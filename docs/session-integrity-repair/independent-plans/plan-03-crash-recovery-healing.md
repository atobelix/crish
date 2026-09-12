# 方案 03：冷启动恢复一致性与自愈强制收敛

## 一、方案全景与核心命题

### 1.1 核心问题诊断与现实断层

在分布式或本地进程模型中，进程意外崩溃（Daemon Restart、OS OOM Killer、机器断电或用户强制关闭）是不可避免的物理现实。系统重启后的“冷启动恢复”（Cold-Start Recovery）是保障会话生命周期不中断、数据不失真、状态机不卡死的关键防线。深入通读编排器（`crates/orchestrator`）、存储持久化（`crates/conex-db`）与核心循环（`crates/session-loop`）的一手源码后，暴露出当前架构中存在的三处严重一致性断层：

1. **悬挂孤儿工具调用（Hanging Orphan Tool Calls）造成协议崩塌**：
   在模型多轮对话执行流中，Assistant 角色在发出工具调用请求时，消息实体（携带 `AgentMessageBlock::ToolCall`）落库进入 `session_messages` 并发射 `message-end` 事件；随后循环进入工具执行阶段（`handleExecutingTools`）。若进程在工具执行期间、审批等待期间或工具结果落盘前发生崩溃，会话中将残留带有 `tool_calls` 的 Assistant 消息，但数据库中**永久缺失**对应的工具执行结果（`ToolResult` / `tool-end` 事件）。
   当会话在冷启动后被水合（`hydrate_history`）或由上层调用恢复时，主流大模型供应商协议（如 Anthropic、OpenAI）强制要求：**包含 `tool_use` / `tool_calls` 的 Assistant 消息后面必须紧跟对应的 `tool_result`**。缺失结果直接导致 API 报错（如 HTTP 400 `An assistant message with tool calls must be followed by tool messages responding to each tool call`），会话彻底损坏；同时前端 UI 工具卡片陷入永久加载等待（Spinning）。

2. **G-29 终态矛盾“只上报不修正，诚实滞留”的消极妥协造成持久性脑裂（Split-Brain）**：
   在 `crates/orchestrator/src/restore_manager.rs:178-195` 与 `restore_manager.rs:341-400` 中，现存的 G-29 终态矛盾对账机制存在严重的架构妥协。恢复流程的步骤 2 错误地将“runs 表作为权威数据源”，并在步骤 3 机械地将所有 `is_inflight` 的 run（包含 `running`、`completing` 等）就地打断为 `failed`（或 `cancelled`），写入 `run-interrupted` 审计事件。
   而在随后的步骤 3c（`reconcile_terminal_conflicts`）中，系统检查 `events` 表，发现事件流中实际已经完整发射并持久化了 `run-terminal`（例如 `terminal: "completed"`），暴露出“事件说已完成，记录说已失败”的尖锐矛盾。然而现有代码仅通过 `tracing::warn!` 打印日志并将其封装入 `RestoreOutcome.reconcile_conflicts`，采取“只上报不修正，诚实滞留”的消极态度，拒绝翻写 `runs` 表。这导致 `runs` 表与 `events` 表永久性脑裂，外部查询与 UI 呈现将一个实质已成功完成的任务报告为失败。

3. **多源恢复真理源缺乏统一权威裁决**：
   系统在恢复期存在四个潜在状态源：
   - 外部文件快照（`StateSnapshot`，存储在磁盘上的 JSON 快照与 `.prev` 备份）；
   - SQLite 业务物化表（`runs`、`session_messages`、`session_agents`）；
   - 权威事件流表（`events`，带全局连续 `sequence` 且外键级联的权威事实源）；
   - 进程内存缓存（`SessionHistoryCache`、`FlowScheduler` 运行时态）。
   当前恢复流程在快照与 DB 冲突时逻辑模糊：`restore_manager.rs:197-212` 组装会话记录时混合快照会话与 runs 派生会话，若快照携带的 `session_last_sequence` 高于数据库实际 `max_sequence`（例如数据库回滚或事务未落盘），增量扫描将产生错乱；若内存与快照发生冲突，缺乏以 `events` 表为绝对权威的单向重投影机制。

---

## 二、架构真理模型与单向强制收敛原则

### 2.1 事件溯源（Event Sourcing）作为唯一事实源（SSOT）

在恢复与自愈架构中，确立如下刚性真理等级序列（Truth Authority Hierarchy）：

$$\text{events 表（权威事件流）} \succ \text{runs / session\_messages 表（物化视图）} \succ \text{StateSnapshot（加速快照）} \succ \text{内存缓存}$$

