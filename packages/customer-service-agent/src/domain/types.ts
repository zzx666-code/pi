import type { RefundStatus } from "./refund-status.ts";

export interface Product {
	sku: string;
	name: string;
	unitPriceCents: number;
}

export interface DraftItem extends Product {
	quantity: number;
	lineTotalCents: number;
}

export type DraftStatus = "awaiting_confirmation" | "confirmed" | "submitted" | "cancelled";

export interface OrderDraft {
	id: string;
	userId: string;
	region: string;
	items: DraftItem[];
	totalCents: number;
	status: DraftStatus;
}

export interface Order {
	id: string;
	userId: string;
	draftId: string;
	items: DraftItem[];
	totalCents: number;
	status: "submitted" | "paid" | "cancelled";
	/** Submission time. The refund window is measured from this instant. */
	createdAt: string;
}

/**
 * A refund request waits for a human decision. The agent may create one, never approve one,
 * so `status` starts at `pending_review` and only the review workflow moves it.
 * Allowed moves live in ./refund-status.ts.
 */
export interface RefundRequest {
	id: string;
	orderId: string;
	userId: string;
	status: RefundStatus;
	reason: string | null;
	amountCents: number;
	/** Snapshot of the decision input, so the window check stays reproducible after review. */
	orderCreatedAt: string;
	requestedAt: string;
	/** Last status change. Creating the request counts as its first move, by the customer. */
	lastTransitionAt: string;
	lastTransitionBy: string;
	lastTransitionNote: string | null;
}

export interface CreateRefundRequestRecord {
	orderId: string;
	userId: string;
	reason: string | null;
	amountCents: number;
	orderCreatedAt: string;
}

export interface UpdateRefundStatusRecord {
	id: string;
	/** Compare-and-set guard: the update only applies while the row is still in this state. */
	from: RefundStatus;
	to: RefundStatus;
	actor: string;
	note: string | null;
}

export interface RefundListOptions {
	/** Narrows the list to one order when the customer quoted an order number. */
	orderId?: string;
	limit?: number;
}

/**
 * Outcome of a refund request. `eligible: false` is a normal business answer, not a failure:
 * the caller must explain the policy instead of retrying.
 */
export type RefundDecision =
	| {
			eligible: true;
			refundId: string;
			status: RefundStatus;
			amountCents: number;
			orderCreatedAt: string;
			requestedAt: string;
			windowDays: number;
	  }
	| {
			eligible: false;
			code: "REFUND_WINDOW_EXPIRED";
			orderCreatedAt: string;
			windowDays: number;
			message: string;
	  };

export type CreateDraftRecord = Omit<OrderDraft, "id" | "status">;

export interface SubmitDraftInput {
	userId: string;
	draftId: string;
	idempotencyKey: string;
}

/** Compact order row for listings, so the agent can answer without loading full line items. */
export interface OrderListEntry {
	id: string;
	status: Order["status"];
	totalCents: number;
	createdAt: string;
	items: { sku: string; name: string; quantity: number }[];
}

export interface CommerceRepository {
	findProductBySku(sku: string): Promise<Product | undefined>;
	getAvailableQuantity(sku: string, region: string): Promise<number>;
	createDraft(record: CreateDraftRecord): Promise<OrderDraft>;
	getDraft(id: string): Promise<OrderDraft | undefined>;
	confirmDraft(id: string): Promise<OrderDraft>;
	getOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | undefined>;
	/**
	 * `orderId` accepts either the submitted order id or the id of the draft it came from.
	 * Confirmation mints a new order id, so callers that only know the draft id still resolve.
	 */
	getOrder(userId: string, orderId: string): Promise<Order | undefined>;
	submitDraft(input: SubmitDraftInput): Promise<Order>;
	/** Refund request that still blocks a new one for the same order, if any. */
	findActiveRefundRequest(orderId: string): Promise<RefundRequest | undefined>;
	getRefundRequest(id: string): Promise<RefundRequest | undefined>;
	/** Newest first. A rejected request can be replaced, so one order may have several rows. */
	listRefundRequests(userId: string, options?: RefundListOptions): Promise<RefundRequest[]>;
	createRefundRequest(record: CreateRefundRequestRecord): Promise<RefundRequest>;
	/** Returns undefined when the row had already left `from`, so the caller can detect a race. */
	updateRefundStatus(record: UpdateRefundStatusRecord): Promise<RefundRequest | undefined>;
}

export interface CommerceStore extends CommerceRepository {
	searchProducts(query: string, limit?: number): Promise<Product[]>;
	listOrders(userId: string, limit?: number): Promise<OrderListEntry[]>;
	createSupportTicket(userId: string, summary: string): Promise<{ id: string; status: "open" }>;
}

export interface DraftItemInput {
	sku: string;
	quantity: number;
}
