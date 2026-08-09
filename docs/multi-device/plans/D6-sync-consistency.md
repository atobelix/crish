# D6 跨端数据同步与一致性模型设计

- 文档编号：D6
- 角色：数据同步一致性设计子代理（D6）
- 状态：设计稿（供评审）
- 日期：2026-08-09
- 产出路径：`docs/multi-device/plans/D6-sync-consistency.md`
- 阅读对象：多端互通方案评审组、移动端实现组、桌面 sync 服务实现组
- 与姊妹文档关系：本文聚焦「跨端数据同步与一致性」；同步范围、移动端职责细节与 D 系列其它文档（D1-D5）对齐；本文的代码引用以仓库当前主干为准，编号随演进可变化

---

## 0. 结论摘要（TL;DR）

**同步模型结论**：采用「**状态投影 + 增量事件流**」两级混合模型，并在其上叠加「**命令式审批提交**」与「**纯推送通知**」：

- **通道 A（投影通道，低频）**：会话索引、run 状态摘要、审批待办、审计摘要——以「会话级状态投影」方式同步，移动端据此渲染列表与待办；
- **通道 B（事件通道，高频）**：增量事件流，以 `events` 表 `(session_id, sequence)` 复合主键（`crates/conex-db/src/schema.rs:141-149`）作为天然增量锚点，移动端持**逐会话游标** `last_applied_sequence`，复用 `LocalDb::query_events(session_id, after_sequence, limit)`（`crates/conex-db/src/events.rs:33-68`）的语义做分页增量拉取；
- **通知通道（推送）**：仅推送「新审批待办 / run 状态变化 / 终态」的轻量通知，内容不随推送全量下发，正文走通道 B 拉取。

**权威边界结论**：桌面端是**唯一写权威**（事件源 + run 状态机 + 审批决策 + 审计落库全部在桌面）。移动端**只读 + 命令**：不注入事件、不直接写任何业务表；审批动作以「命令式请求-响应」提交给桌面 sync 服务，由桌面在本地状态机上执行（`crates/orchestrator/src/run.rs:366-374` 的 `resolve_approval`），结果经 `approval-resolved` 事件流回推。移动端不引入 CRDT / 多写者冲突消解——冲突问题整体上移为「命令的幂等与陈旧拒绝」。

**关键融合点**：

1. `LocalDb::query_events` 的 `after_sequence + limit` 签名（`crates/conex-db/src/events.rs:33-68`）直接构成增量拉取的 SQL 面，只需在其上增加「类型白名单过滤 + 负载裁剪」视图层；
2. `restore.rs` 的快照 + 增量重放语义（`crates/orchestrator/src/restore.rs:696-745`，尤其 `session_last_sequence` 逐会话锚点，PERSIST-02 P1-1）是移动端「初始快照 + 持续增量」的现成范本，逐会话锚点语义必须原样移植到移动端游标模型；
3. 审批动作落桌面后走 `RunHandle::resolve_approval`（`crates/orchestrator/src/run.rs:372-374`）状态机转移，`awaiting-approval` 中间态与 `TerminalImmutable`（`run.rs:345-347`）天然构成「陈旧审批拒绝」的防线；
4. 审计落库是 `security-audit` 事件（`crates/conex-types/src/events.rs:559-577`），移动端审计摘要 = 事件流白名单子集 + 摘要化负载；
5. 事件背压分级 `event_backpressure`（`crates/conex-types/src/events.rs:867-893`）中 `Critical` 级事件即「必达落库」事件，可直接作为移动端同步优先级分级的依据（`Delta` 级不落库，天然不参与同步）。

---

## 1. 背景与目标

### 1.1 架构现状：桌面端是权威源

当前 crish 的持久化与运行态全部收敛在桌面端（Windows 桌面应用 + 本地 daemon 进程）：

- **存储**：`conex-db` 本地 SQLite，单一写者模型（`LocalDb` 内部 `Mutex<Connection>` 串行化，`crates/conex-db/src/lib.rs:41-50`）。持有会话索引（`sessions`）、消息正文（`session_messages`）、协作子代理（`session_agents` / `session_agent_messages`）、run 生命周期（`runs` / `pending_inputs`）、事件流（`events`）、会话级元数据（`session_meta`）；
- **事件流**：引擎（session-loop / orchestrator）产生的 41 种域事件经 `EventQueue` 取号落库（`crates/orchestrator/src/events.rs:161-207`），`events` 表以 `(session_id, sequence)` 为复合主键（v5 schema，`crates/conex-db/src/schema.rs:141-149`；v1 起点为 `UNIQUE(session_id, sequence)`，`schema.rs:17-25`），会话内序列全局单调、跨 run 不重置（T08.12，`reserve_sequence`，`crates/conex-db/src/events.rs:72-99`）；
- **状态机**：run 生命周期状态机（`crates/orchestrator/src/run.rs`）与会话状态机（`crates/conex-types/src/session.rs`）全部在桌面内存态，落库 `runs.status`；审批挂起 `awaiting-approval` 是中间态（`crates/conex-db/src/runs.rs:25`）；
- **恢复**：`RestoreManager::restore`（`crates/orchestrator/src/restore.rs:559-767`）支持「快照 + 增量事件流」两级恢复，逐会话锚点 `session_last_sequence`（`restore.rs:308-309`、`696-745`）；
- **前端**：桌面前端通过 Tauri IPC 调 Rust（`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`），SQLite 为主存储、localStorage 为降级镜像（双轨持久化，见 2.5）。

**结论**：桌面端是唯一的「事实源」（source of truth）。任何跨端同步设计都必须以「桌面为权威、移动端为从属视图」为出发点，而不是多主复制。

### 1.2 移动端职责定义

任务书给定的移动端能力范围为：

1. 查看会话状态（列表、当前 run 状态、状态流转）；
2. 查看事件流（run 进行中的事件时间线）；
3. 查看审批待办与处理审批动作（批准 / 拒绝 / 标记过期）；
4. 查看审计记录（高危操作审计摘要）；
5. 接收推送通知（新审批 / run 终态 / 任务完成等）。

**移动端是「观测者 + 轻量操作者」**：绝大多数的数据需求是「看」，唯一的写需求是「审批决策」。这决定了同步模型不需要多写者复制、不需要冲突解决框架，只需要：

- 一个可靠的「只读投影同步」通道（把桌面的状态搬到移动端）；
- 一个可靠的「命令提交」通道（把移动端的审批决策送回桌面执行）；
- 一个「推送」通道（低延迟通知，替代高频轮询）。

### 1.3 设计目标与非目标

**目标**：

- 移动端可离线查看最近状态、离线排队审批动作；
- 数据量/带宽可控（不把完整消息体、代码内容同步到移动端）；
- 审批操作安全（不因双端并发、陈旧状态造成误批准或重复批准）；
- 与既有 Rust 代码面（conex-db / orchestrator / conex-types）复用最大化，不重复造事件存储。

**非目标**（明确不做，防止范围蔓延）：

- 移动端写消息 / 发起 run / 取消 run（后续版本可经同类命令通道扩展，但本文不设计）【裁决修正】AU1 P2-11：此非目标已被 M6 §4.4/§4.5 扩展为 P2 能力位预留（C24 runTask / C25 runControl / C26 cancelRun，默认关），演进登记完毕；
- 移动端本地编辑任何业务表（sessions / runs / messages / agents）；
- 双端双向合并（不引入 CRDT、向量时钟、三路合并）；
- 移动端替代桌面运行引擎或恢复机制；
- 消息正文全文、代码文件内容的同步。

### 1.4 术语表

| 术语 | 含义 |
| --- | --- |
| 桌面端 | 权威端：conex-db + orchestrator + daemon，持有全部数据 |
| 移动端 | 从属端：只读投影 + 命令提交 + 通知接收 |
| 投影（projection） | 由事件流/权威表派生的、面向展示的轻量视图（会话索引、run 摘要等） |
| 增量事件流 | 按 `(session_id, sequence)` 游标推进的事件子集同步 |
| 游标（cursor） | 移动端本地记录的「已应用最大 sequence」 |
| 命令（command） | 移动端发往桌面的写意图（审批决策），桌面校验后执行 |
| 待办（inbox） | 移动端本地缓存的审批待办列表 |
| 对账（reconciliation） | 上线/重连后，本地缓存与桌面权威状态的一致性核对 |
| 摘要化（summarize） | 事件负载裁剪：只保留展示所需字段，丢弃正文/参数全量 |
| 心跳（heartbeat） | 推送通道的长连接保活与在线状态探测 |

---

## 2. 事实基线：关键代码证据

本节汇编设计所依赖的既有实现事实（均附 `文件路径:行号` 证据），后续各章直接引用。

### 2.1 events 表结构与序列语义

**v1 起点形态**（`crates/conex-db/src/schema.rs:17-25`）：

```sql
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, sequence)
);
```

**v5 目标形态**（`crates/conex-db/src/schema.rs:141-149`）：

```sql
CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, sequence),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) WITHOUT ROWID;
```

要点：

- 任务书点名的 `UNIQUE(session_id, sequence)` 在 v1 存在、v5 升格为复合主键——**会话内序列唯一**这一性质两版一致，是增量同步锚点的合法性依据；
- `session_id` 带 FK `ON DELETE CASCADE`——会话删除时事件行级联删除，意味着「会话删除 = 游标作废」的语义天然存在（见 5.4.4）；
- 事件序列为**会话内独立**：不同会话各自从 1 起，跨会话无全局序。任何同步模型必须按会话管理游标（与 restore.rs P1-1 逐会话锚点结论一致，见 2.4）。

**会话级序列取号**（`crates/conex-db/src/events.rs:72-121`）：

- `reserve_sequence(session_id)`：从 `session_sequence` 表原子取号（首次按 `max(sequence)+1` 隐式预热），`next_sequence` 单调自增——会话内跨 run 不重置（T08.12 Q23）；
- `seed_sequence(session_id, n)`：MAX 语义预热/校准（只抬高不回退，幂等）。

**StoredEvent 行记录**（`crates/conex-db/src/events.rs:124-131`）：`session_id / sequence / event_type / payload(String) / created_at`。payload 为事件体 JSON 字符串（事件信封序列化产物，见 conex-types 2.3）。

### 2.2 query_events：现成的增量查询面

`LocalDb::query_events`（`crates/conex-db/src/events.rs:33-68`）：

```rust
pub fn query_events(
    &self,
    session_id: &str,
    after_sequence: i64,
    limit: Option<i64>,
) -> Result<Vec<StoredEvent>, DbFailure> {
    // SELECT session_id, sequence, event_type, payload, created_at
    //  FROM events WHERE session_id = ?1 AND sequence > ?2
    //  ORDER BY sequence ASC LIMIT ?3
}
```

要点：

- 签名即「增量拉取」：`after_sequence` = 游标，`limit` = 分页上限（注释明确「修复无界查询性能问题，对齐 Stream B 6.3」，推荐显式传 `Some(n)`）；
- **游标是开区间**（`sequence > ?`）：天然容忍序列空洞（delta 事件占号不落库造成的 gap，见 2.3）；
- 排序 `ORDER BY sequence ASC`：应用侧只需顺序追加，无需排序/合并；
- 分页语义完整：`(after_sequence, limit)` 可反复调用直至返回行数 < limit；
- **注意**：orchestrator 的 `Store` trait 抽象（`crates/orchestrator/src/persist.rs:168`）只暴露无 limit 的 `query_events(session_id, after_sequence)`，limit 参数仅在 `LocalDb` 层存在——移动端同步服务应直接调用 `LocalDb` 层（或为该面新增带 limit 的 trait 方法，见 9.1）。

### 2.3 事件落库分类与序列空洞

`EventQueue::push`（`crates/orchestrator/src/events.rs:161-207`）的流程：

1. `reserve(session_id)` 取号（store 端原子计数器）；
2. `is_non_persistent(&event)` 判定（`events.rs:48-58`）：`message-delta` 与 `subagent-event(progress)` 为 `NonPersistent`，**不落库、不阻塞**；
3. 持久化事件 `append_event` 同步等待落库（`approval-requested` 等中间态事件返回时已可观测）。

**推论：序列空洞必然存在**。delta 事件消耗了 sequence 号但未落库，因此：

- `events` 表内某会话的 sequence 集合是「0..N 的子集」，不是连续整数；
- 增量拉取必须用「`sequence > cursor`」开区间（query_events 已如此），**禁止**用「`sequence == cursor+1`」这类连续性假设；
- 移动端游标 = 「已看到的最大 sequence」，不是「已处理条数」。

背压分级（`crates/conex-types/src/events.rs:867-893`）与落库分类的关系：`Delta` 级（message-delta / subagent progress / task-output / task-heartbeat）**不落库或可丢**，`Soft` 级（subagent message/tool、task-suspicious、timer-cancelled）尽力投递，`Critical` 级（终态、审批、审计等）必达落库。移动端同步的候选集 = **已落库事件**；`Delta` 级事件即便落库也不应同步（白名单见 7.3）。

