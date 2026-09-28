import { randomBytes, randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "0.1.0";
const APP_ID = "bot";
const APP_CLIENT_VERSION = (0 << 24) | (1 << 16) | (0 << 8);
const API_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;

export interface WechatCredentials {
	botToken: string;
	botId: string;
	baseUrl: string;
	ownerUserId?: string;
	createdAt: string;
}

export interface WechatMessageItem {
	type?: number;
	text_item?: { text?: string };
}

export interface WechatMessage {
	seq?: number;
	message_id?: string | number;
	client_id?: string;
	from_user_id?: string;
	message_type?: number;
	message_state?: number;
	create_time_ms?: number;
	context_token?: string;
	item_list?: WechatMessageItem[];
}

export interface WechatUpdates {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	msgs?: WechatMessage[];
	get_updates_buf?: string;
	longpolling_timeout_ms?: number;
}

export interface WechatQrCode {
	qrcode: string;
	qrcode_img_content: string;
}

export interface WechatQrStatus {
	status:
		| "wait"
		| "scaned"
		| "confirmed"
		| "expired"
		| "scaned_but_redirect"
		| "need_verifycode"
		| "verify_code_blocked"
		| "binded_redirect";
	bot_token?: string;
	ilink_bot_id?: string;
	baseurl?: string;
	ilink_user_id?: string;
	redirect_host?: string;
}

export class WechatIlinkError extends Error {
	readonly code: number | undefined;

	constructor(message: string, code?: number) {
		super(message);
		this.name = "WechatIlinkError";
		this.code = code;
	}
}

function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function commonHeaders(): Record<string, string> {
	return {
		"iLink-App-Id": APP_ID,
		"iLink-App-ClientVersion": String(APP_CLIENT_VERSION),
	};
}

function postHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
		...commonHeaders(),
	};
	if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
	return headers;
}

function baseInfo(): { channel_version: string; bot_agent: string } {
	return { channel_version: CHANNEL_VERSION, bot_agent: `PiCustomerService/${CHANNEL_VERSION}` };
}

async function requestText(options: {
	baseUrl: string;
	endpoint: string;
	method: "GET" | "POST";
	token?: string;
	body?: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<string> {
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const response = await fetch(new URL(options.endpoint, ensureTrailingSlash(options.baseUrl)), {
		method: options.method,
		headers: options.method === "POST" ? postHeaders(options.token) : commonHeaders(),
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal,
	});
	if (!response.ok) throw new WechatIlinkError(`WeChat iLink HTTP ${response.status}`);
	return await response.text();
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

export async function fetchWechatQrCode(): Promise<WechatQrCode> {
	return parseJson<WechatQrCode>(
		await requestText({
			baseUrl: DEFAULT_BASE_URL,
			endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
			method: "POST",
			body: { local_token_list: [] },
			timeoutMs: API_TIMEOUT_MS,
		}),
	);
}

export async function pollWechatQrStatus(
	qrcode: string,
	baseUrl = DEFAULT_BASE_URL,
	verifyCode?: string,
): Promise<WechatQrStatus> {
	const params = new URLSearchParams({ qrcode });
	if (verifyCode) params.set("verify_code", verifyCode);
	try {
		return parseJson<WechatQrStatus>(
			await requestText({
				baseUrl,
				endpoint: `ilink/bot/get_qrcode_status?${params.toString()}`,
				method: "GET",
				timeoutMs: LONG_POLL_TIMEOUT_MS,
			}),
		);
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			return { status: "wait" };
		}
		throw error;
	}
}

export async function getWechatUpdates(
	credentials: WechatCredentials,
	cursor: string,
	signal?: AbortSignal,
): Promise<WechatUpdates> {
	try {
		const response = parseJson<WechatUpdates>(
			await requestText({
				baseUrl: credentials.baseUrl,
				endpoint: "ilink/bot/getupdates",
				method: "POST",
				token: credentials.botToken,
				body: { get_updates_buf: cursor, base_info: baseInfo() },
				timeoutMs: LONG_POLL_TIMEOUT_MS,
				signal,
			}),
		);
		const code = response.ret && response.ret !== 0 ? response.ret : response.errcode;
		if (code && code !== 0) throw new WechatIlinkError(response.errmsg ?? `WeChat iLink error ${code}`, code);
		return response;
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			if (signal?.aborted) throw error;
			return { ret: 0, msgs: [] };
		}
		throw error;
	}
}

export async function sendWechatText(
	credentials: WechatCredentials,
	externalUserId: string,
	contextToken: string,
	text: string,
): Promise<void> {
	const response = parseJson<{ ret?: number; errcode?: number; errmsg?: string }>(
		await requestText({
			baseUrl: credentials.baseUrl,
			endpoint: "ilink/bot/sendmessage",
			method: "POST",
			token: credentials.botToken,
			body: {
				msg: {
					from_user_id: "",
					to_user_id: externalUserId,
					client_id: `pi-customer-service-${randomUUID()}`,
					message_type: 2,
					message_state: 2,
					context_token: contextToken,
					item_list: [{ type: 1, text_item: { text } }],
				},
				base_info: baseInfo(),
			},
			timeoutMs: API_TIMEOUT_MS,
		}),
	);
	const code = response.ret && response.ret !== 0 ? response.ret : response.errcode;
	if (code && code !== 0) throw new WechatIlinkError(response.errmsg ?? `WeChat send error ${code}`, code);
}

export function wechatMessageText(message: WechatMessage): string {
	return (message.item_list ?? [])
		.filter((item) => item.type === 1 && typeof item.text_item?.text === "string")
		.map((item) => item.text_item?.text?.trim() ?? "")
		.filter(Boolean)
		.join("\n");
}

export function wechatMessageId(message: WechatMessage): string | undefined {
	const value = message.message_id ?? message.client_id ?? message.seq;
	return value === undefined ? undefined : String(value);
}
