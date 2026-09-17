import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type ToolRequestContext, textResult } from "./shared.ts";

const handoffSchema = Type.Object({ summary: Type.String({ minLength: 1, maxLength: 500 }) });

export function createHandoffToHumanTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof handoffSchema, { ticketId: string }> {
	return {
		name: "handoff_to_human",
		label: "转人工客服",
		description: "创建人工客服工单。用于投诉、敏感操作、重复失败或用户明确要求人工服务。",
		parameters: handoffSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const ticket = await commerce.createSupportTicket(context.userId, params.summary);
			return textResult(JSON.stringify(ticket), { ticketId: ticket.id });
		},
	};
}
