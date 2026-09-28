import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type CustomerServiceTool, type ToolRequestContext, textResult, withRecoveryHint } from "./shared.ts";

const cancelRefundSchema = Type.Object({
	orderId: Type.String({ minLength: 1, description: "要撤销退款申请的订单号。" }),
});

/** Exported so the tool factory's inferred return type stays nameable in declarations. */
export interface CancelRefundDetails {
	cancelled: boolean;
	orderId: string;
}

export const cancelRefundRequestToolSystemPromptContribution = {
	snippet: "撤销尚未开始打款的退款申请",
	guidelines: [
		"用户表示撤销、取消或不退了时调用 cancel_refund_request（需要订单号，用户没提供就先 list_refund_requests 或 list_orders 确认）。",
		"cancel_refund_request 返回 cancelled=false 时如实说明原因：状态为“已通过审核，等待退款执行”的申请已经无法撤销，此时建议转人工。",
		"撤销成功后订单可以重新申请退款，按 create_refund_draft 的规则处理新申请。",
	],
} as const;

export function createCancelRefundRequestTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): CustomerServiceTool<typeof cancelRefundSchema, CancelRefundDetails> {
	return {
		name: "cancel_refund_request",
		label: "撤销退款申请",
		description:
			"撤销当前已认证用户本人的、尚未开始打款的退款申请（状态为待处理或已移交人工）。" +
			"撤销后订单不再被占用，客户可以重新提交新的申请。" +
			"已通过审核或已完成的申请不能撤销，工具会返回 cancelled=false 和原因。" +
			"调用前必须与用户确认要撤销哪一张订单的申请。",
		promptSnippet: cancelRefundRequestToolSystemPromptContribution.snippet,
		promptGuidelines: [...cancelRefundRequestToolSystemPromptContribution.guidelines],
		parameters: cancelRefundSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const result = await withRecoveryHint(() => commerce.cancelRefundRequest(context.userId, params.orderId));
			return textResult(JSON.stringify(result), { cancelled: result.cancelled, orderId: result.orderId });
		},
	};
}