- **`events` 表为唯一真理源（Single Source of Truth, SSOT）**：
  在 `crates/conex-db/src/schema.rs:147-160` 中，`events` 表由 `(session_id, sequence)` 构成联合主键，带有 `event_type`、`payload`、`run_id` 和毫秒级 `created_at`。事件流具备不可变性（Append-Only），记录了系统状态迁移的完整因果链。
- **`runs` 与 `session_messages` 为派生物化视图（Derived Materialized Views）**：
  `runs` 表记录当前状态（`status`、`end_reason`、`cursor`），`session_messages` 记录当前消息投影。物化视图允许因崩溃出现写入延迟或撕裂，但绝不具备独立于事件流的裁决权。
- **`StateSnapshot` 为纯粹的重放加速缓存（Performance Accelerator）**：
  快照文件仅用于避免无界事件流的全量重放开销。快照中的数据状态无条件服从 `events` 表的校验。一旦快照与 `events` 表发生矛盾，快照被判定为失效，系统无条件降级并以 `events` 表进行自愈重投影（Re-projection）。

### 2.2 单向强制收敛不变式（Unidirectional Convergence Invariants）

1. **零脑裂不变式（Zero Split-Brain Invariant）**：
   恢复阶段结束时，`runs.status` 必须与 `events` 表中对应 run 的终态记录实现 100% 严格一致。严禁存在“事件流显示完成，而 runs 记录显示失败”或“runs 记录完成，而事件流无终态”的未收敛状态。
2. **工具调用闭包完整性（Tool Call Closure Invariant）**：
   对任意已持久化的 Assistant 消息，若其包含 $N$ 个工具调用 $[C_1, C_2, \dots, C_N]$，则在恢复收敛后，事件流与消息视图中必须存在且仅存在相对应的 $N$ 个工具执行结果 $[R_1, R_2, \dots, R_N]$。对因崩溃未执行的工具，必须由自愈引擎强制合成带有 `ToolOutcomeUnknown` 语义的修复结果。
3. **消除消极滞留（No Passive Compromise Invariant）**：
   彻底废除 G-29“只报不修”逻辑。所有探测到的不一致状态必须在冷启动恢复阶段单向就地修正，修正过程必须在数据库事务或组提交内原子持久化，并产出结构化的修复审计条目。

---

## 三、核心设计一：冷启动孤儿工具调用自愈引擎

### 3.1 悬挂孤儿调用探测算法

在冷启动扫描过程中，`RestoreManager` 遍历待恢复的所有会话（包含快照会话与数据库中已存在的会话）。针对每一个会话执行孤儿调用扫描（`detect_orphaned_tool_calls`）：

```
+-------------------------------------------------------------------------+
|                       扫描最后 Assistant 消息                           |
|       (通过 store.query_events 反向检索 或 本地 session_messages 检索)   |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|                  提取 ToolCall 集合: { call_id }                        |
|        检查 Assistant 消息中的 AgentMessageBlock::ToolCall              |
+-------------------------------------------------------------------------+
                                    |
            +-----------------------+-----------------------+
            | call_set 为空                                 | call_set 非空
            v                                               v
     +--------------+                      +----------------------------------+
     | 无需自愈处理 |                      |   检索该 Session 之后的事件流    |
     +--------------+                      |   收集已存在的 ToolEnd/ToolResult|
                                           +----------------------------------+
                                                            |
                                                            v
                                           +----------------------------------+
                                           | 计算差异集:                      |
                                           | OrphanSet = ToolCalls - Results  |
                                           +----------------------------------+
                                                            |
                                    +-----------------------+-----------------------+
                                    | OrphanSet 为空                                | OrphanSet 非空
                                    v                                               v
                             +--------------+                      +----------------------------------+
                             | 闭包完整放行 |                      | 触发 ToolOutcomeUnknown 合成写入 |
                             +--------------+                      +----------------------------------+
```

1. **定位受检范围**：
   通过 `Store::query_events` 分页读取该会话最近的事件流，寻找最后一个 `message-end` 事件，且该事件的角色为 `assistant`（或从 `LocalDb::load_session_body` 中获取倒数第一条 `assistant` 消息）。
2. **提取调用契约**：
   解析该 Assistant 消息中的 `AgentMessageBlock::ToolCall(ToolCallBlock)`，收集所有的工具调用项：
   $$\mathcal{T}_{\text{declared}} = \{ (\text{call\_id}, \text{tool\_name}) \}$$
