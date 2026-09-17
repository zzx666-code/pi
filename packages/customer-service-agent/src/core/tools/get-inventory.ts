import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { textResult } from "./shared.ts";

const getInventorySchema = Type.Object({
	sku: Type.String({ minLength: 1 }),
	region: Type.String({ minLength: 1 }),
});

export function createGetInventoryTool(
	commerce: CommerceGateway,
): AgentTool<typeof getInventorySchema, { sku: string; region: string }> {
	return {
		name: "get_inventory",
		label: "查询库存",
		description: "查询指定 SKU 在指定地区的实时可售库存。",
		parameters: getInventorySchema,
		replay: "safe",
		async execute(_toolCallId, params) {
			const inventory = await commerce.getInventory(params.sku, params.region);
			return textResult(JSON.stringify(inventory), { sku: params.sku, region: params.region });
		},
	};
}
