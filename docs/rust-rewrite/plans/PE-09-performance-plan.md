# PE-09 性能优化域任务书（AA-06 落地）

> 状态：草稿（只读研究产出，本任务书不含任何代码改动）
> 输入事实：`audits/AA-06-performance-review.md`（P1/P2/P3/P6/P7/P8 + 已验证良好项清单）
> 本任务书范围：Rust 侧 + 跨端持久化/事件通道的性能优化；**不改前端渲染逻辑**
> 关联文档：`03-frontend-contract.md`（事件序列化形状）、`00-master-plan.md` §1 多 Agent 轮次章程、
> `audits/AA-07-data-persistence-review.md`（P6 数据一致性回归协同）

---

## 修订记录

| 版本 | 日期 | 修订依据 | 要点 |
|---|---|---|---|
| v1 | 2026-08-01 | — | 初版 |
| v2 | 2026-08-01 | **AU-04 接口冻结裁决** | ① T09.1.1：契约引用 PE-02 §3.1 SoT（F1 冻结 v1），别名统一 `ProviderStreamItem`（弃 `StreamItem`）+ `ProviderEventStream`；`ProviderRequest<'a>` 生命周期照旧；T09.1.3 验收显式引用锚点 `crates/session-loop/tests/streaming_incremental_contract.rs`；首 token 阈值按 F1 三测量点（600ms 集成硬断言 / 500ms 端到端归 PE-02 T02.6 / 300ms 降为 T09.7 内部基准，G1 目标改写）；② T09.4.1：**删除 save_session_body 改 upsert**（F7，R6 撤销），保留 append_session_messages 命令（session 族第 13 个，唯一负责本任务；PE-08 提供底层增量 API + manifest 登记），hydrate 保留全量；③ T09.5 与 PE-08 T08.x 串行声明；④ T09.6 按 F9 冻结（Arc<dyn> 跨 async 边界 + 执行模型取定 A）；⑤ 新增 **T09.8「首 token 总验收 owner」**（原 T09.8 复测顺延为 **T09.10**）；新增 **T09.9「abort 时序三修复」（Q21/Q33/Q40，认领表 #1，T09.1 之后执行）**；⑥ 基线文档合并为单一 `docs/rust-rewrite/audits/PE-perf-baseline.md`（T09.7 维护，PE-02 写入）；⑦ P11 压缩「后续域」改「登记不做」（认领表 #16）；⑧ 同文件串行声明：streaming.rs/handlers/mod.rs 与 PE-06、transport/mod.rs 与 PE-10（依赖升级先行）、tool_exec.rs 与 PE-06 T06.1（PE-06 先行）；criterion 0.5 依赖增量统一由 PE-10 管理（只提需求） |

---

## 0. 术语、目标与边界

### 0.1 术语

| 术语 | 含义 |
|---|---|
| 首 token 延迟 | 从 provider 返回流首字节到前端收到第一条 `message-delta` 的端到端时间 |
| 每 token 处理耗时 | Rust 侧对单个流事件（TextDelta）完成解析→聚合→产出事件的平均 CPU 耗时 |
| 克隆风暴 | 同一份事件/消息数据在一次驱动循环中被深克隆多次（P2） |
| O(n²) 对话克隆 | 每轮把全部历史消息深拷贝进请求，多轮累计二次方（P3） |
| 写放大 | 每次 commit 实际写入 DB 的行数 / 新增消息行数之比（P6） |

### 0.2 目标（量化验收标准）

| 编号 | 瓶颈 | 现状（代码走查结论） | 目标 |
|---|---|---|---|---|
| G1 | 首 token 延迟（P1/F1） | ≈ 完整响应时长（全量缓冲后才 emit） | 首条 message-delta 到达事件桥：**集成硬断言 < 600ms**（本地 mock SSE 慢速分块）；前端端到端 `requestToFirstChunkMs` **< 500ms**（归 PE-02 T02.6 总验收）；「流产出后 ≤ 300ms」**降为 T09.7 内部基准记录，不作验收门**（F1 三测量点口径，不得新增第四套数字） |
| G2 | 事件克隆风暴（P2） | 每持久化事件 2 次深克隆 + 1 次序列化；MessageEnd 携带完整消息体 | 0 次深克隆 + 1 次序列化（借用/所有权移动） |
| G3 | 对话全量克隆（P3） | 每轮 `state.conversation.clone()` O(n)；`record_message` 每消息 2 次全文克隆 | 请求构建链 0 拷贝；record_message 0 深克隆；每轮 O(1) |
| G4 | DB 写放大（P6） | 每次 commit 全量 DELETE+INSERT（O(n) 行）+ n 次触发器 UPDATE + LS 双写 | commit 路径增量追加 O(新消息数)；hydrate 全量仅首次落地 |
| G5 | 事件分页全量加载（P7） | 首页请求读全部事件（`LIMIT i64::MAX`）再内存分页 | SQL 层 `LIMIT limit+1` 下推，页首请求读取 O(limit) |
| G6 | 审批并行退化（P8） | approval_enabled 时并行组串行（批延迟 = Σ 工具耗时） | 并行组执行阶段并行（批延迟 = max(工具耗时) + 审批链） |
| G7 | Rust 基准缺失 | `crates/**/benches/` 不存在，P1-P8 无量化数据 | 建立 Criterion 基准（P2/P3/P6 关键路径）+ 首 token 延迟集成测量 |

### 0.3 与 PE-02 的分工边界（重要）

- **PE-02（前端流式渲染接线）**：管前端消费端——StreamRenderBuffer 分帧、streamingStore 批合并、EventRouter 增量累加、流式期 markdown、终态 commit。前端**无需为本任务改动**（AA-06 F1 已验证 EventRouter.ts:199-216 已支持增量）。
- **本任务（PE-09 T09.1）**：管 Rust 侧流式**产出**——ProviderCall trait 契约、HttpProviderCall 增量解析、session-loop 增量 emit、增量事件桥通道。
- **接口契约点**（本任务产出、PE-02 消费）：
  1. `message-delta` 事件 JSON 形状**不变**（`AgentEvent::MessageDelta`，03 §5.1 清单）；
  2. 增量通道只承载 `message-delta`/`thought-delta`（非持久化类，EventClass::NonPersistent）；
  3. 增量信封 `sequence=None`（delta 不落库、无序列号；前端按 messageId 累加，不依赖 sequence）；
  4. 终态收口路径（run-terminal 等持久化事件批量 emit）**保持不变**。
- 若 PE-02 需前端改造（如审批批量弹窗，见 T09.6 选项 B），由 PE-02 另行出任务书，本任务只保证 Rust 侧契约稳定。

### 0.4 非目标（明确不做，防越界）

- P5 帧解析优化（serde 派生结构体替代 Value 全树）：独立模块，本任务仅在其产出流式帧后顺带受益；如需单独做，另出任务。
- P4 message-start 瘦身（改持久化事件 schema）：与 AA-07 数据持久化域冲突面大，本任务通过 Arc 化达到同等克隆收益，不改 wire 形状。
- P9/P10 事件桥序列化前置与丢帧分桶；P11 对话上限/CompressionHook → **登记不做**（需真实压缩实现 +
  滚动窗口，未来另立任务，AU-04 认领表 #16）；F2/F3/F4/F5、M1/M2：列为后续低优先域。
- 前端 StreamRenderBuffer 拼接优化（F2）、store 截断（F5）：前端域，不属本任务。

---

## 1. 事实基线（代码走查结论，含文件:行号）

### 1.1 P1 全量缓冲链（首 token 延迟根因）

