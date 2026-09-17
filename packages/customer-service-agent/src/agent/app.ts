import type { IncomingHttpHeaders } from "node:http";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { AuthError, signAuthToken, verifyAuthToken } from "./auth.ts";
import { ConversationAccessError } from "./conversation-store.ts";
import { CommerceHttpError, type OrderConfirmationGateway } from "./gateways.ts";
import type { CustomerServiceAgentService } from "./service.ts";

interface AgentAppOptions {
	authSecret: string;
	demoUserId: string;
	allowedOrigin?: string;
}

function authenticate(headers: IncomingHttpHeaders, secret: string): string {
	const authorization = headers.authorization;
	if (!authorization?.startsWith("Bearer ")) throw new AuthError("Bearer authentication is required");
	return verifyAuthToken(authorization.slice("Bearer ".length), secret).userId;
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
		reply.header("access-control-allow-headers", "authorization, content-type, idempotency-key");
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
		if (error instanceof CommerceHttpError) {
			await reply.code(error.status).send({ code: error.code, message: error.message });
			return;
		}
		app.log.error(error);
		await reply.code(500).send({ code: "INTERNAL_ERROR", message: "Agent service failed" });
	});

	app.get("/health", async () => ({ status: "ok" }));

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
			await service.runMessage(userId, request.body.conversationId, request.body.message, (event) => {
				writeSse(reply, "agent", publicAgentEvent(event));
			});
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

	return app;
}
