import type {
	CancelRefundResult,
	DraftItemInput,
	OrderListEntry,
	RefundDecision,
	RefundDraft,
	RefundListOptions,
	RefundProposal,
	RefundRequest,
	SupportTicket,
	SupportTicketListOptions,
} from "../domain/types.ts";

export interface ProductSummary {
	sku: string;
	name: string;
	unitPriceCents: number;
}

export interface InventorySummary {
	sku: string;
	region: string;
	availableQuantity: number;
}

export interface OrderSummary {
	id: string;
	status: string;
	totalCents: number;
}

export interface DraftSummary {
	id: string;
	status: string;
	totalCents: number;
	items: unknown[];
}

export interface CommerceGateway {
	searchProducts(query: string): Promise<ProductSummary[]>;
	getInventory(sku: string, region: string): Promise<InventorySummary>;
	/** `orderId` accepts the submitted order id or the id of the draft it came from. */
	getOrder(userId: string, orderId: string): Promise<OrderSummary>;
	listOrders(userId: string, limit?: number): Promise<OrderListEntry[]>;
	getOrderDraft(userId: string, draftId: string): Promise<DraftSummary>;
	createOrderDraft(userId: string, region: string, items: DraftItemInput[]): Promise<DraftSummary>;
	/** Opens a handoff. `conversationId` ties the ticket to the transcript the desk must answer into. */
	createSupportTicket(userId: string, summary: string, conversationId: string | null): Promise<SupportTicket>;
	/**
	 * Desk operations. They carry no user identity: the desk works across customers, and none of
	 * them is exposed as an agent tool, so the model can open a ticket but never work one.
	 */
	getSupportTicket(ticketId: string): Promise<SupportTicket>;
	listSupportTickets(options?: SupportTicketListOptions): Promise<SupportTicket[]>;
	claimSupportTicket(ticketId: string, assignee: string): Promise<SupportTicket>;
	closeSupportTicket(ticketId: string, note: string | null): Promise<SupportTicket>;
	/**
	 * Records a refund request for human review.
	 * The commerce service decides the refund window, so the model never judges eligibility.
	 */
	/**
	 * Writes a refund draft. Deliberately not a submission: the model must not be able to open a
	 * live refund request on its own, so the gateway exposes the proposal and nothing further.
	 */
	proposeRefund(userId: string, orderId: string, reason?: string): Promise<RefundProposal>;
	/** Withdraws the customer's own request, releasing the order for a fresh one. */
	cancelRefundRequest(userId: string, orderId: string): Promise<CancelRefundResult>;
	/** Refund requests of the current user, newest first. */
	listRefundRequests(userId: string, options?: RefundListOptions): Promise<RefundRequest[]>;
}

export interface OrderConfirmationGateway {
	confirmOrderDraft(userId: string, draftId: string): Promise<DraftSummary>;
	submitOrderDraft(userId: string, draftId: string, idempotencyKey: string): Promise<OrderSummary>;
}

/**
 * The customer-facing half of the refund gate.
 *
 * It lives beside {@link OrderConfirmationGateway} rather than on {@link CommerceGateway} on
 * purpose: only the web client calls it, with the customer's own JWT, so the model has no path to
 * a refund request that the customer did not confirm.
 */
export interface RefundConfirmationGateway {
	confirmRefundDraft(userId: string, draftId: string): Promise<RefundDecision>;
	loadRefundDraft(userId: string, draftId: string): Promise<RefundDraft>;
}

export interface KnowledgeSearchResult {
	content: string;
	source: string;
	score: number;
}

export interface KnowledgeGateway {
	search(query: string): Promise<KnowledgeSearchResult[]>;
}

/**
 * Carries the upstream status and error code.
 *
 * Without this every business failure (404 unknown draft, 409 insufficient inventory,
 * 403 wrong owner) collapsed into a single opaque 500 at the agent boundary.
 */
export class CommerceHttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "CommerceHttpError";
		this.status = status;
		this.code = code;
	}
}

export class CommerceHttpGateway implements CommerceGateway, OrderConfirmationGateway, RefundConfirmationGateway {
	private readonly baseUrl: string;
	private readonly internalToken: string;

	constructor(baseUrl: string, internalToken: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.internalToken = internalToken;
	}

	async searchProducts(query: string): Promise<ProductSummary[]> {
		return await this.request<ProductSummary[]>(`/products?query=${encodeURIComponent(query)}`);
	}

	async getInventory(sku: string, region: string): Promise<InventorySummary> {
		return await this.request<InventorySummary>(
			`/inventory/${encodeURIComponent(sku)}?region=${encodeURIComponent(region)}`,
		);
	}

