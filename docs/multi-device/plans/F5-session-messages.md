# F5 手机端「会话与消息」功能域设计（会话与消息域）

- 文档类型：多端互通移动端功能设计（会话与消息域）
- 产出路径：`docs/multi-device/plans/F5-session-messages.md`
- 设计依据：桌面端消息模型（store 类型 / chat-bridge 消息流 / 引擎事件契约 / 持久化层 / 渲染组件）
- 输入证据域：
  - `apps/crish-desktop/src/api/chat-bridge/`（messageHandlers / streamState / EventRouter / dispatch）
  - `apps/crish-desktop/src/api/sessionEventHydrate.ts`（引擎事件回放投影）
  - `apps/crish-desktop/src/store/types.ts`（SessionMessage 等类型）
  - `crates/conex-types/src/events.rs` 与 `crates/conex-types/src/message.rs`（事件/消息契约）
  - `apps/crish-desktop/src/components/chat-message-row/`（消息渲染组件）
  - `apps/crish-desktop/src/api/sessionSearch.ts`、`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`
- 禁止读取：`reference/**`、`apps/crish-mobile/**`、`docs/**`、`node_modules/**`、`target/**`（已遵守）

---

## 1. 桌面端消息模型盘点（文件:行号证据）

### 1.1 SessionMessage 结构

桌面端消息权威类型为 `SessionMessage`（`apps/crish-desktop/src/store/types.ts:366-408`），
引擎侧契约类型为 `AgentMessage`（`crates/conex-types/src/message.rs:34-50`）。
两者字段对账如下：

| 字段 | 类型 / 取值 | 语义 | 证据 |
| --- | --- | --- | --- |
| `id` | string | 稳定消息 id（user=本地乐观 id；assistant=stream placeholder，message-end 回显稳定 id 后 rekey） | types.ts:367；sessionEventHydrate.ts:85-93 |
| `sender` | `'user' \| 'assistant'` | 发送方（MessageSender） | types.ts:315 |
| `text` | string（可选） | 正式正文（流式期间为累计全文；message-end 后为终态全文） | types.ts:369 |
| `thinking` | string（可选） | 思考过程，与正式正文分离，避免互相覆盖 | types.ts:371；messageHandlers.ts:84-87 |
| `timestamp` | number（epoch ms） | 消息时间 | types.ts:373 |
| `toolCalls` | `MessageToolCall[]`（可选） | 本条消息的工具调用清单（调用发起） | types.ts:374；types.ts:284-312 |
| `status` | `'queued' \| 'processing' \| 'completed' \| 'error'`（可选） | 消息处理状态（SessionMessageStatus） | types.ts:321-322 |
| `precomputedHtml` | string（可选） | Worker 异步 markdown 渲染的预计算 HTML 缓存 | types.ts:377 |
| `toolCallResults` | `SessionMessageToolCallResult[]`（可选） | 本条消息作为工具调用「结果回执」时关联的 toolCall.id 清单 | types.ts:338-345；types.ts:382 |
| `blocks` | `MessageTimelineBlock[]`（可选） | 时间线：text / tool_call / image 按发生顺序交错 | types.ts:347-363；types.ts:387 |
| `streamTextOffset` | number（可选） | 上一工具插入时 text 的长度，用于把累计正文切成段 | types.ts:389 |
| `thinkingTime` | number（可选） | 思考耗时 | types.ts:391 |
| `images` | `MessageImageRef[]`（可选） | 本条消息全部图片的结构化索引 | types.ts:393；types.ts:213-232 |
| `errorDetail` | `{message, kind, technical?}`（可选） | 运行错误诊断详情 | types.ts:395-401 |
| `cacheMetrics` | `MessageCacheState \| null`（可选） | 消息级缓存指标（T-48）；null=未上报 → 渲染层隐藏 | types.ts:407；messageHandlers.ts:162-167 |

引擎侧 `AgentMessage`（`message.rs:34-50`）为 serde camelCase 契约：`id / role / createdAt /
blocks / metadata / clientMessageId / content`；`clientMessageId` 是前端 upsert/rekey 的
稳定幂等键（`message.rs:45-46`），`content` 为正文兜底字段（`message.rs:48-49`）。

引擎消息块 `AgentMessageBlock`（`message.rs:100-126`）为 tagged enum：
`text / thought / tool-call / tool-result`，前端以 `block.type === 'thought'` 判定思考块
（`message.rs:98-99`）。TS 投影在 `packages/shared-types/src/message.ts:3-44`。

### 1.2 消息生命周期

生命周期：`queued（排队待发）→ processing（流式中）→ completed（终态成功收口）`，
失败走 `error`（types.ts:321-322 注释）。

事件驱动链（chat-bridge 消息域 handler，`handlers/messageHandlers.ts`）：

| 事件 | handler | 行为 | 证据 |
| --- | --- | --- | --- |
| `message-start` | onMessageStart | 显式空实现（无 UI 语义） | messageHandlers.ts:68-73 |
| `message-delta` | onMessageDelta | 按 block 类型分流：thought 单独累积（onThought）；text 增量拼接（onChunk）；若载荷带 `message.content` 全量回显，则按长度差分出增量（slice 逻辑） | messageHandlers.ts:75-107 |
| `message-end` | onMessageEnd | 终态权威：从 blocks 重组 text/thought 全文；按 `turnIndex` 分段合并（同 turn 幂等覆盖、跨 turn 追加）；派生缓存指标挂到 SessionMessage.cacheMetrics | messageHandlers.ts:109-167 |

流式状态机 `StreamState`（`handlers/streamState.ts:3-22`）：
`cancelled / finished / assistantText（累计正文）/ assistantThought（累计思考）/
unsub / endTimer / lastMessageCacheMetrics / messageEndTurnSegments（按 turnIndex 的终态段账本）`。

引擎事件契约（`crates/conex-types/src/events.rs`）：

- `message-start`：`MessageStart { session_id, message: Arc<AgentMessage> }`（events.rs:344-348）
- `message-delta`：`MessageDelta { session_id, timestamp, message_id, block }`（events.rs:350-356）
- `message-end`：`MessageEnd { session_id, message: Arc<AgentMessage>, turn_index }`（events.rs:359-367）
- 工具域：`tool-start`（events.rs:371-377）、`tool-update`（events.rs:379-386）、`tool-end`（events.rs:388-394）
- run 域：`agent-start/agent-end`（events.rs:309-323）、`turn-start/turn-end`（events.rs:327-340）、`run-terminal`（events.rs:511-519）

事件信封 `AgentEventEnvelope`（events.rs:905-933）：顶层平铺 `{ type, runId, sequence,
schemaVersion, sessionId, ...事件字段 }`；`sequence` 是重放去重与游标的唯一依据（events.rs:910-911）。

背压分级（events.rs:867-893）——手机端同步协议必须继承的语义：

| 级别 | 事件 | 语义 | 手机端含义 |
| --- | --- | --- | --- |
| Delta（可丢） | message-delta、task-output、task-heartbeat 等 | 增量可丢、不落库 | 实时通道丢帧可容忍 |
| Soft（尽力） | subagent-event 的 message/tool 类、task-suspicious | 尽力投递 | 可重发 |
| Critical（必达） | message-end、tool-start/end、run-terminal、终态、审批、审计 | 落库不丢 | 终态必达 → 增量丢失可由终态全文兜底 |

### 1.3 工具调用模型

`MessageToolCall`（types.ts:284-312）：

- 状态 `MessageToolCallStatus = 'running' | 'success' | 'error' | 'pending_approval'`（types.ts:244-245）；
  - 语义单一性约定：`success/error` 仅表工具执行结果；用户审批决定由
    `approvalDecision = 'approved' | 'rejected'`（types.ts:252）独立承载；
    拒绝审批时 status 仍保留 `pending_approval`（types.ts:240-243 注释）。
- 字段：`id / name / arguments（JSON 或原始串）/ status / output / diffs / explanation /
  approvalMeta（后端审批风险事实）/ approvalDecision / startedAt / finishedAt / durationMs /
  completedAt / turnId / images`。
- 时间线对齐：`normalizeAssistantTimeline`（`apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts:25-78`）
  把 blocks 与 toolCalls 对齐（live / hydrate / 持久化共用）；
  `buildAssistantTimeline`（timelineNormalizer.ts:168-229）产出可交错渲染的
  text / tools 条目序列。

