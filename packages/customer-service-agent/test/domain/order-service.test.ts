import { describe, expect, it } from "vitest";
import { CommerceError, OrderService } from "../../src/domain/order-service.ts";
import { ACTIVE_REFUND_STATUSES, TERMINAL_REFUND_STATUSES } from "../../src/domain/refund-status.ts";
import type {
	CommerceRepository,
	CreateDraftRecord,
	CreateRefundDraftRecord,
	CreateRefundRequestRecord,
	Order,
	OrderDraft,
	Product,
	RefundDraft,
	RefundListOptions,
	RefundRequest,
	SubmitDraftInput,
	UpdateRefundStatusRecord,
} from "../../src/domain/types.ts";

class FakeCommerceRepository implements CommerceRepository {
	readonly products = new Map<string, Product>([
		["HEADPHONE-BLACK", { sku: "HEADPHONE-BLACK", name: "黑色耳机", unitPriceCents: 39900 }],
	]);
	readonly inventory = new Map([["HEADPHONE-BLACK:北京", 5]]);
	readonly drafts = new Map<string, OrderDraft>();
	readonly ordersByIdempotencyKey = new Map<string, Order>();
	readonly ordersById = new Map<string, Order>();
	readonly refundRequests: RefundRequest[] = [];
	readonly refundDrafts = new Map<string, RefundDraft>();

	async findProductBySku(sku: string): Promise<Product | undefined> {
		return this.products.get(sku);
	}

	async getAvailableQuantity(sku: string, region: string): Promise<number> {
		return this.inventory.get(`${sku}:${region}`) ?? 0;
	}

	async createDraft(record: CreateDraftRecord): Promise<OrderDraft> {
		const draft = { ...record, id: `draft-${this.drafts.size + 1}`, status: "awaiting_confirmation" as const };
		this.drafts.set(draft.id, draft);
		return draft;
	}

	async getDraft(id: string): Promise<OrderDraft | undefined> {
		return this.drafts.get(id);
	}

	async confirmDraft(id: string): Promise<OrderDraft> {
		const current = this.drafts.get(id);
		if (!current) throw new Error("draft not found");
		const confirmed = { ...current, status: "confirmed" as const };
		this.drafts.set(id, confirmed);
		return confirmed;
	}

	async getOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | undefined> {
		return this.ordersByIdempotencyKey.get(idempotencyKey);
	}

	/** Mirrors the real repositories: the submitted order id or the draft id it came from. */
	async getOrder(userId: string, orderId: string): Promise<Order | undefined> {
		const order =
			this.ordersById.get(orderId) ?? [...this.ordersById.values()].find((item) => item.draftId === orderId);
		return order && order.userId === userId ? order : undefined;
	}

	async findActiveRefundRequest(orderId: string): Promise<RefundRequest | undefined> {
		return this.refundRequests.find(
			(request) => request.orderId === orderId && ACTIVE_REFUND_STATUSES.includes(request.status),
		);
	}

	async getRefundRequest(id: string): Promise<RefundRequest | undefined> {
		return this.refundRequests.find((request) => request.id === id);
	}

	async listRefundRequests(userId: string, options: RefundListOptions = {}): Promise<RefundRequest[]> {
		return this.refundRequests
			.filter((request) => request.userId === userId)
			.filter((request) => (options.orderId ? request.orderId === options.orderId : true))
			.reverse()
			.slice(0, options.limit ?? 5);
	}

	async createRefundRequest(record: CreateRefundRequestRecord): Promise<RefundRequest> {
		const existing = await this.findActiveRefundRequest(record.orderId);
		if (existing) return existing;
		const request: RefundRequest = {
			id: `refund-${this.refundRequests.length + 1}`,
			status: "pending_review",
			requestedAt: REQUESTED_AT,
			lastTransitionAt: REQUESTED_AT,
			lastTransitionBy: record.userId,
			lastTransitionNote: null,
			...record,
		};
		this.refundRequests.push(request);
		return request;
	}

	async createRefundDraft(record: CreateRefundDraftRecord): Promise<RefundDraft> {
		const draft: RefundDraft = {
			id: `refund-draft-${this.refundDrafts.size + 1}`,
			...record,
			status: "awaiting_confirmation",
			createdAt: REQUESTED_AT,
		};
		this.refundDrafts.set(draft.id, draft);
		return draft;
	}

	async getRefundDraft(id: string): Promise<RefundDraft | undefined> {
		return this.refundDrafts.get(id);
	}

	async findAwaitingRefundDraft(orderId: string): Promise<RefundDraft | undefined> {
		return [...this.refundDrafts.values()].find(
			(candidate) => candidate.orderId === orderId && candidate.status === "awaiting_confirmation",
		);
	}

