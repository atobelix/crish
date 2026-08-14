# 08 · 恢复/重试与 steering 可追溯 —— 可追溯性与原子化观测审计

> 战役：agent 循环过程的全链路可追溯性与原子化观测（2026-08-14）
> 维度：恢复四级阶梯（自动重试→steering→fork→上报）的事件记录；steering 注入链路；goal 评估闭环；
> 恢复预算拒绝；运行时干预
> 审计方式：只读代码检查，不参考任何外部软件。产出本文档，不修改代码、不提交 git。
> 审计范围：`crates/conex-types/src/events.rs`（recovery-* ×5 / goal-* ×3 / RuntimeSteering /
> RuntimeInterventionRequired）、`crates/orchestrator/src/recovery*.rs`（coordinator/policy/
> store/notify）、`crates/orchestrator/src/goal_state.rs`、`crates/orchestrator/src/steering_queue.rs`、
> `crates/orchestrator/src/normalize.rs`、`crates/session-loop/src/steering/`（coordinator/strategy/
> nudge/diagnostics）、`crates/session-loop/src/safe_point.rs`、`control.rs`、
> `apps/agent-workbench/src-tauri/src/core_run_commands.rs`（D3 接线 / goal 收口 / 熔断）、
> `crates/orchestrator/src/lifecycle.rs`（resume/fork 消费端）、`crates/orchestrator/src/task_events.rs`、
> `apps/crish-desktop/`（continuityHandlers / diagnosticHandlers / continuityUiStore）、
> `docs/continuity-repair/`（D8 §3.2 设计对照）
> 说明：本文档只写入**实际查证过**的内容；未逐一验证的点明确标注「未验证」。

---

## 一、结论摘要

**判定：「恢复/重试链路"全程"可追溯 —— 否。写面完备、读面断裂、阶梯 1 粒度缺失、干预闭环缺失。** 逐层拆解：

1. **写面（事件落库）基本完备**：四级阶梯各有专属事件（recovery-* ×5），goal 三事件实时发射，
   steering 注入有 runtime-steering（含消息全文），预算拒绝有 recovery-budget-denied（双发射方），
   熔断有 recovery-escalated（detail=circuit-trip）。事件契约、注册表、背压分级、归一化位齐全
   （events.rs:801-949、normalize.rs:77-86）。

2. **读面断裂（最大缺口）**：子代理侧 recovery-* 事件经 `RecoveryStore::append_event` 以
   **body-only payload（无 `type` 标签）** 直写 events 表（recovery_store.rs:59-76）；
   而前端唯一事件读取面 `core_read_session_events` → `parse_envelopes` 只按
   `AgentEventEnvelope` 解析、**失败即静默丢弃**（core_query_commands.rs:500-508）。
   D8 文档 §3.2 设计的「body-only → 信封合成 fallback」（D8-观测UI与口径.md:163-190）**未实现**，
   代码里没有该分支。后果：子代理侧 escalated/steering/fork/report/budget-denied 事件
   **前端事件流读不到**（仅 D1 熔断侧 escalated 与 D2 主 run 侧 budget-denied 走
   emit_envelope_event 实时通道可读）。前端对四类 recovery 事件是「登记面显式空实现」
   （continuityHandlers.ts:142-171），且文档注释自己也承认"数据源缺位时失败卡片降级"。

3. **阶梯 1（自动重试）粒度缺失**：每次重试本身**无事件**——生产实现为「收口后重派新 run
   （mode=recovery-retry）」（core_run_commands.rs:3460-3535），成功路径只有 tracing::info；
   重试计数为进程内记账（ladder1_retry_count，重启清零），代码注释明言
   「阶梯 1 不留痕是既有语义」（core_run_commands.rs:2650-2653）。重试→重派的新 run 与原 run
   之间**无结构化关联字段**（信封 runId 各自独立）。

4. **运行时干预闭环缺失**：RuntimeInterventionRequired 的 choices（rollback/pause/user-instruction）
   **无任何消费方**——桌面端 handler 是显式空实现（diagnosticHandlers.ts:34-38「暂无 UI 落地」）；
   用户后续操作（新消息/取消）走正常通道入事件，但「用户选择了干预选项」本身**无事件、无记录**。

5. **goal 评估闭环良好（域内）**：assess_round 纯函数（L0+L1 门禁 / 轮数上限 / stalled 指纹）→
   goal-round-started/completed 实时发射 + goal_state 键落库 + 续轮注入文本（metadata
   {kind:"goal-continue"}）+ 前端投影（continuityHandlers）——链条完整。
   **缺口**：goal-continuation-decided 只覆盖 continue 路径（action 恒为 "continue"），
   Completed/Blocked/NoProgress 的收口决策不发射该事件（仅 goal-round-completed 的 decision 字段）。

