import type { Pool } from "mysql2/promise";

/** The three things a desk can do to a ticket. Reads are deliberately not audited: the desk polls. */
export type DeskAction = "claim" | "reply" | "close";

/**
 * One line of the desk audit trail.
 *
 * Kept separate from `ToolAuditRecord` because the subject is different: a tool record answers
 * "what did the model call", this one answers "who touched this customer's ticket, and when".
 */
export interface DeskAuditRecord {
	ticketId: string;
	/**
	 * Null on the `started` row: the route only knows the ticket id at that point, and reading the
	 * ticket just to enrich an audit line would add a round trip to every desk action.
	 */
	conversationId: string | null;
	/** Null for the same reason as {@link conversationId}, and for tickets that predate the link. */
	userId: string | null;
	/**
	 * The operator. Taken from the ticket or the request, never from a client-supplied author.
	 *
	 * Null when the system genuinely cannot say who acted — a reply refused because nobody claimed
	 * the ticket, or a close whose outcome row never arrived. The desk shares one internal token and
	 * has no per-operator identity yet, so a placeholder here would invent an attribution.
	 */
	assignee: string | null;
	action: DeskAction;
	/**
	 * `started` is written before the action runs, so an action that dies mid-flight still left
	 * evidence, and an action whose intent cannot be recorded does not run at all.
	 */
	status: "started" | "succeeded" | "rejected";
	request?: unknown;
	/** Set on `rejected` rows so a refused attempt is traceable to a cause, not just a timestamp. */
	errorCode?: string;
	durationMs?: number;
}

export interface DeskAuditStore {
	record(entry: DeskAuditRecord): Promise<void>;
}

/** Collects the trail in memory so tests can assert on it without a database. */
export class InMemoryDeskAuditStore implements DeskAuditStore {
	readonly entries: DeskAuditRecord[] = [];

	async record(entry: DeskAuditRecord): Promise<void> {
		this.entries.push(structuredClone(entry));
	}
}

export class MySqlDeskAuditStore implements DeskAuditStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async record(entry: DeskAuditRecord): Promise<void> {
		await this.pool.execute(
			`INSERT INTO desk_audit_logs
				(ticket_id, conversation_id, user_id, assignee, action, status, request_json, error_code, duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				entry.ticketId,
				entry.conversationId,
				entry.userId,
				entry.assignee,
				entry.action,
				entry.status,
				entry.request === undefined ? null : JSON.stringify(entry.request),
				entry.errorCode ?? null,
				entry.durationMs ?? null,
			],
		);
	}
}
