import { Type } from "typebox";
import type { CommerceGateway } from "../../agent/gateways.ts";
import { type CustomerServiceTool, type ToolRequestContext, textResult, withRecoveryHint } from "./shared.ts";

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

export const createOrderDraftToolSystemPromptContribution = {
	snippet: "创建订单草稿；不会正式下单，需要用户在界面上确认",
	guidelines: [
		"下单只能调用 create_order_draft 创建草稿。确认入口是聊天界面消息列表底部的“订单草稿等待确认”卡片上的按钮，不是独立页面；不要描述界面细节，只说明需要在该卡片上点击确认后才会正式提交。",
		"create_order_draft 返回的 draftId 是订单草稿号，不是订单号。正式订单号在用户于界面确认后才生成，不要拿 draftId 当订单号查询，也不要反复重试同一个查不到的编号。",
	],
} as const;

export function createCreateOrderDraftTool(
	context: ToolRequestContext,
	commerce: CommerceGateway,
): CustomerServiceTool<
	typeof createDraftSchema,
	{ draftId: string; requiresConfirmation: true; conversationId: string }
> {
	return {
		name: "create_order_draft",
		label: "创建订单草稿",
		description:
			"根据 SKU 和数量创建订单草稿。此工具不会正式下单，必须由用户在界面中明确确认。返回的 draftId 是草稿号，不是订单号；正式订单号由用户确认下单时生成。",
		promptSnippet: createOrderDraftToolSystemPromptContribution.snippet,
		promptGuidelines: [...createOrderDraftToolSystemPromptContribution.guidelines],
		parameters: createDraftSchema,
		replay: "never",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const draft = await withRecoveryHint(() =>
				commerce.createOrderDraft(context.userId, params.region, params.items),
			);
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
