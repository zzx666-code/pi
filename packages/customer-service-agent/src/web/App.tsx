import { type FormEvent, useEffect, useRef, useState } from "react";
import {
	type AgentStreamPayload,
	confirmDraft,
	type ConversationDisplayMessage,
	type ConversationSummary,
	createConversation,
	getOrderDraft,
	listConversations,
	loadConversationMessages,
	loginDemo,
	streamChat,
} from "./api.ts";
import { toPlainText } from "./text.ts";

interface ChatMessage {
	id: string;
	role: "assistant" | "user" | "status";
	content: string;
}

interface PendingDraft {
	id: string;
	state: "pending" | "submitting" | "submitted";
	orderId?: string;
}

const TITLE_MAX_LENGTH = 40;

function messageId(): string {
	return crypto.randomUUID();
}

function welcomeMessage(): ChatMessage {
	return {
		id: messageId(),
		role: "assistant",
		content: "你好，我可以帮你查询商品、库存、订单和售后政策，也可以创建待确认的订单草稿。",
	};
}

function statusMessage(content: string): ChatMessage {
	return { id: messageId(), role: "status", content };
}

function toChatMessages(messages: ConversationDisplayMessage[]): ChatMessage[] {
	return messages.map((message) => ({ id: message.id, role: message.role, content: message.content }));
}

