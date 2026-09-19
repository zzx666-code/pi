# 已实现功能

## 项目定位

这是一个基于 Pi Agent Core 的电商智能客服示例。模型不能直接读写数据库，只能通过受控工具获取商品、库存、订单和售后政策，并在明确的安全边界内创建订单草稿、提交退款申请或发起转人工。最终下单必须由客户在界面确认，退款是否通过由人工审批，转人工后由坐席在独立的工作台接管会话。

## 用户侧能力

| 功能 | 当前行为 |
| --- | --- |
| 商品搜索 | 根据用户描述查询可售商品，并返回 SKU、名称和价格。 |
| 库存查询 | 按 `SKU + 地区` 查询实时可售库存。库存数据来自 `inventory` 表。 |
| 订单列表 | 列出当前已认证用户最近的订单（订单号、状态、金额、商品），按提交时间从新到旧。 |
| 订单查询 | 按订单号查询订单，也接受刚创建的订单草稿号。仅能查询当前已认证用户自己的订单。 |
| 售后政策问答 | 对退款、配送、保修等问题调用 MySQL 知识库检索，并基于检索结果回答。 |
| 创建订单草稿 | 用户提供 SKU、地区和数量后创建草稿；价格由服务端商品目录重新计算。 |
| 确认并提交订单 | 用户必须在界面点击确认。服务端再次校验库存，并在事务中扣减库存、创建订单。确认入口是聊天记录里的订单确认卡片；刷新页面或重新打开会话时会从会话记录中恢复该卡片，不会丢失待确认状态。 |
| 提交退款申请 | 分两步。模型调用 `create_refund_draft` 只写入 `refund_drafts` 草稿，按下单时间判断资格并返回 `requiresConfirmation=true`；客户在聊天记录里的“退款申请待确认”卡片上点击后，才由客户端调用确认接口写入 `refund_requests`（状态 `pending_review`）。超过 7 天返回 `eligible=false` 且不写草稿。模型不能审批、不能承诺退款金额或到账时间。同一订单重复提议复用同一草稿，重复确认返回同一条申请。 |
| 撤销退款申请 | 客户改主意时可以撤回自己尚未开始打款的申请（`pending_review`、`handed_off`）。撤销后订单不再被占用，可以重新提交一条新的申请。已通过审核的申请无法撤销，接口会返回原因和当前状态。 |
| 查询退款进度 | 列出当前用户的退款申请（状态、金额、原因、提交时间、最后一次状态变更时间），可按订单号过滤。只返回客户可见字段，审核人身份和内部备注不下发。 |
| 转人工 | 投诉、敏感操作、重复失败或用户明确要求时调用 `handoff_to_human` 创建工单；工单保存来源会话，因此坐席能看到完整对话上下文。同一会话已有未关闭工单时返回同一张，不会在坐席队列里产生重复条目。 |
| 人工接管 | 坐席认领工单后会话进入人工接管：模型不再回答，客户的新消息直接留给坐席；工单关闭后模型恢复回答，并且能看到人工此前说过什么。客户页面通过轮询自动显示接管状态，客户不需要刷新或再发消息。 |
| 人工回复 | 坐席的回复写入客户原会话，客户页面在几秒内自动显示，无需刷新；消息标注“人工客服 + 姓名”，与模型回复在样式和署名上区分。 |
| 流式对话 | Web 界面通过 SSE 展示模型回复与工具执行状态；会话被人工接管时发送 `handover` 事件，页面据此立即显示接管提示。 |
| 历史会话 | 左栏列出当前用户的历史会话（按最近活动排序，标题取首条提问），点击可加载该会话的消息；打开页面默认恢复最近一次会话。左栏会话列表与右侧消息区各自独立滚动。 |

## Agent 工具

工具定义位于 `src/core/tools/`，每个工具一个文件，`index.ts` 负责汇总。

| 工具 | 写操作 | 说明 |
| --- | --- | --- |
| `search_products` | 否 | 查询商品目录。 |
| `get_inventory` | 否 | 查询指定 SKU、地区的库存。 |
| `list_orders` | 否 | 列出当前用户最近的订单，用户未提供订单号时使用。 |
| `get_order` | 否 | 按订单号或订单草稿号查询当前用户订单。 |
| `search_knowledge_base` | 否 | 检索退款、配送、保修知识库。 |
| `create_order_draft` | 是 | 创建待确认订单草稿，不会正式下单。 |
| `create_refund_draft` | 是 | 创建退款申请草稿，不会提交申请；7 天窗口由服务端判定，模型只负责解释结果。 |
| `cancel_refund_request` | 是 | 撤销当前用户尚未开始打款的退款申请，撤销后订单可重新申请。 |
| `list_refund_requests` | 否 | 查询当前用户的退款申请进度，可按订单号过滤。 |
| `handoff_to_human` | 是 | 创建人工客服工单，并把工单与当前会话关联；同一会话已有未关闭工单时复用该工单。 |

