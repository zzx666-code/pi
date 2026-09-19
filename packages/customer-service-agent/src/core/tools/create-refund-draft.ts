import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { REFUND_WINDOW_DAYS } from "../../domain/order-service.ts";
import type { RefundProposal } from "../../domain/types.ts";
import { type ToolRequestContext, textResult, withRecoveryHint } from "./shared.ts";

const createRefundDraftSchema = Type.Object({
	orderId: Type.String({ minLength: 1, description: "要申请退款的订单号。" }),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "客户给出的退款原因，可选。" })),
});

/** Exported so the tool factory's inferred return type stays nameable in declarations. */
export interface CreateRefundDraftDetails {
	eligible: boolean;
	draftId?: string;
	requiresConfirmation?: true;
	code?: string;
}

export function createCreateRefundDraftTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof createRefundDraftSchema, CreateRefundDraftDetails> {
	return {
		name: "create_refund_draft",
		label: "创建退款申请草稿",
		description:
			`创建退款申请草稿，只能针对当前已认证用户本人的订单。此工具不会提交申请，必须由用户在界面中明确确认。` +
			`退款资格由服务端按下单时间判断：下单未超过 ${REFUND_WINDOW_DAYS} 天的订单会生成草稿（eligible=true），` +
			`超过 ${REFUND_WINDOW_DAYS} 天返回 eligible=false 且不生成草稿。` +
			"本工具不决定是否退款，也不承诺退款金额或到账时间。调用前必须与用户确认订单号和退款诉求。",
		parameters: createRefundDraftSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const proposal: RefundProposal = await withRecoveryHint(() =>
				commerce.proposeRefund(context.userId, params.orderId, params.reason),
			);
			const details: CreateRefundDraftDetails = proposal.eligible
				? { eligible: true, draftId: proposal.draftId, requiresConfirmation: true }
				: { eligible: false, code: proposal.code };
			return textResult(JSON.stringify(proposal), details);
		},
	};
}
