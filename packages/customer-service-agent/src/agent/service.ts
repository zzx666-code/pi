import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createCustomerServiceTools } from "../core/tools/index.ts";
import type { ConversationStore, ConversationSummary } from "./conversation-store.ts";
import { type ConversationHistory, latestOrderDraftId, toDisplayMessages } from "./conversation-view.ts";
import type { CommerceGateway, DraftSummary, KnowledgeGateway } from "./gateways.ts";
import { CUSTOMER_SERVICE_SYSTEM_PROMPT } from "./system-prompt.ts";

export type AgentEventListener = (event: AgentEvent) => Promise<void> | void;

export interface CustomerServiceAgentOptions {
	model: Model<"openai-completions">;
	streamFn: StreamFn;
	commerce: CommerceGateway;
	knowledge: KnowledgeGateway;
	conversations: ConversationStore;
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
		return { messages: toDisplayMessages(messages), orderDraftId: latestOrderDraftId(messages) };
	}

	async loadOrderDraft(userId: string, draftId: string): Promise<DraftSummary> {
		return await this.options.commerce.getOrderDraft(userId, draftId);
	}

	async runMessage(
		userId: string,
		conversationId: string,
		message: string,
		onEvent: AgentEventListener,
	): Promise<void> {
		if (!message.trim()) throw new Error("Message cannot be empty");
		if (this.activeConversations.has(conversationId)) throw new Error("Conversation is already processing a message");
		this.activeConversations.add(conversationId);
		try {
			const messages = await this.options.conversations.load(conversationId, userId);
			const toolSet = createCustomerServiceTools(
				{ userId, conversationId },
				this.options.commerce,
				this.options.knowledge,
			);
			const startedAt = new Map<string, number>();
			const agent = new Agent({
				initialState: {
					systemPrompt: CUSTOMER_SERVICE_SYSTEM_PROMPT,
					model: this.options.model,
					messages,
					tools: Object.values(toolSet),
				},
				streamFn: this.options.streamFn,
				sessionId: conversationId,
				toolExecution: "parallel",
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
			await this.options.conversations.replace(conversationId, userId, agent.state.messages);
		} finally {
			this.activeConversations.delete(conversationId);
		}
	}
}
