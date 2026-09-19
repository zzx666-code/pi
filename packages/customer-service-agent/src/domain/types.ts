import type { RefundStatus } from "./refund-status.ts";
import type { SupportTicketStatus } from "./support-ticket.ts";

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

/**
 * `awaiting_confirmation` is the only state the model can create; `submitted` means the customer
 * confirmed it and a real request now exists. There is no `expired`: a draft whose refund window
 * has closed fails the eligibility check at confirmation time and simply stays unconfirmed.
 */
export type RefundDraftStatus = "awaiting_confirmation" | "submitted";

/**
 * A refund the model proposed but the customer has not approved yet.
 *
 * It exists so that opening a refund is two moves instead of one: the model writes a draft, and
 * only the customer's own confirmation turns it into a request. The same shape the order draft
 * already uses — the difference is that an order draft holds goods and this holds an intent.
 */
export interface RefundDraft {
	id: string;
	orderId: string;
	userId: string;
	reason: string | null;
	amountCents: number;
	status: RefundDraftStatus;
	createdAt: string;
}

export interface CreateRefundDraftRecord {
	orderId: string;
	userId: string;
	reason: string | null;
	amountCents: number;
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

/**
 * Outcome of a customer withdrawing their own refund request.
 *
 * Like {@link RefundDecision}, "there was nothing to cancel" is a normal business answer rather
 * than an exception: the customer changed their mind, and the model has to explain the state
 * instead of retrying. A customer may also cancel and ask again later, because the order stops
 * being blocked the moment the request leaves the active states.
 */
export type CancelRefundResult =
	| {
			cancelled: true;
			orderId: string;
			refundId: string;
			status: RefundStatus;
			statusLabel: string;
	  }
	| {
			cancelled: false;
			orderId: string;
			code: "NO_ACTIVE_REQUEST" | "REFUND_NOT_CANCELLABLE";
			status?: RefundStatus;
			statusLabel?: string;
			message: string;
	  };

/**
 * Outcome of the model asking to open a refund.
 *
 * `eligible: true` only means a draft was written — nothing has been applied for yet. The customer
 * still has to confirm it, which is the point: the model proposes, and only the customer commits.
 * Unlike {@link RefundDecision} there is no request id here, because no request exists yet.
 */
export type RefundProposal =
	| {
			eligible: true;
			draftId: string;
			requiresConfirmation: true;
			amountCents: number;
			orderCreatedAt: string;
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

/**
 * A handoff the human desk works through. Transitions live in ./support-ticket.ts.
 *
 * The originating conversation is kept on the ticket, because a reply from the desk has to be
 * written back into that transcript; without it a ticket is just an unattached note.
 */
export interface SupportTicket {
	id: string;
	userId: string;
	conversationId: string | null;
	summary: string;
	status: SupportTicketStatus;
	/** Support agent who claimed it. Stays set after closing so the history stays readable. */
	assignee: string | null;
	claimedAt: string | null;
	closedAt: string | null;
	closeNote: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SupportTicketListOptions {
	status?: SupportTicketStatus;
	/** Narrows to the ticket opened from one conversation, which is how takeover is detected. */
	conversationId?: string;
	limit?: number;
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
	createRefundDraft(record: CreateRefundDraftRecord): Promise<RefundDraft>;
	getRefundDraft(id: string): Promise<RefundDraft | undefined>;
	/** The draft still waiting for the customer, if any. One is enough; a repeat call reuses it. */
	findAwaitingRefundDraft(orderId: string): Promise<RefundDraft | undefined>;
	/** Compare-and-set on `awaiting_confirmation`, so two taps cannot both produce a request. */
	markRefundDraftSubmitted(id: string): Promise<RefundDraft | undefined>;
}

export interface CommerceStore extends CommerceRepository {
	searchProducts(query: string, limit?: number): Promise<Product[]>;
	listOrders(userId: string, limit?: number): Promise<OrderListEntry[]>;
	createSupportTicket(userId: string, summary: string, conversationId: string | null): Promise<SupportTicket>;
	getSupportTicket(id: string): Promise<SupportTicket | undefined>;
	/** Newest first. The desk filters by `status` to find work that is still open. */
	listSupportTickets(options?: SupportTicketListOptions): Promise<SupportTicket[]>;
	/** Returns undefined unless the ticket was still `open`, so two agents cannot both claim it. */
	claimSupportTicket(ticketId: string, assignee: string): Promise<SupportTicket | undefined>;
	/** Returns undefined unless the ticket was `assigned`: nobody closes work they never took. */
	closeSupportTicket(ticketId: string, note: string | null): Promise<SupportTicket | undefined>;
}

export interface DraftItemInput {
	sku: string;
	quantity: number;
}
