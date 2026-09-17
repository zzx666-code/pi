import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createCommerceApp } from "../../src/commerce/app.ts";
import { InMemoryCommerceRepository } from "../../src/db/in-memory-commerce-repository.ts";

function createRepository(now?: () => Date): InMemoryCommerceRepository {
	return new InMemoryCommerceRepository({
		products: [{ sku: "HEADPHONE-BLACK", name: "黑色耳机", unitPriceCents: 39900 }],
		inventory: [{ sku: "HEADPHONE-BLACK", region: "北京", availableQuantity: 5 }],
		now,
	});
}

async function submitOrder(
	app: FastifyInstance,
	headers: Record<string, string>,
	idempotencyKey: string,
): Promise<{ draftId: string; orderId: string }> {
	const created = await app.inject({
		method: "POST",
		url: "/order-drafts",
		headers,
		payload: { region: "北京", items: [{ sku: "HEADPHONE-BLACK", quantity: 1 }] },
	});
	const draftId = created.json().id as string;
	await app.inject({ method: "POST", url: `/order-drafts/${draftId}/confirm`, headers });
	const submitted = await app.inject({
		method: "POST",
		url: `/order-drafts/${draftId}/submit`,
		headers: { ...headers, "idempotency-key": idempotencyKey },
	});
	return { draftId, orderId: submitted.json().id as string };
}