### 2.4 restore.rs：快照 + 增量重放的既有范本

`RestoreManager::restore`（`crates/orchestrator/src/restore.rs:559-767`）语义要点：

- **模式**：`RestoreMode::FullReplay`（无快照，从 0 全量重放）或 `SnapshotIncremental`（快照 + `last_sequence` 后增量流）（`restore.rs:64-69`、`566-570`）；
- **逐会话锚点（PERSIST-02 P1-1）**：`StateSnapshot.session_last_sequence: HashMap<String, u64>`（`restore.rs:308-309`），增量恢复按**会话自身**锚点取增量（`restore.rs:711-727`）：
  - 快照会话：`base = session_last_sequence[session]`（旧快照缺字段回退全局 `last_sequence`）；
  - 快照后新派生会话：`base = 0` 全量；
  - 注释明示根因：「事件序列为会话内独立，全局 max 作会话级 base 会永久跳过落后会话的快照后事件」——**这一教训直接决定移动端游标模型必须逐会话**（见 4.5）；
- **事件重放**：只消费两类事件（`session-leaf-moved` 叶子移动、`context-compression-end` 压缩护栏），载荷损坏时跳过不中断（`restore.rs:729-743`）——移动端应用侧重放应继承「容错跳过 + 显式上报」风格（见 9.2）；
- **快照校验**：checksum（FNV-1a 64）+ `.prev` 备份双文件模型（`restore.rs:289-394`、`417-494`）——移动端初始同步的「快照完整性」设计可参考，但移动端无需文件级双备份（本地库重建即可）。

### 2.5 前端双轨持久化（桌面前端）

`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`：

- **主存储**：SQLite（Tauri invoke → Rust `spawn_blocking`），全部会话 API 走 Rust（文件头注释 1-25 行）；
- **降级镜像**：localStorage（invoke 缺失时回退），键前缀 `crish_session_index_v1` / `crish_session_body_v1:` / `crish_session_agents_v1:`（`sessionPersistenceTypes.ts:5-9`）；
- **写竞态防线**（PS-03 T3.2 D6）：模块级写串行队列 `writeChain`（`sessionRustDb.ts:1115-1165`）+ 批次版本戳 `batchVersionCounter` + CAS（`writtenBodyBatchVersions`，`sessionRustDb.ts:1134-1150`）——`saveSessionBody` 落库前比较版本号，陈旧批次直接丢弃不覆盖（`sessionRustDb.ts:705-752`）；
- **降级戳**（P1-F1）：invoke 失败写 localStorage 时打 `crish_degraded_<id>` 戳，hydrate 时以 LS 为真源单向回灌修复（`sessionRustDb.ts:986-1020`）。

对移动端同步设计的启示：

1. 「写竞态」在桌面单机内都需要 CAS——跨端同步更要默认「重复提交/乱序到达」存在；
2. 「单向修复 + 留痕」的分叉处理哲学（不静默、可观测）应移植到移动端对账流程（见 6.5）；
3. 移动端本地缓存设计可借鉴「主存 + 降级镜像」双层：本地 SQLite（主）+ 内存缓存（次）。

### 2.6 run 状态机与审批

- `RunStatus` 枚举含 `AwaitingApproval` 中间态（`crates/conex-db/src/runs.rs:25`）；
- 转移表：`running --ApprovalRequested--> awaiting-approval`，`awaiting-approval --ApprovalResolved--> running`，`awaiting-approval --CancelRequested--> cancelling`（`crates/orchestrator/src/run.rs:146-156`）；
- `transition` 落库 + touch 会话（`run.rs:340-364`），终态后 `TerminalImmutable` 拒绝任何转移（`run.rs:345-347`）；
- `request_approval` / `resolve_approval`（`run.rs:366-374`）即审批挂起/恢复的权威入口；
- `finalize` 收口终态，`run-terminal` 事件由调用方经事件队列发出（`run.rs:430-473`）。

### 2.7 事件契约与审批/审计载荷

`crates/conex-types/src/events.rs`：

- `AgentEvent` 41 种事件 tagged enum（`events.rs:305-782`），顶层 `type` kebab-case，字段 camelCase；
- 事件信封 `AgentEventEnvelope`（`events.rs:922-1013`）：扁平 JSON，注入 `runId / sequence / schemaVersion`；`sequence` 是「重放去重与游标的唯一依据」；
- `PermissionRequest`（`events.rs:194-218`）：审批请求载荷，含 `id / session_id / cwd / tool_call_id / tool_name / parameters(serde_json::Value) / summary / tool_metadata / requester_run_id / reason`——**`parameters` 是全量参数包，是隐私裁剪的重点对象**；
- `ApprovalDecision`（`events.rs:220-232`）：`approved / denied / expired` 三规范值；
- `SecurityAudit`（`events.rs:559-577`）：`operation / targets(Vec<String>) / impact(ImpactAssessment) / decision / permission_mode / tool_call_id`——审计载荷含目标路径列表与影响面；
- `TaskFailed`（`events.rs:704-715`）：`tail: Vec<String>`（最后 20 行日志）——敏感输出；
- `MessageStart/MessageEnd`（`events.rs:344-367`）：携带 `Arc<AgentMessage>` 全文（blocks 含 text/thought/tool-call/tool-result，见 `crates/conex-types/src/message.rs:32-50`）——**完整消息体在事件流中即全量存在**，同步裁剪必须在这里做。

### 2.8 会话级上下文元数据

`SessionContextMeta`（`crates/conex-types/src/context.rs:46-61`）：`last_compaction_at / last_compaction_sequence / last_compaction_generation / compression_retries`，随会话记录持久化，restore 时恢复。移动端如需展示「会话压缩过」之类的元信息，可从 `context-compression-end` 事件或快照派生（非同步主体，见 3.3）。

---

## 3. 同步范围（移动端持有什么数据）

### 3.1 原则：按「移动端职责」裁剪

同步范围的裁剪原则一句话：**移动端只同步「看得到、用得上」的最小充分集**。判定标准：

1. 移动端职责清单（1.2）能否被满足；
2. 每类数据若不同步，移动端体验是否会不可用或误导；
3. 每类数据的敏感度（隐私）与体积（带宽/存储）是否值得同步。

### 3.2 同步清单：5 类数据

| # | 数据类别 | 移动端用途 | 载体 | 是否同步 | 理由 |
| --- | --- | --- | --- | --- | --- |
| S1 | 会话索引（sessions 投影） | 会话列表（标题/文件夹/时间/消息数/固定/归档） | 投影（通道 A） | ✅ 同步 | 移动端首页即是会话列表，离线可浏览 |
| S2 | run 状态摘要（runs 投影） | run 列表与状态徽标（queued/running/awaiting-approval/completed/failed/cancelled + end_reason + cursor） | 投影（通道 A）+ 事件（通道 B） | ✅ 同步 | 状态是移动端观测核心；事件流（run-terminal/run-interrupted）提供状态变化的时间线佐证 |
| S3 | 审批待办（approval-requested 派生） | 审批列表（工具名/摘要/请求方/时间）+ 审批动作 | 投影（通道 A）+ 命令（提交） | ✅ 同步 | 移动端核心写能力；待办必须离线可见（6.2） |
| S4 | 审计摘要（security-audit 派生） | 审计面板（操作类别/目标/决策/时间） | 摘要事件（通道 B 白名单 + 裁剪） | ✅ 同步（摘要） | 审计是移动端职责之一；只同步摘要字段 |
| S5 | 事件流（run 时间线） | run 详情页的事件时间线（turn/tool/消息开始结束/压缩等） | 增量事件（通道 B，白名单过滤） | ✅ 同步（子集） | 事件流是移动端职责之一，但只同步白名单类型 |

### 3.3 不同步清单：明确排除

| # | 数据类别 | 排除理由 | 替代方案 |
| --- | --- | --- | --- |
| N1 | 完整消息正文（message-start/message-end 全文） | 带宽（一个长会话可达 MB 级）、隐私（对话内容）、移动端职责不需要全文 | 消息摘要事件（messageId + 首 N 字符 + 状态），用户点击详情时按需拉取（可选增强） |
| N2 | thinking 内容（thought 块） | 隐私（思考链）、体积 | 不同步；如需展示只同步「有无 thinking」布尔 |
| N3 | 工具调用参数全量（tool-call input / approval parameters） | 参数可能含文件内容、命令、密钥类敏感信息 | 只同步 summary / toolName / 参数键名白名单 |
| N4 | 工具执行结果全量（tool-end result.output / tool-result 块） | 命令输出、文件内容、体积大 | 只同步 isError + 退出状态 + 输出前 N 字符摘要 |
| N5 | 代码/文件内容（任何工具读写载荷、task-output 尾部日志、security-audit 中 targets 的全文上下文） | 隐私红线：文件内容不上移动端 | 路径 + 统计摘要（文件数/大小/目录数，ImpactAssessment 已有） |
| N6 | message-delta / task-output / task-heartbeat / subagent-event(progress) | Delta 级增量，不落库或可丢，移动端无实时逐字流需求 | 不进入同步通道；推送通知只携带「有更新」语义 |
| N7 | pending_inputs 内容 | 桌面内部待消费输入，移动端无消费面 | 不同步；仅 run 状态摘要反映「awaiting-input」语义 |
| N8 | session_agents 的完整消息树（子代理全量消息） | 体积、移动端只关心「子代理是否在跑、何时结束」 | 只同步 session_agents 行投影（status/description/summary/depth），不含 messages 或仅含消息条数 |
| N9 | 压缩块（compression_blocks） | 桌面内部上下文压缩产物 | 不同步；会话投影可含「最近压缩时间」派生字段 |
| N10 | session_meta 全部键值 | 桌面内部配置 | 只同步少量展示键（如 folder_order） |

### 3.4 同步数据与权威表的映射

| 移动端同步面 | 桌面权威表 | 派生方式 | 同步粒度 |
| --- | --- | --- | --- |
| 会话列表 | `sessions`（`schema.rs:123-139`） | 直接投影 `list_sessions`（`crates/conex-db/src/sessions.rs:86-128`） | 会话级整行 |
| run 摘要 | `runs`（`schema.rs:151-169`） | 投影 `StoredRun`（`crates/conex-db/src/runs.rs:88-98`） | run 级整行 |
| 审批待办 | `events` 表 `approval-requested` 未配对事件 | 事件流白名单 + 「已 resolved」配对判定 | 单审批项 |
| 审计摘要 | `events` 表 `security-audit` 事件 | 事件流白名单 + 摘要化 | 单审计项 |
| 事件时间线 | `events` 表全量（落库子集） | 白名单过滤 + 摘要化 | 单事件 |

**设计要点**：审批待办与审计摘要**不需要新建业务表**——它们是 `events` 表上「白名单事件 + 配对/过滤」的派生视图。这与 restore 的「事件是唯一事实源」哲学一致：桌面不维护第二份待办表，移动端同步服务直接查事件流派生。审批配对的实现（9.3）以 `approval-requested.request.id`（`conex-types/events.rs:196`）为键关联 `approval-resolved.tool_call_id`（`events.rs:487-495`，兼容字段 `request_id`）。

### 3.5 同步范围的演化策略

- 3.2 清单是 **v1 最小集**；后续移动端需求（如查看消息详情、按需拉取正文）通过「按需拉取接口」（on-demand fetch）扩展，不改变同步模型骨架；
- 每一项新增同步面都必须过 3.1 的三条判定，并在本文 3.2 表追加一行（本文为设计基线，后续评审维护）；
- **排除清单（N1-N10）是隐私承诺**，任何放宽必须走用户显式配置（见 7.5），不允许默认放开。

---

## 4. 同步模型

### 4.1 四种候选模型

任务书给出四个候选，逐一评估：

**候选 1：全量拉取（Snapshot Pull）**

- 机制：移动端每次上线/定时，把会话索引 + run 摘要 + 审批待办全量拉一遍。
- 优点：实现最简单；无游标状态；天然自愈（任何漂移被全量覆盖）。
- 缺点：数据量与数据变化率成正比；高频 run 事件无法跟得上（消息/tool 事件每分钟几十上百条，全量不现实）；带宽浪费；移动端不能做「流式时间线」。
- 适用：低频数据（会话索引、审计摘要）的**初始引导与自愈兜底**，不能作为事件流方案。

**候选 2：增量事件流（Event Stream Incremental）**

- 机制：按 `(session_id, sequence)` 游标增量拉取 `events` 表子集，移动端本地重放/投影。
- 优点：与既有事实源（events 表 + query_events）零语义损失对齐；带宽只随变化量增长；支持逐事件时间线；断点续传天然（游标不丢）。
- 缺点：移动端需要本地「应用」逻辑（事件 → 本地投影）；需要处理白名单过滤、负载裁剪；高频事件的持续拉取需要分页与推送配合。
- 适用：事件时间线、run 状态变化、审批配对——**同步模型主干**。