### 1.4 消息渲染组件（桌面端现状）

`apps/crish-desktop/src/components/chat-message-row/`：

| 组件 | 职责 | 证据 |
| --- | --- | --- |
| ChatMessageRow | user / assistant 行分派；React.memo 严格 props 比较避免流式时历史行无谓 reconcile | ChatMessageRow.tsx:1-4 |
| ChatUserMessageRow | 用户气泡；长消息折叠（>260 字符 → 240 预览 + 展开）；排队中徽标；复制/固定/撤回 | ChatUserMessageRow.tsx:61-62,153-155；chatMessageRowUtils.ts:8-9 |
| ChatAssistantMessageRow | 助手行：思考块 + 正文 + 工具栈 + 缓存徽标 + 操作条；流式期间 live 行单独订阅 streamingStore | ChatAssistantMessageRow.tsx:93-259 |
| MessageThinkingSection | 思考折叠条（live 显示 spinner + ThinkingTimer；终态可展开/收起；思考文本按 DOM 字符预算截断） | MessageThinkingSection.tsx:17-82 |
| MessageToolCallsSection | 工具卡片组渲染（ChatToolStack；内嵌子 agent 面板懒加载） | MessageToolCallsSection.tsx:22-47 |
| MessageActionsBar | 用户消息操作（复制/撤回/固定）+ 助手消息操作（复制/重新生成/固定）+ 后续建议 chips | MessageActionsBar.tsx:31-190 |
| AsyncMarkdownBlock | 异步 markdown 渲染：流式期间纯文本 div + caret（零 IPC）；完成态走 Rust md_render（worker highlight.js 仅 fallback）；渲染中 skeleton | AsyncMarkdownBlock.tsx:26-75 |

关键设计：流式期间不重渲染整行（streamingStore 缓冲 + 行级 memo），完成态才提交终态文本
并触发一次 Rust 渲染（AsyncMarkdownBlock.tsx:33-38）。

### 1.5 历史持久化（conex-db / sessionRustDb）

桌面持久化层 `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`：

- 存储：SQLite（conex-db）唯一会话存储，14 个 API 走 Tauri invoke（sessionRustDb.ts:1-25）；
  invoke 缺失 → localStorage 同步回退（sessionRustDb.ts:418-421）。
- 形状转换：JS `toolCalls/blocks/toolCallResults` ↔ Rust `tool_calls_json/blocks_json/
  tool_call_results_json`（JSON 字符串）（sessionRustDb.ts:10-17；toRustSessionMessage 155-233；
  fromRustSessionMessage 288-325）。
- 索引条目 `RustSessionIndexEntry`：`id / title / folder / isPinned / isArchived /
  timestamp / updatedAt / messageCount / pinnedMessageIds / engineCursor / engineLastRunId /
  hydratedFromEngine`（sessionRustDb.ts:131-145）。
- 命令面：`list_sessions`（sessionRustDb.ts:668-672）、`load_session_body`（678-693）、
  `save_session_body`（705-752，batchVersion CAS + 写队列）、`load/save_session_agents`、
  `get/set_session_meta`、`cleanup_orphan_sessions`。
- 写竞态防线：模块级串行队列 + 单调递增批次版本 CAS（sessionRustDb.ts:1247-1297）——
  后发批次最后落库，陈旧批次不覆盖。
- 索引真相源：localStorage 索引优先，空时回退 SQLite `list_sessions`（sessionRustDb.ts:1174-1181）。
- 水合：`hydrateSessionsFromRust`（1169-1245）boot 时一次加载 index + bodies + agents。

### 1.6 引擎事件回放（远程会话补全的基础）

`apps/crish-desktop/src/api/sessionEventHydrate.ts`：

- `fetchSessionEvents(sessionId, afterSequence, maxEvents)` → `core_read_session_events`
  （sessionEventHydrate.ts:407-438）：返回 `{ events, nextAfterSequence, hasMore }`。
- 分页上限：`MAX_HYDRATE_PAGES = 50`、`HYDRATE_PAGE_SIZE = 800`（sessionEventHydrate.ts:445-448）。
- `projectEventsToMessages`（155-405）：把 orchestrator session-events 投影为消息列表——
  message-end → user/assistant 终态；message-delta → 累计；tool-start/tool-end → 工具卡；
  按 turnIndex 分段合并（同 turn 幂等覆盖、跨 turn 追加）；收尾仍 running 的工具标 error
  （中断态，UI 隐藏）。
- `mergeMessagesById`（118-149）：同 id 原地 merge，否则 append（重放去重、本地乐观合并共用）。
- H3 钩子：`fetchRunSnapshotUsage(runId)` → `core_get_run_snapshot`（518-534）。

### 1.7 桌面端已有能力清单（手机端可移植/可复用）

| 能力 | 位置 | 手机端复用方式 |
| --- | --- | --- |
| 会话全文搜索（纯前端、无索引） | sessionSearch.ts:417-479（matchSessionSearch）、345-358（messageMatchesSearch） | 纯函数逻辑直接移植 |
| 搜索摘录（码点安全） | sessionSearch.ts:236-296（makeSearchSnippet）、184-194（ellipsizeCodepoints） | 直接移植 |
| 流式缓冲（token 级不入主 store） | streamingStore.ts:30-39（StreamEntry） | 模式移植（React Native / 原生同理） |
| 长消息折叠 | chatMessageRowUtils.ts:8-9（260/240 阈值） | 阈值按手机屏适配 |
| 思考块预算截断 | budgetDomText（ChatAssistantMessageRow.tsx:175） | 直接移植 |
| 工具卡时间线规范化 | timelineNormalizer.ts:25-78 | 直接移植 |
| 历史回传 token 预算 + 稳定锚点 | ConnectionLifecycle.ts:161-182（truncateHistoryWithAnchor，预算 200_000 token） | 手机端同步裁剪参考 |
| 消息合并（幂等） | sessionEventHydrate.ts:118-149 | 直接移植 |
| 消费侧事件去重键 | EventRouter.ts:166-189 | 直接移植 |

### 1.8 消息发送链路（手机端发起会话的协议基础）

桌面端发送消息的唯一通道（C3.1 定稿后无降级分支）：

```
用户输入 → streamAssistantResponseApi(prompt, callbacks, sessionId, assistantMsgId, options)
        → streamViaEngine（chatApi.ts:144-153）
        → createStreamSession（IPC 就绪 → core_run_task 启动 run）
        → 事件回流：listen('workbench-run-event') → EventRouter.onMsg → 分派表
        → 消息域 handler 更新 store / streamingStore
```

证据链：

- `chatApi.ts:5-14`：唯一通道 `streamViaEngine`（Tauri IPC → `core_run_task` + 事件流），
  daemon WebSocket 与 directFetch 降级已删除；
- `StreamRequestOptions`（chatApi.ts:47-87）：`prompt / content / hasImages / attachments /
  systemPrompt / tools / messages / mode（如 goal）/ clientMessageId / assistantClientMessageId`；
  - `clientMessageId` = 用户消息本地乐观 id（chatApi.ts:81-86），经 run-task 下发，
    daemon 用作 user message id，hydrate 按 id upsert——**手机端 P2 发起消息直接复用此幂等机制**；
  - `assistantClientMessageId` = 助手 placeholder id，message-end 带回稳定 id 后 rekey 合并
    （sessionEventHydrate.ts:99-111）。
- 历史回传：`buildHistoryMessages`（ConnectionLifecycle.ts:194-231）把 store 消息组装为
  `HistoryMessage[]`（仅 user/assistant 且 completed 态，ConnectionLifecycle.ts:135-137），
  经 `truncateHistoryWithAnchor` 按 token 预算（20 万）截断，首条 user 锚点恒在
  （ConnectionLifecycle.ts:161-182）；
- run 控制：取消经 `core_run_control`（L2/L3，ConnectionLifecycle.ts:15-16）。

手机端含义：发起会话（P2）= 网关转发 `run_task`（载荷同构：prompt / history / clientMessageId /
assistantClientMessageId）+ 事件回流（2.3 订阅通道）。历史回传的 token 预算与锚点策略
（ConnectionLifecycle.ts:161-182）应原样移植到网关侧，保证服务端前缀缓存命中。

