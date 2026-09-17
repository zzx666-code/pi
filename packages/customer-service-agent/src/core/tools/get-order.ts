import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type ToolRequestContext, textResult } from "./shared.ts";

const getOrderSchema = Type.Object({ orderId: Type.String({ minLength: 1 }) });

export function createGetOrderTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof getOrderSchema, { orderId: string }> {
	return {
		name: "get_order",
		label: "查询订单",
		description:
			"按订单号查询当前已认证用户自己的订单。也接受刚创建的订单草稿号：确认下单后正式订单号会重新生成，草稿号仍能反查到该订单。用户身份由服务端绑定，不接受用户 ID 参数。",
		parameters: getOrderSchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const order = await commerce.getOrder(context.userId, params.orderId);
			return textResult(JSON.stringify(order), { orderId: params.orderId });
		},
	};
}
