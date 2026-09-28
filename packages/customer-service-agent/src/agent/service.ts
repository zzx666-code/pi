import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	allCustomerServiceToolNames,
	type CustomerServiceToolName,
	type CustomerServiceToolOfSet,
	type CustomerServiceToolSet,
	createCustomerServiceTools,
	selectCustomerServiceTools,
} from "../core/tools/index.ts";
import type { SupportTicket, SupportTicketListOptions } from "../domain/types.ts";
import type { ConversationStore, ConversationSummary } from "./conversation-store.ts";
import {
	type ConversationHistory,
	latestOrderDraftId,
	latestRefundDraftId,
	type SupportTicketConversation,
	toDisplayMessages,
} from "./conversation-view.ts";
import type { DeskAction, DeskAuditStore } from "./desk-audit.ts";
import { type CommerceGateway, CommerceHttpError, type DraftSummary, type KnowledgeGateway } from "./gateways.ts";
import { createHumanAgentMessage, toLlmMessages } from "./human-agent-message.ts";
import { buildCustomerServiceSystemPrompt } from "./system-prompt.ts";

export type AgentEventListener = (event: AgentEvent) => Promise<void> | void;

/**
 * Raised by the desk routes. It carries the HTTP status so the route layer can answer with that
 * status instead of collapsing every desk mistake into a 500.
 */
export class DeskError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "DeskError";
		this.status = status;
		this.code = code;
	}
}

/** Outcome of one customer turn. */
export interface RunMessageResult {
	/** A human has claimed the conversation, so this turn never reached the model. */
	takenOverByHuman: boolean;
}

export interface CustomerServiceAgentOptions {
	model: Model<"openai-completions">;
	streamFn: StreamFn;
	commerce: CommerceGateway;
	knowledge: KnowledgeGateway;
	/**
	 * Tools the model may see, in prompt order. Omitted means every tool.
	 *
	 * A tool left out here is absent from the provider request and from the prompt, so its
	 * rules never appear either.
	 */
	enabledTools?: readonly CustomerServiceToolName[];
	conversations: ConversationStore;
	/** Where desk actions are recorded. Required: an unauditable desk is not a supported mode. */
	deskAudit: DeskAuditStore;
	/** Optional customer-channel delivery sink for asynchronous human replies. */
	replySink?: { enqueueConversationReply(conversationId: string, content: string): Promise<void> };
}

export class CustomerServiceAgentService {
	private readonly options: CustomerServiceAgentOptions;
	private readonly activeConversations = new Set<string>();

	constructor(options: CustomerServiceAgentOptions) {
		this.options = options;
	}

	async createConversation(userId: string): Promise<string> {
		return await this.options.conversations.create(userId);
	}

	async listConversations(userId: string): Promise<ConversationSummary[]> {
		return await this.options.conversations.list(userId);
	}

	async loadConversationMessages(userId: string, conversationId: string): Promise<ConversationHistory> {
		const messages = await this.options.conversations.load(conversationId, userId);
		return {
			messages: toDisplayMessages(messages),
			orderDraftId: latestOrderDraftId(messages),
			refundDraftId: latestRefundDraftId(messages),
			underHumanTakeover: await this.isUnderHumanTakeover(conversationId),
		};
	}

	/**
	 * Reads the transcript a ticket was opened from.
	 *
	 * The desk authenticates with the internal token instead of a customer JWT, so it cannot use
	 * {@link loadConversationMessages}. Resolving the conversation through the ticket also keeps the
	 * desk from reading a transcript it has no ticket for.
	 */
	async loadSupportTicketConversation(ticketId: string): Promise<SupportTicketConversation> {
		const ticket = await this.options.commerce.getSupportTicket(ticketId);
		if (!ticket.conversationId) return { conversationId: null, messages: [] };
		const messages = await this.options.conversations.load(ticket.conversationId, ticket.userId);
		return { conversationId: ticket.conversationId, messages: toDisplayMessages(messages) };
	}

