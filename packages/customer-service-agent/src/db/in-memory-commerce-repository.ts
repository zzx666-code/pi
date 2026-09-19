import { randomUUID } from "node:crypto";
import { CommerceError } from "../domain/order-service.ts";
import { ACTIVE_REFUND_STATUSES } from "../domain/refund-status.ts";
import type {
	CommerceStore,
	CreateDraftRecord,
	CreateRefundDraftRecord,
	CreateRefundRequestRecord,
	Order,
	OrderDraft,
	OrderListEntry,
	Product,
	RefundDraft,
	RefundListOptions,
	RefundRequest,
	SubmitDraftInput,
	SupportTicket,
	SupportTicketListOptions,
	UpdateRefundStatusRecord,
} from "../domain/types.ts";

interface InventorySeed {
	sku: string;
	region: string;
	availableQuantity: number;
}

interface InMemoryCommerceOptions {
	products: Product[];
	inventory: InventorySeed[];
	/** Injectable clock so tests can age an order past the refund window without waiting. */
	now?: () => Date;
}

export class InMemoryCommerceRepository implements CommerceStore {
	private readonly products: Map<string, Product>;
	private readonly inventory: Map<string, number>;
	private readonly drafts = new Map<string, OrderDraft>();
	private readonly ordersById = new Map<string, Order>();
	private readonly ordersByIdempotencyKey = new Map<string, Order>();
	private readonly refundRequests: RefundRequest[] = [];
	private readonly refundDrafts = new Map<string, RefundDraft>();
	private readonly supportTickets = new Map<string, SupportTicket>();
	private readonly now: () => Date;

	constructor(options: InMemoryCommerceOptions) {
		this.products = new Map(options.products.map((product) => [product.sku, product]));
		this.inventory = new Map(options.inventory.map((item) => [`${item.sku}:${item.region}`, item.availableQuantity]));
		this.now = options.now ?? (() => new Date());
	}

	async searchProducts(query: string, limit = 10): Promise<Product[]> {
		const normalized = query.trim().toLowerCase();
		return [...this.products.values()]
			.filter((product) => `${product.sku} ${product.name}`.toLowerCase().includes(normalized))
			.slice(0, limit);
	}

	async findProductBySku(sku: string): Promise<Product | undefined> {
		return this.products.get(sku);
	}

	async getAvailableQuantity(sku: string, region: string): Promise<number> {
		return this.inventory.get(`${sku}:${region}`) ?? 0;
	}

	async createDraft(record: CreateDraftRecord): Promise<OrderDraft> {
		const draft = { ...record, id: randomUUID(), status: "awaiting_confirmation" as const };
		this.drafts.set(draft.id, draft);
		return structuredClone(draft);
	}

	async getDraft(id: string): Promise<OrderDraft | undefined> {
		const draft = this.drafts.get(id);
		return draft ? structuredClone(draft) : undefined;
	}

	async confirmDraft(id: string): Promise<OrderDraft> {
		const draft = this.drafts.get(id);
		if (!draft || draft.status !== "awaiting_confirmation") {
			throw new CommerceError("INVALID_INPUT", `Draft ${id} cannot be confirmed`);
		}
		const confirmed = { ...draft, status: "confirmed" as const };
		this.drafts.set(id, confirmed);
		return structuredClone(confirmed);
	}

	async getOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | undefined> {
		const order = this.ordersByIdempotencyKey.get(idempotencyKey);
		return order ? structuredClone(order) : undefined;
	}

	/** Accepts the submitted order id or the id of the draft it was submitted from. */
	async getOrder(userId: string, orderId: string): Promise<Order | undefined> {
		const order =
			this.ordersById.get(orderId) ?? [...this.ordersById.values()].find((item) => item.draftId === orderId);
		return order && order.userId === userId ? structuredClone(order) : undefined;
	}