3. **计算已收口工具集合**：
   检索该 Assistant 消息序号之后发生的所有事件，筛选出事件类型为 `tool-end` 的记录：
   $$\mathcal{T}_{\text{resolved}} = \{ \text{call\_id} \mid \text{event\_type} == \text{"tool-end"} \}$$
4. **孤儿集判定**：
   计算差集：
   $$\mathcal{T}_{\text{orphan}} = \{ (\text{call\_id}, \text{tool\_name}) \in \mathcal{T}_{\text{declared}} \mid \text{call\_id} \notin \mathcal{T}_{\text{resolved}} \}$$
   若 $\mathcal{T}_{\text{orphan}} \neq \emptyset$，则触发强制合成修复流程。

### 3.2 `ToolOutcomeUnknown` 修复事件的合成与落库

对 $\mathcal{T}_{\text{orphan}}$ 中的每一个悬挂调用，自愈引擎在所属会话中合成标准的修复事件，并保证序列连续性与原子性：

1. **修复载荷规范（Repair Payload Specification）**：
   事件类型必须为标准 `tool-end`，对齐 `crates/conex-types/src/events.rs:480-491` 的 `AgentEvent::ToolEnd` 契约：
   - `session_id`: 目标会话 ID；
   - `batch_id`: 继承自当前 Run 或生成确定的修复批次标识 `repair-orphan-<run_id>`；
   - `timestamp`: 当前自愈发生的 UTC ISO8601 时间戳；
   - `attempt`: 显式标注为 `Some(1)`；
   - `result`: 结构化 `ToolBatchResult`：
     - `id`: 孤儿工具调用 ID（`call_id`）；
     - `tool_name`: 原工具名称（`tool_name`）；
     - `is_error`: **必须为 `true`**；
     - `duration_ms`: 记为 `0`；
     - `output`: `ToolOutput` 结构化对象：
       ```json
       {
         "text": "Execution outcome unknown: daemon/process terminated abnormally before tool completion.",
         "json": {
           "code": "ToolOutcomeUnknown",
           "reason": "daemon-crash-interrupted",
           "orphan_call_id": "<call_id>",
           "healed_at": "<ISO8601>"
         }
       }
       ```
2. **事件流追加（Event Stream Append）**：
   - 调用 `store.reserve_sequence(&session_id)` 或 `next_sequence(store, &session_id)` 获取单调自增的唯一序列号；
   - 调用 `store.append_event(&session_id, seq, "tool-end", &payload, Some(&run_id))` 将事件持久化入 `events` 表；
   - 推进当前恢复过程的 `last_sequence` 锚点。
3. **物化视图同步（Materialized View Sync）**：
   若底层为 `LocalDbStore`（`store.as_local_db()` 可用）：
   - 读取当前会话消息列表（`load_session_body`）；
   - 定位对应的 Assistant 消息，若其存在 `tool_calls_json`，则在 `tool_call_results_json` 中补齐该 `call_id` 的失败结果（包含 `output` 与 `isError: true`）；
   - 若系统采用 `AgentMessageRole::Tool` 消息形式承载结果，则向消息列表中追加一条由自愈引擎合成的 `Tool` 角色消息，包含 `AgentMessageBlock::ToolResult`；
   - 调用 `save_session_body_versioned`（CAS 方式）重写 `session_messages` 表，确保消息物化视图与事件流完全镜像对称。

---

## 四、核心设计二：终态矛盾单向强制收敛（彻底废除 G-29）

### 4.1 现存缺陷代码执行时序解构

现存代码 `crates/orchestrator/src/restore_manager.rs` 在处理恢复时的执行时序存在严重的“先盲目改写，后被动报错”逻辑缺陷：

```
[现存缺陷时序: restore_manager.rs:56-195]
1. store.query_runs() -> 获取所有 runs
2. 循环 runs: 只要 is_inflight(status) 为 true:
     -> 强制写入 update_run_status(Failed, "daemon-restarted")
     -> 强制写入 append_event("run-interrupted")
     -> 本地内存 run.status = Failed
3. reconcile_terminal_conflicts():
     -> 读取 events 表中的 run-terminal
     -> 发现 events 明确记录为 "completed"
     -> 发现 runs 记录已被刚刚置为 "failed"
     -> 矛盾形成!
     -> 仅执行 tracing::warn!("G-29 终态矛盾对账：只上报不修正")
     -> 将矛盾压入 outcome.reconcile_conflicts
     -> 结束 (留下持久性脑裂!)
```

这一消极妥协使系统在发生任何微小延迟或异步落盘窗口时，将已经成功收口的 Run 永久毁损为 Failed。

### 4.2 强制单向覆盖修正时序重构