	async loadOrderDraft(userId: string, draftId: string): Promise<DraftSummary> {
		return await this.options.commerce.getOrderDraft(userId, draftId);
	}

	async listSupportTickets(options?: SupportTicketListOptions): Promise<SupportTicket[]> {
		return await this.options.commerce.listSupportTickets(options);
	}

	async getSupportTicket(ticketId: string): Promise<SupportTicket> {
		return await this.options.commerce.getSupportTicket(ticketId);
	}

	async claimSupportTicket(ticketId: string, assignee: string): Promise<SupportTicket> {
		return await this.auditedDeskAction({ ticketId, assignee, action: "claim", request: { assignee } }, () =>
			this.options.commerce.claimSupportTicket(ticketId, assignee),
		);
	}

	/**
	 * Writes a desk reply into the customer's transcript.
	 *
	 * Claiming first is what puts the conversation into human takeover, so a reply can never land
	 * in a conversation the model is still answering. The author comes from the ticket rather than
	 * from the request, so a reply cannot be attributed to somebody who did not claim it.
	 */
	async replyToSupportTicket(ticketId: string, text: string): Promise<SupportTicket> {
		const ticket = await this.options.commerce.getSupportTicket(ticketId);
		return await this.auditedDeskAction(
			{ ticketId, assignee: ticket.assignee, action: "reply", request: { text } },
			async () => {
				// The guards live inside the audited action on purpose: replying to a ticket nobody
				// claimed is exactly the kind of attempt the trail has to keep.
				const { conversationId, assignee } = ticket;
				if (!conversationId) {
					throw new DeskError(
						409,
						"TICKET_WITHOUT_CONVERSATION",
						`Support ticket ${ticketId} has no conversation to reply into`,
					);
				}
				if (ticket.status !== "assigned" || !assignee) {
					throw new DeskError(
						409,
						"TICKET_NOT_ASSIGNED",
						`Support ticket ${ticketId} must be claimed before replying`,
					);
				}
				await this.options.conversations.append(conversationId, ticket.userId, [
					createHumanAgentMessage({ author: assignee, text, ticketId, timestamp: Date.now() }),
				]);
				await this.options.replySink?.enqueueConversationReply(conversationId, `人工客服 ${assignee}：${text}`);
				return ticket;
			},
		);
	}

	async closeSupportTicket(ticketId: string, note: string | null): Promise<SupportTicket> {
		return await this.auditedDeskAction({ ticketId, assignee: null, action: "close", request: { note } }, () =>
			this.options.commerce.closeSupportTicket(ticketId, note),
		);
	}

	/**
	 * Runs one desk action and leaves two audit rows behind: the attempt, then the outcome.
	 *
	 * The attempt is written first so an action that dies mid-flight still left evidence, and so an
	 * action whose intent cannot be recorded does not run at all. The outcome row is the one that
	 * names the customer and the conversation, which only the returned ticket knows.
	 *
	 * Every desk write goes through here; there is no other route to a ticket.
	 */
	private async auditedDeskAction<
		T extends { conversationId: string | null; userId: string; assignee: string | null },
	>(
		base: { ticketId: string; assignee: string | null; action: DeskAction; request?: unknown },
		operation: () => Promise<T>,
	): Promise<T> {
		const startedAt = Date.now();
		await this.options.deskAudit.record({ ...base, conversationId: null, userId: null, status: "started" });
		try {
			const result = await operation();
			await this.options.deskAudit.record({
				...base,
				assignee: result.assignee ?? base.assignee,
				conversationId: result.conversationId,
				userId: result.userId,
				status: "succeeded",
				durationMs: Date.now() - startedAt,
			});
			return result;
		} catch (error) {
			await this.options.deskAudit.record({
				...base,
				conversationId: null,
				userId: null,
				status: "rejected",
				durationMs: Date.now() - startedAt,
				// A refused claim arrives as a CommerceHttpError carrying the reason. Collapsing it
				// into UNEXPECTED would leave the trail unable to answer "why was this refused".
				errorCode: error instanceof DeskError || error instanceof CommerceHttpError ? error.code : "UNEXPECTED",
			});
			throw error;
		}
	}

