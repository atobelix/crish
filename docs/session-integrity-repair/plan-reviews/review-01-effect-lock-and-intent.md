# 方案交叉评审 01：目的性与效果锁闭环审查报告

> **评审对象**：全量 7 份独立方案（`docs/session-integrity-repair/independent-plans/plan-01` 至 `plan-07`）  
> **一手源码比对基线**：
> - `crates/session-loop/src/loop/handlers/executing_tools.rs`
> - `crates/session-loop/src/loop/handlers/streaming.rs`
> - `crates/session-loop/src/exec_batch.rs`
> - `crates/agent-provider/src/request/build_anthropic.rs`
> - `crates/conex-db/src/messages.rs`
> - `crates/conex-db/src/events.rs`
> - `crates/conex-db/src/cas_gc.rs`
> - `crates/orchestrator/src/restore_manager.rs`
> - `crates/orchestrator/src/restore_snapshot.rs`
>
> **评审核心维度**：
> 1. 效果锁坚固度（是否 100% 紧扣两大核心方向，零退避、零砍功能、零 MVP 简化企图）；
> 2. 工具成对性不变量数学封闭性（极端场景下是否 100% 保证配对，零孤儿泄露逃生通道）；
> 3. 持久化真理源唯一权威性（是否彻底消灭三源分裂与 G-29 只报不修，无条件以 `events` 表为单一真理源 SSOT）。
>
> **纪律铁律**：纯逻辑执行拓扑，严禁工期、人天、人员排期或 P0/P1 等级划分；所有发现问题逻辑同权。

---

## 一、评审结论总纲（Executive Summary）

经过对 `plan-01` 至 `plan-07` 全量 7 份独立方案的全文逐行交叉比对，并对照 `crates/` 下 9 处一手源码核心模块的严密推演，出具本次目的性与效果锁闭环审查的总体结论：

### 1. 总体评级：【有条件通过（需定向修补 3 处逃逸隐患与 1 处设计分歧）】

- **效果锁方向性（优秀）**：全量 7 份方案均 100% 紧扣“工具中断合成修复”与“持久化单一真理源收敛”两大主线，坚决贯彻“先删后改、收敛优先”铁律；没有任何一份方案企图将修复降级为“业务临时绕行”、“MVP 简化版”或“砍功能退避”；所有方案均展现了对系统不变量和长效自愈的坚定追求。
- **工具成对性闭环（良好，但存在关键逃逸盲区）**：各方案均精确定位了 `executing_tools.rs:49-53` 前置 abort 丢弃工具、`exec_batch.rs:188-191` 空 ID 兜底伪造两大经典断层。然而，**除 `plan-01` 之外，其余方案（`plan-04`、`plan-05`、`plan-07`）均遗漏了 `streaming.rs:269-280` 流末尾 abort 导致的工具孤儿逃逸断面**；同时，`plan-06` 试图在序列化导线层进行“静默合成垫片”，与 `plan-04` 的“导线层刚性断言拦截”产生了严重的架构设计冲突。
- **持久化 SSOT 唯一权威（优秀，但存在收敛纯度分歧）**：全量方案均达成绝对共识：物理删除 `DELETE FROM session_messages WHERE session_id = ?1` 全量删插反模式，改道增量 Upsert 与差异收缩；全量读改道 `ReaderPool`，生产写收敛至 `DbWriteHandle` Actor。但在 G-29 终态矛盾治理上，`plan-03` / `plan-05` 的“时序前置彻底消灭矛盾”与 `plan-07` 的“保留改名后的后置对账修复器”产生方案分歧，需进行绝对权威裁决。

---

## 二、三维核心审查详细剖析

### 维度 1：效果锁是否坚固（Anti-Retreat & Full Scope Fidelity）

#### 1.1 审查断言与方案表现矩阵