	async listOrders(userId: string, limit = 5): Promise<OrderListEntry[]> {
		return [...this.ordersById.values()]
			.filter((order) => order.userId === userId)
			.reverse()
			.slice(0, Math.min(Math.max(limit, 1), 20))
			.map((order) => ({
				id: order.id,
				status: order.status,
				totalCents: order.totalCents,
				createdAt: order.createdAt,
				items: order.items.map((item) => ({ sku: item.sku, name: item.name, quantity: item.quantity })),
			}));
	}

	async submitDraft(input: SubmitDraftInput): Promise<Order> {
		const existing = this.ordersByIdempotencyKey.get(input.idempotencyKey);
		if (existing) return structuredClone(existing);
		const draft = this.drafts.get(input.draftId);
		if (!draft) throw new CommerceError("NOT_FOUND", `Draft ${input.draftId} was not found`);
		if (draft.userId !== input.userId) throw new CommerceError("FORBIDDEN", "Draft belongs to another user");
		if (draft.status !== "confirmed") {
			throw new CommerceError("DRAFT_NOT_CONFIRMED", "Draft must be confirmed before submission");
		}
		for (const item of draft.items) {
			const key = `${item.sku}:${draft.region}`;
			const available = this.inventory.get(key) ?? 0;
			if (available < item.quantity) {
				throw new CommerceError("INSUFFICIENT_INVENTORY", `Only ${available} units of ${item.sku} are available`);
			}
		}
		for (const item of draft.items) {
			const key = `${item.sku}:${draft.region}`;
			this.inventory.set(key, (this.inventory.get(key) ?? 0) - item.quantity);
		}
		const order: Order = {
			id: randomUUID(),
			userId: draft.userId,
			draftId: draft.id,
			items: structuredClone(draft.items),
			totalCents: draft.totalCents,
			status: "submitted",
			createdAt: this.now().toISOString(),
		};
		this.ordersById.set(order.id, order);
		this.ordersByIdempotencyKey.set(input.idempotencyKey, order);
		this.drafts.set(draft.id, { ...draft, status: "submitted" });
		return structuredClone(order);
	}

	/**
	 * Opens a handoff, or returns the one this conversation already has.
	 *
	 * Mirrors the unique index on `active_conversation_id` in the MySQL repository: a conversation
	 * holds at most one ticket that is not closed, so repeating a handoff cannot put the same
	 * customer into the desk queue twice. Closing frees the slot for a genuinely new escalation.
	 */
	async createSupportTicket(userId: string, summary: string, conversationId: string | null): Promise<SupportTicket> {
		if (conversationId) {
			const existing = this.activeTicketFor(conversationId);
			if (existing) return structuredClone(existing);
		}
		const now = this.now().toISOString();
		const ticket: SupportTicket = {
			id: randomUUID(),
			userId,
			conversationId,
			summary,
			status: "open",
			assignee: null,
			claimedAt: null,
			closedAt: null,
			closeNote: null,
			createdAt: now,
			updatedAt: now,
		};
		this.supportTickets.set(ticket.id, ticket);
		return structuredClone(ticket);
	}

	private activeTicketFor(conversationId: string): SupportTicket | undefined {
		return [...this.supportTickets.values()].find(
			(ticket) => ticket.conversationId === conversationId && ticket.status !== "closed",
		);
	}

	async getSupportTicket(id: string): Promise<SupportTicket | undefined> {
		const ticket = this.supportTickets.get(id);
		return ticket ? structuredClone(ticket) : undefined;
	}

	async listSupportTickets(options: SupportTicketListOptions = {}): Promise<SupportTicket[]> {
		const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
		return [...this.supportTickets.values()]
			.filter((ticket) => (options.status ? ticket.status === options.status : true))
			.filter((ticket) => (options.conversationId ? ticket.conversationId === options.conversationId : true))
			.reverse()
			.slice(0, limit)
			.map((ticket) => structuredClone(ticket));
	}

