import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Minimal message shape rendered by the web client. */
export interface ConversationDisplayMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
}

/** Transcript payload returned when a client opens a conversation. */
export interface ConversationHistory {
	messages: ConversationDisplayMessage[];
	/** Order draft awaiting confirmation at the end of the transcript, if any. */
	orderDraftId?: string;
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
		if (message.role !== "user" && message.role !== "assistant") return;
		const content = messageText(message);
		if (!content) return;
		output.push({ id: `history-${index}`, role: message.role, content });
	});
	return output;
}

/**
 * Recover the draft awaiting confirmation.
 *
 * The browser keeps draft confirmation state in memory only, so reloading the page loses the
 * confirm button while the draft stays open in the database. The id is already recorded in the
 * tool result stored in the transcript, so no schema change is needed to restore it.
 */
export function latestOrderDraftId(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "create_order_draft") continue;
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
