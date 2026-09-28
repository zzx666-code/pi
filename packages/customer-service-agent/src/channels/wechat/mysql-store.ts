import { randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { WechatChannelStore, WechatInboundMessage, WechatOutboxMessage, WechatPendingAction } from "./service.ts";

const CHANNEL = "wechat";

interface IdentityRow extends RowDataPacket {
	user_id: string;
}

interface ConversationRow extends RowDataPacket {
	conversation_id: string;
}

interface InboundRow extends RowDataPacket {
	status: "processing" | "completed";
	conversation_id: string | null;
	response_text: string | null;
}

interface PendingActionRow extends RowDataPacket {
	code: string;
	external_user_id: string;
	user_id: string;
	conversation_id: string;
	action_type: WechatPendingAction["type"];
	resource_id: string;
	expires_at: Date | string;
}

interface OutboxRow extends RowDataPacket {
	id: string;
	external_user_id: string;
	conversation_id: string | null;
	context_token: string;
	content: string;
	attempt_count: number;
}

interface CursorRow extends RowDataPacket {
	get_updates_buf: string;
}

function pendingActionFromRow(row: PendingActionRow): WechatPendingAction {
	return {
		code: row.code,
		externalUserId: row.external_user_id,
		userId: row.user_id,
		conversationId: row.conversation_id,
		type: row.action_type,
		resourceId: row.resource_id,
		expiresAt: new Date(row.expires_at).getTime(),
	};
}

function isDuplicateEntry(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "errno" in error && error.errno === 1062);
}