	async claimSupportTicket(ticketId: string, assignee: string): Promise<SupportTicket | undefined> {
		const ticket = this.supportTickets.get(ticketId);
		if (!ticket || ticket.status !== "open") return undefined;
		const now = this.now().toISOString();
		const claimed: SupportTicket = {
			...ticket,
			status: "assigned",
			assignee,
			claimedAt: now,
			updatedAt: now,
		};
		this.supportTickets.set(ticketId, claimed);
		return structuredClone(claimed);
	}

	async closeSupportTicket(ticketId: string, note: string | null): Promise<SupportTicket | undefined> {
		const ticket = this.supportTickets.get(ticketId);
		if (!ticket || ticket.status !== "assigned") return undefined;
		const now = this.now().toISOString();
		const closed: SupportTicket = {
			...ticket,
			status: "closed",
			closedAt: now,
			closeNote: note,
			updatedAt: now,
		};
		this.supportTickets.set(ticketId, closed);
		return structuredClone(closed);
	}

	async findActiveRefundRequest(orderId: string): Promise<RefundRequest | undefined> {
		const existing = this.refundRequests.find(
			(request) => request.orderId === orderId && ACTIVE_REFUND_STATUSES.includes(request.status),
		);
		return existing ? structuredClone(existing) : undefined;
	}

	async getRefundRequest(id: string): Promise<RefundRequest | undefined> {
		const request = this.refundRequests.find((item) => item.id === id);
		return request ? structuredClone(request) : undefined;
	}

	async listRefundRequests(userId: string, options: RefundListOptions = {}): Promise<RefundRequest[]> {
		const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
		return this.refundRequests
			.filter((request) => request.userId === userId)
			.filter((request) => (options.orderId ? request.orderId === options.orderId : true))
			.reverse()
			.slice(0, limit)
			.map((request) => structuredClone(request));
	}

	async createRefundRequest(record: CreateRefundRequestRecord): Promise<RefundRequest> {
		const existing = await this.findActiveRefundRequest(record.orderId);
		if (existing) return existing;
		const requestedAt = this.now().toISOString();
		const request: RefundRequest = {
			id: randomUUID(),
			status: "pending_review",
			requestedAt,
			lastTransitionAt: requestedAt,
			lastTransitionBy: record.userId,
			lastTransitionNote: null,
			...record,
		};
		this.refundRequests.push(request);
		return structuredClone(request);
	}

	async createRefundDraft(record: CreateRefundDraftRecord): Promise<RefundDraft> {
		const now = this.now().toISOString();
		const draft: RefundDraft = {
			id: randomUUID(),
			...record,
			status: "awaiting_confirmation",
			createdAt: now,
		};
		this.refundDrafts.set(draft.id, draft);
		return structuredClone(draft);
	}

	async getRefundDraft(id: string): Promise<RefundDraft | undefined> {
		const draft = this.refundDrafts.get(id);
		return draft ? structuredClone(draft) : undefined;
	}

	async findAwaitingRefundDraft(orderId: string): Promise<RefundDraft | undefined> {
		const draft = [...this.refundDrafts.values()].find(
			(candidate) => candidate.orderId === orderId && candidate.status === "awaiting_confirmation",
		);
		return draft ? structuredClone(draft) : undefined;
	}

	async markRefundDraftSubmitted(id: string): Promise<RefundDraft | undefined> {
		const draft = this.refundDrafts.get(id);
		if (!draft || draft.status !== "awaiting_confirmation") return undefined;
		const submitted: RefundDraft = { ...draft, status: "submitted" };
		this.refundDrafts.set(id, submitted);
		return structuredClone(submitted);
	}

	async updateRefundStatus(record: UpdateRefundStatusRecord): Promise<RefundRequest | undefined> {
		const index = this.refundRequests.findIndex((item) => item.id === record.id && item.status === record.from);
		const current = this.refundRequests[index];
		if (!current) return undefined;
		const updated: RefundRequest = {
			...current,
			status: record.to,
			lastTransitionAt: this.now().toISOString(),
			lastTransitionBy: record.actor,
			lastTransitionNote: record.note,
		};
		this.refundRequests[index] = updated;
		return structuredClone(updated);
	}
}
