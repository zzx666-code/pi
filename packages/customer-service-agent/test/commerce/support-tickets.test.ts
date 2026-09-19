import { describe, expect, it } from "vitest";
import { createCommerceApp } from "../../src/commerce/app.ts";
import { InMemoryCommerceRepository } from "../../src/db/in-memory-commerce-repository.ts";

const INTERNAL_TOKEN = "test-internal-token";
const deskHeaders = { "x-internal-token": INTERNAL_TOKEN, "x-user-id": "user-1" };

function createApp() {
	return createCommerceApp(
		new InMemoryCommerceRepository({
			products: [{ sku: "HEADPHONE-BLACK", name: "黑色耳机", unitPriceCents: 39900 }],
			inventory: [{ sku: "HEADPHONE-BLACK", region: "北京", availableQuantity: 5 }],
		}),
		{ internalToken: INTERNAL_TOKEN },
	);
}

type App = ReturnType<typeof createApp>;

async function createTicket(app: App, summary = "用户要求人工", conversationId: string | null = "conversation-1") {
	const response = await app.inject({
		method: "POST",
		url: "/support-tickets",
		headers: deskHeaders,
		payload: conversationId === null ? { summary } : { summary, conversationId },
	});
	expect(response.statusCode).toBe(201);
	return response.json();
}

async function claim(app: App, ticketId: string, assignee = "agent-li") {
	return await app.inject({
		method: "POST",
		url: `/support-tickets/${ticketId}/claim`,
		headers: deskHeaders,
		payload: { assignee },
	});
}

