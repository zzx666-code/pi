import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type CustomerServiceTool, textResult, withRecoveryHint } from "./shared.ts";

const getInventorySchema = Type.Object({
	sku: Type.String({ minLength: 1 }),
	region: Type.String({ minLength: 1 }),
});

export const getInventoryToolSystemPromptContribution = {
	snippet: "查询指定 SKU 在指定地区的实时可售库存",
	guidelines: ["库存必须调用 get_inventory 查询，并带上用户要买的 SKU 和收货地区；不得承诺库存锁定。"],
} as const;

export function createGetInventoryTool(
	commerce: CommerceGateway,
): CustomerServiceTool<typeof getInventorySchema, { sku: string; region: string }> {
	return {
		name: "get_inventory",
		label: "查询库存",
		description: "查询指定 SKU 在指定地区的实时可售库存。",
		promptSnippet: getInventoryToolSystemPromptContribution.snippet,
		promptGuidelines: [...getInventoryToolSystemPromptContribution.guidelines],
		parameters: getInventorySchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const inventory = await withRecoveryHint(() => commerce.getInventory(params.sku, params.region));
			return textResult(JSON.stringify(inventory), { sku: params.sku, region: params.region });
		},
	};
}
