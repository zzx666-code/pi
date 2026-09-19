-- 把工单与其来源会话关联起来，并补齐坐席处理工单所需的字段。
--
-- 001 是幂等基线：它用 CREATE TABLE IF NOT EXISTS 建出的 support_tickets 没有这些列。
-- MySQL 8 不支持 ALTER TABLE ... ADD COLUMN IF NOT EXISTS，所以这个文件的幂等性由
-- schema_migrations 版本表保证 —— 它只会被执行一次。

ALTER TABLE support_tickets
	ADD COLUMN conversation_id CHAR(36) NULL AFTER user_id,
	ADD COLUMN assignee VARCHAR(64) NULL AFTER status,
	ADD COLUMN claimed_at TIMESTAMP(3) NULL AFTER assignee,
	ADD COLUMN closed_at TIMESTAMP(3) NULL AFTER claimed_at,
	ADD COLUMN close_note VARCHAR(500) NULL AFTER closed_at,
	ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER close_note,
	ADD INDEX idx_support_tickets_status (status, created_at),
	ADD INDEX idx_support_tickets_conversation (conversation_id, status),
	ADD CONSTRAINT fk_support_tickets_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
