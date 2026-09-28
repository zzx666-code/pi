import { randomUUID } from "node:crypto";
import type { DraftSummary, OrderSummary } from "../../agent/gateways.ts";
import type { RefundDecision, RefundDraft } from "../../domain/types.ts";

const CHANNEL = "wechat";

export interface WechatInboundMessage {
	externalUserId: string;
	externalMessageId: string;
	contextToken: string;
	text: string;
}

export interface WechatAgentTurn {
	reply: string;
	takenOverByHuman: boolean;
	orderDraftId?: string;
	refundDraftId?: string;
}

export interface WechatAgentPort {
	createConversation(userId: string): Promise<string>;
	runTurn(userId: string, conversationId: string, text: string): Promise<WechatAgentTurn>;
}

export interface WechatActionGateway {
	getOrderDraft(userId: string, draftId: string): Promise<DraftSummary>;
	confirmOrderDraft(userId: string, draftId: string): Promise<DraftSummary>;
	submitOrderDraft(userId: string, draftId: string, idempotencyKey: string): Promise<OrderSummary>;
	loadRefundDraft(userId: string, draftId: string): Promise<RefundDraft>;
	confirmRefundDraft(userId: string, draftId: string): Promise<RefundDecision>;
}

export interface WechatOutboxMessage {
	id: string;
	externalUserId: string;
	conversationId: string | null;
	contextToken: string;
	content: string;
	attemptCount: number;
}

export type WechatPendingActionType = "confirm_order" | "confirm_refund";

export interface WechatPendingAction {
	code: string;
	externalUserId: string;
	userId: string;
	conversationId: string;
	type: WechatPendingActionType;
	resourceId: string;
	expiresAt: number;
}

type InboundStart =
	| { status: "accepted" }
	| { status: "processing" }
	| { status: "completed"; conversationId: string | null; response: string | null };

export interface WechatChannelStore {
	findUserId(externalUserId: string): Promise<string | undefined>;
	bindUser(externalUserId: string, userId: string): Promise<void>;
	getConversationId(externalUserId: string): Promise<string | undefined>;
	saveConversation(externalUserId: string, conversationId: string, contextToken: string): Promise<void>;
	startInbound(message: WechatInboundMessage): Promise<InboundStart>;
	releaseInbound(message: WechatInboundMessage): Promise<void>;
	completeInbound(
		message: WechatInboundMessage,
		conversationId: string | null,
		response: string | null,
	): Promise<void>;
	getOrCreatePendingAction(action: Omit<WechatPendingAction, "code">, now: number): Promise<WechatPendingAction>;
	findPendingAction(externalUserId: string, code: string, now: number): Promise<WechatPendingAction | undefined>;
	completePendingAction(code: string): Promise<void>;
	claimOutbox(limit: number): Promise<WechatOutboxMessage[]>;
	markOutboxSent(id: string): Promise<void>;
	markOutboxFailed(id: string, error: string): Promise<void>;
	enqueueConversationReply(conversationId: string, content: string): Promise<void>;
	getSyncCursor(accountId: string): Promise<string>;
	saveSyncCursor(accountId: string, cursor: string): Promise<void>;
}

interface StoredInbound {
	status: "processing" | "completed";
	conversationId: string | null;
	response: string | null;
}

interface StoredConversation {
	conversationId: string;
	contextToken: string;
}

/** Test store that follows the same observable contract as the MySQL channel store. */
export class InMemoryWechatChannelStore implements WechatChannelStore {
	private readonly identities = new Map<string, string>();
	private readonly conversations = new Map<string, StoredConversation>();
	private readonly inbound = new Map<string, StoredInbound>();
	private readonly outbox: (WechatOutboxMessage & { status: "pending" | "sending" })[] = [];
	private readonly pendingActions = new Map<string, WechatPendingAction & { status: "pending" | "completed" }>();
	private readonly syncCursors = new Map<string, string>();