	async markRefundDraftSubmitted(id: string): Promise<RefundDraft | undefined> {
		const draft = this.refundDrafts.get(id);
		if (!draft || draft.status !== "awaiting_confirmation") return undefined;
		const submitted: RefundDraft = { ...draft, status: "submitted" };
		this.refundDrafts.set(id, submitted);
		return submitted;
	}

	async updateRefundStatus(record: UpdateRefundStatusRecord): Promise<RefundRequest | undefined> {
		const index = this.refundRequests.findIndex((item) => item.id === record.id && item.status === record.from);
		const current = this.refundRequests[index];
		if (!current) return undefined;
		const updated: RefundRequest = {
			...current,
			status: record.to,
			lastTransitionAt: TRANSITIONED_AT,
			lastTransitionBy: record.actor,
			lastTransitionNote: record.note,
		};
		this.refundRequests[index] = updated;
		return updated;
	}

	async submitDraft(input: SubmitDraftInput): Promise<Order> {
		const existing = this.ordersByIdempotencyKey.get(input.idempotencyKey);
		if (existing) return existing;
		const draft = this.drafts.get(input.draftId);
		if (!draft) throw new Error("draft not found");
		const order = {
			id: `order-${this.ordersByIdempotencyKey.size + 1}`,
			userId: draft.userId,
			draftId: draft.id,
			items: draft.items,
			totalCents: draft.totalCents,
			status: "submitted" as const,
			createdAt: SUBMITTED_AT,
		};
		this.ordersByIdempotencyKey.set(input.idempotencyKey, order);
		this.ordersById.set(order.id, order);
		return order;
	}
}

const SUBMITTED_AT = "2026-09-10T00:00:00.000Z";
const REVIEWED_AT = new Date("2026-09-17T00:00:00.000Z");
const REQUESTED_AT = "2026-09-17T00:00:00.000Z";
const TRANSITIONED_AT = "2026-09-18T00:00:00.000Z";

function seedOrder(repository: FakeCommerceRepository, overrides: Partial<Order> = {}): Order {
	const order: Order = {
		id: "order-1",
		userId: "user-1",
		draftId: "draft-1",
		items: [],
		totalCents: 39900,
		status: "submitted",
		createdAt: SUBMITTED_AT,
		...overrides,
	};
	repository.ordersById.set(order.id, order);
	return order;
}

function createRefundService(repository: FakeCommerceRepository): OrderService {
	return new OrderService(repository, { now: () => REVIEWED_AT });
}

function seedRefund(repository: FakeCommerceRepository, overrides: Partial<RefundRequest> = {}): RefundRequest {
	const request: RefundRequest = {
		id: "refund-1",
		orderId: "order-1",
		userId: "user-1",
		status: "pending_review",
		reason: null,
		amountCents: 39900,
		orderCreatedAt: SUBMITTED_AT,
		requestedAt: REQUESTED_AT,
		lastTransitionAt: REQUESTED_AT,
		lastTransitionBy: "user-1",
		lastTransitionNote: null,
		...overrides,
	};
	repository.refundRequests.push(request);
	return request;
}

