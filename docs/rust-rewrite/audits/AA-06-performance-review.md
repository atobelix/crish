# AA-06 性能审查报告（conex 系统）

- 审查日期：2026-08-01
- 审查方式：只读代码走查（Rust 热点 / 前端渲染路径 / 启动序列 / 内存策略）
- 覆盖范围：session-loop 主循环、conex-db 写入路径、agent-provider 流解析、事件桥（sequence/背压）、工具执行、前端流式渲染（StreamRenderBuffer/批合并）、markdown 渲染、消息列表、store 更新频率、启动序列、长会话内存

---

## 一、总览

| 面 | 瓶颈 | 影响 |
|---|---|---|
| 首次 token 延迟（Rust→前端） | `HttpProviderCall::stream`（engine.rs:293-324）把整个 SSE 流**全量缓冲**后才返回事件序列；session-loop 再一次性 emit 整块 message-delta | 首个字符到 UI 的延迟 ≈ 完整响应时长。长回复期间前端只显示 placeholder，中途无法增量渲染/增量取消；前端流式渲染管线（StreamRenderBuffer/48ms 批）已就绪但无增量数据源 |
| 事件链克隆/序列化（Rust） | 每个持久化事件经历 2 次深克隆 + 1 次 JSON 序列化（`drive_outcome` 的 `event.clone()` + `event_type_name` 内部信封克隆 + `serde_json::to_string`）；message-end 携带完整消息体 | 多工具批/长回复下 CPU 与 GC 压力显著；工具批事件（tool-start/end×N）放大明显 |
| 对话全量克隆（Rust） | `build_request` 每轮 `state.conversation.clone()`（streaming.rs:156）；run 收口 `conversation.clone()`（loop/mod.rs:430）；`record_message` 每消息 2 次全文克隆（handlers/mod.rs:147-154） | 1000+ 消息长会话：每轮 O(对话总大小) 深拷贝，多轮累计 O(n²) |
| DB 写入路径 | `append_event` 单条 INSERT 每次加锁；`save_session_body` 先删后插全量重写（含逐行触发器 UPDATE）；前端每次消息 commit 全量保存 + localStorage 镜像双写 | 写放大：每次 commit 写全部消息（O(n)），长会话每轮新消息触发全量重写 |
| 事件分页 | `read_session_events_impl`/`read_run_events_impl` 调 `query_events` 无 limit（SQL 层 i64::MAX），全量加载后内存重建信封再分页 | 会话 hydrate/重放页首请求 O(全部事件)，长会话卡顿 |
| 工具执行并行度 | `approval_enabled` 时并行组退化为顺序（ApprovalGate 是 `&dyn` 无法跨 async move 共享） | 审批模式下多工具批串行执行，批延迟 = 各工具耗时之和 |
| 前端流式渲染 | 参数 6ms/8192 字符合理；但 `fullText += delta` 字符串拼接、`pending.slice()` 每帧新数组 | 超长文本（10 万+ 字符）单次流式输出时拼接退化；常规场景无感 |
| 前端 markdown | 流式期纯文本零 IPC（良好）；完成态 Rust `md_render` IPC + 双上限 LRU + 并发去重（良好） | 无显著瓶颈；仅消息极多时每消息 1 次 IPC（已有 `md_render_batch` 未在单条路径使用） |
| 消息列表 | 尾部窗口（默认 80 条）+ 可变行高虚拟滚动 + ResizeObserver 实测 + content-visibility（良好） | 已解决 1000+ 消息渲染问题，未见 O(n²) |
| store 更新频率 | 流式正文走独立 streamingStore（48ms 批 + 8000 字符强制 flush），订阅者仅 2 个组件；终态一次 commit | 每 delta 不会触发会话 store 全树 diff（良好） |
| 启动 | Rust setup 同步链（DB open+migrate→引擎装配）<50ms 量级；前端 bootstrapCore 并行化；产品壳 12s gateTimer 兜底 | 无严重串行阻塞；DB/引擎初始化可后移至 spawn_blocking（低优先） |
| 内存 | session-loop `conversation` 无上限增长（CompressionHook 默认关闭）；前端会话消息全量驻留 + 工具 output 无 store 层截断；事件表只增不删 | 超长会话内存/磁盘持续增长 |