1. `apps/agent-workbench/src-tauri/src/engine.rs:293-303`：`read_stream` 收完**全部** SSE 帧；
2. `engine.rs:305-324`：逐帧 `push_frame` 收集进 `Vec<ProviderStreamEvent>`，**流结束才返回**；
3. `crates/session-loop/src/loop/handlers/streaming.rs:46`：`provider.stream(&request).await` 一次拿整批；
4. `streaming.rs:53-63`：`consume(events, aborted)` 全量聚合；
5. `streaming.rs:234-245`：`emit_message_deltas` 按**整块**消息回放 delta（消息定型后）——前端收到的是全文单条 delta；
6. 增量能力已具备：`crates/session-loop/src/stream.rs` 的 `ProviderStreamEvent` 是流式形状；`transport/mod.rs:51-59` 的 `read_stream` 之上有 `SseParser`（逐帧 `push_frame`）；前端 EventRouter 已支持增量。

### 1.2 P2 克隆链

1. `crates/orchestrator/src/events.rs:276-277`：`drive_outcome` 循环 `queue.push(&run.session_id, event.clone())`——克隆 1；
2. `events.rs:56-58`：`event_type_name` 构造 `AgentEventEnvelope::new(event.clone(), None, None)` 只为取 type 名——克隆 2（MessageEnd 克隆**完整消息体**）；
3. `events.rs:136/165/190`：`serde_json::to_string(&event)` 全量序列化；
4. `apps/agent-workbench/src-tauri/src/core_run_commands.rs:359-366`：分发循环 `sequenced.event.clone()` 进信封——克隆 3；
5. `AgentEventEnvelope::type_name` 的 match 已在 `crates/conex-types/src/events.rs:399-426`，可抽成 `AgentEvent::type_name()` 复用。

### 1.3 P3 克隆链

1. `streaming.rs:154-160`：`build_request` → `messages: state.conversation.clone()`（每轮 O(n)）；
2. `engine.rs:242-247`：`RequestBuildContext { messages: request.messages.clone() }` 第二次拷贝（O(n)）；
3. `crates/agent-provider/src/request/build.rs:66-70`：`RequestBuildContext.messages: Vec<AgentMessage>`（owned，被迫克隆）；
4. `crates/session-loop/src/loop/mod.rs:430`：`converge` 收口 `messages: self.state.conversation.clone()`（O(n)）；
5. `crates/session-loop/src/loop/handlers/mod.rs:147-154`：`record_message`——MessageStart 克隆 + conversation push 克隆 + MessageEnd move，同一条消息正文被深拷贝 2 次。
6. 跨 run 事实：`AgentSessionLoop` 注释声称对话跨 run 持久（loop/mod.rs:162-164），但真实接线 `SessionLoopProducer::produce` **每次 run 重建 AgentSessionLoop**（engine.rs:445-452），跨 run 语义实际仅测试路径使用（run_loop.rs/divergence.rs 复用同 loop 多次 run）。

### 1.4 P6 写放大链

1. `crates/conex-db/src/lib.rs:490-541`：`save_session_body` 先 `DELETE` 全表再逐条 INSERT，事务内；
2. 触发器 `trg_session_messages_insert` 每行 UPDATE sessions（写放大叠加）；
3. 增量 API **已存在但未接线**：`conex-db/src/lib.rs:543-601` `append_session_messages`（按 MAX(seq)+1 续写）；
4. Tauri 侧只有 `load_session_body`/`save_session_body` 命令（`apps/agent-workbench/src-tauri/src/session_commands.rs:84-107`，main.rs:85-86 注册），**无 append_session_messages 命令**；
5. 前端每次消息 commit 全量 `saveSessionBody`（`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:511-532`），成功路径再镜像写 localStorage（:523-527）；
6. hydrate 时逐会话全量保存（sessionRustDb.ts:827）。

### 1.5 P7 分页链

1. `crates/orchestrator/src/persist.rs:101`：`Store::query_events(session_id, after_sequence)` 无 limit 参数；
2. `persist.rs:433-437`：`LocalDbStore::query_events` 调 conex-db `query_events(..., None)` → SQL `LIMIT i64::MAX`（conex-db lib.rs:310-346，SQL 已支持 `LIMIT ?3`）；
3. `apps/agent-workbench/src-tauri/src/core_query_commands.rs:262-267 / 301-306`：`read_run_events_impl` / `read_session_events_impl` 全量读入 → `assign_run_ids` + `reconstruct_envelopes`（逐条 JSON 重建）→ 内存分页（:281-289 / :316-317）；
4. 游标分页接口已正确：`core_query_commands.rs:91-110` `paginate_envelopes`（nextAfterSequence + 限页）；
5. 重放全量路径：`crates/orchestrator/src/restore.rs:597,645` 依赖无 limit 语义（需传 None 保持）。

### 1.6 P8 审批退化链

1. `crates/session-loop/src/tool_exec.rs:122-133`：`approval_enabled` 时并行组 for 循环串行（注释自述：ApprovalGate 是 `&dyn` 无法跨 `async move` 共享）；
2. `tool_exec.rs:147-161`：并行分支每个 future 克隆 `call`/`ctx`/`options` 三结构；
3. `tool_exec.rs:263-307`：审批路径 `gate.request_approval(...).await` 在 execute_one 内（事件先发防死锁，契约正确）；
4. 注入链已 Arc 化：`AgentSessionLoop.approval: Option<Arc<dyn ApprovalGate>>`（loop/mod.rs:177）→ `dispatch_once` 里 `self.approval.as_deref()`（:333）→ handler `Option<&dyn ApprovalGate>`（executing_tools.rs:42）→ `execute_batch`（tool_exec.rs:80）——**仅在 execute_batch 边界退化**；
5. 生产路径未接线审批（engine.rs:445-458 未调 `with_approval`），P8 改造不影响可用性，只影响注入后的行为。

### 1.7 已验证良好项（本任务不得破坏，含回归测试锚点）

- delta 不落库不阻塞 drive loop（events.rs:42-48 分流 + 测试 `delta_does_not_block_drive_loop`）；
- 事件背压丢帧策略（`apps/agent-workbench/src-tauri/src/buffer.rs:41-58`：Delta→Soft 优先丢、Critical 永不丢）；
- 无审批并行执行正确（tool_exec.rs:134-184 + 测试断言 <95ms）；
- 事件分页游标接口（core_query_commands.rs:91-110）；
- 工具批事件顺序契约（tool-exec 批内事件序列，executing_tools.rs:186-277 翻译层）；
- 消息列表/前端流式渲染管线（前端域，不动）。

---

## 2. 任务分解

任务编号 T09.1–T09.10，**编号按域列出，执行顺序见 §4**（T09.8/T09.9 为 AU-04 认领新增）。

### T09.1【P1 高】真增量流：ProviderCall 流式契约 + 边收边发

> 接口契约冻结 v1，见 **AU-04 F1**：契约正文 SoT = **PE-02 §3.1（修订后）**，本任务为实现侧对齐；
> 别名取定：条目别名 = **`ProviderStreamItem`**（PE-02 名，弃用本任务 v1 的 `StreamItem`）；流别名 =
> **`ProviderEventStream`**（本任务名，PE-02 契约正文补入）；两名字各只保留一个。
> 实施形态允许换 tokio mpsc，但须保持事件形状/顺序/终止/取消语义并经锚点测试回归。

#### T09.1.1 接口契约（本任务的稳定契约点，先定死再动手）

`crates/session-loop/src/provider.rs`（第 19-20、55-67 行改造）：

