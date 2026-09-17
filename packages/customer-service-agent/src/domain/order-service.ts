import { isRefundTransitionAllowed, type RefundStatus } from "./refund-status.ts";
import type {
	CommerceRepository,
	DraftItem,
	DraftItemInput,
	Order,
	OrderDraft,
	RefundDecision,
	RefundListOptions,
	RefundRequest,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An order is refundable within this many days of submission. A human still reviews the request. */
export const REFUND_WINDOW_DAYS = 7;

interface OrderServiceOptions {
	/** Injectable clock so the refund window can be checked exactly at its boundary. */
	now?: () => Date;
}

function toRefundDecision(request: RefundRequest): RefundDecision {
	return {
		eligible: true,
		refundId: request.id,
		status: request.status,
		amountCents: request.amountCents,
		orderCreatedAt: request.orderCreatedAt,
		requestedAt: request.requestedAt,
		windowDays: REFUND_WINDOW_DAYS,
	};
}

export type CommerceErrorCode =
	| "DRAFT_NOT_CONFIRMED"
	| "FORBIDDEN"
	| "INSUFFICIENT_INVENTORY"
	| "INVALID_INPUT"
	| "NOT_FOUND";

export class CommerceError extends Error {
	readonly code: CommerceErrorCode;

	constructor(code: CommerceErrorCode, message: string) {
		super(message);
		this.name = "CommerceError";
		this.code = code;
	}
}

export class OrderService {
	private readonly repository: CommerceRepository;
	private readonly now: () => Date;

	constructor(repository: CommerceRepository, options: OrderServiceOptions = {}) {
		this.repository = repository;
		this.now = options.now ?? (() => new Date());
	}

	async createDraft(userId: string, region: string, itemInputs: DraftItemInput[]): Promise<OrderDraft> {
		if (!userId || !region.trim() || itemInputs.length === 0) {
			throw new CommerceError("INVALID_INPUT", "User, region, and at least one item are required");
		}

		const quantitiesBySku = new Map<string, number>();
		for (const input of itemInputs) {
			if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
				throw new CommerceError("INVALID_INPUT", `Quantity for ${input.sku} must be a positive integer`);
			}
			quantitiesBySku.set(input.sku, (quantitiesBySku.get(input.sku) ?? 0) + input.quantity);
		}

		const items: DraftItem[] = [];
		for (const [sku, quantity] of quantitiesBySku) {
			const product = await this.repository.findProductBySku(sku);
			if (!product) throw new CommerceError("NOT_FOUND", `Product ${sku} was not found`);
			const available = await this.repository.getAvailableQuantity(sku, region);
			if (available < quantity) {
				throw new CommerceError("INSUFFICIENT_INVENTORY", `Only ${available} units of ${sku} are available`);
			}
			items.push({
				...product,
				quantity,
				lineTotalCents: product.unitPriceCents * quantity,
			});
		}

		return await this.repository.createDraft({
			userId,
			region,
			items,
			totalCents: items.reduce((total, item) => total + item.lineTotalCents, 0),
		});
	}

	async confirmDraft(userId: string, draftId: string): Promise<OrderDraft> {
		const draft = await this.requireOwnedDraft(userId, draftId);
		if (draft.status === "confirmed") return draft;
		if (draft.status !== "awaiting_confirmation") {
			throw new CommerceError("INVALID_INPUT", `Draft ${draftId} cannot be confirmed from ${draft.status}`);
		}
		return await this.repository.confirmDraft(draftId);
	}

	async submitDraft(userId: string, draftId: string, idempotencyKey: string): Promise<Order> {
		if (!idempotencyKey.trim()) throw new CommerceError("INVALID_INPUT", "Idempotency key is required");
		const existing = await this.repository.getOrderByIdempotencyKey(idempotencyKey);
		if (existing) {
			this.requireMatchingOrder(existing, userId, draftId);
			return existing;
		}

		const draft = await this.requireOwnedDraft(userId, draftId);
		if (draft.status !== "confirmed") {
			throw new CommerceError("DRAFT_NOT_CONFIRMED", "Order draft must be confirmed before submission");
		}
		const order = await this.repository.submitDraft({ userId, draftId, idempotencyKey });
		this.requireMatchingOrder(order, userId, draftId);
		return order;
	}

	/**
	 * Applies the refund window, then records the request for human review.
	 *
	 * The window is decided here, by the business system, and not by the model: the tool only
	 * reports `eligible`. An order outside the window produces a normal answer instead of an
	 * exception, because a rejected window is a policy outcome, not a service failure.
	 */
	async requestRefund(userId: string, orderId: string, reason?: string): Promise<RefundDecision> {
		const order = await this.repository.getOrder(userId, orderId);
		if (!order) throw new CommerceError("NOT_FOUND", "Order was not found for the current user");
		if (order.status === "cancelled") {
			throw new CommerceError("INVALID_INPUT", "A cancelled order cannot be refunded");
		}

		const active = await this.repository.findActiveRefundRequest(order.id);
		if (active) return toRefundDecision(active);

		const submittedAt = Date.parse(order.createdAt);
		if (!Number.isFinite(submittedAt)) {
			throw new CommerceError("INVALID_INPUT", "Order submission time is unusable");
		}
		const elapsedDays = (this.now().getTime() - submittedAt) / DAY_MS;
		if (elapsedDays > REFUND_WINDOW_DAYS) {
			return {
				eligible: false,
				code: "REFUND_WINDOW_EXPIRED",
				orderCreatedAt: order.createdAt,
				windowDays: REFUND_WINDOW_DAYS,
				message: `Order was submitted ${Math.floor(elapsedDays)} days ago, beyond the ${REFUND_WINDOW_DAYS}-day refund window`,
			};
		}

		const request = await this.repository.createRefundRequest({
			orderId: order.id,
			userId,
			reason: reason?.trim() || null,
			amountCents: order.totalCents,
			orderCreatedAt: order.createdAt,
		});
		return toRefundDecision(request);
	}

	/**
	 * Customer-facing progress view. `options.orderId` accepts an order id or the draft id it
	 * came from, because the customer may quote whichever number the chat showed them.
	 */
	async listRefundRequests(userId: string, options: RefundListOptions = {}): Promise<RefundRequest[]> {
		if (!options.orderId) return await this.repository.listRefundRequests(userId, options);
		const order = await this.repository.getOrder(userId, options.orderId);
		if (!order) throw new CommerceError("NOT_FOUND", "Order was not found for the current user");
		return await this.repository.listRefundRequests(userId, { ...options, orderId: order.id });
	}

	/**
	 * Moves a refund request along its lifecycle.
	 *
	 * Only the human review workflow and the payment callback call this. The agent has no tool
	 * for it, so the model cannot approve a refund even though it can submit one. Terminal states
	 * cannot be left: a customer who was rejected submits a new request.
	 */
	async transitionRefundStatus(
		refundId: string,
		status: RefundStatus,
		actor: string,
		note?: string,
	): Promise<RefundRequest> {
		if (!actor.trim()) throw new CommerceError("INVALID_INPUT", "A transition requires an actor");
		const current = await this.repository.getRefundRequest(refundId);
		if (!current) throw new CommerceError("NOT_FOUND", `Refund request ${refundId} was not found`);
		const reviewer = actor.trim();
		if (current.status === status) return current;
		if (!isRefundTransitionAllowed(current.status, status)) {
			throw new CommerceError("INVALID_INPUT", `Refund request cannot move from ${current.status} to ${status}`);
		}

		const updated = await this.repository.updateRefundStatus({
			id: refundId,
			from: current.status,
			to: status,
			actor: reviewer,
			note: note?.trim() || null,
		});
		if (updated) return updated;

		// Another actor moved the request between our read and write; accept only the same target.
		const raced = await this.repository.getRefundRequest(refundId);
		if (raced?.status === status) return raced;
		throw new CommerceError("INVALID_INPUT", `Refund request ${refundId} was changed by another actor`);
	}

	private requireMatchingOrder(order: Order, userId: string, draftId: string): void {
		if (order.userId !== userId || order.draftId !== draftId) {
			throw new CommerceError("FORBIDDEN", "Idempotency key belongs to another order request");
		}
	}

	private async requireOwnedDraft(userId: string, draftId: string): Promise<OrderDraft> {
		const draft = await this.repository.getDraft(draftId);
		if (!draft) throw new CommerceError("NOT_FOUND", `Order draft ${draftId} was not found`);
		if (draft.userId !== userId) {
			throw new CommerceError("FORBIDDEN", "Order draft does not belong to the current user");
		}
		return draft;
	}
}
