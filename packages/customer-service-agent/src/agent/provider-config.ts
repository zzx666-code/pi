import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Credentials shared with the pi coding agent.
 *
 * The coding agent owns `models.json` (its `ModelConfig` parses the full schema) and
 * pi-ai itself never reads that file, so this module re-reads it for the subset the
 * customer service agent needs. One credential setup then serves both programs.
 */
export interface ProviderCredentials {
	baseUrl: string;
	apiKey: string;
}

/** Only this wire protocol is wired up; any other value means models.json asks for something unsupported. */
const SUPPORTED_API = "openai-completions";

export function agentConfigDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override.replace(/^~(?=$|[\\/])/, homedir());
	return join(homedir(), ".pi", "agent");
}

export function modelsConfigPath(): string {
	return join(agentConfigDir(), "models.json");
}

/**
 * Returns the configured credentials for `providerId`, or `undefined` when models.json
 * or the provider entry is absent. Malformed entries throw so the failure is loud
 * instead of surfacing later as a 401 from the model API.
 */
export async function loadProviderCredentials(providerId: string): Promise<ProviderCredentials | undefined> {
	const path = modelsConfigPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(`Unable to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const providers = asRecord(asRecord(parsed)?.providers);
	const entry = providers ? asRecord(providers[providerId]) : undefined;
	if (!entry) return undefined;

	const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
	const apiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
	if (!baseUrl || !apiKey) {
		throw new Error(`Provider "${providerId}" in ${path} must define a non-empty baseUrl and apiKey`);
	}
	if (typeof entry.api === "string" && entry.api !== SUPPORTED_API) {
		throw new Error(`Provider "${providerId}" in ${path} requests unsupported api "${entry.api}"`);
	}
	return { baseUrl, apiKey };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
