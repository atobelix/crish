# 02 · run 生命周期与事件归属审计

> 战役：2026-08-14 agent-loop-trace-wave（agent 循环全链路可追溯性与原子化观测）
> 维度：run 生命周期与事件归属——从 run 创建到终态的事件序列完整性；run_id 注入全覆盖；中断/恢复/并发场景下事件链的连续性
> 审计方式：内部代码审计（只读），不参考外部软件
> 检查范围：crates/orchestrator（run.rs / events.rs / persist.rs / normalize.rs / restore*.rs / recovery*.rs / subagent_events.rs / blocks.rs）、crates/conex-types/src/events.rs、crates/conex-db（runs.rs / events.rs / schema.rs）、crates/session-loop（loop_exec.rs / loop/handlers/executing_tools.rs）、apps/agent-workbench/src-tauri（core_run_commands.rs / core_query_commands.rs / engine_channels.rs / core_event_bridge.rs / subagent_spawner.rs / bg_events.rs / task_event_consumer.rs / server/core_backend.rs / timers.rs / sched.rs）
> 未检查：前端 TS 消费逻辑（eventUtils.ts 去重/过滤的具体行为）、远端推送面（push/ 模块）的深度逐路径核对、goal_state.rs 纯函数内部。涉及时会明确标注「未核前端」。

---

## 一、结论摘要

**判定：按 run 追溯（从任意节点回溯整条链）目前不畅通。** 会话级追溯（按 sequence 升序重放会话事件流）畅通；run 级追溯断在**持久化层丢 runId** 这一环。

核心链路现状：

| 追溯目标                    | 现状                                                                                                       | 判定                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 会话事件流（sequence 顺序） | events 表 `(session_id, sequence)` 主键，读侧分页重放                                                      | ✅ 畅通                                                                       |
| run 生命周期状态（run 表）  | runs 表 status/end_reason/cursor 齐全，终态唯一收口                                                        | ✅ 畅通                                                                       |
| 单个 run 的完整事件时间线   | **persisted payload 一律不含 runId**（仅 run-terminal 事件体自带），按 run 过滤的查询只能命中 run-terminal | ❌ 不通                                                                       |
| 多 run 并发时的事件归属     | 实时广播有信封 runId；落库/重放流无 runId，混在会话流中无法区分                                            | ❌ 不通                                                                       |
| 中断/恢复后的序列连续性     | restore 取号单调续接，run-interrupted 审计事件留痕                                                         | ✅ 序列连续；但审计事件读侧不可见（见五-4）                                   |
| 终态唯一性                  | run-terminal 唯一且只发一次（terminal_sent + 状态机拒绝再转移 + Q25 复用失败序列）                         | ✅ 终态事件唯一；❌ 但终态后仍有事件落库（审计排空 / 子代理收尾 / goal 续轮） |

**最重要发现（一句话）**：事件信封（runId/sequence）只在**广播时**构造（`core_run_commands.rs:5447` 等 13+ 处手写 `AgentEventEnvelope::new`），**落库时永远只写事件体**（`events.rs:189` `serde_json::to_string(&event)`）——runId 从未进入 events 表；而唯一按 run 过滤的读路径（`read_run_events_impl`，C04 激活）恰好在解析后的信封上过滤 runId，于是几乎只能返回 run-terminal 一条事件。**「广播有归属、落库无归属」是本次审计最大的结构性缺口。**

---

## 二、run 理想事件序列图

### 2.1 记录层（runs 表，无事件发射）

```
start_run（run.rs:543）
  insert_run(run_id, queued) → update(initializing) → update(running)
  （三次落库；F-005 touch 会话 updated_at）
```

### 2.2 事件层（会话级 sequence 单调分配，delta 不落库）

