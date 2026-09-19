/**
 * 人工工单的状态机。
 *
 *   open ──► assigned ──► closed
 *
 * - `open`：客户已转人工，等待坐席认领。
 * - `assigned`：某位坐席已认领，会话进入人工接管，机器人停止回答。
 * - `closed`：处理完毕，会话交还机器人。
 *
 * 与退款申请不同，工单没有分支和终态回退：关闭即结束，需要再服务就新建一张工单。
 * 状态名同时用于 MySQL ENUM、HTTP 接口和工具返回值，所以业务库里的值可以原样传给模型。
 */
export const ALL_SUPPORT_TICKET_STATUSES = ["open", "assigned", "closed"] as const;

export type SupportTicketStatus = (typeof ALL_SUPPORT_TICKET_STATUSES)[number];

export function isSupportTicketStatus(value: unknown): value is SupportTicketStatus {
	return typeof value === "string" && (ALL_SUPPORT_TICKET_STATUSES as readonly string[]).includes(value);
}

/** 展示给客户和坐席的状态文字；模型只能原样转述，不得自己发明说法。 */
export const SUPPORT_TICKET_STATUS_LABELS: Record<SupportTicketStatus, string> = {
	open: "待人工认领",
	assigned: "人工处理中",
	closed: "已关闭",
};