---

## 二、问题清单

### Rust 侧

#### P1【高】流式非增量：全量缓冲后才 emit message-delta
- **文件:行号**：`apps/agent-workbench/src-tauri/src/engine.rs:293-324`（`HttpProviderCall::stream` 先 `read_stream` 收完全部 frames，再 `for frame in &output.frames` 逐帧 `push_frame` 收集进 `Vec<ProviderStreamEvent>`，流结束才返回）；`crates/agent-provider/src/transport/mod.rs:51-59`（`read_stream` 返回完整 `StreamReadOutput`）；`crates/session-loop/src/loop/handlers/streaming.rs:46,234-245`（一次性 await 返回的 Vec，`emit_message_deltas` 逐 **block** 整块 delta）
- **瓶颈描述**：整个 SSE 流在内存中攒齐后才进入 session-loop；前端收到的 message-delta 是整块全文（单条事件），增量渲染无从谈起
- **触发场景**：任何流式回复；长回复（数千 token）时尤为严重
- **优化建议**：
  1. `ProviderCall::stream` 返回类型改为增量流（`Pin<Box<dyn Stream<Item=ProviderStreamEvent> + Send>>` 或 tokio mpsc channel）；
  2. `HttpProviderCall` 在 `read_sse` 回调/逐帧循环内边解析边发送（把 `transport::read_stream` 扩展为逐帧回调或流式迭代器）；
  3. `streaming.rs::handle` 边收边 `emit_message_deltas`（逐 delta 文本块产出一条 `AgentEvent::MessageDelta`，而非聚合后整块）。`consume` 聚合逻辑改为流式增量聚合；
  4. 前端无需改动：`EventRouter.ts:199-216` 已支持增量 `assistantText += t` 累加，`StreamRenderBuffer`/48ms 批已在等数据。

#### P2【高】事件链每事件 2 次深克隆 + 1 次序列化
- **文件:行号**：`crates/orchestrator/src/events.rs:277`（`queue.push(&run.session_id, event.clone())`）；`crates/orchestrator/src/events.rs:56-58`（`event_type_name` 构造 `AgentEventEnvelope::new(event.clone(), None, None)` 只为取 type 名——对 `MessageEnd` 会克隆**完整消息体**）；`crates/orchestrator/src/events.rs:136`（`serde_json::to_string(&event)`）
- **瓶颈描述**：每个持久化事件 = drive_outcome 1 次深克隆 + type_name 1 次深克隆 + 1 次完整序列化；MessageEnd/MessageStart 含全文，代价最大；再叠加 `core_run_commands.rs:360` 分发时 `sequenced.event.clone()` 第 3 次克隆
- **触发场景**：每个 run 的 agent-start/message-start/message-end/agent-end/run-terminal + 工具批 N×(tool-start/tool-end)
- **优化建议**：
  1. 在 `AgentEvent` 上直接实现 `pub fn type_name(&self) -> &'static str`（把 `AgentEventEnvelope::type_name`（conex-types/src/events.rs:399）的 match 抽出来复用），`event_type_name` 改为直接调用，删除信封构造；
  2. `EventQueue::push` / `drive_outcome` 改为接收 `&AgentEvent`（序列化时借用，不 clone）；
  3. `core_run_commands.rs:359-366` 分发循环改为 `std::mem::take` 或 Arc 共享，避免第三次克隆。

