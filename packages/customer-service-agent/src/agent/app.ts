import type { IncomingHttpHeaders } from "node:http";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { WechatChannelService } from "../channels/wechat/service.ts";
import { isSupportTicketStatus } from "../domain/support-ticket.ts";
import { AuthError, signAuthToken, verifyAuthToken } from "./auth.ts";
import { ConversationAccessError } from "./conversation-store.ts";
import { CommerceHttpError, type OrderConfirmationGateway, type RefundConfirmationGateway } from "./gateways.ts";
import { type CustomerServiceAgentService, DeskError } from "./service.ts";

interface AgentAppOptions {
	authSecret: string;
	demoUserId: string;
	/** Token the support desk presents. Separate from the JWT a customer uses. */
	deskToken: string;
	allowedOrigin?: string;
	/**
	 * The customer-facing half of the refund gate. Required, not optional: without it the
	 * confirmation route would be missing and refunds could only be opened by the model.
	 */
	refunds: RefundConfirmationGateway;
	/** Optional trusted channel adapter. It is never exposed to browser JWTs. */
	wechat?: WechatChannelService;
	channelToken?: string;
}

function authenticate(headers: IncomingHttpHeaders, secret: string): string {
	const authorization = headers.authorization;
	if (!authorization?.startsWith("Bearer ")) throw new AuthError("Bearer authentication is required");
	return verifyAuthToken(authorization.slice("Bearer ".length), secret).userId;
}

/**
 * The desk is not a customer: it works across customers, so it cannot be scoped by a user JWT.
 * It presents the internal service token instead.
 */
function requireDeskToken(headers: IncomingHttpHeaders, token: string): void {
	if (headers["x-internal-token"] !== token) throw new AuthError("A valid internal service token is required");
}