	async findUserId(externalUserId: string): Promise<string | undefined> {
		return this.identities.get(externalUserId);
	}

	async bindUser(externalUserId: string, userId: string): Promise<void> {
		this.identities.set(externalUserId, userId);
	}

	async getConversationId(externalUserId: string): Promise<string | undefined> {
		return this.conversations.get(externalUserId)?.conversationId;
	}

	async saveConversation(externalUserId: string, conversationId: string, contextToken: string): Promise<void> {
		this.conversations.set(externalUserId, { conversationId, contextToken });
	}

	async startInbound(message: WechatInboundMessage): Promise<InboundStart> {
		const key = `${CHANNEL}:${message.externalMessageId}`;
		const existing = this.inbound.get(key);
		if (existing?.status === "completed") {
			return { status: "completed", conversationId: existing.conversationId, response: existing.response };
		}
		if (existing) return { status: "processing" };
		this.inbound.set(key, { status: "processing", conversationId: null, response: null });
		return { status: "accepted" };
	}

	async completeInbound(
		message: WechatInboundMessage,
		conversationId: string | null,
		response: string | null,
	): Promise<void> {
		this.inbound.set(`${CHANNEL}:${message.externalMessageId}`, {
			status: "completed",
			conversationId,
			response,
		});
		if (response !== null) {
			this.outbox.push({
				id: randomUUID(),
				externalUserId: message.externalUserId,
				conversationId,
				contextToken: message.contextToken,
				content: response,
				attemptCount: 0,
				status: "pending",
			});
		}
	}

	async releaseInbound(message: WechatInboundMessage): Promise<void> {
		const key = `${CHANNEL}:${message.externalMessageId}`;
		if (this.inbound.get(key)?.status === "processing") this.inbound.delete(key);
	}

	async getOrCreatePendingAction(
		action: Omit<WechatPendingAction, "code">,
		now: number,
	): Promise<WechatPendingAction> {
		const existing = [...this.pendingActions.values()].find(
			(item) =>
				item.status === "pending" &&
				item.externalUserId === action.externalUserId &&
				item.type === action.type &&
				item.resourceId === action.resourceId,
		);
		if (existing && existing.expiresAt > now) return structuredClone(existing);
		if (existing) this.pendingActions.delete(existing.code);
		let code = "";
		do {
			code = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
		} while (this.pendingActions.has(code));
		const created = { ...action, code, status: "pending" as const };
		this.pendingActions.set(code, created);
		return structuredClone(created);
	}

	async findPendingAction(
		externalUserId: string,
		code: string,
		now: number,
	): Promise<WechatPendingAction | undefined> {
		const action = this.pendingActions.get(code.toUpperCase());
		if (
			!action ||
			action.status !== "pending" ||
			action.externalUserId !== externalUserId ||
			action.expiresAt <= now
		) {
			return undefined;
		}
		return structuredClone(action);
	}

	async completePendingAction(code: string): Promise<void> {
		const action = this.pendingActions.get(code.toUpperCase());
		if (action) action.status = "completed";
	}

	async claimOutbox(limit: number): Promise<WechatOutboxMessage[]> {
		const claimed = this.outbox.filter((item) => item.status === "pending").slice(0, Math.max(0, limit));
		for (const item of claimed) {
			item.status = "sending";
			item.attemptCount += 1;
		}
		return structuredClone(claimed);
	}

	async markOutboxSent(id: string): Promise<void> {
		const index = this.outbox.findIndex((item) => item.id === id);
		if (index >= 0) this.outbox.splice(index, 1);
	}

	async markOutboxFailed(id: string, _error: string): Promise<void> {
		const item = this.outbox.find((candidate) => candidate.id === id);
		if (item) item.status = "pending";
	}

