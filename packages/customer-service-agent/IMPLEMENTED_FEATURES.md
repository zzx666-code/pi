# 已实现功能

## 项目定位

这是一个基于 Pi Agent Core 的电商智能客服示例。模型不能直接读写数据库，只能通过受控工具获取商品、库存、订单和售后政策，并在明确的安全边界内创建订单草稿。

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
| 提交退款申请 | 按下单时间判断退款资格：下单未超过 7 天的订单写入 `refund_requests`，状态为 `pending_review`，等待人工审批；超过 7 天返回 `eligible=false` 且不写入。模型只能提交申请，不能审批、不能承诺退款金额或到账时间。同一订单重复提交返回同一条申请。 |
| 查询退款进度 | 列出当前用户的退款申请（状态、金额、原因、提交时间、最后一次状态变更时间），可按订单号过滤。只返回客户可见字段，审核人身份和内部备注不下发。 |
| 转人工 | 投诉、敏感操作、重复失败或用户明确要求时，可创建人工客服工单。 |
| 流式对话 | Web 界面通过 SSE 展示模型回复与工具执行状态。 |
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
| `request_refund` | 是 | 提交退款申请，进入待处理状态。7 天窗口由服务端判定，模型只负责解释结果。 |
| `list_refund_requests` | 否 | 查询当前用户的退款申请进度，可按订单号过滤。 |
| `handoff_to_human` | 是 | 创建人工客服工单。 |

模型没有“直接提交订单”的工具，也没有任何“审批退款”的工具：正式下单由 Web 界面的确认操作完成，退款状态只由服务端的人工审批接口推进。

## 退款申请状态机

状态名同时用于 MySQL ENUM、HTTP 接口、Agent 工具返回值，定义在 `src/domain/refund-status.ts`。

| 状态 | 含义 | 可流转到 |
| --- | --- | --- |
| `pending_review` | 待处理：申请已受理，等待人工审批 | `handed_off`、`approved`、`rejected` |
| `handed_off` | 已移交人工客服跟进 | `approved`、`rejected` |
| `approved` | 审核通过，等待退款执行 | `refunded`、`failed` |
| `refunded` | 退款成功（终态） | 无 |
| `rejected` | 审核未通过（终态） | 无 |
| `failed` | 退款执行失败（终态） | 无 |

- 只有“申请成功”是事件而不是状态：它把申请推进到 `pending_review`。
- `approved` 与 `refunded` 分开，是因为“审核通过”和“钱到账”是两件事，中间支付渠道可能失败。
- 非法流转在领域层被拒绝（例如 `pending_review` 直接跳 `refunded`），终态不能再被修改；客户被驳回后想再退，只能重新提交一条新申请。
- 状态由内部接口 `POST /refund-requests/:id/status` 推进，需要 `x-internal-token`，供人工坐席工作台或支付回调调用。

## 安全与一致性控制

- 用户身份由 Agent API 的 JWT 解析后注入工具上下文；模型不能传入或伪造 `userId`。
- 订单草稿使用服务端商品价格，忽略客户端伪造价格。
- 库存创建草稿时会预检查；提交订单时会在 MySQL 事务中以 `FOR UPDATE` 锁定库存并再次校验。
- 订单提交需要幂等键，同一个请求重复提交不会产生重复订单。
- 退款资格由服务端按下单时间判定，模型不参与“是否退款”的决策；写入的申请只进入待处理状态。
- Agent 网关没有退款审批方法，工具集合中也没有审批工具，模型无法绕过人工审批（有测试固定该工具集合）。
- 退款状态更新使用 `WHERE id = ? AND status = ?` 的比较并交换，两个审批人同时操作不会互相覆盖。
- `refund_requests.active_order_id` 唯一索引保证同一订单不会出现两条未结束的退款申请。
- 用户确认前，草稿不会提交；确认后的订单状态和库存扣减由同一个业务事务完成。
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
- `support_tickets`：人工工单
- `conversations`、`conversation_messages`：会话与消息
- `tool_audit_logs`：工具审计日志
- `knowledge_documents`：售后知识库分片

初始化 SQL 显式使用 `utf8mb4`，防止中文地区和商品数据出现乱码。

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

```powershell
cd packages/customer-service-agent
docker compose up -d
npm run db:migrate
npm run knowledge:ingest
```

分别启动三个服务：

```powershell
npm run dev:commerce  # Commerce API: 3101
npm run dev:agent     # Agent API: 3100
npm run dev:web       # Web: 5173
```

Agent 的模型凭据复用 pi 的 `~/.pi/agent/models.json`：按 `LLM_PROVIDER` 查找同名 provider 的 `baseUrl` 与 `apiKey`；文件或该 provider 缺失时才回落到 `LLM_API_KEY` 环境变量。默认模型为 `glm-4.5-air`，已验证能调用知识库工具。

## 已验证场景

- MySQL 迁移、中文编码和知识库入库。
- “配送政策是什么？”会调用 `search_knowledge_base`，并返回配送政策。
- 商品搜索和库存查询可访问真实 MySQL 数据。
- 订单草稿价格校验、库存不足、订单归属、确认门禁和幂等提交均有自动化测试。
- 当前包的单元/API 测试通过，整仓 `npm run check` 通过。

## 当前范围与后续可扩展项

- 当前仅提供演示用户登录；生产环境应接入真实用户系统、权限和会话管理。
- 当前知识库是关键词检索；文档量变大后可恢复 Milvus 和真实 embedding 模型。
- 当前没有真实支付、物流追踪、退款审批界面或人工客服工作台。退款状态可以由内部接口推进，但还没有坐席操作界面，也没有支付回调接入；演示时需要手动调用 `POST /refund-requests/:id/status`。
- 退款只记录当前状态和最后一次状态变更，没有写状态变更历史表；需要完整流转审计时再补 `refund_request_events`。
- 客户目前不能撤销自己的退款申请（状态机中没有 `cancelled`）。
- 退款窗口当前按订单下单时间计算，与知识库中“自签收之日起七天”的表述不完全一致；系统尚未接入物流签收时间，接入后应改为按签收时间判定。
- 当前同一会话的并发消息锁在 Agent 进程内；多实例部署时应改为 Redis 或数据库分布式锁。