	/**
	 * The tools the model may see this turn.
	 *
	 * The tool list and the system prompt both come from this one call, so a tool that is
	 * not enabled cannot leave rules behind in the prompt.
	 */
	private selectTools(toolSet: CustomerServiceToolSet): CustomerServiceToolOfSet[] {
		return selectCustomerServiceTools(toolSet, this.options.enabledTools ?? allCustomerServiceToolNames(toolSet));
	}

	async runMessage(
		userId: string,
		conversationId: string,
		message: string,
		onEvent: AgentEventListener,
	): Promise<RunMessageResult> {
		if (!message.trim()) throw new Error("Message cannot be empty");
		if (this.activeConversations.has(conversationId)) throw new Error("Conversation is already processing a message");
		this.activeConversations.add(conversationId);
		try {
			// Checked inside the lock, so a claim cannot land between the check and the model call
			// and leave both a human and the bot answering the same conversation.
			if (await this.isUnderHumanTakeover(conversationId)) {
				await this.options.conversations.append(conversationId, userId, [
					{ role: "user", content: message.trim(), timestamp: Date.now() },
				]);
				return { takenOverByHuman: true };
			}

			const messages = await this.options.conversations.load(conversationId, userId);
			const toolSet = createCustomerServiceTools(
				{ userId, conversationId },
				this.options.commerce,
				this.options.knowledge,
			);
			const tools = this.selectTools(toolSet);
			const startedAt = new Map<string, number>();
			const agent = new Agent({
				initialState: {
					systemPrompt: buildCustomerServiceSystemPrompt({ tools }),
					model: this.options.model,
					messages,
					// AgentTool<any> types execute() parameters as unknown, so a concretely typed
					// tool is not structurally assignable. The runtime only needs the declared
					// surface, so widen once here instead of widening every tool factory.
					tools: tools as AgentTool<any>[],
				},
				streamFn: this.options.streamFn,
				sessionId: conversationId,
				toolExecution: "parallel",
				// Desk replies arrive as user turns tagged with the agent's name, so the model can
				// see what a human already told the customer instead of repeating it.
				convertToLlm: toLlmMessages,
				beforeToolCall: async ({ toolCall, args }) => {
					startedAt.set(toolCall.id, Date.now());
					await this.options.conversations.recordToolAudit({
						conversationId,
						userId,
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						status: "started",
						request: args,
					});
					return undefined;
				},
				afterToolCall: async ({ toolCall, result, isError }) => {
					await this.options.conversations.recordToolAudit({
						conversationId,
						userId,
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						status: isError ? "failed" : "succeeded",
						result: result.details,
						durationMs: Date.now() - (startedAt.get(toolCall.id) ?? Date.now()),
					});
					return undefined;
				},
			});
			agent.subscribe(onEvent);
			await agent.prompt(message.trim());
			// Only this turn's messages: a desk reply can land while the model is thinking, and
			// replace() would delete it along with the rest of the transcript.
			await this.options.conversations.append(conversationId, userId, agent.state.messages.slice(messages.length));
			return { takenOverByHuman: false };
		} finally {
			this.activeConversations.delete(conversationId);
		}
	}

	/**
	 * A conversation is under human takeover while a claimed ticket points at it. Closing that
	 * ticket hands the conversation back to the bot.
	 */
	private async isUnderHumanTakeover(conversationId: string): Promise<boolean> {
		const tickets = await this.options.commerce.listSupportTickets({
			status: "assigned",
			conversationId,
			limit: 1,
		});
		return tickets.length > 0;
	}
}