6. **文档与实现漂移**：recovery.rs:57-62 头部注释声称「C7 生产未接线：当前无调用方」，
   但 D3 实现后生产接线已存在（coordinator_for / decide_subagent_recovery /
   execute_subagent_recovery / restore_steering_notifications 均已在 core_run_commands.rs 接线，
   如 :5525-5536、:2561-2648）。审计者若信注释会得出「整条链不生效」的错误结论——注释需更新。

---

## 二、恢复四级阶梯事件链对照表

| 阶梯/阶段              | 触发/执行                                                                                                                                                                           | 事件                                                                                                                                                                                | 现状                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 阶梯 1 自动重试 · 判定 | `ladder1_decision`：瞬态四类（RateLimit/ServerError/Timeout/Network）+ 次数 + 60s 总预算 + 已产出内容不重试（recovery_policy.rs:96-134）                                            | **无每次重试事件**                                                                                                                                                                  | 判定在协调器内，返回 `AutoRetry{attempt, delay}`；无事件                                                                              |
| 阶梯 1 · 执行          | 生产 = 收口后重派新 run（mode=recovery-retry，不消费 Episode）（core_run_commands.rs:3460-3535）                                                                                    | **无事件**；仅 tracing::info（:3504-3511 带 from_run_id/new_run_id/retries）                                                                                                        | 原 run end_reason 覆写 recovery-retry（runs 表可查）；新 run 有 agent-start；**两 run 无结构化关联字段**                              |
| 阶梯 1 → 阶梯 2 边界   | Escalate 分支（NonTransient/ContentProduced/BudgetExhausted/RetriesExhausted）                                                                                                      | `recovery-escalated`（append_event 裸写；kind=原因 Debug 形态、retries、elapsedMs、subagentRunId=Some）                                                                             | 写面有；**读面不可达**（见结论 2）；kind 用 Debug 名（"NonTransient" 等）非规范 wire 值                                               |
| 阶梯 2 steering 激活   | `escalate`：steering 条目入队（PendingMessageQueue，group=`recovery-<run_id>` 去重）+ 通知落库 `recover_notifications`（pending=true）+ 事件（recovery.rs:371-410）                 | `recovery-steering`（RecoveryNotification 全字段镜像：subagentId/runId/fingerprint/retries/remainingStatus/pending/createdAtMs）                                                    | 写面有；**读面不可达**；steering 条目经主 agent 下一 run 收口注入（drain_pending_to_inject_messages）可观测                           |
| 阶梯 2 处理确认        | `acknowledge`（pending→false，重启不重排）（recovery.rs:605-617）                                                                                                                   | **无事件**                                                                                                                                                                          | 状态变化仅落 session_meta；「主 agent 已处理该通知」无留痕                                                                            |
| 阶梯 2 重启重排        | `restore_steering_notifications`                                                                                                                                                    | **无事件**；仅日志「恢复阶梯 2 通知重排完成」（core_run_commands.rs:3774-3779）                                                                                                     | 重排条数有日志；事件面无记录                                                                                                          |
| 阶梯 3 fork            | `fork_and_reassign`：幂等（同指纹同源已 fork 返回既有）→ Episode 预算检查 → SessionTree.fork → spawner 新 run → 原 run 置 failed（end_reason=recovery-fork）（recovery.rs:420-565） | `recovery-fork`（ForkRecord 全字段：fingerprint/from_run_id/from_leaf_id/new_run_id/new_leaf_id/context_mode）                                                                      | 写面有；**读面不可达**；字段关联最全（新旧 run/leaf 齐备）；生产入口 = resume_subagent 命令面（lifecycle.rs:420-447）                 |
| 阶梯 4 上报用户        | `report_to_user`：`recover_needs_user` 标记 + UserReport（attempts 聚合阶梯 1/2/3 明细 + 固定建议文案）（recovery.rs:572-601、recovery_notify.rs:236-289）                          | `recovery-report`（subagentId/runId/stuckAtMs/suggestion）                                                                                                                          | 写面有；**读面不可达**；attempts 明细**不在事件载荷**（注释明言前端失败卡片经 escalated/run 终态取数——而 escalated 读不到，取数落空） |
| 预算拒绝（子代理侧）   | `can_recover` 失败 → 直接阶梯 4（禁阶梯 2 通知）（recovery.rs:345-364）                                                                                                             | `recovery-budget-denied`（subagentRunId=Some，append_event 裸写）                                                                                                                   | 写面有；**读面不可达**；同时计入 denied_stats 月度统计（进程级）                                                                      |
| 预算拒绝（主 run 侧）  | D2 续 run/内容续写预算耗尽（consume_resume_episode）                                                                                                                                | `recovery-budget-denied`（subagentRunId=None，emit_envelope_event 实时，core_run_commands.rs:4711-4727）                                                                            | **可读**（实时通道）                                                                                                                  |
| 熔断侧                 | D1 熔断触发边沿（update_provider_fail_streak 跨阈值）                                                                                                                               | `recovery-escalated`（subagentRunId=None、detail="circuit-trip"，emit_envelope_event 实时，core_run_commands.rs:4734-4766）+ `runtime-intervention-required`（reason=circuit-trip） | **可读**；前端熔断横幅消费（continuityUiStore raiseCircuitBanner）                                                                    |

