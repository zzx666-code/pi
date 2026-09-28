-- 微信渠道只负责传输消息。客户身份、Pi 会话、确认动作和可靠回信都由服务端保存，
-- 不把微信 context_token 当成业务会话，也不允许桥接进程自行声明 user_id。

CREATE TABLE IF NOT EXISTS channel_identities (
	channel VARCHAR(32) NOT NULL,
	external_user_id VARCHAR(255) NOT NULL,
	user_id VARCHAR(64) NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	PRIMARY KEY (channel, external_user_id),
	CONSTRAINT fk_channel_identity_user FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS channel_conversations (
	channel VARCHAR(32) NOT NULL,
	external_user_id VARCHAR(255) NOT NULL,
	conversation_id CHAR(36) NOT NULL,
	context_token TEXT NOT NULL,
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	PRIMARY KEY (channel, external_user_id),
	INDEX idx_channel_conversation (conversation_id),
	CONSTRAINT fk_channel_conversation_identity
		FOREIGN KEY (channel, external_user_id) REFERENCES channel_identities (channel, external_user_id),
	CONSTRAINT fk_channel_conversation_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE TABLE IF NOT EXISTS channel_inbound_messages (
	channel VARCHAR(32) NOT NULL,
	external_message_id VARCHAR(255) NOT NULL,
	external_user_id VARCHAR(255) NOT NULL,
	context_token TEXT NOT NULL,
	conversation_id CHAR(36) NULL,
	status ENUM('processing', 'completed') NOT NULL,
	response_text TEXT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	completed_at TIMESTAMP(3) NULL,
	PRIMARY KEY (channel, external_message_id),
	INDEX idx_channel_inbound_user (channel, external_user_id, created_at),
	CONSTRAINT fk_channel_inbound_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE TABLE IF NOT EXISTS channel_pending_actions (
	code CHAR(6) PRIMARY KEY,
	channel VARCHAR(32) NOT NULL,
	external_user_id VARCHAR(255) NOT NULL,
	user_id VARCHAR(64) NOT NULL,
	conversation_id CHAR(36) NOT NULL,
	action_type ENUM('confirm_order', 'confirm_refund') NOT NULL,
	resource_id CHAR(36) NOT NULL,
	status ENUM('pending', 'completed') NOT NULL DEFAULT 'pending',
	expires_at TIMESTAMP(3) NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	completed_at TIMESTAMP(3) NULL,
	UNIQUE KEY uk_channel_pending_resource (channel, external_user_id, action_type, resource_id),
	INDEX idx_channel_pending_lookup (channel, external_user_id, code, status, expires_at),
	CONSTRAINT fk_channel_pending_user FOREIGN KEY (user_id) REFERENCES users (id),
	CONSTRAINT fk_channel_pending_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE TABLE IF NOT EXISTS channel_outbox (
	id CHAR(36) PRIMARY KEY,
	channel VARCHAR(32) NOT NULL,
	external_user_id VARCHAR(255) NOT NULL,
	conversation_id CHAR(36) NULL,
	context_token TEXT NOT NULL,
	content TEXT NOT NULL,
	status ENUM('pending', 'sending', 'sent') NOT NULL DEFAULT 'pending',
	attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
	available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	last_error VARCHAR(500) NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	sent_at TIMESTAMP(3) NULL,
	INDEX idx_channel_outbox_delivery (channel, status, available_at, created_at),
	CONSTRAINT fk_channel_outbox_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE TABLE IF NOT EXISTS wechat_sync_state (
	account_id VARCHAR(255) PRIMARY KEY,
	get_updates_buf MEDIUMTEXT NOT NULL,
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
