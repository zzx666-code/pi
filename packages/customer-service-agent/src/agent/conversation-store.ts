import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { conversationTitleFromMessages, messageTextFromJson, toConversationTitle } from "./conversation-view.ts";

export class ConversationAccessError extends Error {
	constructor() {
		super("Conversation was not found for the current user");
		this.name = "ConversationAccessError";
	}
}

export interface ToolAuditRecord {
	conversationId: string;
	userId: string;
	toolName: string;
	toolCallId: string;
	status: "started" | "succeeded" | "failed" | "blocked";
	request?: unknown;
	result?: unknown;
	durationMs?: number;
}

/** Row rendered in the web sidebar. */
export interface ConversationSummary {
	id: string;
	title: string;
	messageCount: number;
	updatedAt: string;
}

export interface ConversationStore {
	create(userId: string): Promise<string>;
	list(userId: string): Promise<ConversationSummary[]>;
	load(conversationId: string, userId: string): Promise<AgentMessage[]>;
	replace(conversationId: string, userId: string, messages: AgentMessage[]): Promise<void>;
	/**
	 * Adds messages to the end of the transcript.
	 *
	 * Unlike {@link replace} it never deletes existing rows, so a desk reply that lands while the
	 * model is still thinking survives the turn instead of being overwritten.
	 */
	append(conversationId: string, userId: string, messages: AgentMessage[]): Promise<void>;
	recordToolAudit(record: ToolAuditRecord): Promise<void>;
}

interface InMemoryConversation {
	userId: string;
	messages: AgentMessage[];
	updatedAt: number;
	/** Monotonic activity counter; identical millisecond timestamps would otherwise order unpredictably. */
	sequence: number;
}

export class InMemoryConversationStore implements ConversationStore {
	private readonly conversations = new Map<string, InMemoryConversation>();
	private sequence = 0;

	async create(userId: string): Promise<string> {
		const id = randomUUID();
		this.conversations.set(id, { userId, messages: [], updatedAt: Date.now(), sequence: ++this.sequence });
		return id;
	}

	async list(userId: string): Promise<ConversationSummary[]> {
		return [...this.conversations.entries()]
			.filter(([, conversation]) => conversation.userId === userId)
			.sort((left, right) => right[1].sequence - left[1].sequence)
			.map(([id, conversation]) => ({
				id,
				title: conversationTitleFromMessages(conversation.messages),
				messageCount: conversation.messages.length,
				updatedAt: new Date(conversation.updatedAt).toISOString(),
			}));
	}

	async load(conversationId: string, userId: string): Promise<AgentMessage[]> {
		const conversation = this.requireOwned(conversationId, userId);
		return structuredClone(conversation.messages);
	}

	async replace(conversationId: string, userId: string, messages: AgentMessage[]): Promise<void> {
		const conversation = this.requireOwned(conversationId, userId);
		conversation.messages = structuredClone(messages);
		conversation.updatedAt = Date.now();
		conversation.sequence = ++this.sequence;
	}

	async append(conversationId: string, userId: string, messages: AgentMessage[]): Promise<void> {
		const conversation = this.requireOwned(conversationId, userId);
		conversation.messages.push(...structuredClone(messages));
		conversation.updatedAt = Date.now();
		conversation.sequence = ++this.sequence;
	}

	async recordToolAudit(_record: ToolAuditRecord): Promise<void> {}

	private requireOwned(conversationId: string, userId: string): InMemoryConversation {
		const conversation = this.conversations.get(conversationId);
		if (!conversation || conversation.userId !== userId) throw new ConversationAccessError();
		return conversation;
	}
}

interface ConversationRow extends RowDataPacket {
	id: string;
}

interface MessageRow extends RowDataPacket {
	message_json: string | Record<string, unknown>;
}

interface ConversationSummaryRow extends RowDataPacket {
	id: string;
	updated_at: Date | string;
	message_count: number;
	first_user_message: string | Record<string, unknown> | null;
}

