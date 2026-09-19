import { describe, expect, it } from "vitest";
import { ConversationAccessError, InMemoryConversationStore } from "../../src/agent/conversation-store.ts";
import { createHumanAgentMessage } from "../../src/agent/human-agent-message.ts";

describe("InMemoryConversationStore", () => {
	it("stores and restores a conversation for its owner", async () => {
		const store = new InMemoryConversationStore();
		const id = await store.create("user-1");
		const messages = [{ role: "user" as const, content: "你好", timestamp: 1 }];

		await store.replace(id, "user-1", messages);

		expect(await store.load(id, "user-1")).toEqual(messages);
	});

	it("does not reveal another user's conversation", async () => {
		const store = new InMemoryConversationStore();
		const id = await store.create("user-1");

		await expect(store.load(id, "user-2")).rejects.toThrow(ConversationAccessError);
	});

	it("lists only the current user's conversations, most recently active first", async () => {
		const store = new InMemoryConversationStore();
		const older = await store.create("user-1");
		const newer = await store.create("user-1");
		await store.create("user-2");
		await store.replace(older, "user-1", [{ role: "user", content: "最早的问题", timestamp: 1 }]);
		await store.replace(newer, "user-1", [{ role: "user", content: "最新的问题", timestamp: 2 }]);

		const summaries = await store.list("user-1");

		expect(summaries.map((item) => item.id)).toEqual([newer, older]);
		expect(summaries[0]).toMatchObject({ title: "最新的问题", messageCount: 1 });
		expect(summaries[1]).toMatchObject({ title: "最早的问题" });
	});

	it("titles a conversation with no user text as a new conversation", async () => {
		const store = new InMemoryConversationStore();
		const id = await store.create("user-1");

		const [summary] = await store.list("user-1");

		expect(summary).toMatchObject({ id, title: "新会话", messageCount: 0 });
	});

	it("appends after the messages that were already stored", async () => {
		const store = new InMemoryConversationStore();
		const id = await store.create("user-1");
		await store.replace(id, "user-1", [{ role: "user", content: "第一句", timestamp: 1 }]);

		await store.append(id, "user-1", [{ role: "user", content: "第二句", timestamp: 2 }]);

		const restored = await store.load(id, "user-1");
		expect(restored).toHaveLength(2);
		expect(restored[1]).toMatchObject({ role: "user", content: "第二句" });
	});

	// This is the reason append exists: the model writes its whole turn when it finishes, which
	// would delete a desk reply that landed while the model was still thinking.
	it("keeps a message written by someone else before the append", async () => {
		const store = new InMemoryConversationStore();
		const id = await store.create("user-1");
		await store.append(id, "user-1", [{ role: "user", content: "我要投诉", timestamp: 1 }]);
		await store.append(id, "user-1", [
			createHumanAgentMessage({
				author: "客服小李",
				text: "您好，我来处理",
				ticketId: "ticket-1",
				timestamp: 2,
			}),
		]);
		await store.append(id, "user-1", [{ role: "user", content: "还有人在吗", timestamp: 3 }]);

		const restored = await store.load(id, "user-1");

		expect(restored).toHaveLength(3);
		expect(restored[1]).toMatchObject({
			role: "custom",
			customType: "humanAgent",
			content: "您好，我来处理",
			details: { author: "客服小李", ticketId: "ticket-1" },
		});
		expect(restored[2]).toMatchObject({ role: "user", content: "还有人在吗" });
	});

	it("refuses to append to another user's conversation", async () => {
		const store = new InMemoryConversationStore();
		const id = await store.create("user-1");

		await expect(store.append(id, "user-2", [{ role: "user", content: "闯入", timestamp: 1 }])).rejects.toThrow(
			ConversationAccessError,
		);
	});
});