**结论**：四阶梯的「写面事件」全覆盖（含边界与拒绝路径），但其中 **4/5 类子代理侧事件读不到**；
阶梯 1 的重试粒度（每次 attempt/delay）与阶梯 2 的 acknowledge 动作**无事件**。

---

## 三、steering 注入闭环审计

### 3.1 注入闭环（运行期 steering：RecoverySteeringStrategy）

- **触发原因**：`after-tools`（连续工具错误环 ≥2 / 重复调用环 ≥3，strategy.rs:146-207）与
  `empty-response`（D7）。驱动循环集成点：prepare_turn.rs:87-107（AfterTools/BeforeTurn，
  D3 预注入短路）+ steering_evaluation.rs:26-80（EmptyResponse，预算耗尽/干预时 stop 收场不 error）。
- **注入消息**：`build_steering_message`（system 角色，metadata {kind:"runtime-steering", reason,
  steeringCount=注入后计数}，nudge.rs:91-106）——注入文本双语、可读。
- **事件**：`runtime-steering`（reason + 完整 AgentMessage 全文，mod.rs:285-290）。
- **agent 后续响应**：注入消息 append 进 conversation（P1 append-only 不变量），后续
  turn/message 事件照常发射——响应可经 message-end/turn-end 观测。
- **闭合性判定**：reason → 注入文本 → 计数 → 响应，「触发原因到响应」链路**可闭合**
  （事件 + 对话双重可见）。**缺口**：无「注入后 agent 是否恢复」的结构化结果事件——恢复与否
  只能人工从后续事件推断；`reset()`（工具批全成功等重置预算）为隐式行为，无事件。
- **预算耗尽不静默**：inject-message 超预算时产 `EmitDiagnostic`（reason=steering-budget-exhausted，
  载荷含 phase/budget/steeringCount，mod.rs:238-248）→ runtime-steering 事件（metadata kind=diagnostic）
  ——频率限制**可观测**（好的反例）。

### 3.2 nudge 通道（D8：排入下一条用户消息）

- 机制：PendingNudgeChannel → `enqueue_into_input_queue(mode=FollowUp)`（followUp 环仅 idle
  promote 后消费）→ `into_user_message`（user 角色，metadata {kind:"nudge", reason}，id 沿用幂等，
  nudge.rs:148-163）；或经 PendingMessageQueue::drain_nudges 转 steering 条目（按 reason 分组去重，
  steering_queue.rs:221-235）。
- **观测性**：nudge 作为用户消息注入后经 message-start/end 可见（metadata kind=nudge 可检索）。
  **缺口**：nudge 的**入队动作本身无事件**（PendingNudgeChannel 纯内存，无 append_event）——
  「产生 nudge → 何时排入队列」只有队列进程内状态；若 run 未 idle 导致 promote 延迟/未发生，
  该 nudge 是否最终送达无持久记录。容量覆盖（满 50 条覆盖最旧）同样无痕。

### 3.3 子代理运行中注入（C8/M8）

- `request_subagent_inject`（control.rs:275-286）：user 消息经 L1 steer 环下一安全点注入，
  reason 带 `subagent_inject:<id>` 标识、id 带自增序号（subagent-inject:<id>:<seq>）——消息本身
  可观测（message 事件 + id 检索）。**未验证**：注入消息进入目标 run 对话后的端到端事件链
  （子代理 run 的事件流归属）——未逐事件实测。

### 3.4 steering 注入链路（recovery 阶梯 2 的 steering 条目）

- 阶梯 2 steering 条目（group=recovery-<run_id>）由主 agent 下一 run 收口
  `drain_pending_to_inject_messages` 批量转出（合并注入上限 ≤16 条、超出注明省略 N 条，
  core_run_commands.rs:4776-4810）；省略轨迹不丢依赖 recover_notifications 落库冗余。