**候选 3：状态快照 + 事件补丁（Snapshot + Event Patch）**

- 机制：低频拉全量快照，快照之后用增量事件流打补丁；快照失效/落后过多时重新全量。
- 优点：restore.rs 已验证的同构机制（`restore.rs:559-570`）；解决「事件流可能永久落后」的深层问题（比如移动端 30 天未上线，事件流累计 10 万条，逐条同步不划算）；快照重建成本可控。
- 缺点：需要快照服务端（序列化 sessions/runs/待办投影）；快照与事件流的衔接点（锚点对齐）需要严格设计。
- 适用：**作为增量事件流的「引导与重建」层**——移动端首次同步用快照，日常同步用事件流，落后阈值超限时降级回快照重建。

**候选 4：仅推送通知（Push-only）**

- 机制：桌面只推送「有新审批/新事件」通知，不传数据；移动端收到通知后按需拉取。
- 优点：带宽最小；移动端不存任何数据。
- 缺点：离线能力为零（通知到不了或到了没数据看）；无历史回看；「推送即事实」会造成通知与数据不一致的窗口。
- 适用：**作为通道 C 的形态**（通知），不能独立承担同步——通知是「唤醒」，数据是「拉取」。

### 4.2 权衡矩阵

| 维度 | 候选 1 全量 | 候选 2 增量事件流 | 候选 3 快照+补丁 | 候选 4 仅推送 |
| --- | --- | --- | --- | --- |
| 带宽随变化量 | 线性（坏） | 线性（好，系数小） | 好（快照低频 + 事件增量） | 最优 |
| 离线可看历史 | 依赖离线缓存 | 依赖本地应用 | 依赖本地应用 | 无 |
| 实现复杂度 | 低 | 中 | 中高 | 低 |
| 与既有代码复用 | 低（新接口） | 高（query_events） | 高（restore 语义） | 低 |
| 自愈能力 | 天然 | 需要对账 | 快照重建 = 自愈 | 无 |
| 实时性 | 差 | 好（配推送） | 好 | 好（仅通知） |
| 游标/状态要求 | 无 | 逐会话游标 | 逐会话游标 + 快照代数 | 无 |

### 4.3 推荐组合：两级混合 + 命令 + 通知

推荐采用「**候选 3 的快照/重建层 + 候选 2 的事件流主通道 + 候选 4 的通知形态**」组合，即：

```
┌──────────────────────────── 桌面端（权威） ────────────────────────────┐
│  conex-db (SQLite)                                                    │
│   ├─ sessions / runs / messages / agents（业务投影源）                  │
│   ├─ events（事件事实源，(session_id, sequence)）                       │
│   └─ session_sequence（取号）                                          │
│  sync 服务（新增，见 9.6）                                              │
│   ├─ 通道 A：投影接口（会话索引 / run 摘要 / 审批待办 / 审计摘要）          │
│   ├─ 通道 B：增量事件接口（游标 + 白名单 + 裁剪 + 分页）                    │
│   └─ 通道 C：推送（新审批 / run 状态变化 / 终态通知）                     │
└────────────────────────────┬──────────────────────────────────────────┘
                             │ 协议：HTTP/WS + JSON（事件流走 WS 或长轮询）
┌────────────────────────────▼──────────────────────────────────────────┐
│  移动端（从属）                                                        │
│   ├─ 本地库：session_cursors（逐会话游标）/ sessions 投影 / runs 投影 /   │
│   │           approval_inbox（待办+队列）/ audit_summary                │
│   ├─ 同步引擎：引导(快照) → 增量(事件流) → 对账(重连) → 重建(落后超限)      │
│   └─ 命令通道：审批提交（请求-响应，幂等键）                               │
└───────────────────────────────────────────────────────────────────────┘
```

**通道职责划分**：

| 通道 | 数据 | 频率 | 传输形态 | 离线策略 |
| --- | --- | --- | --- | --- |
| A：投影 | 会话索引、run 摘要、审批待办、审计摘要 | 低频（会话变更时推送 / 定时刷新） | 全量 JSON（小，KB 级） | 本地缓存展示 |
| B：事件流 | 白名单事件（时间线 + 状态变化） | 高频（run 进行中秒级） | 分页增量 + WS 推送增量 | 上线后按游标补齐 |
| C：通知 | 轻量通知（有新审批/终态/任务完成） | 事件驱动 | 推送通道（APNs/FCM 或自定义 WS） | 通知本身不可离线，正文离线时显示「上线后查看」 |
| 命令 | 审批决策 | 用户触发 | HTTP 请求-响应 | 本地队列（6.3），上线补发 |

**为何不采用「仅事件流」**：移动端 30 天未开 + 长会话事件量积累（估算见 10.1）会形成「逐条补齐」的放大效应，快照层一次性收敛成本远低。

**为何不采用「状态快照作为主通道」**：快照无法表达事件时间线（移动端职责 2「查看事件流」要求逐事件视图），且高频 run 进行中快照频率会追不上事件产生率——快照只能做低频投影，事件流做高频增量。

### 4.4 sequence 游标：增量同步的天然锚点

**锚点合法性**：`events` 表 `(session_id, sequence)` 复合主键（2.1）保证：

1. **会话内全序**：同一会话的事件序列严格单调递增（`reserve_sequence` 单语句原子取号，`crates/conex-db/src/events.rs:72-99`）；
2. **唯一性**：不存在两个同序列事件（`UNIQUE(session_id, sequence)` / 复合主键）；
3. **追加性**：事件只追加不修改（`append_event` 仅 INSERT，`crates/conex-db/src/events.rs:8-27`）——已同步的事件永不改变，游标不会被「历史被改写」攻击；
4. **级联删除**：会话删除 → 事件级联删（FK CASCADE）→ 游标作废语义明确（5.4.4）。

**游标形态**：移动端本地维护

```json
{
  "session_id": "s-abc",
  "last_applied_sequence": 128,
  "applied_at": 1723200000000
}
```

- `last_applied_sequence` = 该会话已**成功应用**（写本地投影完成）的最大 sequence；
- 拉取请求：`GET /sync/events?session_id=s-abc&after=128&limit=200`；
- 响应含 `has_more` 分页标志与 `latest_sequence`（服务端该会话当前 max，供推进判断）；
- 应用成功后才推进游标；**游标推进与应用是同一事务**（本地库原子性，见 4.6）。

### 4.5 逐会话游标 vs 全局游标

**结论：必须逐会话**，依据是 restore.rs P1-1 的教训（`crates/orchestrator/src/restore.rs:307-309`、`711-727` 注释）：事件序列为会话内独立，用全局 max 作会话级 base 会**永久跳过落后会话的快照后事件**（粘性丢失）。

对应到移动端：

- 若用单一全局游标（所有会话共享 max），一个新创建的会话 A 的事件（sequence 1..50）与旧会话 B 的事件（sequence 1..500）会互相干扰——无法回答「B 拉到哪里了」；
- 逐会话游标下，每会话独立推进、独立重建、独立作废，互不污染；
- **全局状态只作展示**（如「最近更新会话排序」），不参与同步推进判定。

**派生结论**：服务端必须提供「会话级 latest sequence」查询（`GET /sync/sessions` 的响应中携带每会话 `max_sequence`），移动端据此：

- 判断是否有新事件（`cursor < max_sequence`）；
- 判断是否落后超限（`max_sequence - cursor > 阈值` → 触发快照重建，见 6.5/10.3）。

### 4.6 游标推进规则（幂等与原子性）

1. **先应用后推进**：事件写本地库成功（事务提交）后，才把 `last_applied_sequence` 更新为新值；两件事在同一本地事务内完成；
2. **幂等应用**：应用层以 `(session_id, sequence)` 为去重键——重复收到同序列事件（网络重试、服务端重复返回）直接跳过，不重复写投影；本地投影行可带 `source_sequence` 字段支持「重复投递覆盖为同值」；
3. **空洞容忍**：收到 `sequence 100, 102` 而 101 缺失（delta 不落库或服务端过滤），游标推进到 102 即可，**不需要**补拉 101；
4. **回退禁止**：本地游标只升不降（与 `seed_sequence` 的 MAX 语义同构，`crates/conex-db/src/events.rs:103-121`）——服务端时间回拨、重连错乱都不会造成游标回退；
5. **重建语义**：快照重建时游标 = 快照的 `max_sequence`（参考 `restore.rs:302-309` 的 `last_sequence` / `session_last_sequence` 语义），重建后继续增量。

### 4.7 同步时序（主流程）

```
移动端启动
  ├─ 1. 拉快照（首启）/ 载入本地缓存（非首启）
  │     GET /sync/bootstrap?since=... → { sessions: [...], runs: [...],
  │           approvals: [...], audit: [...], cursors: {sid: max_seq} }
  ├─ 2. 对账（仅非首启）：本地缓存与 bootstrap 投影 diff（见 6.5）
  ├─ 3. 增量事件循环
  │     for each 会话 sid in 关注的会话集合:
  │         while cursor[sid] < latest[sid]:
  │             GET /sync/events?session_id=sid&after=cursor[sid]&limit=200
  │             应用事件 → 推进游标
  ├─ 4. 实时模式：订阅 WS（/sync/stream?cursors=...），收到推送增量立即拉取
  ├─ 5. 命令：审批提交 POST /sync/approval/resolve（请求-响应）
  └─ 6. 周期心跳 + 落后检测（落后超限 → 回到步骤 1 重建该会话）
```

### 4.8 会话集合策略（同步哪些会话）

移动端关注会话集合是可配置的：

- **默认**：全部会话（投影通道只同步索引与摘要，体积可控）；事件流通道只同步「活跃会话」（有非终态 run 的会话 + 用户最近打开的会话）；
- **白名单**：用户可在移动端标记「关注」的会话（事件流常驻）；
- **懒加载**：用户点开非活跃会话详情时，按游标补齐该会话事件流（无需重建，游标天然支持任意会话接入）。

### 4.9 同步协议消息格式（草案）

协议为 JSON over HTTP(S) + WS，命名风格与仓库事件契约一致（camelCase，参考
`crates/conex-types/src/events.rs:1-8` 的契约约定）。以下为三通道的请求/响应骨架，
**序列化字段以本草案为基线，实现期以接口文档为准**（字段集可与移动端实现组对齐后微调）。

**4.9.1 引导（bootstrap）——通道 A + 游标初值**

```
GET /sync/bootstrap?since=1723200000000&granularity=standard

200 {
  "schemaVersion": 1,
  "generatedAt": 1723200005000,
  "sessions": [
    {
      "id": "s-abc",
      "title": "重构事件队列",
      "folder": "常规会话",
      "isPinned": false,
      "isArchived": false,
      "timestamp": "2026-08-09T08:00:00Z",
      "updatedAt": 1723200000000,
      "messageCount": 42,
      "maxSequence": 128,            // 该会话最新事件序列（游标初值）
      "activeRun": {                 // 非终态 run 摘要（无则缺省）
        "runId": "r-01JQ...",
        "status": "awaiting-approval",
        "cursor": 127
      }
    }
  ],
  "approvals": [                     // 未配对审批待办（桌面派生）
    {
      "requestId": "req-01JQ...",
      "sessionId": "s-abc",
      "toolName": "edit_file",
      "summary": "修改 crates/sync-server/Cargo.toml",
      "requestedAt": "2026-08-09T08:12:00Z",
      "requester": "main-agent"       // 或子代理 run id
    }
  ],
  "audit": [                         // 最近审计摘要（上限 100 条）
    {
      "sequence": 120,
      "sessionId": "s-abc",
      "operation": "delete_file",
      "targets": ["docs/archive/legacy.md"],
      "decision": "redirected",
      "timestamp": "2026-08-09T08:00:00Z"
    }
  ],
  "config": {                        // 同步配置（7.5 档位 + 白名单版本）
    "granularity": "standard",
    "whitelistVersion": 3
  }
}
```

**4.9.2 增量事件——通道 B**

```
GET /sync/events?sessionId=s-abc&after=128&limit=200&granularity=standard

200 {
  "sessionId": "s-abc",
  "after": 128,
  "events": [
    {
      "sequence": 130,
      "type": "run-terminal",
      "runId": "r-01JQ...",
      "timestamp": "2026-08-09T08:13:00Z",
      "terminal": "completed",       // 事件字段（裁剪后）
      "error": null
    },
    {
      "sequence": 131,
      "type": "approval-requested",  // 类型在白名单内才出现
      "runId": "r-01JQ...",
      "timestamp": "2026-08-09T08:14:00Z",
      "request": {
        "id": "req-01JQ...",
        "toolCallId": "call-xyz",
        "toolName": "write_file",
        "summary": "写入 README.md"  // parameters 全量已被裁剪
      }
    }
  ],
  "latestSequence": 131,             // 服务端该会话当前 max
  "hasMore": false
}
```

**4.9.3 命令提交——审批决策**

