import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

// service.ts imports the Agent class as a runtime value, but that package's entry point is not
// built in the test environment. The desk routes never reach the model, so a stub is enough.
const { agentConstructions, AgentStub } = vi.hoisted(() => {
	const constructions: unknown[] = [];
	class Stub {
		state = { messages: [] as unknown[] };
		subscribe(): void {}
		async prompt(): Promise<void> {}

		constructor() {
			constructions.push(this);
		}
	}
	return { agentConstructions: constructions, AgentStub: Stub };
});

vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: AgentStub }));

import { createAgentApp } from "../../src/agent/app.ts";
import { InMemoryConversationStore } from "../../src/agent/conversation-store.ts";
import { InMemoryDeskAuditStore } from "../../src/agent/desk-audit.ts";
import { type CommerceGateway, CommerceHttpError } from "../../src/agent/gateways.ts";
import { createHumanAgentMessage } from "../../src/agent/human-agent-message.ts";
import { CustomerServiceAgentService } from "../../src/agent/service.ts";
import {
	InMemoryWechatChannelStore,
	type WechatActionGateway,
	WechatChannelService,
} from "../../src/channels/wechat/service.ts";
import { InMemoryCommerceRepository } from "../../src/db/in-memory-commerce-repository.ts";

const DESK_TOKEN = "desk-token";
const deskHeaders = { "x-internal-token": DESK_TOKEN };

