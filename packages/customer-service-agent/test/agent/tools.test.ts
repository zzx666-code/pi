import { describe, expect, it } from "vitest";
import type { CommerceGateway, KnowledgeGateway } from "../../src/agent/gateways.ts";
import { createCustomerServiceTools } from "../../src/core/tools/index.ts";
import type { OrderListEntry, RefundDecision, RefundListOptions, RefundRequest } from "../../src/domain/types.ts";

const PENDING_REFUND: RefundRequest = {
	id: "refund-1",
	orderId: "order-1",
	userId: "user-1",
	status: "pending_review",
	reason: "不想要了",
	amountCents: 39900,
	orderCreatedAt: "2026-09-10T00:00:00.000Z",
	requestedAt: "2026-09-17T00:00:00.000Z",
	lastTransitionAt: "2026-09-17T00:00:00.000Z",
	lastTransitionBy: "user-1",
	lastTransitionNote: "内部备注，不应该出现在客户可见的工具结果里",
};

class FakeCommerceGateway implements CommerceGateway {
	lastOrderUserId: string | undefined;
	lastDraftUserId: string | undefined;
	lastListOrdersUserId: string | undefined;
	lastRefundUserId: string | undefined;
	lastRefundListUserId: string | undefined;
	refundDecision: RefundDecision = {
		eligible: true,
		refundId: "refund-1",
		status: "pending_review",
		amountCents: 39900,
		orderCreatedAt: "2026-09-10T00:00:00.000Z",
		requestedAt: "2026-09-17T00:00:00.000Z",
		windowDays: 7,
	};
	refundRows: RefundRequest[] = [PENDING_REFUND];

	async searchProducts(query: string) {
		return [{ sku: "HEADPHONE-BLACK", name: `${query}耳机`, unitPriceCents: 39900 }];
	}

	async getInventory(sku: string, region: string) {
		return { sku, region, availableQuantity: 5 };
	}

	async getOrder(userId: string, orderId: string) {
		this.lastOrderUserId = userId;
		return { id: orderId, status: "submitted", totalCents: 39900 };
	}

	async listOrders(userId: string, _limit = 5): Promise<OrderListEntry[]> {
		this.lastListOrdersUserId = userId;
		return [
			{
				id: "order-1",
				status: "submitted",
				totalCents: 39900,
				createdAt: "2026-09-17T00:00:00.000Z",
				items: [{ sku: "HEADPHONE-BLACK", name: "黑色降噪耳机", quantity: 1 }],
			},
		];
	}

	async getOrderDraft(_userId: string, draftId: string) {
		return { id: draftId, status: "awaiting_confirmation", totalCents: 39900, items: [] };
	}

	async createOrderDraft(userId: string) {
		this.lastDraftUserId = userId;
		return { id: "draft-1", status: "awaiting_confirmation", totalCents: 39900, items: [] };
	}

	async createSupportTicket(_userId: string, _summary: string) {
		return { id: "ticket-1", status: "open" as const };
	}

	async requestRefund(userId: string, _orderId: string, _reason?: string) {
		this.lastRefundUserId = userId;
		return this.refundDecision;
	}

	async listRefundRequests(userId: string, _options?: RefundListOptions): Promise<RefundRequest[]> {
		this.lastRefundListUserId = userId;
		return this.refundRows;
	}
}

class FakeKnowledgeGateway implements KnowledgeGateway {
	async search(query: string) {
		return [{ content: `${query}可在七天内申请`, source: "refund-policy.md", score: 0.92 }];
	}
}

function createTools(commerce: CommerceGateway) {
	return createCustomerServiceTools(
		{ userId: "user-1", conversationId: "conversation-1" },
		commerce,
		new FakeKnowledgeGateway(),
	);
}

