-- 一个会话最多只有一张未关闭的工单。
--
-- 在此之前 handoff_to_human 的 replay 是 never：同一个会话里模型多转一次人工就多一张工单，
-- 坐席队列里于是出现同一客户的重复条目，谁先认领也不确定。唯一约束把"这个会话已经有人管了"
-- 变成数据库事实，而不是应用层的一次查询——后者在并发下必然漏。
--
-- 写法与 refund_requests.active_order_id 同源：用生成列把"活跃"的定义交给数据库。工单关闭
-- 后生成列变 NULL 自动让出名额，客户之后重新转人工可以建新工单；conversation_id 为 NULL 的
-- 老工单不受约束（MySQL 的唯一索引视多个 NULL 为互不相同），所以 002 之前的数据不受影响。
--
-- 这里必须用 VIRTUAL，不能照抄 refund_requests 的 STORED：conversation_id 上有一个
-- ON DELETE SET NULL 外键，而 MySQL 禁止在「带 SET NULL / CASCADE 外键的列」之上建立存储
-- 生成列，加列时会直接报 ER_CANNOT_ADD_FOREIGN。虚拟生成列没有这个限制，唯一索引的仲裁
-- 效果完全相同，而且不占存储。（这条限制是实测出来的：STORED 版本在此库上迁移失败。）
--
-- 幂等性与 002/003/004 同理：MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，
-- 由 schema_migrations 版本表保证这个文件只执行一次。

ALTER TABLE support_tickets
	ADD COLUMN active_conversation_id CHAR(36)
		GENERATED ALWAYS AS (CASE WHEN status <> 'closed' THEN conversation_id ELSE NULL END) VIRTUAL
		AFTER conversation_id,
	ADD UNIQUE KEY uk_support_tickets_active_conversation (active_conversation_id);