```
POST /sync/approval/resolve
{
  "requestId": "req-01JQ...",
  "toolCallId": "call-xyz",
  "sessionId": "s-abc",
  "decision": "approved",
  "reason": "远程批准",
  "clientCommandId": "m-01JQ...-3",
  "deviceId": "iphone-001"
}

200 { "status": "accepted", "resolvedAtSequence": 132, "decision": "approved" }
409 { "status": "conflict", "reason": "already resolved", "existingDecision": "denied" }
409 { "status": "stale", "reason": "run terminal: completed" }
404 { "status": "not-found", "reason": "pending approval not found" }
422 { "status": "invalid", "reason": "bad request" }
```

**4.9.4 推送通知——通道 C**

```
WS 帧（移动端订阅 /sync/stream?deviceId=...）：
{ "type": "sync-push", "sessionId": "s-abc", "newMaxSequence": 135,
  "hints": ["approval-requested", "run-terminal"] }

系统推送（后台）：
{ "aps": { "alert": { "title": "新审批请求",
                       "body": "edit_file: 修改 crates/sync-server/Cargo.toml" } },
  "sync": { "sessionId": "s-abc", "hints": ["approval-requested"] } }
```

**4.9.5 错误语义约定**

| 响应码 | 语义 | 移动端处理 |
| --- | --- | --- |
| 200 | 成功 | 正常应用 |
| 400 | 参数错误（游标非法/格式错误） | 记录日志；不重试（修复参数） |
| 401/403 | 设备未配对/权限不足 | 引导重新配对；同步暂停 |
| 404 | 资源不存在（会话已删/审批已消） | 触发对账/待办失效 |
| 409 conflict | 命令与权威状态冲突 | 收敛为既有决策（8.3） |
| 409 stale | 目标 run 已终态 | 待办失效，不重试 |
| 429 | 限流 | 指数退避重试 |
| 5xx | 服务端故障 | 指数退避重试；长超时后视为离线 |

**4.9.6 协议版本演进**

- 协议顶层 `schemaVersion`（bootstrap 响应携带）；事件信封沿用
  `schemaVersion` 约定（`crates/conex-types/src/events.rs:935-939` 的
  `EVENT_ENVELOPE_SCHEMA_VERSION` 语义：缺省视为 1，向后兼容）；
- 新增字段一律 `serde(default)` 兼容（参考 `SessionContextMeta` 的兼容扩展
  写法，`crates/conex-types/src/context.rs:45-47`）；
- 白名单与 redact 规则随 `config.whitelistVersion` 版本化下发——移动端缓存
  旧版本配置期间，服务端按**服务端当前版本**裁剪（移动端只消费，不解释
  未登记字段）；配置版本升级为不兼容变更时，强制移动端先拉 bootstrap。

---

## 5. 权威与冲突

### 5.1 权威边界总原则

| 数据面 | 权威 | 移动端角色 | 写路径 |
| --- | --- | --- | --- |
| events 表 | 桌面（仅桌面 append） | 只读消费 | 无 |
| sessions / runs / messages / agents | 桌面 | 只读投影 | 无 |
| run 状态机 | 桌面（内存 + runs 表） | 只读观测 | 无 |
| 审批决策 | 桌面（`resolve_approval` 状态机转移） | **命令发起方** | 命令提交 → 桌面校验执行 |
| 审计 | 桌面（security-audit 事件） | 只读摘要 | 无 |
| 会话删除 | 桌面 | 被动感知（事件/投影删除） | 无 |

**铁律：移动端不写任何业务表，不注入任何事件。** 理由：

1. 事件序列取号（`reserve_sequence`）在桌面本地 `session_sequence` 上原子自增（`crates/conex-db/src/events.rs:72-99`）——若移动端也注入事件，需要跨端共享取号器，引入分布式序列复杂度且破坏「桌面为唯一事件源」的审计可信度；
2. run 状态机转移依赖桌面内存态（`RunHandle`），移动端写 `runs.status` 与状态机脱节，必然产生漂移；
3. 单一写者是审计与一致性的免费午餐：**没有多写者，就没有真正的冲突消解问题**。

### 5.2 移动端写操作提交模型：命令式请求-响应 vs 事件注入

**候选 A：事件注入（移动端直接把 approval-resolved 事件写进桌面 events 表）**

- 优点：统一走事件流回读，实现路径单一；
- 缺点：移动端需具备桌面取号权限（`reserve_sequence` 需要跨端同步取号状态）；审批决策是「状态机转移」而不仅是「追加事件」——只注入事件不驱动 `resolve_approval`，run 状态不会恢复，事件与 `runs.status` 脱节；安全性差（移动端可注入任意事件伪造审计）。

**候选 B：命令式请求-响应（移动端发命令，桌面校验执行后落库）** ✅ 推荐

- 流程：
  1. 移动端 `POST /sync/approval/resolve`，载荷：`requestId / toolCallId / decision / reason / deviceId / clientCommandId（幂等键）`；
  2. 桌面 sync 服务校验：请求存在、run 状态仍为 `awaiting-approval`、未重复处理（幂等）；
  3. 校验通过 → 调 `RunHandle::resolve_approval`（`crates/orchestrator/src/run.rs:372-374`）状态机转移；
  4. 桌面落库 `approval-resolved` 事件（经 `EventQueue`，`crates/orchestrator/src/events.rs:161-207`）+ run 状态更新；
  5. 响应移动端：`{ status: "accepted", approvalResolvedSequence: N }` 或 `{ status: "stale" | "conflict" | "not-found", reason }`；
  6. 移动端等待「自己的命令生效」以 `approval-resolved` 事件（sequence N 之后）**在事件流中到达**为最终确认（见 8.3 两阶段确认）。
- 优点：桌面保持单一写者；校验与状态机转移在权威端原子完成；事件注入的审计可信度不破坏；幂等键天然防重复提交。
- 结论：**命令式**。

### 5.3 审批命令协议（草案）

```
POST /sync/approval/resolve
Content-Type: application/json

{
  "requestId": "req-01JQ...",          // approval-requested.request.id
  "toolCallId": "call-xyz",            // 审批目标工具调用 id
  "sessionId": "s-abc",
  "decision": "approved",              // approved | denied | expired
  "reason": "用户远程批准",             // 可选，写入审批审计
  "clientCommandId": "m-01JQ...-1",    // 移动端幂等键（设备 + 序号）
  "deviceId": "iphone-001"
}

响应：
200 { "status": "accepted", "resolvedAtSequence": 132, "decision": "approved" }
409 { "status": "stale",  "reason": "run already terminal: completed" }
409 { "status": "conflict", "reason": "already resolved by another client", "existingDecision": "denied" }
404 { "status": "not-found", "reason": "no pending approval with requestId" }
```

**幂等键语义**：`clientCommandId` 由移动端生成（UUID/设备序号），桌面保存「已处理命令」集合（session_meta 或新表，见 9.6）；同 `clientCommandId` 重发 → 返回首次处理结果，不重复执行。这是网络重试安全的基石（移动端超时重发是常态，见 6.3）。

### 5.4 冲突场景与解法

**场景 1：双端同时审批同一请求（桌面用户点批准、移动端同时点拒绝）**

- 桌面状态机视角：`awaiting-approval --ApprovalResolved--> running` 是**单一转移**（`crates/orchestrator/src/run.rs:153`），状态机本身保证「第二次转移发生在错误状态上」：
  - 第一次转移成功（awaiting-approval → running）；
  - 第二次转移：状态已非 awaiting-approval，`transition` 返回 `Transition` 错误（`run.rs:348`）或被状态机拒绝（`run.rs:145-156` 的 `(状态, 事件)` 无定义转移显式失败）；
  - 即使第二次命令到达时 run 仍在 awaiting-approval（双命令并发飞行），桌面 sync 服务串行执行（单进程 Mutex/队列），**后到者**在桌面内存态校验时发现「审批已 resolve（内存标记 + approval-resolved 事件已落库）」，返回 `conflict`；
- 移动端语义：**不乐观**——不显示「已批准」直到收到本命令的响应或 approval-resolved 事件；收到 `conflict` 时展示「该请求已在其它设备处理（决策：denied）」，本地待办置灰；
- 最终真相：`approval-resolved` 事件（决策值 + 时间）是唯一裁决；冲突双方都以此收敛。

**场景 2：桌面已结束 run，移动端仍在审批**

- 桌面 run 状态机已到终态（completed/failed/cancelled）→ `transition` 直接 `TerminalImmutable`（`crates/orchestrator/src/run.rs:345-347`）→ 命令返回 `stale`；
- 移动端收到 `run-terminal` 事件（白名单必同步，7.3）后，自动把该 run 的待办标记为「已失效」并从待办区移除（或置灰展示「run 已结束」）；
- 竞态窗口：命令在移动端尚未收到 run-terminal 时发出 → 桌面端 `stale` 拒绝兜底；**两端语义一致：终态优先**。

**场景 3：移动端离线提交的审批，上线后发现 run 已终态/审批已处理**

- 队列元素逐条提交（6.3），每条独立获得 accepted / stale / conflict / not-found；
- 已处理（conflict）→ 本地待办收敛为桌面返回的既有决策；
- 已终态（stale）→ 丢弃并提示「处理时 run 已结束」；
- **不自动重试 stale/conflict**（避免用户看到「拒绝成功」的假象后跑又被拒绝的反直觉体验）。

**场景 4：会话在移动端离线期间被删除**

- FK 级联（`schema.rs:141-149`）事件随之删除；移动端投影中的会话成为幽灵；
- 对账（6.5）时以投影（bootstrap 的会话集合）为准：本地会话不在权威集合 → 标记「已删除」，清理本地投影与游标（5.4.4 细则）。

**场景 5：移动端重复提交（网络重试/双击）**

- 幂等键（5.3）兜底；桌面返回首次结果；移动端队列把「发送成功（accepted）」与「超时重试」区分开（6.3 队列状态机）。

**场景 6：审批过期（approval-expired 语义）**

- 桌面侧到期（如有 TTL 机制）落 `expired` 决策的 approval-resolved 事件；移动端待办据此自动失效；
- 移动端侧离线超时（6.4 TTL）自行置灰——移动端过期仅是**展示层**，桌面在收到命令时仍以权威状态为准（若桌面未过期，移动端已置灰的待办仍可被桌面接受，属可接受偏差：移动端过期展示「可能已过期」而非「已过期」）。

### 5.5 冲突避免总原则

1. **不引入 CRDT / 合并器**：单一写者（桌面）+ 命令面（移动端）结构下，冲突被降级为「命令在权威端的校验拒绝」，不需要向量时钟、不需要合并策略；
2. **状态机是防冲突的第一道墙**：`run.rs:145-156` 的穷举转移表 + `TerminalImmutable`（`run.rs:345-347`）让非法转移在权威端直接失败；
3. **幂等键是第二道墙**：重复/重试被去重；
4. **事件流是收敛器**：所有端以同一事件流收敛到同一状态，不存在「各自为政的最后写者」；
5. **移动端永不覆盖**：移动端本地投影只由「权威数据（投影/事件）」写入，用户操作只产生「命令」，不直接改投影（除队列状态这种纯本地字段）。

---

## 6. 离线模型

### 6.1 离线可用数据

移动端离线时可展示（全部来自本地缓存）：

| 数据 | 离线可用性 | 展示策略 |
| --- | --- | --- |
| 会话列表（投影） | ✅ | 正常展示；标记 `lastSyncedAt` |
| run 状态摘要 | ✅ | 正常展示；加「已离线，数据截至 xx:xx」角标 |
| 审批待办 | ✅ | 正常展示与操作（进入动作队列）；过期展示见 6.4 |
| 审计摘要 | ✅（最近 N 条） | 正常展示 |
| 事件时间线 | ✅（已同步部分） | 时间线停在最后游标处 |

**离线不撒谎原则**：任何离线数据必须携带同步时间戳；UI 明确标注「离线 / 数据截至时间」，禁止离线数据被当作实时数据展示。

### 6.2 审批动作队列

移动端离线期间用户作出的审批决策进入**本地持久化队列**（与待办同库），元素：

```json
{
  "commandId": "m-01JQ...-3",
  "requestId": "req-...",
  "toolCallId": "call-...",
  "sessionId": "s-abc",
  "decision": "approved",
  "reason": "离线批准",
  "queuedAt": 1723200000000,
  "ttlMs": 86400000,
  "state": "pending",        // pending | sending | sent | permanent-failed | expired
  "lastError": null
}
```

队列为**每设备每请求至多一条**（`(requestId, decision)` 本地唯一）；重复决策覆盖同键元素。

### 6.3 队列元素状态机

```
pending ──上线/手动重试──▶ sending ──200 accepted──▶ sent（清除，等待事件确认）
                              │                        │
                              ├─409 stale/conflict──▶ permanent-failed（展示原因，不自动重试）
                              ├─404 not-found ──────▶ permanent-failed
                              ├─网络失败/超时 ──────▶ pending（退避重试）
                              └─到达 TTL ───────────▶ expired（置灰展示）
pending ──离线超 TTL──▶ expired
```