#### P3【高】对话全量克隆：每轮 build_request + 每次 run 收口
- **文件:行号**：`crates/session-loop/src/loop/handlers/streaming.rs:156`（`messages: state.conversation.clone()`）；`crates/session-loop/src/loop/mod.rs:430`（`messages: self.state.conversation.clone()`）
- **瓶颈描述**：每轮 streaming 把全部历史消息深拷贝进 `ProviderRequest`；长会话下每轮 O(n)，多轮 O(n²)；run 收口再全量克隆一次
- **触发场景**：长会话（1000+ 消息）多轮 run；每轮工具调用循环（每轮一次 streaming）
- **优化建议**：
  1. `ProviderRequest.messages` 改为借用切片（`&[AgentMessage]`）或 `Arc<Vec<AgentMessage>>`；`build_chat_completions_request_body` 的 `RequestBuildContext.messages` 同步改引用；
  2. `RunOutcome.messages` 改 `Arc<Vec<AgentMessage>>`（`converge` 里 `Arc::clone` 零拷贝），消费方（`drive_outcome` 不需要 messages 字段）可整体移除。

#### P4【中】record_message 每消息 2 次全文克隆
- **文件:行号**：`crates/session-loop/src/loop/handlers/mod.rs:147-154`
- **瓶颈描述**：`MessageStart { message: message.clone() }` + `conversation.push(message.clone())` + `MessageEnd { message }`（移动），同一条消息正文被复制 2 次
- **触发场景**：每条 assistant 消息（含工具结果消息）
- **优化建议**：
  1. 前端 `EventRouter` 并无 message-start 消费分支（handleAgentEvent 未匹配即忽略），message-start 可瘦身为只带 `message_id`；
  2. 若重放需要 message-start 全文：`conversation` 改存 `Arc<AgentMessage>`，MessageStart/MessageEnd 携带 `Arc<AgentMessage>`（序列化时解引用），record_message 零拷贝。

#### P5【中】SSE 帧解析：每帧全树 JSON + 事件 clone
- **文件:行号**：`crates/agent-provider/src/parse/chat.rs:68`（`serde_json::from_str::<Value>` 全树解析）；`:80, :170, :222`（`self.stream.extend(events.clone())` 每帧 clone 一次）
- **瓶颈描述**：每帧分配完整 JSON Value 树；返回事件与内部校验各持一份（clone）
- **触发场景**：高 token 率流式（每 token 一帧时每帧 1 次 Value 树 + 1 次事件克隆）
- **优化建议**：
  1. `StreamParser::extend` 改接收 `&[ProviderStreamEvent]` 借用（校验只读）；
  2. 用 serde 派生结构体（`#[derive(Deserialize)]` 的 `ChatDeltaFrame { choices: Vec<Choice { delta: Option<Delta>, ... }>, usage: Option<Usage> }`）替代 `Value` 全树解析，只提取需要的字段。

#### P6【中】DB 写入：单条落库 + 全量重写 + 前端双写放大
- **文件:行号**：`crates/conex-db/src/lib.rs:285-304`（`append_event` 每次 Mutex lock + 单条 INSERT，无批处理）；`:490-541`（`save_session_body` 先 DELETE 全表再逐条 INSERT，且 `trg_session_messages_insert` 触发器每行 UPDATE sessions）；`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:511-532`（每次 commit 全量 `save_session_body` + 镜像写 localStorage）；`:827`（hydrate 时逐会话 `saveSessionBody`）
- **瓶颈描述**：每次消息 commit 重写整个会话正文（O(n) 行 DELETE+INSERT + n 次触发器 UPDATE + LS 全量 JSON 序列化）；写放大与消息数成正比
- **触发场景**：每条消息终态 commit；启动 hydrate 多会话；长会话每轮 commit
- **优化建议**：
  1. 前端 commit 路径改调**已存在但未接线**的 `append_session_messages`（conex-db/src/lib.rs:543-601，增量追加）替代全量 save；
  2. `LocalDbStore` 增加事务化批量 `append_events(&[(seq, type, payload)])`，事件落库一批一次事务；
  3. `save_session_body` 改为按 seq `INSERT ... ON CONFLICT(seq) DO UPDATE`（保留超出现有列表的旧行）避免全删；
  4. localStorage 镜像（sessionRustDb.ts:523-527）改为仅活跃会话或低频节流。