- 注入消息 metadata {kind:"steering"}；主 agent 响应可经消息事件观测。

---

## 四、goal 评估闭环审计

### 4.1 评估逻辑（goal_state.rs，纯函数，测试完备 U1-U12）

- 判定优先级：NoGoal → reason 门禁（非 Stop → Blocked，error 轮不计轮数/不计 stalled）→
  L0/L1 完成（checklist 全勾 / 无 checklist 文案 DONE；文案 DONE 但清单未全勾 = 不完成）→
  轮数上限（current_round+1 >= max_rounds → goal-max-rounds）→ stalled（工具批指纹
  `tools:fnv1a:<hex>` 相同且无成功结果 → +1，达 max_stalled_rounds → goal-stalled）→ 默认 Continue
  （goal_state.rs:324-429）。
- 状态：session_meta `goal_state` 键（schemaVersion=1，字段级 fail-open），advance 写回
  （仅 Stop 轮 current_round+1）。

### 4.2 事件闭环

| 环节                  | 事件                                                                                                                                                                                                            | 现状                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| run 启动（mode=goal） | `goal-round-started`（round=1, maxRounds, goal；emit_envelope_event 实时，core_run_commands.rs:6622-6635）                                                                                                      | 可读；前端投影（continuityHandlers onGoalRoundStarted）                                                                   |
| 每轮收口评估          | `goal-round-completed`（round=评估前 current_round+1, toolCallCount, toolSuccessCount, messageCount, decision, reasonDetail, stalledDelta, evidence=tool_success_count 字符串；core_run_commands.rs:3163-3201） | 可读；**每轮必发**（NoGoal 除外——无 goal/终态不评估不写）；decision ∈ Continue/Completed/NoProgress/Blocked/NoGoal        |
| 续轮决策              | `goal-continuation-decided`（action 恒 "continue", reason="needs-continuation", prompt=注入文本, progressSignature；core_run_commands.rs:4683-4699）                                                            | 可读；**仅命中 goal_pending（进行中+未达上限+stop 收场）时发射**；Completed/Blocked/NoProgress 不发射本事件               |
| 续轮注入文本          | goal_continue_message（user 角色，metadata {kind:"goal-continue"}，core_run_commands.rs:4667-4678）                                                                                                             | 注入后可经消息事件观测；文本含上轮进度小结（next_steps）                                                                  |
| 前端投影              | onGoalRoundStarted/Completed/ContinuationDecided → patchSession goalMode                                                                                                                                        | 已实现（continuityHandlers.ts:44-99）；sessionId 取自信封 raw（envelope 事件不列 sessionId 变体字段，normalize.rs:84-86） |

### 4.3 缺口

1. `goal-continuation-decided` 语义与 TS `GoalContinuationDecision`（action 含 continue/complete/
   stop 等，orchestration.ts:38-44）**不对齐**：Rust 侧 action 恒为 "continue"，Completed/Blocked
   的「决策」不发射该事件——「轮次决策全集」需靠 goal-round-completed.decision 拼装，两事件
   的语义边界（"本轮结果" vs "下一步动作"）在载荷上重合度高、区分度低。
2. `evidence` 字段 = tool_success_count 的字符串化（core_run_commands.rs:3197），信息量单薄
   （非工具批指纹/非 checklist 明细）。
3. `goal-round-completed` 的 round 与 goal_state.current_round 存在「error 轮 round 序号按本轮计、
   current_round 不递增」的分叉（:3187-3190 注释承认）——同一语义两个口径，消费方需知悉。
4. 前端投影依赖实时通道（BufferedRunEventBridge），重启后 goal 状态靠 goal_state 键投影
   （core_get_status 恢复域，D8 §3.3）——两条数据源的一致性**未验证**。

---

## 五、预算/限制/干预路径缺口