模型没有“直接提交订单”的工具，也没有任何“审批退款”或“处理工单”的工具：正式下单由 Web 界面的确认操作完成，退款状态只由服务端的人工审批接口推进，工单只由坐席接口认领与关闭。

## 退款申请状态机

状态名同时用于 MySQL ENUM、HTTP 接口、Agent 工具返回值，定义在 `src/domain/refund-status.ts`。

| 状态 | 含义 | 可流转到 |
| --- | --- | --- |
| `pending_review` | 待处理：申请已受理，等待人工审批 | `handed_off`、`approved`、`rejected`、`cancelled` |
| `handed_off` | 已移交人工客服跟进 | `approved`、`rejected`、`cancelled` |
| `approved` | 审核通过，等待退款执行 | `refunded`、`failed` |
| `refunded` | 退款成功（终态） | 无 |
| `rejected` | 审核未通过（终态） | 无 |
| `failed` | 退款执行失败（终态） | 无 |
| `cancelled` | 客户撤销申请（终态） | 无 |

- 只有“申请成功”是事件而不是状态：它把申请推进到 `pending_review`。
- `approved` 与 `refunded` 分开，是因为“审核通过”和“钱到账”是两件事，中间支付渠道可能失败。
- 非法流转在领域层被拒绝（例如 `pending_review` 直接跳 `refunded`），终态不能再被修改；客户被驳回后想再退，只能重新提交一条新申请。
- `cancelled` 只能从还没开始打款的状态进入。`approved` 之后钱已在路上，撤回要与支付侧协调，不属于客服系统的职责，因此接口会返回 `cancelled=false` 并说明原因。
- 状态由内部接口 `POST /refund-requests/:id/status` 推进，需要 `x-internal-token`，供支付回调或运维脚本调用。坐席工作台目前只处理人工工单，不处理退款审批，所以演示时需要手动调用该接口。

## 人工工单状态机

状态名同时用于 MySQL ENUM、HTTP 接口和工具返回值，定义在 `src/domain/support-ticket.ts`。

| 状态 | 含义 | 可流转到 |
| --- | --- | --- |
| `open` | 待认领：客户已转人工，还没有坐席接手 | `assigned` |
| `assigned` | 人工处理中：某位坐席已认领，会话进入人工接管 | `closed` |
| `closed` | 已关闭（终态）：处理完毕，会话交还智能客服 | 无 |

- 认领与关闭都使用比较并交换（`WHERE id = ? AND status = ?`），两位坐席同时认领同一张工单时只有一个成功，另一位收到 409。
- 一个会话最多只有一张未关闭的工单：`support_tickets.active_conversation_id` 是生成列（`status <> 'closed'` 时取 `conversation_id`，否则为 NULL），上面建了唯一索引。重复转人工因此撞索引而不是新建一行，读回赢家后返回同一张工单；关闭后生成列变 NULL 自动释放名额，客户可以重新转人工。
- 该生成列必须是 `VIRTUAL` 而不是 `STORED`：`conversation_id` 上有一个 `ON DELETE SET NULL` 外键，MySQL 禁止在带这类外键的列上建立存储生成列，加列时会直接报 `ER_CANNOT_ADD_FOREIGN`。
- 只有已认领的工单才能关闭，因此不会出现“没有任何人处理过就被关掉”的工单。
- 关单即结束：需要再次服务时新建一张工单，而不是把旧工单改回中间状态。

## 坐席工作台

坐席界面在 `http://127.0.0.1:5134`，是同一份源码上的第二个 Vite 入口（`desk.html` + `vite.desk.config.ts`），随 `run.ps1` 与其余服务一起启动。首次进入需要填写内网 token 和工号，两者都保存在浏览器 localStorage；token 失效会自动退回登录页。