```
seq 1    agent-start                    ← 流首（session.start 源，M14 映射锚点）
seq 2..  turn-start
         message-start                 （Arc 载荷；水合以 message-end 为准）
         message-delta*                ← NonPersistent：不落库不阻塞（T09.1 实时轨 sequence=None 另发）
         tool-batch-start / tool-start / tool-update* / tool-end / tool-batch-end
         message-end                   （携带 turnIndex 分段合并）
         turn-end
         [context-compression-start/end]（end 附带块行索引落库 T-18）
         [approval-requested]          ← 实时先发（sequence=None）+ 收口序列化再发（见五-5）
         [approval-resolved]           （用户决策送达后）
seq N-1  agent-end                     （reason：stop/stopped/max-turns/aborted/error）
seq N    run-terminal                  ← 唯一终态事件，runId 必填（03 §5.1-16）
```

### 2.3 收口层（记录落库，在 run-terminal 落库之后）

```
finalize（run.rs:442）：AgentStop→Completing→(Finalized)→Completed / Failed / Cancelled
  update_run_status(终态, end_reason, cursor=run-terminal 的 sequence)（T08.4）
```

### 2.4 goal 模式变体（打破「流首/流尾」锚点）

```
goal-round-started        ← 在 agent-start **之前**发射（core_run_commands.rs:6623，drive 前）
agent-start … run-terminal
goal-round-completed      ← 在 run-terminal **之后**发射（:3199，收口评估）
goal-continuation-decided ← 在 run-terminal 之后发射（:4688，续轮裁决）
```

### 2.5 失败/取消变体

- 持久化中途失败：`… → run-terminal(failed, event-store-write-failed)` 复用失败序列（Q25 无空洞），run 表 failed。
- 取消：`running →(CancelRequested) cancelling →(CancelConfirmed) cancelled`，终态事件 terminal=cancelled。
- 重启打断：**没有 run-terminal**，只有自定义 `run-interrupted` 审计事件（previousStatus 落库），run 表 failed(daemon-restarted)（见五-4）。

---

## 三、run_id 注入覆盖审计表

信封（runId/sequence/schemaVersion）的构造点清单（`AgentEventEnvelope::new` 全部生产调用点）：

| #   | 构造点                                   | 位置                       | runId              | sequence | 覆盖判定                                                                    |
| --- | ---------------------------------------- | -------------------------- | ------------------ | -------- | --------------------------------------------------------------------------- |
| 1   | drive_run_loop 收口 emit（主路径）       | core_run_commands.rs:5447  | ✅ run_id          | ✅       | 完整（主 run 事件流）                                                       |
| 2   | finalize_failed 终态尽力发射             | core_run_commands.rs:5847  | ✅                 | ✅       | 完整（失败收口）                                                            |
| 3   | emit_envelope_event（goal-* / 熔断观测） | core_run_commands.rs:5789  | ✅                 | ✅       | 完整（emit 通道统一入口）                                                   |
| 4   | emit_approval_resolved                   | core_run_commands.rs:7479  | ✅                 | ✅       | 完整                                                                        |
| 5   | 审批门实时广播（approval-requested）     | core_run_commands.rs:6168  | ✅                 | ❌ None  | **双发问题**（见五-5）                                                      |
| 6   | BridgeAuditSink（security-audit 实时轨） | core_run_commands.rs:1051  | ✅                 | ❌ None  | 落库副本带序列、广播副本无序列（同事件两种 wire 形态）                      |
| 7   | 子代理运行中汇报（progress）             | core_run_commands.rs:3602  | ✅ subagent_run_id | ✅       | 完整                                                                        |
| 8   | BridgeDeltaSink（delta 实时轨）          | engine_channels.rs:633     | ✅                 | ❌ None  | 设计如此（T09.1：前端按 messageId 累加）                                    |
| 9   | timer/cron 缓冲转发                      | engine_channels.rs:493     | ❌ 缺键            | ❌       | 无 run 归属，设计如此；但与文档约定不符（见下）                             |
| 10  | 空闲态事件（手动压缩）                   | core_run_commands.rs:7035  | ❌                 | ✅       | 空闲态无 run 上下文，设计如此（前端按会话域消费）                           |
| 11  | 后台任务事件（task-*）                   | bg_events.rs:259           | ❌                 | ❌       | 会话级存活；task-started 有 ownerRunId 载荷字段，其余 task-* **仅 task_id** |
| 12  | 任务域审计直发                           | task_event_consumer.rs:145 | ❌                 | ❌       | 同上（域隔离，不经 engine audit_sink）                                      |
| 13  | 远端动作审计                             | server/core_backend.rs:252 | ❌                 | ❌       | 远程命令审计，无 run 上下文                                                 |
| 14  | 回收站命令审计                           | core_run_commands.rs:8116  | ❌                 | ❌       | 同上                                                                        |

