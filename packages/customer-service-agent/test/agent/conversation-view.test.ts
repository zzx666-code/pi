import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	conversationTitleFromMessages,
	latestOrderDraftId,
	messageTextFromJson,
	toConversationTitle,
	toDisplayMessages,
} from "../../src/agent/conversation-view.ts";

function toolResult(toolName: string, payload: unknown, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${timestamp}`,
		toolName,
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
		isError: false,
		timestamp,
	};
}

describe("conversation view", () => {
	it("keeps only user and assistant turns that carry visible text", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "北京还有耳机吗", timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "get_inventory",
				content: [{ type: "text", text: '{"availableQuantity":5}' }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "   ", timestamp: 3 },
		];

		expect(toDisplayMessages(messages)).toEqual([{ id: "history-0", role: "user", content: "北京还有耳机吗" }]);
	});

	it("joins assistant text parts and drops tool-only turns", () => {
		const withText = messageTextFromJson({
			role: "assistant",
			content: [
				{ type: "text", text: "第一段" },
				{ type: "toolCall", id: "t1", name: "get_order" },
				{ type: "text", text: "第二段" },
			],
		});
		const toolOnly = messageTextFromJson({
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "get_order" }],
		});

		expect(withText).toBe("第一段\n第二段");
		expect(toolOnly).toBe("");
		expect(messageTextFromJson(null)).toBe("");
		expect(messageTextFromJson("not-json")).toBe("");
	});

	it("derives the sidebar title from the first user turn", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "  你们正常几天可以发货？ ", timestamp: 1 },
			{ role: "user", content: "第二个问题", timestamp: 2 },
		];

		expect(conversationTitleFromMessages(messages)).toBe("你们正常几天可以发货？");
		expect(conversationTitleFromMessages([])).toBe("新会话");
	});

	it("collapses whitespace and truncates long titles", () => {
		expect(toConversationTitle("a\n\n b")).toBe("a b");
		expect(toConversationTitle("字".repeat(50))).toHaveLength(41);
	});

	// Guards the regression where reloading the page lost the confirm button: the draft id
	// is recovered from the tool result already stored in the transcript.
	it("recovers the pending draft id from the stored tool result", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "我要买键盘", timestamp: 1 },
			toolResult("create_order_draft", { draftId: "draft-7", status: "awaiting_confirmation" }, 2),
		];

		expect(latestOrderDraftId(messages)).toBe("draft-7");
	});

	it("ignores other tools and transcripts without a draft", () => {
		expect(latestOrderDraftId([toolResult("get_inventory", { draftId: "nope" }, 1)])).toBeUndefined();
		expect(latestOrderDraftId([])).toBeUndefined();
		expect(latestOrderDraftId([toolResult("create_order_draft", "not-json", 1)])).toBeUndefined();
	});

	it("returns the newest draft when the transcript has several", () => {
		const messages: AgentMessage[] = [
			toolResult("create_order_draft", { draftId: "draft-1" }, 1),
			toolResult("create_order_draft", { draftId: "draft-2" }, 2),
		];

		expect(latestOrderDraftId(messages)).toBe("draft-2");
	});
});
