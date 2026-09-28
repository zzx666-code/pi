import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { REFUND_STATUS_LABELS } from "../../domain/refund-status.ts";
import {
	type CustomerServiceTool,
	type ToolRequestContext,
	textResult,
	toBeijingTime,
	withRecoveryHint,
} from "./shared.ts";

const listRefundRequestsSchema = Type.Object({
	orderId: Type.Optional(
		Type.String({ minLength: 1, description: "只查询该订单的退款申请；用户提供了订单号时传入。" }),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多返回的申请数量，默认 5。" })),
});

export const listRefundRequestsToolSystemPromptContribution = {
	snippet: "查询退款申请的进度、审核状态和到账情况",
	guidelines: [
		"用户询问退款进度、审核结果或到账情况时调用 list_refund_requests（用户提供了订单号就带上 orderId）。",
		"只能原样转述 list_refund_requests 返回的状态含义，不得推测“应该快到了”“正在打款”等进度，也不得承诺到账时间。",
	],
} as const;

export function createListRefundRequestsTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): CustomerServiceTool<typeof listRefundRequestsSchema, { count: number }> {
	return {
		name: "list_refund_requests",
		label: "查询退款申请进度",
		description:
			"查询当前已认证用户自己的退款申请，按提交时间从新到旧，包含状态、金额、原因和最后一次状态变更的时间。" +
			"用户询问退款进度、退款结果、审核状态或到账情况时使用；用户提供了订单号时用 orderId 过滤。" +
			"只能原样转述返回的状态名称，不要推测进度或到账时间。",
		promptSnippet: listRefundRequestsToolSystemPromptContribution.snippet,
		promptGuidelines: [...listRefundRequestsToolSystemPromptContribution.guidelines],
		parameters: listRefundRequestsSchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const requests = await withRecoveryHint(() =>
				commerce.listRefundRequests(context.userId, {
					orderId: params.orderId,
					limit: params.limit ?? 5,
				}),
			);
			// Only customer-visible fields: the reviewer's identity and internal notes stay server-side.
			const visible = requests.map((request) => ({
				refundId: request.id,
				orderId: request.orderId,
				status: request.status,
				statusLabel: REFUND_STATUS_LABELS[request.status],
				amountCents: request.amountCents,
				reason: request.reason,
				requestedAt: toBeijingTime(request.requestedAt),
				updatedAt: toBeijingTime(request.lastTransitionAt),
			}));
			return textResult(JSON.stringify(visible), { count: visible.length });
		},
	};
}