```rust
use futures_util::Stream;
use std::pin::Pin;

/// 流中条目：事件 or 已分类错误（冻结 v1：别名 = ProviderStreamItem，AU-04 F1）
pub type ProviderStreamItem = Result<ProviderStreamEvent, ClassifiedStreamError>;
/// 增量事件流（'static：不得借用 request；实现方须在返回前把请求体
/// 序列化完成——同步构建 body，流只承载响应解析结果）
pub type ProviderEventStream = Pin<Box<dyn Stream<Item = ProviderStreamItem> + Send>>;

#[async_trait]
pub trait ProviderCall: Send + Sync {
    /// 发起一次 provider 调用，返回增量事件流。
    ///
    /// 语义契约（实现方与消费方共同遵守）：
    /// 1. Err(classified) = 传输层/HTTP/解析头帧错误，**尚未产出任何事件**，
    ///    进入主循环现有分类重试阶梯（01 §2.5）；
    /// 2. Ok(stream) 中 Item::Err(classified) = 流中途错误；消费方规则：
    ///    - 已产出内容（text/thought/tool-call 任一）→ 内容保留收场
    ///      （Message + providerError 标注，**不重试**，01 D6 裁决）；
    ///    - 未产出内容 → 完整错误分类 → 现有重试阶梯；
    /// 3. 每流恰好一个 Stop item，Stop 之后流立即结束（02 §六.9 保持）；
    /// 4. 流中 abort 协作检查（L3/AbortSignal）由实现方与消费方按现有
    ///    safe_point 语义各自检查（streaming.rs:50 的读取点保留）。
    async fn stream(
        &self,
        request: &ProviderRequest<'_>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError>;
}
```

`ProviderRequest` 同期改借用（见 T09.3 契约，两者必须同 PR 落地避免两轮类型震荡）：

```rust
pub struct ProviderRequest<'a> {
    pub messages: &'a [AgentMessage],   // 原 Vec<AgentMessage>（provider.rs:26）
    pub tools: Vec<ToolSchema>,
    pub max_tokens: Option<u32>,
}
```

#### T09.1.2 实施步骤

**步骤 1——agent-provider 传输层帧级流**（`crates/agent-provider/src/transport/mod.rs`）：
- 新增 `stream_frames(response, options, abort) -> Pin<Box<dyn Stream<Item = Result<SseFrame, SseReadError<reqwest::Error>>> + Send>>`：内部把 `ReqwestChunkReader`（:18-45 已有）+ `SseParser`（:57）按帧产出，双段超时/诊断逻辑（`sse::reader::read_sse` 的语义）逐帧透出；
- `read_stream`（:51-59）改为 `stream_frames` 的收集包装（`collect().await`），保持签名与全部既有测试兼容——其它调用方零改动；
- 需要 `async-stream` 或 `futures_util::stream::unfold` 实现（检查 workspace 是否已有 async-stream；没有则用 unfold，避免新增依赖）。
- **串行声明（AU-04 PE-09 修订指令 6）**：transport/mod.rs 与 **PE-10 串行（PE-10 先行**：reqwest 0.12→0.13 升级（T10.2）后 `stream_frames` 无 API 差异；若需 async-stream 依赖，声明增量统一由 PE-10 管理）。

**步骤 2——HttpProviderCall 增量实现**（`engine.rs:221-325`）：
- `stream` 返回 Ok(流)：流内每帧 → `parser.push_frame(frame)` → `produced.into_iter().map(to_loop_event)` yield；
- EOF → `parser.finish()` → yield 剩余事件 + `output.diagnostics` 诊断事件（对应现 :313-323 行为）；
- 解析错误（push_frame/finish Err）→ yield `Err(classify_stream_parse(...))`（保持 :339-346 的 Unknown/不可重试分类）；
- 传输层错误（请求失败、非 2xx、首帧超时）→ 返回 `Err(to_classified(...))`（:258-281 现有逻辑不变）；
- `reqwest::Client` 连接池、endpoint、`build_chat_completions_request_body` 同步构建均不变（请求体在返回流之前序列化完毕，满足契约 1 的 'static 要求）。

**步骤 3——session-loop 增量消费**（`streaming.rs:35-117` + `stream.rs`）：
- `stream.rs` 新增 `ConsumeBuilder`（复用现有 `Aggregate`，:192-233）：`push(event)` 增量聚合 + `finish(aborted) -> ConsumeResult`（复用 :252-348 的 `finish` 家族）；`consume()`（:240-249）保留为 `ConsumeBuilder` 的薄包装（测试兼容）；
- `streaming.rs::handle` 重写为逐 item 循环：
  1. 调用 provider 前预生成 `message_id = new_message_id("assistant")`（与最终 record_message 的消息 id 一致，保证 message-start/delta/end 的 message_id 对齐）；
  2. `while let Some(item) = stream.next().await`：
     - `Ok(TextDelta/ThoughtDelta)` → `builder.push` + 实时 `emit_delta(state, message_id, block)`（双轨，见步骤 4）；
     - `Ok(ToolCall/ProviderDiagnostic/Stop)` → `builder.push`（Stop 后 break）；
     - `Err(classified)` → 已产出内容 → 标记 `builder` 错误并继续收流（或直接收场，实现时取其一，语义等价）；未产出内容 → `stream_error::handle`（保持重试阶梯）；
     - 每 item 后 abort 检查（`state.abort_signal.is_aborted()` → 停收，`builder.finish(true)` 走 partial salvage，:84-88 语义保持）；
  3. 流结束 → `builder.finish(aborted)` → 现有 5-7 步（分类、record_message、安全点、分派）**保持不动**；
  4. 删除 `emit_message_deltas`（:234-245）——delta 产出改实时通道。
- 注意：`ToolCall` 可能出现在文本之后（consume 语义：tool_calls 与 text 共存，stream.rs:429-444 测试锚定），增量通道只发 delta 类，ToolCall 仍走收口批量 emit——顺序无冲突。

**步骤 4——实时 delta 双轨（核心设计，防顺序/持久化契约破坏）**：
- 新增增量通道抽象（`provider.rs` 或 `loop/mod.rs`）：

```rust
/// 流式增量转发（delta 实时到前端；非持久化，无 sequence）
pub trait DeltaSink: Send + Sync {
    fn push(&self, delta: AgentEvent);
}
```

- `AgentSessionLoop::with_delta_sink(Box<dyn DeltaSink>)`（新增构建方法，仿 with_approval :238-241）；
- streaming handler 内 delta 双轨：
  - **实时轨**：TextDelta/ThoughtDelta 到达即 `sink.push(AgentEvent::MessageDelta { session_id, timestamp, message_id, block })` → 前端增量渲染；
  - **收口轨**：`state.events` 仍按既有顺序（message-start → delta* → message-end，01 §五.6）在消息定型后构建（供持久化与重放，形状不变）。
  - 代价：delta 构造两次（轻量）；收益：实时轨不触碰序列/持久化契约。
- 增量事件桥（tauri 侧）：
  - 新增 `BridgeDeltaSink`（core_run_commands.rs 或 engine.rs）：`push` 内同步构造 `AgentEventEnvelope { event, run_id: Some, sequence: None }` → `state.bridge.emit(&envelope)`；
  - 背压/丢帧复用现有 `buffer.rs:41-58`（MessageDelta 属 Delta 类，可丢；Soft 水位优先丢，Critical 永不丢）——实时通道天然安全；
  - flush 路径：`core_event_bridge.rs:198` 现有逐帧序列化（P9 范围，不动）；
  - `core_run_task`（core_run_commands.rs:667-716）装配：构造 BridgeDeltaSink 注入 `SessionLoopProducer` → `AgentSessionLoop::with_delta_sink`（engine.rs:445-452 附近）；
  - run 结束：sink 为无状态结构体，无清理需求。