describe("customer service tools", () => {
	it("binds order lookup to the authenticated user instead of accepting a user id from the model", async () => {
		const commerce = new FakeCommerceGateway();
		const tools = createTools(commerce);
		const tool = tools.get_order;

		const result = await tool.execute("call-1", { orderId: "order-1" });

		expect(commerce.lastOrderUserId).toBe("user-1");
		expect(result.details).toMatchObject({ orderId: "order-1" });
	});

	it("binds the order list to the authenticated user", async () => {
		const commerce = new FakeCommerceGateway();

		const result = await createTools(commerce).list_orders.execute("call-2", {});

		expect(commerce.lastListOrdersUserId).toBe("user-1");
		expect(result.details).toMatchObject({ count: 1 });
	});

	it("marks a created order draft as requiring explicit user confirmation", async () => {
		const commerce = new FakeCommerceGateway();

		const result = await createTools(commerce).create_order_draft.execute("call-3", {
			region: "北京",
			items: [{ sku: "HEADPHONE-BLACK", quantity: 1 }],
		});

		expect(commerce.lastDraftUserId).toBe("user-1");
		expect(result.details).toMatchObject({ draftId: "draft-1", requiresConfirmation: true });
	});

	// Guards the regression where the draft id was handed to the model as `id`, so it was
	// reused as an order id and every get_order call returned NOT_FOUND.
	it("labels the draft id as draftId and never as an order id", async () => {
		const commerce = new FakeCommerceGateway();
		const tools = createTools(commerce);

		const result = await tools.create_order_draft.execute("call-4", {
			region: "北京",
			items: [{ sku: "HEADPHONE-BLACK", quantity: 1 }],
		});
		const content = result.content[0];
		const payload = JSON.parse(content.type === "text" ? content.text : "{}") as Record<string, unknown>;

		expect(payload.draftId).toBe("draft-1");
		expect(payload.id).toBeUndefined();
	});

	it("returns knowledge sources with the retrieved policy text", async () => {
		const tools = createTools(new FakeCommerceGateway());

		const result = await tools.search_knowledge_base.execute("call-5", { query: "退款" });

		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.details.sources).toEqual(["refund-policy.md"]);
	});

	it("binds a refund request to the authenticated user, never to a model-supplied id", async () => {
		const commerce = new FakeCommerceGateway();

		const result = await createTools(commerce).request_refund.execute("call-6", {
			orderId: "order-1",
			reason: "不想要了",
		});

		expect(commerce.lastRefundUserId).toBe("user-1");
		expect(result.details).toMatchObject({ eligible: true, refundId: "refund-1" });
	});

	// The window decision is data, not an exception, so the model can explain the policy instead of retrying.
	it("surfaces an ineligible refund decision with its policy code", async () => {
		const commerce = new FakeCommerceGateway();
		commerce.refundDecision = {
			eligible: false,
			code: "REFUND_WINDOW_EXPIRED",
			orderCreatedAt: "2026-08-01T00:00:00.000Z",
			windowDays: 7,
			message: "Order was submitted 47 days ago, beyond the 7-day refund window",
		};

		const result = await createTools(commerce).request_refund.execute("call-7", { orderId: "order-1" });

		expect(result.details).toMatchObject({ eligible: false, code: "REFUND_WINDOW_EXPIRED" });
	});

	it("reports refund progress with a Chinese status label and Beijing time", async () => {
		const commerce = new FakeCommerceGateway();
		commerce.refundRows = [{ ...PENDING_REFUND, status: "handed_off" }];

		const result = await createTools(commerce).list_refund_requests.execute("call-8", { orderId: "order-1" });
		const content = result.content[0];
		const payload = JSON.parse(content.type === "text" ? content.text : "[]") as Array<Record<string, unknown>>;

		expect(commerce.lastRefundListUserId).toBe("user-1");
		expect(payload[0]).toMatchObject({ status: "handed_off", statusLabel: "已移交人工处理", refundId: "refund-1" });
		expect(payload[0]?.updatedAt).toContain("北京时间");
		// Reviewer identity and internal notes stay server-side.
		expect(payload[0]?.lastTransitionNote).toBeUndefined();
		expect(payload[0]?.lastTransitionBy).toBeUndefined();
	});

	// The refund review endpoint has no gateway method, so the tool set is the model's whole reach.
	it("exposes no tool that can approve a refund", () => {
		expect(Object.keys(createTools(new FakeCommerceGateway())).sort()).toEqual([
			"create_order_draft",
			"get_inventory",
			"get_order",
			"handoff_to_human",
			"list_orders",
			"list_refund_requests",
			"request_refund",
			"search_knowledge_base",
			"search_products",
		]);
	});
});
