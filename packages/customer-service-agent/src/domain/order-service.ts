import { isRefundTransitionAllowed, REFUND_STATUS_LABELS, type RefundStatus } from "./refund-status.ts";
import type {
	CancelRefundResult,
	CommerceRepository,
	DraftItem,
	DraftItemInput,
	Order,
	OrderDraft,
	RefundDecision,
	RefundDraft,
	RefundListOptions,
	RefundProposal,
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
	| "NOT_FOUND"
	| "TICKET_NOT_ASSIGNED"
	| "TICKET_NOT_OPEN";

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
		const order = await this.requireRefundableOrder(userId, orderId);

		const active = await this.repository.findActiveRefundRequest(order.id);
		if (active) return toRefundDecision(active);

		const expired = this.expiredRefundDecision(order);
		if (expired) return expired;

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
	 * Opens a refund the model proposes but cannot commit.
	 *
	 * This is the gate. It writes a draft, never a request, so a customer asking "can I return
	 * this?" cannot end up with a live application they never agreed to. The window is checked
	 * here so the confirmation card can state what is being agreed to, and checked again on
	 * confirmation because days can pass in between.
	 */
	async proposeRefund(userId: string, orderId: string, reason?: string): Promise<RefundProposal> {
		const order = await this.requireRefundableOrder(userId, orderId);

		const expired = this.expiredRefundDecision(order);
		if (expired) return expired;

		// Asking twice must not pile up drafts: an unattended draft is reused, and one the customer
		// already confirmed is visible as an active request through the one-request-per-order index.
		const existing = await this.repository.findAwaitingRefundDraft(order.id);
		const draft =
			existing ??
			(await this.repository.createRefundDraft({
				orderId: order.id,
				userId,
				reason: reason?.trim() || null,
				amountCents: order.totalCents,
			}));

		return {
			eligible: true,
			draftId: draft.id,
			requiresConfirmation: true,
			amountCents: draft.amountCents,
			orderCreatedAt: order.createdAt,
			windowDays: REFUND_WINDOW_DAYS,
		};
	}

	/**
	 * Turns the customer's confirmation into an actual request.
	 *
	 * The window is re-checked rather than trusted from the draft, so a draft that has since gone
	 * stale stays unconfirmed and reports why instead of writing a request the review workflow
	 * would only have to reject. Marking the draft first is a compare-and-set, so a double tap
	 * cannot produce two requests.
	 */
	async confirmRefundDraft(userId: string, draftId: string): Promise<RefundDecision> {
		const draft = await this.requireOwnedRefundDraft(userId, draftId);
		if (draft.status === "submitted") return await this.replaySubmittedDraft(draft);

		const order = await this.requireRefundableOrder(userId, draft.orderId);
		const expired = this.expiredRefundDecision(order);
		if (expired) return expired;

		const claimed = await this.repository.markRefundDraftSubmitted(draft.id);
		if (!claimed) return await this.replaySubmittedDraft(draft);

		return await this.requestRefund(userId, draft.orderId, draft.reason ?? undefined);
	}

	/**
	 * Withdraws a refund request the customer no longer wants.
	 *
	 * An active request blocks its order through the unique index, so without this the customer
	 * would have to wait for a human to reject it before asking again — including when the first
	 * request was not really what they wanted. Only requests that have not started paying out can
	 * be withdrawn: `approved` means the money is already on its way.
	 */
	async cancelRefundRequest(userId: string, orderId: string): Promise<CancelRefundResult> {
		const order = await this.repository.getOrder(userId, orderId);
		if (!order) throw new CommerceError("NOT_FOUND", "Order was not found for the current user");

		const active = await this.repository.findActiveRefundRequest(order.id);
		if (!active) {
			return {
				cancelled: false,
				orderId: order.id,
				code: "NO_ACTIVE_REQUEST",
				message: "There is no refund request waiting for this order",
			};
		}
		if (!isRefundTransitionAllowed(active.status, "cancelled")) {
			return {
				cancelled: false,
				orderId: order.id,
				code: "REFUND_NOT_CANCELLABLE",
				status: active.status,
				statusLabel: REFUND_STATUS_LABELS[active.status],
				message: `A refund request that is ${active.status} can no longer be withdrawn`,
			};
		}

		const updated = await this.repository.updateRefundStatus({
			id: active.id,
			from: active.status,
			to: "cancelled",
			actor: userId,
			note: null,
		});
		if (updated) {
			return {
				cancelled: true,
				orderId: order.id,
				refundId: updated.id,
				status: updated.status,
				statusLabel: REFUND_STATUS_LABELS[updated.status],
			};
		}

		// A reviewer moved the request between our read and our write; their decision stands.
		const raced = await this.repository.getRefundRequest(active.id);
		return {
			cancelled: false,
			orderId: order.id,
			code: "REFUND_NOT_CANCELLABLE",
			...(raced ? { status: raced.status, statusLabel: REFUND_STATUS_LABELS[raced.status] } : {}),
			message: `Refund request ${active.id} was changed by another actor`,
		};
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

	private async requireRefundableOrder(userId: string, orderId: string): Promise<Order> {
		const order = await this.repository.getOrder(userId, orderId);
		if (!order) throw new CommerceError("NOT_FOUND", "Order was not found for the current user");
		if (order.status === "cancelled") {
			throw new CommerceError("INVALID_INPUT", "A cancelled order cannot be refunded");
		}
		return order;
	}

	private async requireOwnedRefundDraft(userId: string, draftId: string): Promise<RefundDraft> {
		const draft = await this.repository.getRefundDraft(draftId);
		if (!draft) throw new CommerceError("NOT_FOUND", `Refund draft ${draftId} was not found`);
		if (draft.userId !== userId) {
			throw new CommerceError("FORBIDDEN", "Refund draft does not belong to the current user");
		}
		return draft;
	}

	/**
	 * Confirming a draft that is already submitted replays its request instead of failing.
	 *
	 * A customer who taps twice, or reloads and taps again, gets the same answer rather than an
	 * error about something they cannot see.
	 */
	private async replaySubmittedDraft(draft: RefundDraft): Promise<RefundDecision> {
		const active = await this.repository.findActiveRefundRequest(draft.orderId);
		if (active) return toRefundDecision(active);
		throw new CommerceError("INVALID_INPUT", `Refund draft ${draft.id} was already submitted`);
	}

	/** Undefined while the window is open, so callers can tell "still eligible" from "expired". */
	private expiredRefundDecision(order: Order): Extract<RefundDecision, { eligible: false }> | undefined {
		const submittedAt = Date.parse(order.createdAt);
		if (!Number.isFinite(submittedAt)) {
			throw new CommerceError("INVALID_INPUT", "Order submission time is unusable");
		}
		const elapsedDays = (this.now().getTime() - submittedAt) / DAY_MS;
		if (elapsedDays <= REFUND_WINDOW_DAYS) return undefined;
		return {
			eligible: false,
			code: "REFUND_WINDOW_EXPIRED",
			orderCreatedAt: order.createdAt,
			windowDays: REFUND_WINDOW_DAYS,
			message: `Order was submitted ${Math.floor(elapsedDays)} days ago, beyond the ${REFUND_WINDOW_DAYS}-day refund window`,
		};
	}
}
