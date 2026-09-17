import { describe, expect, it } from "vitest";
import { ConversationAccessError, InMemoryConversationStore } from "../../src/agent/conversation-store.ts";

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
});
