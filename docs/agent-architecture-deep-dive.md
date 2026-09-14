# pi Agent 源码深度解析：架构、协议封装、循环结构与工具注册机制

> 本文基于对仓库源码的完整阅读，所有代码引用均标注 `文件路径:行号`，可直接跳转核对。
> 阅读前提：了解基本的 TypeScript / Node.js / LLM API（Anthropic、OpenAI 等）概念。

## 目录

1. [总体架构：monorepo 分层](#1-总体架构monorepo-分层)
2. [协议封装（一）：`packages/ai` 统一 LLM 协议层](#2-协议封装一packagesai-统一-llm-协议层)
3. [协议封装（二）：`packages/protocol` RPC 传输协议](#3-协议封装二packagesprotocol-rpc-传输协议)
4. [循环结构（一）：`packages/agent` 低层 agent 循环](#4-循环结构一packagesagent-低层-agent-循环)
5. [循环结构（二）：`packages/agent` 可持久化 harness 状态机](#5-循环结构二packagesagent-可持久化-harness-状态机)
6. [工具注册机制：从 Tool 接口到 Agent 手里](#6-工具注册机制从-tool-接口到-agent-手里)
7. [端到端数据流：一条消息的完整生命周期](#7-端到端数据流一条消息的完整生命周期)
8. [设计要点总结](#8-设计要点总结)

---

## 1. 总体架构：monorepo 分层

pi 是一个 monorepo，核心包之间存在严格的单向依赖（上层用下层，下层不知道上层）：

```
┌─────────────────────────────────────────────────────────┐
│ packages/coding-agent  （CLI / TUI / RPC 模式，产品层）  │
│   main.ts → AgentSession → Agent                        │
├─────────────────────────────────────────────────────────┤
│ packages/agent  (pi-agent-core，agent 运行时)            │
│   agent-loop.ts：核心循环                                │
│   Agent 类：状态管理                                     │
│   harness/：可持久化会话运行时（崩溃可恢复）             │
├─────────────────────────────────────────────────────────┤
│ packages/ai  (pi-ai，统一 LLM 协议层)                    │
│   types.ts：统一消息/工具/事件类型                       │
│   api/：各厂商 wire protocol 适配器                      │
│   providers/：厂商身份/认证/模型目录                     │
│   models.ts：模型注册与请求分发                          │
├─────────────────────────────────────────────────────────┤
│ packages/protocol  (pi-protocol，远程会话 RPC 协议)      │
│   CBOR 编码 + 长度前缀帧 + TypeBox 校验的信封协议        │
├─────────────────────────────────────────────────────────┤
│ packages/chord (底层 RPC 语义) / packages/tui / client / │
│ server / telemetry / evals                              │
└─────────────────────────────────────────────────────────┘
```

关键认知：**这个仓库有两个"协议"概念，不要混淆**：

| 概念 | 包 | 作用 |
|---|---|---|
| LLM 提供商协议 | `packages/ai` | 把 Anthropic/OpenAI/Google 等 10 种 wire protocol 统一成一套消息/流式事件协议 |
| 远程会话 RPC 协议 | `packages/protocol` | 客户端↔服务端进程间通信的 CBOR 信封/帧协议，不含任何 LLM 语义 |

`packages/agent` 则提供了**两层循环**：

| 层 | 文件 | 特点 |
|---|---|---|
| 低层内存循环 | `src/agent-loop.ts` | 单进程内存版：while 循环 + 消息数组，轻量直接 |
| 可持久化 harness 循环 | `src/harness/runtime/drive.ts` | 存储背书的状态机：13 个持久状态，崩溃后可从任意状态恢复 |

---

## 2. 协议封装（一）：`packages/ai` 统一 LLM 协议层

### 2.1 统一消息格式（`packages/ai/src/types.ts`）

系统提示**不是消息**，而是请求上下文的一个字段：

```ts
// packages/ai/src/types.ts:524-528
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
```

三种消息角色（`types.ts:470`）：

```ts
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

**用户消息**（`types.ts:422-426`）：

```ts
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[]; // 纯文本或图文混合
	timestamp: number; // Unix 毫秒时间戳
}
```

**助手消息**（`types.ts:428-450`）：携带完整的模型身份、用量、停止原因：

```ts
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;              // 用的是哪种 wire protocol
	provider: ProviderId;  // 哪家厂商
	model: string;
	responseId?: string;   // 上游响应 ID
	usage: Usage;          // token 用量与成本
	stopReason: StopReason;
	deferred?: DeferredHandle;     // 延迟（异步）响应句柄
	errorMessage?: string;
	timestamp: number;
}
```

**工具结果消息**（`types.ts:452-468`）：注意 pi 把工具结果设计为**独立的顶层角色 `toolResult`**，而不是像 OpenAI 那样塞进 user 消息里：

```ts
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;    // 对应 ToolCall.id
	toolName: string;
	content: (TextContent | ImageContent)[]; // 支持文本和图片！
	details?: TDetails;    // 结构化数据，给日志/UI 用，不发给模型
	usage?: Usage;
	addedToolNames?: string[]; // 延迟工具加载点（Anthropic tool_reference）
	isError: boolean;
	timestamp: number;
}
```

内容块类型（`types.ts:351-381`）：

```ts
export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // 思维链回放签名（跨请求保持推理连续性）
	redacted?: boolean;         // 被安全过滤器涂黑
}

export interface ImageContent {
	type: "image";
	data: string;    // base64
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google 专有
	namespace?: string;        // OpenAI Responses 专有
}
```

停止原因（`types.ts:406`）：

```ts
export type StopReason =
	| "pending"   // 流式进行中
	| "stop"      // 正常结束
	| "length"    // 输出被 token 上限截断
	| "toolUse"   // 模型想调工具
	| "error"
	| "aborted"   // 用户中止
	| "deferred"; // 提供商侧异步延迟响应
```

`StopReason` 是整个 agent 循环的**控制信号**：`toolUse` → 继续循环执行工具；`stop` → 结束循环；`length` → 不执行工具直接全部报错；`error`/`aborted` → 终止。

### 2.2 统一流式事件协议（`types.ts:546-562`）

所有 provider 的流式响应被归一化为同一组事件：

```ts
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start" | "text_delta" | "text_end"; contentIndex: number; ... }
	| { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
	| { type: "toolcall_start" | "toolcall_delta" | "toolcall_end"; ... }
	| { type: "done"; reason: ...; message: AssistantMessage }
	| { type: "error"; reason: ...; error: AssistantMessage };
```

契约（`types.ts:324-337`）：

- `StreamFunction` 必须返回 `AssistantMessageEventStream`；
- 只有**请求 auth 缺失**才允许同步抛异常；其余一切失败（模型错、网络错、运行时错）都必须编码为流内的 `error` 事件 + `stopReason: "error" | "aborted"`；
- `start` 之前不许出现 `done`/`error` 之外的任何事件。

这个"错误不抛异常而是进流"的设计贯穿全库：上层循环永远 `for await` 消费流即可，不需要 try/catch 分支。

### 2.3 流的底层实现：EventStream（`packages/ai/src/utils/event-stream.ts`）

`EventStream<T, R>`（`event-stream.ts:26-89`）是一个手写的 push/async-iterate 双模式队列：

- 生产端 `push()` / `end(result)` / `error(e)`；
- 消费端可以直接 `for await` 迭代，也可以 `await stream.result()` 拿最终结果（在 `done`/`error` 时 resolve）；
- 内部是 FIFO 队列 + waiter promise 链，保证事件顺序。

`AssistantMessageEventStream`（`event-stream.ts:91-105`）是它的特化。

### 2.4 Provider 适配：三层架构

**第一层：API 适配器（`src/api/*.ts`）** —— 按 **wire protocol**（不是按厂商）划分，共 10 种 `KnownApi`（`types.ts:17-27`）：

```
anthropic-messages / openai-completions / openai-responses / azure-openai-responses /
openai-codex-responses / google-generative-ai / google-vertex / bedrock-converse-stream /
mistral-conversations / pi-messages
```

每个模块导出统一形状（`types.ts:272-281`）：

```ts
export interface ProviderStreams {
	stream(model, context, options): AssistantMessageEventStream;
	streamSimple(model, context, options): AssistantMessageEventStream;
	fetchDeferred?(...): AssistantMessageEventStream;
	cancelDeferred?(...): Promise<void>;
}
```

例如 Anthropic 适配器在 `api/anthropic-messages.ts:502` 导出 `stream`、`:846` 导出 `streamSimple`。每个适配器内部都有：

- `buildParams()`：把统一 `Context` 转成厂商原生参数（如 `anthropic-messages.ts:1021`）；
- `convertMessages()`：统一消息 → 厂商消息（`anthropic-messages.ts:1223`）；
- `convertTools()`：统一工具 → 厂商工具（详见 §6.1）。

**第二层：Provider 注册（`src/providers/*.ts`）** —— 按**厂商**划分，约 40 个文件。每个是薄工厂，把"身份 + 认证 + 模型目录"绑定到一个 API 适配器：

```ts
// packages/ai/src/providers/anthropic.ts:43-59
export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: { apiKey: anthropicApiKeyAuth(), oauth: lazyOAuth({...}) },
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(), // 懒加载包装（见下）
	});
}
```

**第三层：模型注册与分发（`src/models.ts`）** —— `Models` 运行时集合（`models.ts:156-228`）负责每个请求的认证解析 + 分发：

```ts
// packages/ai/src/models.ts:695-701（示意）
stream(model, context, options) {
	return lazyStream(model, async () => {
		const provider = this.requireProvider(model);
		const { requestModel, requestOptions } = await this.applyAuth(model, options);
		return provider.stream(requestModel, context, requestOptions);
	});
}
```

`applyAuth`（`models.ts:641-670`）合并凭据存储/环境变量/自定义 header，`createProvider`（`models.ts:775-875`）支持单 API 或按 `model.api` 分发的 API map（混合 API 厂商用，`models.ts:788-805`）。

**懒加载**：重型 SDK 不在启动时 import。`api/lazy.ts:73-98` 的 `lazyApi(() => import("./anthropic-messages.ts"))` 让模块在首次 stream 调用时才加载，`lazyStream`（`api/lazy.ts:46-61`）同步返回流、异步转发 setup 错误。这也是 `AGENTS.md` 禁止 inline import 的一个背景——库内用的是受控的、集中管理的 lazy 机制。

### 2.5 跨厂商规范化：transformMessages（`api/transform-messages.ts:64-130`）

模型目录是静态 + 生成的（`src/models.generated.ts`，由 `scripts/generate-models.ts` 生成，**绝不手改**）。每条请求前 `transformMessages` 会做跨厂商修补：

- 把工具调用 ID 重写成各 provider 合法字符集（`transform-messages.ts` 起于 :64）；
- 非视觉模型：图片降级为文本占位符（`:35-57`）；
- 跨模型回放时 thinking 块转纯文本（`:100-117`），丢弃别的模型的涂黑 thinking。

### 2.6 一次请求的完整流程（以 Anthropic 为例）

```
Models.streamSimple(model, context)
  └─ applyAuth()                          models.ts:641        合并凭据
  └─ Provider.streamSimple()              models.ts:843        按模型分发
    └─ streamSimple()                     anthropic-messages.ts:846
      └─ stream()                         anthropic-messages.ts:502
        ├─ buildParams()                  :1021
        │   ├─ transformMessages()        transform-messages.ts:64
        │   ├─ convertMessages()          :1223   统一消息 → MessageParam[]
        │   └─ convertTools()             :1425   统一工具 → BetaTool[]
        ├─ retryProviderRequest(...)      :576    带重试的 SDK 调用
        └─ SSE 事件循环                    :590
            ├─ message_start       → usage/responseId     :591
            ├─ content_block_start → text/thinking/toolcall_start  :614-661
            ├─ content_block_delta → *_delta（含增量 JSON 解析）   :662-707
            ├─ content_block_stop  → *_end                :708-739
            └─ message_delta        → mapStopReason()      :740-776（映射表 :1464-1490）
```

其他适配器结构完全同构，只是 `buildParams`/`convertMessages`/`convertTools` 的目标格式不同。`api/pi-messages.ts` 是退化适配器：把 `{model, context, options}` 原样 POST 到 `<baseUrl>/messages` 并转发 pi 自己的 SSE 事件协议（用于 Radius 网关）。

### 2.7 统一 options 体系

`streamSimple` 接收 `SimpleStreamOptions`（reasoning level → 自动映射 thinkingEnabled/effort/budget，见各适配器如 `anthropic-messages.ts:846-892`），完整 `stream` 接收 `StreamOptions`（含 `transport: "sse" | "websocket" | "websocket-cached" | "auto"`，`types.ts:110, 199`）。

---

## 3. 协议封装（二）：`packages/protocol` RPC 传输协议

这个包与 LLM 无关，是**远程 pi 会话**的客户端↔服务端传输协议：传输中立（TCP/stdio/WS 均可）、二进制、有版本协商。

### 3.1 分层

```
应用层消息（Chord RPC 语义，call 载荷不透明）
   ↓ protocol.ts —— TypeBox 信封 schema + 校验
信封（hello / request / cancel / response / service_update / attachment）
   ↓ codec.ts —— validate + encode/decode
CBOR 二进制
   ↓ framing.ts —— 4 字节大端长度前缀分帧
字节流
```

### 3.2 信封 schema（`packages/protocol/src/protocol.ts`）

版本常量（`:5`）：

```ts
export const PROTOCOL_VERSION = 8 as const;
```

客户端消息（`:29-63`）——首帧必须是 hello：

```ts
const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});

const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	target: RpcTargetSchema,
	call: OpaqueJsonValueSchema, // 不透明的 Chord 载荷
});

const CancelEnvelopeSchema = StrictObject({
	type: Type.Literal("cancel"),
	id: IdSchema,
	target: RpcTargetSchema,
});

export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, CancelEnvelopeSchema]);
```

`target` 决定请求路由到整个服务器还是某个会话（`:36-47`）：

```ts
const SessionTargetSchema = StrictObject({
	serverId: ServerIdSchema,   // UUID v4
	sessionId: IdSchema,
	attachmentId: IdSchema,
});
```

服务端消息（`:65-110`）：`hello`（含 serverId）/ `hello_error` / `response`（ok:result 或 error）/ `service_update`（订阅推送）/ `attachment`（带外会话路由变更）。

设计要点：

- **载荷不透明**：`call: OpaqueJsonValueSchema` —— 这一层只管路由与信封，载荷语义归 Chord（`packages/chord`）。LLM 消息原样穿过这层。
- **严格对象**：所有 schema 都是 `additionalProperties: false`（`StrictObject`，`:9-10`），未知字段直接校验失败，保证前后兼容纪律。

### 3.3 帧与 CBOR（`framing.ts` / `cbor/`）

`framing.ts`：

- `encodeFrame()`（`:28-39`）：4 字节大端长度前缀 + CBOR 载荷；
- `FrameDecoder`（`:44-150`）：增量式、容忍 TCP 分片的拆帧器。

CBOR 编解码是**手写的**（`cbor/encoder.ts:216` 行 / `cbor/decoder.ts:168` 行），刻意限制在 JSON 值域：

- 拒绝 CBOR tags（`decoder.ts:79-80`）；
- 拒绝重复 map key（`decoder.ts:68`）；
- 拒绝不安全整数、非法 UTF-8；
- DoS 防护限制（`cbor/options.ts:6-8`）：最大 16 MiB、100 万元素、深度 64。

### 3.4 编解码入口（`codec.ts`）

`parseClientMessage`/`parseServerMessage`（`:20-32`）= 反序列化 + TypeBox 校验；`ClientMessageDecoder`/`ServerMessageDecoder`（`:106-137`）提供有状态的流式解码；`isSupportedProtocolVersion`（`:139-141`）做版本协商。

---

## 4. 循环结构（一）：`packages/agent` 低层 agent 循环

`src/agent-loop.ts`（803 行）是整个系统的心脏。文件头注释一句话点题（`:1-4`）：

```ts
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
```

即：循环内部全程使用 `AgentMessage`（可扩展消息，见 §6.2），只在调 LLM 的边界处才转换成 `Message[]`。这让应用可以往会话里塞自定义消息类型（如 bash 执行记录、压缩摘要），它们不发给模型但参与会话历史。

### 4.1 入口函数

| 函数 | 行号 | 用途 |
|---|---|---|
| `agentLoop` | `agent-loop.ts:32-55` | 推入新 prompt 启动循环，返回 `EventStream<AgentEvent, AgentMessage[]>` |
| `agentLoopContinue` | `agent-loop.ts:65-94` | 从现有上下文继续（重试用），要求最后一条消息是 user/toolResult |
| `runAgentLoop` | `agent-loop.ts:96-119` | async 变体：追加 prompt、发生命周期事件、调 `runLoop` |
| `runAgentLoopContinue` | `agent-loop.ts:121-144` | async 继续变体 |

### 4.2 主循环 `runLoop`（`agent-loop.ts:156-273`）逐行解析

```ts
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	// 循环开始前先检查 steering 消息（用户可能在等待期间输入了）
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// 外层循环：agent 本该停止时，如果有排队的 follow-up 消息则继续
	while (true) {
		let hasMoreToolCalls = true;

		// 内层循环：处理工具调用和 steering 消息
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (lastCompletedTurn) {
				// 每轮开始前的钩子：可换模型/换 thinking 等级/压缩上下文
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = { ...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning: /* thinkingLevel 映射 */ };
				}
				// prepareNextTurn 可能耗时（如压缩），期间新排队 的 steering 也要捡起来
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// 注入 pending 消息（在下一次助手响应之前）
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// ★ 调 LLM（流式）
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			// 错误/中止 → 结束循环
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 收集工具调用
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// stopReason === "length" 意味着输出被 token 上限截断，
				// 工具参数可能被截断而不安全 → 全部标记为失败，让模型重新发
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate; // ← 循环继续的条件

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			lastCompletedTurn = { message, toolResults, context: currentContext, newMessages };

			if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		} // ← 内层循环条件：还有工具调用或有 steering 消息

		// agent 本该在此停止。检查 follow-up 队列
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue; // ← 外层循环重启内层循环
		}
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}
```

**循环继续条件总结**（这是 agent 循环的本质）：

1. 内层 `while (hasMoreToolCalls || pendingMessages.length > 0)`：
   - `hasMoreToolCalls`：模型发了 toolCall 且工具没说 terminate → **把工具结果喂回去再调一次模型**；
   - `pendingMessages`：用户在运行中插话（steering）→ 插进上下文再调模型。
2. 外层 `while (true)`：模型自然停止后，查 follow-up 队列（如 UI 排队的下一指令）→ 有则继续。
3. 终止路径：`stopReason: error/aborted`（直接返回）、`shouldStopAfterTurn` 钩子、工具批全部 `terminate: true`。

### 4.3 LLM 调用边界 `streamAssistantResponse`（`agent-loop.ts:279-370`）

这是 `AgentMessage[]` 变成 `Message[]` 的唯一地点：

```ts
async function streamAssistantResponse(...): Promise<AssistantMessage> {
	// 1. 可选的上下文变换（AgentMessage[] → AgentMessage[]，如压缩）
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// 2. 转换成 LLM 消息（AgentMessage[] → Message[]）
	const llmMessages = await config.convertToLlm(messages);

	// 3. 构造 LLM 上下文
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// 4. 解析 API key（重要：token 可能过期，每次现取）
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 5. 调流函数
	const response = await streamFunction(config.model, llmContext, {
		...config, apiKey: resolvedApiKey, signal,
	});

	// 6. 消费流事件，实时改写 context.messages 的最后一个元素
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage); // partial 立即入上下文
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start": /* fallthrough */
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					// ★ 原地替换最后一个元素：上下文数组始终持有"活的 partial"
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				// 流结束：用最终消息替换 partial
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}
	// ...
}
```

注意"**原地替换**"模式：流式 partial 在 `start` 时就 push 进上下文，每个 delta 原地替换最后元素，结算时替换成最终消息——上下文数组永远反映实时状态，UI 订阅即可渲染。

### 4.4 工具执行流水线（`agent-loop.ts:409-803`）

**分发**（`executeToolCalls`，`:409-424`）：

```ts
const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
const hasSequentialToolCall = toolCalls.some(
	(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
	return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

- 串行路径（`:431-485`）：逐个 prepare → execute → finalize；
- 并行路径（`:487-561`）：**先顺序 prepare**（保证 `beforeToolCall` 钩子看到一致状态），execute 部分包装成惰性 thunk，`Promise.all`（`:547`）并发执行，最后**按助手消息中的原始顺序**发出工具结果（`:550-555`）——顺序确定性对会话回放和缓存都重要。

**单个工具调用三阶段**：

1. `prepareToolCall`（`:607-675`）：
   - 按 name 在 `context.tools` 里找工具，找不到 → 立即错误结果；
   - `prepareToolCallArguments`（`:593-605`）：调用工具的 `prepareArguments` 兼容 shim；
   - `validateToolArguments`（来自 `@earendil-works/pi-ai`，实现在 `packages/ai/src/utils/validation.ts:317-350`）：TypeBox 校验 + JSON-schema 风格类型强转；
   - `config.beforeToolCall` 钩子：可 `block`（阻止执行，原因返回给模型）。
2. `executePreparedToolCall`（`:677-718`）：
   - 调 `tool.execute(toolCallId, args, signal, onUpdate)`；
   - `onUpdate` 回调把工具的部分结果（如 bash 的实时输出）缓冲成 `tool_execution_update` 事件流；
   - 工具抛异常 → 捕获并转换成错误结果（`createErrorToolResult`，`:767-772`），**异常不会炸掉循环**。
3. `finalizeExecutedToolCall`（`:720-765`）：
   - `config.afterToolCall` 钩子可改写结果（content/details/usage/terminate/isError）；
   - `createToolResultMessage`（`:784-798`）归一化为 `ToolResultMessage`（无 content 的 JS 扩展工具也会被兜底成 `[]`，防止 null 进入会话历史）。

**批量终止判定**（`shouldTerminateToolBatch`，`:589-591`）：

```ts
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```

只有批内**全部**结果都 `terminate: true` 才提前结束——单个工具无权单独终止整个 agent。

**截断保护**（`failToolCallsFromTruncatedMessage`，`:379-404`）：`stopReason === "length"` 时所有工具调用直接标记失败并附提示让模型重发，因为流式工具参数经过 best-effort JSON 补全解析，可能"看起来合法"但实际不完整。

### 4.5 事件协议（`packages/agent/src/types.ts:431-446`）

```ts
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

三层生命周期：**agent**（一次 run）> **turn**（一次助手响应 + 其工具调用/结果）> **message**（单条消息流式）。事件通过 `AgentEventSink`（`agent-loop.ts:26`）`await` 逐个发出——**事件是顺序的、背压友好的**。

### 4.6 Agent 类：有状态包装（`packages/agent/src/agent.ts`）

裸循环是无状态函数；`Agent` 类（`agent.ts:173`）提供产品级状态管理：

- `AgentState`（`types.ts:334-359`）：systemPrompt/model/thinkingLevel/tools/messages + 运行时只读量（isStreaming/streamingMessage/pendingToolCalls/errorMessage）；
- `PendingMessageQueue`（`agent.ts:125-159`）：两个队列——steering（运行中插话）与 follow-up（停止后接力），支持 `"all"` / `"one-at-a-time"` 两种出队模式；
- `runWithLifecycle`（`agent.ts:486`）：AbortController + 完成承诺，流式期间设置 isStreaming；
- `processEvents`（`agent.ts:544-591`）：先把事件归约进状态（`message_end` push 进 messages、`tool_execution_start/end` 维护 pendingToolCalls 集合、`turn_end` 捕获 errorMessage），再**顺序 await** 每个订阅者；
- `createContextSnapshot`（`agent.ts:437`）：每次 run 前快照 messages/tools，隔离并发修改；
- `createLoopConfig`（`agent.ts:445`）：把所有钩子 + 队列排空接进 `AgentLoopConfig`。

### 4.7 AgentLoopConfig：循环的全部可配置点（`types.ts:149+`）

```ts
// 节选自 packages/agent/src/types.ts
interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;
	convertToLlm: (messages: AgentMessage[]) => Promise<Message[]>; // 自定义消息 → LLM 消息
	transformContext?: (messages, signal) => Promise<AgentMessage[]>; // 上下文变换（压缩）
	getApiKey?: (provider) => Promise<string | undefined>;            // 每次现取（过期 token）
	shouldStopAfterTurn?: (turn) => Promise<boolean> | boolean;       // 提前停止
	prepareNextTurn?: (turn) => Promise<NextTurnSnapshot | undefined>;// 换模型/压缩/换 thinking
	getSteeringMessages?: () => Promise<AgentMessage[]>;              // 运行中插话
	getFollowUpMessages?: () => Promise<AgentMessage[]>;              // 停止后接力
	toolExecution?: "sequential" | "parallel";
	beforeToolCall?: (info, signal) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | void>;
	afterToolCall?: (info, signal) => Promise<Partial<AgentToolResult> | void>;
}
```

每个钩子都在 `runLoop` 的固定位置被调用（见 §4.2 注释）——循环骨架不变形，行为全部通过钩子注入。

---

## 5. 循环结构（二）：`packages/agent` 可持久化 harness 状态机

`src/harness/` 是第二层循环：**存储背书的显式状态机**，目标是崩溃可恢复、工具效果可审计。低层 `runLoop` 的"内存里 while"在这里变成"存储里逐状态推进"。

### 5.1 为什么需要它（问题 → 方案）

问题：低层循环中，"模型想调工具"到"工具结果落盘"之间进程崩溃，重启后无法知道工具到底执行没执行；LLM 流式输出到一半崩溃，partial 丢失。

方案：把一次 run 拆成 13 个**持久状态**，每个状态迁移都先写存储再执行效果（write-ahead），崩溃后从最后状态恢复。代价是复杂度，换来的是 durability。

### 5.2 13 个持久状态（`harness/session/types.ts:316-329`）

```
starting                      run 启动
checkpoint                    轮边界（收件箱规划 / 结束判定）
assistant.ready               准备调 LLM
assistant.effect_pending      LLM 调用进行中（效果未定）
assistant.retry_wait          出错退避等待
tools                         工具批执行中
deferred.suspended            等待提供商侧异步响应
deferred.effect_pending       异步响应取回中
summary.deciding              判断是否需要压缩上下文
summary.ready                 准备生成摘要
summary.effect_pending        摘要生成中
summary.retry_wait            摘要退避
navigation.ready_to_commit    分支导航待提交
```

工具调用内部还有嵌套状态机（`session/types.ts:157-163`）：

```
planned → effect_pending → outcome_ready → completed
```

### 5.3 主分发器 `driveOperation`（`harness/runtime/drive.ts:29-106`）

```ts
export async function driveOperation(lane, drive): Promise<DriveOutcome> {
	let operation = currentOperation(lane, drive);

	for (;;) {
		operation = currentOperation(lane, drive);
		const state = operation.state;
		let result: ProcedureResult;
		try {
			if (state.control.status === "cancel_requested") {
				result = await reconcileOperation(lane, drive); // 取消协调
			} else
				switch (state.at) {
					case "starting":             result = await startRun(lane, drive, state); break;
					case "checkpoint":           result = await runCheckpoint(lane, drive, state); break;
					case "assistant.ready":
					case "assistant.retry_wait": result = await runGeneration(lane, drive, state); break;
					case "assistant.effect_pending":
					                             result = await recoverAssistantGeneration(lane, drive, state); break;
					case "tools":                result = await runTools(lane, drive, state); break;
					case "deferred.suspended":
					case "deferred.effect_pending":
					                             result = await runDeferred(lane, drive, state); break;
					case "summary.deciding":     result = await runStructuralDecision(...); break;
					case "summary.ready":        result = await runStructuralGeneration(...); break;
					case "summary.effect_pending":
					                             result = await recoverStructuralGeneration(...); break;
					case "summary.retry_wait":   result = await runStructuralRetryWait(...); break;
					case "navigation.ready_to_commit":
					                             result = await commitNavigation(...); break;
				}
		} catch (error) { /* AbortRequested → continue */ }

		if (result.kind === "settled") return { kind: "settled", outcome: result.outcome };
		if (result.kind === "waiting") return result.outcome; // 退避等待/挂起
		// 活性守卫：状态没推进就是 bug
		const next = currentOperation(lane, drive).state;
		if (next === state && next.control.status !== "cancel_requested") {
			throw new SessionInvariantError(`Drive procedure made no progress from ${state.at}`);
		}
	}
}
```

这就是 while 循环的**状态机形态**：每次迭代从存储读当前状态 → 执行该状态的 procedure → procedure 内部提交下一次状态迁移 → 循环。末尾的 no-progress 守卫防止死循环。

### 5.4 一轮完整的状态流转

```
starting
  └→ startRun (drive/checkpoint.ts:25)：消费 before_run 钩子，提交注入条目
checkpoint
  └→ runCheckpoint (drive/checkpoint.ts:95)：planBoundaryInbox (drive/boundary.ts:79)
     把 steer/followUp/write 项排入 transcript → 压缩阈值？→ summary.deciding 或 assistant.ready
assistant.ready
  └→ runGeneration (drive/generation.ts:285)：
     prepareGeneration (:68) 解析 model/tools/messages（readBoundedContext 读到上个压缩点）
     publishGenerationIntent (:132) 先持久置为 effect_pending、发 turn_start
     performGeneration (:174) 实际调 LLM（streamHarnessAssistant, execution/assistant.ts:136）
assistant.effect_pending
  └→ publishResponse (drive/response.ts:182) 原子分类结算消息：
       有 toolCall → at:"tools" + ToolBatch（每个调用 planned）     ← ★ 循环回边
       干净停止  → at:"checkpoint" + may_finish
       错误      → assistant.retry_wait（退避）或终态 failed
       deferred  → deferred.suspended
       上下文溢出→ summary.deciding
tools
  └→ runTools (drive/tools.ts:656)：每个调用
       publishToolIntent (:187) 持久置 effect_pending、发 tool_start
       performToolInvocation (:350) 执行工具（支持进度检查点：openToolProgress 把
         部分结果也持久化，崩溃后可作为中断标记恢复）
       publishToolOutcome (:229) 暂存结果、发 tool_end
     全部完成后 materializeReady (tool-placement.ts:280) 按助手原始顺序落 transcript
     commitPlacement (:219-231) → at:"checkpoint" + need_assistant   ← ★ 回到 LLM
checkpoint (may_finish)
  └→ finishRunBoundary (drive/boundary.ts:164)：跑 before_run_end 钩子，查 follow-up 队列
       有 → 回 assistant.ready；无 → 写终态 completed、发 run_end
```

对比 §4.2 的 `runLoop`：**内层 while（工具回边）= tools → checkpoint(need_assistant) → assistant.ready**；**外层 while（follow-up）= finishRunBoundary 查队列后回到 assistant.ready**。语义同构，只是每一步都持久化了。

### 5.5 Session / Lane / 事件

- `Session`（`harness/session/types.ts:530-555`）：树形 transcript（`Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry`），所有变更经 `mutate()` 串行屏障。后端：内存（`memory.ts`）、JSONL（`jsonl/`）、SQLite（独立包）。
- `Lane`（`harness/runtime/lane.ts:221`）：会话内一条对话线。`accept()`（`:480`）持久受理操作；`drive()`（`:921`）安装 Drive 跑 `driveOperation`。
- `HarnessEventBus.emitBatch`（`harness/events.ts:35-46`）：每个事件 `structuredClone` 给每个接收者，经全局 `deliveryTail` 承诺链**串行保序**投递；handler 失败被隔离并报告为 `handler_error`，绝不影响发射方。
- 流式 partial 的持久化：`openAssistantResponse`（`drive/response.ts:46-97`）把每个流事件编码成 `AssistantMessageFrame` 写进 `pendingAssistantFrames` 值列表（`runtime/progress.ts:69`），崩溃后用 `reduceAssistantMessageFrames` 重建 partial。

### 5.6 何时用哪层

| 场景 | 选择 |
|---|---|
| 简单嵌入式 agent、单进程、不要恢复 | `agentLoop` / `Agent` |
| 产品级会话、崩溃恢复、效果审计、远程多客户端 | harness（`createAgentHarness`，`runtime/harness.ts:375`） |

`packages/coding-agent` 的主体走的是 `Agent` + `AgentSession` 路线（轻量），harness 服务于实验性的 server/mini 运行时。

---

## 6. 工具注册机制：从 Tool 接口到 Agent 手里

工具系统是一条**四层接力**：声明（ai 的 `Tool`）→ 运行时（agent 的 `AgentTool`）→ 产品定义（coding-agent 的 `ToolDefinition`）→ 注册（AgentSession 的 `_toolRegistry`）。

### 6.1 第一层：声明式 `Tool`（`packages/ai/src/types.ts:517-522`）

```ts
export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters; // TypeBox schema
	constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

**没有 execute**——pi-ai 是传输层，只负责把工具声明发给模型。参数 schema 用 TypeBox（不是 zod），`Static<TParameters>` 反推 TS 输入类型。

发往 wire 的转换在每个适配器的 `convertTools` 里，例如 Anthropic（`api/anthropic-messages.ts:1425-1462`）：

```ts
return {
	name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
	description: tool.description,
	input_schema: inputSchema,
	...(strict === true ? { strict: true } : {}),
	...(deferLoading ? { defer_loading: true } : {}),        // 延迟加载
	...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
};
```

OpenAI Responses 用 `convertResponsesTools`（`openai-responses-shared.ts:359-396`，支持 `type: "function"` 或 grammar 自定义工具）；Bedrock 用 `convertToolConfig`（`bedrock-converse-stream.ts:1102-1136`）；Google 用 `google-shared.ts:318+`。`constrainedSampling`（`types.ts:507-515`）统一表达 json_schema strict / grammar 两种受约束采样。

### 6.2 第二层：可执行 `AgentTool`（`packages/agent/src/types.ts:386-412`）

```ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
	extends Tool<TParameters> {
	label: string;                     // UI 显示名
	prepareArguments?: (args: unknown) => Static<TParameters>; // 校验前的参数兼容 shim
	execute: (                          // ★ 执行函数（失败要 throw，不编码进 content）
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	replay?: "never" | "safe";         // harness 崩溃恢复策略
	executionMode?: ToolExecutionMode; // "sequential" | "parallel" 每工具覆盖
}
```

返回值（`types.ts:361-376`）：

```ts
export interface AgentToolResult<T> {
	content: (TextContent | ImageContent)[]; // 返回给模型的
	details: T;                              // 给日志/UI 的结构化数据
	usage?: Usage;
	addedToolNames?: string[];               // 延迟工具加载点
	terminate?: boolean;                     // 提前停止提示
}
```

### 6.3 第三层：产品级 `ToolDefinition`（`coding-agent/src/core/extensions/types.ts:451-500`）

coding-agent 在 `AgentTool` 之上再加产品能力：

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	name: string;
	label: string;
	description: string;            // 给 LLM 看
	promptSnippet?: string;         // 自动注入系统提示"Available tools"段的一行摘要
	promptGuidelines?: string[];    // 自动注入系统提示 Guidelines 段的条目
	parameters: TParams;
	constrainedSampling?: false | ConstrainedSamplingConfig;
	renderShell?: "default" | "self"; // TUI 渲染模式
	prepareArguments?: (args: unknown) => Static<TParams>;
	executionMode?: ToolExecutionMode;
	execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext):
		Promise<AgentToolResult<TDetails>>;   // ★ 多了 ExtensionContext（cwd、model 等）
	renderCall?: (args, theme, context) => Component;    // 自定义调用渲染
	renderResult?: (result, options, theme, context) => Component; // 自定义结果渲染
}
```

`ToolDefinition` → `AgentTool` 的适配器（`core/tools/tool-definition-wrapper.ts:5-20`）就是字段搬运 + 把 `ctx` 的获取方式参数化：

```ts
export function wrapToolDefinition(definition, ctxFactory?): AgentTool {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctx ?? ctxFactory?.()),
	};
}
```

### 6.4 内置工具：8 个（`core/tools/index.ts:95-105`）

```ts
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
```

汇总工厂（`index.ts:182-193`）：

```ts
export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}
```

另有快捷组合：`createCodingToolDefinitions`（`:164`，read/bash/edit/write）、`createReadOnlyToolDefinitions`（`:173`，read/grep/find/ls）。

### 6.5 完整工具示例一：read 工具（`core/tools/read.ts` 全 197 行）

**Schema（`:14-18`）**——TypeBox 定义 + 每个字段的 description 会成为模型看到的参数说明：

```ts
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
```

**系统提示贡献（`:20-23`）**——声明式地让系统提示自动带上工具用法：

```ts
export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;
```

**可插拔操作（`:35-48`）**——把副作用抽成接口，本地文件系统只是默认实现（SSH 等远程运行时可替换）：

```ts
export interface ReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};
```

**工厂主体（`:64-193`）**：

```ts
export function createReadToolDefinition(cwd, options?): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). ...`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { path, offset, limit }, signal?, _onUpdate?, ctx?) {
			// 1. 路径解析（ctx?.cwd || cwd）
			const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
			// 2. 可读性检查
			await ops.access(absolutePath);
			// 3. 图片路径：读 buffer → processImage（缩放）→ 返回 ImageContent
			// 4. 文本路径：按 offset/limit 切片 → truncateHead 截断 → 生成
			//    "[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]"
			//    这类可操作续读提示（:159-172）
			return { content, details };
		},
		...readRenderers, // 展开 renderCall/renderResult（TUI 渲染）
	};
}

export function createReadTool(cwd, options?): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
```

