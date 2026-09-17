import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProviderCredentials, modelsConfigPath } from "../../src/agent/provider-config.ts";

let dir: string;
const originalDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-customer-service-provider-"));
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(async () => {
	if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalDir;
	await rm(dir, { recursive: true, force: true });
});

async function writeModels(json: unknown): Promise<void> {
	await writeFile(join(dir, "models.json"), JSON.stringify(json), "utf8");
}

describe("provider credentials from models.json", () => {
	it("reads the baseUrl and apiKey of the requested provider", async () => {
		await writeModels({
			providers: {
				zhipu: { baseUrl: "https://example.test/v4/", api: "openai-completions", apiKey: "secret-key" },
			},
		});

		expect(await loadProviderCredentials("zhipu")).toEqual({
			baseUrl: "https://example.test/v4/",
			apiKey: "secret-key",
		});
	});

	it("returns undefined when the file or the provider entry is absent", async () => {
		expect(await loadProviderCredentials("zhipu")).toBeUndefined();

		await writeModels({ providers: { other: { baseUrl: "https://example.test", apiKey: "k" } } });

		expect(await loadProviderCredentials("zhipu")).toBeUndefined();
	});

	it("rejects an incomplete provider entry", async () => {
		await writeModels({ providers: { zhipu: { baseUrl: "https://example.test" } } });

		await expect(loadProviderCredentials("zhipu")).rejects.toThrow(/baseUrl and apiKey/);
	});

	it("rejects an unsupported transport", async () => {
		await writeModels({
			providers: { zhipu: { baseUrl: "https://example.test", apiKey: "k", api: "anthropic-messages" } },
		});

		await expect(loadProviderCredentials("zhipu")).rejects.toThrow(/unsupported api/);
	});

	it("resolves models.json inside the overridden config directory", () => {
		expect(modelsConfigPath()).toBe(join(dir, "models.json"));
	});
});