#### P7【中】事件分页全量加载
- **文件:行号**：`apps/agent-workbench/src-tauri/src/core_query_commands.rs:262-267`、`:301-306`（`query_events` 不带 limit）；`crates/orchestrator/src/persist.rs:436`（`LocalDbStore::query_events` 传 `None` → SQL `LIMIT i64::MAX`）
- **瓶颈描述**：页首请求把该会话 `after_sequence` 之后**全部**事件读入内存，`assign_run_ids` + `reconstruct_envelopes`（逐条 JSON 序列化）后再内存分页；每次翻页重复全量
- **触发场景**：长会话 hydrate（每消息 2-3 个持久化事件，1000 消息 ≈ 3000 行）
- **优化建议**：SQL 层直接 `LIMIT limit+1` 分页（表已有 `idx_events_session_seq` 索引）；段归属（run 边界判定）改为先查 `run-terminal` 锚点（`WHERE event_type='run-terminal' AND payload LIKE %run_id%`）缩小范围，再按范围查询。

#### P8【中】工具执行：审批模式并行退化为顺序 + 每工具克隆
- **文件:行号**：`crates/session-loop/src/tool_exec.rs:122-133`（`approval_enabled` 时并行组 for 循环串行，注释自述原因：ApprovalGate 是 `&dyn` 无法跨 async move 共享）；`:147-161`（并行分支每个 future 克隆 `call`/`ctx`/`options` 三个结构）
- **瓶颈描述**：审批开启时 N 个并行工具的批延迟 = Σ 单工具耗时（如 5×1s = 5s）；无审批时每次 spawn 3 次结构克隆
- **触发场景**：审批模式下多工具批（批量读文件/搜索等本可并行的工具）
- **优化建议**：
  1. `ApprovalGate` 改 `Arc<dyn ApprovalGate>`（trait 加 `Send + Sync` 已满足），并行组中 clone Arc 共享，恢复并行+审批；
  2. future 捕获改 `Arc<ToolBatchCall>` 或仅克隆变化字段（`call.input` 深克隆可改为 `Arc<Value>`）。

#### P9【低】事件桥序列化/克隆链
- **文件:行号**：`apps/agent-workbench/src-tauri/src/core_event_bridge.rs:198`（flush 每帧 `serde_json::to_string`）；`apps/agent-workbench/src-tauri/src/engine.rs:79`（`BufferedRunEventBridge::emit` 克隆整个信封）；`apps/agent-workbench/src-tauri/src/core_run_commands.rs:360`（`sequenced.event.clone()`）
- **瓶颈描述**：事件从产生到 emit 经历 2-3 次拷贝 + 1 次序列化；`EventBuffer` 存 `AgentEventEnvelope`（含事件体）而非序列化后字符串
- **优化建议**：入队时即序列化为 payload 字符串（`EventBuffer` 存 `(DropClass, String)`，丢帧判定只需事件类别），flush 直接 emit 字符串；`enqueue_envelope` 改 `&AgentEventEnvelope` 借用。

#### P10【低】EventBuffer 丢帧线性扫描
- **文件:行号**：`apps/agent-workbench/src-tauri/src/buffer.rs:110-120`
- **瓶颈描述**：超水位时两次 `position` 线性扫描（Delta→Soft）；仅在 emit 失败积压场景触发，影响有限
- **优化建议**：`RunQueue` 增加 `delta_count`/`soft_count` 计数，或维护按 DropClass 分桶的双端队列，O(1) 定位可丢帧（低优先）。

#### P11【中】session-loop 对话无上限增长（内存）
- **文件:行号**：`crates/session-loop/src/loop/handlers/mod.rs:66,152`（`conversation: Vec<AgentMessage>` 只 push 不截断）；`crates/session-loop/src/loop/mod.rs:103-109`（`CompressionHook` 默认关闭）
- **瓶颈描述**：跨 run 持久对话无限膨胀；叠加 P3/P4 的克隆，长会话内存与 CPU 双劣化
- **优化建议**：实现并启用 `CompressionHook`（如消息数 > N 时把旧消息压缩为摘要块）；run 边界对 `conversation` 做滚动窗口（保留最近 200 条 + 摘要）。