function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const sameDay = date.toDateString() === new Date().toDateString();
	return sameDay
		? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
		: date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function titleFromInput(input: string): string {
	const normalized = input.replace(/\s+/g, " ").trim();
	return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH)}…` : normalized;
}

export function App() {
	const [token, setToken] = useState("");
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [conversationId, setConversationId] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [drafts, setDrafts] = useState<Record<string, PendingDraft>>({});
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [loadingHistory, setLoadingHistory] = useState(true);
	const [connectionState, setConnectionState] = useState("正在连接服务…");
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const auth = await loginDemo();
				const existing = await listConversations(auth.token);
				if (cancelled) return;
				setToken(auth.token);
				if (existing.length > 0) {
					const latest = existing[0];
					const history = await loadConversationMessages(auth.token, latest.id);
					if (cancelled) return;
					setConversations(existing);
					setConversationId(latest.id);
					setMessages(history.messages.length > 0 ? toChatMessages(history.messages) : [welcomeMessage()]);
					await restoreDraft(auth.token, latest.id, history.orderDraftId);
				} else {
					const id = await createConversation(auth.token);
					if (cancelled) return;
					setConversations([{ id, title: "新会话", messageCount: 0, updatedAt: new Date().toISOString() }]);
					setConversationId(id);
					setMessages([welcomeMessage()]);
				}
				setConnectionState(`已连接 · ${auth.userId}`);
			} catch (error) {
				if (cancelled) return;
				setConnectionState(error instanceof Error ? error.message : "连接失败");
			} finally {
				if (!cancelled) setLoadingHistory(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, drafts, conversationId]);

	const draft = conversationId ? drafts[conversationId] : undefined;
	const activeTitle = conversations.find((item) => item.id === conversationId)?.title ?? "当前会话";

	/**
	 * Rebuild the confirm button after a reload. The draft lives in the database, but the
	 * browser otherwise has no way to know this conversation still has one open.
	 */
	async function restoreDraft(authToken: string, target: string, draftId: string | undefined): Promise<void> {
		if (!draftId) return;
		try {
			const draft = await getOrderDraft(authToken, draftId);
			if (draft.status !== "awaiting_confirmation") return;
			setDrafts((current) =>
				current[target] ? current : { ...current, [target]: { id: draft.id, state: "pending" } },
			);
		} catch {
			// An unreadable draft keeps its card hidden instead of rendering a broken button.
		}
	}

	function handleAgentPayload(assistantId: string, event: string, payload: AgentStreamPayload): void {
		if (event === "error") {
			setMessages((current) => [...current, statusMessage("本次处理失败，请稍后重试。")]);
			return;
		}
		if (payload.type === "message_update" && payload.update?.type === "text_delta" && payload.update.delta) {
			setMessages((current) =>
				current.map((message) =>
					message.id === assistantId ? { ...message, content: message.content + payload.update?.delta } : message,
				),
			);
		}
		if (payload.type === "tool_execution_start" && payload.toolName) {
			setMessages((current) => [...current, statusMessage(`正在执行：${payload.toolName}`)]);
		}
		if (payload.type === "tool_execution_end" && payload.toolName === "create_order_draft") {
			const draftId = payload.result?.details?.draftId;
			if (typeof draftId === "string") {
				setDrafts((current) => ({ ...current, [conversationId]: { id: draftId, state: "pending" } }));
			}
		}
	}

	async function sendMessage(event: FormEvent): Promise<void> {
		event.preventDefault();
		const content = input.trim();
		if (!content || !token || !conversationId || busy || loadingHistory) return;
		const assistantId = messageId();
		const target = conversationId;
		setInput("");
		setBusy(true);
		setMessages((current) => [
			...current,
			{ id: messageId(), role: "user", content },
			{ id: assistantId, role: "assistant", content: "" },
		]);
		try {
			await streamChat(token, target, content, (eventName, payload) =>
				handleAgentPayload(assistantId, eventName, payload),
			);
			setConversations((current) => {
				const existing = current.find((item) => item.id === target);
				if (!existing) return current;
				const updated: ConversationSummary = {
					...existing,
					title: existing.messageCount === 0 ? titleFromInput(content) : existing.title,
					messageCount: existing.messageCount + 2,
					updatedAt: new Date().toISOString(),
				};
				return [updated, ...current.filter((item) => item.id !== target)];
			});
		} catch (error) {
			setMessages((current) => [
				...current,
				statusMessage(error instanceof Error ? error.message : "请求失败"),
			]);
		} finally {
			setBusy(false);
		}
	}

	async function startConversation(): Promise<void> {
		if (!token || busy) return;
		try {
			const id = await createConversation(token);
			setConversations((current) => [
				{ id, title: "新会话", messageCount: 0, updatedAt: new Date().toISOString() },
				...current,
			]);
			setConversationId(id);
			setMessages([welcomeMessage()]);
		} catch (error) {
			setMessages((current) => [
				...current,
				statusMessage(error instanceof Error ? error.message : "新建会话失败"),
			]);
		}
	}

	async function selectConversation(id: string): Promise<void> {
		if (!token || busy || id === conversationId) return;
		setLoadingHistory(true);
		try {
			const history = await loadConversationMessages(token, id);
			setConversationId(id);
			setMessages(history.messages.length > 0 ? toChatMessages(history.messages) : [welcomeMessage()]);
			await restoreDraft(token, id, history.orderDraftId);
		} catch (error) {
			setConnectionState(error instanceof Error ? error.message : "加载会话失败");
		} finally {
			setLoadingHistory(false);
		}
	}

	async function submitDraft(): Promise<void> {
		if (!draft || !token || !conversationId || draft.state !== "pending") return;
		const target = conversationId;
		setDrafts((current) => ({ ...current, [target]: { ...draft, state: "submitting" } }));
		try {
			const order = await confirmDraft(token, draft.id);
			setDrafts((current) => ({ ...current, [target]: { id: draft.id, state: "submitted", orderId: order.id } }));
			setMessages((current) => [...current, statusMessage(`订单已安全提交：${order.id}`)]);
		} catch (error) {
			setDrafts((current) => ({ ...current, [target]: { id: draft.id, state: "pending" } }));
			setMessages((current) => [
				...current,
				statusMessage(error instanceof Error ? error.message : "订单提交失败"),
			]);
		}
	}

	return (
		<div className="app-shell">
			<header className="topbar">
				<div>
					<p className="eyebrow">CUSTOMER OPERATIONS</p>
					<h1>衡木客服台</h1>
				</div>
				<div className="connection" role="status"><span aria-hidden="true" />{connectionState}</div>
			</header>

			<main className="workspace">
				<aside className="sidebar">
					<section className="conversation-panel" aria-label="历史会话">
						<div className="panel-heading">
							<h2>历史会话</h2>
							<button type="button" className="ghost-button" disabled={!token || busy} onClick={() => void startConversation()}>
								新建会话
							</button>
						</div>
						<ul className="conversation-list">
							{conversations.length === 0 && <li className="conversation-empty">暂无历史会话</li>}
							{conversations.map((item) => (
								<li key={item.id}>
									<button
										type="button"
										className={item.id === conversationId ? "conversation-item conversation-item--active" : "conversation-item"}
										disabled={busy}
										aria-current={item.id === conversationId}
										onClick={() => void selectConversation(item.id)}
									>
										<span className="conversation-title">{item.title}</span>
										<span className="conversation-meta">
											{formatTimestamp(item.updatedAt)} · {item.messageCount} 条消息
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>

					<section className="context-panel" aria-label="服务边界">
						<h2>服务边界</h2>
						<p>实时数据通过受控工具查询，模型不会直接访问数据库。</p>
						<dl>
							<div><dt>可执行</dt><dd>库存查询、订单查询、创建草稿</dd></div>
							<div><dt>需确认</dt><dd>正式提交订单</dd></div>
							<div><dt>需人工</dt><dd>投诉、责任认定、退款金额</dd></div>
						</dl>
					</section>
				</aside>

				<section className="chat-panel" aria-labelledby="chat-heading">
					<div className="chat-heading">
						<div>
							<h2 id="chat-heading">{activeTitle}</h2>
							<p>所有工具操作均记录审计日志</p>
						</div>
						<span>{conversationId ? conversationId.slice(0, 8) : "等待会话"}</span>
					</div>

					<div className="messages" aria-live="polite" aria-busy={busy || loadingHistory}>
						{loadingHistory && <p className="history-loading">正在加载会话…</p>}
						{messages.map((message) => (
							<div className={`message message--${message.role}`} key={message.id}>
								{message.role !== "status" && <strong>{message.role === "user" ? "你" : "客服 Agent"}</strong>}
								<p>{toPlainText(message.content) || (busy ? "正在思考…" : "")}</p>
							</div>
						))}

						{draft && (
							<section className="order-card" aria-label="待确认订单">
								<p className="eyebrow">ORDER CHECKPOINT</p>
								<h3>{draft.state === "submitted" ? "订单已提交" : "订单草稿等待确认"}</h3>
								<p className="order-card-hint">
									{draft.state === "submitted"
										? "已生成正式订单，可在对话中让客服查询。"
										: "点击下面的按钮才会正式下单并扣减库存。"}
								</p>
								<p className="mono">{draft.orderId ?? draft.id}</p>
								{draft.state !== "submitted" && (
									<button type="button" disabled={draft.state === "submitting"} onClick={() => void submitDraft()}>
										{draft.state === "submitting" ? "正在重新校验库存…" : "确认并提交订单"}
									</button>
								)}
							</section>
						)}
						<div ref={endRef} />
					</div>

					<form className="composer" onSubmit={(event) => void sendMessage(event)}>
						<label htmlFor="message">发送消息</label>
						<div>
							<textarea
								id="message"
								value={input}
								onChange={(event) => setInput(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										event.currentTarget.form?.requestSubmit();
									}
								}}
								placeholder="例如：北京还有黑色降噪耳机吗？"
								rows={2}
							/>
							<button type="submit" disabled={busy || loadingHistory || !token || !input.trim()}>发送</button>
						</div>
					</form>
				</section>
			</main>
		</div>
	);
}
