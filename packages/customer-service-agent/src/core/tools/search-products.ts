import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { textResult, withRecoveryHint } from "./shared.ts";

const searchProductsSchema = Type.Object({ query: Type.String({ minLength: 1 }) });

export function createSearchProductsTool(
	commerce: CommerceGateway,
): AgentTool<typeof searchProductsSchema, { count: number }> {
	return {
		name: "search_products",
		label: "搜索商品",
		description: "根据用户描述搜索可购买的商品。返回价格单位为分。",
		parameters: searchProductsSchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const products = await withRecoveryHint(() => commerce.searchProducts(params.query));
			return textResult(JSON.stringify(products), { count: products.length });
		},
	};
}