describe("OrderService", () => {
	it("calculates draft prices from the product repository", async () => {
		const service = new OrderService(new FakeCommerceRepository());

		const draft = await service.createDraft("user-1", "北京", [{ sku: "HEADPHONE-BLACK", quantity: 2 }]);

		expect(draft.totalCents).toBe(79800);
		expect(draft.items[0]).toMatchObject({ unitPriceCents: 39900, lineTotalCents: 79800 });
	});

	it("rejects a draft when requested inventory is unavailable", async () => {
		const service = new OrderService(new FakeCommerceRepository());

		await expect(
			service.createDraft("user-1", "北京", [{ sku: "HEADPHONE-BLACK", quantity: 6 }]),
		).rejects.toMatchObject({ code: "INSUFFICIENT_INVENTORY" });
	});

	it("merges duplicate SKUs before checking inventory and creating the draft", async () => {
		const service = new OrderService(new FakeCommerceRepository());

		const draft = await service.createDraft("user-1", "北京", [
			{ sku: "HEADPHONE-BLACK", quantity: 1 },
			{ sku: "HEADPHONE-BLACK", quantity: 2 },
		]);

		expect(draft.items).toHaveLength(1);
		expect(draft.items[0]).toMatchObject({ quantity: 3, lineTotalCents: 119700 });
	});

	it("requires ownership and confirmation before submission", async () => {
		const service = new OrderService(new FakeCommerceRepository());
		const draft = await service.createDraft("user-1", "北京", [{ sku: "HEADPHONE-BLACK", quantity: 1 }]);

		await expect(service.confirmDraft("user-2", draft.id)).rejects.toEqual(
			new CommerceError("FORBIDDEN", "Order draft does not belong to the current user"),
		);
		await expect(service.submitDraft("user-1", draft.id, "submit-1")).rejects.toMatchObject({
			code: "DRAFT_NOT_CONFIRMED",
		});
	});

	it("submits the same confirmed draft only once for one idempotency key", async () => {
		const repository = new FakeCommerceRepository();
		const service = new OrderService(repository);
		const draft = await service.createDraft("user-1", "北京", [{ sku: "HEADPHONE-BLACK", quantity: 1 }]);
		await service.confirmDraft("user-1", draft.id);

		const first = await service.submitDraft("user-1", draft.id, "submit-1");
		const second = await service.submitDraft("user-1", draft.id, "submit-1");

		expect(second.id).toBe(first.id);
		expect(repository.ordersByIdempotencyKey.size).toBe(1);
	});

	it("rejects an order returned by a racing idempotency-key collision", async () => {
		const repository = new FakeCommerceRepository();
		const service = new OrderService(repository);
		const draft = await service.createDraft("user-1", "北京", [{ sku: "HEADPHONE-BLACK", quantity: 1 }]);
		await service.confirmDraft("user-1", draft.id);
		repository.submitDraft = async () => ({
			id: "foreign-order",
			userId: "user-2",
			draftId: "foreign-draft",
			items: [],
			totalCents: 0,
			status: "submitted",
			createdAt: SUBMITTED_AT,
		});

		await expect(service.submitDraft("user-1", draft.id, "shared-key")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("OrderService refund requests", () => {
	it("records a pending refund request for an order submitted exactly at the window boundary", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);

		const decision = await createRefundService(repository).requestRefund("user-1", "order-1", "不想要了");

		expect(decision).toMatchObject({
			eligible: true,
			status: "pending_review",
			amountCents: 39900,
			orderCreatedAt: SUBMITTED_AT,
			windowDays: 7,
		});
		expect(repository.refundRequests).toHaveLength(1);
		expect(repository.refundRequests[0]).toMatchObject({
			orderId: "order-1",
			userId: "user-1",
			reason: "不想要了",
		});
	});

	it("stores no request and reports ineligibility one millisecond past the window", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository, { createdAt: "2026-09-09T23:59:59.999Z" });

		const decision = await createRefundService(repository).requestRefund("user-1", "order-1");

		expect(decision).toMatchObject({
			eligible: false,
			code: "REFUND_WINDOW_EXPIRED",
			orderCreatedAt: "2026-09-09T23:59:59.999Z",
		});
		expect(repository.refundRequests).toHaveLength(0);
	});

	it("returns the same request when the customer submits the same order twice", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		const service = createRefundService(repository);

		const first = await service.requestRefund("user-1", "order-1");
		const second = await service.requestRefund("user-1", "order-1");

		expect(first).toMatchObject({ eligible: true, refundId: "refund-1" });
		expect(second).toMatchObject({ eligible: true, refundId: "refund-1" });
		expect(repository.refundRequests).toHaveLength(1);
	});

	it("hides another user's order instead of refunding it", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);

		await expect(createRefundService(repository).requestRefund("user-2", "order-1")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(repository.refundRequests).toHaveLength(0);
	});

	it("rejects a refund request for a cancelled order", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository, { status: "cancelled" });

		await expect(createRefundService(repository).requestRefund("user-1", "order-1")).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		expect(repository.refundRequests).toHaveLength(0);
	});
});