**步骤 5——TestProvider 适配**（`crates/session-loop/src/testing/mod.rs`）：现有脚本化事件序列改经 `futures_util::stream::iter` 包装成 `ProviderEventStream`（可复用脚本化测试全部用例，行为不变）。

#### T09.1.3 验收

1. 既有测试全绿：`cargo test -p session-loop -p orchestrator -p agent-provider`；`cargo test -p agent-workbench`（tauri 集成）；
2. 新增测试：
   - 中途 `Err` item 且有内容 → Message 收场（providerError 标注，不重试）；无内容 → 错误分类路径（stream_error 阶梯）；
   - 增量双轨：实时 sink 收到的 delta 序列与消息 block 顺序一致；收口流 message-start/delta/end 顺序与 01 §五.6 契约一致；
   - **锚点测试显式引用（F1）**：`crates/session-loop/tests/streaming_incremental_contract.rs`（PE-02 落壳、本任务填实现）——增量形状/顺序/终止/取消语义回归；
   - 事件序列连续性/终态唯一/delta 不阻塞（events.rs 既有 3 个测试）全绿；
   - tauri 集成：本地 TCP mock SSE（复用 transport tests 的 `serve_sse` 模式，transport/mod.rs:73-100）慢速分块（首 token 500ms，总时长 5s）→ 断言 BridgeDeltaSink 首条 delta 到达时间 **< 600ms（F1 硬断言，改造前 ≈ 5s）**；300ms 项仅作 T09.7 内部基准记录，不作验收；
3. 行为回归：abort 中途内容保留（partial salvage）、length 阶梯重试、NoProgressContinue 路径不受影响（run_loop/divergence 全套）；
4. 前端零改动验收：EventRouter 收到 sequence=None 的 message-delta 正常累加（联调点，可后置）；端到端 `requestToFirstChunkMs < 500ms` 归 PE-02 T02.6 总验收（F1）。

### T09.2【P2 高】事件克隆风暴消除

#### T09.2.1 实施步骤

**步骤 1——`AgentEvent::type_name()`**（`crates/conex-types/src/events.rs`）：
- 新增 `impl AgentEvent { pub fn type_name(&self) -> &'static str }`，match 内容照搬 `AgentEventEnvelope::type_name`（:399-426 全部 25 个分支）；
- `AgentEventEnvelope::type_name`（:398-426）改为 `self.event.type_name()` 委托；
- 回归锚点：conex-types 既有测试 + 序列化 roundtrip（`crates/conex-types/tests/events_roundtrip.rs`）逐字节比对 wire 形状。

**步骤 2——`event_type_name` 删信封**（`crates/orchestrator/src/events.rs:55-58`）：

```rust
pub fn event_type_name(event: &AgentEvent) -> &'static str {
    event.type_name()
}
```

（删除 `AgentEventEnvelope::new(event.clone(), None, None)` 构造——克隆 2 消除。）

**步骤 3——push 系列改所有权移动 + 序列化借用**（`events.rs:120-204`）：
- `push(&mut self, session_id: &str, event: AgentEvent)`（by value）；序列化改 `serde_json::to_string(&event)`（:136 已有借用，配合 by value 后 0 克隆）；
- `push_terminal_best_effort` / `push_at_best_effort` 同样 by value；
- `SequencedEvent`（:61-69）保持 owned event 不变（envelope/emit 需要）；
- 既有调用点核对：`core_run_commands.rs:644`（`queue.push(&session_id, event)` owned，兼容）。

**步骤 4——`drive_outcome` 零克隆**（`events.rs:263-377`）：
- 签名改 `drive_outcome(run, queue, outcome: RunOutcome)`（by value 消费事件流）；
- `for event in &outcome.events` 改 `for event in outcome.events`（move，0 克隆）；
- 收尾字段（reason/error/diagnostic/messages）改 by value 使用（`outcome.reason` Copy、`error` 移动）；
- `drive_outcome` 的调用点：`core_run_commands.rs:350`（`&outcome` → `outcome`；outcome 在步骤 3 后不再使用，可安全 move——核对 :338-357 控制流）；orchestrator tests（`events.rs` 测试多处 `drive_outcome(&mut run, &mut queue, &outcome(...))` → 传值，构造处已是临时值，改动机械）。

**步骤 5——分发循环去第三次克隆**（`core_run_commands.rs:358-370`）：
- `for sequenced in &drive.events` 改 `for sequenced in drive.events`（by value）；
- `AgentEventEnvelope::new(sequenced.event, ...)` 直接 move（:360-364 去 `.clone()`）；
- 步骤 5 取 last 提前：`let last_sequence = drive.events.last().map(|e| e.sequence);`（在 move 前取，适配 :368-370）。

#### T09.2.2 验收

1. 持久化事件路径深克隆次数 2 → 0（可用 T09.7 基准量化；代码审查断言：drive_outcome 与 push 内无 `.clone()`）；
2. 事件类型名逐项不变（25 个 type 值，roundtrip 测试锚定）；
3. 事件序列连续性、终态唯一、delta 不阻塞、持久化失败收口（events.rs 既有 8 个测试）全绿；
4. `cargo clippy -p orchestrator -p conex-types` 无新告警。

### T09.3【P3 高】对话克隆消除（两阶段）

#### T09.3.1 阶段 1——请求构建链全链借用（必做，P3 主体 O(n²) 来源）

**实施步骤**：
1. `crates/session-loop/src/provider.rs:24-31`：`ProviderRequest<'a> { messages: &'a [AgentMessage], ... }`；
2. `streaming.rs:154-160`：`build_request` → `messages: &state.conversation`（0 拷贝）；
3. `crates/agent-provider/src/request/build.rs:66-70`：`RequestBuildContext<'a> { messages: &'a [AgentMessage], ... }`；:146 处（wire 消息转换）适配 `&**msg` 或 `msg.as_ref()`；
4. `engine.rs:242-247`：`messages: request.messages`（直接传借用，删除 :244 的 `.clone()`）；
5. `TestProvider`（session-loop/testing/mod.rs）与所有构造 `ProviderRequest` 的测试适配借用；
6. 若 T09.3.2 落地，本阶段类型同步为 `&'a [Arc<AgentMessage>]`（两者只允许一种最终形态，见 T09.3.2 波及清单）。

#### T09.3.2 阶段 2——`record_message` 零深克隆（建议做，含完整波及清单）

**方案（Arc 化，wire 形状不变）**：
1. `crates/conex-types/src/events.rs:151-166`：`MessageStart.message` / `MessageEnd.message` 字段类型 `AgentMessage` → `Arc<AgentMessage>`（serde 对 `Arc<T>` 按 `T` 序列化，持久化 JSON **逐字节不变**）；
2. `crates/session-loop/src/loop/handlers/mod.rs:147-154`：

```rust
pub(crate) fn record_message(state: &mut LoopState, message: AgentMessage) {
    let session_id = state.machine.context().session_id.clone();
    let message = Arc::new(message);
    state.conversation.push(message.clone());          // Arc 克隆（0 深拷贝）
    state.events.push(AgentEvent::MessageStart { session_id: session_id.clone(), message: message.clone() });
    state.events.push(AgentEvent::MessageEnd { session_id, message });
}
```