值得学习的细节：

- **截断提示是可操作的**：不是简单说"文件太大"，而是告诉模型精确的续读 offset——把失败转化为下一步指令；
- **abort 处理**：注册 `signal` 的 abort 监听，随时可中断（`:87-96`）；
- **非视觉模型降级**：图片附注"当前模型不支持图片，本次请求将省略"（`:57-62`）。

### 6.6 完整工具示例二：bash 工具（`core/tools/bash.ts`）

bash 与 powershell **共用**同一工厂 `createShellToolDefinition`（`:222-373`），只差一个配置对象（`:375-383`）：

```ts
const bashToolConfig: ShellToolConfig = {
	name: "bash", label: "bash", shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(cwd, options?) {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}
```

`execute` 的核心机制（`:239-370`）：

1. `resolveSpawnContext`：拼命令前缀、解析 cwd、暴露 `PI_*` 会话环境变量给子进程；
2. `OutputAccumulator`：流式收集 stdout/stderr，超限截断时**把完整输出持久化到临时文件**；
3. **节流的部分结果更新**（`:260-294`）：`BASH_UPDATE_THROTTLE_MS` 节流，通过 `onUpdate` 回调把实时输出推给 `tool_execution_update` 事件——这就是 TUI 里看到命令输出"打字机效果"的来源；
4. 退出码处理（`:363-365`）：**非零退出码 = throw**（走 `isError: true` 路径），但错误消息里带上完整输出和 `Command exited with code N` 状态行。

