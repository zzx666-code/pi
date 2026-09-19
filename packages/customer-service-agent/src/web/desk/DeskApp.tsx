import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { toPlainText } from "../text.ts";
import {
	claimTicket,
	closeTicket,
	type DeskMessage,
	DeskRequestError,
	type DeskTicket,
	type DeskTicketStatus,
	type DeskTranscript,
	listTickets,
	loadTranscript,
	replyTicket,
} from "./desk-api.ts";

const TOKEN_STORAGE_KEY = "pi-desk-token";
const ASSIGNEE_STORAGE_KEY = "pi-desk-assignee";

/** Matches the customer page: short enough to feel live, long enough not to hammer the API. */
const POLL_INTERVAL_MS = 5000;

const STATUS_TABS: readonly { status: DeskTicketStatus; label: string; hint: string }[] = [
	{ status: "open", label: "待认领", hint: "客户已转人工。认领后会话进入人工接管，机器人停止回答。" },
	{ status: "assigned", label: "处理中", hint: "已认领。回复会直接出现在客户会话里。" },
	{ status: "closed", label: "已关闭", hint: "处理完毕，会话已交还机器人。" },
];

function describe(error: unknown): string {
	if (error instanceof DeskRequestError && error.status === 401) return "内网 token 无效，请重新填写。";
	return error instanceof Error ? error.message : "操作失败";
}

