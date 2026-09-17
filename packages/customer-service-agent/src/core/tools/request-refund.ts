import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { REFUND_WINDOW_DAYS } from "../../domain/order-service.ts";
import { REFUND_STATUS_LABELS } from "../../domain/refund-status.ts";
import type { RefundDecision } from "../../domain/types.ts";
import { type ToolRequestContext, textResult } from "./shared.ts";

const requestRefundSchema = Type.Object({
	orderId: Type.String({ minLength: 1, description: "要申请退款的订单号。" }),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "客户给出的退款原因，可选。" })),
});

/** Exported so the tool factory's inferred return type stays nameable in declarations. */
export interface RequestRefundDetails {
	eligible: boolean;
	refundId?: string;
	code?: string;
}

export function createRequestRefundTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof requestRefundSchema, RequestRefundDetails> {
	return {
		name: "request_refund",
		label: "提交退款申请",
		description:
			`提交退款申请，只能提交当前已认证用户本人的订单。退款资格由服务端按下单时间判断：` +
			`下单未超过 ${REFUND_WINDOW_DAYS} 天的订单会写入退款申请并进入待处理状态（pending_review），` +
			`超过 ${REFUND_WINDOW_DAYS} 天返回 eligible=false 且不写入。` +
			"本工具不决定是否退款，也不承诺退款金额或到账时间。调用前必须与用户确认订单号和退款诉求。",
		parameters: requestRefundSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const decision: RefundDecision = await commerce.requestRefund(context.userId, params.orderId, params.reason);
			const details: RequestRefundDetails = decision.eligible
				? { eligible: true, refundId: decision.refundId }
				: { eligible: false, code: decision.code };
			const visible = decision.eligible
				? { ...decision, statusLabel: REFUND_STATUS_LABELS[decision.status] }
				: decision;
			return textResult(JSON.stringify(visible), details);
		},
	};
}