| 方案编号与主题 | 目标是否紧扣两大方向 | 是否存在退避/减配企图 | 评价与审查物证 |
| :--- | :---: | :---: | :--- |
| **Plan 01** (中断合成) | 100% 紧扣 | 零退避 | **坚固**。构建 Tier-1 执行层就地合成、Tier-2 终态收敛全局闭合、Tier-3 水合自愈三级防御纵深，效果锁极其坚固。 |
| **Plan 02** (持久化 SSOT) | 100% 紧扣 | 零退避 | **坚固**。确立 `events` 为唯一物理法定真理，`session_messages` 降为只读物化视图，彻底切除全删反模式，并提供事件回放投影自愈引擎。 |
| **Plan 03** (恢复一致性) | 100% 紧扣 | 零退避 | **坚固**。彻底废除 G-29“只报不修”消极妥协，颠倒恢复时序为“事件真理先行”，实现冷启动孤儿工具调用强制合成自愈。 |
| **Plan 04** (防御性测试) | 100% 紧扣 | 零退避 | **坚固**。引入 I7/I8 运行时不变量，构建反 DELETE 负向断言、Provider 导线协议预检守门断言，杜绝脱水 Mock。 |
| **Plan 05** (死层清理) | 100% 紧扣 | 零退避 | **坚固**。先删后改，建立长达 15 项的物理删除清册，将全量 DELETE、G-29 对账、快照死函数及前端截断防御补丁连根拔起。 |
| **Plan 06** (端到端集成) | 100% 紧扣 | 存在防御性退避隐患 | **需修正**。在 §4.2 提出在 Provider 序列化层对未配对工具进行静默补齐（`to_anthropic_messages` 假装成功），涉嫌以补丁掩盖底层断层。 |
| **Plan 07** (架构门禁) | 100% 紧扣 | 零退避 | **坚固**。编制 3 大静态防腐探针与运行时守卫，从预检脚本、pre-commit 到 CI 流水线形成刚性防腐网。 |

#### 1.2 效果锁重点审计结论
方案群在方向性上高度统一，彻底粉碎了历史重构中“打临时补丁”、“留待日后对账”、“前端写保护熔断”等妥协思想。唯一的严重退避隐患出现在 `plan-06` 的序列化层静默兜底，该点必须予以刚性纠偏。

---

### 维度 2：工具成对性不变量是否数学封闭（Pairing Invariant Mathematical Closure）

工具成对性不变量的数学定义为：
$$\forall c \in \text{Assistant.ToolCalls},\ \exists! r \in \text{ToolResults}\ \text{s.t.}\ r.\text{tool\_call\_id} = c.\text{id}$$
即：会话历史中任何被模型声明的 `ToolCall`，必须且仅能存在一个全局唯一匹配其 ID 的 `ToolResult`。

通过对 5 大极端场景进行全真逻辑推演，审查各方案的封闭性：

#### 2.1 场景推演一：前置中断（Pre-flight Abort / SafePoint L3）
- **源码断裂点**：[`crates/session-loop/src/loop/handlers/executing_tools.rs:49-53`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L49-L53)
  ```rust
  if let Some(end) = check_control(state)? {
      return Ok(HandlerOutcome::end(end));
  }
  ```
- **方案封闭性审查**：
  - `plan-01` §3.1（L310-326）、`plan-04` §2.1（L65-68）、`plan-05` §5.1（L322-343）、`plan-07` §4.2（L304-318）均精准捕捉并封堵了此漏洞，要求在返回前提取 `last_assistant_with_tool_calls` 中的调用，就地合成携带 `ToolErrorKind::Cancelled` 或 `codes::TOOL_ABORTED_BEFORE_DISPATCH` 的 `ToolResult` 消息并推入会话历史。
  - **审查结论**：本场景在所有方案中均实现了逻辑闭合。

#### 2.2 场景推演二：流式中断（Streaming Abort / Stream Truncation）
- **源码断裂点**：[`crates/session-loop/src/loop/handlers/streaming.rs:269-280`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L269-L280)
  ```rust
  commit_message_with_deltas(state, message); // 携带 tool_calls 的 Assistant 消息已落盘！
  if aborted || consumed.stop_reason() == Some(ConsumeStopReason::Aborted) {
      return streaming_aborted(state); // 直接退出状态机！
  }
  if let Some(end) = check_control(state)? {
      return Ok(HandlerOutcome::end(end)); // 直接退出状态机！
  }
  ```
