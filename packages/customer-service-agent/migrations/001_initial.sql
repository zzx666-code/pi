SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
	id VARCHAR(64) PRIMARY KEY,
	name VARCHAR(120) NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS products (
	sku VARCHAR(80) PRIMARY KEY,
	name VARCHAR(200) NOT NULL,
	description TEXT NOT NULL,
	unit_price_cents INT UNSIGNED NOT NULL,
	active BOOLEAN NOT NULL DEFAULT TRUE,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS inventory (
	sku VARCHAR(80) NOT NULL,
	region VARCHAR(80) NOT NULL,
	available_quantity INT UNSIGNED NOT NULL,
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	PRIMARY KEY (sku, region),
	CONSTRAINT fk_inventory_product FOREIGN KEY (sku) REFERENCES products(sku)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
	id CHAR(64) PRIMARY KEY,
	source VARCHAR(255) NOT NULL,
	content TEXT NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	INDEX idx_knowledge_source (source)
);

CREATE TABLE IF NOT EXISTS order_drafts (
	id CHAR(36) PRIMARY KEY,
	user_id VARCHAR(64) NOT NULL,
	region VARCHAR(80) NOT NULL,
	total_cents INT UNSIGNED NOT NULL,
	status ENUM('awaiting_confirmation', 'confirmed', 'submitted', 'cancelled') NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	INDEX idx_order_drafts_user (user_id, created_at),
	CONSTRAINT fk_order_drafts_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS order_draft_items (
	draft_id CHAR(36) NOT NULL,
	sku VARCHAR(80) NOT NULL,
	product_name VARCHAR(200) NOT NULL,
	unit_price_cents INT UNSIGNED NOT NULL,
	quantity INT UNSIGNED NOT NULL,
	line_total_cents INT UNSIGNED NOT NULL,
	PRIMARY KEY (draft_id, sku),
	CONSTRAINT fk_draft_items_draft FOREIGN KEY (draft_id) REFERENCES order_drafts(id),
	CONSTRAINT fk_draft_items_product FOREIGN KEY (sku) REFERENCES products(sku)
);

CREATE TABLE IF NOT EXISTS orders (
	id CHAR(36) PRIMARY KEY,
	user_id VARCHAR(64) NOT NULL,
	draft_id CHAR(36) NOT NULL UNIQUE,
	idempotency_key VARCHAR(120) NOT NULL UNIQUE,
	region VARCHAR(80) NOT NULL,
	total_cents INT UNSIGNED NOT NULL,
	status ENUM('submitted', 'paid', 'cancelled') NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	INDEX idx_orders_user (user_id, created_at),
	CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
	CONSTRAINT fk_orders_draft FOREIGN KEY (draft_id) REFERENCES order_drafts(id)
);

CREATE TABLE IF NOT EXISTS order_items (
	order_id CHAR(36) NOT NULL,
	sku VARCHAR(80) NOT NULL,
	product_name VARCHAR(200) NOT NULL,
	unit_price_cents INT UNSIGNED NOT NULL,
	quantity INT UNSIGNED NOT NULL,
	line_total_cents INT UNSIGNED NOT NULL,
	PRIMARY KEY (order_id, sku),
	CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
	CONSTRAINT fk_order_items_product FOREIGN KEY (sku) REFERENCES products(sku)
);

-- 状态名必须与 src/domain/refund-status.ts 中的 ALL_REFUND_STATUSES 完全一致。
CREATE TABLE IF NOT EXISTS refund_requests (
	id CHAR(36) PRIMARY KEY,
	order_id CHAR(36) NOT NULL,
	user_id VARCHAR(64) NOT NULL,
	status ENUM('pending_review', 'handed_off', 'approved', 'refunded', 'rejected', 'failed') NOT NULL DEFAULT 'pending_review',
	amount_cents INT UNSIGNED NOT NULL,
	reason VARCHAR(500) NULL,
	order_created_at TIMESTAMP(3) NOT NULL,
	requested_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	last_transition_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	last_transition_by VARCHAR(64) NOT NULL,
	last_transition_note VARCHAR(500) NULL,
	-- 非终态才占用订单；该生成列的条件必须与 ACTIVE_REFUND_STATUSES 保持一致。
	active_order_id CHAR(36) GENERATED ALWAYS AS (CASE WHEN status IN ('pending_review', 'handed_off', 'approved') THEN order_id ELSE NULL END) STORED,
	UNIQUE KEY uk_refund_requests_active_order (active_order_id),
	INDEX idx_refund_requests_user (user_id, requested_at),
	INDEX idx_refund_requests_status (status, requested_at),
	CONSTRAINT fk_refund_requests_order FOREIGN KEY (order_id) REFERENCES orders(id),
	CONSTRAINT fk_refund_requests_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS support_tickets (
	id CHAR(36) PRIMARY KEY,
	user_id VARCHAR(64) NOT NULL,
	summary VARCHAR(500) NOT NULL,
	status ENUM('open', 'assigned', 'closed') NOT NULL DEFAULT 'open',
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT fk_support_tickets_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS conversations (
	id CHAR(36) PRIMARY KEY,
	user_id VARCHAR(64) NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT fk_conversations_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	conversation_id CHAR(36) NOT NULL,
	message_json JSON NOT NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	INDEX idx_messages_conversation (conversation_id, id),
	CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS tool_audit_logs (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	conversation_id CHAR(36) NOT NULL,
	user_id VARCHAR(64) NOT NULL,
	tool_name VARCHAR(120) NOT NULL,
	tool_call_id VARCHAR(160) NOT NULL,
	status ENUM('started', 'succeeded', 'failed', 'blocked') NOT NULL,
	request_json JSON NULL,
	result_json JSON NULL,
	duration_ms INT UNSIGNED NULL,
	created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	INDEX idx_tool_audit_conversation (conversation_id, created_at)
);

INSERT INTO users (id, name) VALUES ('user-1', '演示用户')
	ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO products (sku, name, description, unit_price_cents) VALUES
	('HEADPHONE-BLACK', '黑色降噪耳机', '头戴式主动降噪蓝牙耳机，黑色', 39900),
	('KEYBOARD-87', '87 键机械键盘', '三模连接机械键盘，支持热插拔', 52900),
	('MOUSE-WHITE', '白色无线鼠标', '轻量化无线鼠标，支持双设备切换', 19900)
	ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), unit_price_cents = VALUES(unit_price_cents);

INSERT INTO inventory (sku, region, available_quantity) VALUES
	('HEADPHONE-BLACK', '北京', 12),
	('HEADPHONE-BLACK', '上海', 8),
	('KEYBOARD-87', '北京', 5),
	('MOUSE-WHITE', '北京', 20)
	ON DUPLICATE KEY UPDATE available_quantity = available_quantity;
