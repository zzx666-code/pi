import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type CustomerServiceTool, textResult, withRecoveryHint } from "./shared.ts";

const searchProductsSchema = Type.Object({ query: Type.String({ minLength: 1 }) });

export const searchProductsToolSystemPromptContribution = {
	snippet: "根据用户描述搜索可购买的商品，返回价格单位为分",
	guidelines: ["商品名称、价格和规格必须调用 search_products 查询，不得猜测；search_products 返回的价格单位是分。"],
} as const;

export function createSearchProductsTool(
	commerce: CommerceGateway,
): CustomerServiceTool<typeof searchProductsSchema, { count: number }> {
	return {
		name: "search_products",
		label: "搜索商品",
		description: "根据用户描述搜索可购买的商品。返回价格单位为分。",
		promptSnippet: searchProductsToolSystemPromptContribution.snippet,
		promptGuidelines: [...searchProductsToolSystemPromptContribution.guidelines],
		parameters: searchProductsSchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const products = await withRecoveryHint(() => commerce.searchProducts(params.query));
			return textResult(JSON.stringify(products), { count: products.length });
		},
	};
}