3. `LoopState.conversation: Vec<AgentMessage>` → `Vec<Arc<AgentMessage>>`（handlers/mod.rs:66）；
4. 波及点适配（grep 已定位，逐项列）：
   - `handlers/mod.rs:159` `steering_context` 与 `crates/session-loop/src/steering/strategy.rs:71,140,175`、`steering/mod.rs:221`：`&[AgentMessage]` → `&[Arc<AgentMessage>]`（读字段自动 deref，改动签名与类型标注即可）；
   - `loop/mod.rs:254` `AgentSessionLoop::conversation()` 返回 `&[AgentMessage]` → 适配（返回 `Vec<&AgentMessage>` 或改 `&[Arc<AgentMessage>]`，二选一，推荐后者）；
   - `crates/orchestrator/src/normalize.rs:27-29,314-324`（MessageStart/End 重建处，构造参数改 Arc::new）；
   - `crates/orchestrator/tests/common/mod.rs:114`、`orchestrator/src/events.rs:472-487`（测试构造）；
   - `crates/conex-types/tests/events_roundtrip.rs:231-241,440`（构造 + 断言——Arc 序列化形状不变，需验证断言不因内部类型变化失效）；
   - `apps/agent-workbench/src-tauri/tests/event_bridge.rs:57`（构造）；
   - `core_run_commands.rs:1351-1421`（match 绑定 `message` 为 `&Arc<AgentMessage>`，`.id`/`.blocks` 自动 deref——编译验证即可）；
   - `buffer.rs:47`（`..` 模式匹配，无碍）。
5. 回退方案（若波及超预期）：仅保留阶段 1；`record_message` 保持 2 次克隆并标注「与 P4 message-start 瘦身联动」，作为遗留问题登记。

#### T09.3.3 `converge` 收口零拷贝

- 现状：`loop/mod.rs:430` `messages: self.state.conversation.clone()`（每 run 收口 O(n)）。
- 方案：`messages: std::mem::take(&mut self.state.conversation)`（零拷贝 move）；
- **行为变化面（必须显式登记）**：converge 后 conversation 清空。真实接线无影响（SessionLoopProducer 每 run 重建 loop，engine.rs:445-452）；测试路径（run_loop.rs / divergence.rs 复用同一 AgentSessionLoop 多次 `run()` 的用例）需改造：新增 `AgentSessionLoop::with_initial_conversation(Vec<AgentMessage>)`（构建方法，服务测试续接与未来会话恢复），用例改为「上一轮 `outcome.messages` 作为下一轮初始对话」或重建 loop；
- 若评估跨 run 语义风险不可接受：降级为 `Arc::new(std::mem::take(...))` + `RunOutcome.messages: Arc<Vec<AgentMessage>>`（测试适配 `&*outcome.messages` 等 deref 处约 15 处，见 §1.3 grep 结果），三方案择一，推荐 mem::take。

#### T09.3.4 验收

1. 阶段 1 完成即验收 G3 主体：`cargo test -p session-loop -p agent-provider -p agent-workbench` 全绿；
2. T09.7 基准：5000 消息下 build_request+stream 调用开销不再随对话规模线性增长；
3. 阶段 2 完成后：`record_message` 路径深克隆 0（代码审查断言）；conex-types roundtrip 全绿（wire 形状不变）；
4. steering 行为回归（divergence.rs 全部用例）。

### T09.4【P6 中】DB 写放大消除（跨端，含前端 commit 路径）

#### T09.4.1 Rust 侧

> 写模型冻结 v1，见 **AU-04 F7**：`save_session_body` 全量替换语义**保留**（PE-08 T08.10 定稿）；
> 本任务 v1 的「save_session_body 改 ON CONFLICT upsert」条目**已删除**（行为变化面 R6 撤销）。

1. **新增 Tauri 命令**（`apps/agent-workbench/src-tauri/src/session_commands.rs`）：
   `append_session_messages(session_id: String, messages: Vec<SessionMessage>) -> Result<(), CoreError>`，
   **唯一负责 = 本任务 T09.4.1 第 1 条（冻结 v1，AU-04 F7；session 族第 13 个命令）**；
   `spawn_blocking` 包 `db.append_session_messages`（conex-db lib.rs:543-601 已实现，增量续写 + 单事务，
   **底层增量 API 由 PE-08 提供并登记 manifest/契约**）；main.rs:85-86 处注册；串行：sessionRustDb.ts
   写模型由 PE-08 T08.10 定稿先行，本任务 T09.4.2 增量接线在后（AU-04 附录串行表）。
2. **（v2 删除）~~`save_session_body` 改 upsert~~**：DELETE 全部改为 INSERT ... ON CONFLICT 的方案
   **作废**（F7/C14 裁决：全量替换保留，产品语义 = 可删除/编辑历史消息；写放大消除完全走 append
   增量路径）；hydrate / 首次落地 / 显式修复路径继续用全量 `save_session_body`（语义不变）。
3. **事件落库批处理（可选子项）**：`LocalDbStore`/`Store` 增加 `append_events(&[(u64, &str, &str)])` 单事务批量（审计建议 2）；**约束**：`EventQueue::push` 的逐条同步等待语义（approval 中间态可观测，events.rs 测试锚定）不得改变——批接口只供重放/hydrate/恢复路径使用；
4. 数据一致性回归与 AA-07 数据持久化域协同（append 增量与全量混合、崩溃恢复后 seq 连续性；Q23/Q24 并发序列由 PE-08 T08.8/T08.12 承接）。

#### T09.4.2 前端（session-persistence 域）

1. `sessionRustDb.ts` 新增 `appendSessionMessages(sessionId, newMessages: SessionMessage[])`：调 append_session_messages + LS 镜像（仅活跃会话，节流 500ms）；
2. **消息 commit 路径改增量**：定位 commit 调用点（当前经 saveSessionBody 全量，:511-532）→ 改为只传本轮新增消息调 appendSessionMessages；**id 幂等**：append 前按消息 id 去重（防止重放/并发重复 commit 造成重复行——append 无 ON CONFLICT，需前端幂等或改 append 为按 id 去重）；
3. hydrate 路径（:827 `persistAllSessionsRust`）保留全量 `saveSessionBody`（首次落地；写模型全量替换语义按 F7/PE-08 T08.10，先经 upsert 索引 T08.1 保证会话行存在）；
4. LS 镜像节流（:523-527）：仅活跃会话 / 500ms 节流，不活跃会话跳过（离线回退数据滞后为已知接受项，登记）。

#### T09.4.3 验收

1. `cargo test -p conex-db -p orchestrator` 全绿（append 增量语义新测试：增量续写 seq 连续、与全量 save_session_body 混合后完整性——**不设 upsert 语义测试**，R6 已撤销，F7）；
2. T09.7 基准：1000 消息会话 commit 写放大从 O(n) 降到 O(k)（k=新增消息数）；
3. 前端联调：发 3 条消息 → 重启 → body 完整无重复（AA-07 协同回归）；
4. 回归锚点：`save_session_body` 全量替换语义既有测试（删除/编辑历史消息后全量保存清除旧行）**保持**（F7）。

### T09.5【P7 中】SQL 分页下推

> 签名冻结 v1，见 **AU-04 PE-09 修订指令 3**：`Store::query_events` 加 `limit` 参数（restore 传 `None`
> 保持全量语义）不变。与 PE-08 T08.x 串行（core_query_commands.rs 与 sessionRustDb.ts 同文件区，
> 按 AU-04 附录串行表；PE-08 先行）。

#### T09.5.1 实施步骤