export class MySqlConversationStore implements ConversationStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async create(userId: string): Promise<string> {
		const id = randomUUID();
		await this.pool.execute("INSERT INTO conversations (id, user_id) VALUES (?, ?)", [id, userId]);
		return id;
	}

	/**
	 * Titles come from the first user turn instead of a dedicated column, so existing rows
	 * stay readable without a migration.
	 */
	async list(userId: string): Promise<ConversationSummary[]> {
		const [rows] = await this.pool.execute<ConversationSummaryRow[]>(
			`SELECT c.id,
			        c.updated_at,
			        (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count,
			        (SELECT m.message_json
			           FROM conversation_messages m
			          WHERE m.conversation_id = c.id
			            AND JSON_UNQUOTE(JSON_EXTRACT(m.message_json, '$.role')) = 'user'
			          ORDER BY m.id
			          LIMIT 1) AS first_user_message
			   FROM conversations c
			  WHERE c.user_id = ?
			  ORDER BY c.updated_at DESC, c.created_at DESC
			  LIMIT 100`,
			[userId],
		);
		return rows.map((row) => ({
			id: row.id,
			title: toConversationTitle(messageTextFromJson(row.first_user_message)),
			messageCount: Number(row.message_count),
			updatedAt: new Date(row.updated_at).toISOString(),
		}));
	}

	async load(conversationId: string, userId: string): Promise<AgentMessage[]> {
		await this.requireOwned(conversationId, userId);
		const [rows] = await this.pool.execute<MessageRow[]>(
			"SELECT message_json FROM conversation_messages WHERE conversation_id = ? ORDER BY id",
			[conversationId],
		);
		return rows.map((row) => messageTextFromJsonRow(row));
	}

	async replace(conversationId: string, userId: string, messages: AgentMessage[]): Promise<void> {
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			const [rows] = await connection.execute<ConversationRow[]>(
				"SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE",
				[conversationId, userId],
			);
			if (!rows[0]) throw new ConversationAccessError();
			await connection.execute("DELETE FROM conversation_messages WHERE conversation_id = ?", [conversationId]);
			for (const message of messages) {
				await connection.execute(
					"INSERT INTO conversation_messages (conversation_id, message_json) VALUES (?, ?)",
					[conversationId, JSON.stringify(message)],
				);
			}
			await connection.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [
				conversationId,
			]);
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async append(conversationId: string, userId: string, messages: AgentMessage[]): Promise<void> {
		if (messages.length === 0) {
			await this.requireOwned(conversationId, userId);
			return;
		}
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			const [rows] = await connection.execute<ConversationRow[]>(
				"SELECT id FROM conversations WHERE id = ? AND user_id = ? FOR UPDATE",
				[conversationId, userId],
			);
			if (!rows[0]) throw new ConversationAccessError();
			for (const message of messages) {
				await connection.execute(
					"INSERT INTO conversation_messages (conversation_id, message_json) VALUES (?, ?)",
					[conversationId, JSON.stringify(message)],
				);
			}
			await connection.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [
				conversationId,
			]);
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async recordToolAudit(record: ToolAuditRecord): Promise<void> {
		await this.pool.execute(
			"INSERT INTO tool_audit_logs (conversation_id, user_id, tool_name, tool_call_id, status, request_json, result_json, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				record.conversationId,
				record.userId,
				record.toolName,
				record.toolCallId,
				record.status,
				record.request === undefined ? null : JSON.stringify(record.request),
				record.result === undefined ? null : JSON.stringify(record.result),
				record.durationMs ?? null,
			],
		);
	}

	private async requireOwned(conversationId: string, userId: string): Promise<void> {
		const [rows] = await this.pool.execute<ConversationRow[]>(
			"SELECT id FROM conversations WHERE id = ? AND user_id = ?",
			[conversationId, userId],
		);
		if (!rows[0]) throw new ConversationAccessError();
	}
}

/** mysql2 hands back either a parsed object or the raw string depending on column type casts. */
function messageTextFromJsonRow(row: MessageRow): AgentMessage {
	const value = typeof row.message_json === "string" ? (JSON.parse(row.message_json) as unknown) : row.message_json;
	return value as AgentMessage;
}