- `sending → sent` 后**不立即清除**：进入「确认等待」子状态（事件流中的 approval-resolved 或 run-terminal 到达后清除），因为 accepted 只代表桌面已接收执行，移动端仍可能随后收到 conflict/事件收敛结果——清除与否以事件流为准；
- 重试策略：指数退避（1s/4s/16s/60s 封顶），在应用前台/网络恢复事件驱动重试，不做无谓后台轮询；
- 队列上限：默认 200 条，超出按 FIFO 剔除最早且已完成（sent/expired）的元素，未完成元素永不剔除（数据安全 > 空间）。

### 6.4 到期失效（TTL）

- 审批待办的「有效期限」由桌面端权威语义决定（桌面 approval 有 TTL 时在 approval-requested 事件中携带或由策略接口下发）；
- 移动端本地 TTL 仅作展示层（防止「离线 3 天回来点一个早已过期的审批」）：
  - 默认 TTL 24 小时（用户可配置 1h/24h/7d/不过期）；
  - 到 TTL 的元素 UI 置灰 + 「可能已过期」，**仍在队列中**（因为桌面可能并未过期，命令仍有机会被接受——见 5.4 场景 6 的偏差容忍）；
  - 移动端绝不自行产生「expired 决策」命令（expired 决策只能由桌面权威产生并落 approval-resolved 事件）；
- run 终态到达（run-terminal 事件）是**即时失效**源：不等 TTL，直接标记失效。

### 6.5 上线对账（Reconciliation）

重连/上线的对账流程（与 4.7 主流程的步骤 2 衔接）：

1. **投影对账**：拉 bootstrap 投影（会话索引/run 摘要/待办/审计），与本地 diff：
   - 本地有、权威无 → 会话已删除 → 清理本地投影 + 游标 + 队列中该会话的未发送命令（标记 not-found 候选，提交时由桌面裁决，不主动丢弃——保守）；
   - 权威有、本地无 → 全新会话 → 直接写入投影 + 初始化游标（0 或快照 max）；
   - 双方有但字段不同 → 以权威为准覆盖（投影是低冲突数据，桌面覆盖语义无风险）；
2. **游标对账**：逐会话比较 `cursor` 与权威 `max_sequence`：
   - `cursor < max` → 增量补齐；
   - `max - cursor > 重建阈值`（默认 5000 事件，可配）→ 该会话走快照重建（4.3 候选 3 的降级层）；
3. **队列对账**：逐条提交（6.3 状态机）；提交完成后刷新待办（权威待办 = 未 resolved 的 approval-requested，服务端派生）；
4. **审计对账**：本地审计摘要落后 → 按游标补齐；摘要数量超过本地上限（10.4）→ 裁剪旧条目，保留最新；
5. **留痕**：对账发现的分歧（删除会话、命令被拒、快照重建）全部写入移动端本地日志（参考桌面前端「降级留痕」哲学，`sessionRustDb.ts:743-751`），不静默。

**对账幂等**：对账可重复执行（用户多次重连），每次都是「以权威为准的收敛」，无副作用累积。

### 6.6 移动端生命周期与省电策略

离线模型必须与移动端操作系统生命周期配合（iOS/Android 的前台/后台/终止
三态）：

| 生命周期态 | 同步引擎行为 | 队列行为 | 推送行为 |
| --- | --- | --- | --- |
| 前台活跃 | WS 长连接 + 推送触发拉取 + 30s 兜底刷新 | 立即发送 | 直接渲染通知为 UI 状态 |
| 前台闲置（>2min） | 保留 WS；兜底刷新降频至 60s | 照常 | 照常 |
| 后台（<30s 窗口） | 暂停增量拉取；保留待发命令清理 | 不主动重试 | 系统推送唤醒 |
| 后台长驻/挂起 | 全部暂停；依赖系统推送 | 冻结 | 系统推送负责唤醒 |
| 被终止 | 无状态（本地库为最后快照） | 本地持久化队列保留 | 系统推送仍可达（如配置） |

要点：

1. **队列持久化**：审批动作队列必须落本地库（6.2），应用被终止不丢——这是
   「离线模型」的硬底线；
2. **发送时机**：命令发送只在「前台 + 在线」执行；后台窗口只做「标记可发送」，
   不抢后台预算（移动端平台对后台网络有强限制）；
3. **省电**：WS 长连接空闲时发心跳（30s）；心跳失败 3 次即断线转轮询/推送
   兜底，避免无效重连；
4. **唤醒语义**：系统推送到达 → 应用拉起（或局部唤醒）→ 执行「增量补齐 +
   队列发送」两步，完成后回到后台（拉取量受 10.3 分页控制，秒级完成）。

### 6.7 设备更换、重装与多设备

| 场景 | 行为 |
| --- | --- |
| 移动端重装（同设备） | 本地库清空 → 走首次引导（bootstrap 全量，4.7 步骤 1）；游标从 0 重建；队列清空（旧命令失效——未确认的离线审批重新提交需用户确认，不自动恢复） |
| 设备更换 | 新设备重新配对（设备密钥交换，7.6）→ 引导全量；旧设备登出时由桌面吊销其推送订阅 |
| 多移动设备同时在线 | 每设备独立游标、独立队列；审批命令的幂等键带 `deviceId`，冲突收敛规则（5.4 场景 1）与设备数无关——桌面单一权威保证多设备收敛到同一事件流 |
| 设备离线 30 天 | 各会话游标落后超限 → 对账触发快照重建（6.5 步骤 2）；期间产生的审批由其它设备/桌面处理，本设备待办以权威为准刷新 |

---

## 7. 数据裁剪与隐私

### 7.1 敏感字段盘点

按事件类型盘点负载中可能含敏感内容的字段：

| 事件 | 字段 | 敏感度 | 说明 |
| --- | --- | --- | --- |
| message-start / message-end | `message.blocks[].text` / `.thought.text` | 🔴 高 | 对话全文、思考链 |
| message-start / message-end | `message.blocks[].tool-call.input` | 🔴 高 | 工具入参（可能含文件路径、内容、命令） |
| message-start / message-end | `message.blocks[].tool-result` | 🔴 高 | 工具输出全文（命令 stdout / 文件内容） |
| approval-requested | `request.parameters` | 🔴 高 | 审批请求参数包（`conex-types/events.rs:194-218`） |
| approval-requested | `request.summary` / `reason` | 🟡 中 | 摘要含上下文描述 |
| security-audit | `targets` / `impact` | 🟡 中 | 路径与文件统计（可接受，但用户可关） |
| task-failed | `tail` | 🔴 高 | 最后 20 行日志（`conex-types/events.rs:704-715`） |
| tool-start / tool-end | `call.input` / `result.output` | 🔴 高 | 工具调用参数与输出 |
| provider-diagnostic / runtime-error | `error` / `diagnostic` | 🟡 中 | 诊断信息，可能含路径 |
| timer-fired / cron-fired | `prompt` | 🟡 中 | 注入的提示内容 |

### 7.2 裁剪策略：摘要 vs 全量

**默认全链路摘要化**：

| 字段类别 | 桌面→移动端 | 实现方式 |
| --- | --- | --- |
| 消息正文 text | 只传 `{messageId, charCount, firstN(200)}` | 事件负载重写（见 7.4） |
| thinking | 只传 `{hasThinking: bool}` | 重写删除 thought.text |
| tool 参数/输出 | 只传 `{toolName, callId, isError, outputHead(200)}` | 重写 |
| 审批参数 | 只传 `{toolName, summary, 参数键名白名单}` | 重写（审批**决策**不依赖参数全量） |
| 审计 | `targets` 截断（每目标路径截 120 字符，条目 ≤ 20）+ `impact` 保留 | 重写 |
| task 日志 | 不传（或 `tail 前 5 行`） | 重写 |
| 事件时间线 | 只传结构化字段，不传 payload 原文 | 重写 |

**裁剪点位置**（7.4）保证：移动端拿到的是「裁剪后事件」，桌面本地不受影响（本地仍是全量），隐私边界在**服务端出网处**，而非移动端本地（移动端本地不存全量，防止本地库被读取即泄露）。

### 7.3 事件类型白名单

移动端事件流只同步以下类型（其余类型即使落库也不下发）：

**必须同步（驱动状态与待办）**：

| 事件 | 用途 |
| --- | --- |
| agent-start / agent-end | run 生命周期时间线 |
| run-terminal | run 终态（待办即时失效的关键事件） |
| run-interrupted | 桌面重启打断审计（`crates/orchestrator/src/restore.rs:55`）；【裁决修正】AU1 P2-8 复核结论：`RUN_INTERRUPTED_EVENT` 真实存在于 restore.rs:55，但**不在 41 AgentEvent 变体表内**（独立审计事件），保留在白名单不触发 registry_drift |
| approval-requested / approval-resolved | 审批待办与决策收敛 |
| security-audit | 审计摘要 |
| task-started / task-completed / task-failed / task-killed | 任务状态（推送通知源） |
| subagent-started / subagent-ended | 子代理状态投影 |

**可选同步（run 详情时间线，默认开启）**：

| 事件 | 用途 |
| --- | --- |
| turn-start / turn-end | 轮次时间线 |
| tool-start / tool-end | 工具活动时间线（负载裁剪后） |
| message-end | 消息终态 + 摘要 |
| context-compression-start / context-compression-end | 压缩事件（`SessionContextMeta` 派生展示） |

> 【裁决修正 2】AU1 P1-2 已按 M6 §5.0/§5.1（消息真源）收缩本表：
> **message-start / tool-batch-start / tool-batch-end / tool-input-repaired /
> checkpoint-created / checkpoint-restored 移出可选同步**（M6 不同步清单），
> 原「可选 13 类」现为 8 类；必须 13 类 + 可选 8 类 = 21 类，其中
> run-interrupted 为非 41 变体的独立审计事件，其余 20 类与 M6 同步面逐一对应。

**不同步（Delta/Soft 或与移动端职责无关）**：message-delta、subagent-event（progress/message/tool）、task-output、task-heartbeat、task-suspicious、timer-fired、timer-cancelled、cron-fired、provider-diagnostic、runtime-error、runtime-steering、runtime-intervention-required、cache-stats-updated、cache-waste-alert、cold-cache-warning、message-start、tool-batch-start、tool-batch-end、tool-input-repaired、checkpoint-created、checkpoint-restored（与 M6 §5.0 不同步清单一致）。

> 白名单在**同步服务端**配置（单一位置），移动端不按类型二次过滤（只按 `event_type` 字符串转发）；白名单变更通过版本化配置下发（见 9.6）。

### 7.4 负载重写（Redaction）设计

- 位置：桌面 sync 服务的事件查询路径（服务端），对 `query_events` 结果逐条执行「类型 → 重写规则」；
- 实现形态：解析 payload JSON（`StoredEvent.payload`，`crates/conex-db/src/events.rs:124-131`），按规则删除/截断字段后重新序列化；
- 规则表独立于白名单（`redact_rules: HashMap<event_type, RedactSpec>`），与事件注册表（`contracts/engine-events.json`）同源演进——新增事件类型必须登记重写规则（否则默认「全删」fail-closed）；
- **fail-closed 原则**：无重写规则的事件类型 → 不下发正文，只发 `{type, sequence, eventType}` 元组（宁可少数据，不可泄数据）；
- 审批参数重写对「决策」无影响：移动端批准/拒绝只需要 `requestId / toolCallId / summary / 工具名`，不需要参数全量——**决策信息与参数信息解耦**是审批可裁剪的关键设计。

### 7.5 用户可配置同步粒度

三档（默认中档），配置存桌面（session_meta，随会话同步给移动端，或存移动端本地——建议双端各存一份，桌面为权威）：

| 档位 | 投影 | 事件流 | 摘要深度 | 隐私取向 |
| --- | --- | --- | --- | --- |
| 轻量（通知 + 待办） | 会话索引 + run 状态 + 待办 | 仅 approval / run-terminal / security-audit | 无消息摘要 | 最保守 |
| 标准（默认） | 全投影 | 白名单全开（裁剪后） | 消息首 200 字符、工具输出首 200 字符 | 平衡 |
| 完整 | 全投影 | 白名单全开 | 消息首 2000 字符、审计路径全量 | 便利优先 |

**隐私红线（任何档位都不可越过）**：

- 完整 thinking 内容永不同步；
- 工具参数/输出超过摘要上限的部分永不同步（即使「完整」档也不传全量文件内容）；
- 如需「完整文件内容查看」，走独立的一次性授权按需拉取（非本设计范围，注明为后续增强）。

### 7.6 安全传输与存储

