import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { CommerceHttpError } from "../../agent/gateways.ts";

/** Trusted identity injected by the Agent API. The model cannot set or override these values. */
export interface ToolRequestContext {
	userId: string;
	conversationId: string;
}

/**
 * A tool that carries its own system-prompt contribution.
 *
 * Same shape as coding-agent's `ToolDefinition`: the prompt text lives next to the schema
 * that defines the tool, so a tool that is not active also contributes no rules to the
 * prompt. Nothing in the runtime reads these fields; the prompt builder does.
 */
export interface CustomerServiceTool<TParameters extends TSchema = TSchema, TDetails = unknown>
	extends AgentTool<TParameters, TDetails> {
	/** One line for the "可用工具" section. Tools without a snippet are not listed. */
	promptSnippet?: string;
	/**
	 * Bullets appended to the "守则" section while this tool is active.
	 *
	 * The bullets are appended flat, with no tool-name prefix, so each bullet must name the
	 * tool it refers to — "不要用同一个编号重试" is ambiguous, "不要拿 draftId 当订单号查询" is not.
	 */
	promptGuidelines?: readonly string[];
}

export function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Hand the model a pre-formatted local time instead of making it do timezone arithmetic. */
export function toBeijingTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const local = new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString();
	return `${local.slice(0, 16).replace("T", " ")}（北京时间）`;
}

/**
 * What the model should do next, per business rejection code.
 *
 * The message alone says what went wrong but not how to recover, and the two obvious wrong moves
 * are to retry the identical call or to invent an explanation. Each hint names the specific next
 * action, including when the answer is "stop and hand off".
 */
const NEXT_STEPS: Record<string, string> = {
	NOT_FOUND:
		"编号不存在或不属于当前客户。先按对象核对来源：订单和退款单用 list_orders / list_refund_requests 查客户本人的记录，商品用 search_products 重新确认；不要用同一个编号重试。",
	FORBIDDEN:
		"这属于其他客户的数据，不要重试。按“无权访问或不存在”的统一口径回复，不要说明该记录是否存在，也不要再换编号试探。",
	INSUFFICIENT_INVENTORY:
		"库存不足。把可售数量如实告诉客户，请其减少数量或更换地区后重新确认；不要重复提交同一个数量。",
	DRAFT_NOT_CONFIRMED:
		"订单草稿尚未确认。提醒客户在聊天记录里的订单确认卡片上点击后才会正式下单；不要重复调用下单相关工具。",
	INVALID_INPUT: "参数不合法。按提示补齐或修正字段后重新调用；缺哪个字段就向客户问哪个字段，不要自行编造。",
	TICKET_NOT_ASSIGNED: "工单尚未被认领，无法回复。这是坐席侧的操作，不要重试。",
	TICKET_NOT_OPEN: "工单已被认领或关闭。不要重试，先重新查询工单当前状态再决定下一步。",
};

const DEFAULT_NEXT_STEP =
	"这是业务系统的拒绝。不要用同样的参数重试；如实说明原因，无法在工具范围内解决时调用 handoff_to_human 转人工。";

/**
 * Rethrows a business rejection with its code and a recovery hint folded into the message.
 *
 * The runtime reduces a thrown error to `message` before handing it to the model, so anything the
 * model needs has to be inside that string: the code that says which rule refused, and the hint
 * that says what to do about it. Without them the model reads "Only 1 units are available" and
 * has to guess between retrying, changing the request, or handing off.
 *
 * Only {@link CommerceHttpError} is rewritten. Anything else — a dead socket, a timeout — keeps
 * its original shape so the runtime still reports a genuine malfunction rather than a business
 * answer the customer could act on.
 */
export async function withRecoveryHint<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (!(error instanceof CommerceHttpError)) throw error;
		const nextStep = NEXT_STEPS[error.code] ?? DEFAULT_NEXT_STEP;
		throw new CommerceHttpError(
			error.status,
			error.code,
			`${error.message}｜代码：${error.code}｜下一步：${nextStep}`,
		);
	}
}
