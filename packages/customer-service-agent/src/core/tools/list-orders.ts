import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import {
	type CustomerServiceTool,
	type ToolRequestContext,
	textResult,
	toBeijingTime,
	withRecoveryHint,
} from "./shared.ts";

const listOrdersSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多返回的订单数量，默认 5。" })),
});

export const listOrdersToolSystemPromptContribution = {
	snippet: "列出当前用户最近的订单；用户没给订单号时先用它定位订单",
	guidelines: [
		"用户询问订单但没有提供订单号时，先调用 list_orders 获取最近的订单；拿到订单号后才用 get_order 查询明细。",
	],
} as const;

export function createListOrdersTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): CustomerServiceTool<typeof listOrdersSchema, { count: number }> {
	return {
		name: "list_orders",
		label: "查询我的订单列表",
		description:
			"列出当前已认证用户最近的订单，按提交时间从新到旧，包含订单号、状态、金额和商品。用户询问订单、订单状态，或没有提供订单号时使用。",
		promptSnippet: listOrdersToolSystemPromptContribution.snippet,
		promptGuidelines: [...listOrdersToolSystemPromptContribution.guidelines],
		parameters: listOrdersSchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const orders = await withRecoveryHint(() => commerce.listOrders(context.userId, params.limit ?? 5));
			const localised = orders.map((order) => ({ ...order, createdAt: toBeijingTime(order.createdAt) }));
			return textResult(JSON.stringify(localised), { count: orders.length });
		},
	};
}