- 传输：TLS（移动端 ↔ 桌面 sync 服务；若经公网中转则端到端加密，密钥由用户设备配对时交换）；
- 移动端本地：事件投影存本地库（系统级加密存储，如 iOS Keychain/Android Keystore 包裹的 SQLCipher）；敏感摘要字段默认不落盘纯文本之外的额外副本；
- 剪贴板/截图防护由移动端 UI 层负责（本文不展开）。

### 7.7 安全模型与威胁分析

同步通道引入了新的攻击面，本节做威胁枚举与缓解（信任模型：桌面为根，
移动端为需配对的半信任终端，传输层为不可信网络）。

| # | 威胁 | 影响 | 缓解 |
| --- | --- | --- | --- |
| T1 | 未授权设备接入同步接口 | 读取会话/审计摘要（隐私泄露） | 设备配对（一次性码交换 + 密钥派生）；sync 服务只接受已配对设备标识（`deviceId` 签名）；未配对返回 401 |
| T2 | 重放攻击（截获命令重新提交） | 审批被重复执行 | 命令幂等键（`clientCommandId`，5.3）+ 时间窗校验（命令时间戳偏差 > 5min 拒绝） |
| T3 | 事件流投毒（伪造增量事件） | 移动端展示虚假状态 | 事件流带服务端签名（HMAC 或 TLS 通道即信任）；移动端**只消费不解释**未登记字段（fail-closed，7.4） |
| T4 | 敏感字段经推送泄露 | 审批参数/输出进系统推送 | 推送负载只含白名单摘要（10.5 红线）；裁剪在服务端出网处（7.2） |
| T5 | 移动端本地库被读取 | 摘要数据泄露 | 系统级加密存储（7.6）；敏感字段不落盘额外副本 |
| T6 | 中间人截获传输 | 明文数据泄露 | 全链路 TLS；公网中转场景端到端加密（7.6） |
| T7 | 恶意命令（伪造拒绝/批准他人请求） | 审批误判 | 命令签名（移动端私钥签 `clientCommandId + requestId + decision`，桌面验签）；配对此批准 |
| T8 | 同步服务 DoS（拉取风暴） | 桌面资源耗尽 | 每设备限流（429 + 退避，4.9.5）；`limit` 上限服务端强制（≤500/批） |
| T9 | 命令语义混淆（把 expired 当 approved 提交） | 非法决策落库 | 决策枚举服务端白名单（`approved/denied/expired`，`crates/conex-types/src/events.rs:220-232`），非枚举值 422 拒绝 |

**审计责任**：审批命令（含设备来源、决策、原因）经 `approval-resolved` 事件
的 `request_id` / `metadata` 字段（`crates/conex-types/src/events.rs:487-495`）
落库——远程审批与本地审批同一条审计链，**移动端审批不产生独立审计旁路**。

---

## 8. 一致性级别

### 8.1 一致性分级框架

| 级别 | 定义 | 适用 |
| --- | --- | --- |
| L0 最终一致 | 数据最终收敛，中间状态可为任意旧值 | 会话索引、run 状态摘要、事件时间线、审计摘要 |
| L1 读己之写 | 提交方在提交后能读到自己的写入 | 审批命令（移动端提交后收到确认） |
| L2 单调读 | 读到的数据只前进不后退 | 逐会话游标（绝不回退）、run 状态（不倒退） |
| L3 强一致 | 读到的永远是最新已提交值 | 审批决策的权威判定（桌面本地） |

### 8.2 各类数据的级别矩阵

| 数据 | 级别 | 达成手段 | 用户可感知的偏差 |
| --- | --- | --- | --- |
| 会话列表 | L0 | 投影通道 | 列表可能滞后数秒 |
| run 状态 | L0 + L2（单调） | 事件流（run-terminal 等） | 状态可能滞后，但不倒退 |
| 事件时间线 | L0 + L2 | 逐会话游标 | 时间线截断在游标处，补齐后完整 |
| 审批待办 | L0 + 即时失效 | run-terminal 事件 | 新待办延迟出现（推送缓解） |
| 审批决策 | **L1 + 桌面 L3** | 命令响应 + 事件确认（8.3） | 移动端确认前显示 pending，不做乐观假象 |
| 审计 | L0 | 摘要事件流 | 审计面板滞后 |

### 8.3 审批的关键路径一致性：桌面权威 + 移动端确认往返

审批是唯一「跨端写」操作，采用**两阶段确认**：

```
阶段一（提交）：移动端 → 桌面命令（POST /sync/approval/resolve）
            桌面校验 → 状态机转移（resolve_approval，run.rs:372-374）
            → 落库 approval-resolved 事件 → 响应 accepted
阶段二（收敛）：approval-resolved 事件经事件流回到移动端
            移动端以该事件为「事实确认」：
            - 事件携带的 decision 与本地提交一致 → 待办清除，完成闭环
            - 不一致（另一设备先到）→ 待办收敛为事件值，展示冲突
            - run-terminal 先到 → 待办失效
```

**为什么需要两阶段**：

- 仅阶段一（命令响应）不够：accepted 只代表桌面受理，若另一设备已决策（conflict 分支）或 run 已终态（stale），响应已明确拒绝——但「响应与事件之间的窗口」内移动端不能把待办当「已处理」；
- 仅阶段二（事件）不够：事件流是异步通道，可能延迟数十秒；用户需要即时反馈；
- **移动端 UI 语义**：提交后立即显示「已提交，等待确认」（中间态），收到阶段一 accepted + 阶段二事件匹配后显示「已批准/已拒绝」；收到 stale/conflict 显示拒绝原因。**绝不乐观显示「已批准」**——审批是高信任操作，宁可慢不可错。

### 8.4 一致性的工程保证清单

| 保证 | 机制 |
| --- | --- |
| 顺序保证（单调） | 逐会话游标只进不退（4.6）+ 服务端事件按 sequence ASC 返回（query_events 保证） |
| 不丢 | 游标持久化 + 未推进不回退 + 快照重建兜底 |
| 不重 | 应用幂等（(session_id, sequence) 去重键，4.6） |
| 最后写者收敛 | 权威端唯一写者 + 命令幂等键（5.3） |
| 观测一致性 | 移动端展示「数据截至时间」+ 待办 pending 语义（6.1、8.3） |
| 审计不可篡改 | 移动端只读审计事件；本地投影带来源 sequence |

### 8.5 弱一致下的 UI 语义（移动端）

- 列表页：顶部「已同步 xx:xx」；断网横幅；
- run 详情：状态角标带时钟图标（数据截至游标时间）；「同步中…」加载态在增量补齐时展示；
- 待办：`pending / 已提交待确认 / 已失效 / 冲突`四态 UI（8.3）；过期置灰（6.4）；
- 事件时间线：游标前的条目正常显示，游标后自动补齐（增量到达时插入，按 sequence 排序，天然单调）。

---

## 9. 与现有代码融合

### 9.1 query_events 复用为「移动端增量拉取」语义

现状：`LocalDb::query_events`（`crates/conex-db/src/events.rs:33-68`）已有 `after_sequence + limit` 分页，但：

- orchestrator 的 `Store` trait 只暴露无 limit 版本（`crates/orchestrator/src/persist.rs:168` `async fn query_events(&self, session_id: &str, after_sequence: u64)`）；
- 移动端同步服务需要：limit 分页 + 类型白名单过滤 + 负载裁剪 + 会话 latest sequence 查询。

融合方案（三个新面，全部在既有库之上，不动既有调用方）：

1. **新增 `query_events_paged`（或直接在 sync 服务内用 `LocalDb::query_events`）**：sync 服务直接持有 `LocalDb` 引用（同进程），调用 `query_events(session_id, after, Some(limit))`；
2. **新增「会话 latest sequence」查询**：`SELECT MAX(sequence) FROM events WHERE session_id = ?`（可用既有 `reserve_sequence` 的 `session_sequence` 表加速：`session_sequence.next_sequence - 1` 即 latest，`crates/conex-db/src/events.rs:72-99`——注意该表在有空洞时 next-1 仍是正确的 latest，因为取号单调）；
3. **过滤与裁剪在 sync 服务层**（不污染 conex-db）：白名单（7.3）+ 重写规则（7.4）是纯服务端策略。

### 9.2 restore 重放语义 → 移动端「应用侧重放」映射

restore.rs 的增量重放（`crates/orchestrator/src/restore.rs:696-745`）与移动端事件应用的映射：

| restore.rs 概念 | 移动端对应 |
| --- | --- |
| `StateSnapshot.last_sequence` / `session_last_sequence`（`restore.rs:302-309`） | bootstrap 响应携带的逐会话 `max_sequence`（游标初值） |
| 快照会话 `base = session_last_sequence[sid]`、派生会话 `base = 0`（`restore.rs:711-727`） | 已缓存会话 `base = cursor`、新会话 `base = 0` |
| 增量拉取 `store.query_events(&session_id, base)`（`restore.rs:728`） | `GET /sync/events?after=cursor` |
| 重放容错（载荷损坏跳过不中断，`restore.rs:729-743`） | 移动端应用层坏事件跳过 + 本地日志留痕（不中断同步） |
| 快照损坏回退备份（`restore.rs:438-453`） | 本地投影损坏 → 清空该会话重拉（移动端无备份轮转，重建成本低） |
| 未知字面量保真（`restore.rs:781-794`，裁决 D3） | 移动端对未知 `event_type` / 未知状态字面量**透传保真**（`RunStatus::Unknown` 同理，`crates/conex-db/src/runs.rs:21-35`），不做静默改写 |

**关键移植点**：逐会话锚点语义（P1-1）必须原样移植——**全局 max 的粘性丢失教训（`restore.rs:713-716` 注释）在移动端同样成立**。

### 9.3 审批状态机融合：移动端审批如何进桌面审批链

现状：审批的权威执行面是 `RunHandle`（`crates/orchestrator/src/run.rs`）：

- `request_approval`（`run.rs:366-369`）：引擎侧挂起，`running → awaiting-approval`；
- `resolve_approval`（`run.rs:372-374`）：恢复，`awaiting-approval → running`；
- 事件侧：`approval-requested`（`crates/conex-types/src/events.rs:479-484`）与 `approval-resolved`（`events.rs:487-495`）经 `EventQueue` 落库（`crates/orchestrator/src/events.rs:161-207`）。

融合设计：

1. sync 服务收到 `POST /sync/approval/resolve` → 定位 `RunHandle`（或经 orchestrator 的 run 管理器暴露的 `resolve_approval(run_id)` 接口）→ 调用既有转移；
2. 校验（5.3）在 sync 服务层完成，之后**唯一写路径**是 `RunHandle::resolve_approval`（复用状态机，不新增审批逻辑）；
3. `approval-resolved` 事件的产生由既有 `EventQueue` 负责（决策来源由命令链路注入，事件结构零改动——`events.rs:487-495` 的 `request_id` 兼容字段正好承载 `requestId`，`metadata` 字段可承载 `deviceId/reason` 审计信息，`PermissionDecision`（`conex-types/events.rs:51-59`）的 `metadata` 同构）；
4. 移动端待办派生 = 白名单事件配对（3.4）：`approval-requested` 未配对的 `request.id` 即待办；配对键 `approval-resolved.tool_call_id`（`events.rs:489`）与 `approval-requested.request.tool_call_id`（`events.rs:201`）对齐。

**结论：移动端审批 = 既有状态机的远程控制面，不新增审批状态机**。

### 9.4 审计落库融合

- 审计的事实源是 `security-audit` 事件（`crates/conex-types/src/events.rs:559-577`，`Critical` 必达落库）；
- 桌面审计面板消费方式（现为前端 EventRouter）与移动端审计摘要消费方式一致：**从事件流投影**；
- 融合点：sync 服务的审计接口（`GET /sync/audit?session_id=...&after=...`）= 白名单（security-audit）+ 重写（7.2 审计行）之上的查询；
- 审计的删除/保留策略：跟随 `events` 表生命周期（会话删除级联删），移动端本地审计摘要按上限裁剪（10.4），**裁剪只影响移动端本地视图，不影响桌面审计权威**。

### 9.5 事件背压分级复用

- 同步优先级可直接用 `event_backpressure`（`crates/conex-types/src/events.rs:867-893`）：
  - `Critical`（审批/终态/审计/任务终态/子代理终态）→ 同步**优先队列**（推送通知也以此为触发源）；
  - `Soft`（subagent message/tool、task-suspicious、timer-cancelled）→ 同步普通队列（如参与白名单）；
  - `Delta`（message-delta 等）→ 不同步；
- 该函数「静态可判定」（`events.rs:866-867` 注释）——移动端同步优先级不需要运行时判断逻辑，编译期枚举即可。

### 9.6 新增组件（sync 服务）的放置与依赖

新组件建议：`crates/sync-server`（or 并入现有 daemon 的 `apps/agent-workbench/src-tauri` 侧）：