	async getOrder(userId: string, orderId: string): Promise<OrderSummary> {
		return await this.request<OrderSummary>(`/orders/${encodeURIComponent(orderId)}`, { userId });
	}

	async listOrders(userId: string, limit = 5): Promise<OrderListEntry[]> {
		return await this.request<OrderListEntry[]>(`/orders?limit=${limit}`, { userId });
	}

	async getOrderDraft(userId: string, draftId: string): Promise<DraftSummary> {
		return await this.request<DraftSummary>(`/order-drafts/${encodeURIComponent(draftId)}`, { userId });
	}

	async createOrderDraft(userId: string, region: string, items: DraftItemInput[]): Promise<DraftSummary> {
		return await this.request<DraftSummary>("/order-drafts", {
			method: "POST",
			userId,
			body: { region, items },
		});
	}

	async confirmOrderDraft(userId: string, draftId: string): Promise<DraftSummary> {
		return await this.request<DraftSummary>(`/order-drafts/${encodeURIComponent(draftId)}/confirm`, {
			method: "POST",
			userId,
		});
	}

	async submitOrderDraft(userId: string, draftId: string, idempotencyKey: string): Promise<OrderSummary> {
		return await this.request<OrderSummary>(`/order-drafts/${encodeURIComponent(draftId)}/submit`, {
			method: "POST",
			userId,
			idempotencyKey,
		});
	}

	async createSupportTicket(userId: string, summary: string, conversationId: string | null): Promise<SupportTicket> {
		return await this.request<SupportTicket>("/support-tickets", {
			method: "POST",
			userId,
			body: { summary, conversationId },
		});
	}

	async getSupportTicket(ticketId: string): Promise<SupportTicket> {
		return await this.request<SupportTicket>(`/support-tickets/${encodeURIComponent(ticketId)}`);
	}

	async listSupportTickets(options: SupportTicketListOptions = {}): Promise<SupportTicket[]> {
		const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
		if (options.status) params.set("status", options.status);
		if (options.conversationId) params.set("conversationId", options.conversationId);
		return await this.request<SupportTicket[]>(`/support-tickets?${params.toString()}`);
	}

	async claimSupportTicket(ticketId: string, assignee: string): Promise<SupportTicket> {
		return await this.request<SupportTicket>(`/support-tickets/${encodeURIComponent(ticketId)}/claim`, {
			method: "POST",
			body: { assignee },
		});
	}

	async closeSupportTicket(ticketId: string, note: string | null): Promise<SupportTicket> {
		return await this.request<SupportTicket>(`/support-tickets/${encodeURIComponent(ticketId)}/close`, {
			method: "POST",
			body: { note },
		});
	}

	async proposeRefund(userId: string, orderId: string, reason?: string): Promise<RefundProposal> {
		return await this.request<RefundProposal>("/refund-drafts", {
			method: "POST",
			userId,
			body: { orderId, reason },
		});
	}

	async confirmRefundDraft(userId: string, draftId: string): Promise<RefundDecision> {
		return await this.request<RefundDecision>(`/refund-drafts/${encodeURIComponent(draftId)}/confirm`, {
			method: "POST",
			userId,
		});
	}

	async loadRefundDraft(userId: string, draftId: string): Promise<RefundDraft> {
		return await this.request<RefundDraft>(`/refund-drafts/${encodeURIComponent(draftId)}`, { userId });
	}

	async cancelRefundRequest(userId: string, orderId: string): Promise<CancelRefundResult> {
		return await this.request<CancelRefundResult>("/refund-requests/cancel", {
			method: "POST",
			userId,
			body: { orderId },
		});
	}

	async listRefundRequests(userId: string, options: RefundListOptions = {}): Promise<RefundRequest[]> {
		const params = new URLSearchParams({ limit: String(options.limit ?? 5) });
		if (options.orderId) params.set("orderId", options.orderId);
		return await this.request<RefundRequest[]>(`/refund-requests?${params.toString()}`, { userId });
	}

	private async request<T>(
		path: string,
		options: {
			method?: "GET" | "POST";
			userId?: string;
			idempotencyKey?: string;
			body?: unknown;
		} = {},
	): Promise<T> {
		const headers: Record<string, string> = { "x-internal-token": this.internalToken };
		if (options.userId) headers["x-user-id"] = options.userId;
		if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
		if (options.body !== undefined) headers["content-type"] = "application/json";
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => undefined)) as { code?: string; message?: string } | undefined;
			throw new CommerceHttpError(
				response.status,
				body?.code ?? "COMMERCE_ERROR",
				body?.message ?? `Commerce API returned ${response.status}`,
			);
		}
		return (await response.json()) as T;
	}
}