彻底重构 `RestoreManager::restore` 阶段 2 与阶段 3 的执行逻辑，将时序颠倒为**“先检事件真理，再行状态决策，矛盾单向强制覆盖”**：

```
[重构后强制收敛时序]
1. store.query_runs() -> 获取数据库中现存 runs
2. 遍历每个 run:
     |
     +---> [步骤 A] 查询 events 表中该 run 的 "run-terminal" 事件:
     |     store.query_events_by_type(session_id, run_id, "run-terminal", 0, Some(1))
     |
     +---> [分支 1: events 表存在 run-terminal] -----------------------+
     |     权威结论: 该 Run 在崩溃前已合法完成收口!                   |
     |     提取事件中的终态字面量: E_status (completed/cancelled/failed) |
     |                                                                 |
     |     判断: run.status 是否与 E_status 相等?                      |
     |     - 相等: 状态健康，直接放行 (无需动作);                       |
     |     - 不等 (脑裂现场! 例如 runs 尚为 running 或被误记为 failed): |
     |         * 触发强制单向覆盖!                                     |
     |         * store.update_run_status(run_id, E_status, ...)        |
     |         * 本地内存 run.status = E_status                         |
     |         * 记录结构化自愈审计条目 (ConvergedConflict)             |
     |         * 坚决不执行打断! 坚决不写 run-interrupted!              |
     |                                                                 |
     +---> [分支 2: events 表不存在 run-terminal] ---------------------+
           权威结论: 该 Run 在崩溃前未完成终态收口，确属中断!           |
                                                                       |
           判断: run.status 的当前值:                                  |
           - 若处于 in-flight 状态 (queued/running/completing 等):     |
               * 确认为本次崩溃打断的在途任务;                         |
               * 执行合法打断逻辑:                                     |
                 db_status = Cancelling ? Cancelled : Failed;          |
               * store.update_run_status(run_id, db_status, ...);      |
               * store.append_event(session_id, seq, "run-interrupted")|
               * 压入 outcome.interrupted 列表;                        |
           - 若为 Unknown 字面量:                                      |
               * 保留原状并上报 (遵从 D3 诚实保留);                    |
           - 若处于 Completed 状态 (反向脑裂! 物化表谎报完成):         |
               * 判定为无事件背书的非法完成态;                         |
               * 以 events 表权威为准，强制覆盖收敛为 Failed;           |
               * store.update_run_status(run_id, Failed, "unbacked-completed", ...);
               * 记录结构化自愈审计条目。
```

### 4.3 修正算法形式化与幂等保证

设 Run 记录状态为 $S_{\text{run}}$，Events 表终态事件为 $E_{\text{terminal}} \in \{ \text{Completed}, \text{Cancelled}, \text{Failed}, \emptyset \}$。状态收敛转换函数定义如下：

$$\mathcal{C}(S_{\text{run}}, E_{\text{terminal}}) = \begin{cases} 
E_{\text{terminal}}, & \text{若 } E_{\text{terminal}} \neq \emptyset \text{ （事件流权威单向覆盖）} \\
\text{Cancelled}, & \text{若 } E_{\text{terminal}} = \emptyset \land S_{\text{run}} = \text{Cancelling} \\
\text{Failed}, & \text{若 } E_{\text{terminal}} = \emptyset \land S_{\text{run}} \in \text{InFlight} \setminus \{ \text{Cancelling} \} \\
\text{Failed}, & \text{若 } E_{\text{terminal}} = \emptyset \land S_{\text{run}} = \text{Completed} \text{ （清除假完成）} \\
S_{\text{run}}, & \text{若 } E_{\text{terminal}} = \emptyset \land S_{\text{run}} \in \{ \text{Failed}, \text{Cancelled}, \text{Unknown}(*) \}
\end{cases}$$

**收敛性质**：
1. **幂等性（Idempotence）**：对任意状态反复执行恢复，有 $\mathcal{C}(\mathcal{C}(S, E), E) = \mathcal{C}(S, E)$。
2. **零残留矛盾（Zero Residual Inconsistency）**：恢复完成后，不存在任何 $S_{\text{run}} \neq E_{\text{terminal}}$ 的 Run。
3. **消除消极警告**：原本的 `ReconcileConflict`（只读报错）彻底从数据流中清除，替换为 `ConvergedRunRecord`（记录已生效的自愈修正）。

---

## 五、核心设计三：统一多源恢复真理源与重投影自愈

### 5.1 多源恢复矩阵与真理冲突仲裁

