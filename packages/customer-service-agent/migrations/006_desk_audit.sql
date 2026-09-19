-- 坐席操作审计：谁、在什么时候、对哪张工单做了什么，结果如何。
--
-- 在此之前只有 tool_audit_logs，记录的是模型的工具调用。坐席的认领、回复和关闭完全不留痕，
-- 于是 ROADMAP 里「坐席操作有审计」这条验收一直没满足——工单被别人关掉时无法回答是谁关的。
--
-- 与 tool_audit_logs 同构：先写一条 started，动作结束后再写一条终态。先写意图是刻意的——
-- 如果进程在动作中途消失，仍然留下了「有人开始做这件事」的证据；而如果第一条都写不进去，
-- 这个动作根本不会发生（fail-closed）。差别只在于主体是坐席工号而不是工具调用 id。
--
-- conversation_id 和 user_id 允许为 NULL 的原因有两个：002 之前的老工单没有关联会话，但它们
-- 同样可以被认领和关闭，审计不能因为这些工单就丢记录；另外 started 那条只知道路由收到的
-- ticketId，客户与会话要等动作返回工单后才能填上。
--
-- assignee 也允许为 NULL，这不是疏漏：坐席接口用的是共享内部令牌，没有独立坐席身份（见 T9），
-- 因此「回复一张没人认领的工单」这种被拒绝的尝试，系统根本无法说出是谁做的。把工号写成占位符
-- 会伪造归属，留空才是事实。
--
-- 故意不加外键：审计行要比它描述的对象活得久，工单或会话被清理后记录仍应可查。
-- 这也是 tool_audit_logs 的做法。
--
-- 幂等性与 002~005 同理：由 schema_migrations 版本表保证这个文件只执行一次。

CREATE TABLE IF NOT EXISTS desk_audit_logs (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	ticket_id CHAR(36) NOT NULL,
	conversation_id CHAR(36) NULL,
	user_id VARCHAR(64) NULL,
	assignee VARCHAR(64) NULL,
	action ENUM('claim', 'reply', 'close') NOT NULL,
	status ENUM('started', 'succeeded', 'rejected') NOT NULL,
	request_json JSON NULL,
	error_code VARCHAR(64) NULL,
	duration_ms INT UNSIGNED NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	INDEX idx_desk_audit_ticket (ticket_id, created_at),
	INDEX idx_desk_audit_customer (user_id, created_at),
	INDEX idx_desk_audit_assignee (assignee, created_at)
);
