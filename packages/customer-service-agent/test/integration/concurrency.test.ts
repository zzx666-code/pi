import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMysqlPool } from "../../src/db/mysql.ts";
import { MySqlCommerceRepository } from "../../src/db/mysql-commerce-repository.ts";
import { OrderService } from "../../src/domain/order-service.ts";

/**
 * Concurrency behaviour can only be verified against a real MySQL.
 *
 * The in-memory repository serialises every call in JavaScript, so it agrees with these tests no
 * matter what the SQL does. The three failure modes that matter — gap locks deadlocking, the
 * unique index arbitrating a race, and a compare-and-set reporting zero affected rows — exist
 * only in the database. That is why order submission used to return HTTP 500 to seven of eight
 * concurrent requests while every unit test passed.
 *
 * The suite skips itself when no database is reachable, so `npm test` still runs offline.
 */
const MYSQL_URL = process.env.MYSQL_URL ?? "mysql://pi:pi@127.0.0.1:3307/pi_customer_service";
const CONCURRENCY = 8;

const pool = createMysqlPool(MYSQL_URL);
const reachable = await pool
	.query("SELECT 1")
	.then(() => true)
	.catch(() => false);

if (!reachable) {
	await pool.end();
	console.warn(`[integration] MySQL unreachable at ${MYSQL_URL}; skipping concurrency tests`);
}