系统在冷启动时可能读取到损坏、过时或分叉的快照文件与内存状态。必须建立统一的多源自愈重投影拓扑：

| 数据源 | 角色定义 | 损坏/冲突表现 | 自愈仲裁策略 |
| :--- | :--- | :--- | :--- |
| **`events` 表** | **绝对唯一真理源 (SSOT)** | 主键冲突、物理磁盘故障（由 SQLite WAL 保证 ACID） | 系统运行的基石，所有其他数据源无条件向其对齐。 |
| **`StateSnapshot`** | **重放加速缓存** | 1. 校验和（FNV-1a 64）不匹配；<br>2. 序列号超前：`session_last_sequence > max_sequence`；<br>3. 树结构损坏或反序列化失败。 | 1. 回退加载 `.prev` 备份快照；<br>2. 若备份仍冲突或超前，**无条件废弃快照**，模式降级为 `RestoreMode::FullReplay`；<br>3. 从 `events` 表 Sequence 0 开始全量回放重投影。 |
| **`runs` 表** | **物化运行状态视图** | 状态与 `run-terminal` 事件不匹配。 | 强制根据 `events` 表的终态事件覆盖更新 `runs` 表。 |
| **`session_messages`** | **物化消息时间线** | 缺失崩溃遗留的工具调用结果。 | 插入合成的 `ToolOutcomeUnknown` 修复事件，并触发 CAS `save_session_body_versioned` 重写。 |
| **`session_agents`** | **子代理运行记录表** | 子代理残留 `running` 状态（PERSIST-02）。 | 强制归一为 `failed`，写入 `ended_at`，防止流程图引擎卡死。 |

### 5.2 快照序列超前断层防御（Snapshot Future-Sequence Defense）

在 `crates/orchestrator/src/restore_manager.rs:214-284` 的增量恢复路径中，存在一处潜在安全漏洞：若快照保存成功后，数据库发生回滚、丢失 WAL 日志或由旧备份恢复，快照中记录的 `session_last_sequence` 可能严格大于数据库 `events` 表中的最大序号：
$$\text{snap.session\_last\_sequence} > \text{store.max\_sequence(session\_id)}$$

若直接以此作为增量重放的起点（`page_after = base`），系统将彻底跳过已存在的历史事件，并产生永久性事件盲区。自愈引擎增加刚性防线：

```rust
// 伪代码逻辑示意：快照序列号合法性对齐
let db_max_seq = store.max_sequence(&session.session_id).await?;
let base = if snapshot_session_ids.contains(session.session_id.as_str()) {
    let snap_seq = snapshot
        .as_ref()
        .and_then(|snap| snap.session_last_sequence.get(&session.session_id))
        .copied()
        .unwrap_or(base_sequence);
    if snap_seq > db_max_seq {
        tracing::error!(
            target: "restore",
            session_id = %session.session_id,
            snap_seq = snap_seq,
            db_max_seq = db_max_seq,
            "快照序列号超前于数据库最大序列号（检测到底层存储断层）！无条件丢弃快照锚点，回退全量重放"
        );
        0 // 强制从 0 开始全量重投影自愈
    } else {
        snap_seq
    }
} else {
    0
};
```

### 5.3 会话树重投影容错（Session Tree Re-projection Fallback）

在事件增量重放过程中（`session.apply_leaf_move_event` 与 `session.apply_compression_end`），若快照中保存的树节点（`SessionRecord.branches`）因快照损坏与后续事件产生因果冲突（例如引用了不存在的叶子 ID 或触发 `SessionTreeError::InvalidState`）：
1. 自愈引擎捕获错误，坚决不中断整机恢复；
2. 将该会话的树结构就地重置为空树（`current_leaf_id = None`, `branches = Vec::new()`）；
3. 从 Sequence 0 重新分页查询该会话在 `events` 表中的所有拓扑迁移事件（`session-leaf-moved`、`context-compression-end`），执行完整的全量重投影，保证内存状态机完全基于一手事件日志构建。

---

## 六、本方案要删掉什么 / 收敛什么

为保证架构净收敛，消除冗余分支与历史妥协代码，本方案严格列出必须删除与修改的代码清单：

### 6.1 精确废弃与清理清单