### 6.7 注册终点：AgentSession（`coding-agent/src/core/agent-session.ts`）

**注册流程 `_buildRuntime()`（`:2787-2839`）**：

```ts
private _buildRuntime(options): void {
	// 1. 内置工具定义（或 SDK 覆盖集）
	const baseToolDefinitions = this._baseToolsOverride
		? Object.fromEntries(/* AgentTool → ToolDefinition 反向适配 */)
		: createAllToolDefinitions(this._cwd, {
				read: { autoResizeImages },
				bash: { commandPrefix: shellCommandPrefix, shellPath },
			});

	// 2. 加载扩展（扩展可通过 pi.registerTool() 注册工具）
	this._extensionRunner = new ExtensionRunner(extensionsResult.extensions, ...);

	// 3. 默认激活集
	const defaultActiveToolNames = this._baseToolsOverride
		? Object.keys(this._baseToolsOverride)
		: ["read", "bash", "edit", "write"];

	// 4. 刷新注册表
	this._refreshToolRegistry({ activeToolNames: baseActiveToolNames, ... });
}
```

注意默认只激活 4 个工具（read/bash/edit/write），grep/find/ls/powershell 按需加入——控制发给模型的工具数量。

**合并三个来源 `_refreshToolRegistry()`（`:2694-2785`）**：

