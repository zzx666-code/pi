import Fastify, { type FastifyInstance } from "fastify";
import { CommerceError, OrderService } from "../domain/order-service.ts";
import { isRefundStatus } from "../domain/refund-status.ts";
import type { CommerceStore, DraftItemInput } from "../domain/types.ts";

interface CommerceAppOptions {
	internalToken?: string;
}

function requireUserId(headers: Record<string, string | string[] | undefined>): string {
	const value = headers["x-user-id"];
	if (typeof value !== "string" || !value.trim()) {
		throw new CommerceError("FORBIDDEN", "A trusted user identity is required");
	}
	return value;
}

function requireDraftItems(value: unknown): DraftItemInput[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new CommerceError("INVALID_INPUT", "At least one order item is required");
	}
	return value.map((item) => {
		if (!item || typeof item !== "object") throw new CommerceError("INVALID_INPUT", "Invalid order item");
		const record = item as Record<string, unknown>;
		if (typeof record.sku !== "string" || typeof record.quantity !== "number") {
			throw new CommerceError("INVALID_INPUT", "Each item requires sku and quantity");
		}
		return { sku: record.sku, quantity: record.quantity };
	});
}

function errorStatus(error: CommerceError): number {
	switch (error.code) {
		case "FORBIDDEN":
			return 403;
		case "NOT_FOUND":
			return 404;
		case "DRAFT_NOT_CONFIRMED":
		case "INSUFFICIENT_INVENTORY":
			return 409;
		default:
			return 400;
	}
}

export function createCommerceApp(repository: CommerceStore, options: CommerceAppOptions = {}): FastifyInstance {
	const app = Fastify({ logger: false });
	const orders = new OrderService(repository);

	if (options.internalToken) {
		app.addHook("onRequest", async (request, reply) => {
			if (request.url === "/health") return;
			if (request.headers["x-internal-token"] !== options.internalToken) {
				await reply.code(401).send({ code: "UNAUTHORIZED", message: "Invalid internal service token" });
			}
		});
	}

	app.setErrorHandler(async (error, _request, reply) => {
		if (error instanceof CommerceError) {
			await reply.code(errorStatus(error)).send({ code: error.code, message: error.message });
			return;
		}
		app.log.error(error);
		await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Internal commerce service error" });
	});

	app.get("/health", async () => ({ status: "ok" }));

	app.get<{ Querystring: { query?: string; limit?: string } }>("/products", async (request) => {
		return await repository.searchProducts(request.query.query ?? "", Number(request.query.limit ?? 10));
	});

	app.get<{ Params: { sku: string }; Querystring: { region?: string } }>("/inventory/:sku", async (request) => {
		const region = request.query.region?.trim();
		if (!region) throw new CommerceError("INVALID_INPUT", "region is required");
		return {
			sku: request.params.sku,
			region,
			availableQuantity: await repository.getAvailableQuantity(request.params.sku, region),
		};
	});

	app.get<{ Querystring: { limit?: string } }>("/orders", async (request) => {
		const parsed = Number(request.query.limit ?? 5);
		const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 20) : 5;
		return await repository.listOrders(requireUserId(request.headers), limit);
	});

	/** `:id` accepts the submitted order id or the draft id it came from. */
	app.get<{ Params: { id: string } }>("/orders/:id", async (request) => {
		const order = await repository.getOrder(requireUserId(request.headers), request.params.id);
		if (!order) throw new CommerceError("NOT_FOUND", "Order was not found for the current user");
		return order;
	});

	/** Lets the client rebuild the confirmation card after a reload. */
	app.get<{ Params: { id: string } }>("/order-drafts/:id", async (request) => {
		const draft = await repository.getDraft(request.params.id);
		if (!draft || draft.userId !== requireUserId(request.headers)) {
			throw new CommerceError("NOT_FOUND", "Order draft was not found for the current user");
		}
		return {
			id: draft.id,
			status: draft.status,
			region: draft.region,
			items: draft.items,
			totalCents: draft.totalCents,
		};
	});

	app.post<{ Body: { region?: unknown; items?: unknown } }>("/order-drafts", async (request, reply) => {
		if (typeof request.body?.region !== "string") throw new CommerceError("INVALID_INPUT", "region is required");
		const draft = await orders.createDraft(
			requireUserId(request.headers),
			request.body.region,
			requireDraftItems(request.body.items),
		);
		return await reply.code(201).send(draft);
	});

	app.post<{ Params: { id: string } }>("/order-drafts/:id/confirm", async (request) => {
		return await orders.confirmDraft(requireUserId(request.headers), request.params.id);
	});

	app.post<{ Params: { id: string } }>("/order-drafts/:id/submit", async (request, reply) => {
		const userId = requireUserId(request.headers);
		const idempotencyKey = request.headers["idempotency-key"];
		if (typeof idempotencyKey !== "string") {
			throw new CommerceError("INVALID_INPUT", "Idempotency-Key header is required");
		}
		const existing = await repository.getOrderByIdempotencyKey(idempotencyKey);
		const order = await orders.submitDraft(userId, request.params.id, idempotencyKey);
		return await reply.code(existing ? 200 : 201).send(order);
	});

	/**
	 * Applies the refund window on the server. `eligible: false` is a policy answer, so it is a
	 * 200 response instead of an error: the agent must explain it, not retry it.
	 */
	app.post<{ Body: { orderId?: unknown; reason?: unknown } }>("/refund-requests", async (request) => {
		const { orderId, reason } = request.body;
		if (typeof orderId !== "string" || !orderId.trim()) {
			throw new CommerceError("INVALID_INPUT", "orderId is required");
		}
		if (reason !== undefined && typeof reason !== "string") {
			throw new CommerceError("INVALID_INPUT", "reason must be a string when provided");
		}
		return await orders.requestRefund(
			requireUserId(request.headers),
			orderId.trim(),
			typeof reason === "string" ? reason.trim() : undefined,
		);
	});

	/** The customer's own refund requests, newest first. */
	app.get<{ Querystring: { orderId?: string; limit?: string } }>("/refund-requests", async (request) => {
		const parsed = Number(request.query.limit ?? 5);
		const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 20) : 5;
		return await orders.listRefundRequests(requireUserId(request.headers), {
			orderId: request.query.orderId,
			limit,
		});
	});

	/**
	 * Internal hook for the human review workflow and the payment callback. It requires the
	 * internal service token and has no counterpart in the agent gateway, so the model can
	 * submit a refund but never approve one.
	 */
	app.post<{ Params: { id: string }; Body: { status?: unknown; actor?: unknown; note?: unknown } }>(
		"/refund-requests/:id/status",
		async (request) => {
			const { status, actor, note } = request.body;
			if (!isRefundStatus(status)) {
				throw new CommerceError("INVALID_INPUT", `status must be one of the known refund statuses`);
			}
			if (typeof actor !== "string" || !actor.trim()) {
				throw new CommerceError("INVALID_INPUT", "actor is required");
			}
			if (note !== undefined && typeof note !== "string") {
				throw new CommerceError("INVALID_INPUT", "note must be a string when provided");
			}
			return await orders.transitionRefundStatus(request.params.id, status, actor, note);
		},
	);

	app.post<{ Body: { summary?: unknown } }>("/support-tickets", async (request, reply) => {
		if (typeof request.body?.summary !== "string" || !request.body.summary.trim()) {
			throw new CommerceError("INVALID_INPUT", "summary is required");
		}
		return await reply
			.code(201)
			.send(await repository.createSupportTicket(requireUserId(request.headers), request.body.summary.trim()));
	});

	return app;
}
