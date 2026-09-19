import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type ToolRequestContext, textResult, withRecoveryHint } from "./shared.ts";

const cancelRefundSchema = Type.Object({
	orderId: Type.String({ minLength: 1, description: "要撤销退款申请的订单号。" }),
});

/** Exported so the tool factory's inferred return type stays nameable in declarations. */
export interface CancelRefundDetails {
	cancelled: boolean;
	orderId: string;
}

export function createCancelRefundRequestTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof cancelRefundSchema, CancelRefundDetails> {
	return {
		name: "cancel_refund_request",
		label: "撤销退款申请",
		description:
			"撤销当前已认证用户本人的、尚未开始打款的退款申请（状态为待处理或已移交人工）。" +
			"撤销后订单不再被占用，客户可以重新提交新的申请。" +
			"已通过审核或已完成的申请不能撤销，工具会返回 cancelled=false 和原因。" +
			"调用前必须与用户确认要撤销哪一张订单的申请。",
		parameters: cancelRefundSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const result = await withRecoveryHint(() => commerce.cancelRefundRequest(context.userId, params.orderId));
			return textResult(JSON.stringify(result), { cancelled: result.cancelled, orderId: result.orderId });
		},
	};
}