```
内置定义（createAllToolDefinitions）
  + 扩展注册（ExtensionRunner.getAllRegisteredTools()）   :2702
  + SDK customTools                                        :2705
  → 按 allowedToolNames/excludedToolNames 过滤（allow/deny 列表）:2697-2700
  → wrapRegisteredTools 包装（注入 ExtensionContext 工厂 + 差异追踪 addedToolNames）
  → this._toolRegistry: Map<string, AgentTool>            :2756-2760
  → setActiveToolsByName(...)                             :2784
```

**交给 Agent `setActiveToolsByName()`（`:966-981`）**：

```ts
setActiveToolsByName(toolNames: string[]): void {
	const tools: AgentTool[] = [];
	for (const name of toolNames) {
		const tool = this._toolRegistry.get(name);
		if (tool) { tools.push(tool); }
	}
	this.agent.state.tools = tools;              // ★ 工具正式进入 agent 状态
	// 用新工具集重建系统提示（Available tools 段 + Guidelines 段）
	this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
	this.agent.state.systemPrompt = ...;
}
```

**扩展注册路径**：`pi.registerTool(tool)` → `extensions/loader.ts:287-299`（校验 object schema，存入 `extension.tools`，触发 `runtime.refreshTools()`）→ 被 `getAllRegisteredTools()` 捡起 → 进 `_refreshToolRegistry`。