界面提供：按 `open` / `assigned` / `closed` 过滤的工单队列、工单摘要与状态、客户完整会话、认领、回复和关闭。队列与会话每 5 秒自动刷新，新转人工的工单会自己出现在队列里；打开工单时滚到最新消息，轮询刷新不会打断坐席正在翻阅的历史位置。

### 坐席接口

工作台调用的接口挂在 Agent API（`3100`）上，因为它们要把回复写进客户会话。全部需要 `x-internal-token`（默认取 `COMMERCE_INTERNAL_TOKEN`，可用 `DESK_TOKEN` 单独覆盖），且都没有对应的 Agent 工具：

| 接口 | 作用 |
| --- | --- |
| `GET /api/support-tickets?status=open&limit=20` | 列出工单，可按状态或 `conversationId` 过滤 |
| `GET /api/support-tickets/:id` | 查看单张工单，含来源会话 |
| `GET /api/support-tickets/:id/messages` | 读取该工单来源会话的完整对话；工单没有关联会话时返回空数组 |
| `POST /api/support-tickets/:id/claim` | 认领，body 为 `{ "assignee": "客服小李" }` |
| `POST /api/support-tickets/:id/reply` | 回复客户，body 为 `{ "text": "..." }`，写入原会话 |
| `POST /api/support-tickets/:id/close` | 关闭，body 为可选的 `{ "note": "..." }` |

`reply` 必须发生在认领之后，署名取自工单的认领人而不是请求体。坐席不持有客户 JWT，因此会话读取走 `/api/support-tickets/:id/messages`，而不是客户侧的 `/api/conversations/:id/messages`；会话从工单反解，坐席读不到自己没有工单的会话。

没有工作台界面时这些接口也可以用 curl 直接调用，见 README。

### 坐席操作审计

坐席的认领、回复和关闭都写入 `desk_audit_logs`。它与 `tool_audit_logs` 同构，但主体不同：后者回答“模型调用了什么”，前者回答“谁动了这个客户的工单”。

| 列 | 含义 |
| --- | --- |
| `ticket_id` | 被操作的工单 |
| `conversation_id`、`user_id` | 客户与来源会话。`started` 那行为空，因为路由此时只拿到工单号 |
| `assignee` | 操作人。取自工单或请求，不取请求体里的署名 |
| `action` | `claim`、`reply`、`close` |
| `status` | `started`、`succeeded`、`rejected` |
| `error_code` | 被拒绝的原因，例如重复认领是 `TICKET_NOT_OPEN` |
| `duration_ms` | 动作耗时，认领包含一次跨服务调用 |

- **先写意图再执行**：`started` 在动作之前落库，所以动作中途失败仍留下“有人开始做这件事”的证据；如果连这条都写不进去，动作不会执行。
- **被拒绝的尝试同样记录**，这是审计最有价值的部分——它能回答“为什么这位坐席没能接手这张工单”，而不只是“谁成功了”。
- **读取刻意不审计**：工作台每 5 秒轮询队列和会话，记录这些读操作会淹没真正的动作。
- 表故意不加外键：审计行要比它描述的对象活得久，工单或会话被清理后记录仍应可查。

## 安全与一致性控制

