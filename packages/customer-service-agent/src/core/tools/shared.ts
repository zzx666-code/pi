import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** Trusted identity injected by the Agent API. The model cannot set or override these values. */
export interface ToolRequestContext {
	userId: string;
	conversationId: string;
}

export function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Hand the model a pre-formatted local time instead of making it do timezone arithmetic. */
export function toBeijingTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const local = new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString();
	return `${local.slice(0, 16).replace("T", " ")}（北京时间）`;
}
