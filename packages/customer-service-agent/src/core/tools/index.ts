import type { CommerceGateway, KnowledgeGateway } from "../../agent/gateways.ts";
import { createCancelRefundRequestTool } from "./cancel-refund-request.ts";
import { createCreateOrderDraftTool } from "./create-order-draft.ts";
import { createCreateRefundDraftTool } from "./create-refund-draft.ts";
import { createGetInventoryTool } from "./get-inventory.ts";
import { createGetOrderTool } from "./get-order.ts";
import { createHandoffToHumanTool } from "./handoff-to-human.ts";
import { createListOrdersTool } from "./list-orders.ts";
import { createListRefundRequestsTool } from "./list-refund-requests.ts";
import { createSearchKnowledgeBaseTool } from "./search-knowledge-base.ts";
import { createSearchProductsTool } from "./search-products.ts";
import type { ToolRequestContext } from "./shared.ts";

export type { ToolRequestContext };

/**
 * Builds the tool set for one conversation turn.
 *
 * `context` carries the server-verified identity, so tool schemas never expose `userId`
 * and the model cannot query another user's data.
 */
export function createCustomerServiceTools(
	context: ToolRequestContext,
	commerce: CommerceGateway,
	knowledge: KnowledgeGateway,
) {
	return {
		search_products: createSearchProductsTool(commerce),
		get_inventory: createGetInventoryTool(commerce),
		list_orders: createListOrdersTool(context, commerce),
		get_order: createGetOrderTool(context, commerce),
		search_knowledge_base: createSearchKnowledgeBaseTool(knowledge),
		create_order_draft: createCreateOrderDraftTool(context, commerce),
		create_refund_draft: createCreateRefundDraftTool(context, commerce),
		cancel_refund_request: createCancelRefundRequestTool(context, commerce),
		list_refund_requests: createListRefundRequestsTool(context, commerce),
		handoff_to_human: createHandoffToHumanTool(context, commerce),
	};
}