- 用户身份由 Agent API 的 JWT 解析后注入工具上下文；模型不能传入或伪造 `userId`。
- 订单草稿使用服务端商品价格，忽略客户端伪造价格。
- 库存创建草稿时会预检查；提交订单时会在 MySQL 事务中以 `FOR UPDATE` 锁定库存并再次校验。
- 订单提交需要幂等键，同一个请求重复提交不会产生重复订单。
- 退款资格由服务端按下单时间判定，模型不参与“是否退款”的决策；写入的申请只进入待处理状态。
- Agent 网关没有退款审批方法，工具集合中也没有审批工具，模型无法绕过人工审批（有测试固定该工具集合）。
- 退款申请走两段式：Agent 网关只暴露 `proposeRefund`，工具集合里只有 `create_refund_draft`，写入的是草稿；把草稿变成正式申请的 `POST /refund-drafts/:id/confirm` 要求客户 JWT，模型拿不到。所以模型可以提议退款，但不能单方面产生一条申请。
- 退款状态更新使用 `WHERE id = ? AND status = ?` 的比较并交换，两个审批人同时操作不会互相覆盖。
- `refund_requests.active_order_id` 唯一索引保证同一订单不会出现两条未结束的退款申请；`cancelled` 不在该生成列的取值内，所以撤销即释放订单。
- 撤销走 `POST /refund-requests/cancel` 并按 `x-user-id` 校验归属，客户不能撤销他人的申请，也不经过坐席使用的内部令牌。
- 坐席接口只认内部令牌，不绑定客户身份；模型没有认领、回复或关闭工单的工具，只能开单。
- 坐席的认领、回复和关闭先写审计意图再执行：审计写不进去的动作根本不会发生，因此不存在“做了但没记录”的窗口。
- 工单创建幂等由 `support_tickets.active_conversation_id` 唯一索引保证：应用层的“先查再建”在并发下必然漏，索引不会。没有会话的老工单（`conversation_id` 为 NULL）不受约束。
- 坐席读取会话必须经由工单：会话 id 由工单反解，坐席读不到自己没有工单的对话。
- 客户侧的接管状态由服务端按“是否存在指向该会话的 assigned 工单”现算，客户端不能自行声明已转人工。
- 人工接管判定在会话并发锁之内完成：认领不会与模型的回答同时在途，避免人机同时回复。
- 人工回复的署名取自工单认领人，请求方不能冒用他人身份。
- 会话写入使用增量追加而不是全量覆盖，模型回答结束时不会删掉坐席在此期间写入的回复。
- 未认领的工单不会被回复，也不会有人工消息进入会话。
- 用户确认前，草稿不会提交；确认后的订单状态和库存扣减由同一个业务事务完成。
- 业务拒绝（`CommerceHttpError`）在工具层被重写成「原始原因｜代码｜下一步」，因为运行时只把 `message` 交给模型：不带上代码和指引，模型看到「Only 6 units are available」只能猜是该重试、改数量还是转人工。基础设施故障不改写，保留原样让运行时如实标记为错误。
- 对话消息、工具调用参数、结果、成功/失败状态和耗时都会写入 MySQL 审计表。
- 知识库内容被当作参考资料，不能覆盖系统安全规则。

## 数据与基础设施

### MySQL

Docker Compose 只运行 MySQL，主机端口为 `3307`，容器内端口为 `3306`。主要表包括：

- `products`：商品目录
- `inventory`：按 `sku + region` 存储库存
- `order_drafts`、`order_draft_items`：订单草稿
- `orders`、`order_items`：已提交订单
- `refund_requests`：退款申请当前状态、下单时间快照和最后一次状态变更（`last_transition_at/by/note`）
- `refund_drafts`：模型提议但客户尚未确认的退款申请，只标记是否已被确认
- `support_tickets`：人工工单，含来源会话、认领人、认领/关闭时间和关闭备注；`active_conversation_id` 生成列加唯一索引，约束一个会话只有一张未关闭工单
- `conversations`、`conversation_messages`：会话与消息
- `tool_audit_logs`：模型工具调用审计日志
- `desk_audit_logs`：坐席操作审计日志，记录谁在什么时候对哪张工单做了什么、结果如何
- `knowledge_documents`：售后知识库分片
- `schema_migrations`：已应用的迁移文件名

初始化 SQL 显式使用 `utf8mb4`，防止中文地区和商品数据出现乱码。

### 数据库迁移

`migrations/*.sql` 按文件名顺序执行，每个文件执行成功后把文件名写入 `schema_migrations`，所以 `npm run db:migrate` 可以重复运行。