**缺口汇总**：

1. **持久化丢 runId（最重）**：所有落库路径（events.rs:189/221/246）序列化的是事件体，不是信封。runId 只活在广播时点。→ 直接导致按 run 追溯断裂（见四）。
2. **文档-实现不符（timer/cron 伪 runId 约定）**：conex-types/src/events.rs:1112-1115 文档约定 timer/cron 发射方「置空串或 `timer-<id>` / `cron-<id>` 伪 runId」；实现（engine_channels.rs:493）为 `None` → 序列化时 **runId 键完全缺席**（非空串）。前端 `messageBelongsToRun` 对缺键与空串的判定可能一致，但契约面不符。
3. **normalize_envelope 是「名义统一注入点」而非实际**：normalize.rs 模块自述「orchestrator 所有 emit 出口的统一归一化点」，但生产路径 13 个构造点全部直接 `AgentEventEnvelope::new`，**没有一处调用 normalize_envelope**（仅测试调用）。统一注入语义实际靠各调用点手工重复，未来新增发射点存在漏注入风险。
4. **子代理生命周期事件（subagent-started/ended）只落库、不广播**：subagent_spawner.rs:446-484（emit_started）与 :574-612（emit_ended）仅经 `SubagentEventEmitter` 推入队列（persist + sequence），**不构造信封、不达事件桥**；FlowScheduler（flow_graph.rs:1068/1194）同构。前端实时看到子代理启动/结束依赖其它通道（wait 通道 feed / 会话重放），与 progress（#7，有广播）不对称。**未核前端**子代理卡片是否依赖实时 subagent-started，若依赖则存在实时缺口。
5. **无 runId 缺失可能于主 run 事件路径**（#1-8 的 runId 注入均正确）；缺失集中在「非 run 域事件」与「持久化面」。

---

## 四、按 run 查询路径现状与问题

### 4.1 表结构事实

- events 表主键 `(session_id, sequence)`，无 run_id 列（schema.rs:141-149，v5）。
- payload 为**事件体 JSON**（`{"type":..., "sessionId":..., ...}`，无 runId/sequence/schemaVersion；唯一例外是 run-terminal 事件体自带 runId）。

### 4.2 三条读取路径

| 路径                                                 | 实现                       | 按 run 过滤能力                                                                                               |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| IPC `core_read_session_events`（前端唯一事件读取面） | core_query_commands.rs:528 | 无过滤：`parse_envelopes` 把 body 解析为信封（runId 解析为 None）→ 原样下发。前端拿到的事件**无 runId**。     |
| 远端 C04 `read_run_events_impl`（激活）              | core_run_commands.rs:7540  | 解析 payload 为信封后 `envelope.run_id == Some(run_id)` 过滤 → 因 payload 无 runId，**只命中 run-terminal**。 |
| IPC `core_read_run_events`                           | core_query_commands.rs:568 | 同 C04 逻辑，**已退役**（T-F 06 登记，dead_code）。                                                           |

### 4.3 结论