describe("commerce HTTP API", () => {
	it("creates a draft using the server-side catalog price", async () => {
		const app = createCommerceApp(createRepository());

		const response = await app.inject({
			method: "POST",
			url: "/order-drafts",
			headers: { "x-user-id": "user-1" },
			payload: { region: "北京", items: [{ sku: "HEADPHONE-BLACK", quantity: 2, unitPriceCents: 1 }] },
		});

		expect(response.statusCode).toBe(201);
		expect(response.json()).toMatchObject({ totalCents: 79800, status: "awaiting_confirmation" });
		await app.close();
	});

	it("does not let another user confirm a draft", async () => {
		const app = createCommerceApp(createRepository());
		const created = await app.inject({
			method: "POST",
			url: "/order-drafts",
			headers: { "x-user-id": "user-1" },
			payload: { region: "北京", items: [{ sku: "HEADPHONE-BLACK", quantity: 1 }] },
		});
		const draftId = created.json().id as string;

		const response = await app.inject({
			method: "POST",
			url: `/order-drafts/${draftId}/confirm`,
			headers: { "x-user-id": "user-2" },
		});

		expect(response.statusCode).toBe(403);
		expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
		await app.close();
	});

	it("returns the same order for a repeated idempotency key", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const created = await app.inject({
			method: "POST",
			url: "/order-drafts",
			headers,
			payload: { region: "北京", items: [{ sku: "HEADPHONE-BLACK", quantity: 1 }] },
		});
		const draftId = created.json().id as string;
		await app.inject({ method: "POST", url: `/order-drafts/${draftId}/confirm`, headers });

		const first = await app.inject({
			method: "POST",
			url: `/order-drafts/${draftId}/submit`,
			headers: { ...headers, "idempotency-key": "submit-1" },
		});
		const second = await app.inject({
			method: "POST",
			url: `/order-drafts/${draftId}/submit`,
			headers: { ...headers, "idempotency-key": "submit-1" },
		});

		expect(first.statusCode).toBe(201);
		expect(second.statusCode).toBe(200);
		expect(second.json().id).toBe(first.json().id);
		await app.close();
	});

	it("lists recent orders for the current user, newest first", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		await submitOrder(app, headers, "list-key-1");
		const second = await submitOrder(app, headers, "list-key-2");

		const response = await app.inject({ method: "GET", url: "/orders", headers });

		expect(response.statusCode).toBe(200);
		const orders = response.json() as Array<Record<string, unknown>>;
		expect(orders).toHaveLength(2);
		expect(orders[0]).toMatchObject({ id: second.orderId, status: "submitted", totalCents: 39900 });
		expect(orders[0].items).toMatchObject([{ sku: "HEADPHONE-BLACK", quantity: 1 }]);
		await app.close();
	});

	it("keeps the order list scoped to the authenticated user", async () => {
		const app = createCommerceApp(createRepository());
		await submitOrder(app, { "x-user-id": "user-1" }, "scoped-key-1");

		const response = await app.inject({ method: "GET", url: "/orders", headers: { "x-user-id": "user-2" } });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
		await app.close();
	});

	// Regression: the draft id was previously looked up only against orders.id, so an agent
	// holding the draft id from create_order_draft got NOT_FOUND for its own order.
	it("resolves a submitted order from its draft id", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const { draftId, orderId } = await submitOrder(app, headers, "draft-lookup-key");

		const response = await app.inject({ method: "GET", url: `/orders/${draftId}`, headers });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ id: orderId, draftId });
		await app.close();
	});

	// Backs the client-side reload path: the confirm card is rebuilt from this response.
	it("returns an owned draft and hides another user's draft", async () => {
		const app = createCommerceApp(createRepository());
		const created = await app.inject({
			method: "POST",
			url: "/order-drafts",
			headers: { "x-user-id": "user-1" },
			payload: { region: "北京", items: [{ sku: "HEADPHONE-BLACK", quantity: 1 }] },
		});
		const draftId = created.json().id as string;

		const mine = await app.inject({
			method: "GET",
			url: `/order-drafts/${draftId}`,
			headers: { "x-user-id": "user-1" },
		});
		const foreign = await app.inject({
			method: "GET",
			url: `/order-drafts/${draftId}`,
			headers: { "x-user-id": "user-2" },
		});

		expect(mine.statusCode).toBe(200);
		expect(mine.json()).toMatchObject({ id: draftId, status: "awaiting_confirmation", totalCents: 39900 });
		expect(mine.json().userId).toBeUndefined();
		expect(foreign.statusCode).toBe(404);
		await app.close();
	});

	it("records a refund request inside the window and reuses it for a repeat request", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const { orderId } = await submitOrder(app, headers, "refund-key-1");

		const first = await app.inject({
			method: "POST",
			url: "/refund-requests",
			headers,
			payload: { orderId, reason: "不想要了" },
		});
		const second = await app.inject({ method: "POST", url: "/refund-requests", headers, payload: { orderId } });

		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({
			eligible: true,
			status: "pending_review",
			amountCents: 39900,
			windowDays: 7,
		});
		expect(second.json().refundId).toBe(first.json().refundId);
		await app.close();
	});

	// The refund window is measured against the order submission time, not against the draft or review time.
	it("refuses a refund request for an order past the window", async () => {
		let now = new Date("2026-09-01T00:00:00.000Z");
		const app = createCommerceApp(createRepository(() => now));
		const { orderId } = await submitOrder(app, { "x-user-id": "user-1" }, "refund-key-2");

		now = new Date("2026-09-17T00:00:00.000Z");
		const response = await app.inject({
			method: "POST",
			url: "/refund-requests",
			headers: { "x-user-id": "user-1" },
			payload: { orderId },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ eligible: false, code: "REFUND_WINDOW_EXPIRED", windowDays: 7 });
		await app.close();
	});

	it("does not refund another user's order", async () => {
		const app = createCommerceApp(createRepository());
		const { orderId } = await submitOrder(app, { "x-user-id": "user-1" }, "refund-key-3");

		const response = await app.inject({
			method: "POST",
			url: "/refund-requests",
			headers: { "x-user-id": "user-2" },
			payload: { orderId },
		});

		expect(response.statusCode).toBe(404);
		expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
		await app.close();
	});

	it("requires the order id to submit a refund request", async () => {
		const app = createCommerceApp(createRepository());

		const response = await app.inject({
			method: "POST",
			url: "/refund-requests",
			headers: { "x-user-id": "user-1" },
			payload: { reason: "不想要了" },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({ code: "INVALID_INPUT" });
		await app.close();
	});

	it("lists only the current user's refund requests", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const first = await submitOrder(app, headers, "refund-list-key-1");
		const second = await submitOrder(app, headers, "refund-list-key-2");
		await app.inject({ method: "POST", url: "/refund-requests", headers, payload: { orderId: first.orderId } });
		await app.inject({ method: "POST", url: "/refund-requests", headers, payload: { orderId: second.orderId } });

		const mine = await app.inject({ method: "GET", url: "/refund-requests", headers });
		const foreign = await app.inject({
			method: "GET",
			url: "/refund-requests",
			headers: { "x-user-id": "user-2" },
		});

		expect(mine.statusCode).toBe(200);
		expect((mine.json() as Array<{ orderId: string }>).map((request) => request.orderId)).toEqual([
			second.orderId,
			first.orderId,
		]);
		expect(foreign.json()).toEqual([]);
		await app.close();
	});

	it("moves a refund request through the review workflow", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const { orderId } = await submitOrder(app, headers, "refund-review-key");
		const created = await app.inject({ method: "POST", url: "/refund-requests", headers, payload: { orderId } });
		const refundId = created.json().refundId as string;

		const handedOff = await app.inject({
			method: "POST",
			url: `/refund-requests/${refundId}/status`,
			payload: { status: "handed_off", actor: "agent-7", note: "需要人工核实" },
		});
		const approved = await app.inject({
			method: "POST",
			url: `/refund-requests/${refundId}/status`,
			payload: { status: "approved", actor: "agent-7" },
		});
		const refunded = await app.inject({
			method: "POST",
			url: `/refund-requests/${refundId}/status`,
			payload: { status: "refunded", actor: "payment-gateway" },
		});

		expect(handedOff.json()).toMatchObject({
			status: "handed_off",
			lastTransitionBy: "agent-7",
			lastTransitionNote: "需要人工核实",
		});
		expect(approved.json()).toMatchObject({ status: "approved" });
		expect(refunded.json()).toMatchObject({ status: "refunded", lastTransitionBy: "payment-gateway" });
		await app.close();
	});

	// The window and the state machine both reject invalid moves, and the message says which.
	it("rejects an illegal refund transition", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const { orderId } = await submitOrder(app, headers, "refund-illegal-key");
		const created = await app.inject({ method: "POST", url: "/refund-requests", headers, payload: { orderId } });
		const refundId = created.json().refundId as string;

		const skipped = await app.inject({
			method: "POST",
			url: `/refund-requests/${refundId}/status`,
			payload: { status: "refunded", actor: "agent-7" },
		});

		expect(skipped.statusCode).toBe(400);
		expect(skipped.json()).toMatchObject({ code: "INVALID_INPUT" });
		await app.close();
	});

	it("validates the review payload and the request id", async () => {
		const app = createCommerceApp(createRepository());
		const headers = { "x-user-id": "user-1" };
		const { orderId } = await submitOrder(app, headers, "refund-payload-key");
		const created = await app.inject({ method: "POST", url: "/refund-requests", headers, payload: { orderId } });
		const refundId = created.json().refundId as string;

		const unknownStatus = await app.inject({
			method: "POST",
			url: `/refund-requests/${refundId}/status`,
			payload: { status: "refund_now", actor: "agent-7" },
		});
		const missingActor = await app.inject({
			method: "POST",
			url: `/refund-requests/${refundId}/status`,
			payload: { status: "approved", actor: "  " },
		});
		const missingRequest = await app.inject({
			method: "POST",
			url: "/refund-requests/refund-404/status",
			payload: { status: "approved", actor: "agent-7" },
		});

		expect(unknownStatus.statusCode).toBe(400);
		expect(missingActor.statusCode).toBe(400);
		expect(missingRequest.statusCode).toBe(404);
		await app.close();
	});
});
