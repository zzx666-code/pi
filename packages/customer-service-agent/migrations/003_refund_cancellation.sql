-- 允许客户撤回自己尚未开始打款的退款申请。
--
-- 与 002 同理：MySQL 8 没有修改 ENUM 的幂等写法，这个文件的幂等性由 schema_migrations
-- 版本表保证 —— 它只会被执行一次。
--
-- 为什么需要这个状态：active_order_id 唯一索引让一条非终态申请独占订单，所以客户误提交
-- 申请后会被挡住，直到人工驳回它才能重新申请。加上 cancelled 之后，撤销即释放订单。
-- cancelled 不在 active_order_id 生成列的条件里，因此不需要改动那个生成列。

ALTER TABLE refund_requests
	MODIFY COLUMN status ENUM(
		'pending_review',
		'handed_off',
		'approved',
		'refunded',
		'rejected',
		'failed',
		'cancelled'
	) NOT NULL;