1. **`Store::query_events` 加 limit**（`crates/orchestrator/src/persist.rs:101`）：`async fn query_events(&self, session_id: &str, after_sequence: u64, limit: Option<u64>) -> StoreResult<Vec<PersistedEvent>>`；
2. `InMemoryStore`（persist.rs:310-323）：limit 语义在内存过滤后 take（测试替身对齐）；
3. `LocalDbStore`（persist.rs:433-437）：`limit` 原样传给 `conex-db query_events(..., limit.map(|l| l as i64))`（SQL 已支持 `LIMIT ?3`，conex-db lib.rs:310-346）；
4. `restore.rs:597,645`：传 `None`（重放需全量，语义保持）；
5. `core_query_commands.rs:262-267 / 301-306`：传 `Some(limit as u64 + 1)`（limit 已在 :243/:300 `clamp(1, MAX_PAGE_SIZE)`，多取 1 条供 has_more 判定；实现时核对 `paginate_envelopes`（:91-110）的 has_more 计算口径，保证翻页语义与现状一致）；
6. **段归属正确性（关键风险点）**：分页截断后 `assign_run_ids` 只在已取行内运行——截断页的尾段（无 run-terminal 锚点）按现有兜底逻辑归属（:270-280 active run / 目标 run 未终态时尾段归属）；翻页间一致性由「锚点事件与截断点位置」决定，实现时新增测试覆盖「run 边界恰在分页切点」场景；第二阶（可选）：run-terminal 锚点先行查询（`WHERE event_type='run-terminal'`）缩小段归属扫描范围（AA-06 建议），独立小任务；
7. **前端 hydrate 分页**（session-persistence 域，若在本任务边界内）：会话事件重放路径改 nextAfterSequence 游标循环（core_read_session_events 已支持分页参数），首页只取一页（如需长会话全文恢复，循环取完并拼接）。

#### T09.5.2 验收

1. `cargo test -p orchestrator -p agent-workbench` 全绿（分页纯函数测试 core_query_commands.rs:91-110 保持）；
2. 新增测试：limit=100 时 SQL 只取 101 行（内存 store 断言行数）；run 边界在切点的归属一致性（翻两页归属注入结果相同）；
3. T09.7 基准：3000 事件会话首页查询耗时从 O(n) 到 O(limit)；
4. 重放/恢复路径（restore.rs）行为不变。

### T09.6【P8 中】审批模式并行恢复

> 形态冻结 v1，见 **AU-04 F9**：跨 async 边界一律 `Option<Arc<dyn ApprovalGate>>`；执行模型**取定 A**
> （审批逐个 await → 通过后执行阶段 join_all 并行）。PE-06（T06.1 改 mark_rest_cancelled 签名时）
> 不得动 approval 参数形态；选项 B（审批并发请求）需前端批量审批支持，由 PE-02 另行任务书。
> 串行：tool_exec.rs 由 PE-06 T06.1 先行（AU-04 附录串行表）。

#### T09.6.1 实施步骤

1. **`execute_batch` 签名**（`crates/session-loop/src/tool_exec.rs:76-83`）：`approval: Option<&dyn ApprovalGate>` → `approval: Option<Arc<dyn ApprovalGate>>`；
2. 调用点适配：`executing_tools.rs:79-81`（收到的是 `Option<&dyn ApprovalGate>`）→ handler 签名同步改 `Option<Arc<dyn ApprovalGate>>`（loop/mod.rs:333-340 `self.approval.as_deref()` 改为 `self.approval.clone()`——Arc 克隆便宜）；`execute_one`（:220-230）内部保持 `&dyn` 消费（`approval.as_deref()`）；
3. **并行组审批改造**（:122-133 删除串行退化分支，与 :134-184 并行分支合并）：
   - 事件顺序保持契约：先同步产出全部 `ToolStart` + `ApprovalRequested`（:136-146 先发 start 的模式扩展为 start+approval 全组先发，approval-requested 先于等待是防死锁硬契约，tool_events.rs 头注）；
   - 执行模型（默认选 A）：**审批逐个 await（UX 与事件顺序不变）→ 通过后执行阶段 join_all 并行**；
   - 选项 B（可选，需前端批量审批支持，由 PE-02 另行任务）：审批也 join_all 并发请求；
   - future 捕获：`ctx`/`options` 各 Arc 共享 1 次（或保持 clone——两结构小）；`call` 每工具 1 次克隆保持（execute_single 需要 owned `input: Value`，:358-365；可选优化：`call.input` 改 `Arc<Value>`，标记为低优先子项）；
4. **每工具克隆**（:147-161 现有并行分支）：`calls[idx].clone()` 三结构克隆保持现状（本任务不扩大范围），审批路径复用同一并行执行函数体，避免双份实现漂移。

#### T09.6.2 验收

1. 新增测试：`approval_enabled=true` + 并行组 5×50ms 慢工具 → 批耗时 < 2×单工具（现串行 ≈ 5×50ms）；审批拒绝/超时/取消/expired 语义与事件顺序（tool-start → approval-requested → tool-end）回归；
2. 无审批并行测试（<95ms 断言，tool_exec.rs:641-656）保持全绿；
3. `cargo test -p session-loop` 全绿 + clippy。

### T09.7【基准基建】Rust 侧 Criterion 基准 + 首 token 延迟测量

#### T09.7.1 基准目录与场景

工作区根 Cargo.toml 增加 `criterion = "0.5"` dev-dependency（**依赖增量统一由 PE-10 管理，本任务只提需求**，AU-04 PE-10 修订指令 2），`crates/**/benches/`：

| 基准 | 位置 | 场景 | 指标 |
|---|---|---|---|
| event_chain | `crates/orchestrator/benches/event_chain.rs` | P2：drive_outcome 100 事件（agent-start + 20 工具批 + 大 MessageEnd 1KB/10KB 文本） | 每事件耗时、总耗时、内存峰值 |
| request_build | `crates/session-loop/benches/request_build.rs` | P3：build_request + ProviderRequest 构造 + consume 聚合，100/1000/5000 消息 | 每轮耗时（验证 O(1)） |
| db_write | `crates/conex-db/benches/db_write.rs` | P6：save_session_body 全量（100/1000/5000）vs append_session_messages 增量（每批 +1/+10） | 写放大比、每批耗时 |
| tool_batch | `crates/session-loop/benches/tool_batch.rs` | P8：并行组 5×50ms，无审批 vs 审批（A/B 两模型） | 批总耗时 |
| consume_delta | `crates/session-loop/benches/consume_delta.rs` | 每 token 处理耗时：1000 条 TextDelta 的 consume + emit 路径 | ns/token |

#### T09.7.2 首 token 延迟测量方法（集成测试 + 观测）

- 位置：`apps/agent-workbench/src-tauri/tests/`（本地 TCP mock SSE 服务模式照搬 `crates/agent-provider/src/transport/mod.rs:73-100` 的 `serve_sse`：分块慢速发送，首 token 延迟 500ms、总时长 5s）；
- 断言式集成测试：`HttpProviderCall::stream` 返回后，首条 `TextDelta` item 到达时间 **< 600ms（F1 硬断言，改造前 = 整流读完 ≈ 5s）**；
- **内部基准（F1，不作验收门）**：流产出后到达事件桥 ≤ 300ms 仅作 T09.7 内部基准记录（回归看板项，不进验收清单）；
- 观测式：`cargo test --test ttfb -- --nocapture` 打印各阶段耗时（首字节 / 首帧 / 首事件 / bridge emit），作为回归看板项；
- 端到端（人工冒烟 + PE-02 T02.6 总验收）：live model 长回复，观察 UI 首字符出现时间与流式增量渲染（`requestToFirstChunkMs < 500ms` 归 PE-02）。