const TEST_MODEL: Model<"openai-completions"> = {
	id: "test-model",
	name: "test-model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

/**
 * Bridges the in-memory commerce store to the gateway the agent talks to. The store already
 * implements the ticket rules, so the fake only has to translate "not found" into the error the
 * real HTTP gateway would raise.
 */
class FakeCommerceGateway implements CommerceGateway {
	private readonly store = new InMemoryCommerceRepository({ products: [], inventory: [] });

	async searchProducts() {
		return [];
	}

	async getInventory(sku: string, region: string) {
		return { sku, region, availableQuantity: 0 };
	}

	async getOrder(_userId: string, orderId: string) {
		return { id: orderId, status: "submitted", totalCents: 0 };
	}

	async listOrders() {
		return [];
	}

	async getOrderDraft(): Promise<never> {
		throw new Error("the desk test never drafts an order");
	}

	async createOrderDraft(): Promise<never> {
		throw new Error("the desk test never drafts an order");
	}

	async createSupportTicket(userId: string, summary: string, conversationId: string | null) {
		return await this.store.createSupportTicket(userId, summary, conversationId);
	}

	async getSupportTicket(ticketId: string) {
		const ticket = await this.store.getSupportTicket(ticketId);
		if (!ticket) throw new CommerceHttpError(404, "NOT_FOUND", "Support ticket was not found");
		return ticket;
	}

	async listSupportTickets(options?: { status?: "open" | "assigned" | "closed"; limit?: number }) {
		return await this.store.listSupportTickets(options);
	}

	async claimSupportTicket(ticketId: string, assignee: string) {
		const ticket = await this.store.claimSupportTicket(ticketId, assignee);
		if (!ticket) throw new CommerceHttpError(409, "TICKET_NOT_OPEN", "Support ticket is not open");
		return ticket;
	}

	async closeSupportTicket(ticketId: string, note: string | null) {
		const ticket = await this.store.closeSupportTicket(ticketId, note);
		if (!ticket) throw new CommerceHttpError(409, "TICKET_NOT_ASSIGNED", "Support ticket is not assigned");
		return ticket;
	}

	async proposeRefund(): Promise<never> {
		throw new Error("the desk test never refunds");
	}

	async cancelRefundRequest(): Promise<never> {
		throw new Error("the desk test never cancels refunds");
	}

	async listRefundRequests() {
		return [];
	}

	async confirmOrderDraft(): Promise<never> {
		throw new Error("the desk test never confirms orders");
	}

	async submitOrderDraft(): Promise<never> {
		throw new Error("the desk test never submits orders");
	}
}

function createHarness(options: { withWechat?: boolean } = {}) {
	const commerce = new FakeCommerceGateway();
	const conversations = new InMemoryConversationStore();
	const deskAudit = new InMemoryDeskAuditStore();
	const channelStore = new InMemoryWechatChannelStore();
	const service = new CustomerServiceAgentService({
		model: TEST_MODEL,
		streamFn: async () => {
			throw new Error("the desk never calls the model");
		},
		commerce,
		knowledge: { search: async () => [] },
		conversations,
		deskAudit,
		replySink: channelStore,
	});
	const wechatActions: WechatActionGateway = {
		getOrderDraft: async () => {
			throw new Error("the channel API test never loads order drafts");
		},
		confirmOrderDraft: async () => {
			throw new Error("the channel API test never confirms orders");
		},
		submitOrderDraft: async () => {
			throw new Error("the channel API test never submits orders");
		},
		loadRefundDraft: async () => {
			throw new Error("the channel API test never loads refund drafts");
		},
		confirmRefundDraft: async () => {
			throw new Error("the channel API test never confirms refunds");
		},
	};
	const wechat = options.withWechat
		? new WechatChannelService({
				store: channelStore,
				agent: {
					createConversation: async () => "conversation-wechat",
					runTurn: async (_userId, _conversationId, text) => ({
						reply: `微信回复：${text}`,
						takenOverByHuman: false,
					}),
				},
				actions: wechatActions,
				demoUserId: "user-1",
				autoBindDemoUser: true,
			})
		: undefined;
	const app = createAgentApp(service, commerce, {
		authSecret: "test-secret",
		demoUserId: "user-1",
		deskToken: DESK_TOKEN,
		refunds: {
			confirmRefundDraft: async () => {
				throw new Error("the desk test never confirms refunds");
			},
			loadRefundDraft: async () => {
				throw new Error("the desk test never loads refund drafts");
			},
		},
		wechat,
		channelToken: "channel-token",
	});
	return { app, commerce, conversations, deskAudit, service, channelStore };
}

async function seedTicket(commerce: FakeCommerceGateway, conversationId: string, summary = "我要投诉") {
	return await commerce.createSupportTicket("user-1", summary, conversationId);
}

describe("desk API", () => {
	it("protects the WeChat channel endpoint with its own service token", async () => {
		const { app } = createHarness({ withWechat: true });
		const payload = {
			externalUserId: "wx-user-1",
			externalMessageId: "message-1",
			contextToken: "context-1",
			text: "查库存",
		};

		const denied = await app.inject({ method: "POST", url: "/api/internal/channels/wechat/messages", payload });
		const accepted = await app.inject({
			method: "POST",
			url: "/api/internal/channels/wechat/messages",
			headers: { "x-channel-token": "channel-token" },
			payload,
		});

		expect(denied.statusCode).toBe(401);
		expect(accepted.statusCode).toBe(200);
		expect(accepted.json()).toMatchObject({ conversationId: "conversation-wechat", reply: "微信回复：查库存" });
		await app.close();
	});

	it("queues a claimed desk reply for the linked WeChat conversation", async () => {
		const { app, commerce, conversations, channelStore } = createHarness();
		const conversationId = await conversations.create("user-1");
		await channelStore.bindUser("wx-user-1", "user-1");
		await channelStore.saveConversation("wx-user-1", conversationId, "context-latest");
		const ticket = await seedTicket(commerce, conversationId);
		await commerce.claimSupportTicket(ticket.id, "客服小李");

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/reply`,
			headers: deskHeaders,
			payload: { text: "库存问题已经处理完成" },
		});

		expect(response.statusCode).toBe(200);
		expect(await channelStore.claimOutbox(10)).toEqual([
			expect.objectContaining({
				externalUserId: "wx-user-1",
				contextToken: "context-latest",
				content: "人工客服 客服小李：库存问题已经处理完成",
			}),
		]);
		await app.close();
	});

	it("rejects a desk call without the internal token", async () => {
		const { app } = createHarness();

		const response = await app.inject({ method: "GET", url: "/api/support-tickets" });

		expect(response.statusCode).toBe(401);
		await app.close();
	});

	it("lists the tickets waiting for a human", async () => {
		const { app, commerce } = createHarness();
		await seedTicket(commerce, "conversation-1", "第一单");
		await seedTicket(commerce, "conversation-2", "第二单");

		const response = await app.inject({
			method: "GET",
			url: "/api/support-tickets?status=open",
			headers: deskHeaders,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().tickets).toHaveLength(2);
		await app.close();
	});

	it("claims a ticket for a named agent", async () => {
		const { app, commerce } = createHarness();
		const ticket = await seedTicket(commerce, "conversation-1");

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: "assigned", assignee: "客服小李" });
		await app.close();
	});

	it("rejects a competing claim with the upstream status", async () => {
		const { app, commerce } = createHarness();
		const ticket = await seedTicket(commerce, "conversation-1");
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小王" },
		});

		expect(response.statusCode).toBe(409);
		await app.close();
	});

	// This is the whole point of the feature: the customer reads the answer where they asked.
	it("writes a desk reply into the customer's transcript", async () => {
		const { app, commerce, conversations } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/reply`,
			headers: deskHeaders,
			payload: { text: "您好，我是人工客服小李，已为您核实订单。" },
		});

		expect(response.statusCode).toBe(200);
		const stored = await conversations.load(conversationId, "user-1");
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			role: "custom",
			customType: "humanAgent",
			content: "您好，我是人工客服小李，已为您核实订单。",
			details: { author: "客服小李", ticketId: ticket.id },
		});
		await app.close();
	});

	it("refuses to reply on a ticket nobody claimed", async () => {
		const { app, commerce, conversations } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/reply`,
			headers: deskHeaders,
			payload: { text: "你好" },
		});

		expect(response.statusCode).toBe(409);
		expect(await conversations.load(conversationId, "user-1")).toHaveLength(0);
		await app.close();
	});

	it("closes a claimed ticket", async () => {
		const { app, commerce } = createHarness();
		const ticket = await seedTicket(commerce, "conversation-1");
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/close`,
			headers: deskHeaders,
			payload: { note: "已解决" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: "closed", closeNote: "已解决" });
		await app.close();
	});

	// Before this the desk left no trace at all: tool_audit_logs only knows about the model, so
	// "who closed this ticket" had no answer.
	it("records a claim as an attempt and an outcome", async () => {
		const { app, commerce, conversations, deskAudit } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);

		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});

		expect(deskAudit.entries).toMatchObject([
			// The attempt only knows what the route was given.
			{
				action: "claim",
				status: "started",
				assignee: "客服小李",
				ticketId: ticket.id,
				conversationId: null,
				userId: null,
			},
			// The outcome names the customer, which only the returned ticket knows.
			{
				action: "claim",
				status: "succeeded",
				assignee: "客服小李",
				ticketId: ticket.id,
				conversationId,
				userId: "user-1",
			},
		]);
		await app.close();
	});

	it("records a refused claim with the reason it was refused", async () => {
		const { app, commerce, conversations, deskAudit } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});
		deskAudit.entries.length = 0;

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小王" },
		});

		expect(response.statusCode).toBe(409);
		expect(deskAudit.entries[deskAudit.entries.length - 1]).toMatchObject({
			action: "claim",
			status: "rejected",
			assignee: "客服小王",
			errorCode: "TICKET_NOT_OPEN",
		});
		await app.close();
	});

	it("records a reply against the ticket's own assignee", async () => {
		const { app, commerce, conversations, deskAudit } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});
		deskAudit.entries.length = 0;

		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/reply`,
			headers: deskHeaders,
			payload: { text: "已经在处理了" },
		});

		expect(deskAudit.entries).toMatchObject([
			{ action: "reply", status: "started", assignee: "客服小李" },
			{ action: "reply", status: "succeeded", assignee: "客服小李", conversationId, userId: "user-1" },
		]);
		await app.close();
	});

	// A reply on an unclaimed ticket is refused, and the desk has one shared token rather than a
	// per-operator identity, so there is genuinely nobody to attribute it to. Null says that;
	// writing a placeholder would invent an attribution the system cannot back up.
	it("records a refused reply with no assignee rather than a made-up one", async () => {
		const { app, commerce, conversations, deskAudit } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);

		const response = await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/reply`,
			headers: deskHeaders,
			payload: { text: "你好" },
		});

		expect(response.statusCode).toBe(409);
		expect(deskAudit.entries[deskAudit.entries.length - 1]).toMatchObject({
			action: "reply",
			status: "rejected",
			assignee: null,
			errorCode: "TICKET_NOT_ASSIGNED",
		});
		await app.close();
	});

	it("records a close with the assignee the ticket ended up with", async () => {
		const { app, commerce, conversations, deskAudit } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});
		deskAudit.entries.length = 0;

		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/close`,
			headers: deskHeaders,
			payload: { note: "已解决" },
		});

		// The close route carries no operator, so the outcome row is the only place the name can
		// come from — the ticket it just closed.
		expect(deskAudit.entries).toMatchObject([
			{ action: "close", status: "started", assignee: null },
			{ action: "close", status: "succeeded", assignee: "客服小李", conversationId, userId: "user-1" },
		]);
		await app.close();
	});

	// Auditing reads would drown the trail: the workbench re-reads the queue and the transcript
	// every few seconds, so those rows would outnumber real actions by orders of magnitude.
	it("does not audit reads", async () => {
		const { app, commerce, conversations, deskAudit } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);

		await app.inject({ method: "GET", url: "/api/support-tickets?status=open", headers: deskHeaders });
		await app.inject({ method: "GET", url: `/api/support-tickets/${ticket.id}`, headers: deskHeaders });
		await app.inject({ method: "GET", url: `/api/support-tickets/${ticket.id}/messages`, headers: deskHeaders });

		expect(deskAudit.entries).toHaveLength(0);
		await app.close();
	});

	it("reports an unknown ticket as not found", async () => {
		const { app } = createHarness();

		const response = await app.inject({
			method: "GET",
			url: "/api/support-tickets/does-not-exist",
			headers: deskHeaders,
		});

		expect(response.statusCode).toBe(404);
		await app.close();
	});

	// The desk holds an internal token, not the customer's JWT, so the customer transcript route is
	// unreachable for it. Reading the transcript through the ticket is what makes the link usable.
	it("lets the desk read the transcript behind a ticket", async () => {
		const { app, commerce, conversations } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await conversations.append(conversationId, "user-1", [
			{ role: "user", content: "我要投诉", timestamp: 1 },
			createHumanAgentMessage({ author: "客服小李", text: "已经在处理了", ticketId: ticket.id, timestamp: 2 }),
		]);

		const response = await app.inject({
			method: "GET",
			url: `/api/support-tickets/${ticket.id}/messages`,
			headers: deskHeaders,
		});

		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			conversationId: string;
			messages: { role: string; content: string; author?: string }[];
		};
		expect(body.conversationId).toBe(conversationId);
		expect(body.messages.map(({ role, content, author }) => ({ role, content, author }))).toEqual([
			{ role: "user", content: "我要投诉", author: undefined },
			{ role: "agent", content: "已经在处理了", author: "客服小李" },
		]);
		await app.close();
	});

	it("reports an empty transcript for a ticket that predates the conversation link", async () => {
		const { app, commerce } = createHarness();
		const ticket = await commerce.createSupportTicket("user-1", "迁移前建的老工单", null);

		const response = await app.inject({
			method: "GET",
			url: `/api/support-tickets/${ticket.id}/messages`,
			headers: deskHeaders,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ conversationId: null, messages: [] });
		await app.close();
	});

	it("rejects a desk transcript read without the internal token", async () => {
		const { app, commerce } = createHarness();
		const ticket = await seedTicket(commerce, "conversation-1");

		const response = await app.inject({
			method: "GET",
			url: `/api/support-tickets/${ticket.id}/messages`,
		});

		expect(response.statusCode).toBe(401);
		await app.close();
	});

	// The browser has no push channel, so it polls the transcript. This flag is what lets it show
	// the desk as present without the customer having to reload or send another message.
	it("flags a customer transcript as under human takeover once the ticket is claimed", async () => {
		const { app, commerce, conversations } = createHarness();
		const conversationId = await conversations.create("user-1");
		const token = (await app.inject({ method: "POST", url: "/api/auth/demo", payload: {} })).json().token as string;
		const ticket = await seedTicket(commerce, conversationId);

		const before = await app.inject({
			method: "GET",
			url: `/api/conversations/${conversationId}/messages`,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(before.json().underHumanTakeover).toBe(false);

		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});

		const claimed = await app.inject({
			method: "GET",
			url: `/api/conversations/${conversationId}/messages`,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(claimed.json().underHumanTakeover).toBe(true);

		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/close`,
			headers: deskHeaders,
			payload: { note: "已解决" },
		});

		const closed = await app.inject({
			method: "GET",
			url: `/api/conversations/${conversationId}/messages`,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(closed.json().underHumanTakeover).toBe(false);
		await app.close();
	});

	// Once a desk agent has claimed the ticket the bot must stop answering: two writers on one
	// conversation would contradict each other.
	it("hands the conversation to the desk instead of calling the model", async () => {
		const { app, commerce, conversations, service } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});
		const before = agentConstructions.length;

		const result = await service.runMessage("user-1", conversationId, "我补充一下情况", () => {});

		expect(result.takenOverByHuman).toBe(true);
		expect(agentConstructions).toHaveLength(before);
		expect(await conversations.load(conversationId, "user-1")).toEqual([
			{ role: "user", content: "我补充一下情况", timestamp: expect.any(Number) },
		]);
		await app.close();
	});

	it("keeps answering while nobody has claimed the conversation", async () => {
		const { app, commerce, conversations, service } = createHarness();
		const conversationId = await conversations.create("user-1");
		await seedTicket(commerce, conversationId);

		const result = await service.runMessage("user-1", conversationId, "还有货吗", () => {});

		expect(result.takenOverByHuman).toBe(false);
		await app.close();
	});

	it("answers again once the ticket is closed", async () => {
		const { app, commerce, conversations, service } = createHarness();
		const conversationId = await conversations.create("user-1");
		const ticket = await seedTicket(commerce, conversationId);
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: { assignee: "客服小李" },
		});
		await app.inject({
			method: "POST",
			url: `/api/support-tickets/${ticket.id}/close`,
			headers: deskHeaders,
			payload: { note: "已解决" },
		});

		const result = await service.runMessage("user-1", conversationId, "那再帮我查个库存", () => {});

		expect(result.takenOverByHuman).toBe(false);
		await app.close();
	});
});