export class MySqlWechatChannelStore implements WechatChannelStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async findUserId(externalUserId: string): Promise<string | undefined> {
		const [rows] = await this.pool.execute<IdentityRow[]>(
			"SELECT user_id FROM channel_identities WHERE channel = ? AND external_user_id = ?",
			[CHANNEL, externalUserId],
		);
		return rows[0]?.user_id;
	}

	async bindUser(externalUserId: string, userId: string): Promise<void> {
		await this.pool.execute(
			"INSERT IGNORE INTO channel_identities (channel, external_user_id, user_id) VALUES (?, ?, ?)",
			[CHANNEL, externalUserId, userId],
		);
	}

	async getConversationId(externalUserId: string): Promise<string | undefined> {
		const [rows] = await this.pool.execute<ConversationRow[]>(
			"SELECT conversation_id FROM channel_conversations WHERE channel = ? AND external_user_id = ?",
			[CHANNEL, externalUserId],
		);
		return rows[0]?.conversation_id;
	}

	async saveConversation(externalUserId: string, conversationId: string, contextToken: string): Promise<void> {
		await this.pool.execute(
			`INSERT INTO channel_conversations (channel, external_user_id, conversation_id, context_token)
			 VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE conversation_id = VALUES(conversation_id), context_token = VALUES(context_token)`,
			[CHANNEL, externalUserId, conversationId, contextToken],
		);
	}

	async startInbound(message: WechatInboundMessage) {
		const [insert] = await this.pool.execute<ResultSetHeader>(
			`INSERT IGNORE INTO channel_inbound_messages
			 (channel, external_message_id, external_user_id, context_token, status)
			 VALUES (?, ?, ?, ?, 'processing')`,
			[CHANNEL, message.externalMessageId, message.externalUserId, message.contextToken],
		);
		if (insert.affectedRows === 1) return { status: "accepted" as const };

		const [rows] = await this.pool.execute<InboundRow[]>(
			`SELECT status, conversation_id, response_text
			   FROM channel_inbound_messages
			  WHERE channel = ? AND external_message_id = ?`,
			[CHANNEL, message.externalMessageId],
		);
		const row = rows[0];
		if (row?.status === "completed") {
			return {
				status: "completed" as const,
				conversationId: row.conversation_id,
				response: row.response_text,
			};
		}
		return { status: "processing" as const };
	}

	async completeInbound(
		message: WechatInboundMessage,
		conversationId: string | null,
		response: string | null,
	): Promise<void> {
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			const [updated] = await connection.execute<ResultSetHeader>(
				`UPDATE channel_inbound_messages
				    SET status = 'completed', conversation_id = ?, response_text = ?, completed_at = CURRENT_TIMESTAMP(3)
				  WHERE channel = ? AND external_message_id = ? AND status = 'processing'`,
				[conversationId, response, CHANNEL, message.externalMessageId],
			);
			if (updated.affectedRows === 1 && response !== null) {
				await connection.execute(
					`INSERT INTO channel_outbox
					 (id, channel, external_user_id, conversation_id, context_token, content)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[randomUUID(), CHANNEL, message.externalUserId, conversationId, message.contextToken, response],
				);
			}
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async releaseInbound(message: WechatInboundMessage): Promise<void> {
		await this.pool.execute(
			`DELETE FROM channel_inbound_messages
			  WHERE channel = ? AND external_message_id = ? AND status = 'processing'`,
			[CHANNEL, message.externalMessageId],
		);
	}

	async getOrCreatePendingAction(
		action: Omit<WechatPendingAction, "code">,
		now: number,
	): Promise<WechatPendingAction> {
		const existing = await this.findPendingActionByResource(action.externalUserId, action.type, action.resourceId);
		if (existing && existing.expiresAt > now) return existing;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const code = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
			try {
				if (existing) {
					const [updated] = await this.pool.execute<ResultSetHeader>(
						`UPDATE channel_pending_actions
						    SET code = ?, user_id = ?, conversation_id = ?, status = 'pending',
						        expires_at = ?, completed_at = NULL, created_at = CURRENT_TIMESTAMP(3)
						  WHERE code = ? AND channel = ? AND external_user_id = ? AND action_type = ?
						    AND resource_id = ? AND expires_at <= ?`,
						[
							code,
							action.userId,
							action.conversationId,
							new Date(action.expiresAt),
							existing.code,
							CHANNEL,
							action.externalUserId,
							action.type,
							action.resourceId,
							new Date(now),
						],
					);
					if (updated.affectedRows === 0) {
						const raced = await this.findPendingActionByResource(
							action.externalUserId,
							action.type,
							action.resourceId,
						);
						if (raced) return raced;
						continue;
					}
				} else {
					await this.pool.execute(
						`INSERT INTO channel_pending_actions
						 (code, channel, external_user_id, user_id, conversation_id, action_type, resource_id, expires_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							code,
							CHANNEL,
							action.externalUserId,
							action.userId,
							action.conversationId,
							action.type,
							action.resourceId,
							new Date(action.expiresAt),
						],
					);
				}
				return { ...action, code };
			} catch (error) {
				if (!isDuplicateEntry(error)) throw error;
				const raced = await this.findPendingActionByResource(action.externalUserId, action.type, action.resourceId);
				if (raced) return raced;
			}
		}
		throw new Error("Unable to allocate a WeChat confirmation code");
	}

	async findPendingAction(
		externalUserId: string,
		code: string,
		now: number,
	): Promise<WechatPendingAction | undefined> {
		const [rows] = await this.pool.execute<PendingActionRow[]>(
			`SELECT code, external_user_id, user_id, conversation_id, action_type, resource_id, expires_at
			   FROM channel_pending_actions
			  WHERE code = ? AND channel = ? AND external_user_id = ? AND status = 'pending' AND expires_at > ?`,
			[code.toUpperCase(), CHANNEL, externalUserId, new Date(now)],
		);
		return rows[0] ? pendingActionFromRow(rows[0]) : undefined;
	}

	async completePendingAction(code: string): Promise<void> {
		await this.pool.execute(
			`UPDATE channel_pending_actions
			    SET status = 'completed', completed_at = CURRENT_TIMESTAMP(3)
			  WHERE code = ? AND status = 'pending'`,
			[code.toUpperCase()],
		);
	}

	async claimOutbox(limit: number): Promise<WechatOutboxMessage[]> {
		const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			const [rows] = await connection.query<OutboxRow[]>(
				`SELECT id, external_user_id, conversation_id, context_token, content, attempt_count
				   FROM channel_outbox
				  WHERE channel = ? AND status IN ('pending', 'sending') AND available_at <= CURRENT_TIMESTAMP(3)
				  ORDER BY created_at
				  LIMIT ${boundedLimit}
				  FOR UPDATE SKIP LOCKED`,
				[CHANNEL],
			);
			if (rows.length > 0) {
				await connection.query(
					`UPDATE channel_outbox
					    SET status = 'sending', attempt_count = attempt_count + 1,
					        available_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 2 MINUTE)
					  WHERE id IN (${rows.map(() => "?").join(", ")})`,
					rows.map((row) => row.id),
				);
			}
			await connection.commit();
			return rows.map((row) => ({
				id: row.id,
				externalUserId: row.external_user_id,
				conversationId: row.conversation_id,
				contextToken: row.context_token,
				content: row.content,
				attemptCount: Number(row.attempt_count) + 1,
			}));
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async markOutboxSent(id: string): Promise<void> {
		await this.pool.execute(
			`UPDATE channel_outbox
			    SET status = 'sent', sent_at = CURRENT_TIMESTAMP(3), last_error = NULL
			  WHERE id = ? AND status = 'sending'`,
			[id],
		);
	}

	async markOutboxFailed(id: string, error: string): Promise<void> {
		const [rows] = await this.pool.execute<(RowDataPacket & { attempt_count: number })[]>(
			"SELECT attempt_count FROM channel_outbox WHERE id = ?",
			[id],
		);
		const delaySeconds = Math.min(60, 2 ** Math.min(Number(rows[0]?.attempt_count ?? 1), 6));
		await this.pool.execute(
			`UPDATE channel_outbox
			    SET status = 'pending', available_at = ?, last_error = ?
			  WHERE id = ? AND status = 'sending'`,
			[new Date(Date.now() + delaySeconds * 1000), error.slice(0, 500), id],
		);
	}

	async enqueueConversationReply(conversationId: string, content: string): Promise<void> {
		await this.pool.execute(
			`INSERT INTO channel_outbox
			 (id, channel, external_user_id, conversation_id, context_token, content)
			 SELECT UUID(), channel, external_user_id, conversation_id, context_token, ?
			   FROM channel_conversations
			  WHERE channel = ? AND conversation_id = ?`,
			[content, CHANNEL, conversationId],
		);
	}

	async getSyncCursor(accountId: string): Promise<string> {
		const [rows] = await this.pool.execute<CursorRow[]>(
			"SELECT get_updates_buf FROM wechat_sync_state WHERE account_id = ?",
			[accountId],
		);
		return rows[0]?.get_updates_buf ?? "";
	}

	async saveSyncCursor(accountId: string, cursor: string): Promise<void> {
		await this.pool.execute(
			`INSERT INTO wechat_sync_state (account_id, get_updates_buf) VALUES (?, ?)
			 ON DUPLICATE KEY UPDATE get_updates_buf = VALUES(get_updates_buf)`,
			[accountId, cursor],
		);
	}

	private async findPendingActionByResource(
		externalUserId: string,
		type: WechatPendingAction["type"],
		resourceId: string,
	): Promise<WechatPendingAction | undefined> {
		const [rows] = await this.pool.execute<PendingActionRow[]>(
			`SELECT code, external_user_id, user_id, conversation_id, action_type, resource_id, expires_at
			   FROM channel_pending_actions
			  WHERE channel = ? AND external_user_id = ? AND action_type = ? AND resource_id = ? AND status = 'pending'
			  LIMIT 1`,
			[CHANNEL, externalUserId, type, resourceId],
		);
		return rows[0] ? pendingActionFromRow(rows[0]) : undefined;
	}
}