- **SQL 层面没有按 run 的查询路径**（无 run_id 列）；程序过滤（C04）因落库丢 runId 而失效。
- **多 run 并发**：同一会话内并发 run 的事件在落库流中不可区分归属（实时广播流有 runId 可区分，但无持久化）；前端重放水合时只能按会话整体消费。
- 附带问题：`read_run_events_impl` 的 `next_after_sequence` 取自**过滤后**页末序列——即便 runId 修复，交错会话流中该游标也会跳过其它 run 的事件，分页语义需要按全局序列推进。
- 恢复域事件（recovery-_）、goal 域事件（goal-_）载荷为「契约镜像」形态（recovery 无 type/sessionId 键；goal 无 sessionId 键）——`parse_envelopes` 对 **recovery-*** 事件解析**失败被静默跳过**（缺 sessionId/type），goal-* 可解析但 wire 无 sessionId。文档（normalize.rs:75-76、conex-types events.rs:804 自述「读侧合成信封」）与 `parse_envelopes` 实现**不符**——读侧并没有合成 sessionId（见五-4）。

---

## 五、中断/恢复/并发/终态后的连续性缺口

### 1. 重启中断 → 恢复：序列连续 ✅，但终态事件缺位 ⚠️

- 现状：restore（restore_manager.rs:62-116）把 in-flight（queued/initializing/running/awaiting-approval/cancelling/completing）标记为 failed(daemon-restarted)（cancelling→cancelled），写入 `run-interrupted` 审计事件（`next_sequence` = 已落库 max+1，restore_manager.rs:280-288），cursor = 序列-1；终态/blocked/Unknown 保真不打断。恢复后新 run 取号经 store 端原子计数器隐式预热（max+1）或 seed_sequence 校准，**单调连续、无重复、无空洞**（events.rs:79-83 的 INSERT OR IGNORE 自对齐兜底；与 restore 手动 max+1 的关系在附录推演，无碰撞）。
- 缺口 A：**被打断的 run 没有 run-terminal**。事件流层面「run 终态」的唯一证据是自定义 `run-interrupted`（payload 是 InterruptedRun 记录，**无 type 键、非 AgentEvent 枚举成员**）。`parse_envelopes`（core_query_commands.rs:500）解析失败静默跳过 → 该审计事件在 read 路径**不可见**（只有内存 RestoreOutcome.interrupted 消费 + 日志/留痕）。即：run 表显示 failed，事件流里却没有该 run 的任何终态事件。
- 缺口 B：`next_sequence` 走 query_events 全量扫描（O(n) 全表读 + max），与 `reserve_sequence` 原子计数器两条取号路径并存，语义靠「单连接互斥」维持一致；未来多连接/只读副本场景下存在分歧风险（当前单 Mutex 连接下无实际风险）。

### 2. 恢复后新 run 的事件归属：runId 断裂 ⚠️

- 恢复后新 run 的事件正常带广播 runId；但被打断 run 与后续 run 的事件在落库流中**没有任何边界标记**（没有 run-terminal 分隔，只有一条读不出的 run-interrupted）。从 events 表重建「run A 被中断 → run B 开始」的因果链**不可能**。
- session_agents 残留 running 行归一（restore_manager.rs:125-159）与 FlowScheduler 重建（flow_graph）只解决状态机侧，不产生事件侧证据。

### 3. 并发 run：归属只存在于广播时点 ⚠️

- 取号（T08.12 原子计数器）与 UNIQUE(session_id, sequence) 已闭环，并发无冲突（events.rs:1062-1093 测试锚定）。
- 但归属：并发 run A/B 的事件在落库流中**交错且无 runId**，无法按 run 切分；`core_read_session_events` 返回混合流。前端重放时只能整体应用，无法按 run 过滤（与 events.rs:1096 自述一致：「runId 缺失时前端放行不过滤，多 run 并发过滤失效」——该自述的适用场景正是**重放流**）。

### 4. 自定义事件类型读侧不可见（run-interrupted / recovery-*）⚠️

- `run-interrupted`：无 type 键 → `parse_envelopes` 失败跳过；无专用读路径（D6 §3.3 恢复条目消费的是内存 outcome，不是事件表）。
- recovery-*（recovery.rs:328-405/554-590 直写 append_event）：载荷为字段镜像，**无 type 键、无 sessionId 键**（如 `{"subagentRunId":...}`）→ 同样在 read 路径被静默丢弃。文档自述「读侧合成信封注入 sessionId」与实现不符（parse_envelopes 未合成）。
- 影响：会话事件流重放时，恢复阶梯（escalated/steering/fork/report/budget-denied）与打断审计**全部缺位**——「全链路可追溯」在这些环节是断裂的。

