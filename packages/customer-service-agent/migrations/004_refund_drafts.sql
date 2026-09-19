-- 退款申请的确认门禁：把「模型提议」和「客户确认」分成两个动作。
--
-- 在此之前，模型调用 request_refund 就直接写入了 refund_requests，唯一的约束是系统提示词
-- 里那句「调用前必须与用户确认」。提示词是请求，不是机制：客户只是在聊天里问「这耳机能退吗」
-- 时，申请就可能已经落库，而撤销要靠客户自己发现。
--
-- 订单早就是这个形状了：模型只能写 order_drafts，真正的提交接口要求客户 JWT。这张表让退款
-- 与订单对齐 —— 草稿由模型写，正式申请只能由客户在界面上确认后产生。
--
-- 草稿故意不占用订单：占用订单的是 refund_requests.active_order_id 那个唯一索引，而草稿还没
-- 申请，不该挡住客户提交或撤销。所以这里不加生成列，只用一个普通索引支持按订单查草稿。

CREATE TABLE IF NOT EXISTS refund_drafts (
	id CHAR(36) PRIMARY KEY,
	order_id CHAR(36) NOT NULL,
	user_id VARCHAR(64) NOT NULL,
	reason VARCHAR(500) NULL,
	amount_cents INT UNSIGNED NOT NULL,
	status ENUM('awaiting_confirmation', 'submitted') NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	INDEX idx_refund_drafts_order (order_id, status),
	CONSTRAINT fk_refund_drafts_order FOREIGN KEY (order_id) REFERENCES orders (id),
	CONSTRAINT fk_refund_drafts_user FOREIGN KEY (user_id) REFERENCES users (id)
);