### 1.9 桌面端能力缺口（手机端需要新增，桌面无）

| 缺口 | 说明 |
| --- | --- |
| 未读数 / 已读未读 | 桌面无 unread 概念（全仓 grep 无命中），手机端需自建（见 6.3） |
| 会话运行状态可见性 | 桌面侧栏无「运行中」徽标位（需确认，D-系列文档不在此域），手机端列表需展示（见 2.1） |
| 远程会话列表 | 桌面会话列表是本地 SQLite/LS 索引；手机端需远程索引接口（见 2.1） |
| 增量实时订阅 | 桌面与引擎同进程（Tauri IPC listen('workbench-run-event')，ConnectionLifecycle.ts:7-8）；手机端需网络订阅通道（见 2.3） |

---

## 2. 手机端功能清单

### 2.1 会话列表（标题 / 时间 / 状态 / 未读数）

功能目标：一屏列出可访问的会话，信息密度高于桌面侧栏（手机屏小，一次只给关键信息）。

信息项与来源：

| 信息项 | 数据来源 | 说明 |
| --- | --- | --- |
| 标题 | 会话索引 `title`（桌面由首条用户消息推导，sessionTitle.ts:69-72：空标题='新会话'，截断 28 码点） | 手机端应复用同一推导/截断规则，保证两端一致 |
| 最后消息时间 | 索引 `updatedAt`（epoch ms，RustSessionIndexEntry:139） | 相对时间（刚刚 / N 分钟前），与桌面 formatMsgTime 同风格 |
| 运行状态 | 会话最后 run 状态（派生自实时订阅或索引 `engineLastRunId` + run-terminal） | 「运行中」徽标 + 动效点；「已完成/失败」静态徽标 |
| 未读数 | 手机端本地游标派生（lastReadSequence vs 最新 sequence） | 桌面无此概念，手机端本地计算，角标展示（见 6.3） |
| 摘要（可选） | 最后一条消息 text 前缀（列表接口可携带「最后消息预览」字段） | 帮助快速识别会话；隐私开关可关闭 |

列表排序：按 `updatedAt` 降序（与桌面 hydrateSessionsFromRust 排序一致，sessionRustDb.ts:1192）。
置顶 `isPinned` 优先段（桌面 partition 语义）。

加载策略：

- 首次进入：拉取会话索引（轻量，不含正文），见 2.4；
- 增量刷新：实时订阅推送「会话变更」事件（updatedAt / messageCount / 运行状态变化）时局部更新；
- 下拉刷新：全量重拉索引，收敛漂移。

### 2.2 会话详情（消息流渲染）

功能目标：按时间顺序渲染消息流，覆盖用户消息 / 助手正文 / 思考折叠 / 工具调用摘要 /
代码块 / 图片。

渲染元素映射（桌面组件 → 手机端）：

| 桌面组件 | 手机端对应 |
| --- | --- |
| ChatUserMessageRow | 右侧气泡：正文 + 时间；长消息折叠（见 3.3） |
| ChatAssistantMessageRow | 左侧卡片：思考折叠条（见 4.4）+ 正文（轻量 markdown，见 3.1）+ 工具卡片（见 4.5）+ 缓存徽标（可选，默认隐藏，见 8.1 裁剪） |
| MessageThinkingSection | 思考折叠组件（默认收起；思考中自动展开显示 spinner） |
| MessageToolCallsSection | 工具调用摘要卡：名称 + 状态图标 + 时长；点击展开 arguments/output（见 4.5） |
| MessageActionsBar | 消息长按操作菜单（复制 / 转发 / 引用；见 2.5 与 4.3） |
| CacheMetricsBadge | P1 隐藏（缓存指标为桌面性能调试信息，手机端不展示，减少噪音） |

数据来源：会话详情接口（分页事件流投影，见 2.4）＋ 实时增量（见 2.3）＋ 本地缓存。

### 2.3 实时会话（桌面 run 进行中，手机端实时看消息）——结论：可以，且架构上天然支持

结论先行：**手机端实时查看桌面端 run 是可行的**，因为：

1. 消息协议本身是事件流（message-delta / message-end），不是「桌面持有后转发」的快照，
   引擎事件契约与传输层解耦（events.rs:290-305 契约、events.rs:905-933 信封）；
2. 背压分级天然支持弱网：message-delta 为 Delta 可丢（events.rs:867-893），丢帧不致命，
   由 message-end（Critical 必达）终态全文兜底；
3. 桌面端已有「远程会话补全」先例：`core_read_session_events` + `afterSequence` 游标
   （sessionEventHydrate.ts:407-438），增量续拉路径已经存在。

方案：新增「会话事件订阅」协议（与同步域 D6 衔接，建议由网关/中继实现）：

```
手机端                    网关/中继                    桌面端/引擎
  │  subscribe_session_events  │                          │
  │  {sessionId, sinceSeq}     │  建立事件流               │
  │ ─────────────────────────► │  core_read_session_events │
  │                            │  + 增量事件推送（挂订阅）  │
  │  message-delta (节流合并)  │◄─────────────────────────│
  │ ◄───────────────────────── │                          │
  │  message-end (必达)        │◄─────────────────────────│
  │ ◄───────────────────────── │                          │
  │  run-terminal              │◄─────────────────────────│
  │ ◄───────────────────────── │                          │
```

关键设计点：

| 设计点 | 决策 | 理由 |
| --- | --- | --- |
| 增量推送粒度 | delta 帧按节流窗口（如 200ms）合并成批推送；message-end / tool-end / run-terminal 即时推 | 手机端每 token 渲染不可行（对齐桌面 streamingStore 思路，streamingStore.ts:1-11）；终态必须即时 |
| 断线重连 | 重连后携带本地 `maxSequence` 调 `read_session_events` 续拉，再恢复订阅 | 与桌面 fetchSessionEvents 同游标语义（sessionEventHydrate.ts:407-438） |
| 订阅鉴权 | 订阅仅允许会话拥有者；网关校验会话归属 | 安全基线（D5 域）；手机端不得订阅他人会话 |
| 消费侧幂等 | 移植 buildEventDedupeKey（EventRouter.ts:166-189）去重键 | 防止重连重放造成双气泡 |
| 投影语义 | 移植 projectEventsToMessages（sessionEventHydrate.ts:155-405） | 保证手机端与桌面渲染同一消息形态，不做第二套投影 |
| 前台/后台 | 前台（App 可见）用长连接事件流；后台用推送通知（D7 域衔接）携带「有更新」信号，进前台再续拉 | 省电与流量（见 6.2） |

### 2.4 历史会话查看（远程读取 vs 分页拉取）——结论：分页事件流拉取 + 本地缓存

结论先行：**采用「远程分页事件流拉取 + 本地缓存」**，不引入独立快照接口。

理由：

1. 桌面端权威路径就是事件回放（hydrate 走 `core_read_session_events` 分页，50 页 × 800 事件，
   sessionEventHydrate.ts:445-448），手机端复用同一协议即与桌面同源，无第二套数据形状；
2. 消息正文、思考、工具卡全部可从事件流投影（projectEventsToMessages 已覆盖 text/thinking/
   tool-call），无需额外正文接口；
3. 事件流天然支持增量（afterSequence），缓存续拉与实时订阅共用游标。

拉取策略：

| 场景 | 策略 |
| --- | --- |
| 首屏（打开会话） | 从尾部向前拉取：先拉最近 1-2 页（800-1600 事件），渲染最近消息；「向上滚动加载更早」时按 before 游标继续（对齐桌面向后游标语义的反向使用） |
| 加载上限 | 对齐桌面 MAX_HYDRATE_PAGES=50 页上限，防异常 hasMore 拖死（sessionEventHydrate.ts:445-446）；超限打「未完整」标记（truncated，复用 SessionState.hydrateTruncated 语义 types.ts:567-572） |
| 本地缓存 | 已拉取的事件/消息本地落盘（SQLite / MMKV），二次进入秒开；缓存与游标一起保存（lastSequence），增量续拉补齐 |
| 消息体裁剪 | 大消息默认裁剪（见 5.3），「查看全文」按需补拉（P2，见 5.3 策略 B） |