	async enqueueConversationReply(conversationId: string, content: string): Promise<void> {
		for (const [externalUserId, conversation] of this.conversations) {
			if (conversation.conversationId !== conversationId) continue;
			this.outbox.push({
				id: randomUUID(),
				externalUserId,
				conversationId,
				contextToken: conversation.contextToken,
				content,
				attemptCount: 0,
				status: "pending",
			});
		}
	}

	async getSyncCursor(accountId: string): Promise<string> {
		return this.syncCursors.get(accountId) ?? "";
	}

	async saveSyncCursor(accountId: string, cursor: string): Promise<void> {
		this.syncCursors.set(accountId, cursor);
	}
}

export interface WechatChannelServiceOptions {
	store: WechatChannelStore;
	agent: WechatAgentPort;
	actions: WechatActionGateway;
	demoUserId: string;
	autoBindDemoUser: boolean;
	clock?: () => number;
}

export interface WechatChannelReply {
	conversationId: string | null;
	reply: string | null;
	duplicate: boolean;
}

export class WechatChannelService {
	private readonly options: WechatChannelServiceOptions;

	constructor(options: WechatChannelServiceOptions) {
		this.options = options;
	}

	async handleInbound(message: WechatInboundMessage): Promise<WechatChannelReply> {
		const start = await this.options.store.startInbound(message);
		if (start.status === "completed") {
			return { conversationId: start.conversationId, reply: start.response, duplicate: true };
		}
		if (start.status === "processing") {
			return { conversationId: null, reply: "这条消息正在处理中，请稍候。", duplicate: true };
		}
		try {
			return await this.handleAcceptedInbound(message);
		} catch (error) {
			await this.options.store.releaseInbound(message);
			throw error;
		}
	}

	private async handleAcceptedInbound(message: WechatInboundMessage): Promise<WechatChannelReply> {
		let userId = await this.options.store.findUserId(message.externalUserId);
		if (!userId && this.options.autoBindDemoUser) {
			userId = this.options.demoUserId;
			await this.options.store.bindUser(message.externalUserId, userId);
		}
		if (!userId) {
			const reply = "当前微信尚未绑定客户账号，请先完成账号绑定。";
			await this.options.store.completeInbound(message, null, reply);
			return { conversationId: null, reply, duplicate: false };
		}

		const command = message.text.trim().toLowerCase();
		if (command === "/help") {
			const conversationId = (await this.options.store.getConversationId(message.externalUserId)) ?? null;
			const reply = [
				"微信智能客服命令：",
				"/help 查看帮助",
				"/new 开始新的客服会话",
				"/status 查看绑定与会话状态",
				"订单或退款草稿生成后，请严格按提示回复确认码。",
			].join("\n");
			await this.options.store.completeInbound(message, conversationId, reply);
			return { conversationId, reply, duplicate: false };
		}
		if (command === "/new") {
			const conversationId = await this.options.agent.createConversation(userId);
			await this.options.store.saveConversation(message.externalUserId, conversationId, message.contextToken);
			const reply = "已开始新的客服会话。";
			await this.options.store.completeInbound(message, conversationId, reply);
			return { conversationId, reply, duplicate: false };
		}
		if (command === "/status") {
			const conversationId = (await this.options.store.getConversationId(message.externalUserId)) ?? null;
			const reply = conversationId
				? "微信账号已绑定，当前客服会话可继续使用。"
				: "微信账号已绑定，尚未开始客服会话。";
			await this.options.store.completeInbound(message, conversationId, reply);
			return { conversationId, reply, duplicate: false };
		}

		const confirmation = /^(确认下单|确认退款)\s+([A-Z0-9]{6})$/i.exec(message.text.trim());
		if (confirmation) {
			const code = confirmation[2].toUpperCase();
			const action = await this.options.store.findPendingAction(
				message.externalUserId,
				code,
				this.options.clock?.() ?? Date.now(),
			);
			const expectedType: WechatPendingActionType =
				confirmation[1] === "确认下单" ? "confirm_order" : "confirm_refund";
			if (!action || action.userId !== userId || action.type !== expectedType) {
				const reply = "确认码无效、已使用或已经过期，请重新发起操作。";
				await this.options.store.completeInbound(message, action?.conversationId ?? null, reply);
				return { conversationId: action?.conversationId ?? null, reply, duplicate: false };
			}
			const reply = await this.executePendingAction(action, message.externalMessageId);
			await this.options.store.completePendingAction(action.code);
			await this.options.store.saveConversation(message.externalUserId, action.conversationId, message.contextToken);
			await this.options.store.completeInbound(message, action.conversationId, reply);
			return { conversationId: action.conversationId, reply, duplicate: false };
		}

		let conversationId = await this.options.store.getConversationId(message.externalUserId);
		if (!conversationId) {
			conversationId = await this.options.agent.createConversation(userId);
		}
		await this.options.store.saveConversation(message.externalUserId, conversationId, message.contextToken);

		const turn = await this.options.agent.runTurn(userId, conversationId, message.text.trim());
		if (turn.takenOverByHuman) {
			await this.options.store.completeInbound(message, conversationId, null);
			return { conversationId, reply: null, duplicate: false };
		}
		let reply = turn.reply.trim() || "本次请求已处理，但没有生成可显示的回复。";
		reply = await this.appendConfirmationInstructions(message.externalUserId, userId, conversationId, turn, reply);
		await this.options.store.completeInbound(message, conversationId, reply);
		return { conversationId, reply, duplicate: false };
	}

