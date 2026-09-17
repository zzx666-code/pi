import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AppConfig } from "../config.ts";
import { loadProviderCredentials, modelsConfigPath } from "./provider-config.ts";

export interface CustomerModelRuntime {
	models: MutableModels;
	model: Model<"openai-completions">;
}

export async function createCustomerModelRuntime(config: AppConfig): Promise<CustomerModelRuntime> {
	const stored = await loadProviderCredentials(config.llmProvider);
	const apiKey = stored?.apiKey ?? config.llmApiKey;
	if (!apiKey) {
		throw new Error(
			`No credentials for provider "${config.llmProvider}": add it to ${modelsConfigPath()} or set LLM_API_KEY.`,
		);
	}

	const baseUrl = (stored?.baseUrl ?? config.llmBaseUrl).replace(/\/$/, "");
	const source = stored ? modelsConfigPath() : "LLM_API_KEY";
	const model: Model<"openai-completions"> = {
		id: config.llmModel,
		name: config.llmModel,
		api: "openai-completions",
		provider: config.llmProvider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
	const provider = createProvider({
		id: config.llmProvider,
		name: config.llmProvider,
		baseUrl,
		auth: {
			apiKey: {
				name: `${config.llmProvider} API key`,
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return { auth: { apiKey }, source };
				},
			},
		},
		models: [model],
		api: openAICompletionsApi(),
	});
	const models = createModels();
	models.setProvider(provider);
	return { models, model };
}
