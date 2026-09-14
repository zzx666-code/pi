# pi 开源项目架构与目录结构完整指南

> 本文是对 pi 仓库（[github.com/earendil-works/pi](https://github.com/earendil-works/pi)）的整体架构介绍与目录说明。
> 所有引用均标注 `文件路径:行号` 或具体目录，可直接跳转核对。
> 深入的 agent 循环 / 协议封装 / 工具注册机制解析见姊妹篇：[agent-architecture-deep-dive.md](./agent-architecture-deep-dive.md)。

## 目录

1. [pi 是什么](#1-pi-是什么)
2. [Monorepo 总览与依赖分层](#2-monorepo-总览与依赖分层)
3. [各包详解（按层自底向上）](#3-各包详解按层自底向上)
4. [coding-agent 包内部结构（产品层）](#4-coding-agent-包内部结构产品层)
5. [根目录文件与目录说明](#5-根目录文件与目录说明)
6. [工程化体系：构建、测试、质量门禁](#6-工程化体系构建测试质量门禁)
7. [架构设计总结](#7-架构设计总结)

---

## 1. pi 是什么

README.md 第一句：

> **Pi Agent Harness** — This is the home of the Pi agent harness project including our self extensible coding agent.

pi 自我定位是 **"agent harness"（agent 运行具）**，而不只是又一个 CLI 编程助手。核心产品 `pi` 是一个交互式编程 agent 命令行工具，但整个仓库的野心是提供构建 agent 的完整分层积木：LLM 协议层、agent 运行时、终端 UI 框架、组合运行时、远程会话协议。

几个鲜明的设计立场（来自 README 和 CONTRIBUTING.md）：

- **内核极小**："pi's core is minimal" —— 功能尽量做成扩展（extension），不进核心。CONTRIBUTING.md 把这作为贡献哲学的第一条。
- **没有内置权限系统**：不做逐工具审批弹窗，官方推荐用容器/沙箱隔离（Gondolin micro-VM、Docker、OpenShell）。
- **供应链安全极重**：依赖全部精确锁版本、`npm install --ignore-scripts`、发布 CLI 带 npm-shrinkwrap、每日 npm audit、新贡献者 PR 自动关闭需白名单（`lgtm`/`lgtmi` 机制）。
- **"The One Rule"**（CONTRIBUTING.md）：你必须理解你提交的代码——AI 辅助可以，AI 垃圾不行。

作者：Mario Zechner / Earendil Works，MIT 协议，网站 pi.dev。

## 2. Monorepo 总览与依赖分层

npm workspaces monorepo，10 个包 + 1 个后端子目录，全部 ESM（`"type": "module"`）、Node >= 22.19、统一版本 0.85.1、发布在 `@earendil-works` scope 下。

### 2.1 依赖图（运行时依赖，自底向上）

```
第 1 层（叶子，零工作区依赖）
    chord（组合运行时）      telemetry（遥测契约）      tui（终端 UI 框架）

第 2 层
    ai ──────────── telemetry
    protocol ────── chord

第 3 层
    agent (pi-agent-core) ── chord, ai, telemetry

第 4 层
    client ── chord, protocol
    server ── chord, agent, protocol
    session-backends/sqlite-node ── ai, agent

第 5 层（产品）
    coding-agent (pi) ── chord, agent, ai, tui
                        （devDeps: client, protocol, server —— 实验性远程会话功能）

第 6 层（私有）
    evals ── ai, coding-agent（不发布）
```

关键结论：

- **无循环依赖**。根 `package.json` 的 `build` 脚本就是按这个拓扑序串行构建的：`chord → tui → telemetry → ai → agent → sqlite-node → protocol → client → server → coding-agent`。
- **两条栈在 `server` 处交汇**：agent 栈（ai → agent → coding-agent）和远程会话栈（protocol → client/server）本来平行，只在 server（需要托管 Agent 的 Session）和 coding-agent（devDep 方式实验性接入）处连接。
- **`chord` 是被依赖最多的包**（protocol、client、server、agent、coding-agent 都依赖它），是整个 monorepo 的地基。

### 2.2 包一览表

| 包名 | npm 包 | 一句话职责 | 规模 |
|---|---|---|---|
| `packages/chord` | `@earendil-works/chord` | 应用组合运行时：服务组合（DI）、远程服务（RPC）、复制状态（增量 diff） | 26 文件 |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | 厂商无关的遥测契约 + 类型化 schema 工具 | 5 文件 |
| `packages/tui` | `@earendil-works/pi-tui` | 终端 UI 框架，差分渲染 | 44 文件，~2 万行 |
| `packages/ai` | `@earendil-works/pi-ai` | 统一多厂商 LLM API（10 种 wire 协议、40 个厂商） | ~120 文件 |
| `packages/protocol` | `@earendil-works/pi-protocol` | 远程会话 RPC 的 CBOR 信封/分帧协议 | 5 文件 |
| `packages/agent` | `@earendil-works/pi-agent-core` | agent 运行时：低层循环 + 可持久化 harness | 94 文件 |
| `packages/client` | `@earendil-works/pi-client` | 远程会话客户端（传输中立） | 8 文件 |
| `packages/server` | `@earendil-works/pi-server` | 远程会话服务端（实验性） | 17 文件 |
| `packages/session-backends/sqlite-node` | — | SQLite 会话存储后端 | — |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | 产品本体：`pi` CLI（交互/打印/RPC 模式） | 258 ts 文件 |
| `packages/evals` | （私有） | 基于 vitest-evals 的行为评估框架 | — |

## 3. 各包详解（按层自底向上）

### 3.1 `packages/chord` — 组合运行时（地基）

**npm**：`@earendil-works/chord` — "Application composition runtime for services, replicated state, RPC, and plugins"。

它不是简单的 RPC 库，而是三合一：

1. **服务组合（facet/DI）**：`createFacetHost`（`src/api.ts:19`）把多个 `Facet`（声明 `use`/`provide`/`observe` 的组装单元，接口在 `src/types.ts:206-228`）按依赖排序组装成图。`FacetKernel`（`src/facets/host.ts:340`）跑 setup → assembling → connecting 三阶段，支持按 ID 热重载单个 facet。
2. **远程服务（RPC）**：`defineService(id)`（`src/api.ts:77`）定义类型化服务契约（编译期校验成员可 JSON 序列化）；`RemoteServiceProvider`（`src/services/provider.ts:77`）发布实现，`RemoteServiceBindingImpl`（`src/services/consumer.ts:425`）消费。**传输可插拔**：`RemoteServiceTransport`（`src/types.ts:184`）只有 `invoke` + `subscribe` 两个方法，实现者自选传输/分帧/路由。
3. **复制状态**：`replicatedState(initial)`（`src/api.ts:88`）返回可变代理，生产者改完 `publish()` 生成 JSON 增量 op（replace/set/delete/string-append/front-truncate/array-splice，路径驻留编码压缩线上体积），消费端按序 apply。完整规范在 `src/delta/README.md`。

其他目录：`context/`（Go 风格带取消传播的 immutable Context）、`node/`（基于 esbuild 的 facet 打包与运行时加载器）。

外部依赖只有 `esbuild`。

### 3.2 `packages/telemetry` — 遥测契约

**npm**：`@earendil-works/pi-telemetry` — "Vendor-neutral telemetry contracts and typed schema utilities"。

极小（5 文件，零运行时依赖）。定义 `TelemetryContext`/`TelemetrySpan`/`SpanAttributes` 抽象；`createTypedSpanStarter()` 把普通 context 绑定到 `TelemetrySchemaDefinition`（span 名、起止属性、事件签名的 schema），之后 TypeScript 在**编译期**强制 span 名和属性完全匹配——schema 只用于类型，不做运行时校验。自带 NOOP 和内存录制两个参考实现；`./testing` 子导出提供适配器一致性测试套件。

### 3.3 `packages/tui` — 终端 UI 框架

**npm**：`@earendil-works/pi-tui` — "Terminal User Interface library with differential rendering"。

自研 TUI 框架（零工作区依赖），`pi` 交互模式的全部界面都建立在它上面。核心：

- **组件契约**：`Component` 接口（`src/tui.ts:111`）只需 `render(width): string[]`，可选 `handleInput`/`handleMouse`/`invalidate`——一个组件就是"给定宽度返回一组行"的纯函数式渲染单元。
- **差分渲染**：`TuiMainScreen`（`src/tui-main-screen.ts:124`）对主屏 + 滚回区做行级 diff，只重绘变化的行；`TuiAltScreen`（`src/tui-alt-screen.ts:195`）提供备用全屏模式。渲染循环 16ms 节流（`src/tui.ts:465` 的 `TuiBase`）。
- **组件库**（`src/components/`，17 个）：旗舰是 `Editor`（`editor.ts:284`，2100 行——撤销栈、kill-ring、词导航），另有 Markdown 渲染（887 行）、ScrollView、SelectList、HStack/VStack、Loader、Image 等。
- **输入**：Kitty 协议按键解析（`src/keys.ts`，1286 行）、可配置键位（`src/keybindings.ts:231`）、鼠标分发。
- **能力检测**：Kitty/iTerm2 图片协议（`src/terminal-image.ts`）、OSC 11 取配色。
- `native/` 目录含 win32/darwin/linux 剪贴板原生插件（C/Obj-C）。

### 3.4 `packages/ai` — 统一 LLM API

**npm**：`@earendil-works/pi-ai` — "Unified LLM API with automatic model discovery and provider configuration"。

三层结构把 40 家厂商归一到一套消息/流式/工具协议：

| 目录 | 职责 |
|---|---|
| `src/types.ts` | 统一类型：`Message`（user/assistant/toolResult 三角色）、`Context`、`Tool`、`AssistantMessageEvent` 流式事件、10 种 `KnownApi` |
| `src/api/` | **按 wire 协议**划分的适配器（每模块导出同构的 `stream`/`streamSimple`）：anthropic-messages、openai-completions、openai-responses、google-generative-ai、bedrock、mistral、pi-messages 等；配套 `.lazy.ts` 懒加载包装 |
| `src/providers/` | **按厂商**划分的薄工厂（~40 个）：身份 + baseUrl + 认证（API key / OAuth）+ 模型目录 → 绑定到一个 API 适配器 |
| `src/models.ts` | `Provider`/`Models` 运行时：每请求解析认证（`applyAuth`）后分发 |
| `src/models.generated.ts` | 生成的模型目录（由 `scripts/generate-models.ts` 生成，**绝不手改**） |
| `src/auth/` | 凭据存储 + 各家 OAuth（PKCE、device-code 等） |
| `src/utils/` | `event-stream.ts`（手写 push/async-iterate EventStream）、`validation.ts`（TypeBox 工具参数校验/强转）、重试、Unicode 清洗等 |

要点：`StreamFunction` 契约（`types.ts:324-337`）规定错误不抛异常而是编码为流内 `error` 事件；跨厂商规范化（工具调用 ID 重写、非视觉模型图片降级、thinking 跨模型回放）集中在 `api/transform-messages.ts`。

### 3.5 `packages/protocol` — 远程会话传输协议

**npm**：`@earendil-works/pi-protocol`。与 LLM 无关，是**远程 pi 会话**的客户端↔服务端传输协议：

```
应用层消息（Chord RPC 载荷，本层不透明）
   ↓ src/protocol.ts —— TypeBox 信封 schema（PROTOCOL_VERSION = 8，:5）
hello / request / cancel / response / service_update / attachment
   ↓ src/codec.ts —— 校验 + 编解码（有状态流式解码器 :106-137）
CBOR 二进制（手写编解码器，src/cbor/，限 JSON 值域 + DoS 限制：16MiB/1M 元素/深度 64）
   ↓ src/framing.ts —— 4 字节大端长度前缀分帧（增量式容忍分片的 FrameDecoder :44-150）
字节流
```

所有信封都是 `additionalProperties: false` 的严格对象（`protocol.ts:9-10`），未知字段直接校验失败——前后兼容纪律。

### 3.6 `packages/agent` — agent 运行时（核心）

**npm**：`@earendil-works/pi-agent-core` — "Agent runtime with tool calling and state management"。

两层循环实现（详见姊妹篇文档 §4-5）：

| 部分 | 目录/文件 | 内容 |
|---|---|---|
| 低层内存循环 | `src/agent-loop.ts`（803 行） | `runLoop`（:156-273）双层 while：内层 = 工具回边 + steering 插话，外层 = follow-up 接力。工具执行三阶段（prepare → execute → finalize，:607-765），串行/并行双路径 |
| 有状态包装 | `src/agent.ts` | `Agent` 类（:173）：AgentState、steering/follow-up 双队列、事件归约（processEvents :544）、运行快照 |
| 类型 | `src/types.ts` | `AgentTool`（:386）、`AgentEvent`（:431）、`AgentContext`、可扩展的 `AgentMessage` |
| 可持久化 harness | `src/harness/` | 崩溃可恢复的存储背书状态机：13 个持久 `OperationState`（`session/types.ts:316-329`），主分发器 `driveOperation`（`runtime/drive.ts:29-106`）；Session 树形 transcript（内存/JSONL/SQLite 三种后端）；工具调用嵌套状态机 planned → effect_pending → outcome_ready → completed |
| 内置工具 | `src/harness/tools/` | bash/read/write/edit/edit-diff/image 等 harness 版工具（与 coding-agent 的产品版工具区分） |
| 搜索 | `src/search/` | 会话搜索服务接口 |

### 3.7 `packages/client` / `packages/server` — 远程会话两端（实验性）

**`client`**（`@earendil-works/pi-client`，8 文件）：传输中立的远程会话客户端。`Client` 类（`src/client.ts:62`）做握手、请求/响应关联、服务订阅（含排队 + 就绪门控）；`createClientServiceTransport()`（`src/client.ts:448`）把客户端适配成 Chord 的 `RemoteServiceTransport`——本地 facet 透明消费远程服务。`src/transport.ts` 定义 `ByteTransport` 抽象（任意有序字节管道即可）；`./unix` 子导出提供 Unix domain socket 传输与服务器发现（win32 不支持）。

**`server`**（`@earendil-works/pi-server`，17 文件）：远程会话服务端。`Server` 类（`src/server.ts:46`）管理监听器、握手超时、连接注册；核心是 `SessionRouter`（`src/session-router.ts:34`）——多会话路由、客户端 attachment 租约（acquire/release）、按客户端串行化的操作队列。`ServerHost`（`src/types.ts:59`）是应用挂钩（`resolveSession`/`openSession`）。`transports/unix/` 是 socket 监听实现（含陈旧 socket 清理）；`./testing` 提供可脚本化的测试替身。

两者在 coding-agent 中仅作为 **devDependencies**，供 `src/experimental/` 的远程会话实验（session-worker、mini 运行时、radius-relay）使用。

### 3.8 `packages/session-backends/sqlite-node` — SQLite 会话后端

agent harness `Session` 存储接口的 Node SQLite 实现（依赖 ai + agent），为 JSONL/内存后端之外的持久化选项。

### 3.9 `packages/evals` — 评估框架（私有，不发布）

**`@earendil-works/pi-evals`** — 基于 Sentry 的 `vitest-evals` 的行为评估框架：

- `src/pi-harness.ts`：把真实 `AgentSession` 适配成 vitest-evals harness，在隔离的临时项目/agent 目录中运行，快照原生会话 JSONL；
- 支持单步/多步（含 reload）提示词、按 harness 选模型（`PI_PROVIDER`/`PI_MODEL`）；
- `evalHarnessTable` 做 A/B 对比评估（基线 vs 候选），报告通过率提升、token/延迟/成本差值，支持重复实验；
- `src/*.eval.ts`：smoke、docs、models、extensions、providers 五个评估套件；
- 入口：`npm run eval`（`scripts/run-evals.mjs`）。

## 4. coding-agent 包内部结构（产品层）

`packages/coding-agent`（npm 名 `pi-coding-agent`，bin 名 `pi`）是用户实际安装的东西，258 个 TS 文件：

```
packages/coding-agent/
├── src/
│   ├── main.ts / cli.ts        # 入口：main() 解析参数 → 选模式（interactive/print/rpc/json）→ 组装
│   ├── index.ts                # SDK 公共导出（evals 从这里 import AgentSession/ModelRuntime）
│   ├── core/                   # ★ 核心业务
│   │   ├── agent-session.ts    # 中央会话类（3552 行）：工具注册表、事件总线、系统提示组装
│   │   ├── sdk.ts              # createAgentSession() 工厂：组装 Agent + AgentSession + ModelRuntime
│   │   ├── model-*.ts          # 模型运行时/注册表/解析器
│   │   ├── tools/              # ★ 8 个内置工具（read/bash/powershell/edit/write/grep/find/ls）
│   │   │   ├── index.ts        #   注册表：createAllToolDefinitions :182、默认激活集
│   │   │   └── renderers/      #   各工具的 TUI 渲染器
│   │   ├── extensions/         # 扩展系统：加载器、运行器、ToolDefinition 类型
│   │   ├── compaction/         # 上下文压缩
│   │   ├── skills.ts / slash-commands.ts / prompt-templates.ts
│   │   ├── settings-*.ts / trust-manager.ts / project-trust.ts
│   │   ├── session-manager.ts / session-export.ts   # 会话持久化（JSONL）与导出
│   │   ├── system-prompt.ts    # 系统提示构建
│   │   └── export-html/        # 会话导出为 HTML
│   ├── modes/                  # 运行模式
│   │   ├── interactive/        # TUI 交互模式（components/、theme/）
│   │   ├── print-mode.ts       # 非交互单次执行（可管道）
│   │   ├── rpc/                # JSON-RPC 模式（IDE/程序化接入）
│   │   └── json-event.ts       # JSON 事件流输出
│   ├── cli/                    # 启动期 UI：参数解析、auth 命令、setup 向导、模型列表
│   ├── experimental/           # 实验区：mini 运行时、session-worker、服务化、radius
│   ├── extensions/llama/       # 内置的本地 llama 扩展
│   ├── utils/                  # git、shell、图片、MIME、路径等 ~30 个工具模块
│   ├── client/                 # 远程会话客户端 SDK 再导出
│   └── bun/                    # Bun 运行时 shim
├── examples/
│   ├── extensions/             # 5 个示例扩展（也注册为 workspace，测试带依赖的扩展）：
│   │                           #   with-deps、custom-provider-anthropic、
│   │                           #   custom-provider-gitlab-duo、sandbox、gondolin
│   ├── plugins/ 和 sdk/        # 插件与 SDK 使用示例
├── docs/                       # 用户文档（扩展开发、工具、模型配置等）
├── scripts/                    # 打包（esbuild bundle）、shrinkwrap 生成
├── test/                       # 测试（含 suite/ 回归测试 + faux provider 假 LLM）
└── install-lock/               # 安装锁
```

发布形态值得注意：npm 上发布的 `pi` **不是散的 tsc 产物**，而是 esbuild 单文件 bundle（bin: `dist/bundle/cli.js`），发布时附带 `npm-shrinkwrap.json`（由根 lockfile 生成，带生命周期脚本依赖白名单）——供应链加固的一环。`build:binary` 用 `bun build --compile` 产出完全独立的可执行文件。

## 5. 根目录文件与目录说明

```
pi/
├── packages/                  # 全部工作区包（见上文）
│   └── session-backends/      # 会话存储后端子 workspace
├── scripts/                   # ~40 个构建/检查/分析脚本（见下）
├── .github/                   # CI 与治理
│   ├── workflows/
│   │   ├── ci.yml             # push/PR：npm ci --ignore-scripts → build → check → test
│   │   ├── pr-gate.yml        # pull_request_target：非白名单贡献者 PR 自动关闭
│   │   ├── issue-gate.yml / issue-analysis.yml / issue-triage-labels.yml
│   │   │                      # issue 治理：/is 分析工作流（用 pi 自身分析 issue）
│   │   ├── build-binaries.yml # v* tag：Bun/Node 独立二进制 + SHA256SUMS + draft release
│   │   ├── npm-audit.yml      # 每日定时 npm audit --omit=dev
│   │   └── publish-model-catalog.yml
│   ├── ISSUE_TEMPLATE/        # bug / contribution / package-report 三种模板
│   └── APPROVED_CONTRIBUTORS  # 贡献者白名单
├── .husky/pre-commit          # 提交前钩子（见 §6.3）
├── .pi/                       # ★ 用 pi 开发 pi：本仓库自己的 agent 配置
│   ├── skills/                #   release.md、interactive-testing.md、add-llm-provider.md
│   │                          #   （AGENTS.md 引用的技能，AI 助手按流程加载）
│   ├── prompts/               #   斜杠命令提示词：/is、/wr、/cl、/pr、/sa、/deslop
│   │                          #   （issue-analysis.yml 工作流跑的就是 /is）
│   └── extensions/            #   开发用扩展：tps、redraws、prompt-url-widget 等
├── package.json               # pi-monorepo（私有）：workspaces、拓扑序 build、check 脚本
├── tsconfig.json / tsconfig.base.json
├── biome.json                 # Biome lint + 格式化（tab 缩进、行宽 120）
├── vitest.base.ts             # 共享 vitest 配置：所有 @earendil-works/* 别名到 src/
├── test.sh                    # 无菌环境跑测试（env -i，无 API key 时 e2e 自动跳过）
├── mini-test.sh               # 跑 experimental/mini 的集成冒烟
├── pi-test.sh / .ps1 / .bat   # 从源码运行 pi（--no-env 清除 ~40 个厂商凭据变量）
├── AGENTS.md                  # 给 AI 助手的开发规则（本仓库的 agent 行为准则）
├── CONTRIBUTING.md            # 贡献哲学与门槛（lgtm/lgtmi 机制）
├── SECURITY.md / LICENSE / README.md
└── tui-plan.md                # TUI 设计笔记
```

**`scripts/` 按用途分组**：

| 组 | 脚本 | 作用 |
|---|---|---|
| 构建发布 | `build-binaries.sh`、`build-coding-agent-bundle.mjs`、`release*.mjs`、`publish.mjs` | esbuild bundle、Bun 独立二进制、发布流水线 |
| 供应链检查 | `check-pinned-deps.mjs`、`check-runtime-deps.mjs`、`check-ts-relative-imports.mjs`、`check-entry-graphs.mjs`、`check-browser-smoke.mjs`、`check-lockfile-commit.mjs`、`generate-coding-agent-shrinkwrap.mjs` | 依赖必须精确锁版本、禁止危险 import 形态、lockfile 纪律 |
| 模型数据 | `diff-model-catalog.mjs`、`publish-model-catalog.mjs`、`generate-thinking-capabilities.mjs` | 维护生成的模型目录 |
| 分析工具 | `cost.ts`、`stats.ts`、`tool-stats.ts`、`session-transcripts.ts`、`session-context-stats.mjs` | 会话/成本/工具使用统计 |

## 6. 工程化体系：构建、测试、质量门禁

### 6.1 TypeScript 配置

- **编译器是 `tsgo`**（TypeScript native preview 7.0.0-dev），`--noEmit` 类型检查。
- `tsconfig.base.json`：ES2022、strict、**`erasableSyntaxOnly: true`**——只允许可擦除语法（Node strip-only 模式直接跑 TS 源码），因此全库禁用 `enum`/`namespace`/参数属性等需要发射的构造（AGENTS.md 也明文规定）。
- import 必须带显式 `.ts` 扩展名（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）。
- 根 `tsconfig.json` 把每个 `@earendil-works/*` 包映射到其 `src/`——跨包 import 直接对着源码做类型检查。

### 6.2 测试

- **Vitest 4**（除 `packages/tui` 用 `node:test`）；`vitest.base.ts` 把包名别名到源码路径，测试永远跑 src 而非 dist。
- `test.sh` 在**完全消毒的环境**（`env -i`、隔离 HOME/TMPDIR、`PI_NO_LOCAL_LLM=1`）中跑——没有 API key 时 e2e/真实 LLM 测试自动跳过，本地测试永不烧 token。
- `packages/coding-agent/test/suite/` 回归测试用 `harness.ts` + **faux provider**（假 LLM，可脚本化响应），绝不调真实 API。
- `packages/evals` 提供模型在环的行为评估（可选，`npm run eval`）。
- 脚本自测试：`npm run test:scripts`（node:test）。

### 6.3 质量门禁（`npm run check`，pre-commit 强制）

1. Biome lint + 格式化；
2. 6 个自定义检查脚本（依赖锁版本、运行时依赖、相对 import 形态、入口图、浏览器冒烟、lockfile 提交纪律）；
3. `tsgo --noEmit` 全量类型检查；
4. `.husky/pre-commit`：lockfile 提交需 `PI_ALLOW_LOCKFILE_CHANGE=1`（多 AI 会话并行开发时的防误伤设计）→ 全量 check → 条件性浏览器冒烟 → 格式化文件重新入暂存区。

### 6.4 CI（`.github/workflows/ci.yml`）

push/PR 到 main：安装系统依赖（cairo/pango/fd/ripgrep）→ `npm ci --ignore-scripts` → 构建 → `npm run check` → `npm test`，Node 22。

### 6.5 治理自动化

- `pr-gate.yml`：非白名单新贡献者的 PR 自动关闭（防 AI 垃圾灌注）；维护者用 `lgtmi`/`lgtm` 回复放行。
- `issue-analysis.yml`：给 issue 打标签后，用仓库里的 `/is` 提示词跑 pi 自身做自动分析并回帖（dogfooding：pi 分析 pi 的 issue）。
- `npm-audit.yml`：每日审计。
- `.pi/` 目录本身也是 dogfooding——这个仓库用 pi 开发 pi，`AGENTS.md` 约束 AI 助手行为，`.pi/skills/` 存放发布流程等技能。

## 7. 架构设计总结

### 7.1 分层积木而非单体

普通 coding agent 项目（如单包 CLI）把"循环 + LLM 调用 + 工具 + UI"写在一起。pi 反其道而行：**每一层能力都是独立可发布的包**——你要做自己的 agent，可以只用 pi-ai；要 TUI，可以只用 pi-tui；要组合运行时，chord 单独可用。coding-agent 只是这些积木的一种组装方式。代价是包间协议的维护成本，收益是整个生态的复用性（evals、server、实验性 mini 运行时都是不同组装的产物）。

### 7.2 关键边界

| 边界 | 位置 | 为什么重要 |
|---|---|---|
| 会话消息 vs LLM 消息 | `agent-loop.ts:293` 的 `convertToLlm` | 应用可扩展自定义消息类型而不污染模型上下文 |
| 声明 vs 执行 | `Tool`（ai）vs `AgentTool`（agent） | 协议层保持纯净，执行语义归运行时 |
| 传输 vs 语义 | `protocol` 信封中 `call` 载荷不透明 | LLM 消息无需感知就穿过 RPC 层 |
| 循环 vs 持久化 | 低层 `runLoop` vs harness 状态机 | durability 是可插拔决策而非本质复杂度 |

### 7.3 自举与自动化治理

这个仓库最独特的地方：**pi 用自己开发自己**——`.pi/` 的技能与提示词、`AGENTS.md` 的 AI 行为规则、issue-analysis 工作流让 pi 分析 pi 的 issue、pre-commit 防多 AI 会话互踩。整个工程化体系（自动关 PR、依赖锁、每日审计、无菌测试环境）明显是为"人 + AI 协作开发"设计的，而不是传统纯人类协作。

### 7.4 一图流

```
                        用户
                         │
                   pi CLI (coding-agent)
                    ┌────┴────────────────────────┐
                    │ AgentSession（会话/工具注册） │
                    │   modes: TUI│print│RPC│json  │
                    ├──────────────────────────────┤
                    │ Agent / agent-loop（循环）    │──── harness（持久化状态机）
                    ├──────────────────────────────┤
                    │ pi-ai（统一 LLM 协议）        │──── telemetry
                    ├──────────────────────────────┤
                    │ pi-tui（终端渲染）            │
                    ├──────────────────────────────┤
                    │ chord（组合/RPC/复制状态）    │
                    ├──────────────────────────────┤
                    │ protocol（CBOR 分帧）→ client/server（远程会话，实验）│
                    └──────────────────────────────┘
```

---

## 附：包速查表

| 想了解… | 看哪里 |
|---|---|
| agent 主循环 | `packages/agent/src/agent-loop.ts:156`（`runLoop`） |
| 工具注册 | `packages/coding-agent/src/core/tools/index.ts:182` + `agent-session.ts:2694` |
| LLM 协议适配 | `packages/ai/src/api/anthropic-messages.ts:502`（同构模板） |
| 流式事件 | `packages/ai/src/types.ts:546`（`AssistantMessageEvent`） |
| TUI 组件契约 | `packages/tui/src/tui.ts:111`（`Component`） |
| 远程会话协议 | `packages/protocol/src/protocol.ts`（全文 110 行） |
| 组合运行时 | `packages/chord/src/api.ts` + `src/types.ts` |
| 持久化状态机 | `packages/agent/src/harness/runtime/drive.ts:29` |
| 评估框架 | `packages/evals/src/pi-harness.ts` |
| 工程门禁 | 根 `package.json` 的 `check` 脚本 + `.husky/pre-commit` |