	private async appendConfirmationInstructions(
		externalUserId: string,
		userId: string,
		conversationId: string,
		turn: WechatAgentTurn,
		reply: string,
	): Promise<string> {
		const now = this.options.clock?.() ?? Date.now();
		const expiresAt = now + 5 * 60 * 1000;
		const instructions: string[] = [];
		if (turn.orderDraftId) {
			const draft = await this.options.actions.getOrderDraft(userId, turn.orderDraftId);
			if (draft.status === "awaiting_confirmation") {
				const action = await this.options.store.getOrCreatePendingAction(
					{
						externalUserId,
						userId,
						conversationId,
						type: "confirm_order",
						resourceId: turn.orderDraftId,
						expiresAt,
					},
					now,
				);
				instructions.push(
					`订单金额：¥${(draft.totalCents / 100).toFixed(2)}。回复“确认下单 ${action.code}”提交，确认码 5 分钟内有效。`,
				);
			}
		}
		if (turn.refundDraftId) {
			const draft = await this.options.actions.loadRefundDraft(userId, turn.refundDraftId);
			if (draft.status === "awaiting_confirmation") {
				const action = await this.options.store.getOrCreatePendingAction(
					{
						externalUserId,
						userId,
						conversationId,
						type: "confirm_refund",
						resourceId: turn.refundDraftId,
						expiresAt,
					},
					now,
				);
				instructions.push(
					`退款申请金额：¥${(draft.amountCents / 100).toFixed(2)}。回复“确认退款 ${action.code}”提交，确认码 5 分钟内有效。`,
				);
			}
		}
		return instructions.length > 0 ? `${reply}\n\n${instructions.join("\n")}` : reply;
	}

	private async executePendingAction(action: WechatPendingAction, externalMessageId: string): Promise<string> {
		if (action.type === "confirm_order") {
			await this.options.actions.confirmOrderDraft(action.userId, action.resourceId);
			const order = await this.options.actions.submitOrderDraft(
				action.userId,
				action.resourceId,
				`wechat:${action.externalUserId}:${externalMessageId}`,
			);
			return `订单 ${order.id} 已提交，金额 ¥${(order.totalCents / 100).toFixed(2)}。`;
		}
		const decision = await this.options.actions.confirmRefundDraft(action.userId, action.resourceId);
		return decision.eligible
			? `退款申请 ${decision.refundId} 已提交，当前状态为 ${decision.status}。`
			: decision.message;
	}
}
