export interface AppConfig {
	agentPort: number;
	commercePort: number;
	commerceBaseUrl: string;
	commerceInternalToken: string;
	/** Token the support desk presents to the agent. Defaults to the internal token: same system, one secret. */
	deskToken: string;
	mysqlUrl: string;
	llmProvider: string;
	llmBaseUrl: string;
	llmApiKey: string;
	llmModel: string;
	authSecret: string;
	demoUserId: string;
}

function numberFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

export function loadConfig(): AppConfig {
	const commercePort = numberFromEnv("COMMERCE_PORT", 3101);
	const commerceInternalToken = process.env.COMMERCE_INTERNAL_TOKEN ?? "change-me-for-production";
	return {
		agentPort: numberFromEnv("AGENT_PORT", 3100),
		commercePort,
		commerceBaseUrl: process.env.COMMERCE_BASE_URL ?? `http://127.0.0.1:${commercePort}`,
		commerceInternalToken,
		deskToken: process.env.DESK_TOKEN ?? commerceInternalToken,
		mysqlUrl: process.env.MYSQL_URL ?? "mysql://pi:pi@127.0.0.1:3307/pi_customer_service",
		llmProvider: process.env.LLM_PROVIDER ?? "zhipu",
		llmBaseUrl: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
		llmApiKey: process.env.LLM_API_KEY ?? "",
		llmModel: process.env.LLM_MODEL ?? "glm-4.5-air",
		authSecret: process.env.AUTH_SECRET ?? "replace-this-development-secret",
		demoUserId: process.env.DEMO_USER_ID ?? "user-1",
	};
}