describe("support ticket desk API", () => {
	// The ticket has to carry the conversation, otherwise the desk cannot find the transcript
	// it is supposed to answer into.
	it("keeps the source conversation on the ticket", async () => {
		const app = createApp();

		const ticket = await createTicket(app);

		expect(ticket).toMatchObject({ status: "open", conversationId: "conversation-1", assignee: null });
		await app.close();
	});

	it("lists tickets filtered by status, newest first", async () => {
		const app = createApp();
		// Distinct conversations on purpose: one conversation can only ever hold one open ticket.
		const older = await createTicket(app, "先转人工的", "conversation-1");
		await createTicket(app, "后转人工的", "conversation-2");
		await claim(app, older.id);

		const open = await app.inject({ method: "GET", url: "/support-tickets?status=open", headers: deskHeaders });
		const assigned = await app.inject({
			method: "GET",
			url: "/support-tickets?status=assigned",
			headers: deskHeaders,
		});
		const all = await app.inject({ method: "GET", url: "/support-tickets", headers: deskHeaders });

		expect(open.statusCode).toBe(200);
		expect(open.json().map((ticket: { summary: string }) => ticket.summary)).toEqual(["后转人工的"]);
		expect(assigned.json()).toHaveLength(1);
		expect(all.json()).toHaveLength(2);
		await app.close();
	});

	it("claims a ticket once and rejects a competing claim", async () => {
		const app = createApp();
		const ticket = await createTicket(app);

		const first = await claim(app, ticket.id, "agent-li");
		const second = await claim(app, ticket.id, "agent-wang");

		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({ status: "assigned", assignee: "agent-li" });
		expect(second.statusCode).toBe(409);
		expect(second.json()).toMatchObject({ code: "TICKET_NOT_OPEN" });
		await app.close();
	});

	it("closes a claimed ticket and records the note", async () => {
		const app = createApp();
		const ticket = await createTicket(app);
		await claim(app, ticket.id);

		const response = await app.inject({
			method: "POST",
			url: `/support-tickets/${ticket.id}/close`,
			headers: deskHeaders,
			payload: { note: "已电话沟通" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			status: "closed",
			assignee: "agent-li",
			closeNote: "已电话沟通",
		});
		expect(response.json().closedAt).toBeTruthy();
		await app.close();
	});

	// Closing straight from `open` would let a ticket disappear without a human ever working it.
	it("refuses to close a ticket nobody claimed", async () => {
		const app = createApp();
		const ticket = await createTicket(app);

		const response = await app.inject({
			method: "POST",
			url: `/support-tickets/${ticket.id}/close`,
			headers: deskHeaders,
			payload: {},
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ code: "TICKET_NOT_ASSIGNED" });
		await app.close();
	});

	it("reports an unknown ticket as not found", async () => {
		const app = createApp();

		const response = await claim(app, "does-not-exist");

		expect(response.statusCode).toBe(404);
		await app.close();
	});

	it("requires an assignee when claiming", async () => {
		const app = createApp();
		const ticket = await createTicket(app);

		const response = await app.inject({
			method: "POST",
			url: `/support-tickets/${ticket.id}/claim`,
			headers: deskHeaders,
			payload: {},
		});

		expect(response.statusCode).toBe(400);
		await app.close();
	});

	// Before the unique index existed, every handoff in one conversation added another entry to the
	// desk queue: the same customer showed up twice and either agent could claim the wrong one.
	it("reuses the open ticket when one conversation asks for a human twice", async () => {
		const app = createApp();
		const first = await createTicket(app, "第一次投诉");

		const second = await app.inject({
			method: "POST",
			url: "/support-tickets",
			headers: deskHeaders,
			payload: { summary: "第二次投诉", conversationId: "conversation-1" },
		});
		const all = await app.inject({ method: "GET", url: "/support-tickets", headers: deskHeaders });

		expect(second.statusCode).toBe(201);
		expect(second.json().id).toBe(first.id);
		// The summary belongs to the escalation that opened the ticket. The desk may have read it
		// already, and the newer context is in the transcript the desk reads anyway.
		expect(second.json().summary).toBe("第一次投诉");
		expect(all.json()).toHaveLength(1);
		await app.close();
	});

	it("keeps reusing the ticket after a desk claims it", async () => {
		const app = createApp();
		const first = await createTicket(app);
		await claim(app, first.id, "agent-li");

		const second = await app.inject({
			method: "POST",
			url: "/support-tickets",
			headers: deskHeaders,
			payload: { summary: "又要人工", conversationId: "conversation-1" },
		});

		expect(second.json().id).toBe(first.id);
		expect(second.json()).toMatchObject({ status: "assigned", assignee: "agent-li" });
		await app.close();
	});

	// Closing frees the slot, so a customer who comes back with a new problem gets a new ticket
	// instead of reopening one the desk already finished.
	it("opens a new ticket once the previous one is closed", async () => {
		const app = createApp();
		const first = await createTicket(app);
		await claim(app, first.id);
		await app.inject({
			method: "POST",
			url: `/support-tickets/${first.id}/close`,
			headers: deskHeaders,
			payload: { note: "已解决" },
		});

		const second = await createTicket(app, "新问题");

		expect(second.id).not.toBe(first.id);
		expect(second.status).toBe("open");
		await app.close();
	});

	it("scopes reuse to one conversation", async () => {
		const app = createApp();
		const first = await createTicket(app, "会话一", "conversation-1");
		const second = await createTicket(app, "会话二", "conversation-2");

		expect(second.id).not.toBe(first.id);
		await app.close();
	});

	// Tickets created before 002 carry no conversation, and MySQL treats several NULLs in a unique
	// index as distinct, so those rows keep their old behaviour.
	it("does not constrain tickets that carry no conversation", async () => {
		const app = createApp();
		const first = await createTicket(app, "老工单一", null);
		const second = await createTicket(app, "老工单二", null);

		expect(second.id).not.toBe(first.id);
		await app.close();
	});

	it("rejects a desk call without the internal token", async () => {
		const app = createApp();

		const response = await app.inject({ method: "GET", url: "/support-tickets", headers: {} });

		expect(response.statusCode).toBe(401);
		await app.close();
	});
});
