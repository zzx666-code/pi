import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type ToolRequestContext, textResult } from "./shared.ts";

const createDraftSchema = Type.Object({
	region: Type.String({ minLength: 1 }),
	items: Type.Array(
		Type.Object({
			sku: Type.String({ minLength: 1 }),
			quantity: Type.Integer({ minimum: 1, maximum: 99 }),
		}),
		{ minItems: 1, maxItems: 20 },
	),
});

export function createCreateOrderDraftTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): AgentTool<typeof createDraftSchema, { draftId: string; requiresConfirmation: true; conversationId: string }> {
	return {
		name: "create_order_draft",
		label: "创建订单草稿",
		description:
			"根据 SKU 和数量创建订单草稿。此工具不会正式下单，必须由用户在界面中明确确认。返回的 draftId 是草稿号，不是订单号；正式订单号由用户确认下单时生成。",
		parameters: createDraftSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const draft = await commerce.createOrderDraft(context.userId, params.region, params.items);
			return textResult(
				JSON.stringify({
					draftId: draft.id,
					status: draft.status,
					region: params.region,
					items: draft.items,
					totalCents: draft.totalCents,
					requiresConfirmation: true,
				}),
				{ draftId: draft.id, requiresConfirmation: true, conversationId: context.conversationId },
			);
		},
	};
}