| 路径                    | 机制                                                                                                                                  | 事件/留痕                                                                                         | 判定                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 恢复预算（Episode）拒绝 | RecoveryBudget（recover_max_episodes 默认 3，recover_episodes 计数，指纹=subagent_id+任务哈希）                                       | recovery-budget-denied（双发射方：子代理侧裸写不可读 / 主 run 侧实时可读）+ denied_stats 月度统计 | 写面有；子代理侧读不到                                                                                                                                              |
| steering 预算耗尽       | SteeringCoordinator max_steering_budget=3；策略层 maxSteeringMessages=1                                                               | steering-budget-exhausted 诊断事件（runtime-steering，kind=diagnostic）                           | **可观测**（反例标杆）                                                                                                                                              |
| 自终止诊断              | SelfTerminationDiagnostic（D2 删除 tool-promise 计数后 promised_tools_without_call 恒 0，should_emit 恒 false，diagnostics.rs:54-56） | **无事件（死路径）**                                                                              | 结构保留、契约不触发；「诊断条件默认不触发」已注释明言，非缺陷而是现状                                                                                              |
| 阶梯 1 重试频率         | 退避 750ms 起/8s 封顶/60s 预算；ladder1_retry_count 进程内记账（重启清零）                                                            | 每次重试无事件；仅 escalate 时的 retries/elapsedMs 汇总                                           | 频率限制过程不可观测（粒度缺失）                                                                                                                                    |
| 续 run 退避（D2）       | backoff_delay_for + sleep_resume_backoff                                                                                              | 无事件（仅预算拒绝有事件）                                                                        | 与阶梯 1 同类缺口                                                                                                                                                   |
| 运行时干预              | RuntimeInterventionRequired（reason/choices=[rollback,pause,user-instruction]/message）                                               | 事件照发；run 以 stop 收场（D7/D9，steering_evaluation.rs:68-75）                                 | 事件可读（实时通道，Critical）；**choices 无消费方**（桌面 handler 空实现 diagnosticHandlers.ts:34-38；熔断侧另走 UI 横幅，仅进程内 UI 态非持久化）                 |
| 干预后继续              | 用户选择 → 无结构化路径                                                                                                               | 「用户选择了什么」**无事件、无记录**                                                              | 闭环缺失：run 停后靠用户发新消息/取消，选择结果不可追溯                                                                                                             |
| 任务失败衔接            | task-failed（Critical 必达）→ 唤醒摘要 steering 条目（task_wake_summary）                                                             | 审计留痕 + 注入可观测                                                                             | `steer_for_task_failed`（task_events.rs:200）**v1 不启用**（task_event_consumer.rs:18-19：C7 与 recovery 阶梯 2 衔接留 v2）——后台任务失败暂不接恢复阶梯，仅唤醒注入 |

---

## 六、建议方向（只给方向，不做方案选型）

1. **恢复事件读面打通**（最高优先）：D8 §3.2 的「body-only payload → 信封合成」fallback 设计
   已有（文档伪代码），落地为 parse_envelopes 的宽容分支（type 缺省用 event_type、sessionId 用
   行级列），配单测锁定；或写面改 envelope 形状——二选一，须保证 41 基线事件行为不变。
2. **阶梯 1 重试粒度观测**：为每次自动重试（attempt/delay/剩余预算）增加原子事件
   （或至少在 escalate 事件中补全 attempt 明细），并把 ladder1_retry_count 从进程内记账
   改为持久化（重启后跨 run 计数可追溯）。
3. **阶梯 2 acknowledge 留痕**：pending→false 状态翻转补事件，闭合「主 agent 已处理该通知」
   的动作链。
4. **干预闭环**：为 RuntimeInterventionRequired 的 choices 补真实消费面（rollback/pause/
   user-instruction 至少可落库），并定义「用户选择 → 恢复动作」的事件（如 reuse 现有
   run_control 或新增 decision 事件）。
5. **goal 事件语义收敛**：goal-continuation-decided 扩展覆盖全部决策（或明确仅 continue 的
   契约并改名），消除与 TS GoalContinuationDecision 的漂移；round 双口径（序号 vs current_round）
   收敛为单一口径。
6. **recovery.rs 头部注释更新**：删/改「生产未接线」过时声明，避免审计与排查被误导
   （文档-实现漂移本身伤害可追溯性）。
7. **重派/新 run 关联字段**：阶梯 1 重派的新 run 与原 run 建立结构化关联
   （如 runs 表扩展或事件载荷带 from_run_id——recovery-fork 已有先例可参照）。
8. **nudge 通道持久化**：nudge 入队动作补原子留痕（或复用事件表），避免「产生但未送达」
   无迹可查。

---

## 附：检查了什么 / 没检查什么

**检查了**：上述「审计范围」列出的全部文件（源码 + 单测 + 生产接线点 + 前端 handler + D8 设计文档）。
关键结论均有文件:行号证据（见正文）。**未验证**：未运行程序实测事件流；未检查
core_get_status 恢复域投影与 goal_state 键的一致性；未验证子代理 run 事件流的端到端信封归属；
未对 device 侧（移动端）recovery 事件 redact 策略的影响做完整核查（device/events.rs 已见
recovery-fork=Transparent、其余=Redacted 的静态判定）。
