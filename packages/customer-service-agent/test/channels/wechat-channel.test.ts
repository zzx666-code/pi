import { describe, expect, it } from "vitest";
import {
	InMemoryWechatChannelStore,
	type WechatActionGateway,
	type WechatAgentPort,
	WechatChannelService,
} from "../../src/channels/wechat/service.ts";

const actions: WechatActionGateway = {
	async getOrderDraft() {
		throw new Error("Unexpected order draft lookup");
	},
	async confirmOrderDraft() {
		throw new Error("Unexpected order confirmation");
	},
	async submitOrderDraft() {
		throw new Error("Unexpected order submission");
	},
	async loadRefundDraft() {
		throw new Error("Unexpected refund draft lookup");
	},
	async confirmRefundDraft() {
		throw new Error("Unexpected refund confirmation");
	},
};

describe("WechatChannelService", () => {
	it("continues one Pi conversation and queues the reply for WeChat", async () => {
		const turns: { userId: string; conversationId: string; text: string }[] = [];
		let conversationSequence = 0;
		const agent: WechatAgentPort = {
			async createConversation() {
				conversationSequence += 1;
				return `conversation-${conversationSequence}`;
			},
			async runTurn(userId, conversationId, text) {
				turns.push({ userId, conversationId, text });
				return { reply: `回复：${text}`, takenOverByHuman: false };
			},
		};
		const store = new InMemoryWechatChannelStore();
		const service = new WechatChannelService({
			store,
			agent,
			actions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
		});

		const first = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-1",
			contextToken: "context-1",
			text: "查询北京库存",
		});
		const second = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-2",
			contextToken: "context-2",
			text: "还有上海吗",
		});

		expect(first).toMatchObject({ conversationId: "conversation-1", reply: "回复：查询北京库存" });
		expect(second).toMatchObject({ conversationId: "conversation-1", reply: "回复：还有上海吗" });
		expect(turns).toEqual([
			{ userId: "user-1", conversationId: "conversation-1", text: "查询北京库存" },
			{ userId: "user-1", conversationId: "conversation-1", text: "还有上海吗" },
		]);

		const outbound = await store.claimOutbox(10);
		expect(outbound.map((item) => ({ content: item.content, contextToken: item.contextToken }))).toEqual([
			{ content: "回复：查询北京库存", contextToken: "context-1" },
			{ content: "回复：还有上海吗", contextToken: "context-2" },
		]);
	});

	it("does not execute the agent twice when WeChat redelivers one message", async () => {
		let turnCount = 0;
		const agent: WechatAgentPort = {
			async createConversation() {
				return "conversation-1";
			},
			async runTurn() {
				turnCount += 1;
				return { reply: "只执行一次", takenOverByHuman: false };
			},
		};
		const store = new InMemoryWechatChannelStore();
		const service = new WechatChannelService({
			store,
			agent,
			actions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
		});
		const message = {
			externalUserId: "wx-user-1",
			externalMessageId: "same-message",
			contextToken: "context-1",
			text: "查订单",
		};

		const first = await service.handleInbound(message);
		const duplicate = await service.handleInbound(message);

		expect(turnCount).toBe(1);
		expect(first.duplicate).toBe(false);
		expect(duplicate).toEqual({ conversationId: "conversation-1", reply: "只执行一次", duplicate: true });
		expect(await store.claimOutbox(10)).toHaveLength(1);
	});

	it("allows WeChat to retry a message after agent processing fails", async () => {
		let turnCount = 0;
		const agent: WechatAgentPort = {
			async createConversation() {
				return "conversation-1";
			},
			async runTurn() {
				turnCount += 1;
				if (turnCount === 1) throw new Error("temporary model failure");
				return { reply: "重试成功", takenOverByHuman: false };
			},
		};
		const store = new InMemoryWechatChannelStore();
		const service = new WechatChannelService({
			store,
			agent,
			actions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
		});
		const message = {
			externalUserId: "wx-user-1",
			externalMessageId: "retry-message",
			contextToken: "context-1",
			text: "查订单",
		};

		await expect(service.handleInbound(message)).rejects.toThrow("temporary model failure");
		await expect(service.handleInbound(message)).resolves.toMatchObject({ reply: "重试成功", duplicate: false });
		expect(turnCount).toBe(2);
	});

	it("requires an explicit confirmation code before submitting an order draft", async () => {
		let turnCount = 0;
		const calls: string[] = [];
		const agent: WechatAgentPort = {
			async createConversation() {
				return "conversation-1";
			},
			async runTurn() {
				turnCount += 1;
				return {
					reply: "订单草稿已创建。",
					takenOverByHuman: false,
					orderDraftId: "draft-1",
				};
			},
		};
		const orderActions: WechatActionGateway = {
			async getOrderDraft(userId, draftId) {
				expect({ userId, draftId }).toEqual({ userId: "user-1", draftId: "draft-1" });
				return { id: draftId, status: "awaiting_confirmation", totalCents: 39_900, items: [] };
			},
			async confirmOrderDraft(_userId, draftId) {
				calls.push(`confirm:${draftId}`);
				return { id: draftId, status: "confirmed", totalCents: 39_900, items: [] };
			},
			async submitOrderDraft(_userId, draftId, idempotencyKey) {
				calls.push(`submit:${draftId}:${idempotencyKey}`);
				return { id: "order-1", status: "submitted", totalCents: 39_900 };
			},
			async loadRefundDraft() {
				throw new Error("Unexpected refund draft lookup");
			},
			async confirmRefundDraft() {
				throw new Error("Unexpected refund confirmation");
			},
		};
		const store = new InMemoryWechatChannelStore();
		const service = new WechatChannelService({
			store,
			agent,
			actions: orderActions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
		});

		const proposed = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-1",
			contextToken: "context-1",
			text: "买一个耳机",
		});
		const code = /确认下单 ([A-Z0-9]{6})/.exec(proposed.reply ?? "")?.[1];

		expect(code).toBeDefined();
		expect(calls).toEqual([]);
		const confirmed = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-2",
			contextToken: "context-2",
			text: `确认下单 ${code}`,
		});

		expect(turnCount).toBe(1);
		expect(confirmed.reply).toContain("订单 order-1 已提交");
		expect(calls).toEqual(["confirm:draft-1", "submit:draft-1:wechat:wx-user-1:message-2"]);
	});

	it("replaces an expired confirmation code for the same draft", async () => {
		let now = 1_000;
		const agent: WechatAgentPort = {
			async createConversation() {
				return "conversation-1";
			},
			async runTurn() {
				return {
					reply: "订单草稿已创建。",
					takenOverByHuman: false,
					orderDraftId: "draft-1",
				};
			},
		};
		const orderActions: WechatActionGateway = {
			...actions,
			async getOrderDraft() {
				return { id: "draft-1", status: "awaiting_confirmation", totalCents: 100, items: [] };
			},
		};
		const service = new WechatChannelService({
			store: new InMemoryWechatChannelStore(),
			agent,
			actions: orderActions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
			clock: () => now,
		});
		const first = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-1",
			contextToken: "context-1",
			text: "创建订单",
		});
		const firstCode = /确认下单 ([A-Z0-9]{6})/.exec(first.reply ?? "")?.[1];
		now += 5 * 60 * 1000 + 1;
		const second = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-2",
			contextToken: "context-2",
			text: "重新创建订单",
		});
		const secondCode = /确认下单 ([A-Z0-9]{6})/.exec(second.reply ?? "")?.[1];

		expect(firstCode).toBeDefined();
		expect(secondCode).toBeDefined();
		expect(secondCode).not.toBe(firstCode);
	});

	it("starts a fresh Pi conversation when the customer sends /new", async () => {
		let sequence = 0;
		const usedConversations: string[] = [];
		const agent: WechatAgentPort = {
			async createConversation() {
				sequence += 1;
				return `conversation-${sequence}`;
			},
			async runTurn(_userId, conversationId) {
				usedConversations.push(conversationId);
				return { reply: "完成", takenOverByHuman: false };
			},
		};
		const store = new InMemoryWechatChannelStore();
		const service = new WechatChannelService({
			store,
			agent,
			actions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
		});
		await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-1",
			contextToken: "context-1",
			text: "第一次咨询",
		});

		const reset = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-2",
			contextToken: "context-2",
			text: "/new",
		});
		await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-3",
			contextToken: "context-3",
			text: "第二次咨询",
		});

		expect(reset).toMatchObject({ conversationId: "conversation-2", reply: "已开始新的客服会话。" });
		expect(usedConversations).toEqual(["conversation-1", "conversation-2"]);
	});

	it("does not send repeated automatic replies while a human owns the conversation", async () => {
		const agent: WechatAgentPort = {
			async createConversation() {
				return "conversation-1";
			},
			async runTurn() {
				return { reply: "", takenOverByHuman: true };
			},
		};
		const store = new InMemoryWechatChannelStore();
		const service = new WechatChannelService({
			store,
			agent,
			actions,
			demoUserId: "user-1",
			autoBindDemoUser: true,
		});

		const result = await service.handleInbound({
			externalUserId: "wx-user-1",
			externalMessageId: "message-under-takeover",
			contextToken: "context-1",
			text: "我要投诉你",
		});

		expect(result).toEqual({ conversationId: "conversation-1", reply: null, duplicate: false });
		expect(await store.claimOutbox(10)).toEqual([]);
	});
});