function formatTime(iso: string | null): string {
	if (!iso) return "-";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function messageAuthor(message: DeskMessage): string {
	if (message.role === "user") return "客户";
	if (message.role === "agent") return message.author ? `人工客服 ${message.author}` : "人工客服";
	return "客服 Agent";
}

export function DeskApp() {
	const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
	const [tokenInput, setTokenInput] = useState("");
	const [authError, setAuthError] = useState("");

	const [assignee, setAssignee] = useState(() => localStorage.getItem(ASSIGNEE_STORAGE_KEY) ?? "");
	const [status, setStatus] = useState<DeskTicketStatus>("open");
	const [tickets, setTickets] = useState<DeskTicket[]>([]);
	const [selected, setSelected] = useState<DeskTicket>();
	const [transcript, setTranscript] = useState<DeskTranscript>();
	const [replyText, setReplyText] = useState("");
	const [closeNote, setCloseNote] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const transcriptRef = useRef<HTMLDivElement>(null);

	const tab = STATUS_TABS.find((candidate) => candidate.status === status) ?? STATUS_TABS[0];

	const refreshQueue = useCallback(async (): Promise<void> => {
		if (!token) return;
		try {
			setTickets(await listTickets(token, status));
		} catch (error) {
			if (error instanceof DeskRequestError && error.status === 401) {
				// Drop the stored token too, or a reload would send the desk straight back into 401.
				localStorage.removeItem(TOKEN_STORAGE_KEY);
				setAuthError("内网 token 无效，请重新填写。");
				setToken("");
				return;
			}
			setNotice(describe(error));
		}
	}, [token, status]);

	const refreshTranscript = useCallback(
		async (ticketId: string): Promise<void> => {
			if (!token) return;
			try {
				setTranscript(await loadTranscript(token, ticketId));
			} catch (error) {
				setNotice(describe(error));
			}
		},
		[token],
	);

	// The queue is what tells an operator there is work, so it keeps itself current.
	useEffect(() => {
		if (!token) return;
		void refreshQueue();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void refreshQueue();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [token, refreshQueue]);

	// The customer may keep typing while the desk reads, so the open transcript follows along.
	useEffect(() => {
		setTranscript(undefined);
		if (!token || !selected) return;
		const ticketId = selected.id;
		void refreshTranscript(ticketId);
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void refreshTranscript(ticketId);
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [token, selected, refreshTranscript]);

	// Opening a ticket always jumps to the newest message; a poll only follows the tail if the
	// operator is already reading it, so a refresh cannot yank them out of the backlog.
	const scrolledTicketRef = useRef("");
	useEffect(() => {
		const list = transcriptRef.current;
		if (!list) return;
		const openingAnotherTicket = scrolledTicketRef.current !== selected?.id;
		scrolledTicketRef.current = selected?.id ?? "";
		const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
		if (openingAnotherTicket || nearBottom) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
	}, [transcript, selected]);

	function enterDesk(event: FormEvent): void {
		event.preventDefault();
		const value = tokenInput.trim();
		if (!value) return;
		localStorage.setItem(TOKEN_STORAGE_KEY, value);
		setToken(value);
		setTokenInput("");
		setAuthError("");
	}

	function leaveDesk(): void {
		localStorage.removeItem(TOKEN_STORAGE_KEY);
		setToken("");
		setTickets([]);
		setSelected(undefined);
		setTranscript(undefined);
		setNotice("");
	}

	function saveAssignee(value: string): void {
		setAssignee(value);
		localStorage.setItem(ASSIGNEE_STORAGE_KEY, value);
	}

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		try {
			await action();
		} catch (error) {
			setNotice(describe(error));
		} finally {
			setBusy(false);
		}
	}

	async function handleClaim(): Promise<void> {
		const id = selected?.id;
		if (!token || !id || busy) return;
		const name = assignee.trim();
		if (!name) {
			setNotice("先填写工号，工单会记下是谁接手的。");
			return;
		}
		await run(async () => {
			const updated = await claimTicket(token, id, name);
			setSelected(updated);
			setNotice("已认领。客户页面会在几秒内显示“人工客服已接入”，机器人停止回答。");
			setStatus("assigned");
		});
	}

	async function handleReply(event: FormEvent): Promise<void> {
		event.preventDefault();
		const id = selected?.id;
		const text = replyText.trim();
		if (!token || !id || !text || busy) return;
		await run(async () => {
			await replyTicket(token, id, text);
			setReplyText("");
			setNotice("已发送。这条回复会出现在客户的会话里。");
			await refreshTranscript(id);
		});
	}

	async function handleClose(): Promise<void> {
		const id = selected?.id;
		if (!token || !id || busy) return;
		await run(async () => {
			const updated = await closeTicket(token, id, closeNote.trim());
			setSelected(updated);
			setCloseNote("");
			setNotice("已关闭。会话交还机器人，客户页面的人工提示会消失。");
			setStatus("closed");
		});
	}

	if (!token) {
		return (
			<div className="desk-gate">
				<form onSubmit={enterDesk}>
					<p className="eyebrow">CUSTOMER OPERATIONS</p>
					<h1>衡木坐席台</h1>
					<p className="gate-hint">
						坐席台用内网 token 直连 Agent，不走客户登录。它是工单的入口：没有这里，转人工的工单无人认领。
					</p>
					<label htmlFor="desk-token">内网 token</label>
					<input
						id="desk-token"
						type="password"
						value={tokenInput}
						onChange={(event) => setTokenInput(event.target.value)}
						placeholder="x-internal-token"
						autoComplete="off"
					/>
					{authError && <p className="desk-error">{authError}</p>}
					<button type="submit" disabled={!tokenInput.trim()}>
						进入坐席台
					</button>
				</form>
			</div>
		);
	}

	return (
		<div className="desk-shell">
			<header className="desk-topbar">
				<div>
					<p className="eyebrow">CUSTOMER OPERATIONS</p>
					<h1>衡木坐席台</h1>
				</div>
				<div className="desk-identity">
					<label htmlFor="desk-assignee">工号</label>
					<input
						id="desk-assignee"
						value={assignee}
						onChange={(event) => saveAssignee(event.target.value)}
						placeholder="例如 12314"
						autoComplete="off"
					/>
					<button type="button" className="ghost-button" onClick={leaveDesk}>
						退出
					</button>
				</div>
			</header>

			<main className="desk-workspace">
				<aside className="desk-queue">
					<nav className="queue-tabs" aria-label="工单状态">
						{STATUS_TABS.map((candidate) => (
							<button
								key={candidate.status}
								type="button"
								className={candidate.status === status ? "queue-tab queue-tab--active" : "queue-tab"}
								aria-current={candidate.status === status}
								onClick={() => setStatus(candidate.status)}
							>
								{candidate.label}
								{candidate.status === status && <span>{tickets.length}</span>}
							</button>
						))}
					</nav>
					<p className="queue-hint">{tab.hint}</p>
					<ul className="ticket-list">
						{tickets.length === 0 && <li className="ticket-empty">这个状态下没有工单</li>}
						{tickets.map((ticket) => (
							<li key={ticket.id}>
								<button
									type="button"
									className={ticket.id === selected?.id ? "ticket-item ticket-item--active" : "ticket-item"}
									onClick={() => setSelected(ticket)}
								>
									<span className="ticket-summary">{ticket.summary}</span>
									<span className="ticket-meta">
										#{ticket.id.slice(0, 8)} · {formatTime(ticket.createdAt)}
										{ticket.assignee ? ` · ${ticket.assignee}` : ""}
									</span>
									{ticket.conversationId ? (
										<span className="ticket-tag">含会话</span>
									) : (
										<span className="ticket-tag ticket-tag--warn">无关联会话</span>
									)}
								</button>
							</li>
						))}
					</ul>
				</aside>

				<section className="desk-detail">
					{!selected ? (
						<p className="detail-empty">从左边选一张工单。认领后就能读到客户的完整会话并回复。</p>
					) : (
						<>
							<div className="detail-head">
								<div>
									<p className="eyebrow">TICKET #{selected.id.slice(0, 8)}</p>
									<h2>{selected.summary}</h2>
									<p className="detail-meta">
										状态 {selected.status} · 客户 {selected.userId} · 会话{" "}
										{selected.conversationId ? selected.conversationId.slice(0, 8) : "无"}
										{selected.assignee ? ` · 处理人 ${selected.assignee}` : ""}
									</p>
								</div>
								<button type="button" className="ghost-button" disabled={busy} onClick={() => void refreshQueue()}>
									刷新
								</button>
							</div>

							{selected.status === "open" && (
								<div className="detail-actions">
									<p>认领后这台会话进入人工接管，机器人不再回答，直到你关闭工单。</p>
									<button type="button" disabled={busy || !assignee.trim()} onClick={() => void handleClaim()}>
										{busy ? "处理中…" : "认领这张工单"}
									</button>
								</div>
							)}

							{selected.status === "assigned" && (
								<form className="detail-actions" onSubmit={(event) => void handleReply(event)}>
									<label htmlFor="desk-reply">回复客户（会直接出现在他的会话里）</label>
									<textarea
										id="desk-reply"
										rows={3}
										value={replyText}
										onChange={(event) => setReplyText(event.target.value)}
										placeholder="例如：您的问题已经解决，欢迎下次购物"
									/>
									<div className="action-row">
										<button type="submit" disabled={busy || !replyText.trim()}>
											发送回复
										</button>
										<input
											aria-label="关闭备注"
											value={closeNote}
											onChange={(event) => setCloseNote(event.target.value)}
											placeholder="关闭备注（可选）"
										/>
										<button type="button" className="ghost-button" disabled={busy} onClick={() => void handleClose()}>
											关闭工单
										</button>
									</div>
								</form>
							)}

							{notice && <p className="desk-notice">{notice}</p>}

							{!selected.conversationId && (
								<p className="desk-error">
									这张工单创建于工单记录会话之前，没有关联会话，无法回复。新工单都会带上会话。
								</p>
							)}

							<div className="transcript" ref={transcriptRef}>
								{!transcript && <p className="detail-empty">正在读取会话…</p>}
								{transcript?.messages.map((message) => (
									<div className={`bubble bubble--${message.role}`} key={message.id}>
										<strong>{messageAuthor(message)}</strong>
										<p>{toPlainText(message.content)}</p>
									</div>
								))}
							</div>
						</>
					)}
				</section>
			</main>
		</div>
	);
}
