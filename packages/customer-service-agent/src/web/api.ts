export interface AgentStreamPayload {
	type?: string;
	update?: { type?: string; delta?: string };
	toolName?: string;
	result?: { details?: Record<string, unknown> };
	isError?: boolean;
}

export interface ConversationSummary {
	id: string;
	title: string;
	messageCount: number;
	updatedAt: string;
}

export interface ConversationDisplayMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
}

export interface ConversationHistory {
	messages: ConversationDisplayMessage[];
	/** Draft awaiting confirmation, so the confirm card survives a page reload. */
	orderDraftId?: string;
}

export interface OrderDraftSummary {
	id: string;
	status: string;
	region: string;
	totalCents: number;
}

async function jsonRequest<T>(path: string, token: string | undefined, init: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...init.headers,
		},
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
		throw new Error(body?.message ?? `请求失败：${response.status}`);
	}
	return (await response.json()) as T;
}

export async function loginDemo(): Promise<{ token: string; userId: string }> {
	return await jsonRequest("/api/auth/demo", undefined, { method: "POST", body: JSON.stringify({}) });
}

export async function createConversation(token: string): Promise<string> {
	const result = await jsonRequest<{ conversationId: string }>("/api/conversations", token, { method: "POST" });
	return result.conversationId;
}

export async function listConversations(token: string): Promise<ConversationSummary[]> {
	const result = await jsonRequest<{ conversations: ConversationSummary[] }>("/api/conversations", token, {
		method: "GET",
	});
	return result.conversations;
}

export async function loadConversationMessages(token: string, conversationId: string): Promise<ConversationHistory> {
	return await jsonRequest<ConversationHistory>(
		`/api/conversations/${encodeURIComponent(conversationId)}/messages`,
		token,
		{ method: "GET" },
	);
}

export async function getOrderDraft(token: string, draftId: string): Promise<OrderDraftSummary> {
	return await jsonRequest<OrderDraftSummary>(`/api/order-drafts/${encodeURIComponent(draftId)}`, token, {
		method: "GET",
	});
}

export async function confirmDraft(token: string, draftId: string): Promise<{ id: string; status: string }> {
	return await jsonRequest(`/api/order-drafts/${encodeURIComponent(draftId)}/confirm`, token, { method: "POST" });
}

export async function streamChat(
	token: string,
	conversationId: string,
	message: string,
	onPayload: (event: string, payload: AgentStreamPayload) => void,
): Promise<void> {
	const response = await fetch("/api/chat", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ conversationId, message }),
	});
	if (!response.ok || !response.body) throw new Error(`对话请求失败：${response.status}`);

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			let event = "message";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith("event: ")) event = line.slice(7);
				if (line.startsWith("data: ")) data += line.slice(6);
			}
			if (data) onPayload(event, JSON.parse(data) as AgentStreamPayload);
		}
		if (done) break;
	}
}