- **方案封闭性审查**：
  - **严重漏洞定位**：在全量 7 份方案中，**仅有 `plan-01` §1.2 断面 2（L111-128）与 §3.1 机制 1.2（L330-334）识别并覆盖了此场景**！
  - `plan-04`、`plan-05`、`plan-07` 的分析视角完全局限在 `executing_tools.rs:49-53`。若流式末尾模型吐出工具后瞬间发生中止，状态机直接在 `streaming.rs` 中走向 `streaming_aborted` 或 `HandlerOutcome::end`，**永远不会进入 `executing_tools`**！
  - **审查结论**：若缺少 `plan-01` 提出的在 `streaming.rs` 就地闭合或在 `loop_exec.rs::converge` 处设立 Tier-2 全局守门员（`reconcile_orphan_tool_calls`），系统在此处将存在致命的孤儿泄露逃生通道！

#### 2.3 场景推演三：审批超时与审批等待期取消（Approval Timeout & Cancel）
- **源码断裂点**：[`crates/session-loop/src/exec_batch.rs:368-403`](file:///c:/Software/conex/crates/session-loop/src/exec_batch.rs#L368-L403) 与 `:469-501`。
- **方案封闭性审查**：
  - `exec_batch.rs` 本身具备超时（`ApprovalDecision::Expired`）与取消（`ToolErrorKind::Cancelled`）的分支，但 `:188-191` 处的解包兜底存在硬编码漏洞：
    `ClassifiedToolResult::error("", "", ToolErrorKind::Cancelled, "cancelled", 0)`。
  - `plan-01`、`plan-04`、`plan-05`、`plan-06`、`plan-07` 均精准定位该空串漏洞，并要求强制基于入参 `calls[i].id` 与 `calls[i].tool_name` 严密回填。
  - **审查结论**：闭合逻辑确凿，回填契约规范。

#### 2.4 场景推演四：并发部分失败与兄弟取消（Concurrent Partial Failure & Sibling Cancellation）
- **源码断裂点**：[`crates/session-loop/src/exec_batch.rs:252-264`](file:///c:/Software/conex/crates/session-loop/src/exec_batch.rs#L252-L264)
- **方案封闭性审查**：
  - `mark_rest_cancelled`（`crates/session-loop/src/exec_verdict.rs:240-279`）虽然为剩余工具生成了取消结果与事件，但批次外层缺少针对 `abort` 的快速熔断（`plan-05` §5.2 补全了外层 break）。
  - `plan-04` 设计的 `test_midflight_concurrency_abort_pairing_closure`（4 并发工具部分完成时打断）提供了真实的多任务验证物证。
  - **审查结论**：场景推演闭合。

#### 2.5 场景推演五：冷启动崩溃（Crash before Tool Completion）
- **源码断裂点**：宿主进程在工具执行中途被 `SIGKILL` 或断电，未产生 `tool-end` 事件，内存未及写盘。
- **方案封闭性审查**：
  - `plan-03` §3（L53-144）设计了冷启动孤儿工具自愈引擎 `heal_orphaned_tool_calls`，在恢复期扫描最后一个 Assistant 消息的工具集合与后续事件，差集强制合成 `ToolOutcomeUnknown` 事件并落库。
  - `plan-01` §3.3（L437-442）与 `plan-06` §4.2（L520-568）在 `hydrate.rs:synthesize_blocks` 提供了第二重水合自愈。
  - **审查结论**：冷启动与存量历史水合具备双重自愈保障。

---

### 维度 3：持久化真理源是否唯一权威（Persistence SSOT & Zero Split-Brain）

#### 3.1 彻底消灭三源分裂（`events` vs `session_messages` vs `StateSnapshot`）
系统现存数据漂移的根源在于三个物理介质缺乏清晰的主从契约。审查各方案的收敛模型：
1. **单一法定权威（SSOT）**：
   - 全量方案一致裁决：**`events` 表（SQLite Append-Only Event Stream）是系统的唯一法定权威**。
   - 所有状态迁移的真实性由 `(session_id, sequence)` 严格单调递增的事件记录背书，物理不可篡改。
2. **物化视图降级（Materialized View）**：
   - `plan-02` §二与 `plan-05` §3.1 将 `session_messages` 彻底降级为读加速物化视图；
   - 彻底废除并物理删除 `DELETE FROM session_messages WHERE session_id = ?1`（`messages.rs:112-119` 与 `import.rs:90-95`）；
   - 采用 `ON CONFLICT(session_id, seq) DO UPDATE` 增量 Upsert + 尾部差异收缩（Diff Shrink），从根源上消除了清空窗口、数据归零与 $O(N)$ 写放大；
   - `plan-02` §六设计了 `rebuild_messages_from_events` 投影引擎，确保物化视图在任何时候损坏均可由 `events` 单向幂等自愈重建。
3. **外部快照降级（Acceleration Cache Only）**：
   - `plan-03` §5.1-5.2 与 `plan-05` §4.2 明确 `StateSnapshot` 仅作为重放加速缓存；
   - 若快照中 `session_last_sequence` 超前于数据库实际 `max_sequence`，无条件丢弃快照并降级为从 `events` 表 Sequence 0 开始全量重放；
   - 物理删除 `restore_snapshot.rs` 中用于反序列化 `runs` 和 `pending_inputs` 的 4 个死函数，切断快照向内存渗透虚假状态的路径。

#### 3.2 终态矛盾从“只报不修”升级为“单向强制收敛”
- **源码现场**：[`crates/orchestrator/src/restore_manager.rs:178-195`](file:///c:/Software/conex/crates/orchestrator/src/restore_manager.rs#L178-L195)
  历史代码在 Step 3 盲目将所有 in-flight run 改写为 Failed，导致后续对账发现 `events` 表明明记录已完成时，只能消极打印 `tracing::warn!("G-29 终态矛盾对账：只上报不修正")`。
- **审查结论**：
  `plan-03` §4（L146-233）穿透了本质，给出了最优架构解：**颠倒执行时序，将事件权威前置于状态决策之前**！
  - 若 `events` 表中已存在 `run-terminal`（例如 completed），则权威判定该 Run 已合法完成，直接单向覆盖同步 `runs.status = Completed`，绝不打断，绝不记为 failed；
  - 仅当 `events` 表无终态时，才执行合法打断；
  - 这种设计从物理上彻底消除了终态矛盾产生的可能性，是对 G-29 的彻底根治。

---

## 三、跨方案缺陷、漏洞与冲突清单（Defect & Conflict Log）

在全量交叉比对中，审查出以下 4 项重大架构缺陷、冲突与盲区，必须在总方案与分维详案中予以明确裁决与修正：

### 缺陷 1：【重大冲突】Plan 06 导线层静默填坑 vs Plan 04 刚性门禁断言
- **涉及文档与行号**：
  - `docs/session-integrity-repair/independent-plans/plan-06-end-to-end-integration.md:570-578`
  - `docs/session-integrity-repair/independent-plans/plan-04-defensive-assertions.md:193-243`
- **缺陷剖析**：
  - `plan-06` 在 §4.2 中提出在 `build_anthropic.rs:to_anthropic_messages` 注入“算法 2：序列化层 Invariant Guardian”——当序列化扫描到末尾发现仍有未配对的 `tool_use_id` 时，由序列化层在内存中伪造一个空的 user tool_result 块发往上游。
  - 这属于典型的**违反效果锁、用临时补丁掩盖底层故障的危险行为**！如果允许序列化层在内存中静默填坑，那么上游状态机未闭合、数据库持久化孤儿、前端 UI 永久卡死等底层断层将被彻底掩盖，脱离监控。
  - 这与 `plan-04` §3.2 的 `assert_wire_messages_integrity` 门禁发生尖锐冲突（`plan-04` 要求一旦在导线层发现孤儿调用，必须硬性 panic 阻断，拦截率 100%）。
- **审查裁决**：
  **坚决否决 `plan-06` 的导线层静默合成方案，全面采纳 `plan-04` 的刚性门禁拦截**！导线层只作为校验守门员，必须保持 Fail-Closed；成对闭合必须在状态机层（Tier-1/Tier-2）与水合层（Tier-3）彻底解决，严禁在出站导线层打补丁。

---

### 缺陷 2：【成对性逃逸盲区】`streaming.rs` 流式中断未被多数方案覆盖
- **涉及文档与行号**：
  - `docs/session-integrity-repair/independent-plans/plan-04-defensive-assertions.md:65-84`
  - `docs/session-integrity-repair/independent-plans/plan-05-dead-layers-removal.md:62-64`
  - `docs/session-integrity-repair/independent-plans/plan-07-architectural-guardrails.md:58-84`
  - 核心一手源码：[`crates/session-loop/src/loop/handlers/streaming.rs:269-280`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L269-L280)
- **缺陷剖析**：
  - `plan-04`、`plan-05`、`plan-07` 的方案设计与删除面仅关注了 `executing_tools.rs:49-53`。
  - 事实上，在 `streaming.rs` 中，`commit_message_with_deltas` 提交消息后，紧随其后的第 271 行（`if aborted ...`）与第 277 行（`if let Some(end) = check_control(state)?`）均可使循环直接退出，**根本不进入 `executing_tools`**。
  - 若仅在 `executing_tools.rs` 注入合成逻辑，在流式末尾发生的打断仍将 100% 泄露孤儿调用。
- **审查裁决**：
  **必须将 `plan-01` 提出的全方位防护模型并入总纲**：
  1. 在 `streaming.rs:271-280` 退出分支增加工具调用闭合逻辑；
  2. 在 `crates/session-loop/src/loop/loop_exec.rs:304` 的终态收敛函数 `AgentSessionLoop::converge` 中注入兜底守门员 `reconcile_orphan_tool_calls`。无论状态机从哪个 Handler（streaming、executing_tools、dispatch 等）以何种原因退出，离开循环前强制执行 100% 孤儿配对扫描与补全。

---

### 缺陷 3：【架构收敛分歧】G-29 终态矛盾治理路径不一致（彻底删除 vs 改名保留）
- **涉及文档与行号**：
  - `docs/session-integrity-repair/independent-plans/plan-03-crash-recovery-healing.md:171-215` & `plan-05-dead-layers-removal.md:48-56`
  - 对比：`docs/session-integrity-repair/independent-plans/plan-07-architectural-guardrails.md:221-231, 323-335`
- **缺陷剖析**：
  - `plan-03` 与 `plan-05` 主张将事件终态探测前置到 Step 3 打断循环前，消除矛盾产生的根因，从而**彻底物理删除** `reconcile_terminal_conflicts` 全函数、`ReconcileConflict` 结构体及 `outcome.reconcile_conflicts` 字段（代码净删除）。
  - 而 `plan-07` 在 §4.3 与 §3.2 中，仍主张保留一个改名后的后置对账修复器 `reconcile_and_repair_terminal_conflicts`，并在脚本探针中检查该函数是否存在。这导致了“两阶段打补丁”（先改错、再修纠）的复杂化冗余。
- **审查裁决**：
  **全面采纳 `plan-03` / `plan-05` 的“时序前置单向收敛”架构，废除 `plan-07` 的后置对账保留方案**！
  - 状态判断必须一步到位：事件流有终态则直接单向覆盖，事件流无终态才执行打断；
  - `reconcile_terminal_conflicts` 函数与 `ReconcileConflict` 结构体物理删除，不再保留任何变体名称，实现真正的架构净收敛；
  - `plan-07` 的静态探针 `check-tool-pairing-invariants.mjs` 应改为断言“源码中绝对不存在 `reconcile_terminal_conflicts` 与 `只上报不修正` 文本”。

---

### 缺陷 4：【真理源事件规范缺漏】冷启动孤儿自愈事件的事件包络断层
- **涉及文档与行号**：
  - `docs/session-integrity-repair/independent-plans/plan-03-crash-recovery-healing.md:106-144`
  - 对比：`docs/session-integrity-repair/independent-plans/plan-01-interrupt-synthesis.md:218-219`
- **缺陷剖析**：
  - `plan-01` §2.1 明确规定了事件不变量：`ToolBatchStart -> ToolStart(call_id) -> ToolEnd(call_id) -> ToolBatchEnd`。
  - `plan-03` 在设计冷启动孤儿自愈 `heal_orphaned_tool_calls` 时，对未闭合调用直接向 `events` 表插入 `tool-end`（载荷 `ToolOutcomeUnknown`）。但如果崩溃发生在工具批分发之前，事件流中根本不存在该调用的 `tool-start` 事件！
  - 单独出现一个孤立的 `tool-end` 事件，将破坏事件溯源时间线的因果闭合，可能导致前端事件还原解析器抛出异常。
- **审查裁决**：
  在 `heal_orphaned_tool_calls` 追加修复事件时，必须先行检查该 `call_id` 是否已有 `tool-start` 事件；若无，必须严格补齐补发 `ToolStart` 事件，再发射 `ToolEnd` 事件，保证事件溯源流的数学级自洽。

---

## 四、具体改进建议与定稿行动项（Actionable Recommendations）

为确保总方案（01）与各分维详案（02~06）坚如磐石，主控与后续方案定稿必须无条件执行以下改进裁决：

### 1. 刚性锁死成对性双层防御模型（架构级决议）
- **决议**：
  废除任何导线层静默修复方案。成对性保障模型统一定稿为：
  - **第一道防线（Handler 级主动合成）**：
    - 在 `executing_tools.rs:49-53` 前置中止处，就地提取未执行 calls 并合成中断结果消息；
    - 在 `streaming.rs:269-280` 流式中止处，对已提交包含 tool_calls 的消息就地合成中断结果消息；
    - 在 `exec_batch.rs:188-191` 彻底删除 `("", "")` 空串兜底，严格按 `calls[i]` 真值回填；
  - **第二道防线（状态机终态收敛全局守门）**：
    - 在 `crates/session-loop/src/loop/loop_exec.rs` 的 `converge` 函数中，接入纯函数式全量扫描 `handlers::reconcile_orphan_tool_calls(&mut self.state, &decision)`，截断一切未闭合调用逃出引擎；
  - **第三道防线（导线层刚性拦截守门）**：
    - 在 `crates/agent-provider/src/request/` 中全面落地 `assert_wire_messages_integrity`，在测试与调试期对任何未配对报文实行硬性 panic 拦截，彻底阻止带毒请求流向网络。

### 2. 全面贯彻持久化单向权威收敛（存储级决议）
- **决议**：
  - 物理切除 `crates/conex-db/src/messages.rs` 与 `import.rs` 中的全量 `DELETE` 语句，全面改用基于 `(session_id, seq)` 的原生 SQL Upsert 与差异收缩；
  - 将 `crates/conex-db/src/events.rs` 的 4 处读取（`query_events`、`query_events_by_run`、`max_sequence`、`query_events_by_type`）全部改道 `ReaderPool` 的 `self.read`；
  - 将 `sessions.rs`（`cleanup_orphan_sessions`）、`import.rs`、`imported.rs` 以及 `cas_gc.rs`（22 处直接写）的所有写操作全部收敛至 `DbWriteHandle::write_blocking`，实现生产写旁路绝对零豁免。

### 3. 彻底根治恢复脑裂，清除妥协残留（编排级决议）
- **决议**：
  - 重构 `crates/orchestrator/src/restore_manager.rs`：前置查询 `events` 表中对应 run 的 `run-terminal` 终态，若存在且为完成态，强制单向覆写 `runs.status = Completed`，绝不盲目打断；
  - 物理删除 `reconcile_terminal_conflicts` 整个函数及其调用的消极警告循环；
  - 物理删除 `struct ReconcileConflict` 与 `RestoreOutcome.reconcile_conflicts` 字段；
  - 物理删除 `restore_snapshot.rs` 中用于快照反序列化 runs 的 4 个死函数；
  - 在冷启动恢复中落地 `heal_orphaned_tool_calls`，且自愈时必须遵循完整的 `ToolStart -> ToolEnd` 事件包络。

### 4. 彻底清退前端历史防御性补丁（前端与门禁级决议）
- **决议**：
  - 物理删除 `apps/crish-desktop/src/api/session-persistence/sessionRustDbWriteGuard.ts` 中的 `isHydrateTruncated` 截断熔断与 CAS 版本戳链；
  - 物理删除 `sessionRustDbTruncationGuard.test.ts`、`sessionAgentsTruncation.ts` 及其测试文件；
  - 升级 `scripts/check-db-write-bypass.mjs`，清退 `cas_gc.rs`、`cleanup_orphan_sessions` 等所有非 DDL 豁免；
  - 建立 `check-session-message-upsert.mjs` 与 `check-tool-pairing-invariants.mjs` 静态探针，接入 `.husky/pre-commit` 与 CI 快层。

---

## 五、评审核验签字表

- **评审人**：主控调度与架构交叉评审组（Agent 01 - 目的性与效果锁闭环专席）
- **评审状态**：【审查完毕 · 明确裁决 · 冻结落盘】
- **产出文件规范**：`c:/Software/conex/docs/session-integrity-repair/plan-reviews/review-01-effect-lock-and-intent.md`（UTF-8 无 BOM）
- **后续协同输入**：本报告直接作为战役阶段四《总方案定稿与分维详案编制》的刚性裁决输入。