describe.skipIf(!reachable)("concurrency against live MySQL", () => {
	const repository = new MySqlCommerceRepository(pool);
	const service = new OrderService(repository);

	// A private fixture per run: the suite never touches the demo user's rows.
	const userId = `itest-${randomUUID()}`;
	const sku = `ITEST-${randomUUID().slice(0, 8).toUpperCase()}`;
	const region = `ITEST-${randomUUID().slice(0, 8)}`;

	beforeAll(async () => {
		await pool.execute("INSERT INTO users (id, name) VALUES (?, ?)", [userId, "并发测试用户"]);
		await pool.execute("INSERT INTO products (sku, name, description, unit_price_cents) VALUES (?, ?, '', ?)", [
			sku,
			"并发测试商品",
			1000,
		]);
		await pool.execute("INSERT INTO inventory (sku, region, available_quantity) VALUES (?, ?, ?)", [
			sku,
			region,
			1000,
		]);
	});

	afterAll(async () => {
		// Children first: every delete below is referenced by a foreign key from the one above it.
		await pool.execute("DELETE FROM refund_requests WHERE user_id = ?", [userId]);
		await pool.execute("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)", [
			userId,
		]);
		await pool.execute("DELETE FROM orders WHERE user_id = ?", [userId]);
		await pool.execute(
			"DELETE FROM order_draft_items WHERE draft_id IN (SELECT id FROM order_drafts WHERE user_id = ?)",
			[userId],
		);
		await pool.execute("DELETE FROM order_drafts WHERE user_id = ?", [userId]);
		await pool.execute("DELETE FROM support_tickets WHERE user_id = ?", [userId]);
		await pool.execute("DELETE FROM conversations WHERE user_id = ?", [userId]);
		await pool.execute("DELETE FROM inventory WHERE sku = ?", [sku]);
		await pool.execute("DELETE FROM products WHERE sku = ?", [sku]);
		await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
		await pool.end();
	});

	async function createConfirmedDraft(quantity = 1): Promise<string> {
		const draft = await service.createDraft(userId, region, [{ sku, quantity }]);
		await service.confirmDraft(userId, draft.id);
		return draft.id;
	}

	async function countOrdersForKey(key: string): Promise<number> {
		const [rows] = await pool.execute<RowDataPacket[]>("SELECT id FROM orders WHERE idempotency_key = ?", [key]);
		return rows.length;
	}

	async function availableQuantity(): Promise<number> {
		const [rows] = await pool.execute<RowDataPacket[]>(
			"SELECT available_quantity FROM inventory WHERE sku = ? AND region = ?",
			[sku, region],
		);
		return Number(rows[0]?.available_quantity ?? -1);
	}

	/** `support_tickets.conversation_id` is a foreign key, so the row has to exist for real. */
	async function createConversation(): Promise<string> {
		const conversationId = randomUUID();
		await pool.execute("INSERT INTO conversations (id, user_id) VALUES (?, ?)", [conversationId, userId]);
		return conversationId;
	}

	// The regression this suite exists for: eight concurrent submissions used to answer
	// 201 + 500 x7 because InnoDB deadlocked seven transactions on crossing gap locks.
	it("answers every racer with the same order for one idempotency key", async () => {
		const draftId = await createConfirmedDraft();
		const key = `itest-key-${randomUUID()}`;

		const orders = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => service.submitDraft(userId, draftId, key)),
		);

		expect(new Set(orders.map((order) => order.id)).size).toBe(1);
		expect(await countOrdersForKey(key)).toBe(1);
	});

	it("deducts inventory once for a replicated submission", async () => {
		const draftId = await createConfirmedDraft(2);
		const key = `itest-key-${randomUUID()}`;
		const before = await availableQuantity();

		const orders = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => service.submitDraft(userId, draftId, key)),
		);

		expect(new Set(orders.map((order) => order.id)).size).toBe(1);
		expect(await availableQuantity()).toBe(before - 2);
	});

	it("replays a sequential resubmission onto the first order", async () => {
		const draftId = await createConfirmedDraft();
		const key = `itest-key-${randomUUID()}`;

		const first = await service.submitDraft(userId, draftId, key);
		const second = await service.submitDraft(userId, draftId, key);

		expect(second.id).toBe(first.id);
		expect(await countOrdersForKey(key)).toBe(1);
	});

	it("refuses to reuse an idempotency key for another draft", async () => {
		const firstDraft = await createConfirmedDraft();
		const secondDraft = await createConfirmedDraft();
		const key = `itest-key-${randomUUID()}`;
		await service.submitDraft(userId, firstDraft, key);

		await expect(service.submitDraft(userId, secondDraft, key)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await countOrdersForKey(key)).toBe(1);
	});

	// The refund path already used the unique index as the arbiter; this pins that behaviour so a
	// future rewrite of order submission cannot quietly regress the pattern it now shares.
	it("records one refund request when eight requests race on one order", async () => {
		const draftId = await createConfirmedDraft();
		const order = await service.submitDraft(userId, draftId, `itest-key-${randomUUID()}`);

		const decisions = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => service.requestRefund(userId, order.id, "并发验证")),
		);

		// Every racer must be told the same request exists, so all eight report an id and it matches.
		const refundIds = decisions.flatMap((decision) => (decision.eligible ? [decision.refundId] : []));
		expect(refundIds).toHaveLength(CONCURRENCY);
		expect(new Set(refundIds).size).toBe(1);
		const [rows] = await pool.execute<RowDataPacket[]>("SELECT id FROM refund_requests WHERE order_id = ?", [
			order.id,
		]);
		expect(rows).toHaveLength(1);
	});

	it("lets exactly one customer cancel a pending request", async () => {
		const draftId = await createConfirmedDraft();
		const order = await service.submitDraft(userId, draftId, `itest-key-${randomUUID()}`);
		await service.requestRefund(userId, order.id, "并发撤销验证");

		const cancellations = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => service.cancelRefundRequest(userId, order.id)),
		);

		expect(cancellations.filter((result) => result.cancelled)).toHaveLength(1);
		const [rows] = await pool.execute<RowDataPacket[]>("SELECT status FROM refund_requests WHERE order_id = ?", [
			order.id,
		]);
		expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
	});

	it("releases the order so a cancelled request can be replaced", async () => {
		const draftId = await createConfirmedDraft();
		const order = await service.submitDraft(userId, draftId, `itest-key-${randomUUID()}`);
		await service.requestRefund(userId, order.id, "耳机太丑");
		await service.cancelRefundRequest(userId, order.id);

		const replacement = await service.requestRefund(userId, order.id, "按键失灵");

		expect(replacement).toMatchObject({ eligible: true });
		const [rows] = await pool.execute<RowDataPacket[]>(
			"SELECT status, reason FROM refund_requests WHERE order_id = ? ORDER BY requested_at",
			[order.id],
		);
		expect(rows.map((row) => [row.status, row.reason])).toEqual([
			["cancelled", "耳机太丑"],
			["pending_review", "按键失灵"],
		]);
	});

	// The unique index on `active_conversation_id` is what makes this hold under concurrency; a
	// read-then-insert check would still let several racers through.
	it("keeps one open ticket per conversation", async () => {
		const conversationId = await createConversation();

		const tickets = await Promise.all(
			Array.from({ length: CONCURRENCY }, () =>
				repository.createSupportTicket(userId, "并发转人工验证", conversationId),
			),
		);

		expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(1);
		const [rows] = await pool.execute<RowDataPacket[]>(
			"SELECT id FROM support_tickets WHERE conversation_id = ? AND status <> 'closed'",
			[conversationId],
		);
		expect(rows).toHaveLength(1);
	});

	it("opens a new ticket once the previous one is closed", async () => {
		const conversationId = await createConversation();
		const first = await repository.createSupportTicket(userId, "第一次转人工", conversationId);
		await repository.claimSupportTicket(first.id, "agent-reopen");
		await repository.closeSupportTicket(first.id, "已解决");

		const second = await repository.createSupportTicket(userId, "第二次转人工", conversationId);

		expect(second.id).not.toBe(first.id);
	});

	it("lets exactly one agent claim a ticket", async () => {
		const ticket = await repository.createSupportTicket(userId, "并发认领验证", null);

		const claims = await Promise.all(
			Array.from({ length: CONCURRENCY }, (_unused, index) =>
				repository.claimSupportTicket(ticket.id, `agent-${index}`),
			),
		);

		const winners = claims.filter((claim) => claim !== undefined);
		expect(winners).toHaveLength(1);
		// Which racer wins depends on lock acquisition order, so only the count is deterministic.
		expect(winners[0]?.assignee).toMatch(/^agent-\d$/);
	});

	it("lets exactly one agent close a claimed ticket", async () => {
		const ticket = await repository.createSupportTicket(userId, "并发关闭验证", null);
		await repository.claimSupportTicket(ticket.id, "agent-owner");

		const closes = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => repository.closeSupportTicket(ticket.id, "已解决")),
		);

		expect(closes.filter((closed) => closed !== undefined)).toHaveLength(1);
	});
});