`001_initial.sql` 是幂等基线（全部使用 `CREATE TABLE IF NOT EXISTS` 与 `ON DUPLICATE KEY UPDATE`）。**表结构变更必须写成新的编号文件并使用 `ALTER TABLE`**：MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`，这类语句的幂等性由版本表保证，而不是由 SQL 本身保证。`002_support_ticket_conversation.sql` 就是这样一个例子。

### 知识库

当前知识库使用 MySQL 的 `LIKE` 检索，适合示例中的少量固定政策文档。执行以下命令可将 `knowledge/` 目录下的 Markdown 分片后写入数据库：

```powershell
npm run knowledge:ingest
```

可用以下命令验证检索：

```powershell
npm run knowledge:verify -- 配送
```

知识库网关遵循 `KnowledgeGateway` 接口；未来可替换为 Milvus 向量检索，而不改动 Agent 工具和业务 API。

## 运行入口

一键启动（含 MySQL、迁移、知识库和四个服务）：

```powershell
cd packages/customer-service-agent
.\run.ps1              # 完整启动并打开客户页面
.\run.ps1 -SkipSeed    # 跳过迁移与入库，只重启服务
.\run.ps1 -Stop        # 停止四个服务（MySQL 容器保留）
```

启动后四个端口分别对应：客户页面 `5173`、坐席工作台 `5134`、Agent API `3100`、Commerce API `3101`。`-NoBrowser` 可跳过自动打开浏览器。

手动启动：

```powershell
cd packages/customer-service-agent
docker compose up -d
npm run db:migrate
npm run knowledge:ingest
```

分别启动四个服务：

```powershell
npm run dev:commerce  # Commerce API: 3101
npm run dev:agent     # Agent API: 3100
npm run dev:web       # 客户页面: 5173
npm run dev:desk      # 坐席工作台: 5134
```

Agent 的模型凭据复用 pi 的 `~/.pi/agent/models.json`：按 `LLM_PROVIDER` 查找同名 provider 的 `baseUrl` 与 `apiKey`；文件或该 provider 缺失时才回落到 `LLM_API_KEY` 环境变量。默认模型为 `glm-4.5-air`，已验证能调用知识库工具。

## 已验证场景

- MySQL 迁移、中文编码和知识库入库。
- “配送政策是什么？”会调用 `search_knowledge_base`，并返回配送政策。
- 商品搜索和库存查询可访问真实 MySQL 数据。
- 订单草稿价格校验、库存不足、订单归属、确认门禁和幂等提交均有自动化测试。
- 退款资格判定、重复提交返回同一条申请、状态流转的非法组合和并发冲突均有自动化测试。
- 工单认领的比较并交换、未认领不得回复、未认领不得关闭、人工接管期间不调用模型均有自动化测试。
- 工单创建幂等有自动化测试：同一会话重复转人工返回同一张工单，已认领的工单同样会被复用，关闭后可以重新开单，没有会话的老工单不受约束。
- 坐席按工单读取客户会话、无关联会话的老工单返回空数组、缺少令牌被拒绝、接管状态随认领与关闭翻转均有自动化测试。
- 坐席审计有自动化测试：认领、回复、关闭各写 `started` + 终态两条；被拒绝的尝试记为 `rejected` 并带原因码；回复与关闭的工号取自工单而不是请求体；被拒绝且无人认领时工号为空；读取不产生审计行。
- 客户页面无需刷新即可看到人工接入与人工回复，已在真实服务上验证。
- `test/integration/concurrency.test.ts` 在真实 MySQL 上发八个并发请求，验证订单提交幂等（返回同一单、库存只扣一次）、退款唯一索引、工单认领与关闭只有一个赢家、同一会话的并发转人工只产生一张工单。数据库不可达时整套跳过，`npm run test:integration` 可显式运行。
- 当前包的单元/API 测试通过，整仓 `npm run check` 通过。

## 当前范围与后续可扩展项

- 当前仅提供演示用户登录；生产环境应接入真实用户系统、权限和会话管理。
- 当前知识库是关键词检索；文档量变大后可恢复 Milvus 和真实 embedding 模型。
- 当前没有真实支付、物流追踪或退款审批界面。退款状态可以由内部接口推进，但还没有坐席操作界面，也没有支付回调接入；演示时需要手动调用 `POST /refund-requests/:id/status`。
- 坐席工作台是单角色界面，用共享内部令牌鉴权，没有独立坐席身份，所以审计里的工号只能来自工单的认领人；被拒绝且无人认领的尝试留空，而不是填一个占位符。
- 人工服务没有对外 webhook 通知。接外部客服系统时，只需在 `handoff_to_human` 创建工单后追加一次出站推送，入站回复仍复用现有接口。
- 客户看不到工单自身的状态：没有面向客户的工单进度查询工具，客户只能从会话里的提示判断人工是否已接入。
- 工单只记录当前状态和最后一次状态变更，没有写变更历史表；需要完整流转审计时再补 `support_ticket_events`。
- 客户目前不能主动结束人工接管，只能等坐席关闭工单。
- 退款只记录当前状态和最后一次状态变更，没有写状态变更历史表；需要完整流转审计时再补 `refund_request_events`。
- 退款申请一旦进入 `approved` 就不能由客户撤销，也没有面向客户的批量撤销。
- 退款窗口当前按订单下单时间计算，与知识库中“自签收之日起七天”的表述不完全一致；系统尚未接入物流签收时间，接入后应改为按签收时间判定。
- 当前同一会话的并发消息锁在 Agent 进程内；多实例部署时应改为 Redis 或数据库分布式锁。