### 2.5 发起会话 / 任务（手机端能否发起新对话）——结论与建议

结论先行：**协议面同构、技术上可行，但「与桌面同权」依赖网关与审批路由，建议 P1 冻结只读，
P2 实现「委托执行」模式。**

论证：

1. 桌面端发送 = `core_run_task`（Tauri IPC，chatApi.ts:5-14 唯一通道）+ 事件回流。
   手机端无法直接调桌面进程内 IPC，必须经网关把「发起 run」转发给桌面端/服务端引擎；
2. 协议载荷本身可复用：`StreamRequestOptions`（chatApi.ts:47-87）含 `prompt / content /
   history / clientMessageId / assistantClientMessageId`——`clientMessageId` 机制
   （chatApi.ts:81-86，用户消息=本地乐观 id，message-end 回显稳定 id 合并）天然支持
   手机端乐观消息 + 服务端回显合并，幂等性好；
3. 关键前提（与桌面同权）：

   - 权限与审批：桌面 run 会触发 `approval-requested`（events.rs:479-484）审批弹窗；
     手机端发起 run 必须路由审批到桌面（或手机端审批 UI，属 F-权限域）。Rust 侧已有
     `requester_run_id` 传递层先例（events.rs:213-215，子代理来源 → 主 agent 裁决），
     手机端可作为特殊 requester 复用该路由；
   - 权限模式：桌面发送前有 checkEngineReadyRealtime（ConnectionLifecycle.ts:277-297）
     与 permissionMode 门禁；手机端须至少验证「引擎在线 + 会话归属 + 网关鉴权」；
   - 审计：手机端发起的 run 应能溯源（建议在 run 载荷加 `requestOrigin: 'mobile'` 标记，
     引擎侧审计留痕，D5 域衔接）。

建议分阶段：

| 阶段 | 范围 |
| --- | --- |
| P1（本轮） | 只读：会话列表 + 历史详情 + 实时查看 + 搜索 + 消息操作（复制/转发/引用） |
| P2（后续） | 委托执行：手机端发消息 → 网关转发桌面/服务端引擎 → run 事件回流（审批路由到桌面）；新会话 = 同一协议 + `createSession` 语义（桌面 commitDraftIfNeeded，sessionTitle.ts:11） |
| P3（可选） | 手机端直接审批（approval-requested 双向）、移动端权限模式设置 |

### 2.6 消息搜索（标题 / 内容）——结论：本地轻量搜索 + 服务端搜索预留

桌面现状：`sessionSearch.ts` 是纯前端内存搜索（无索引），覆盖 title / folder / 消息正文 /
思考 / 工具字段 / 子 agent 元数据，NFKC 归一 + CJK 单 token 子串 + 多 token AND + 相关度
排序 + 码点安全摘录（sessionSearch.ts:1-10, 18-27, 417-479）。

手机端策略：

| 搜索范围 | 方案 | 理由 |
| --- | --- | --- |
| 标题 / 文件夹（会话列表搜索） | 本地：索引条目已在手（title/folder/id），轻量 keys 过滤（对齐 sessionIndex.ts 的 buildSessionSearchFilterKeys 思路） | 索引已同步，无需额外请求 |
| 消息全文搜索 | P1：**不做全局全文搜索**（消息正文不全量在手，全量同步违反裁剪策略 5.3）；提供「会话内搜索」：进入会话详情后，对**已加载**的消息做本地匹配（移植 messageMatchesSearch，sessionSearch.ts:345-358）+ 命中高亮 | 数据可得性约束 |
| 服务端全文搜索 | P2 预留：网关提供 `search_sessions {query}`（服务端索引 + 摘要返回），手机端只展示标题/摘要/命中计数，点击进入会话定位 | 桌面无服务端索引，此为新增能力，需服务端域支撑 |

搜索交互：搜索入口（会话列表顶部 + 详情页头部）→ 关键词输入 → 结果列表（标题 + 摘录 +
命中消息数）→ 点击进入会话详情并定位到命中消息（高亮）。摘录复用 `makeSearchSnippet`
（sessionSearch.ts:236-296），CJK 码点安全，可直接移植为纯函数。

### 2.7 边界与错误状态

| 状态 | 手机端表现 | 恢复路径 |
| --- | --- | --- |
| 引擎离线 / 桌面端未启动 | 会话列表显示「桌面端离线」横幅；已缓存会话可读（本地缓存），实时订阅挂起 | 下拉刷新 / 重连探测（轮询 gateway 状态，D6 衔接）；桌面恢复后增量续拉 |
| 会话在桌面被删除 / 归档 | 列表条目消失或置灰（归档态）；已打开详情收到「会话不存在」错误 | 清理本地缓存与未读游标；提示用户 |
| 会话不可访问（权限） | 列表不展示；深链进入显示「无权访问」 | 权限校验在网关侧（D5 域） |
| 消息拉取失败（网络） | 详情页显示错误态 + 「重试」按钮；已缓存内容照常展示 | 重试续拉（游标不变，幂等） |
| 大消息补拉失败 | 「查看全文」占位显示「加载失败，点击重试」 | 重试；持续失败降级展示已有摘要 |
| 订阅中断 | 悬浮提示「连接已断开，正在重连」；本地游标保留 | 重连后按 lastSequence 续拉（2.3） |
| 空会话 | 列表显示「新会话」标题（EMPTY_SESSION_TITLE，sessionTitle.ts:69）；详情显示空态插画 + 「发送第一条消息」（P2） | 无 |
| 消息截断（hydrateTruncated） | 详情顶部提示「会话过长，仅显示最近部分」 | 手动向上翻页继续加载（P1）；服务端补拉（P2） |

---

## 3. 渲染策略

### 3.1 轻量 markdown（不引入重型引擎）

结论：**自研轻量 markdown 子集解析器（约 200-300 行纯函数），流式期间渲染纯文本**。

理由（对齐桌面现状）：

1. 桌面完成态走 Rust `md_render`（进程内 IPC，AsyncMarkdownBlock.tsx:16-25），手机端没有
   该能力；引入完整 markdown-it / marked + 插件体系在移动端为重型依赖；
2. 桌面流式期间就是纯文本 + caret（AsyncMarkdownBlock.tsx:50-61），证明流式纯文本体验可接受；
3. 消息正文的形态以段落 / 列表 / 代码块 / 行内代码 / 粗斜体为主，子集足够覆盖 95% 场景。

子集范围：

| 支持 | 不支持（保持字面量或降级） |
| --- | --- |
| 段落 / 换行；`#` ~ `###` 标题；`-`/`*` 无序列表、`1.` 有序列表；`**粗体**` `*斜体*` `` `行内代码` ``；`> 引用`；```` ``` ``` ```` 围栏代码块；链接 `[text](url)`；水平线 `---` | 表格（降级为等宽文本块）；嵌套列表（P2）；HTML 标签（剥离/转义，安全考虑）；数学公式（P2 单独方案）；脚注 / 任务列表 checkbox（显示为普通列表） |

安全约束：解析器输出结构化节点（不是 innerHTML），由 React/原生组件渲染——天然防 XSS，
无需 sanitizer（桌面用 innerHTML + Rust 渲染器白名单，手机端结构化输出更安全）。

流式渲染策略（对齐桌面）：

- 流式中：纯文本 + 闪烁 caret 占位（zero 解析），见 AsyncMarkdownBlock.tsx:50-61；
- 完成态：一次性解析 + 渲染（骨架屏过渡，对齐 AsyncMarkdownBlock.tsx:63-73 skeleton 思路）。

### 3.2 代码块与高亮

| 方案 | 决策 | 理由 |
| --- | --- | --- |
| P1：代码块样式 | 统一等宽字体 + 底色块 + 行号（可选）+ 复制按钮；不引入高亮库 | highlight.js / prism 全量体积大（数百 KB）；移动端网络与包体敏感 |
| P2：轻量高亮 | 引入 highlight.js core + 常用语言子集（按需加载 ~10 种语言），或服务端预渲染高亮 HTML 返回 | 与 D4 移动端技术选型衔接；服务端预渲染可避免客户端包体增长 |
| 折叠 | 超长代码块（如 >30 行）默认折叠为「代码块 · N 行」，点击展开 | 对齐工具输出折叠思路（见 4.5） |

