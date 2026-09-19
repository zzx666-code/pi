import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readHumanAgentMessage } from "./human-agent-message.ts";

/** Minimal message shape rendered by the web client. */
export interface ConversationDisplayMessage {
	id: string;
	/** `agent` is a human support reply, rendered differently from the model's own answers. */
	role: "user" | "assistant" | "agent";
	content: string;
	/** Support agent who wrote it. Only set for `agent` messages. */
	author?: string;
}

/** Transcript payload returned when a client opens a conversation. */
export interface ConversationHistory {
	messages: ConversationDisplayMessage[];
	/** Order draft awaiting confirmation at the end of the transcript, if any. */
	orderDraftId?: string;
	/** Refund draft awaiting the customer's confirmation, if any. */
	refundDraftId?: string;
	/**
	 * True while a claimed ticket points at this conversation.
	 *
	 * The browser has no push channel, so it polls this payload. Without the flag a customer would
	 * have to reload to learn that a human showed up.
	 */
	underHumanTakeover: boolean;
}

/** Transcript the desk reads through a ticket. Separate from {@link ConversationHistory}: no draft. */
export interface SupportTicketConversation {
	/** Null for tickets created before the conversation link existed. */
	conversationId: string | null;
	messages: ConversationDisplayMessage[];
}

const TITLE_MAX_LENGTH = 40;
const FALLBACK_TITLE = "新会话";

interface TextBearingPart {
	type?: unknown;
	text?: unknown;
}

function contentText(content: string | readonly unknown[]): string {
	if (typeof content === "string") return content.trim();
	const chunks: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const candidate = part as TextBearingPart;
		if (candidate.type === "text" && typeof candidate.text === "string") chunks.push(candidate.text);
	}
	return chunks.join("\n").trim();
}

/** Visible text of a user or assistant turn. Tool results and tool-only turns yield an empty string. */
export function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	return contentText(message.content);
}

/** Same as {@link messageText} but for a message that round-tripped through a JSON column. */
export function messageTextFromJson(value: unknown): string {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return "";
		}
	}
	if (!parsed || typeof parsed !== "object") return "";
	return messageText(parsed as AgentMessage);
}

export function toConversationTitle(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return FALLBACK_TITLE;
	return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH)}…` : normalized;
}

/** Sidebar title derived from the first user turn, so no extra database column is needed. */
export function conversationTitleFromMessages(messages: AgentMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = messageText(message);
		if (text) return toConversationTitle(text);
	}
	return toConversationTitle("");
}

export function toDisplayMessages(messages: AgentMessage[]): ConversationDisplayMessage[] {
	const output: ConversationDisplayMessage[] = [];
	messages.forEach((message, index) => {
		const deskReply = readHumanAgentMessage(message);
		if (deskReply) {
			output.push({
				id: `history-${index}`,
				role: "agent",
				content: deskReply.text,
				author: deskReply.author,
			});
			return;
		}
		if (message.role !== "user" && message.role !== "assistant") return;
		const content = messageText(message);
		if (!content) return;
		output.push({ id: `history-${index}`, role: message.role, content });
	});
	return output;
}

/**
 * Recover the drafts awaiting confirmation.
 *
 * The browser keeps draft confirmation state in memory only, so reloading the page loses the
 * confirm buttons while the drafts stay open in the database. The ids are already recorded in the
 * tool results stored in the transcript, so no schema change is needed to restore them.
 */
export function latestOrderDraftId(messages: AgentMessage[]): string | undefined {
	return latestToolDraftId(messages, "create_order_draft");
}

/** Same recovery trick for the refund gate: the draft id rides along in the tool result. */
export function latestRefundDraftId(messages: AgentMessage[]): string | undefined {
	return latestToolDraftId(messages, "create_refund_draft");
}

function latestToolDraftId(messages: AgentMessage[], toolName: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== toolName) continue;
		const text = contentText(message.content);
		if (!text) continue;
		try {
			const parsed = JSON.parse(text) as { draftId?: unknown };
			return typeof parsed.draftId === "string" ? parsed.draftId : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