### 前端

#### F1【高】首次 token 延迟（与 P1 同源，前端视角）
- **文件:行号**：`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:161-179`（`StreamRenderBuffer` 已接线，`onFrame → setStreamText`）；`apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts:199-216`（已支持增量 `assistantText += t`）
- **瓶颈描述**：前端渲染管线完整，但 Rust 全量缓冲导致前端直到流结束才收到第一条 delta；且 delta 是整块全文（`emit_message_deltas` 逐 block），渲染分帧（8192 字符/帧）只能把「已收全文」摊到多帧，无法提前显示
- **优化建议**：同 P1。前端无需改动。

#### F2【低】StreamRenderBuffer 拼接与切片
- **文件:行号**：`apps/crish-desktop/src/api/StreamRenderBuffer.ts:46-48`（参数 6ms/8192，注释 120FPS 预算推导正确，验证良好）；`:197`（`this.pending = this.pending.slice(consumed)` 每帧新数组）；`:219`（`this.fullText += delta` 每帧全量拼接）；`:127-133`（`bufferedLength()` 全量扫描）
- **瓶颈描述**：超长文本（10 万+ 字符，如整文件贴入回复）时 `fullText +=` 拼接退化（V8 rope 缓解但仍有次线性成本）；`slice` 每帧分配
- **优化建议**：`fullText` 改为保存分块数组，`frame.full` 在 onFrame 时惰性 `join('')`（或仅 `isFinal` 时计算）；pending 消费用下标游标 + 惰性清理；`bufferedLength` 维护增量计数。参数本身（6ms/8192）无需调整。

#### F3【低】streamingStore 每 48ms 全量 spread
- **文件:行号**：`apps/crish-desktop/src/store/streamingStore.ts:137-146`（`byKey: { ...state.byKey, [key]: ... }`）
- **瓶颈描述**：每 48ms 批 flush 重建整个 byKey 对象；订阅者仅 2 个组件（MessageContent.tsx:47、ChatAssistantMessageRow.tsx:129），活跃条目通常 1-2 条，实际代价可忽略
- **优化建议**：无需改动（已良好）。若未来条目增多，可改 `Map`。

#### F4【低】完成态 markdown 单条 IPC
- **文件:行号**：`apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx:33-38,51-59`（流式期 `renderTarget=''` 零 IPC，验证良好）；`apps/crish-desktop/src/api/markdownRenderAsync.ts:37-43`（Rust 优先 + LRU 缓存命中同步返回 + 并发去重，验证良好）；`apps/crish-desktop/src/api/markdownCache.ts:32-36`（双上限 LRU，验证良好）
- **瓶颈描述**：无显著瓶颈；仅 1000+ 消息首屏/展开时每条 1 次 IPC（有 `md_render_batch` 批量命令）
- **优化建议**：批量展开/首屏路径改 `markdownPreload.ts` 的 `renderMarkdownBatch`（已有实现，只需在展开「全部消息」路径接线）。

#### F5【低】store 层工具输出无截断
- **文件:行号**：`apps/crish-desktop/src/api/messageWindow.ts:58-62`（`THINKING_DOM_CHAR_CAP=4000` / `TOOL_OUTPUT_DOM_CHAR_CAP=8000` 仅在 DOM 层截断）；store 内 `toolCalls[].output` 全量保留
- **瓶颈描述**：大量大输出工具（read_file 输出 100KB+）时内存持续增长
- **优化建议**：commit 进 store 时对 output 超 8KB 截断 + 附 `truncated` 标记（展开时再拉全文——需新增按需加载路径，或先只截断保存）。

