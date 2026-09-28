import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WechatCredentials } from "./ilink.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface WechatWorkerConfig {
	credentialsPath: string;
	agentBaseUrl: string;
	channelToken: string;
	allowedUserIds: string[];
	maxMessageLength: number;
}

function positiveInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

export function loadWechatWorkerConfig(): WechatWorkerConfig {
	return {
		credentialsPath: resolve(
			process.env.WECHAT_CREDENTIALS_PATH ?? resolve(PACKAGE_ROOT, ".wechat/credentials.json"),
		),
		agentBaseUrl: (process.env.WECHAT_AGENT_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, ""),
		channelToken:
			process.env.CHANNEL_INTERNAL_TOKEN ?? process.env.COMMERCE_INTERNAL_TOKEN ?? "change-me-for-production",
		allowedUserIds: (process.env.WECHAT_ALLOWED_USER_IDS ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
		maxMessageLength: positiveInteger("WECHAT_MAX_MESSAGE_LENGTH", 1800),
	};
}

export async function loadWechatCredentials(path: string): Promise<WechatCredentials> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(
			`Unable to read WeChat credentials at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object") throw new Error("Invalid WeChat credentials");
	const record = parsed as Record<string, unknown>;
	if (
		typeof record.botToken !== "string" ||
		typeof record.botId !== "string" ||
		typeof record.baseUrl !== "string" ||
		typeof record.createdAt !== "string"
	) {
		throw new Error("Invalid WeChat credentials");
	}
	return {
		botToken: record.botToken,
		botId: record.botId,
		baseUrl: record.baseUrl,
		ownerUserId: typeof record.ownerUserId === "string" ? record.ownerUserId : undefined,
		createdAt: record.createdAt,
	};
}
