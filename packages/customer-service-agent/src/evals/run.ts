import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Scenario {
	name: string;
	input: string;
	expectedTools: string[];
}

interface AuthResponse {
	token: string;
}

interface ConversationResponse {
	conversationId: string;
}

interface StreamPayload {
	type?: string;
	toolName?: string;
}

async function requestJson<T>(baseUrl: string, path: string, token?: string): Promise<T> {
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: "{}",
	});
	if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
	return (await response.json()) as T;
}

function collectTools(stream: string): Set<string> {
	const tools = new Set<string>();
	for (const frame of stream.split("\n\n")) {
		const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
		if (!dataLine) continue;
		const payload = JSON.parse(dataLine.slice(6)) as StreamPayload;
		if (payload.type === "tool_execution_start" && payload.toolName) tools.add(payload.toolName);
	}
	return tools;
}

async function runScenario(baseUrl: string, token: string, scenario: Scenario): Promise<boolean> {
	const { conversationId } = await requestJson<ConversationResponse>(baseUrl, "/api/conversations", token);
	const response = await fetch(`${baseUrl}/api/chat`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ conversationId, message: scenario.input }),
	});
	if (!response.ok) throw new Error(`${scenario.name} failed with HTTP ${response.status}`);
	const tools = collectTools(await response.text());
	const missing = scenario.expectedTools.filter((tool) => !tools.has(tool));
	console.log(`${missing.length === 0 ? "PASS" : "FAIL"} ${scenario.name} tools=[${[...tools].join(", ")}]`);
	return missing.length === 0;
}

const baseUrl = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:3100";
const scenarioPath = join(import.meta.dirname, "../../evals/scenarios.json");
const scenarios = JSON.parse(await readFile(scenarioPath, "utf8")) as Scenario[];
const { token } = await requestJson<AuthResponse>(baseUrl, "/api/auth/demo");
const results: boolean[] = [];
for (const scenario of scenarios) results.push(await runScenario(baseUrl, token, scenario));
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} scenarios passed`);
if (passed !== results.length) process.exitCode = 1;