### 3.3 长消息处理

| 场景 | 策略 | 参考 |
| --- | --- | --- |
| 用户长消息 | 折叠预览 + 展开全文（阈值按屏宽适配：桌面 260 字符/240 预览，手机建议 180/160 码点） | chatMessageRowUtils.ts:8-9 |
| 助手长正文 | 不折叠（滚动自然阅读）；但超长正文（如 >50KB）仅渲染可视窗口文本，避免整段渲染卡顿 | 与 5.3 裁剪衔接 |
| 思考内容 | 预算截断展示（桌面 THINKING_DOM_CHAR_CAP 思路，ChatAssistantMessageRow.tsx:175），超限提示「已截断」 | MessageThinkingSection.tsx:65-67 |
| 工具 output | 默认摘要（首 N 字符 + 状态），展开看全文（见 4.5）；超长 output 分页/截断 | toolCardPresenter 的 toolResultPreview 思路 |

### 3.4 图片

数据形状直接复用 `MessageImageRef`（types.ts:213-232）：

| kind | 手机端处理 |
| --- | --- |
| `http` | 直接 `<img>` 加载；加载失败显示占位 + alt |
| `data` | 直接显示（注意体积：byteSize 超限则降级为「图片 · N KB」占位，点击查看） |
| `local` | **手机端不可达**（路径在桌面机）：显示「图片 · 需在桌面端查看」占位，或 P2 经网关代理拉取（服务端转 http URL） |
| `svg` | 显示为文本/图标占位（移动端 SVG 渲染风险），P2 优化 |
| `unsafe` | 不渲染，仅显示来源文本（安全策略，D5 域衔接） |

流式期间图片：桌面在流式期间增量解析出图片占位（types.ts:203-207 设计动机），手机端
对齐：delta 流中解析出 image 块 → 先占位，resolvedUrl 到位后加载（status:
pending → resolved/error，types.ts:223）。

---

## 4. 交互设计（文字描述 + ASCII 线框图）

### 4.1 会话列表页

```
┌─────────────────────────────┐
│ 会话            [搜索][新建+]│   ← 顶部栏：标题 + 搜索入口 + 新建（P2）
├─────────────────────────────┤
│ ● 运行中                     │   ← 运行状态分段（P1 只读也可只看全部）
│ ┌─────────────────────────┐ │
│ │ 📌 修复登录页 bug         │ │   ← 置顶会话
│ │ 助手：已定位问题…         │ │   ← 最后消息预览（1 行，灰）
│ │ 3 分钟前       ● 运行中  │ │   ← 相对时间 + 运行徽标
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 调研多端互通方案           │ │
│ │ 助手：参考文档已整理…      │ │
│ │ 昨天 14:30      ● 进行中  │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 新会话                    │ │
│ │ （空）                    │ │
│ │ 周一 09:12               │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│  ▲ 上滑加载更早（分页索引）   │
└─────────────────────────────┘
```

交互说明：

- 会话项点击 → 会话详情（4.2）；
- 运行中徽标：小圆点 + 旋转动效（P1 本地轮询/订阅驱动，见 2.3）；
- 未读角标：会话项右侧红点数字（见 6.3）；
- 长按会话项 → 操作菜单（固定 / 归档 / 删除——对齐桌面 session 动作面，P2 写操作，P1 只展示固定）；
- 下拉刷新：全量重拉索引。

### 4.2 会话详情页（消息流）

```
┌─────────────────────────────┐
│ ‹ 修复登录页 bug   [搜索][⋯] │   ← 顶部栏：返回 + 标题 + 会话内搜索 + 更多
├─────────────────────────────┤
│ 你        14:32              │
│ ┌─────────────────────────┐ │
│ │ 帮我修一下登录页的 bug     │ │
│ └─────────────────────────┘ │
│                              │
│ 助手       14:32             │
│ ┌─▸ 思考 (12 秒)──────────┐ │   ← 思考折叠条（默认收起，见 4.4）
│ ├─────────────────────────┤ │
│ │ ▸ 工具 · grep_search    │ │   ← 工具调用摘要卡（见 4.5）
│ │ ▸ 工具 · edit_file      │ │
│ ├─────────────────────────┤ │
│ │ 已定位问题：…            │ │   ← 助手正文（轻量 markdown）
│ │                        │ │
│ │ ```typescript          │ │   ← 代码块（等宽 + 底色）
│ │ const x = 1;           │ │
│ │ ```                    │ │
│ └─────────────────────────┘ │
│  [复制]      [重新生成]      │   ← 助手消息操作条（终态显示）
│                              │
│ ● 运行中         助手正在处理… │   ← 会话级状态条（流式期间）
├─────────────────────────────┤
│ [ + ] 输入消息…        [↑]   │   ← 输入框（P2 启用；P1 只读置灰）
└─────────────────────────────┘
```

交互说明：

- 消息流虚拟化渲染（FlatList / RecyclerView），见 6.1；
- 滚动到底部自动吸底；上滑离开底部显示「N 条新消息」悬浮条（见 6.2）；
- 消息长按 → 操作菜单（复制 / 转发 / 引用，见 4.3）；
- 时间戳分隔线：跨 5 分钟以上插入时间分组线（移动端惯例）。

### 4.3 消息操作（复制 / 转发 / 引用）

```
┌─────────────────────────────┐
│ 你  14:32                    │
│ ┌─────────────────────────┐ │
│ │ 帮我修一下登录页的 bug     │ │
│ └─────────────────────────┘ │
│         ┌───────────────┐   │
│ 长按 ──► │ 📋 复制        │   │   ← 操作菜单（长按气泡弹出）
│         │ ↩️ 引用        │   │   ← 引用：插入「引用原文 + 输入」
│         │ 📤 转发        │   │   ← 转发：选择目标会话（P2）
│         │ ⭐ 固定        │   │   ← P2 写操作
│         └───────────────┘   │
└─────────────────────────────┘
```

交互说明：

- 复制：正文 + 思考 + 工具输出按桌面 `assistantCopyText` 语义组装（toolPresentation.ts 导出）；
- 引用：在输入框上方插入引用条（原消息预览 + 原文），发送后引用块随消息上屏
  （对齐桌面 follow-up 参考交互，MessageActionsBar.tsx:204-287 的 chips 交互为桌面版先例）；
- 转发（P2）：选择目标会话 → 以「引用 + 原文」形式发送到目标会话（写操作，随 2.5 审批路由）；
- 操作菜单需可访问：TalkBack / VoiceOver 读出「复制消息」等标签（对齐桌面 aria-label
  做法，chatMessageRowUtils.ts:17-29）。

### 4.4 思考内容折叠

```
┌─────────────────────────────┐
│ 助手                          │
│ ┌─▸ 思考 (12 秒)──────────┐ │   ← 折叠态：一行摘要「思考 · N 秒」
│ │  (点击展开)              │ │
│ └─────────────────────────┘ │
│ ┌─▾ 思考 (12 秒)──────────┐ │   ← 展开态：全文（预算截断）
│ │ 我先分析一下问题：        │ │
│ │ 1. 定位登录接口…         │ │
│ │ 2. 检查前端表单校验…      │ │
│ │        （已截断）        │ │   ← 超预算提示
│ └─────────────────────────┘ │
│ ┌─● 思考中───────────────┐ │   ← 流式期间：spinner + 计时（自动展开）
│ │  (live，不可折叠)       │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

交互说明（对齐 MessageThinkingSection.tsx:17-82）：

- 折叠条：标题「思考」+ 思考耗时（thinkingTime / ThinkingTimer）+ 展开箭头；
- 流式期间（processing）：显示 spinner「思考中」，自动展开，禁止手动折叠；
- 展开态超预算（THINKING_DOM_CHAR_CAP 思路）显示「已截断」标记；
- 仅当思考内容非空或思考中才渲染折叠条（对齐 showThinking 判定，
  ChatAssistantMessageRow.tsx:139-144）。

### 4.5 工具调用卡片（可展开）

```
┌─────────────────────────────┐
│ ┌─ ▸ grep_search ─────────┐ │   ← 折叠态：工具名 + 状态图标 + 时长
│ │   ✔ 完成 · 1.2 秒         │ │   ← ✔=success ✖=error ◐=running ⚠=审批中
│ └─────────────────────────┘ │
│ ┌─ ▾ edit_file ───────────┐ │   ← 展开态
│ │   📄 src/pages/login.tsx  │ │   ← 参数摘要（arguments 截断展示）
│ │   +12 -4                 │ │   ← diff 统计（diffs 存在时）
│ │                          │ │
│ │   ┌─────────────────┐    │ │   ← 输出摘要（默认展开首 N 行）
│ │   │ 已更新文件…      │    │ │
│ │   └─────────────────┘    │ │
│ │   [查看完整输出]          │ │   ← 超长输出分页/截断
│ └─────────────────────────┘ │
│ ┌─ ◐ 审批中 ──────────────┐ │   ← pending_approval 状态卡（P2 审批）
│ │   工具等待批准…          │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

