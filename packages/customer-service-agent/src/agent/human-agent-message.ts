import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

/**
 * A reply written by the human support desk rather than by the model.
 *
 * It is stored as a `custom` message — a role the agent package already defines — instead of
 * widening `CustomAgentMessages`. Declaration merging is global to the monorepo: merging a new
 * role here would also widen `AgentMessage` for every other package, including the ones that
 * switch over it exhaustively.
 *
 * `Agent`'s default message conversion keeps only `user`, `assistant` and `toolResult`, so a desk
 * reply never reaches the model by accident. {@link toLlmMessages} opts in explicitly.
 */
export const HUMAN_AGENT_CUSTOM_TYPE = "humanAgent";

/** Stored on `details`, kept out of the text so the UI can show who wrote the reply. */
export interface HumanAgentDetails {
	author: string;
	ticketId: string;
}

/** Domain view of a desk reply, parsed back out of the stored message. */
export interface HumanAgentMessage {
	author: string;
	text: string;
	ticketId: string;
	timestamp: number;
}

export function createHumanAgentMessage(reply: HumanAgentMessage): AgentMessage {
	return {
		role: "custom",
		customType: HUMAN_AGENT_CUSTOM_TYPE,
		content: reply.text,
		details: { author: reply.author, ticketId: reply.ticketId } satisfies HumanAgentDetails,
		display: true,
		timestamp: reply.timestamp,
	};
}

export function readHumanAgentMessage(message: AgentMessage): HumanAgentMessage | undefined {
	if (message.role !== "custom" || message.customType !== HUMAN_AGENT_CUSTOM_TYPE) return undefined;
	const details = message.details;
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	if (typeof record.author !== "string" || typeof record.ticketId !== "string") return undefined;
	// `custom` messages may carry content parts, but a desk reply is always plain text.
	const text = typeof message.content === "string" ? message.content : "";
	return { author: record.author, text, ticketId: record.ticketId, timestamp: message.timestamp };
}

/**
 * Prepares the transcript for the model.
 *
 * Dropping desk replies would hide the whole handoff: once the ticket is closed the bot takes
 * over again and would otherwise repeat questions the human already answered. Each reply becomes
 * a user turn tagged with the agent's name, so the model can tell who said what.
 */
export function toLlmMessages(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] => {
		const deskReply = readHumanAgentMessage(message);
		if (deskReply) {
			return [
				{
					role: "user",
					content: `[人工客服 ${deskReply.author}] ${deskReply.text}`,
					timestamp: deskReply.timestamp,
				},
			];
		}
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			return [message];
		}
		return [];
	});
}
