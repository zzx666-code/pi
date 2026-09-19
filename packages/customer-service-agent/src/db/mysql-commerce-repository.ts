import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { CommerceError } from "../domain/order-service.ts";
import type { RefundStatus } from "../domain/refund-status.ts";
import type { SupportTicketStatus } from "../domain/support-ticket.ts";
import type {
	CommerceStore,
	CreateDraftRecord,
	CreateRefundDraftRecord,
	CreateRefundRequestRecord,
	DraftItem,
	DraftStatus,
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

interface ProductRow extends RowDataPacket {
	sku: string;
	name: string;
	unit_price_cents: number;
}

interface QuantityRow extends RowDataPacket {
	available_quantity: number;
}

interface DraftRow extends RowDataPacket {
	id: string;
	user_id: string;
	region: string;
	total_cents: number;
	status: DraftStatus;
}

interface ItemRow extends RowDataPacket {
	sku: string;
	product_name: string;
	unit_price_cents: number;
	quantity: number;
	line_total_cents: number;
}

interface OrderRow extends RowDataPacket {
	id: string;
	user_id: string;
	draft_id: string;
	total_cents: number;
	status: Order["status"];
	created_at: Date | string;
}

interface RefundRow extends RowDataPacket {
	id: string;
	order_id: string;
	user_id: string;
	status: RefundStatus;
	amount_cents: number;
	reason: string | null;
	order_created_at: Date | string;
	requested_at: Date | string;
	last_transition_at: Date | string;
	last_transition_by: string;
	last_transition_note: string | null;
}

/** Kept as one string so every refund query returns the same shape. */
const REFUND_COLUMNS = `id, order_id, user_id, status, amount_cents, reason, order_created_at, requested_at,
	last_transition_at, last_transition_by, last_transition_note`;

interface RefundDraftRow extends RowDataPacket {
	id: string;
	order_id: string;
	user_id: string;
	reason: string | null;
	amount_cents: number;
	status: RefundDraft["status"];
	created_at: Date | string;
}

const REFUND_DRAFT_COLUMNS = "id, order_id, user_id, reason, amount_cents, status, created_at";

interface OrderListRow extends RowDataPacket {
	id: string;
	status: Order["status"];
	total_cents: number;
	created_at: Date | string;
}

interface OrderListItemRow extends RowDataPacket {
	order_id: string;
	sku: string;
	product_name: string;
	quantity: number;
}

interface SupportTicketRow extends RowDataPacket {
	id: string;
	user_id: string;
	conversation_id: string | null;
	summary: string;
	status: SupportTicketStatus;
	assignee: string | null;
	claimed_at: Date | string | null;
	closed_at: Date | string | null;
	close_note: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

/** Kept as one string so every ticket query returns the same shape. */
const SUPPORT_TICKET_COLUMNS = `id, user_id, conversation_id, summary, status, assignee, claimed_at, closed_at,
	close_note, created_at, updated_at`;

function mapItem(row: ItemRow): DraftItem {
	return {
		sku: row.sku,
		name: row.product_name,
		unitPriceCents: row.unit_price_cents,
		quantity: row.quantity,
		lineTotalCents: row.line_total_cents,
	};
}

function mapRefundRequest(row: RefundRow): RefundRequest {
	return {
		id: row.id,
		orderId: row.order_id,
		userId: row.user_id,
		status: row.status,
		reason: row.reason,
		amountCents: row.amount_cents,
		orderCreatedAt: new Date(row.order_created_at).toISOString(),
		requestedAt: new Date(row.requested_at).toISOString(),
		lastTransitionAt: new Date(row.last_transition_at).toISOString(),
		lastTransitionBy: row.last_transition_by,
		lastTransitionNote: row.last_transition_note,
	};
}

function mapRefundDraft(row: RefundDraftRow): RefundDraft {
	return {
		id: row.id,
		orderId: row.order_id,
		userId: row.user_id,
		reason: row.reason,
		amountCents: row.amount_cents,
		status: row.status,
		createdAt: new Date(row.created_at).toISOString(),
	};
}

function mapSupportTicket(row: SupportTicketRow): SupportTicket {
	return {
		id: row.id,
		userId: row.user_id,
		conversationId: row.conversation_id,
		summary: row.summary,
		status: row.status,
		assignee: row.assignee,
		claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
		closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
		closeNote: row.close_note,
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

/** The unique index on the active order is the last line of defence against a concurrent double request. */
function isDuplicateKeyError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_DUP_ENTRY";
}

/**
 * InnoDB rolls one transaction back to break a lock cycle and expects the caller to try again.
 *
 * Order submission acquires two rows per transaction, so two requests sharing an idempotency key
 * can still meet in a cycle under unusual interleavings even with the draft lock taken first.
 */
function isDeadlockError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_LOCK_DEADLOCK";
}

export class MySqlCommerceRepository implements CommerceStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async searchProducts(query: string, limit = 10): Promise<Product[]> {
		const term = `%${query.trim()}%`;
		const [rows] = await this.pool.execute<ProductRow[]>(
			"SELECT sku, name, unit_price_cents FROM products WHERE active = TRUE AND (sku LIKE ? OR name LIKE ? OR description LIKE ?) ORDER BY name LIMIT ?",
			[term, term, term, Math.min(Math.max(limit, 1), 20)],
		);
		return rows.map((row) => ({ sku: row.sku, name: row.name, unitPriceCents: row.unit_price_cents }));
	}

	async findProductBySku(sku: string): Promise<Product | undefined> {
		const [rows] = await this.pool.execute<ProductRow[]>(
			"SELECT sku, name, unit_price_cents FROM products WHERE sku = ? AND active = TRUE",
			[sku],
		);
		const row = rows[0];
		return row ? { sku: row.sku, name: row.name, unitPriceCents: row.unit_price_cents } : undefined;
	}

	async getAvailableQuantity(sku: string, region: string): Promise<number> {
		const [rows] = await this.pool.execute<QuantityRow[]>(
			"SELECT available_quantity FROM inventory WHERE sku = ? AND region = ?",
			[sku, region],
		);
		return rows[0]?.available_quantity ?? 0;
	}

	async createDraft(record: CreateDraftRecord): Promise<OrderDraft> {
		const id = randomUUID();
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			await connection.execute(
				"INSERT INTO order_drafts (id, user_id, region, total_cents, status) VALUES (?, ?, ?, ?, 'awaiting_confirmation')",
				[id, record.userId, record.region, record.totalCents],
			);
			for (const item of record.items) {
				await connection.execute(
					"INSERT INTO order_draft_items (draft_id, sku, product_name, unit_price_cents, quantity, line_total_cents) VALUES (?, ?, ?, ?, ?, ?)",
					[id, item.sku, item.name, item.unitPriceCents, item.quantity, item.lineTotalCents],
				);
			}
			await connection.commit();
			return { ...record, id, status: "awaiting_confirmation" };
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async getDraft(id: string): Promise<OrderDraft | undefined> {
		return await this.loadDraft(this.pool, id);
	}

	async confirmDraft(id: string): Promise<OrderDraft> {
		const [result] = await this.pool.execute<ResultSetHeader>(
			"UPDATE order_drafts SET status = 'confirmed' WHERE id = ? AND status = 'awaiting_confirmation'",
			[id],
		);
		if (result.affectedRows === 0) throw new CommerceError("INVALID_INPUT", `Draft ${id} cannot be confirmed`);
		const draft = await this.getDraft(id);
		if (!draft) throw new CommerceError("NOT_FOUND", `Order draft ${id} was not found`);
		return draft;
	}

	async getOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | undefined> {
		const [rows] = await this.pool.execute<OrderRow[]>(
			"SELECT id, user_id, draft_id, total_cents, status, created_at FROM orders WHERE idempotency_key = ?",
			[idempotencyKey],
		);
		return rows[0] ? await this.loadOrder(this.pool, rows[0]) : undefined;
	}

	/**
	 * Matches the submitted order id first and falls back to the draft id it came from.
	 * `orders.draft_id` is UNIQUE, so the fallback resolves to at most one row.
	 */
	async getOrder(userId: string, orderId: string): Promise<Order | undefined> {
		const [rows] = await this.pool.execute<OrderRow[]>(
			"SELECT id, user_id, draft_id, total_cents, status, created_at FROM orders WHERE user_id = ? AND (id = ? OR draft_id = ?)",
			[userId, orderId, orderId],
		);
		return rows[0] ? await this.loadOrder(this.pool, rows[0]) : undefined;
	}

	async listOrders(userId: string, limit = 5): Promise<OrderListEntry[]> {
		const [rows] = await this.pool.execute<OrderListRow[]>(
			"SELECT id, status, total_cents, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
			[userId, Math.min(Math.max(limit, 1), 20)],
		);
		if (rows.length === 0) return [];

		const [itemRows] = await this.pool.query<OrderListItemRow[]>(
			"SELECT order_id, sku, product_name, quantity FROM order_items WHERE order_id IN (?) ORDER BY order_id, sku",
			[rows.map((row) => row.id)],
		);
		const itemsByOrder = new Map<string, OrderListEntry["items"]>();
		for (const item of itemRows) {
			const items = itemsByOrder.get(item.order_id) ?? [];
			items.push({ sku: item.sku, name: item.product_name, quantity: item.quantity });
			itemsByOrder.set(item.order_id, items);
		}
		return rows.map((row) => ({
			id: row.id,
			status: row.status,
			totalCents: row.total_cents,
			createdAt: new Date(row.created_at).toISOString(),
			items: itemsByOrder.get(row.id) ?? [],
		}));
	}

	/**
	 * Submits a confirmed draft, tolerating a concurrent request that carries the same key.
	 *
	 * Losing that race is not a failure: the order exists, so the retry reads it back. Reporting an
	 * error would only make the client retry the same call and eventually succeed anyway.
	 */
	async submitDraft(input: SubmitDraftInput): Promise<Order> {
		try {
			return await this.submitDraftOnce(input);
		} catch (error) {
			if (!isDeadlockError(error) && !isDuplicateKeyError(error)) throw error;
			return await this.submitDraftOnce(input);
		}
	}

	private async submitDraftOnce(input: SubmitDraftInput): Promise<Order> {
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			// The draft lock is taken first on purpose. Every racer needs this row, so the rest of
			// the transaction runs serialised. Checking the idempotency key first instead would put
			// a gap lock on a non-existent key in every racer, and the two lock sets crossed into a
			// reproducible deadlock that surfaced as HTTP 500 for every request but the winner.
			const [draftRows] = await connection.execute<DraftRow[]>(
				"SELECT id, user_id, region, total_cents, status FROM order_drafts WHERE id = ? FOR UPDATE",
				[input.draftId],
			);
			const draft = draftRows[0];
			if (!draft) throw new CommerceError("NOT_FOUND", `Order draft ${input.draftId} was not found`);
			if (draft.user_id !== input.userId)
				throw new CommerceError("FORBIDDEN", "Order draft belongs to another user");

			// Deliberately after the draft lock: a winner that already committed must be visible, and
			// the draft is still `submitted` rather than `confirmed` at that point.
			const [existingRows] = await connection.execute<OrderRow[]>(
				"SELECT id, user_id, draft_id, total_cents, status, created_at FROM orders WHERE idempotency_key = ? FOR UPDATE",
				[input.idempotencyKey],
			);
			if (existingRows[0]) {
				const existing = await this.loadOrder(connection, existingRows[0]);
				if (existing.userId !== input.userId || existing.draftId !== input.draftId) {
					throw new CommerceError("FORBIDDEN", "Idempotency key belongs to another order request");
				}
				await connection.commit();
				return existing;
			}

			if (draft.status !== "confirmed") {
				throw new CommerceError("DRAFT_NOT_CONFIRMED", "Order draft must be confirmed before submission");
			}

			const [itemRows] = await connection.execute<ItemRow[]>(
				"SELECT sku, product_name, unit_price_cents, quantity, line_total_cents FROM order_draft_items WHERE draft_id = ? ORDER BY sku",
				[input.draftId],
			);
			for (const item of itemRows) {
				const [inventoryRows] = await connection.execute<QuantityRow[]>(
					"SELECT available_quantity FROM inventory WHERE sku = ? AND region = ? FOR UPDATE",
					[item.sku, draft.region],
				);
				const available = inventoryRows[0]?.available_quantity ?? 0;
				if (available < item.quantity) {
					throw new CommerceError(
						"INSUFFICIENT_INVENTORY",
						`Only ${available} units of ${item.sku} are available`,
					);
				}
			}

			const orderId = randomUUID();
			// Written explicitly so the returned order carries the same instant the refund window uses.
			const createdAt = new Date();
			await connection.execute(
				"INSERT INTO orders (id, user_id, draft_id, idempotency_key, region, total_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)",
				[orderId, input.userId, input.draftId, input.idempotencyKey, draft.region, draft.total_cents, createdAt],
			);
			for (const item of itemRows) {
				await connection.execute(
					"UPDATE inventory SET available_quantity = available_quantity - ? WHERE sku = ? AND region = ?",
					[item.quantity, item.sku, draft.region],
				);
				await connection.execute(
					"INSERT INTO order_items (order_id, sku, product_name, unit_price_cents, quantity, line_total_cents) VALUES (?, ?, ?, ?, ?, ?)",
					[orderId, item.sku, item.product_name, item.unit_price_cents, item.quantity, item.line_total_cents],
				);
			}
			await connection.execute("UPDATE order_drafts SET status = 'submitted' WHERE id = ?", [input.draftId]);
			await connection.commit();
			return {
				id: orderId,
				userId: input.userId,
				draftId: input.draftId,
				items: itemRows.map(mapItem),
				totalCents: draft.total_cents,
				status: "submitted",
				createdAt: createdAt.toISOString(),
			};
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	/**
	 * Opens a handoff, or returns the one this conversation already has.
	 *
	 * A conversation holds at most one ticket that is not closed, enforced by the unique index on
	 * the generated `active_conversation_id`. A repeat handoff therefore collides with that index
	 * instead of adding a second entry to the desk queue, and reading the winner back makes a
	 * sequential repeat and a concurrent one behave the same way.
	 */
	async createSupportTicket(userId: string, summary: string, conversationId: string | null): Promise<SupportTicket> {
		const id = randomUUID();
		try {
			await this.pool.execute(
				"INSERT INTO support_tickets (id, user_id, conversation_id, summary, status) VALUES (?, ?, ?, ?, 'open')",
				[id, userId, conversationId, summary],
			);
		} catch (error) {
			// A ticket without a conversation is unconstrained, so a collision there is a real
			// failure and must not be swallowed by turning it into a lookup.
			if (!conversationId || !isDuplicateKeyError(error)) throw error;
			const existing = await this.findActiveSupportTicket(conversationId);
			if (!existing) throw error;
			return existing;
		}
		const created = await this.getSupportTicket(id);
		if (!created) throw new CommerceError("NOT_FOUND", `Support ticket ${id} was not found after creation`);
		return created;
	}

	private async findActiveSupportTicket(conversationId: string): Promise<SupportTicket | undefined> {
		const [rows] = await this.pool.execute<SupportTicketRow[]>(
			`SELECT ${SUPPORT_TICKET_COLUMNS} FROM support_tickets WHERE active_conversation_id = ?`,
			[conversationId],
		);
		return rows[0] ? mapSupportTicket(rows[0]) : undefined;
	}

	async getSupportTicket(id: string): Promise<SupportTicket | undefined> {
		const [rows] = await this.pool.execute<SupportTicketRow[]>(
			`SELECT ${SUPPORT_TICKET_COLUMNS} FROM support_tickets WHERE id = ?`,
			[id],
		);
		return rows[0] ? mapSupportTicket(rows[0]) : undefined;
	}

	async listSupportTickets(options: SupportTicketListOptions = {}): Promise<SupportTicket[]> {
		const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
		const conditions: string[] = [];
		const values: (string | number)[] = [];
		if (options.status) {
			conditions.push("status = ?");
			values.push(options.status);
		}
		if (options.conversationId) {
			conditions.push("conversation_id = ?");
			values.push(options.conversationId);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const [rows] = await this.pool.execute<SupportTicketRow[]>(
			`SELECT ${SUPPORT_TICKET_COLUMNS} FROM support_tickets ${where} ORDER BY created_at DESC LIMIT ?`,
			[...values, limit],
		);
		return rows.map(mapSupportTicket);
	}

	/**
	 * Compare-and-set on `open`: a second claim updates zero rows, which is how the desk learns
	 * that someone else already took the ticket instead of overwriting the first assignee.
	 */
	async claimSupportTicket(ticketId: string, assignee: string): Promise<SupportTicket | undefined> {
		const [result] = await this.pool.execute<ResultSetHeader>(
			`UPDATE support_tickets
			 SET status = 'assigned', assignee = ?, claimed_at = CURRENT_TIMESTAMP(3)
			 WHERE id = ? AND status = 'open'`,
			[assignee, ticketId],
		);
		if (result.affectedRows === 0) return undefined;
		return await this.getSupportTicket(ticketId);
	}

	/** Compare-and-set on `assigned`: a ticket nobody worked on cannot be closed. */
	async closeSupportTicket(ticketId: string, note: string | null): Promise<SupportTicket | undefined> {
		const [result] = await this.pool.execute<ResultSetHeader>(
			`UPDATE support_tickets
			 SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), close_note = ?
			 WHERE id = ? AND status = 'assigned'`,
			[note, ticketId],
		);
		if (result.affectedRows === 0) return undefined;
		return await this.getSupportTicket(ticketId);
	}

	async createRefundDraft(record: CreateRefundDraftRecord): Promise<RefundDraft> {
		const id = randomUUID();
		await this.pool.execute(
			"INSERT INTO refund_drafts (id, order_id, user_id, reason, amount_cents, status) VALUES (?, ?, ?, ?, ?, 'awaiting_confirmation')",
			[id, record.orderId, record.userId, record.reason, record.amountCents],
		);
		const created = await this.getRefundDraft(id);
		if (!created) throw new CommerceError("NOT_FOUND", `Refund draft ${id} was not found after creation`);
		return created;
	}

	async getRefundDraft(id: string): Promise<RefundDraft | undefined> {
		const [rows] = await this.pool.execute<RefundDraftRow[]>(
			`SELECT ${REFUND_DRAFT_COLUMNS} FROM refund_drafts WHERE id = ?`,
			[id],
		);
		return rows[0] ? mapRefundDraft(rows[0]) : undefined;
	}

	async findAwaitingRefundDraft(orderId: string): Promise<RefundDraft | undefined> {
		const [rows] = await this.pool.execute<RefundDraftRow[]>(
			`SELECT ${REFUND_DRAFT_COLUMNS} FROM refund_drafts WHERE order_id = ? AND status = 'awaiting_confirmation' ORDER BY created_at DESC LIMIT 1`,
			[orderId],
		);
		return rows[0] ? mapRefundDraft(rows[0]) : undefined;
	}

	/** Compare-and-set on `awaiting_confirmation`, so two confirmations cannot both proceed. */
	async markRefundDraftSubmitted(id: string): Promise<RefundDraft | undefined> {
		const [result] = await this.pool.execute<ResultSetHeader>(
			"UPDATE refund_drafts SET status = 'submitted' WHERE id = ? AND status = 'awaiting_confirmation'",
			[id],
		);
		if (result.affectedRows === 0) return undefined;
		return await this.getRefundDraft(id);
	}

	/** `active_order_id` is the generated column behind the unique index, so this returns at most one row. */
	async findActiveRefundRequest(orderId: string): Promise<RefundRequest | undefined> {
		const [rows] = await this.pool.execute<RefundRow[]>(
			`SELECT ${REFUND_COLUMNS} FROM refund_requests WHERE active_order_id = ?`,
			[orderId],
		);
		return rows[0] ? mapRefundRequest(rows[0]) : undefined;
	}

	async getRefundRequest(id: string): Promise<RefundRequest | undefined> {
		const [rows] = await this.pool.execute<RefundRow[]>(
			`SELECT ${REFUND_COLUMNS} FROM refund_requests WHERE id = ?`,
			[id],
		);
		return rows[0] ? mapRefundRequest(rows[0]) : undefined;
	}

	async listRefundRequests(userId: string, options: RefundListOptions = {}): Promise<RefundRequest[]> {
		const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
		const [rows] = options.orderId
			? await this.pool.execute<RefundRow[]>(
					`SELECT ${REFUND_COLUMNS} FROM refund_requests WHERE user_id = ? AND order_id = ? ORDER BY requested_at DESC LIMIT ?`,
					[userId, options.orderId, limit],
				)
			: await this.pool.execute<RefundRow[]>(
					`SELECT ${REFUND_COLUMNS} FROM refund_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT ?`,
					[userId, limit],
				);
		return rows.map(mapRefundRequest);
	}

	async createRefundRequest(record: CreateRefundRequestRecord): Promise<RefundRequest> {
		try {
			await this.pool.execute(
				`INSERT INTO refund_requests
				 (id, order_id, user_id, status, amount_cents, reason, order_created_at, last_transition_at, last_transition_by)
				 VALUES (?, ?, ?, 'pending_review', ?, ?, ?, CURRENT_TIMESTAMP(3), ?)`,
				[
					randomUUID(),
					record.orderId,
					record.userId,
					record.amountCents,
					record.reason,
					new Date(record.orderCreatedAt),
					record.userId,
				],
			);
		} catch (error) {
			// A concurrent request won the race; the unique index rejected this insert on purpose.
			if (!isDuplicateKeyError(error)) throw error;
		}
		const created = await this.findActiveRefundRequest(record.orderId);
		if (!created) {
			throw new CommerceError("INVALID_INPUT", `Refund request for order ${record.orderId} was not persisted`);
		}
		return created;
	}

	/**
	 * Compare-and-set so two reviewers cannot both apply a transition. `affectedRows` is 0 when
	 * the row already left `from`, which tells the caller to re-read instead of overwriting.
	 */
	async updateRefundStatus(record: UpdateRefundStatusRecord): Promise<RefundRequest | undefined> {
		const [result] = await this.pool.execute<ResultSetHeader>(
			`UPDATE refund_requests
			 SET status = ?, last_transition_at = CURRENT_TIMESTAMP(3), last_transition_by = ?, last_transition_note = ?
			 WHERE id = ? AND status = ?`,
			[record.to, record.actor, record.note, record.id, record.from],
		);
		if (result.affectedRows === 0) return undefined;
		return await this.getRefundRequest(record.id);
	}

	private async loadDraft(executor: Pool | PoolConnection, id: string): Promise<OrderDraft | undefined> {
		const [rows] = await executor.execute<DraftRow[]>(
			"SELECT id, user_id, region, total_cents, status FROM order_drafts WHERE id = ?",
			[id],
		);
		const row = rows[0];
		if (!row) return undefined;
		const [itemRows] = await executor.execute<ItemRow[]>(
			"SELECT sku, product_name, unit_price_cents, quantity, line_total_cents FROM order_draft_items WHERE draft_id = ? ORDER BY sku",
			[id],
		);
		return {
			id: row.id,
			userId: row.user_id,
			region: row.region,
			items: itemRows.map(mapItem),
			totalCents: row.total_cents,
			status: row.status,
		};
	}

	private async loadOrder(executor: Pool | PoolConnection, row: OrderRow): Promise<Order> {
		const [itemRows] = await executor.execute<ItemRow[]>(
			"SELECT sku, product_name, unit_price_cents, quantity, line_total_cents FROM order_items WHERE order_id = ? ORDER BY sku",
			[row.id],
		);
		return {
			id: row.id,
			userId: row.user_id,
			draftId: row.draft_id,
			items: itemRows.map(mapItem),
			totalCents: row.total_cents,
			status: row.status,
			createdAt: new Date(row.created_at).toISOString(),
		};
	}
}