#### T09.7.3 输出

- 优化前基线报告（本次任务开始前记录）；每 T 完成后复测对照表；
- **基线存档合并为单一文档 `docs/rust-rewrite/audits/PE-perf-baseline.md`（本任务 T09.7 维护，PE-02 写入基线数据与前端埋点数据；v2，AU-04 认领表 #4）**；
- 最终报告附 `docs/rust-rewrite/plans/PE-09-performance-plan.md` 同目录（或单独 `PE-09-benchmarks.md`）。

### T09.8 首 token 总验收 owner 确认（v2 新增，AU-04 认领表 #4）

> 首 token 总验收 owner 互等（PE-02 ↔ PE-09）裁决：**本任务为唯一 owner**。

1. **owner 分工**：PE-02 T02.6 只提供基线数据与前端埋点（`requestToFirstChunkMs` 测量点）；
   **验收权在 PE-09**——首 token 阈值（600ms 集成硬断言 + 500ms 端到端）的放行/驳回由本任务行使。
2. **基线文档单一化**：所有首 token 基线数据写入 `docs/rust-rewrite/audits/PE-perf-baseline.md`
   （PE-02 写入基线 + 埋点数据，本任务 T09.7 维护），不再散落两份。
3. **验收**：G1 目标按 F1 三测量点口径（600/500/300，无第四套数字）；端到端 500ms 验收与 PE-02 T02.6
   联调时由本任务确认放行。

### T09.9【abort 时序三修复】Q21/Q33/Q40（v2 新增，AU-04 认领表 #1）

> 与 T09.1 同文件区（streaming.rs / stream_error.rs / tool_exec.rs），**T09.1 之后执行**（流式重构先行、
> 短路点稳定后落点）。PE-06 §7「移交 PE-05 运行行为域」表述**作废**（AU-04 认领表 #1）。

**现状（AA-01 原文证据）**
- Q21（tool_exec.rs:386-395，重要）：abort 信号只在工具执行完成后检查——L3 取消对运行中的长工具最长
  需等 `options.timeout`（默认 60s）才生效；超时 drop future 时 MCP 远端仍在执行（费用/副作用）。
- Q33（streaming.rs:50,84，建议）：`aborted` 标志在 consume 前一次性捕获：流中途触发 abort 时已
  commit 消息不带 stopReason=aborted 标注（消息正常落盘后才由 check_control 收场），partial salvage
  标注不一致。
- Q40（stream_error.rs:45-54，建议）：瞬态重试期间不检查 abort_signal——若重试间隙用户取消，仍会
  继续重试直至阶梯用尽（延迟 3 次请求）。

**方案（三修复一体合入）**
1. **Q21——abort-aware 竞速**：`execute_one`/工具执行体包「`options.timeout` future 与 abort 监听
   future 竞速」：abort 触发即取消等待并走现有收场路径（execute_impl 的取消语义），不再等 timeout 全长；
   超时 drop 时对 MCP 远端尽力发取消（transport 层 abort 语义，T09.1 步骤 1 的 abort 参数联动）。
2. **Q33——consume 后重读 abort**：`streaming.rs::handle` 收流结束后（`builder.finish` 前）**重读
   `abort_signal.is_aborted()`** 再决定 stopReason 标注（aborted vs 正常终态），保证 partial salvage
   标注与前端语义一致；与 T09.1 步骤 3 的逐 item abort 检查并存（前者管收流，后者管标注）。
3. **Q40——重试决策前查 abort**：`stream_error.rs` 瞬态错误重试阶梯每级决策前检查
   `abort_signal.is_aborted()`，已取消则跳过剩余阶梯直接收场（不发起无效请求）。

**产出**：tool_exec.rs / streaming.rs / stream_error.rs 三处改造 + 单测。

**验收**
- Q21：模拟 60s 长工具 + 中途 abort → 取消在 ≤ 数百 ms 内生效（不等 timeout）；远端取消尽力触发；
- Q33：流中途 abort → 已 commit 消息带 stopReason=aborted（partial salvage 标注一致）；
- Q40：重试阶梯第一级后 abort → 剩余阶梯不再发起请求（mock 计数断言）；
- T09.1 验收项（中途错误收场、delta 双轨顺序）不回归；run_loop/divergence 全套回归。

### T09.10 复测与回归收口（原 T09.8，v2 顺延编号）

1. 全量 `cargo test`（workspace）+ `cargo clippy --workspace` 零新告警；
2. T09.7 全部基准复测，对照目标 G1-G7 逐项核对（含 T09.7 内部 300ms 基准记录）；
3. 行为回归清单（§5 验证清单）逐项执行；
4. 冒烟：live model 全旅程（长回复流式渲染 → 工具调用 → 审批（若已接线）→ 收口 → 重启会话恢复，与 AA-07 协同）。

---

## 3. 风险与接口契约冲突

### 3.1 行为变化面（需显式登记/产品确认）

| # | 变化 | 来源 | 影响与缓解 |
|---|---|---|---|
| R1 | 事件到达时序：delta 由「批 emit」变「实时 emit」；信封 `sequence=None` | T09.1 | 前端 EventRouter 按 messageId 累加不依赖 sequence（AA-06 F1 已验证）；buffer 丢帧类目 Delta 不变；需在联调确认「实时通道先行 + 收口流再 emit」不产生 UI 双写（前端按 messageId 幂等） |
| R2 | 重试语义：有已产出内容的中途错误不再重试（内容保留收场） | T09.1 | 现状：全量缓冲下中途错误可整体重试无残留；改后：已显示内容保留。语义与 01 D6「有文字即 Message、错误降级标注」一致，需回归 retry 阶梯测试（无内容错误路径不变） |
| R3 | 事件队列 API：push/drive_outcome 改 by value | T09.2 | 仅 Rust 内部 API；测试与调用点已列清单；无协议变化 |
| R4 | 跨 run 对话语义：converge 后 conversation 清空（mem::take） | T09.3.3 | 真实接线每 run 重建 loop（engine.rs:445-452）无影响；测试路径需 with_initial_conversation 续接；已列三方案择一 |
| R5 | 事件类型内部形态：MessageStart/End 消息体改 Arc（wire 不变） | T09.3.2 | 持久化载荷逐字节不变（serde Arc 透传）；波及清单已列；roundtrip 测试锚定 |
| R6 | ~~save_session_body 改 upsert 后不再清除旧行~~ | T09.4 | **已撤销（AU-04 F7）**：写模型 = 全量替换保留（PE-08 T08.10 定稿），删除/编辑历史消息的全量保存继续生效；本任务只新增 append_session_messages 增量命令 |
| R7 | 审批并行组事件时序：ToolStart+ApprovalRequested 全组先发 | T09.6 | 前端审批 UI 若逐个处理需兼容批量（默认模型 A 保持逐个审批，仅执行并行，时序仍为逐工具 start/approval/end——R7 实际仅在选项 B 下成立，登记备查） |
| R8 | LS 镜像节流：非活跃会话离线回退数据滞后 | T09.4 | 已知接受项；SQLite 主存路径不受影响 |

### 3.2 跨域接口契约