```
crates/sync-server/
├─ projection.rs   # 通道 A：会话索引/run 摘要/待办/审计 投影查询（读 conex-db + 事件流派生）
├─ events.rs       # 通道 B：增量事件接口（query_events + 白名单 + redact）
├─ approval.rs     # 命令面：POST /sync/approval/resolve（校验 + 幂等 + 调 RunHandle）
├─ redact.rs       # 负载重写规则表（7.4）
├─ push.rs         # 通道 C：通知（WS 订阅 + 推送触发）
└─ policy.rs       # 用户粒度配置（7.5）读取与下发
```

依赖关系：`conex-db`（LocalDb 直连）+ `conex-types`（事件类型/审批决策）+ `orchestrator`（RunHandle 的审批执行面，只经公开接口调用，不触碰内部状态）。

**幂等键存储**：桌面端 `session_meta`（`crates/conex-db/src/sessions.rs:166-213` 的 `set_session_meta` / `update_session_meta`）或专用表 `sync_commands(command_id PRIMARY KEY, request_id, decision, result_json, created_at)`（建议专用表，写入频繁 + 查询语义独立，且不污染 `session_meta` 的 key-value 面）。

### 9.7 前端双轨持久化模式对移动端的借鉴

| 桌面前端模式 | 移动端借鉴 |
| --- | --- |
| 批次版本戳 CAS（`sessionRustDb.ts:705-752`、`1134-1150`） | 命令幂等键（5.3）——同一防重思路跨端复用 |
| 写串行队列（`sessionRustDb.ts:1115-1165`） | 移动端命令发送串行化（本地队列 6.3 天然串行） |
| 降级戳单向修复（`sessionRustDb.ts:986-1020`） | 离线队列「sent 后等事件确认」（6.3）——同构的「写入未确认则留痕修复」哲学 |
| LS 镜像 + 截断标志（`sessionPersistenceTypes.ts:22-28`） | 移动端本地库容量裁剪 + 留痕（10.4） |

### 9.8 明确不改动的既有代码面

- `conex-db` 的 events/sessions/runs 表结构：**零改动**（新面全部在 sync-server 层）；
- `orchestrator` 的 `Store` trait / `EventQueue` / `RestoreManager`：零改动（sync-server 只消费公开接口）；
- 前端双轨持久化：零改动；
- `conex-types`：事件结构零改动；如需「决策来源」审计字段，走既有 `ApprovalResolved.request_id` / `metadata` 可选字段（`events.rs:487-495`），不新增必填字段。

---

## 10. 性能与带宽

### 10.1 事件速率估算

**持久化事件产生率**（`EventQueue` 落库子集，`crates/orchestrator/src/events.rs:161-207`）：

| 场景 | 事件类型 | 单轮 turn 数量 | 全 run 数量（16 轮上限，`DEFAULT_MAX_TURNS`，`crates/conex-types/src/session.rs:9`） |
| --- | --- | --- | --- |
| run 生命周期 | agent-start / agent-end / run-terminal | 0-2 | ~3 |
| 轮次 | turn-start / turn-end | 2 | ~32 |
| 消息 | message-start / message-end | 2-4 | ~32-64 |
| 工具 | tool-batch-start/end + tool-start/end | 2-8 | ~32-128 |
| 审批 | approval-requested / approval-resolved | 0-2 | 0-32 |
| 子代理 | subagent-started / subagent-ended | 0-2 | 0-32 |
| 压缩 | context-compression-start/end | 0-1 | 0-2 |
| 审计 | security-audit | 0-3 | 0-48 |
| 任务 | task-started/completed/failed/killed | 0-4 | 0-64 |
| **合计** | | **6-25** | **~100-400** |

**峰值速率**：工具密集轮（tool-batch + tool-end × N + 消息），单轮可在数秒内产生 10-20 个持久化事件 → **峰值 ~5-10 事件/秒**。`message-delta` / `task-output` 等高频增量不落库（`events.rs:48-58`、`conex-types/events.rs:876-879`），不进入同步通道——**事件表的「低频化」是带宽设计的第一红利**。

### 10.2 带宽预算

| 载荷 | 桌面→移动端（裁剪后） | 说明 |
| --- | --- | --- |
| 投影（会话索引 100 会话） | ~50-100 KB | 每会话 ~0.5-1 KB |
| run 摘要（每 run） | ~200 B | status/end_reason/cursor/时间戳 |
| 单事件（白名单 + 裁剪） | 0.2-1 KB | 摘要化后远小于原始（原始 tool-end 可达 10-100 KB） |
| 审批待办（每项） | ~300 B | toolName/summary/时间/请求方 |
| 审计摘要（每项） | ~300 B | operation/targets 截断/impact 计数 |

**估算**：活跃 run 全生命周期同步量 ~100-400 事件 × 0.5 KB ≈ 50-200 KB；增量轮询/推送间隔内的同步量 ~KB 级/分钟。原始数据（含消息全文/工具输出）相比是 10-100 倍差距——**裁剪是带宽的第一控制面**。

**传输压缩**：JSON + gzip（HTTP/WS 层统一压缩）；事件流 WS 帧批量（≤50 事件/帧）减少帧头开销。

### 10.3 批量拉取策略

- **分页**：`limit = 200`/批（与 `query_events` 的 limit 参数同构，`crates/conex-db/src/events.rs:33-68`）；响应含 `has_more`，游标未推进完持续拉取；
- **多会话聚合**：同步服务支持 `?sessions=s1,s2,s3&after={s1:128,s2:40,...}` 聚合查询（单请求多会话增量），减少往返；
- **推送触发拉取**：WS 推送只带 `{sessionId, newMaxSequence}` 元组，移动端按需拉取——推送是「唤醒」，不承载数据（4.3 通道 C 原则）；
- **退避**：网络错误指数退避（1s→60s 封顶）；空增量（`has_more=false`）后进入「等待推送/定时刷新」空闲态，不做忙轮询；
- **落后重建阈值**：`max - cursor > 5000` 或增量拉取连续 10 批 → 该会话降级快照重建（4.3）。

### 10.4 移动端存储上限与清理

| 本地数据 | 上限（默认） | 超限策略 |
| --- | --- | --- |
| 事件时间线（本地投影） | 每会话 2000 条 | 超限裁剪最旧（保留最近），游标不动（裁剪的是投影不是游标——重新同步无需回退） |
| 审计摘要 | 全设备 1000 条 | FIFO 裁剪 + 留痕 |
| 审批待办 | 200 条 | 已完成清除；未完成永不剔（6.3） |
| 会话投影 | 全量（体积小） | 无上限（~KB/会话） |
| 本地库总预算 | 50 MB 软上限 | 超限时优先裁事件时间线，再裁审计，最后提示用户「历史同步数据已裁剪」 |

**裁剪一致性**：投影裁剪不破坏游标单调性——游标只表示「消费到哪」，本地投影是「展示缓存」，二者解耦；用户重新打开被裁剪的旧时间线时按游标向前拉（补数据不重放）。

### 10.5 推送 vs 轮询

| 通道 | 触发 | 延迟 | 能耗 |
| --- | --- | --- | --- |
| WS 长连接（前台） | 事件推送 | <1s | 中 |
| 系统推送（后台） | 新审批/终态 | <5s | 低 |
| 定时刷新（兜底，前台闲置） | 30s | 30s | 低 |

- 前台：WS 订阅 + 推送触发拉取；
- 后台：系统推送（APNs/FCM），只发「有新审批/run 终态/任务完成」；
- 兜底：任何推送不可达场景（网络策略、后台限制）下，前台 30s 定时拉投影 + 游标补齐（与 4.7 步骤 3 同构）；
- **推送内容红线**：通知正文只含「工具名 + 会话标题」级别的摘要，敏感参数/输出绝不进推送负载（系统推送通道不可控）。

### 10.6 移动端本地数据模型（表结构草案）

移动端本地库（SQLite）为「游标 + 投影 + 队列」三块，与桌面 `conex-db` 结构
**刻意不同构**（移动端不需要事件表、消息表、代理表——只存展示面）。

```sql
-- 游标区（4.5/4.6：逐会话单调推进）
CREATE TABLE session_cursors (
    session_id        TEXT PRIMARY KEY,
    last_applied_seq  INTEGER NOT NULL,     -- 已应用最大事件序列
    app_source        TEXT NOT NULL,        -- 'bootstrap' | 'event-stream' | 'rebuild'
    updated_at        INTEGER NOT NULL
);

-- 会话投影（通道 A 缓存，桌面权威覆盖语义）
CREATE TABLE session_projection (
    session_id        TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    folder            TEXT NOT NULL,
    is_pinned         INTEGER NOT NULL DEFAULT 0,
    is_archived       INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL,
    message_count     INTEGER NOT NULL DEFAULT 0,
    max_sequence      INTEGER NOT NULL,     -- 投影时桌面 latest
    synced_at         INTEGER NOT NULL      -- 离线展示「数据截至」用（6.1）
);

-- run 摘要投影
CREATE TABLE run_projection (
    run_id            TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    status            TEXT NOT NULL,        -- RunStatus 字面量（未知值透传，9.2）
    end_reason        TEXT,
    cursor            INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    source_sequence   INTEGER               -- 最近一次更新的来源事件序列（幂等）
);

-- 审批待办（approval-requested 派生，未配对）
CREATE TABLE approval_inbox (
    request_id        TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    tool_call_id      TEXT NOT NULL,
    tool_name         TEXT NOT NULL,
    summary           TEXT,
    requester         TEXT,
    requested_at      INTEGER NOT NULL,
    source_sequence   INTEGER NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending',  -- pending|confirming|resolved|stale|conflict
    decision          TEXT,                 -- 收敛后的决策值
    resolved_at       INTEGER
);

-- 审批动作队列（6.2/6.3，持久化）
CREATE TABLE approval_queue (
    command_id        TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    tool_call_id      TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    decision          TEXT NOT NULL,        -- approved|denied|expired
    reason            TEXT,
    queued_at         INTEGER NOT NULL,
    ttl_ms            INTEGER NOT NULL,
    state             TEXT NOT NULL,        -- pending|sending|sent|permanent-failed|expired
    last_error        TEXT,
    retry_count       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (request_id, decision)
);

-- 审计摘要（白名单 security-audit 投影，上限裁剪）
CREATE TABLE audit_summary (
    sequence          INTEGER NOT NULL,
    session_id        TEXT NOT NULL,
    operation         TEXT NOT NULL,
    targets_json      TEXT NOT NULL,
    decision          TEXT NOT NULL,
    event_at          INTEGER NOT NULL,
    PRIMARY KEY (session_id, sequence)
);

-- 设备与配置
CREATE TABLE sync_meta (
    key               TEXT PRIMARY KEY,     -- device_id / server_url / granularity /
    value             TEXT NOT NULL         -- whitelist_version / last_bootstrap_at ...
);
```

**索引与约束**：

- `session_cursors.last_applied_seq` 只增不减（应用层约束 + 校验函数）；
- `approval_queue` 的 `(request_id, decision)` 唯一——同一请求同决策只留一条
  （6.2 覆盖语义）；
- `audit_summary` 以 `(session_id, sequence)` 主键——与应用幂等键（4.6）
  同构，重复事件插入冲突即跳过；
- 全部 `synced_at` / `updated_at` 列服务于「离线不撒谎」展示（6.1）。

### 10.7 本地缓存与索引策略

- **展示直读本地库**：所有列表页/详情页直接读本地表（无网络路径），网络只
  负责「拉新」——这是离线体验的第一设计（与桌面端「SQLite 主存」哲学一致，
  `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:4-9`）；
- **内存缓存**：会话列表（投影）与当前 run 摘要常驻内存（app 生命周期内），
  事件流到达时增量更新内存 + 异步落库；
- **懒加载**：用户进入 run 详情页时才初始化该会话事件时间线（若游标落后先
  补齐）；离开页面后时间线驻留本地库（下次秒开）；
- **索引**：`run_projection(session_id)`、`approval_inbox(state)`（待办角标
  查询）、`audit_summary(sequence)`（对账推进）建索引；
- **空间控制**：时间线投影按「每会话 2000 条 + 全库 50MB」双上限裁剪
  （10.4），裁剪只删展示行不动游标。

---

## 11. 测试

### 11.1 测试分层

| 层 | 位置 | 框架 | 覆盖 |
| --- | --- | --- | --- |
| 单元 | `crates/sync-server/src/**` | cargo test（沿用仓库 Rust 测试约定） | 游标逻辑、白名单、redact、命令幂等、队列状态机 |
| 集成 | sync-server 集成测试 | cargo test + 内存 LocalDb | 断线/重连、对账、并发审批（真实 SQLite 内存库） |
| 端到端 | 移动端 → sync-server 模拟器 | 移动端测试框架（按移动端实现组选型） | 全链路同步 + 命令闭环 |
| 回归 | 既有门禁 | `cargo test --workspace`（73 套件基线） | 确认 sync-server 不破坏既有面 |

### 11.2 一致性场景用例清单（必测）