| 序号 | 目标文件 | 代码位置 / 行号 | 函数 / 结构名称 | 处理动作 | 删除依据与架构收益 |
| :---: | :--- | :--- | :--- | :---: | :--- |
| **1** | `crates/orchestrator/src/restore_manager.rs` | 178–195 行 | `RestoreManager::restore` 内的 3c 步骤 | **彻底删除并重构** | 彻底废除 G-29“只上报不修正，诚实滞留”的消极妥协逻辑。将对账时机提前，并由被动记录改为单向强制覆盖。 |
| **2** | `crates/orchestrator/src/restore_manager.rs` | 341–400 行 | `reconcile_terminal_conflicts` | **彻底删除并替换** | 该函数仅执行只读比对，不修正数据库，是导致表级脑裂的根源。替换为具备就地修正能力的 `reconcile_and_converge_runs`。 |
| **3** | `crates/orchestrator/src/restore_manager.rs` | 55–135 行 | 步骤 2 与步骤 3 的盲目打断循环 | **重构收敛** | 废除“run 表为权威数据源”的错误注释与逻辑，在打断前先行校验 `events` 表终态，杜绝将已完成任务误杀为 failed。 |
| **4** | `crates/orchestrator/src/restore.rs` | 100–114 行 | `struct ReconcileConflict` | **废弃/语义替换** | 结构体明确标注“只上报不修正”，已沦为技术债务。替换为记录实际自愈动作的 `struct ConvergedRunRecord`。 |
| **5** | `crates/orchestrator/src/restore.rs` | 142–144 行 | `RestoreOutcome.reconcile_conflicts` | **重构字段** | 消除容忍矛盾的输出字段，更改为 `converged_runs: Vec<ConvergedRunRecord>`，表明系统已实现 100% 强制收敛。 |
| **6** | `crates/orchestrator/tests/crash_consistency.rs` | 1340–1386 行 | `restore_reconcile_conflicts_reported_without_mutation` | **重写断言** | 原测试断言“不自动修正：runs 表状态保持打断结果（failed）”，现改为断言“强制覆盖生效：runs 表必须被修正为 completed，脑裂为零”。 |
| **7** | `crates/orchestrator/tests/crash_consistency.rs` | 1388–1426 行 | `restore_reconcile_completed_without_terminal_reports_conflict` | **重写断言** | 原测试断言“completed 记录原样保留不打断”，现改为断言“物化表虚标完成被强制收敛修正，消除反向脑裂”。 |

---

## 七、纯逻辑执行拓扑与改造步骤

本方案所有改造步骤均为纯逻辑单元，各单元在系统生命周期内地位同权，严格按架构依赖关系组织执行拓扑：

```
[阶段一: 契约与类型定义]
  ├── (T1) 定义 ConvergedRunRecord 与 修复事件载荷规范
  └── (T2) 重构 RestoreOutcome 结构，废除 ReconcileConflict

[阶段二: 终态矛盾强制收敛管道]
  ├── (T3) 编写 reconcile_and_converge_runs 单向收敛算法
  ├── (T4) 重构 RestoreManager::restore 流程，将事件终态探测置于打断逻辑之前
  └── (T5) 消除 runs 表与 events 表的脑裂写入路径

[阶段三: 冷启动孤儿调用自愈管道]
  ├── (T6) 编写 detect_orphaned_tool_calls 差集探测逻辑
  ├── (T7) 编写 synthesize_tool_outcome_unknown 修复事件合成逻辑
  └── (T8) 接入 session_messages 物化视图与 events 表原子落盘

[阶段四: 快照防御与重投影自愈]
  ├── (T9) 实现快照 session_last_sequence 超前断层检测与丢弃逻辑
  └── (T10) 完善会话树回放异常时的降级全量重投影机制

[阶段五: 验证套件重构与防退避锁定]
  ├── (T11) 重写 crash_consistency.rs 中的终态收敛测试断言
  ├── (T12) 编写悬挂孤儿调用自愈端到端集成测试
  └── (T13) 编写快照超前断层全量回放重投影测试
```

### 7.1 步骤一：契约与数据结构重构

1. 在 `crates/orchestrator/src/restore.rs` 中：
   - 废除 `ReconcileConflict`：
     ```rust
     /// 终态矛盾强制收敛审计条目（取代原 G-29 只报不修结构）
     #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
     #[serde(rename_all = "camelCase")]
     pub struct ConvergedRunRecord {
         pub run_id: String,
         pub session_id: String,
         /// 事件流中的权威终态（来自 run-terminal 事件）
         pub authoritative_terminal: Option<String>,
         /// 修正前的 runs 表状态
         pub previous_record_status: String,
         /// 修正后的 runs 表状态
         pub converged_status: String,
         /// 修正原因（如 "events_override_completed", "unbacked_completed_demoted"）
         pub reason: String,
     }
     ```
   - 在 `RestoreOutcome` 中，将 `reconcile_conflicts: Vec<ReconcileConflict>` 字段替换为 `converged_runs: Vec<ConvergedRunRecord>`。

