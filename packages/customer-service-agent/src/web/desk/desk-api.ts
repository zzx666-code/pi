export type DeskTicketStatus = "open" | "assigned" | "closed";

export interface DeskTicket {
	id: string;
	userId: string;
	/** Null for tickets created before tickets recorded their source conversation. */
	conversationId: string | null;
	summary: string;
	status: DeskTicketStatus;
	assignee: string | null;
	claimedAt: string | null;
	closedAt: string | null;
	closeNote: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DeskMessage {
	id: string;
	role: "user" | "assistant" | "agent";
	content: string;
	/** Support agent who wrote it. Only set for `agent` messages. */
	author?: string;
}

export interface DeskTranscript {
	conversationId: string | null;
	messages: DeskMessage[];
}

/** Carries the status and code so the desk can tell a stale token from a ticket someone else took. */
export class DeskRequestError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "DeskRequestError";
		this.status = status;
		this.code = code;
	}
}

async function deskRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			"x-internal-token": token,
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
			...init.headers,
		},
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => undefined)) as { code?: string; message?: string } | undefined;
		throw new DeskRequestError(
			response.status,
			body?.code ?? "UNKNOWN",
			body?.message ?? `请求失败：${response.status}`,
		);
	}
	return (await response.json()) as T;
}

export async function listTickets(token: string, status: DeskTicketStatus): Promise<DeskTicket[]> {
	const result = await deskRequest<{ tickets: DeskTicket[] }>(token, `/api/support-tickets?status=${status}&limit=50`);
	return result.tickets;
}

export async function loadTranscript(token: string, ticketId: string): Promise<DeskTranscript> {
	return await deskRequest<DeskTranscript>(token, `/api/support-tickets/${encodeURIComponent(ticketId)}/messages`);
}

export async function claimTicket(token: string, ticketId: string, assignee: string): Promise<DeskTicket> {
	return await deskRequest<DeskTicket>(token, `/api/support-tickets/${encodeURIComponent(ticketId)}/claim`, {
		method: "POST",
		body: JSON.stringify({ assignee }),
	});
}

export async function replyTicket(token: string, ticketId: string, text: string): Promise<DeskTicket> {
	return await deskRequest<DeskTicket>(token, `/api/support-tickets/${encodeURIComponent(ticketId)}/reply`, {
		method: "POST",
		body: JSON.stringify({ text }),
	});
}

export async function closeTicket(token: string, ticketId: string, note: string): Promise<DeskTicket> {
	return await deskRequest<DeskTicket>(token, `/api/support-tickets/${encodeURIComponent(ticketId)}/close`, {
		method: "POST",
		body: JSON.stringify({ note }),
	});
}