交互说明（对齐 MessageToolCallsSection + toolCardPresenter）：

- 默认折叠，展开显示：arguments 摘要、diff 统计、output 摘要；
- 状态图标映射：running ◐ / success ✔ / error ✖ / pending_approval ⚠；
- 工具组：同一时间线连续工具渲染为「工具组 · N 步」卡片（对齐 buildToolRenderItems 的
  group 语义，timelineNormalizer.ts:122-138）；
- 并行工具（turnId 相同）展开后并行排列；
- 中断工具（上次会话未完成，status=error + 「上次会话中断」文案，
  sessionEventHydrate.ts:382-393）显示灰色「中断」标记，不渲染失败红叉误导。

### 4.6 搜索页

```
┌─────────────────────────────┐
│ ‹ [ 🔍 搜索会话 / 消息    ]  │   ← 搜索框自动聚焦
├─────────────────────────────┤
│ 最近搜索                     │   ← 本地历史（sessionStorage 思路）
│   [登录]  [markdown]  [清空] │
├─────────────────────────────┤
│ 结果（按相关度排序）          │
│ ┌─────────────────────────┐ │
│ │ 🔥 修复登录页 bug         │ │   ← 标题命中（权重最高）
│ │   命中 3 条消息           │ │   ← hitCount
│ │   「…定位登录接口…」      │ │   ← 摘录（makeSearchSnippet）
│ │   3 分钟前                │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 🔎 调研 markdown 渲染     │ │
│ │   命中正文 1 条           │ │
│ │   「…轻量 markdown…」    │ │
│ │   昨天                    │ │
│ └─────────────────────────┘ │
│ 命中高亮：进入详情后          │
│ 命中消息行底色高亮 +          │
| 会话内搜索框可切换关键词      │
└─────────────────────────────┘
```

交互说明：

- 搜索范围：标题 + 文件夹（本地，索引在手）；会话内搜索（已加载消息，messageMatchesSearch）；
- 排序：score ↓ → hitCount ↓ → titleMatch 优先（compareSessionSearchRank，
  sessionSearch.ts:485-495）；
- 摘录：命中点两侧 28 码点半径、默认 72 码点（SNIPPET_RADIUS_CP / SNIPPET_MAX_CP，
  sessionSearch.ts:42-44）；
- 进入详情：命中消息行高亮（桌面 isSearchHit 语义，ChatAssistantMessageRow.tsx:203）；
- 查询词跨页面保留（桌面 storeSessionSearchQuery 的 sessionStorage 思路，手机端本地状态）。

### 4.7 发起会话 / 输入流程（P2）

```
┌─────────────────────────────┐
│ 新会话                        │
│ 输入框（多行，自动增高）        │
│ ┌─────────────────────────┐ │
│ │ 帮我把登录页的 bug 修了    │ │
│ │                          │ │
│ │                          │ │
│ └─────────────────────────┘ │
│ [📎 附件]      [发送 ➤]      │
│ 发送前状态检查（对齐桌面）：    │
│  · 桌面引擎在线 ✔            │
│  · 会话归属校验 ✔            │
│  · 权限模式提示（只读/询问）  │
├─────────────────────────────┤
│ 发送后：                     │
│  ┌────────────────────────┐ │
│  │ 你（排队中）             │ │   ← 乐观气泡 queued
│  │ 帮我把登录页的 bug 修了   │ │
│  └────────────────────────┘ │
│  ◐ 已提交至桌面端执行…       │   ← 转发状态条（网关确认后消失）
└─────────────────────────────┘
```

交互说明：

- 新会话 = 同协议发起 run（2.5）：无既有会话时网关创建会话（对齐桌面
  commitDraftIfNeeded，sessionTitle.ts:11）后返回 sessionId；
- 发送前状态检查移植 `checkEngineReadyRealtime` 语义（ConnectionLifecycle.ts:277-297）：
  网关返回 S1/S2/S3 分域错误文案；
- 审批触发：run 中 `approval-requested`（events.rs:479-484）经订阅回流 → 手机端提示
  「桌面端正在等待你的批准」+ 跳转桌面审批（P2 路由）；P3 手机端直接审批；
- 附件：图片走 `content` 视觉通路（ChatContentPart，chatApi.ts:25-33），文件走
  attachments 元数据（StreamAttachmentMeta，chatApi.ts:36-40）。

### 4.8 消息 UI 状态机

```
用户消息:                             助手消息:
  queued ──► processing ──► completed     processing ──► completed
     │           │              │             │              │
     │           │              ▼             │              ▼
     │           │            error           │            error
     │           │                             │
     │           └──► (流式：live 行)           │
     └──► (失败重发 P2)                        └──► (重新生成 P2)
```

各状态 UI 表现：

| 状态 | 用户消息 | 助手消息 |
| --- | --- | --- |
| queued | 气泡 + 「排队中」小标签（对齐 ChatUserMessageRow.tsx:153-155） | （不适用） |
| processing | 发送中动画（对勾待确认）；发送失败可重试 | 思考折叠条自动展开（spinner + 计时）+ 正文 caret + 工具卡 live 更新 |
| completed | 正常气泡 + 时间 | 思考折叠收起 + 终态 markdown 渲染 + 工具卡终态（✔/✖）+ 操作条出现（复制/重新生成） |
| error | 气泡 + 「发送失败」+ 重试/删除 | 错误条（errorDetail.message）+ 重新生成入口 |

状态迁移数据驱动：仅由消息 status（types.ts:321-322）与流式缓冲驱动，UI 不自行维护
状态（对齐桌面「数据驱动、UI 被动」原则）。

---

### 5.1 分层同步模型

按数据体积与变更频率分三层（与 D6 同步一致性域衔接）：

| 层 | 数据 | 同步方式 | 频率 |
| --- | --- | --- | --- |
| L1 会话索引 | id / title / folder / isPinned / updatedAt / messageCount / 运行状态 / 未读游标 | 全量拉取 + 变更推送（索引级事件） | 低频（列表刷新 / 推送） |
| L2 会话消息（历史） | 消息事件流（正文 / 思考 / 工具） | 分页拉取（2.4）+ 本地缓存 | 按需（打开会话 / 上滑翻页） |
| L3 实时增量 | 进行中 run 的事件流 | 订阅推送（2.3） | 高频（节流合并 200ms） |

### 5.2 增量同步（游标模型）

- 全局游标：`sequence`（事件信封，events.rs:910-911），单调递增；
- 会话级游标：`engineCursor`（SessionState 字段，types.ts:562；索引 RustSessionIndexEntry:142）；
- 手机端本地持久化 `(sessionId → lastSequence)`；
- 同步动作：
  - 打开会话：若本地缓存有数据 → 渲染缓存 → 以 `lastSequence` 调 `read_session_events` 续拉
    增量（补齐缺口）；无缓存 → 分页拉取（2.4）；
  - 实时订阅（2.3）：游标持续前移；
  - 断线重连：以 `lastSequence` 续拉，丢失的 delta 由 message-end 终态兜底；
- 幂等：消费侧去重键移植（EventRouter.ts:166-189），重放不双气泡。

### 5.3 消息体裁剪策略（摘要 vs 全文）

消息体可能很大（长正文 / 思考 / 工具 output / 图片 base64），手机端流量与内存敏感。
裁剪原则：**「列表给摘要、详情给正文、超限给占位、按需补全」**。

