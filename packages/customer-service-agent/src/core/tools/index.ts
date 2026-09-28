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
import type { CustomerServiceTool, ToolRequestContext } from "./shared.ts";

export type { CustomerServiceTool, ToolRequestContext };

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

/** Every tool for one turn, keyed by its runtime name. */
export type CustomerServiceToolSet = ReturnType<typeof createCustomerServiceTools>;

/** A tool name that actually exists in the set. */
export type CustomerServiceToolName = keyof CustomerServiceToolSet;

/** The union of all tool types, so a subset keeps a nameable type instead of widening to `any`. */
export type CustomerServiceToolOfSet = CustomerServiceToolSet[CustomerServiceToolName];

/** Every tool name, in the order createCustomerServiceTools() defines them. */
export function allCustomerServiceToolNames(tools: CustomerServiceToolSet): CustomerServiceToolName[] {
	return Object.keys(tools) as CustomerServiceToolName[];
}

/**
 * The active subset, in the order the names are given.
 *
 * Mirrors coding-agent's `setActiveToolsByName`: unknown names are ignored rather than
 * rejected. A tool that is not selected is invisible to the model *and* contributes no
 * rules to the prompt, so the two can never disagree.
 */
export function selectCustomerServiceTools(
	tools: CustomerServiceToolSet,
	names: readonly CustomerServiceToolName[],
): CustomerServiceToolOfSet[] {
	const selected: CustomerServiceToolOfSet[] = [];
	for (const name of names) {
		const tool = tools[name];
		if (tool) {
			selected.push(tool);
		}
	}
	return selected;
}

/** Type guard used by callers that need to read a subset out of configuration. */
export function isCustomerServiceToolName(
	tools: CustomerServiceToolSet,
	name: string,
): name is CustomerServiceToolName {
	return Object.hasOwn(tools, name);
}
