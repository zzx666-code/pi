import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { SUPPORT_TICKET_STATUS_LABELS } from "../../domain/support-ticket.ts";
import { type CustomerServiceTool, type ToolRequestContext, textResult, withRecoveryHint } from "./shared.ts";

const handoffSchema = Type.Object({ summary: Type.String({ minLength: 1, maxLength: 500 }) });

export const handoffToHumanToolSystemPromptContribution = {
	snippet: "创建人工客服工单；同一会话已有未关闭工单时返回那一张",
	guidelines: [
		"工具确实无法解决、用户投诉、涉及敏感操作或用户明确要求人工时，调用 handoff_to_human。",
		"转人工必须调用 handoff_to_human，并在回复中告知工单号和当前状态。人工坐席接入后由坐席在这个会话里回复，不要承诺处理时限，也不要声称已经联系上人工。",
	],
} as const;

export function createHandoffToHumanTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): CustomerServiceTool<typeof handoffSchema, { ticketId: string }> {
	return {
		name: "handoff_to_human",
		label: "转人工客服",
		description:
			"创建人工客服工单。用于投诉、敏感操作、重复失败或用户明确要求人工服务。" +
			"同一会话已经有未关闭的工单时直接返回那张工单，不会重复创建，因此可以放心在确认客户确实需要人工后调用。" +
			"转人工后请在回复中说明工单号和当前状态。",
		promptSnippet: handoffToHumanToolSystemPromptContribution.snippet,
		promptGuidelines: [...handoffToHumanToolSystemPromptContribution.guidelines],
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