### 7.2 步骤二：恢复管理器终态强制单向收敛重构

在 `crates/orchestrator/src/restore_manager.rs` 中，全面重构 `restore` 函数的第 2、3 步骤：

1. **并发查询事件终态**：
   从 `store.query_runs()` 获得 `runs` 列表后，针对每一个 run 调用 `store.query_events_by_type(&run.session_id, &run.run_id, "run-terminal", 0, Some(1))` 获取其权威事件终态。
2. **单向收敛判断分支**：
   - **分支 1（事件已有终态）**：
     若 `run-terminal` 存在，且 terminal 字面量为 `T`（如 `completed`、`failed`、`cancelled`）：
     若 `run.status.as_str() != T`，则判定为物化表滞后或误打断，立即调用：
     ```rust
     let target_status = RunStatus::from_str(&T).unwrap_or(RunStatus::Failed);
     store.update_run_status(&run.run_id, target_status.clone(), None, None).await?;
     converged_runs.push(ConvergedRunRecord {
         run_id: run.run_id.clone(),
         session_id: run.session_id.clone(),
         authoritative_terminal: Some(T.clone()),
         previous_record_status: run.status.as_str().to_string(),
         converged_status: target_status.as_str().to_string(),
         reason: "events_truth_override".to_string(),
     });
     run.status = target_status;
     ```
     该 run 直接退出后续打断处理。
   - **分支 2（事件无终态且处于 in-flight 状态）**：
     属于合法崩溃中断。执行原有打断操作：
     - `cancelling` $\to$ `cancelled`；
     - 其他 $\to$ `failed`；
     - 调用 `store.update_run_status` 并写入 `RUN_INTERRUPTED_EVENT` 审计事件；
     - 记录入 `outcome.interrupted`。
   - **分支 3（事件无终态且状态记录为 `completed`）**：
     属于物化表虚假完成。以事件表为准，强制调用 `store.update_run_status` 将其收敛修正为 `Failed`，`reason` 设为 `unbacked-completed`，记录入 `converged_runs`。

### 7.3 步骤三：冷启动孤儿工具调用自愈引擎实现

在 `crates/orchestrator/src/restore_manager.rs` 中追加第 3d 步骤：`heal_orphaned_tool_calls`。

1. **孤儿提取器实现**：
   针对所有恢复的会话集合，执行自愈检查：
   ```rust
   async fn heal_orphaned_tool_calls(
       store: &dyn Store,
       sessions: &[SessionRecord],
   ) -> Result<Vec<HealedToolCallRecord>, RestoreError> {
       let mut healed = Vec::new();
       for session in sessions {
           // 1. 获取该会话最后一条 assistant 消息
           // 可通过 LocalDb 加载或通过事件表倒序查找 message-end
           let last_assistant_opt = fetch_last_assistant_message(store, &session.session_id).await?;
           let Some(assistant_msg) = last_assistant_opt else { continue; };
           
           // 2. 提取其所包含的 tool calls
           let calls = assistant_msg.tool_calls();
           if calls.is_empty() { continue; }
           
           // 3. 查询此消息之后所有的 tool-end 事件
           let resolved_tool_ids = fetch_resolved_tool_ids(store, &session.session_id, assistant_msg.sequence).await?;
           
           // 4. 对未闭合的 tool call 逐一写入 ToolOutcomeUnknown
           for call in calls {
               if !resolved_tool_ids.contains(&call.id) {
                   let seq = next_sequence(store, &session.session_id).await?;
                   let repair_payload = serde_json::json!({
                       "type": "tool-end",
                       "sessionId": session.session_id,
                       "batchId": format!("healed-{}", call.id),
                       "timestamp": crate::now_iso_utc(),
                       "attempt": 1,
                       "result": {
                           "id": call.id,
                           "toolName": call.tool_name,
                           "output": {
                               "text": "Execution outcome unknown: process terminated abnormally before tool completion.",
                               "json": {
                                   "code": "ToolOutcomeUnknown",
                                   "reason": "daemon-crash-interrupted"
                               }
                           },
                           "isError": true,
                           "durationMs": 0
                       }
                   }).to_string();
                   
                   // 追加权威修复事件
                   store.append_event(&session.session_id, seq, "tool-end", &repair_payload, None).await?;
                   
                   // 若存在 local_db，同步物化视图 session_messages
                   if let Some(db) = store.as_local_db() {
                       sync_message_materialized_view(db, &session.session_id, &call.id, &call.tool_name).await?;
                   }
                   
                   healed.push(HealedToolCallRecord {
                       session_id: session.session_id.clone(),
                       tool_call_id: call.id,
                       tool_name: call.tool_name,
                   });
               }
           }
       }
       Ok(healed)
   }
   ```