#### F6【低】启动串行链
- **文件:行号**：`apps/agent-workbench/src-tauri/src/main.rs:138-201`（tauri setup 同步执行：config init → DB open+migrate（PRAGMA/DDL 检查）→ `EngineHandle::init`（配置加载 + 工具注册）→ 装配）；`apps/crish-desktop/src/bootstrap-core.ts:12-34`（前端 Promise.all 并行，验证良好）；`apps/crish-desktop/src/app/useEngineBootstrap.ts:50`（产品壳 12s gateTimer 兜底）
- **瓶颈描述**：DB migrate 与工具注册在 webview 加载前同步执行；本地 SQLite 通常 <50ms，无严重阻塞，但纯串行
- **优化建议**：DB open/migrate 与 `build_tool_registry` 移入 `spawn_blocking`（引擎 ready 标志异步置位，`core_get_status` 已支持未就绪降级）；低优先。

#### F7【中】会话持久化双写放大（与 P6 同源，前端视角）
- **文件:行号**：`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:511-532`（SQLite 全量 + LS 镜像双写）；`:827`（hydrate 逐会话全量保存）
- **瓶颈描述**：每消息 commit 全量传输+重写；长会话（1000+ 消息）每次 commit 序列化/传输全部消息
- **优化建议**：同 P6：commit 改增量 `append_session_messages`；LS 镜像节流。

### 内存（跨端）

#### M1【中】前端会话消息全量驻留
- **文件:行号**：`apps/crish-desktop/src/store/layoutStore.ts`（sessionsById 每会话全量消息数组，含 `blocks`+`text` 双份、`toolCalls[].output` 全量）；消息列表窗口化仅控制 DOM 挂载，不释放 store 数据
- **瓶颈描述**：长会话消息文本+工具输出全量常驻内存；1000+ 消息 × 平均 2KB ≈ 数 MB~数十 MB，且只增不减
- **优化建议**：不可见旧消息（窗口外 + 未 pin）降级为元数据（text/toolCalls 置空），需要时经 `load_session_body` 按需恢复；与 P6 的增量持久化配合。

#### M2【低】事件表/run 表只增不删
- **文件:行号**：`crates/conex-db/src/lib.rs:126-137`（events 表无清理策略）
- **瓶颈描述**：每消息 2-3 个持久化事件累积；叠加 P7 全量扫描，长会话磁盘与查询双增长
- **优化建议**：终态 run 超过 N 天后清理其事件行（保留 run 记录）；或滚动窗口（只留最近 M 条/天）。

---

## 三、已验证良好项

| 项 | 位置 | 说明 |
|---|---|---|
| 前端流式渲染管线（分层节流） | StreamRenderBuffer.ts + streamTextBatcher.ts + streamingStore.ts | rAF 分帧（6ms/8192，120FPS 预算推导正确）+ 48ms 定时批 + 独立轻量 store，终态一次性 commit 会话 store；订阅者仅 2 个组件 |
| 流式期 markdown 零 IPC | AsyncMarkdownBlock.tsx:33-38,51-59 | 流式期纯文本 + caret，不触发任何 IPC/HTML 解析 |
| 完成态 markdown 缓存链 | markdownCache.ts（双上限 LRU + 内存压力收缩 + 统计）、markdownRenderAsync.ts（并发去重）、conex-markdown/src/cache.rs（moka 32MB/2048 条目） | Rust 侧 spawn_blocking 不阻塞主线程；JS/Rust 双端缓存口径一致（UTF-16 len×2） |
| 消息列表长会话策略 | messageWindow.ts（尾部 80 条 + 步进展开 + must-include 保活）、MessageVirtualizer.tsx（可变行高虚拟滚动 + overscan 6 + ResizeObserver 实测 + memo 比较器）、content-visibility | 三层防护，1000+ 消息 DOM 挂载量有界 |
| delta 不落库不阻塞 | orchestrator/src/events.rs:42-48,127-134（EventClass 分流）；tests 验证 120 delta 不阻塞 drive loop | 事件序列连续性 + 持久化分流设计正确 |
| 事件背压丢帧策略 | buffer.rs:41-58（Delta→Soft 优先丢，Critical 永不丢，含测试） | 设计完备，仅实现细节（P10）可优化 |
| 工具并行执行（无审批） | tool_exec.rs:134-184（并行组 join_all 并发，测试断言耗时 <95ms） | 无审批时并行正确 |
| 事件分页游标 | core_query_commands.rs:91-110（nextAfterSequence 分页纯函数 + 限页） | 接口正确，仅 SQL 层未下推（P7） |
| 前端启动并行 | bootstrap-core.ts:12-34（Promise.all 三路）、AppBootstrap.ts（各 effect 独立并行）、hydrateWorkspaceShell 门闩 | 无明显串行等待 |
| 流式批合并终态保障 | streamTextBatcher.ts（flushNow/嵌套保护/回填）、beforeunloadFlush 注册 | 终态不丢、异常回填 |