### 5. 终态后仍有事件落库（终态唯一性在事件流层面不严格）⚠️

- run-terminal 事件本体唯一（terminal_sent 守卫 + 状态机终态拒绝再转移 + Q25 复用失败序列，events.rs:943-971 测试锚定）——**终态事件唯一 ✅**。
- 但「终态后还有事件」**确实存在**（均为 session 级序列流，runId 不落库）：
  - **审计排空**：drive_run_loop 在 run-terminal 发射后才 `audit_worker.await`（core_run_commands.rs:5493-5500）与 escape_watch.shutdown 冲刷（:5469-5476）——security-audit 事件在 terminal 之后入队落库（广播带 runId，落库无 runId）。
  - **子代理 run 收尾**：subagent-event(progress) / subagent-ended 在 run-terminal 之后经 `emit_subagent_progress`（:5538）与 `on_subagent_run_terminal`（:5543）发射并落库（progress 为 Delta 不落库；ended 落库）。
  - **goal 续轮**：goal-round-completed / goal-continuation-decided 在 terminal 之后（:5610/:3199、:4688）。
  - **空闲态**：push_emit_idle_event（:7027，手动压缩等）——runId=None。
- 影响：a) 会话流中「run-terminal 是流尾」不成立（仅普通单 run 成立，session_start_end_map 测试只覆盖该形态）；b) 这些尾事件的归属语义未定义（归 run 还是会话？），按 run 切分时间线会少收尾事件、或把相邻 run 的尾事件误收。

### 6. 审批双发（实时 None + 收口带序列）⚠️

- approval-requested 在运行中经审批门广播（sequence=None，core_run_commands.rs:6168），同时 session-loop 在 `executing_tools.rs:252` 把它推入 state.events → drive_outcome 落库 → 收口 emit 时**再次广播**（sequence=N，:5447）。同一事件两种 wire 形态（sequence 缺失/有值）双发。
- T09.1 对 message-delta 有显式 skip（:5440），approval-requested **没有**对应 skip。前端去重若以 sequence 为键（events.rs:1097 自述「sequence 是重放去重与游标的唯一依据」），None 与 N 不匹配，存在重复应用风险。**未核前端** eventUtils/approvalHandlers 是否以 toolCallId 幂等。

### 7. timer/cron 事件完全不落库（与背压分级/域文档不符）⚠️

- timer-fired / timer-cancelled / cron-fired：仅经缓冲 sink（timers.rs:176-196 / sched.rs:263）→ `forward_drained_*`（engine_channels.rs:475-504）**只广播**（信封无 runId/sequence、sessionId 空串），**从不经 EventQueue 落库**。
- 与 conex-types event_backpressure（events.rs:1062-1066：TimerFired/CronFired = Critical「必达落库」）及域文档（「事件仅数据面：落库 + 前端可观测，§4.7」）**矛盾**。
- 影响：会话事件流重放时 timer/cron 历史触发不可见；「数据面落库」承诺未兑现。

### 8. 落库失败路径：链路完整且自洽 ✅（小缺口两处）

- 完整链路（events.rs:376-408/451-487）：任一持久化事件失败 → run 标记 failed(event-store-write-failed)（未终态走 finalize；已终态翻转记录）→ 终态复用失败序列 best-effort 重发（Q25 无空洞）→ cursor=失败序列落库。失败前已落库事件保留，与 failed 状态自洽（run 表与事件流一致，events.rs:905-940 测试锚定）。
- 小缺口 a：`finalize_failed`（core_run_commands.rs:5823）的 runtime-error 用 `queue.push`（非 best-effort）——store 已坏时 push 失败仅 `let _` 吞掉，随后 fail_event_store 若再失败也只打日志；此时 run 记录可能停留在非终态而进程不感知（防御路径尽力而为，但「run 表最终态」无强保证）。
- 小缺口 b：`fail_event_store` 自身依赖 update_run_status 成功；store 彻底损坏（写失败 latch）时该调用也失败 → 上抛 RunError → drive_run_loop 转 finalize_failed → 再次 fail_event_store → 循环风险极低但存在（每次仅日志）。