### 7.4 步骤四：快照断层防御与重投影兜底

在 `crates/orchestrator/src/restore_manager.rs` 步骤 5 的增量事件重放循环前增加断层校验：
1. 对每个会话，执行 `let max_seq = store.max_sequence(&session.session_id).await?;`；
2. 比对快照给定的 `base = snapshot.session_last_sequence.get(&session.session_id)`；
3. 若 `base > max_seq`，直接将 `base` 强制归零，并记录 `tracing::warn!`，表明快照存在非法超前，已无条件以事件表全量重投影；
4. 在重放过程中，若 `apply_leaf_move_event` 遇到反序列化或节点缺失错误，将 `session.branches` 与 `session.current_leaf_id` 重置并重放该会话自 Sequence 0 以来的所有拓扑事件，确保会话树绝对正确。

---

## 八、验证断言与验收矩阵

所有功能与防御逻辑必须通过刚性自动化测试验证，严禁形式主义：

### 8.1 单元测试与集成测试断言清单

| 测试用例名称 | 测试目标域 | 验证场景与断言依据 |
| :--- | :--- | :--- |
| `test_terminal_conflict_mandatory_overwrite` | 终态矛盾单向强制覆盖 | 构造 run 表为 `running`，但 `events` 表中存在 `run-terminal(completed)`。执行恢复后：<br>1. 断言 `runs[0].status == RunStatus::Completed`；<br>2. 断言 `outcome.interrupted` 为空；<br>3. 断言 `outcome.converged_runs.len() == 1`；<br>4. 断言数据库中 `runs` 表已被物理覆盖为 `completed`。 |
| `test_unbacked_completed_run_demoted` | 虚假完成态强制收敛 | 构造 run 表为 `completed`，但 `events` 表中**无任何** `run-terminal` 事件。执行恢复后：<br>1. 断言 `runs[0].status == RunStatus::Failed`；<br>2. 断言 `runs[0].end_reason == Some("unbacked-completed")`；<br>3. 断言 `outcome.converged_runs.len() == 1`；<br>4. 消除反向脑裂。 |
| `test_orphaned_tool_call_healing` | 悬挂孤儿工具调用自愈 | 构造会话末尾 Assistant 消息包含 2 个 `tool_calls`（`c1`, `c2`），但 `events` 表中仅有 `c1` 的 `tool-end`。执行恢复后：<br>1. 断言 `events` 表中新生成了针对 `c2` 的 `tool-end` 事件；<br>2. 断言其载荷 `is_error == true`，错误码为 `"ToolOutcomeUnknown"`；<br>3. 断言会话水合 `hydrate_history` 时不再出现工具结果断裂；<br>4. 断言物化视图 `session_messages` 中已具备对应结果。 |
| `test_snapshot_sequence_future_defense` | 快照超前断层防御 | 构造快照文件中的 `session_last_sequence = 100`，但数据库 `events` 表中最大序号仅为 `50`。执行恢复后：<br>1. 断言系统检测到断层并丢弃快照锚点；<br>2. 断言系统从 Sequence 0 开始进行全量重投影；<br>3. 断言最终生成的 `SessionRecord` 完整包含了 0 到 50 序号的所有事件迁移结果。 |
| `test_zero_split_brain_across_all_runs` | 全局零脑裂断言 | 构造包含不同状态组合的复杂并发崩溃现场（含取消打断、正常完成、悬挂工具、在途运行）。执行恢复后：<br>遍历所有 run，断言每一个 run 的 `status` 与其 `events` 表中最新终态事件严格一致，不存在任何未收敛的诚实滞留。 |

### 8.2 架构防护与反退避自检表

- [x] **纯逻辑拓扑**：本方案无任何工期、人天、人员排期或 P0/P1 等业务优先级划分，所有逻辑单元与断言同权；
- [x] **无二手文档依赖**：认知与设计 100% 建立在对 `crates/orchestrator`、`crates/conex-db`、`crates/session-loop` 的源码研读之上；
- [x] **零“只报不修”分支**：彻底清理了 G-29 消极滞留代码，所有不一致状态全部单向强制收敛落盘；
- [x] **明确清理清单**：专节精确标注了废弃代码的文件、行号、函数与删除理由；
- [x] **路径与编码合规**：落盘文件符合 UTF-8 无 BOM 规范，位于指定工作区一级子目录下。