**CLI 层的开关**：`main.ts:529-539` 支持 `--tools` / `--exclude-tools` / `--no-tools`；`sdk.ts:256-263` 有 `defaultTools` 设置覆盖 + allow/deny 过滤。

### 6.8 工具注册全景图

```
              TypeBox schema + description
                        │
        ┌───────────────┼─────────────────┐
        ▼               ▼                 ▼
  pi-ai Tool       AgentTool         ToolDefinition
  (声明, :517)    (执行, :387)      (产品, ext/types.ts:451)
  发给模型用       循环执行用         +promptSnippet/Guidelines
        │               ▲               +renderCall/renderResult
        │               │ wrapToolDefinition (tool-definition-wrapper.ts:5)
        │               │
        │   createAllToolDefinitions (core/tools/index.ts:182)
        │        + ExtensionRunner.getAllRegisteredTools (:2702)
        │        + SDK customTools (:2705)
        │        - allow/deny 过滤 (:2697)
        │               │
        │      _refreshToolRegistry → _toolRegistry: Map<name, AgentTool> (:2756)
        │               │
        │      setActiveToolsByName (agent-session.ts:966)
        │               │
        └───────► agent.state.tools = tools (:976)
                        │
          Agent.prompt() 快照进 AgentContext.tools (agent.ts:437)
                        │
          runLoop → executeToolCalls → prepare→execute→finalize
                        │
          convertTools (api/anthropic-messages.ts:1425) → 发给模型
```

