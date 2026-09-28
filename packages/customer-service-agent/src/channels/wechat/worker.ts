import { loadConfig } from "../../config.ts";
import { createMysqlPool } from "../../db/mysql.ts";
import { loadWechatCredentials, loadWechatWorkerConfig } from "./config.ts";
import { WechatAgentHttpGateway } from "./http-gateway.ts";
import { getWechatUpdates, sendWechatText, WechatIlinkError, wechatMessageId, wechatMessageText } from "./ilink.ts";
import { MySqlWechatChannelStore } from "./mysql-store.ts";
import { runWechatOutboxLoop } from "./outbox-loop.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const appConfig = loadConfig();
const workerConfig = loadWechatWorkerConfig();
const credentials = await loadWechatCredentials(workerConfig.credentialsPath);
const allowedUserIds = new Set(
	workerConfig.allowedUserIds.length > 0
		? workerConfig.allowedUserIds
		: credentials.ownerUserId
			? [credentials.ownerUserId]
			: [],
);
if (allowedUserIds.size === 0) {
	throw new Error("No WeChat user is allowed. Set WECHAT_ALLOWED_USER_IDS before starting the bridge.");
}

const pool = createMysqlPool(appConfig.mysqlUrl);
const store = new MySqlWechatChannelStore(pool);
const agent = new WechatAgentHttpGateway(workerConfig.agentBaseUrl, workerConfig.channelToken);
const abort = new AbortController();
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		shuttingDown = true;
		abort.abort();
	});
}

async function drainOutbox(): Promise<number> {
	const messages = await store.claimOutbox(20);
	for (const message of messages) {
		try {
			for (let offset = 0; offset < message.content.length; offset += workerConfig.maxMessageLength) {
				await sendWechatText(
					credentials,
					message.externalUserId,
					message.contextToken,
					message.content.slice(offset, offset + workerConfig.maxMessageLength),
				);
			}
			await store.markOutboxSent(message.id);
		} catch (error) {
			await store.markOutboxFailed(message.id, error instanceof Error ? error.message : String(error));
			console.error(`[wechat] reply delivery failed id=${message.id}:`, error);
		}
	}
	return messages.length;
}

console.log(`[wechat] bridge started account=${credentials.botId} allowedUsers=${allowedUserIds.size}`);

async function runInboundLoop(): Promise<void> {
	let cursor = await store.getSyncCursor(credentials.botId);
	while (!shuttingDown) {
		try {
			const updates = await getWechatUpdates(credentials, cursor, abort.signal);
			for (const message of updates.msgs ?? []) {
				if (message.message_type !== 1 || (message.message_state !== undefined && message.message_state !== 2))
					continue;
				const externalUserId = message.from_user_id;
				const externalMessageId = wechatMessageId(message);
				const contextToken = message.context_token;
				if (!externalUserId || !externalMessageId || !contextToken || !allowedUserIds.has(externalUserId)) continue;
				const text = wechatMessageText(message);
				if (!text) {
					await sendWechatText(
						credentials,
						externalUserId,
						contextToken,
						"当前版本先支持微信文字消息，图片、语音和文件将在后续版本接入。",
					);
					continue;
				}
				await agent.handleInbound({ externalUserId, externalMessageId, contextToken, text });
			}
			if (updates.get_updates_buf) {
				cursor = updates.get_updates_buf;
				await store.saveSyncCursor(credentials.botId, cursor);
			}
			await drainOutbox();
		} catch (error) {
			if (shuttingDown) break;
			console.error("[wechat] polling failed:", error);
			await sleep(error instanceof WechatIlinkError && error.code === -14 ? 60_000 : 3_000);
		}
	}
}

try {
	await Promise.all([
		runInboundLoop(),
		runWechatOutboxLoop({
			signal: abort.signal,
			drain: drainOutbox,
			onError(error) {
				console.error("[wechat] outbox delivery loop failed:", error);
			},
		}),
	]);
} finally {
	await pool.end();
}