describe("OrderService refund lifecycle", () => {
	it("walks a request from pending review to a completed refund", async () => {
		const repository = new FakeCommerceRepository();
		seedRefund(repository);
		const service = createRefundService(repository);

		const handedOff = await service.transitionRefundStatus("refund-1", "handed_off", "agent-7", "需要人工核实");
		const approved = await service.transitionRefundStatus("refund-1", "approved", "agent-7");
		const refunded = await service.transitionRefundStatus("refund-1", "refunded", "payment-gateway");

		expect(handedOff).toMatchObject({
			status: "handed_off",
			lastTransitionBy: "agent-7",
			lastTransitionNote: "需要人工核实",
		});
		expect(approved).toMatchObject({ status: "approved", lastTransitionBy: "agent-7", lastTransitionNote: null });
		expect(refunded).toMatchObject({ status: "refunded", lastTransitionBy: "payment-gateway" });
	});

	it("refuses to skip a state", async () => {
		const repository = new FakeCommerceRepository();
		seedRefund(repository);

		await expect(
			createRefundService(repository).transitionRefundStatus("refund-1", "refunded", "agent-7"),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(repository.refundRequests[0]?.status).toBe("pending_review");
	});

	it("keeps every terminal state closed", async () => {
		for (const status of TERMINAL_REFUND_STATUSES) {
			const repository = new FakeCommerceRepository();
			seedRefund(repository, { status });

			await expect(
				createRefundService(repository).transitionRefundStatus("refund-1", "approved", "agent-7"),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	it("treats a repeated transition to the current status as already done", async () => {
		const repository = new FakeCommerceRepository();
		seedRefund(repository, { status: "handed_off" });

		const result = await createRefundService(repository).transitionRefundStatus("refund-1", "handed_off", "agent-7");

		expect(result.status).toBe("handed_off");
		expect(result.lastTransitionBy).toBe("user-1");
	});

	it("rejects a transition without an actor and for an unknown request", async () => {
		const repository = new FakeCommerceRepository();
		seedRefund(repository);
		const service = createRefundService(repository);

		await expect(service.transitionRefundStatus("refund-1", "approved", "  ")).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(service.transitionRefundStatus("refund-404", "approved", "agent-7")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("lists the customer's own requests newest first and hides other users'", async () => {
		const repository = new FakeCommerceRepository();
		seedRefund(repository, { id: "refund-1", orderId: "order-1" });
		seedRefund(repository, { id: "refund-2", orderId: "order-2" });
		seedRefund(repository, { id: "refund-9", orderId: "order-9", userId: "user-2" });
		const service = createRefundService(repository);

		const mine = await service.listRefundRequests("user-1");

		expect(mine.map((request) => request.id)).toEqual(["refund-2", "refund-1"]);
	});

	it("filters by order id and accepts the draft id it came from", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		seedRefund(repository);
		seedRefund(repository, { id: "refund-2", orderId: "order-2" });
		const service = createRefundService(repository);

		const byDraft = await service.listRefundRequests("user-1", { orderId: "draft-1" });

		expect(byDraft.map((request) => request.id)).toEqual(["refund-1"]);
		await expect(service.listRefundRequests("user-1", { orderId: "order-404" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});

describe("OrderService refund gate", () => {
	// The whole point of the gate: proposing must not create a request, or a customer who merely
	// asked "can I return this?" ends up with a live application they never agreed to.
	it("writes a draft and no request when the model proposes a refund", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);

		const proposal = await createRefundService(repository).proposeRefund("user-1", "order-1", "耳机太丑");

		expect(proposal).toMatchObject({
			eligible: true,
			draftId: "refund-draft-1",
			requiresConfirmation: true,
			amountCents: 39900,
			windowDays: 7,
		});
		expect(repository.refundDrafts.size).toBe(1);
		expect(repository.refundRequests).toHaveLength(0);
		expect(await repository.findActiveRefundRequest("order-1")).toBeUndefined();
	});

	it("creates the request only once the customer confirms", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		const service = createRefundService(repository);
		const proposal = await service.proposeRefund("user-1", "order-1", "耳机太丑");
		if (!proposal.eligible) throw new Error("expected an eligible proposal");

		const decision = await service.confirmRefundDraft("user-1", proposal.draftId);

		expect(decision).toMatchObject({ eligible: true, refundId: "refund-1", status: "pending_review" });
		expect(repository.refundRequests).toHaveLength(1);
		expect(repository.refundDrafts.get(proposal.draftId)?.status).toBe("submitted");
	});

	it("reuses the draft the model already opened instead of piling up new ones", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		const service = createRefundService(repository);

		const first = await service.proposeRefund("user-1", "order-1", "耳机太丑");
		const second = await service.proposeRefund("user-1", "order-1", "耳机太丑");

		expect(second).toMatchObject({ draftId: first.eligible ? first.draftId : "unreachable" });
		expect(repository.refundDrafts.size).toBe(1);
	});

	// Days can pass between proposing and confirming, so the window is re-checked rather than
	// trusted from the draft.
	it("refuses to confirm a draft whose window has closed", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		const service = createRefundService(repository);
		// Opened while the order still qualified, then the order was re-dated to a stale one, which
		// is what a week passing between proposing and confirming looks like to the service.
		const proposal = await service.proposeRefund("user-1", "order-1");
		if (!proposal.eligible) throw new Error("expected an eligible proposal");
		repository.ordersById.set("order-1", { ...seedOrder(repository), createdAt: "2026-08-01T00:00:00.000Z" });

		const decision = await service.confirmRefundDraft("user-1", proposal.draftId);

		expect(decision).toMatchObject({ eligible: false, code: "REFUND_WINDOW_EXPIRED" });
		expect(repository.refundRequests).toHaveLength(0);
	});

	it("hides another user's draft", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		const service = createRefundService(repository);
		const proposal = await service.proposeRefund("user-1", "order-1");
		if (!proposal.eligible) throw new Error("expected an eligible proposal");

		await expect(service.confirmRefundDraft("user-2", proposal.draftId)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(repository.refundRequests).toHaveLength(0);
	});

	// A double tap, or a reload followed by another tap, must not open two requests.
	it("replays the request when the same draft is confirmed twice", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		const service = createRefundService(repository);
		const proposal = await service.proposeRefund("user-1", "order-1");
		if (!proposal.eligible) throw new Error("expected an eligible proposal");

		const first = await service.confirmRefundDraft("user-1", proposal.draftId);
		const second = await service.confirmRefundDraft("user-1", proposal.draftId);

		expect(first).toMatchObject({ eligible: true });
		expect(second).toMatchObject({ eligible: true });
		expect(repository.refundRequests).toHaveLength(1);
	});

	it("reports an ineligible window without writing a draft", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository, { createdAt: "2026-08-01T00:00:00.000Z" });

		const proposal = await createRefundService(repository).proposeRefund("user-1", "order-1");

		expect(proposal).toMatchObject({ eligible: false, code: "REFUND_WINDOW_EXPIRED" });
		expect(repository.refundDrafts.size).toBe(0);
	});
});

describe("OrderService refund cancellation", () => {
	it("cancels a request that is still waiting for review", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		seedRefund(repository);
		const service = createRefundService(repository);

		const result = await service.cancelRefundRequest("user-1", "order-1");

		expect(result).toMatchObject({
			cancelled: true,
			orderId: "order-1",
			refundId: "refund-1",
			status: "cancelled",
			statusLabel: "已撤销",
		});
		expect(repository.refundRequests[0]?.status).toBe("cancelled");
		expect(repository.refundRequests[0]?.lastTransitionBy).toBe("user-1");
	});

	it("cancels a request the desk had already taken over", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		seedRefund(repository, { status: "handed_off" });

		const result = await createRefundService(repository).cancelRefundRequest("user-1", "order-1");

		expect(result).toMatchObject({ cancelled: true, status: "cancelled" });
	});

	// Once the request is approved the money is already moving, so the customer cannot recall it.
	it("refuses to cancel an approved request", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		seedRefund(repository, { status: "approved" });

		const result = await createRefundService(repository).cancelRefundRequest("user-1", "order-1");

		expect(result).toMatchObject({
			cancelled: false,
			code: "REFUND_NOT_CANCELLABLE",
			status: "approved",
			statusLabel: "已通过审核，等待退款执行",
		});
		expect(repository.refundRequests[0]?.status).toBe("approved");
	});

	it("reports nothing to cancel once the request is terminal", async () => {
		for (const status of TERMINAL_REFUND_STATUSES) {
			const repository = new FakeCommerceRepository();
			seedOrder(repository);
			seedRefund(repository, { status });

			const result = await createRefundService(repository).cancelRefundRequest("user-1", "order-1");

			expect(result).toMatchObject({ cancelled: false, code: "NO_ACTIVE_REQUEST" });
			expect(repository.refundRequests[0]?.status).toBe(status);
		}
	});

	// Why the feature exists: an unwanted request used to hold the order until a human rejected it,
	// because the unique index allows only one active request per order.
	it("frees the order so the customer can submit a different request", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		seedRefund(repository, { reason: "耳机太丑" });
		const service = createRefundService(repository);
		await service.cancelRefundRequest("user-1", "order-1");

		const decision = await service.requestRefund("user-1", "order-1", "按键失灵");

		expect(decision).toMatchObject({ eligible: true });
		expect(await repository.findActiveRefundRequest("order-1")).toMatchObject({ reason: "按键失灵" });
		expect(repository.refundRequests).toHaveLength(2);
	});

	it("hides another user's order", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);
		seedRefund(repository);

		await expect(createRefundService(repository).cancelRefundRequest("user-2", "order-1")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(repository.refundRequests[0]?.status).toBe("pending_review");
	});

	it("reports that there is nothing to cancel when no request was ever made", async () => {
		const repository = new FakeCommerceRepository();
		seedOrder(repository);

		const result = await createRefundService(repository).cancelRefundRequest("user-1", "order-1");

		expect(result).toMatchObject({ cancelled: false, orderId: "order-1", code: "NO_ACTIVE_REQUEST" });
	});
});