| 契约面 | 变更 | 冲突方 | 处置 |
|---|---|---|---|
| `ProviderCall::stream` 签名 | Vec → Stream；**冻结 v1（AU-04 F1）** | TestProvider、HttpProviderCall、session-loop 测试、agent-workbench 集成测试 | 契约正文 SoT = PE-02 §3.1（修订后）；别名 `ProviderStreamItem`/`ProviderEventStream`；T09.1.2 步骤 2/5 全量适配；tauri 侧 `SessionLoopProducer`（engine.rs:436-462）同步 |
| `Store::query_events` 签名 | 加 limit 参数 | InMemoryStore/LocalDbStore/restore.rs/全部 test double | 一处 trait + 两实现 + 两调用点，机械变更；restore 显式传 None 保语义 |
| `AgentSessionEvent`/`AgentEvent` wire 形状 | 不变 | 前端 EventRouter、AA-07 持久化、03-frontend-contract | 本任务所有方案以「wire 逐字节不变」为硬约束，roundtrip 测试为守门 |
| 事件桥/背压 | delta 信封无 sequence | buffer.rs DropClass 判定（按事件类型，:41-58）、core_event_bridge | 类型判定不依赖 sequence，兼容；P9 若前置序列化需同步覆盖 delta 路径 |
| `EventQueue` 逐条同步等待语义 | 不变（批接口仅限重放路径） | approval 中间态可观测（events.rs 测试） | 硬约束登记：append_events 批接口不得接入 push 路径 |
| 前端 session-persistence | commit 增量 + LS 节流 | 离线回退、多端同步（seedSessions） | 与 AA-07 数据持久化审查协同回归；fallback 路径保持全量 |
| RunOutcome.messages | mem::take/Arc 方案 | run_loop.rs/divergence.rs/testing/mod.rs:114 | 适配清单已列；`SessionLoopProducer` 不使用该字段（drive_outcome 忽略），无生产影响 |

### 3.3 依赖与前置

- T09.1 依赖 T09.3 阶段 1（ProviderRequest 借用类型）与 T09.2（drive_outcome by value 后调用点稳定）；**T09.1 与 T09.3 阶段 2 同文件区（streaming.rs / handlers/mod.rs）**，禁止并行执行防冲突；
- **T09.9（abort 三修复）与 T09.1 同文件区（streaming.rs / stream_error.rs / tool_exec.rs），T09.1 之后执行**（AU-04 认领表 #1）；
- 同文件串行（AU-04 附录）：streaming.rs / handlers/mod.rs 与 PE-06（T06.2.1 短路点落点调整在 T09.1 重构之后）；transport/mod.rs 与 PE-10（依赖升级先行）；tool_exec.rs 与 PE-06 T06.1（**PE-06 先行**，T09.6 Arc 化在后）；
- T09.4 需 AA-07 数据持久化域协同回归；T09.6 选项 B 需前端审批批量支持（PE-02 域）；T09.4 与 PE-08 T08.10 串行（F7：PE-08 写模型定稿先行，本任务增量接线在后）；
- T09.7 基线必须先于 T09.2 落地（否则无对照数据）。

---

## 4. 执行顺序与依赖

```
阶段 0（只读 + 基建）：
  T09.7 基准基建 + 基线测量（改前数据）            ← 最先，产出 G1-G7 对照基线

阶段 1（零/低协议风险，快速见效）：
  1. T09.2 P2 事件克隆（独立，无跨文件耦合）        ← cargo test -p orchestrator -p conex-types
  2. T09.3-阶段1 P3 请求链借用（类型稳定前置）      ← cargo test -p session-loop -p agent-provider -p agent-workbench
  3. T09.6 P8 审批并行（独立小改）                  ← cargo test -p session-loop
  4. T09.5 P7 分页下推（独立，签名机械变更）        ← cargo test -p orchestrator -p agent-workbench

阶段 2（结构性改动）：
  5. T09.1 P1 真增量流（依赖 1、2 的类型稳定）      ← 全量回归 + 首 token 集成测试
  6. T09.9 abort 时序三修复（Q21/Q33/Q40）         ← T09.1 之后执行（同文件区落点稳定）
  7. T09.3-阶段2 record_message Arc 化（与 5 串行） ← roundtrip + steering 回归

阶段 3（跨端 + 收口）：
  8. T09.4 P6 写放大（tauri 命令 + 前端 commit 增量，AA-07 协同；与 PE-08 T08.10 串行，F7）
  9. T09.8 首 token 总验收 owner 确认（与 PE-02 T02.6 联调放行）
  10. T09.10 复测 + 基准对照 + 冒烟（live model）
```

依赖规则：P1 与 P3 阶段 2 不得并行（同文件区）；T09.9 依赖 T09.1；P6 前端部分与 PE-02/AA-07 协同；
每步完成必须跑对应 crate 全量测试 + clippy（00-master-plan.md §1.3 质量门槛）。

## 5. 验证清单（可勾选执行）

### T09.1 P1
- [ ] `cargo test -p session-loop -p orchestrator -p agent-provider -p agent-workbench` 全绿
- [ ] 中途错误有内容 → Message 收场不重试；无内容 → 重试阶梯（新增测试）
- [ ] 双轨顺序：实时 sink delta 顺序 = block 顺序；收口流 start/delta/end 契约保持
- [ ] 首 token 集成测试 < 600ms（本地 mock SSE，改前 ≈ 5s）
- [ ] run_loop/divergence 全套回归；delta 不阻塞、终态唯一、序列连续性测试全绿
- [ ] 前端零改动验收（EventRouter 增量累加，联调项）

### T09.2 P2
- [ ] drive_outcome/push 路径无 `.clone()`（代码审查断言）
- [ ] 25 个事件类型名 roundtrip 逐字节不变
- [ ] events.rs 既有 8 个测试全绿；clippy 无新告警

### T09.3 P3
- [ ] 阶段 1：build_request/engine/build.rs 链 0 拷贝（审查断言）；5000 消息基准 O(1)
- [ ] 阶段 2（若做）：record_message 0 深克隆；conex-types roundtrip 全绿
- [ ] converge 方案落地 + with_initial_conversation 测试续接用例全绿
- [ ] steering 行为回归（divergence.rs 全绿）

### T09.4 P6
- [ ] append_session_messages 命令注册（main.rs）+ spawn_blocking 包装（session 族第 13 个命令，F7）
- [ ] save_session_body 全量替换语义回归（R6 撤销后无 upsert 测试）；append 增量续写 seq 连续 + 混合完整性
- [ ] 前端 commit 增量 + id 幂等；hydrate 保持全量
- [ ] 重启回归：3 消息 → 重启 → body 完整无重复（AA-07 协同）
- [ ] 基准：1000 消息 commit 写放大 O(n)→O(k)

### T09.5 P7
- [ ] Store::query_events 三参数全调用点适配（restore 传 None）
- [ ] 分页新测试：limit 行数断言；run 边界在切点的归属一致性（翻页一致）
- [ ] 前端 hydrate 游标循环（若在边界内）

### T09.6 P8
- [ ] 审批并行组新测试：5×50ms 批耗时 < 2×单工具；事件顺序契约回归（F9：Arc 形态 + 执行模型 A）
- [ ] 无审批并行 <95ms 测试保持；审批拒绝/超时/expired 回归

### T09.8/T09.9 新增任务
- [ ] T09.8：PE-perf-baseline.md 单一基线文档就位（PE-02 写入数据，本任务维护）；500ms 端到端验收放行权确认
- [ ] T09.9：Q21 abort-aware 竞速（取消 ≤ 数百 ms 生效）；Q33 consume 后重读 abort 标注；Q40 重试前查 abort（mock 计数）

### T09.7/T09.10 收口
- [ ] 5 个基准场景基线 + 复测对照表（G1-G7 逐项核对；300ms 仅内部基准）
- [ ] `cargo test`（workspace）+ `cargo clippy --workspace` 零新告警
- [ ] live model 冒烟：长回复流式渲染 → 工具调用 → 收口 → 重启恢复