---

## 7. 端到端数据流：一条消息的完整生命周期

以 TUI 里用户输入"修复这个 bug"为例，完整链路：

```
[用户输入]
  ↓ InteractiveMode → session.prompt()
[AgentSession.prompt] agent-session.ts:1101
  ↓ agent.prompt() + 重试/压缩续跑循环
[Agent.prompt] agent.ts
  ↓ 快照 state.tools/messages → AgentContext；构造 AgentLoopConfig（全部钩子）
[agentLoop → runAgentLoop] agent-loop.ts:32/96
  ↓ 发 agent_start / turn_start / message_start(user)
[runLoop 内层循环] agent-loop.ts:156
  ↓
  ├─ streamAssistantResponse (:279)
  │    ↓ transformContext（压缩）→ convertToLlm（自定义消息过滤）
  │    ↓ StreamFn = modelRuntime.streamSimple 包装（sdk.ts:314-342，含重试/超时/归因头）
  │    ↓
  │  [pi-ai] Models.streamSimple → applyAuth → Provider → api/anthropic-messages.ts
  │    ↓ convertTools (:1425) convertMessages (:1223) → HTTP SSE
  │    ↓ SSE → AssistantMessageEvent 流 → 循环 emit message_start/update/end
  │    ↓ （harness 路径还会把每帧持久化为 AssistantMessageFrame）
  │
  ├─ stopReason === "toolUse"？
  │    ↓ 提取 toolCall 块
  │  [executeToolCalls] agent-loop.ts:409
  │    ↓ prepareToolCall：找工具 → prepareArguments → validateToolArguments → beforeToolCall 钩子
  │    ↓ executePreparedToolCall：tool.execute()，onUpdate 节流推送 partial
  │    ↓ finalizeExecutedToolCall：afterToolCall 钩子可改写结果
  │    ↓ createToolResultMessage → push 进 context.messages
  │    ↓ hasMoreToolCalls = true → ★ 回到循环顶部再调 LLM
  │
  ├─ stopReason === "stop"？
  │    ↓ 内层循环退出 → 查 getFollowUpMessages
  │    ↓ 有 → 外层循环继续；无 → agent_end
  │
  └─ stopReason === "error"/"aborted"？
       ↓ turn_end + agent_end，结束
[Agent.processEvents] agent.ts:544
  ↓ 事件归约进 AgentState（messages/pendingToolCalls/errorMessage）
  ↓ 顺序 await 每个订阅者（AgentSession → TUI 渲染）
```

