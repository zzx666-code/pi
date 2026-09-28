import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { messageText } from "../../agent/conversation-view.ts";
import type { CustomerServiceAgentService } from "../../agent/service.ts";
import type { WechatAgentPort, WechatAgentTurn } from "./service.ts";

/** Presents the existing Pi customer-service runtime as one text-in/text-out channel turn. */
export class CustomerServiceWechatAgent implements WechatAgentPort {
	private readonly service: CustomerServiceAgentService;

	constructor(service: CustomerServiceAgentService) {
		this.service = service;
	}

	async createConversation(userId: string): Promise<string> {
		return await this.service.createConversation(userId);
	}

	async runTurn(userId: string, conversationId: string, text: string): Promise<WechatAgentTurn> {
		let reply = "";
		const result = await this.service.runMessage(userId, conversationId, text, (event: AgentEvent) => {
			if (event.type !== "message_end") return;
			const visible = messageText(event.message);
			if (visible) reply = visible;
		});
		const history = await this.service.loadConversationMessages(userId, conversationId);
		if (!reply) {
			reply = [...history.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
		}
		return {
			reply,
			takenOverByHuman: result.takenOverByHuman,
			orderDraftId: history.orderDraftId,
			refundDraftId: history.refundDraftId,
		};
	}
}
