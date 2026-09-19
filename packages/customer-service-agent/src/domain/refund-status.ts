/**
 * 退款申请的状态机。
 *
 * 状态名同时用于 MySQL ENUM、HTTP 接口和 Agent 工具返回值，所以业务库里的值可以原样传到
 * 模型，不需要翻译。终态只能被替换（客户重新提交一条新申请），不能被改回中间状态。
 *
 *   pending_review ──► handed_off ──► approved ──► refunded
 *          └──────────────┴──────────────┴────────► rejected
 *          └──────────────┴                          └───► failed
 *                  └─────────────────────────────────► cancelled
 *
 * 说明三点：
 * - “申请成功”是一次事件而不是状态：它把申请推进到 `pending_review`（待处理）。
 * - `approved` 和 `refunded` 分开，是因为“审核通过”和“钱真的退到账”是两件事，
 *   中间支付渠道仍可能失败，于是落到 `failed`。
 * - `cancelled` 是客户自己撤回申请，只能从还没有开始打款的状态（`pending_review`、
 *   `handed_off`）进入。`approved` 之后钱已经在路上，撤回需要与支付侧协调，不属于客服系统。
 */

export const ALL_REFUND_STATUSES = [
	"pending_review",
	"handed_off",
	"approved",
	"refunded",
	"rejected",
	"failed",
	"cancelled",
] as const;

export type RefundStatus = (typeof ALL_REFUND_STATUSES)[number];

/** 到达这些状态的申请已经结束，只能重新申请，不能继续流转。 */
export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = ["refunded", "rejected", "failed", "cancelled"];

/**
 * 处于这些状态的申请仍然占用该订单，重复提交会返回同一条记录，而不是新建一条。
 * 必须与 migrations/001_initial.sql 中生成列 `active_order_id` 的条件保持一致。
 */
export const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = ALL_REFUND_STATUSES.filter(
	(status) => !TERMINAL_REFUND_STATUSES.includes(status),
);

/** 展示给客户看的状态文字；模型只能原样转述，不得自己发明说法。 */
export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
	pending_review: "待处理",
	handed_off: "已移交人工处理",
	approved: "已通过审核，等待退款执行",
	refunded: "退款成功",
	rejected: "审核未通过",
	failed: "退款执行失败",
	cancelled: "已撤销",
};

/** 允许的状态流转；未列出的组合一律拒绝。 */
const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
	pending_review: ["handed_off", "approved", "rejected", "cancelled"],
	handed_off: ["approved", "rejected", "cancelled"],
	approved: ["refunded", "failed"],
	refunded: [],
	rejected: [],
	failed: [],
	cancelled: [],
};

export function isRefundTransitionAllowed(from: RefundStatus, to: RefundStatus): boolean {
	return REFUND_TRANSITIONS[from].includes(to);
}

export function isRefundStatus(value: unknown): value is RefundStatus {
	return typeof value === "string" && (ALL_REFUND_STATUSES as readonly string[]).includes(value);
}