---

## 8. 设计要点总结

### 8.1 循环继续条件的本质

整个 agent 可以浓缩成一句话：

> **`while (模型还想调工具 or 用户还有话要说)`：调模型 → 执行工具 → 把结果喂回去。**

pi 的实现把"用户还有话说"细分为 steering（运行中插话，下轮注入）与 follow-up（停止后接力，重启循环），并把"模型还想调工具"的安全阀交给 `stopReason`（length → 拒执行全部工具）。

### 8.2 错误处理哲学：一切进流，不炸循环

- provider 层：`StreamFunction` 契约禁止抛异常（auth 缺失除外），错误都是流内 `error` 事件；
- 工具层：`execute` 抛异常 → 捕获 → `isError: true` 的 ToolResultMessage 返回给模型自我纠正；
- 循环层：`stopReason: error/aborted` 是一等公民的退出路径。

### 8.3 严格的双层消息边界

`AgentMessage[]`（会话内）与 `Message[]`（发模型）分离，转换只发生在 `streamAssistantResponse` 的 `convertToLlm` 一处。收益：应用可自由扩展自定义消息类型（declaration merging，`types.ts:303-319`），模型上下文保持最小。

### 8.4 协议封装的可替换性

- `StreamFn` 是低层循环对 pi-ai 的**唯一**依赖点——`agent-proxy.ts`（`src/proxy.ts:120`）实现了把流事件经 HTTP 中继的替代 StreamFn，证明边界干净；
- 每个 API 适配器导出同构的 `ProviderStreams`，新增厂商 = 新增一个 provider 工厂（绑定现有 API）或一个 API 适配器（新 wire protocol）。