| 层级 | 默认同步内容 | 超限策略 |
| --- | --- | --- |
| 会话索引（L1） | 不携带正文，仅 title / updatedAt / messageCount / 最后消息预览（≤80 字符） | 预览超限截断 |
| 消息正文 text | 全文（多数消息 <8KB） | 单条 >8KB：同步前 8KB + `truncated=true` 标记，展示「正文已截断 · 查看全文」占位（P2 按消息 id 补拉全文） |
| thinking | 预算截断（对齐 THINKING_DOM_CHAR_CAP 思路） | 截断后展示「已截断」 |
| 工具 arguments / output | arguments ≤2KB；output 默认 ≤8KB + 摘要（首 N 行） | 超限折叠 + 「查看完整输出」（P2 补拉） |
| 图片（data / base64） | byteSize ≤512KB 同步；更大降级为占位 | 占位 + 点击按需加载（P2） |
| 子 agent 消息 | P1 不递归同步子 agent 消息（会话列表仅展示「N 个子任务」计数） | 点击子任务进入后按需拉取（P2） |

裁剪实现位置：**服务端/网关侧裁剪后传输**（而非手机端下载全文再裁剪）——省流量；
摘要生成用纯函数（复用 makeSearchSnippet / trunc 等已有逻辑）。补全接口
`fetch_message_full {sessionId, messageId}`（P2）返回消息全文（含未截断工具输出）。

### 5.4 冲突与合并语义

- 终态权威：`message-end` 覆盖同消息 delta 累积（messageHandlers.ts:109-167 语义）；
- 同 turn 幂等：turnIndex 分段，同 turn 覆盖、跨 turn 追加（sessionEventHydrate.ts:170-173, 280-291）；
- 合并：移植 `mergeMessagesById`（sessionEventHydrate.ts:118-149）——同 id 原地 merge，
  不同 id append，无双气泡；
- 客户端乐观消息：手机端发消息（P2）时本地先渲染 `queued` 状态气泡（乐观 id），
  message-end 回显稳定 id 后 rekey 合并（sessionEventHydrate.ts:99-111 rekey 语义）；
- 与桌面并发：同一会话桌面与手机同时打开时，两端都以事件流为真相源，游标增量各自消费，
  不产生整表覆盖（区别于本地 SQLite save_session_body 先删后插——手机端不做整表回写）。

### 5.5 数据形状映射与协议载荷示例

手机端不直接接触桌面 Rust 的 JSON 字符串往返（toolCallsJson / blocksJson 是本地存储
格式，sessionRustDb.ts:10-17）；网关应直接输出结构化 JS 形状（对齐 store types），
手机端零转换。协议载荷示例：

```
订阅事件（message-delta）：
{
  "type": "message-delta",
  "runId": "run-abc",
  "sequence": 4812,
  "sessionId": "sess-1",
  "messageId": "asst-msg-1",
  "block": { "type": "text", "text": "问题定位在" }
}

订阅事件（message-end，终态权威）：
{
  "type": "message-end",
  "runId": "run-abc",
  "sequence": 4890,
  "sessionId": "sess-1",
  "turnIndex": 0,
  "message": {
    "id": "asst-msg-1",            // 稳定 id（= assistantClientMessageId 回显）
    "role": "assistant",
    "createdAt": "2026-08-09T06:00:00Z",
    "blocks": [
      { "type": "thought", "text": "先分析……" },
      { "type": "text", "text": "问题定位在 src/pages/login.tsx" },
      { "type": "tool-call", "id": "tc-1", "toolName": "grep_search",
        "input": { "pattern": "login" } }
    ],
    "clientMessageId": "asst-msg-1"
  }
}

列表索引条目（L1 层，手机端 DTO）：
{
  "id": "sess-1",
  "title": "修复登录页 bug",
  "folder": "默认",
  "isPinned": true,
  "updatedAt": 1754700000000,
  "messageCount": 12,
  "engineCursor": 4890,
  "runStatus": "completed",        // 新增：网关从 run-terminal 派生
  "lastMessagePreview": "已定位问题：…",  // 新增：≤80 字符
  "unreadCount": 2                 // 新增：网关按已读游标计算（P2 多端已读时）
}
```

形状映射规则：

| 桌面概念 | 网关 DTO | 说明 |
| --- | --- | --- |
| SessionMessage | 事件载荷（message-end.message 展开） | 结构化 blocks / toolCalls，不做字符串往返 |
| RustSessionIndexEntry | 索引条目（如上） | 新增 runStatus / lastMessagePreview / unreadCount（P2） |
| tool_calls_json | toolCalls 数组 | 网关解析后下发结构化 |
| 图片 data URI | 原样或占位 | 裁剪策略见 5.3 |
| 时间 | ISO 8601（createdAt / updatedAt） | 手机端本地化展示 |

---

## 6. 体验要求

### 6.1 消息流滚动流畅

| 手段 | 说明 |
| --- | --- |
| 列表虚拟化 | FlatList（RN）/ RecyclerView（原生），消息行复用；行高缓存避免流式重排 |
| 行级 memo | 移植桌面 assistantRowPropsEqual（ChatAssistantMessageRow.tsx:53-91）：仅当 id/status/text/thinking/toolCalls/blocks/timestamp 变化才重渲染该行 |
| 流式缓冲 | 移植 streamingStore 模式：流式期间活跃行读独立缓冲（text/thinking 增量），终态才 commit 到主数据源（streamingStore.ts:1-11） |
| 渲染降级 | 超长消息（>50KB）不整段渲染文本，仅渲染可视窗口（Text 组件截断） |
| 图片懒加载 | 滚动进入视口才加载（http/data 图片）；本地图片占位不发起请求 |
| 帧率目标 | 目标 60fps：单次 update 的 React 渲染周期 <16ms；流式节流（200ms 批）保证每秒最多 ~5 次列表刷新 |

### 6.2 新消息提示（到底部 / 角标）

| 场景 | 行为 |
| --- | --- |
| 会话详情打开且滚动在底部 | 自动吸底跟随（流式增量直接可见） |
| 详情打开但用户已上滑 | 底部浮现「▼ N 条新消息」悬浮按钮，点击吸底 |
| App 在后台 / 会话未打开 | 推送通知（D7 域）：message-end / run-terminal 触发「新消息」通知；进前台后按游标续拉 |
| 会话列表 | 未读角标（红点 + 数字），见 6.3 |

吸底判定：`scrollOffset + viewport >= contentSize - threshold(≈40dp)`。

### 6.3 已读未读

桌面无未读概念（1.8 缺口），手机端自建本地未读模型：

| 项 | 方案 |
| --- | --- |
| 未读判定 | 会话 `lastReadSequence`（本地持久化）< 会话最新 `sequence` 且最新消息为助手消息 → 未读 |
| 已读时机 | 会话详情打开且滚动到底部（或用户主动吸底）→ 更新 lastReadSequence；P1 不写回服务端 |
| 角标 | 列表红点数字；条目点击进入即清零（本地） |
| 多端已读同步 | P2：已读回传（`mark_read {sessionId, sequence}`），桌面/手机统一已读；桌面侧需新增已读模型（跨域接口，D6 衔接） |
| 清理 | 会话删除/归档时清理本地未读游标 |

### 6.4 弱网与省流

| 场景 | 策略 |
| --- | --- |
| 弱网（3G / 丢包） | 实时订阅降级：节流窗口放大（200ms → 1s）；重连退避（1s / 2s / 4s 指数）；依赖 message-end 终态兜底，delta 丢帧不补救（背压契约，2.3） |
| 流量预算 | 列表刷新仅拉索引（KB 级）；详情按需分页；大消息裁剪（5.3）；图片仅在 Wi-Fi 或「仅 Wi-Fi 加载图片」开关开启时加载（设置项） |
| 省电 | 后台仅收推送（D7），不保持长连接心跳；进前台才续拉（2.3） |
| 缓存命中 | 二次进入同一会话直接读本地缓存 + 增量续拉，不重拉历史 |

---

## 7. 测试点（消息链路验证）

### 7.1 消息链路（事件 → 投影 → 渲染）

