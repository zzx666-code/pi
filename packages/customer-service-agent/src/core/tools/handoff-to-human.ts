import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { SUPPORT_TICKET_STATUS_LABELS } from "../../domain/support-ticket.ts";
import { type ToolRequestContext, textResult, withRecoveryHint } from "./shared.ts";

const handoffSchema = Type.Object({ summary: Type.String({ minLength: 1, maxLength: 500 }) });

export function createHandoffToHumanTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof handoffSchema, { ticketId: string }> {
	return {
		name: "handoff_to_human",
		label: "转人工客服",
		description:
			"创建人工客服工单。用于投诉、敏感操作、重复失败或用户明确要求人工服务。" +
			"同一会话已经有未关闭的工单时直接返回那张工单，不会重复创建，因此可以放心在确认客户确实需要人工后调用。" +
			"转人工后请在回复中说明工单号和当前状态。",
		parameters: handoffSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			// The conversation id is stored with the ticket so the desk can answer into this transcript.
			const ticket = await withRecoveryHint(() =>
				commerce.createSupportTicket(context.userId, params.summary, context.conversationId),
			);
			return textResult(
				JSON.stringify({
					ticketId: ticket.id,
					status: ticket.status,
					statusLabel: SUPPORT_TICKET_STATUS_LABELS[ticket.status],
				}),
				{ ticketId: ticket.id },
			);
		},
	};
}