### 8.5 工具系统的四层职责

| 层 | 包 | 职责 | 关键点 |
|---|---|---|---|
| 声明 | ai | 发给模型 | TypeBox schema、constrainedSampling |
| 执行 | agent | 循环里跑 | execute/prepareArguments/executionMode/terminate |
| 产品 | coding-agent | UI + 提示词 | promptSnippet/Guidelines 自动注入系统提示、renderers |
| 注册 | AgentSession | 汇总生效 | 内置+扩展+SDK 三源合并、allow/deny、默认激活集精简 |

### 8.6 截断即指令（Truncation as actionable prompt）

read 的 `Use offset=2001 to continue`、bash 的 `Full output: <temp file path>`——所有截断都附带**模型可直接执行的下一步动作**，这是 coding agent 可用性的关键细节。

### 8.7 持久化状态机的取舍

harness 用 13 状态 + write-ahead 换取崩溃恢复与效果审计，代价是显著复杂度。两层循环并存说明：**durability 是可插拔的产品决策，不是 agent 循环的本质复杂度**——先写对内存版 while 循环，再按需上状态机。

---

## 附：快速文件索引

| 主题 | 文件 | 关键位置 |
|---|---|---|
| 主循环 | `packages/agent/src/agent-loop.ts` | `runLoop` :156-273 |
| LLM 调用边界 | `packages/agent/src/agent-loop.ts` | `streamAssistantResponse` :279-370 |
| 工具执行 | `packages/agent/src/agent-loop.ts` | `executeToolCalls` :409-561 |
| AgentTool 类型 | `packages/agent/src/types.ts` | :386-412 |
| AgentEvent 类型 | `packages/agent/src/types.ts` | :431-446 |
| Agent 类 | `packages/agent/src/agent.ts` | :173 |
| harness 主分发 | `packages/agent/src/harness/runtime/drive.ts` | `driveOperation` :29-106 |
| 持久状态定义 | `packages/agent/src/harness/session/types.ts` | `OperationState` :316-329 |
| 统一消息类型 | `packages/ai/src/types.ts` | :351-528 |
| 流式事件类型 | `packages/ai/src/types.ts` | `AssistantMessageEvent` :546-562 |
| EventStream | `packages/ai/src/utils/event-stream.ts` | :26-105 |
| Anthropic 适配器 | `packages/ai/src/api/anthropic-messages.ts` | `stream` :502, `convertTools` :1425 |
| provider 工厂 | `packages/ai/src/providers/anthropic.ts` | :43-59 |
| RPC 信封 schema | `packages/protocol/src/protocol.ts` | 全文 110 行 |
| CBOR/分帧 | `packages/protocol/src/cbor/`, `framing.ts` | — |
| ToolDefinition | `packages/coding-agent/src/core/extensions/types.ts` | :451-500 |
| 内置工具注册表 | `packages/coding-agent/src/core/tools/index.ts` | :95-224 |
| read 工具 | `packages/coding-agent/src/core/tools/read.ts` | 全文 197 行 |
| bash 工具 | `packages/coding-agent/src/core/tools/bash.ts` | `createShellToolDefinition` :222-373 |
| 工具注册进 Agent | `packages/coding-agent/src/core/agent-session.ts` | `_refreshToolRegistry` :2694, `setActiveToolsByName` :966 |
| 主入口 | `packages/coding-agent/src/main.ts` | `main` :562 |
| SDK 组装 | `packages/coding-agent/src/core/sdk.ts` | `createAgentSession` :173-410 |