| 测试点 | 验证内容 | 参考语义 |
| --- | --- | --- |
| delta 累积 | message-delta 多次推送 → 正文拼接正确（含 thought 分离） | messageHandlers.ts:75-107 |
| message-end 终态 | 终态全文覆盖 delta 累积；同消息终态重放不双气泡 | sessionEventHydrate.ts:243-308 |
| turn 分段 | 多轮 run 的 message-end 按 turnIndex 分段合并（同 turn 覆盖、跨 turn 追加） | sessionEventHydrate.ts:280-291 |
| 工具链路 | tool-start → tool-end 渲染工具卡；中断工具（running 收尾）标 error | sessionEventHydrate.ts:335-393 |
| 幂等重放 | 同 sequence 重复事件消费一次（去重键） | EventRouter.ts:166-189 |
| 顺序保证 | 引擎单通道顺序（不校验 sequence），乱序不处理 | EventRouter.ts:100-105 |

### 7.2 分页 / 增量 / 重连

| 测试点 | 验证内容 |
| --- | --- |
| 首屏拉取 | 最近 1-2 页事件投影正确；跨页同消息（delta 在 A 页、end 在 B 页）不撕裂 |
| 上滑翻页 | before 游标反向分页；hasMore=false 停止；50 页上限截断打「未完整」标记 |
| 断线重连 | 重连后 lastSequence 续拉补齐；丢 delta 由 message-end 兜底，无文本缺失 |
| 缓存续拉 | 本地缓存 + 增量合并；缓存损坏（坏 JSON）降级全量重拉 |
| 未读游标 | lastReadSequence 前移正确；新消息到达未读角标 +1；清零时机正确 |

### 7.3 渲染

| 测试点 | 验证内容 |
| --- | --- |
| markdown 子集 | 段落/标题/列表/引用/行内代码/围栏代码块渲染正确；不支持语法降级安全（无 XSS、无崩溃） |
| 长消息 | 用户长消息折叠/展开；超长助手正文不卡顿；思考预算截断提示 |
| 工具卡 | 折叠/展开；状态图标映射；diff 统计；并行工具组 |
| 图片 | http/data 加载；local 占位；加载失败占位 + alt；unsafe 不渲染 |
| 流式 | 思考中 spinner；正文 caret；200ms 节流批渲染；终态 commit 无闪烁 |

### 7.4 同步 / 性能

| 测试点 | 验证内容 |
| --- | --- |
| 裁剪 | >8KB 正文截断 + 占位；P2 补拉全文一致 |
| 大会话 | 1000 消息会话：首屏 <2s、滚动 60fps、内存 <200MB |
| 弱网 | 3G 节流下订阅重连、游标续拉正确；Delta 丢帧不致命 |
| 多端并发 | 桌面 + 手机同时打开同一会话，两端消息一致（以事件流为真相源） |

### 7.5 列表与交互测试

| 测试点 | 验证内容 |
| --- | --- |
| 列表渲染 | 索引条目渲染：标题截断（28 码点）、相对时间、运行徽标、未读角标；置顶分段排序正确 |
| 列表刷新 | 下拉刷新重拉索引；桌面产生新消息后列表 updatedAt / 预览 / 角标实时更新（订阅推送） |
| 详情导航 | 列表 → 详情跳转参数正确；返回列表滚动位置保留；深链（会话 id）直达 |
| 消息操作 | 复制（含思考/工具输出组装）；长按菜单可访问性（TalkBack / VoiceOver）；引用条插入与取消 |
| 思考折叠 | 折叠/展开；思考中自动展开且不可折叠；预算截断提示「已截断」 |
| 工具卡 | 折叠/展开；状态图标映射；组折叠「N 步」；中断工具灰标 |
| 状态机 | queued → processing → completed / error 迁移正确；重新生成（P2）清空旧终态再进 processing |
| 空态 / 错误态 | 空会话、引擎离线、会话不可访问、拉取失败重试各状态展示与恢复（2.7） |
| 无障碍 | 字体缩放（动态字体）下布局不破；对比度达标；朗读顺序正确 |
| 省流 | 弱网降级、重连退避、流量预算开关生效（6.4） |

### 7.6 端到端回归（与桌面对照）

| 测试点 | 验证内容 |
| --- | --- |
| 同会话双端一致性 | 桌面 run 全程，手机端增量与桌面最终消息流逐条一致（id / text / thinking / toolCalls 状态） |
| 历史兼容 | 桌面旧会话（含中断工具、多轮 turn 分段、截断态）在手机端渲染与桌面一致 |
| 断线恢复 | 手机端中途断网 → 重连 → 游标续拉 → 消息无缺失无重复（对照桌面 hydrate 语义） |
| 持久化往返 | 手机端缓存 → 重启 App → 缓存加载 + 增量补齐正确 |

---

## 8. 与桌面差异点汇总与开放问题

### 8.1 能力差异表

| 维度 | 桌面现状 | 手机端（P1） | 差异处理 |
| --- | --- | --- | --- |
| markdown 渲染 | Rust md_render + worker fallback | 自研轻量子集 | 手机端不引入重型引擎（3.1） |
| 代码高亮 | worker highlight.js | P1 无高亮，P2 子集/服务端 | 视觉降级可接受 |
| 全文搜索 | 纯前端内存搜索（全量消息在手） | 标题搜索 + 会话内已加载消息搜索 | 数据可得性约束（2.6） |
| 未读 | 无 | 本地未读模型 | 新增能力（6.3） |
| 实时 | 进程内 IPC | 网络订阅（网关） | 背压分级兜底（2.3） |
| 缓存指标 | 桌面展示 badge | 手机隐藏 | 信息降噪 |
| 审批 | 桌面弹窗 | P1 无；P2 路由桌面 | 依赖审批路由（2.5） |
| 子 agent 消息 | 面板内联渲染 | P1 仅计数 | 递归体积问题（5.3） |

### 8.2 开放问题（需主控/跨域裁决）

1. 网关「会话事件订阅」通道的归属：本域提出协议（subscribe_session_events +
   read_session_events 续拉），具体传输（WS / SSE / 长轮询）由 D6 同步域定稿；
2. 服务端全文搜索接口（2.6 P2）需要服务端索引能力，属服务端域；
3. 手机端发起 run（2.5 P2）的审批路由与安全审计（requester 溯源）需与安全域（D5）联合设计；
4. 「查看全文」补拉接口（5.3 P2）需要网关透传单条消息全文，属服务端域；
5. 已读多端同步（6.3 P2）需桌面端新增已读模型，桌面侧改动需主控排期。

### 8.3 验收红线（P1 范围）

- 会话列表：标题 / 相对时间 / 运行状态 / 未读角标四要素齐全；
- 会话详情：用户/助手消息、思考折叠、工具摘要卡、代码块、图片占位渲染正确；
- 实时会话：桌面 run 进行中手机端能增量看到正文（节流 ≤500ms 延迟），断线重连不丢终态；
- 历史会话：分页翻页正确，跨页消息不撕裂；
- 搜索：标题搜索可用；会话内搜索命中高亮；
- 消息操作：复制可用；转发/引用在 P2 入口占位；
- 消息链路测试（7.1-7.6）全绿。

### 8.4 里程碑与依赖关系

| 阶段 | 依赖 | 交付物 |
| --- | --- | --- |
| P1-M1 只读骨架 | 网关基础通道（D6）、列表/详情接口 | 会话列表 + 历史详情 + 分页 + 本地缓存 |
| P1-M2 实时 | 事件订阅通道（2.3） | 实时增量 + 断线重连 + 新消息提示 + 未读角标 |
| P1-M3 渲染与搜索 | 轻量 markdown 子集实现 | 消息流完整渲染 + 会话内搜索 + 消息操作 |
| P2-M1 委托执行 | 网关 run 转发 + 审批路由（D5） | 发起会话/发消息 + 乐观消息 + 重新生成 |
| P2-M2 补全 | 网关全文补拉接口 | 查看全文 + 完整工具输出 + 图片按需加载 |
| P2-M3 已读同步 | 桌面已读模型（跨域） | 多端已读回传 + 服务端全文搜索 |

依赖清单（跨域）：D6 同步一致性（订阅通道 / 游标 / 缓存）、D5 安全（订阅鉴权 /
审批路由 / 审计）、D7 推送通知（后台新消息）、D4 移动端技术选型（markdown 子集实现
载体 / 存储选型）。

---

（本文档结束）