function requireChannelToken(headers: IncomingHttpHeaders, token: string): void {
	if (headers["x-channel-token"] !== token) throw new AuthError("A valid channel service token is required");
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
	reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function publicAgentEvent(event: AgentEvent): unknown {
	switch (event.type) {
		case "message_update":
			return { type: event.type, update: event.assistantMessageEvent };
		case "tool_execution_start":
			return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
		case "tool_execution_end":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		case "message_end":
			return { type: event.type, message: event.message };
		case "agent_end":
			return { type: event.type };
		default:
			return { type: event.type };
	}
}

export function createAgentApp(
	service: CustomerServiceAgentService,
	orders: OrderConfirmationGateway,
	options: AgentAppOptions,
): FastifyInstance {
	const app = Fastify({ logger: true });

	app.addHook("onRequest", async (request, reply) => {
		const origin = options.allowedOrigin ?? "http://127.0.0.1:5173";
		reply.header("access-control-allow-origin", origin);
		reply.header(
			"access-control-allow-headers",
			"authorization, content-type, idempotency-key, x-internal-token, x-channel-token",
		);
		reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
		if (request.method === "OPTIONS") await reply.code(204).send();
	});

	app.setErrorHandler(async (error, _request, reply) => {
		if (error instanceof AuthError) {
			await reply.code(401).send({ code: "UNAUTHORIZED", message: error.message });
			return;
		}
		if (error instanceof ConversationAccessError) {
			await reply.code(404).send({ code: "CONVERSATION_NOT_FOUND", message: error.message });
			return;
		}
		if (error instanceof DeskError) {
			await reply.code(error.status).send({ code: error.code, message: error.message });
			return;
		}
		if (error instanceof CommerceHttpError) {
			await reply.code(error.status).send({ code: error.code, message: error.message });
			return;
		}
		app.log.error(error);
		await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Agent service failed" });
	});

	app.get("/health", async () => ({ status: "ok" }));

	if (options.wechat && options.channelToken) {
		const wechat = options.wechat;
		const channelToken = options.channelToken;
		app.post<{
			Body: {
				externalUserId?: unknown;
				externalMessageId?: unknown;
				contextToken?: unknown;
				text?: unknown;
			};
		}>("/api/internal/channels/wechat/messages", async (request, reply) => {
			requireChannelToken(request.headers, channelToken);
			const { externalUserId, externalMessageId, contextToken, text } = request.body ?? {};
			if (
				typeof externalUserId !== "string" ||
				!externalUserId.trim() ||
				typeof externalMessageId !== "string" ||
				!externalMessageId.trim() ||
				typeof contextToken !== "string" ||
				!contextToken.trim() ||
				typeof text !== "string" ||
				!text.trim()
			) {
				return await reply
					.code(400)
					.send({ code: "INVALID_INPUT", message: "Complete WeChat message fields are required" });
			}
			if (
				externalUserId.length > 255 ||
				externalMessageId.length > 255 ||
				contextToken.length > 8192 ||
				text.length > 4000
			) {
				return await reply.code(400).send({ code: "INVALID_INPUT", message: "WeChat message fields are too long" });
			}
			return await wechat.handleInbound({
				externalUserId: externalUserId.trim(),
				externalMessageId: externalMessageId.trim(),
				contextToken: contextToken.trim(),
				text: text.trim(),
			});
		});
	}

	app.post<{ Body: { userId?: unknown } }>("/api/auth/demo", async (request) => {
		const userId = request.body?.userId ?? options.demoUserId;
		if (userId !== options.demoUserId) throw new AuthError("Only the configured demo user can sign in");
		return { token: signAuthToken(options.demoUserId, options.authSecret), userId: options.demoUserId };
	});

	app.post("/api/conversations", async (request, reply) => {
		const userId = authenticate(request.headers, options.authSecret);
		return await reply.code(201).send({ conversationId: await service.createConversation(userId) });
	});

	app.get("/api/conversations", async (request) => {
		const userId = authenticate(request.headers, options.authSecret);
		return { conversations: await service.listConversations(userId) };
	});

	app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request) => {
		const userId = authenticate(request.headers, options.authSecret);
		return await service.loadConversationMessages(userId, request.params.id);
	});

	app.post<{ Body: { conversationId?: unknown; message?: unknown } }>("/api/chat", async (request, reply) => {
		const userId = authenticate(request.headers, options.authSecret);
		if (typeof request.body?.conversationId !== "string" || typeof request.body.message !== "string") {
			return await reply
				.code(400)
				.send({ code: "INVALID_INPUT", message: "conversationId and message are required" });
		}

		reply.hijack();
		reply.raw.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"access-control-allow-origin": options.allowedOrigin ?? "http://127.0.0.1:5173",
		});
		try {
			const result = await service.runMessage(userId, request.body.conversationId, request.body.message, (event) => {
				writeSse(reply, "agent", publicAgentEvent(event));
			});
			// The desk owns the conversation now. Telling the client avoids a silent turn that
			// looks like a failure to the customer.
			if (result.takenOverByHuman) writeSse(reply, "handover", { ok: true });
			writeSse(reply, "done", { ok: true });
		} catch (error) {
			writeSse(reply, "error", { message: error instanceof Error ? error.message : "Unknown agent error" });
		} finally {
			reply.raw.end();
		}
	});

	app.get<{ Params: { id: string } }>("/api/order-drafts/:id", async (request) => {
		const userId = authenticate(request.headers, options.authSecret);
		return await service.loadOrderDraft(userId, request.params.id);
	});

	app.post<{ Params: { id: string } }>("/api/order-drafts/:id/confirm", async (request) => {
		const userId = authenticate(request.headers, options.authSecret);
		await orders.confirmOrderDraft(userId, request.params.id);
		return await orders.submitOrderDraft(userId, request.params.id, `confirm:${userId}:${request.params.id}`);
	});

	/**
	 * The refund counterpart of the order confirmation above, and the reason the gate holds.
	 *
	 * The model can write a refund draft but has no JWT, so this route is out of its reach: a
	 * refund request can only exist because the customer tapped the card. `GET` restores that
	 * card after a reload, the same way the order draft is restored.
	 */
	app.get<{ Params: { id: string } }>("/api/refund-drafts/:id", async (request) => {
		const userId = authenticate(request.headers, options.authSecret);
		return await options.refunds.loadRefundDraft(userId, request.params.id);
	});

	app.post<{ Params: { id: string } }>("/api/refund-drafts/:id/confirm", async (request) => {
		const userId = authenticate(request.headers, options.authSecret);
		return await options.refunds.confirmRefundDraft(userId, request.params.id);
	});

	/**
	 * Desk routes. They have no counterpart in the tool set, so the model can open a ticket
	 * through `handoff_to_human` but can never claim, answer or close one.
	 */
	app.get<{ Querystring: { status?: string; limit?: string } }>("/api/support-tickets", async (request) => {
		requireDeskToken(request.headers, options.deskToken);
		const { status } = request.query;
		if (status !== undefined && !isSupportTicketStatus(status)) {
			throw new DeskError(400, "INVALID_INPUT", "status must be one of open, assigned, closed");
		}
		const parsed = Number(request.query.limit ?? 20);
		const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 100) : 20;
		return { tickets: await service.listSupportTickets({ status, limit }) };
	});

	app.get<{ Params: { id: string } }>("/api/support-tickets/:id", async (request) => {
		requireDeskToken(request.headers, options.deskToken);
		return await service.getSupportTicket(request.params.id);
	});

	/** The customer transcript route needs a customer JWT, which the desk does not hold. */
	app.get<{ Params: { id: string } }>("/api/support-tickets/:id/messages", async (request) => {
		requireDeskToken(request.headers, options.deskToken);
		return await service.loadSupportTicketConversation(request.params.id);
	});

	app.post<{ Params: { id: string }; Body: { assignee?: unknown } }>(
		"/api/support-tickets/:id/claim",
		async (request) => {
			requireDeskToken(request.headers, options.deskToken);
			const { assignee } = request.body ?? {};
			if (typeof assignee !== "string" || !assignee.trim()) {
				throw new DeskError(400, "INVALID_INPUT", "assignee is required");
			}
			return await service.claimSupportTicket(request.params.id, assignee.trim());
		},
	);

	/** The reply lands in the customer's own transcript, which is why this route lives here. */
	app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/api/support-tickets/:id/reply", async (request) => {
		requireDeskToken(request.headers, options.deskToken);
		const { text } = request.body ?? {};
		if (typeof text !== "string" || !text.trim()) {
			throw new DeskError(400, "INVALID_INPUT", "text is required");
		}
		return await service.replyToSupportTicket(request.params.id, text.trim());
	});

	app.post<{ Params: { id: string }; Body: { note?: unknown } }>("/api/support-tickets/:id/close", async (request) => {
		requireDeskToken(request.headers, options.deskToken);
		const { note } = request.body ?? {};
		if (note !== undefined && typeof note !== "string") {
			throw new DeskError(400, "INVALID_INPUT", "note must be a string when provided");
		}
		return await service.closeSupportTicket(
			request.params.id,
			typeof note === "string" && note.trim() ? note.trim() : null,
		);
	});

	return app;
}