---

## 四、优化优先级（见效快 / 风险低优先）

### 第一批：收益最大，改动集中（1-2 天内）

1. **P2 事件克隆风暴**——删除 `event_type_name` 的信封克隆（改 `AgentEvent::type_name()` match 实现），`push`/`drive_outcome` 改借用。纯内部优化，无协议变更，风险极低，收益立即体现（每事件省 2 次深克隆）。
2. **P5 帧解析**——`StreamParser::extend` 改借用 + serde 派生结构体替代 Value 全树。独立模块，单测完备（chat.rs 已有大量测试锚定），风险低。
3. **P7 SQL 分页下推**——`LocalDbStore::query_events` 传 limit，SQL 已有 `LIMIT ?3` 支持。接口签名不变，风险低，长会话 hydrate 立竿见影。

### 第二批：结构性改动，需配套测试（1 周）

4. **P1 流式增量**——`ProviderCall::stream` 改流式返回，`HttpProviderCall` 边收边发，`streaming.rs` 边收边 emit delta。这是**首次 token 延迟**的根本解，影响 trait 签名与 session-loop 状态机消费方式（`consume` 改增量聚合），需配套 run_loop/divergence 测试更新。前端零改动。
5. **P6 DB 写放大**——前端 commit 接 `append_session_messages`（API 已存在）+ `save_session_body` 改 upsert。改动在持久化路径，数据一致性需回归（AA-07 数据持久化审查可协同）。
6. **P3/P4 对话克隆**——`conversation` 与 `ProviderRequest` 改引用/Arc，`RunOutcome.messages` 改 Arc。需要核查 `build_chat_completions_request_body` 借用链（crates/agent-provider/src/request/messages.rs）。

### 第三批：内存与长会话治理（持续）

7. **P11 + M1 会话消息上限**——启用 `CompressionHook`（Rust）+ 前端窗口外消息降级/按需加载（M1）。
8. **F5 store 层工具输出截断**——与 DOM 预算对齐（8KB），阻止长会话内存膨胀。
9. **M2 事件表滚动清理**——终态 run 事件定期归档。

### 低优先（可选）

10. P8 审批模式并行恢复（Arc<ApprovalGate>）、P9 事件桥序列化前置、P10 背压分桶、F2 StreamRenderBuffer 惰性 full 计算、F4 批量展开接 md_render_batch、F6 启动项 spawn_blocking 化。

---

## 附：现有基准/压力测试结论

- `tests/stress/`（stress-runner.ts + 4 场景）：纯 JS 场景模拟（AI 流、会话切换、diff 加载），覆盖 FPS/内存/延迟阈值；**不覆盖 Rust 侧**（session-loop、事件链、DB 写路径）——建议补充 Rust 侧基准：事件链克隆成本（P2）、对话克隆（P3）、DB 全量重写（P6）、SSE 帧解析（P5）。
- `apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`：前端流式缓冲模糊测试，覆盖 StreamRenderBuffer 分帧。
- `crates/**/benches/`：**不存在** Criterion 基准目录——Rust 侧无基准测试，P1-P8 的量化数据需后续补测（本报告为代码走查结论）。