| # | 场景 | 关键断言 |
| --- | --- | --- |
| T1 | 首次引导（bootstrap） | 移动端投影与桌面一致；游标 = bootstrap max_sequence |
| T2 | 增量拉取基本流 | 新事件按 sequence 顺序到达；游标单调推进 |
| T3 | 游标空洞（delta 占号） | 落库事件缺失序号（100,102）不报错；游标到 102；不重复应用 100 |
| T4 | 断线重连 | 断线期间的事件在重连后全部补齐；无重复、无丢失、无乱序 |
| T5 | 分页拉取（limit 命中） | 多页拼装后与全量一致；`has_more` 语义正确 |
| T6 | 落后重建 | 超过阈值 → 快照重建 → 游标重置 → 后续增量正确 |
| T7 | 双端并发审批（同请求不同决策） | 先到者生效；后到者 conflict；双方经 approval-resolved 收敛为同一值 |
| T8 | 桌面已终态，移动端审批 | 命令返回 stale；run-terminal 使本地待办失效 |
| T9 | 移动端离线审批 ×3 + 上线 | 队列逐条提交；accepted 生效；stale 丢弃并留痕 |
| T10 | 命令重试（网络重发） | 幂等键去重；第二次返回首次结果；不重复执行状态机转移 |
| T11 | 会话桌面删除，移动端离线 | 对账识别幽灵会话；清理投影/游标；队列命令被 not-found 裁决 |
| T12 | 未知事件类型透传 | 未知 `event_type` 不崩溃、不透传敏感字段（fail-closed 后只发元组） |
| T13 | 隐私裁剪 | message-end 的 thought/text 全文不出现于移动端任何同步面；审批 parameters 不出现 |
| T14 | 投影对账 | 本地与权威 diff 的所有分支（增/删/改）正确收敛 |
| T15 | 推送触发 | 推送通知到达后增量拉取闭环；通知负载无敏感字段 |
| T16 | 存储裁剪 | 超限裁剪后游标不动；重新同步不重放旧数据 |
| T17 | 一致性级别（读己之写） | 移动端提交命令后：先收到响应，随后收到匹配的 approval-resolved 事件 |

### 11.3 关键用例细化

**T7 并发审批（确定性竞态）**：

```
前置：桌面 run 处于 awaiting-approval；approval-requested 已落库。
步骤：
1. 桌面本地用户点「批准」（resolve_approval）→ 状态机转 running，approval-resolved(approved) 落库；
2. 同一毫秒级窗口，移动端提交「拒绝」命令（模拟并发飞行）；
3. 断言：sync 服务串行处理，后到命令校验「审批已 resolve」→ 返回 conflict(denied 不存在，existing=approved)；
4. 断言：approval-resolved 事件唯一（无第二条 resolved 事件）；runs.status = running；
5. 断言：移动端收到 conflict + approval-resolved(approved) → 本地待办收敛为 approved。
```

**T9 离线审批 + 对账**：

```
前置：移动端离线；待办含 A/B/C 三项。
步骤：
1. 用户离线批准 A、拒绝 B、批准 C → 队列 3 条 pending；
2. 离线期间桌面侧：A 已被桌面用户处理（denied）、B 所在 run 已终态（completed）；
3. 移动端上线 → 对账：
   - A 提交 → conflict（already resolved: denied）→ permanent-failed + 展示「已在桌面被拒绝」；
   - B 提交 → stale（run terminal）→ 丢弃 + 留痕；
   - C 提交 → accepted → 等待 approval-resolved(C, approved) 事件到达后清除；
4. 断言：本地待办最终 = 桌面权威待办集合；三条命令各得其所；本地日志含全部留痕。
```

**T3 游标空洞**：

```
前置：会话事件序列 1..5，其中 2、4 为 delta（未落库）。
步骤：
1. 移动端游标 = 0；
2. 拉取 after=0 → 得 [1,3,5]；
3. 断言：应用 1、3、5，游标 = 5；无任何「缺 2/4」的补拉行为；第二次拉取 after=5 → 空。
```

**T17 读己之写（两阶段确认）**：

```
前置：移动端在线。
步骤：
1. 提交命令（approved）→ 立即收到 accepted（含 resolvedAtSequence=132）；
2. 事件流后续收到 approval-resolved(seq=132, approved) → 闭环；
3. 断言：在步骤 2 之前 UI 保持「已提交待确认」；步骤 2 后变「已批准」；
4. 反例断言：桌面 approval-resolved 事件若先于命令到达（另一设备已处理）→ 移动端显示 conflict 而非 accepted。
```

### 11.4 测试基础设施要求

- sync-server 测试全部基于 `LocalDb::open_in_memory()`（`crates/conex-db/src/lib.rs:85-98`）——与既有单元测试同构，无需真文件库；
- 模拟时钟注入（命令 TTL、过期、退避逻辑）——队列状态机测试必须可控时间；
- 竞态测试沿用仓库既有 barrier/线程模式（参照 `crates/conex-db/src/agents.rs:743-782` 的 kill/spawn 交错测试范式）；
- 与既有门禁的关系：新增 crate 的测试并入 `cargo test --workspace`；**既有 73 套件基线不得回归**（sync-server 零改动既有代码面，见 9.8）。

### 11.5 协议与配置演进测试

| # | 场景 | 断言 |
| --- | --- | --- |
| E1 | 服务端白名单升版（新增事件类型） | 移动端按旧版本继续同步（未知类型不崩溃）；bootstrap 配置版本更新后新类型可见 |
| E2 | 移动端旧客户端访问新版 bootstrap | `schemaVersion` 兼容（缺省字段默认值，参考 `context.rs:45-47` 的 serde default 写法） |
| E3 | redact 规则 fail-closed | 未登记重写规则的事件类型只下发元组（type/sequence），正文不出网 |
| E4 | 设备吊销 | 吊销后该设备所有请求 401；推送订阅移除 |
| E5 | 命令时间窗（重放防护） | 时间戳偏差超窗的旧命令被拒（422） |
| E6 | 多设备并发拉取同一会话 | 各设备游标独立；服务端无共享可变状态（无锁或只读查询） |
| E7 | 大会话（10 万事件）落后重建 | 快照重建正确落游标；重建后增量续接无缝 |

### 11.6 移动端侧测试（按移动端实现组选型）

- **同步引擎**：bootstrap → 增量 → 对账 → 重建 全流程状态机测试（注入网络
  故障矩阵：超时/断连/乱序/重复响应）；
- **队列**：状态机全转移（6.3）+ 持久化（进程被杀后恢复）+ TTL；
- **展示层**：待办四态 UI、离线角标、「数据截至」文案、冲突收敛展示；
- **推送**：系统推送负载解析（无敏感字段断言）、唤醒后增量补齐闭环；
- **端到端**：真实桌面 daemon + 模拟移动端双端联调（T1-T17 抽 5-8 条做
  冒烟回归）。

---

## 12. 开放问题与决策清单

| # | 问题 | 现状 | 建议裁决 |
| --- | --- | --- | --- |
| O1 | sync 服务部署形态：独立进程 vs daemon 内嵌模块 | 未定 | 建议先内嵌 daemon（`apps/agent-workbench/src-tauri` 侧），零部署成本；后续独立进程可选 |
| O2 | 移动端↔桌面连接方式：局域网直连 vs 云端中转 | 未定（涉 D 系列其它文档） | 本文协议面与拓扑无关；中转时启用端到端加密（7.6） |
| O3 | 推送通道实现：APNs/FCM vs 自建 WS | 未定 | 建议系统推送做后台唤醒 + 自建 WS 做前台流 |
| O4 | approval TTL 的桌面权威实现是否存在 | 桌面现无 TTL（`run.rs:146-156` 无 expired 转移事件） | 如需「审批过期」权威语义，后续版本在桌面状态机扩展（本次只做移动端展示层 TTL，6.4） |
| O5 | `task-output` 等 Delta 事件的实际落库行为与 `event_class`（`crates/orchestrator/src/events.rs:48-58`）的分类差异需实现期复核 | 已注 | 复核结论只需影响白名单（7.3），不影响模型骨架 |
| O6 | 命令幂等键存储表（sync_commands）的保留策略 | 建议保留 30 天 | 防重放窗口大于离线 TTL 上限即可 |
| O7 | 「完整消息正文按需拉取」是否纳入 v1 | 建议 v2 | v1 只同步摘要；按需拉取接口作为扩展点预留 |
| O8 | 移动端「关注会话集合」默认策略 | 全部 + 活跃优先 | 见 4.8 |
| O9 | 命令签名（T7 威胁缓解）的实现形态 | 建议 HMAC 设备密钥 | 配对时派生设备密钥；验签在 sync 服务（不引入 PKI） |
| O10 | 移动端本地库加密强度 | SQLCipher 默认 | 摘要数据泄露风险可接受时可用系统明文库 + 加密摘要字段，实现期定 |
| O11 | 推送通道供应商（APNs/FCM/自建） | 见 O3 | 推送负载协议与供应商无关（4.9.4） |

---

## 13. 参考代码索引

| 主题 | 位置 |
| --- | --- |
| events 表 v1 `UNIQUE(session_id, sequence)` | `crates/conex-db/src/schema.rs:17-25` |
| events 表 v5 复合主键 + FK CASCADE | `crates/conex-db/src/schema.rs:141-149` |
| session_sequence 表 | `crates/conex-db/src/schema.rs:184-187` |
| runs 表（含 usage 列） | `crates/conex-db/src/schema.rs:151-169` |
| sessions 表（v5 索引投影） | `crates/conex-db/src/schema.rs:123-139` |
| `append_event` | `crates/conex-db/src/events.rs:8-27` |
| `query_events`（after_sequence + limit） | `crates/conex-db/src/events.rs:33-68` |
| `reserve_sequence` / `seed_sequence` | `crates/conex-db/src/events.rs:72-121` |
| `StoredEvent` 行 | `crates/conex-db/src/events.rs:124-131` |
| `RunStatus`（含 AwaitingApproval / Unknown） | `crates/conex-db/src/runs.rs:21-53` |
| `StoredRun` / `PendingInput` | `crates/conex-db/src/runs.rs:88-108` |
| `update_run_status` | `crates/conex-db/src/runs.rs:143-171` |
| `list_sessions` / `upsert_session_entry` / `set_session_meta` | `crates/conex-db/src/sessions.rs:37-83` / `86-128` / `166-213` |
| 孤儿清理（宽限期 + 豁免） | `crates/conex-db/src/sessions.rs:238-319` |
| 快照结构（last_sequence / session_last_sequence） | `crates/orchestrator/src/restore.rs:289-320` |
| 恢复主流程 | `crates/orchestrator/src/restore.rs:559-767` |
| 逐会话增量重放（P1-1） | `crates/orchestrator/src/restore.rs:696-745` |
| in-flight 判定（awaiting-approval 等） | `crates/orchestrator/src/restore.rs:776-794` |
| `EventQueue::push`（取号 + 落库分流） | `crates/orchestrator/src/events.rs:161-207` |
| `event_class`（持久化分流） | `crates/orchestrator/src/events.rs:48-58` |
| `Store` trait（query_events 无 limit 版） | `crates/orchestrator/src/persist.rs:152-170` |
| run 状态机转移表（审批行） | `crates/orchestrator/src/run.rs:146-156` |
| `transition` / `TerminalImmutable` | `crates/orchestrator/src/run.rs:340-364` |
| `request_approval` / `resolve_approval` | `crates/orchestrator/src/run.rs:366-374` |
| `finalize`（终态收口） | `crates/orchestrator/src/run.rs:430-473` |
| `AgentEvent` 41 事件 / 信封 | `crates/conex-types/src/events.rs:305-782` / `922-1013` |
| `PermissionRequest` / `ApprovalDecision` | `crates/conex-types/src/events.rs:194-232` |
| `SecurityAudit` | `crates/conex-types/src/events.rs:559-577` |
| `TaskFailed`（tail 日志） | `crates/conex-types/src/events.rs:704-715` |
| `event_backpressure` 分级 | `crates/conex-types/src/events.rs:867-893` |
| `AgentMessage` 全文载荷 | `crates/conex-types/src/message.rs:32-50` |
| `SessionContextMeta` | `crates/conex-types/src/context.rs:46-61` |
| 会话状态机 8 态 / `DEFAULT_MAX_TURNS` | `crates/conex-types/src/session.rs:9` / `15-34` |
| 前端写队列 + 批次版本戳 CAS | `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:1115-1165` |
| 前端 saveSessionBody CAS | `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:705-752` |
| 前端降级戳单向修复 | `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:986-1020` |
| 前端 LS 键 / agents 软上限 | `apps/crish-desktop/src/api/session-persistence/sessionPersistenceTypes.ts:5-28` |

---

## 14. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-08-09 | v0.1 | 初稿：同步范围 / 两级同步模型 + 命令 + 通知 / 桌面权威边界 / 离线队列与对账 / 裁剪与隐私 / 一致性分级 / 代码融合面 / 带宽预算 / 测试清单 |
