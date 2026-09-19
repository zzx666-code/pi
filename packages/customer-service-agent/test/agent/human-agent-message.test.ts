import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	createHumanAgentMessage,
	HUMAN_AGENT_CUSTOM_TYPE,
	readHumanAgentMessage,
	toLlmMessages,
} from "../../src/agent/human-agent-message.ts";

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

describe("human agent message", () => {
	it("round-trips a desk reply through the stored message", () => {
		const stored = createHumanAgentMessage({
			author: "客服小李",
			text: "您好，我来处理。",
			ticketId: "ticket-1",
			timestamp: 2,
		});

		expect(stored).toMatchObject({
			role: "custom",
			customType: HUMAN_AGENT_CUSTOM_TYPE,
			content: "您好，我来处理。",
		});
		expect(readHumanAgentMessage(stored)).toEqual({
			author: "客服小李",
			text: "您好，我来处理。",
			ticketId: "ticket-1",
			timestamp: 2,
		});
	});

	it("ignores custom messages that are not desk replies", () => {
		const other = {
			role: "custom",
			customType: "somethingElse",
			content: "x",
			details: {},
			display: true,
			timestamp: 1,
		} as AgentMessage;

		expect(readHumanAgentMessage(other)).toBeUndefined();
		expect(readHumanAgentMessage(userMessage("你好", 1))).toBeUndefined();
	});

	// `Agent`'s default conversion drops custom messages, which would hide the whole handoff.
	it("shows the model what a human already told the customer", () => {
		const converted = toLlmMessages([
			userMessage("我要投诉", 1),
			createHumanAgentMessage({
				author: "客服小李",
				text: "您好，我来处理您的投诉。",
				ticketId: "ticket-1",
				timestamp: 2,
			}),
		]);

		expect(converted).toEqual([
			{ role: "user", content: "我要投诉", timestamp: 1 },
			{ role: "user", content: "[人工客服 客服小李] 您好，我来处理您的投诉。", timestamp: 2 },
		]);
	});

	it("passes model turns through untouched", () => {
		const messages: AgentMessage[] = [userMessage("还有货吗", 1)];

		expect(toLlmMessages(messages)).toEqual(messages);
	});
});