---

## 六、建议方向（只给方向，不做方案选型）

1. **落库面持久化 runId**：events 表增加 run_id 列（或 payload 落信封全文），写入端在 EventQueue::push 处统一注入，读端（parse_envelopes/水合）天然携带——这是按 run 追溯的地基，其它所有按 run 能力都建立在其上。
2. **修通按 run 查询**：以持久化 runId 为键提供真正的按 run 事件分页（SQL 过滤或程序过滤），并修正过滤后分页游标语义（按全局 sequence 推进）；同步评估退役的 `core_read_run_events` 是否恢复。
3. **收敛 emit 出口**：把所有广播/落库构造点收敛到 normalize_envelope 单一注入点（消除 13+ 处手写 `AgentEventEnvelope::new` 与文档-实现漂移），或至少让 EventQueue 承担「广播 + 落库」双写职责（emit 时注入 runId/sequence，落库时同源）。
4. **终态后尾事件归属定案**：明确 run-terminal 之后的同 runId 尾事件（审计排空/子代理收尾/goal 续轮/空闲态）归属语义——或 run 收口线把尾事件排在 terminal 之前（先 drain 审计、先发 subagent-ended/goal 事件再发 terminal），或引入显式边界（如 run-closed 标记/信封 runId 携带到落库）。
5. **自定义事件类型读侧路由**：run-interrupted 与 recovery-* 要么进入 AgentEvent 枚举（携带 type/sessionId），要么读侧对 event_type 白名单做专用解析（当前 `parse_envelopes` 静默丢弃，追溯链路断裂）。
6. **timer/cron 落库对齐文档**：按 Critical 分级与「数据面落库」承诺把 timer-fired/cron-fired/timer-cancelled 纳入 EventQueue 持久化（或显式修订文档与分级）。
7. **审批双发去重**：对已实时广播的持久化事件（approval-requested 等）在收口 emit 时复用 T09.1 delta 的 skip 机制，避免 sequence=None 与 sequence=N 双形态。
8. **恢复侧取号统一**：restore 的 `next_sequence` 与 reserve_sequence 原子计数器收敛为单一取号通道，消除两条取号路径并存。

---

## 附录：验证边界（检查了什么 / 没检查什么）

**已检查（代码面逐路径）**：orchestrator 全部 run 生命周期/事件/恢复/子代理/恢复域文件；conex-types 信封契约；conex-db 三表 DDL 与 CRUD；session-loop 的 agent-start/end 与 approval 事件入流点；workbench 的 drive_run_loop 收口 emit、finalize_failed、审批门广播、审计 sink、子代理 spawner/flow 事件、任务/审计/远端/回收站 4 条无 runId 广播路径、read_session/read_run 三条读路径、timer/cron 缓冲转发。

**未检查 / 未核**：

- 前端 TS 消费侧（eventUtils.ts 的去重/过滤行为、approvalHandlers 幂等性、subagentHandlers 是否依赖实时 subagent-started）——涉及时在正文标注「未核前端」。
- push/ 远端推送模块对事件的二次加工（D7 推送面）与 ws.rs 事件续传的逐帧核对（测试侧形态已见，生产侧未逐行）。
- goal_state.rs 纯函数内部与 33-event-schema-changelog.md 的演进登记逐条核对。
- 未运行任何测试/构建（只读审计）；全部结论基于代码阅读与既有测试锚点（events.rs / restore_tests* 等），对「parse_envelopes 对 recovery-* 载荷解析失败」的结论依据是 serde tag="type" 的必需性推导，未做运行时验证。

---

_审计子 Agent · 2026-08-14 · 只读检查，未修改任何代码，未提交 git_
