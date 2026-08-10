# D5 — goal 引擎化与完成契约（维度详细设计）

> 目录：docs/continuity-repair/dimensions/
> 日期：2026-08-11
> 定位：本文件为「任务连续性多Agent协同修复方案」维度轮【D5 goal 引擎化与完成契约】的详细设计文档。权威输入：00-总纲-维度设计.md（§3 D5、§4 同批约束、§5 护栏、§6 契约）、01-敲定方案.md（裁决 #9/#10/#11/#14/#21、§2.2 事件、§2.3 RunTaskOptions 字段、§3 第3条、§5 V4）；方案细节输入：proposals/03（核心）、proposals/05（§2B/§2A）；评审输入：reviews/selection-01（分歧3/5）、selection-02（P-8/P-10）、selection-03（S4/M2/M7/M8/M9）；领域输入：05-Goal模式与主动结束后继续能力.md、08-参照系、archive 03-goal-loop（L0-L3）。
> 引用统一为 `文件路径:行号`；行号以抽查当日代码为准，漂移以代码为真源。
> 与敲定冲突处显式标注「⚠️冲突」并给理由；输入未覆盖处记录于 §8 动态决策。

---

## 1. 维度目标与验收断言

### 1.1 目标

解决用户核心诉求 4 的 goal 部分：「goal 模式下未完成任务但 agent 主动结束，系统应能继续」。落地形态为**引擎为权威、前端降级为投影**（00 总纲 §1.2 原则 3、03 方案 §1.2）：goal 状态与判定进引擎（session_meta `goal_state` 键 + 收口 RoundAssessment 纯函数 + 四源 goal_pending 续轮），前端 /goal 循环降级为投影与入口（过渡期 decideGoalContinuation 保留兜底）。

### 1.2 验收断言（00 总纲 §3 D5 最低线细化，可细化不可降低）

| # | 断言 | 来源 | 细化说明 |
|---|---|---|---|
| A1 | goal 未完成 stop 收场 → 自动续轮 | 00 §3 D5 ① | goal_state.active && current_round < max_rounds && reason==Stop → decide_idle_resume 四源命中 goal_pending → spawn_idle_resume_run 拉起 mode=goal-continue 新 run，注入 goal 前缀 + 摘要 nextSteps |
| A2 | 工具批指纹连续相同 ≥ max_stalled_rounds → goal-stalled 终态 | 00 §3 D5 ② | stalled 计数落 goal_state.stalled_rounds；终态 reason=goal-stalled 落库（restore.rs:815 保真匹配命中） |
| A3 | max_rounds 耗尽 → goal-max-rounds | 00 §3 D5 ③ | current_round >= max_rounds → 终态 reason=goal-max-rounds（restore.rs:815 保真）；此后 goal_pending 恒 false |
| A4 | 错误收场不触发 goal_pending；error 轮不计 stalled | 00 §3 D5 ④ / 01 §3 第3条 | reason=Error/MaxTurns/Aborted/Stopped 均不触发（allows_auto_continue 仅 Stop，normalize.rs:177-179）；error 轮不递增 stalled_rounds 与 current_round |
| A5 | 前端发 /goal（不带 maxIterations）→ 引擎 goal_state.max_rounds == 12 | 03 §1.4-1 | 消除 useStreamCallbacks.ts:661 `?? 5` 分叉；引擎缺省 DEFAULT_GOAL_MAX_ROUNDS=12（对齐 GOAL_DEFAULT_MAX_ITERATIONS，goalModeController.ts:16） |
| A6 | checklist 全勾或（无清单且文案 DONE）→ goal-completed 终态，前端投影 phase=completed 且无第二次续轮 | 03 §1.4-4 / 敲定 V4 | 完成轮 run 终态=Completed 类 + reason=goal-completed（03 决策 4）；前端投影 completed 判定兼容（goalModeController.ts:497-509 既有判定复用） |
| A7 | 重启后重读 goal_state：current_round 不归零、续轮从断点继续 | 03 §1.4-6 | run_restore 后惰性重读；重启打断的轮不计 stalled（03 护栏 8） |
| A8 | 事件登记 goal-round-* ×3 与 recovery-* ×5 集中一次（41 → 47/49） | 00 §3 D8① / 01 §2.2 | 六处改动面一次改完（05 §2A：events.rs 变体/engine-events.json/V1_EVENT_TYPES+断言名/fixtures/event_backpressure/changelog + 生成产物） |
| A9 | 子代理 run 不参与 goal 续轮 | 00 §4 / 03 护栏 7 | 沿用 core_run_commands.rs:2872 `active.subagent.is_none()` 判定 |
| A10 | 用户显式停止永不自动续 | 00 §5 护栏 2 | abort_signal / user_touched / reason!=Stop 硬条件保留（core_run_commands.rs:2513-2519） |

---

## 2. 现状基线：三层分裂体（代码核证）

### 2.1 前端——唯一活跃权威

| 项 | 现状 | 证据 |
|---|---|---|
| /goal 进入 | useSlashSend 解析 → createInitialGoalMode → 下发 goal 三字段 | goalModeController.ts:275-287；ConnectionLifecycle.ts:628-631（mode/visibleGoal/maxRounds/maxStalledRounds 已发） |
| 自动续写循环 | decideGoalContinuation 完整决策（checklist 解析、prematureDoneClaim 反假完成、12 轮上限、max_iter toast） | goalModeController.ts:202-273（prematureDoneClaim :232）；useGoalMode.ts:34-77（maybeContinueGoalMode） |
| 生命周期状态机 | transitionGoalLifecycle 纯函数（enter/pause/resume/complete/blocked/exit） | goalModeController.ts:548-813 |
| 默认值 | GOAL_DEFAULT_MAX_ITERATIONS=12、GOAL_DEFAULT_MAX_STALLED_ROUNDS=2 | goalModeController.ts:16、:19 |
| **`?? 5` 分叉（事实修正）** | useStreamCallbacks.ts:661 `maxIterations: liveGm.maxIterations ?? 5` —— goalMode.maxIterations 为可选字段（store/types.ts:503）未设置时实际下发 maxRounds=5 而非 12；buildGoalRunTaskFields 的 12 兜底被短路 | useStreamCallbacks.ts:656-663；goalModeController.ts:28-50 |
| 续写对 error 收场不设防 | decideGoalContinuation 只看 cancelled/session/assistantText，不看 run 是否 error 收场 | goalModeController.ts:202-206；05 领域文档缺口 3 |

### 2.2 引擎——全占位/预留

| 项 | 现状 | 证据 |
|---|---|---|
| RunTaskOptions 无 goal 字段 | visibleGoal/maxRounds/maxStalledRounds serde 静默丢弃；mode 仅日志 | core_run_commands.rs:3121-3143（字段表）、:3715（`mode = %mode` 日志） |
| GoalAuditStrategy 占位 | SteeringPhase::BeforeTurn 存在但无策略注册该相位 | steering/mod.rs:52-61（:58-61 自述「依赖未来 GoalAudit 策略实现」）；prepare_turn 有评估点但恒不触发 |
| GoalComplete 无发射点 | RunLifecycleEvent::GoalComplete 仅测试遍历引用 | run.rs:55-56、:149、:747 |
| allows_auto_continue 零生产调用 | normalize.rs:177-179 仅 Stop 返回 true，无生产调用方（仅测试） | normalize.rs:177-179、:521-525 |
| 收口决策链（run 内 turn 收场） | turn_complete.rs:33-192 五类决策：abort/error 收场(:49-71)、maxTurns(:117-154)、toolCallCount>0 续 turn(:175-178)、默认 SHOULD_STOP(:189-191)；纯文字回复=正常结束 | turn_complete.rs；no_tool_calls.rs:59-63 |
| idle 续 run 三源 | decide_idle_resume 仅队列/定时器/Cron 三源，goal 不在其中 | core_run_commands.rs:2522-2558 |
| 硬条件 | `reason != Stop` 不续（Aborted/Stopped/Error/MaxTurns 全排除） | core_run_commands.rs:2513 |
| blocked 终态 reason 预留 | is_blocked_reason 保真 goal-blocked/goal-max-rounds/goal-stalled（无生产者） | restore.rs:812-817 |
| goal 错误码预留 | conex-types goal 域 3 码：GOAL_STALLED/GOAL_LOOP_DETECTED/GOAL_MAX_ROUNDS | error.rs:182-185 |
| 摘要落库面（无人消费） | Schema V1 summary_json 落 compression_blocks 表（写面完整） | blocks.rs:66-87（update_compression_block_summary）；summary_dispatch.rs:292（summary_json 产出）；summary_coordinator.rs:317-322（载荷字段） |

### 2.3 契约层——TS 孤儿

| 项 | 现状 | 证据 |
|---|---|---|
| 孤儿类型 | GoalContinuationDecision/OrchestratorGoalRunState/GoalRoundAssessmentState/goal-round-* 事件类型齐备但无消费方（agent-orchestrator 已随 Rust 重写删除） | orchestration.ts:36-89；stored-event.ts:14-16 |
| 终态 reason 字面量 | RunOutcomeReason 含 goal-completed/goal-blocked/goal-max-rounds/goal-stalled | orchestration.ts:23-26 |
| Rust 注册表无 goal 事件 | events.rs AgentEvent 41 变体（engine-events.json eventCount 41），无 goal-* 变体 | events.rs:306；contracts/engine-events.json:4 |

### 2.4 三层分裂的后果

- 用户实际走的 product 路径是前端文本环（05 领域文档 §1）；引擎侧 goal 能力全部闲置，`goal_state` 不存在 → 跨重启 goal 环断裂（05 领域文档缺口 5）；
- 前端续写不设防 error 收场 → provider 故障后仍烧轮数（05 领域文档缺口 3）；
- `?? 5` 分叉使「12 轮上限」语义漂移（03 §1.1 事实修正；selection-01 M1、selection-02 P-10）。

---

## 3. 改动设计

### 3.1 RunTaskOptions 三字段透传链

```
前端 /goal ──► ConnectionLifecycle.ts:628-631（camelCase 三字段，现状已发）
   │
   ▼
RunTaskOptions 新增（serde camelCase，缺省 None 向前兼容）：
  visible_goal: Option<String>      // 原 visibleGoal
  max_rounds: Option<u32>           // 原 maxRounds
  max_stalled_rounds: Option<u32>   // 原 maxStalledRounds
  先例：subagent_config 的 #[serde(default, skip_serializing_if = "Option::is_none")]
  （core_run_commands.rs:3141-3142）
   │
   ▼
run_task_impl（core_run_commands.rs:3169 起，:3175-3190 参数取出区同批取出）
   │
   ├─ mode=="goal" && visible_goal 非空 → 装配 goal_state（§3.2）
   │    缺省规则：max_rounds None → 12（DEFAULT_GOAL_MAX_ROUNDS，对齐 goalModeController.ts:16）；
   │    max_stalled_rounds None → 2（对齐 GOAL_DEFAULT_MAX_STALLED_ROUNDS，goalModeController.ts:19）
   └─ 其余 mode → 普通 run，goal_state 不创建不清理（§3.8 模式切换）
```

字段激活后 `core_run_task`（:3145-3151）IPC 面自动生效——`#[tauri::command]` 入参 Deserialize，无需额外登记（命令已存在，仅补字段）。缺省 None 保证旧前端（未发字段）行为与现状一致（05 §4-1 兼容）。

### 3.2 session_meta `goal_state` 键读写

**读写 helper**（新模块建议 `crates/orchestrator/src/goal_state.rs`，或挂 recovery.rs 同域）：

```rust
/// 宽容解析（fail-open）：缺键 → None；坏 JSON → None（对齐 recovery.rs:1286-1292
/// parse_json_list / :327-335 RecoveryBudget::from_json 先例）；字段级容忍：
/// 未知字段忽略、缺省字段用默认值（不引入版本列，对齐 33-changelog「持久化
/// payload 不引入版本列」决策）。
pub fn load_goal_state(store: &dyn Store, session_id: &str) -> Option<GoalState>

pub fn save_goal_state(store: &dyn Store, session_id: &str, state: &GoalState)
```

**读写时机与唯一写方**（05 §2B 纪律，核心约束）：

| 时机 | 操作 | 说明 |
|---|---|---|
| run_task_impl 装配（mode=goal 首轮） | 写 | 创建/覆盖 goal_state（新 /goal 覆盖语义，§3.8） |
| drive_run_loop 收口 RoundAssessment 后 | **写（唯一写方）** | 每轮收口推进 current_round/stalled_rounds/progress_signature/stopped_reason；仅 round 边界写、run 内不写（对齐「run 收口写 SessionHistoryCache」时机纪律，core_run_commands.rs:2714-2718） |
| decide_idle_resume 判定前 | 读 | goal_pending 判定输入（§3.6） |
| run_restore 成功路径后 | 读 | 惰性加载进 CoreRunState 内存面，跨重启续接（03 §1.4-6；对齐 05 #7「run_restore 成功后重读」） |
| 续轮 run 启动（mode=goal-continue） | 读 | spawn_idle_resume_run 从 goal_state 重建注入文本与三字段（§3.7） |

**并发与性能**：会话内串行守卫（core_run_commands.rs:3208-3216）保证同会话单活动 run → 收口写无并发（05 §2B 论证）；LocalDb::get/set_session_meta 为同步 SQLite（sessions.rs:147-177），**全部读写走 spawn_blocking**（01 敲定 §3-5 F2-27 全表；先例 session_commands.rs:269-288、core_run_commands.rs:2958 save_run_usage）。

### 3.3 收口 RoundAssessment 纯函数（D5 核心）

**位置**：`crates/orchestrator` 域新模块（纯函数，无 IO 依赖，直接单测）；调用点在 drive_run_loop 收口（core_run_commands.rs:2861 idle 判定同区、子代理收口 :2844-2852 之后、:2872 判定之前）。**allows_auto_continue 首个生产调用**（normalize.rs:177-179 激活）。

**签名**：

```rust
/// 纯函数：goal 轮次评估。输入 = 收场 reason × 本轮产出 × goal_state；输出 = 决策。
/// 无 IO、无副作用；状态落库与事件发射由壳层（drive_run_loop 收口）负责。
pub struct RoundInput {
    pub end_reason: AgentEndReason,          // RunOutcome.reason（end.rs:102）
    pub assistant_text: String,              // 本轮助手终稿（RunOutcome.messages 尾）
    pub tool_calls: Vec<ToolCallStamp>,      // 本轮工具批（name + 参数顶层 key 集）
    pub tool_success_count: u32,             // 本轮成功工具结果计数（L2 退化证据）
    pub runtime_error: Option<String>,       // runtime-error 事件文案（drive_run_loop:2772-2775 已捕获）
    pub current: GoalState,                  // 评估前 goal_state（读快照）
}

pub struct RoundAssessment {
    pub decision: GoalDecision,              // Continue / Completed / NoProgress / Blocked / NoGoal
    pub stopped_reason: Option<String>,      // 落 goal_state.stopped_reason
    pub reason_detail: String,               // 观测：goal-completed / goal-max-rounds / goal-stalled …
    pub next_progress_signature: Option<String>, // 本轮签名（无工具轮 = 沿用上轮）
    pub stalled_delta: u32,                  // 0 或 1
    pub should_continue: bool,               // allows_auto_continue(end_reason) 生产调用（normalize.rs:177-179）
}

pub enum GoalDecision { Continue, Completed, NoProgress, Blocked, NoGoal }
```

**判定伪代码**（优先级从高到低）：

```
fn assess(input) -> RoundAssessment:
  1. 无 goal：current.status != active → NoGoal（普通会话/已终态，不评估不写）
  2. reason 门禁：end_reason 非 Stop（Error/MaxTurns/Aborted/Stopped）→
       decision = Blocked（reason_detail = 对应原因）
       stalled_delta = 0；current_round 不递增（error 轮不计轮数、不计 stalled——
       01 敲定 §3 第3条；error 收场转 D2 error 分支，不触发 goal_pending）
  3. 轮数上限：current_round + 1 >= max_rounds 且未完成 → Blocked(goal-max-rounds)
       （前端语义对齐 goalModeController.ts:246-257；03 护栏 1）
  4. 完成判定 L0+L1（§3.5）：
       checklist 非空且全勾 → Completed（L1）
       无 checklist && 文案 DONE → Completed（L0 候选收口）
       文案 DONE 但 checklist 未全勾 → 不完成（prematureDoneClaim 对齐，
       goalModeController.ts:232；continue 路径）
  5. stalled 检测（§3.4）：progress_signature 与本轮签名相同 && 无成功工具结果
       → stalled_delta = 1；stalled_rounds + 1 >= max_stalled_rounds → Blocked(goal-stalled)
       否则 NoProgress（continue，stalled 已递增）
  6. 默认 → Continue（needs-continuation）
```

**写回与发射**（壳层收口，在 :2872 判定前调用）：

```
assessment = assess(RoundInput{…})          // 纯函数
goal_state 更新：current_round += 1（Stop 轮）、stalled_rounds += stalled_delta、
  progress_signature = next_progress_signature、stopped_reason = reason_detail、
  status = Completed|Blocked|Active
save_goal_state(spawn_blocking)              // 唯一写方
emit goal-round-completed（§3.9）
若 decision==Completed/Blocked → goal_pending 恒 false（后续判定由 status 拦截）
```

### 3.4 stalled 检测 = 工具批指纹（裁决 #11）

- **签名** = 本轮工具批序列哈希：对每笔工具调用取 `tool_name + 参数 JSON 顶层 key 集合`（排序后拼串），序列整体 FNV-1a 哈希（复用 recovery.rs:251-262 fingerprint 模式）；参数值噪声（时间戳/随机值）被 key 集降级容忍（03 §2D D2、selection-01 分歧 3 附带裁决）。
- **无工具轮 → 签名不变**（不产出新签名，沿用上轮 progress_signature）——纯文字总结轮自动落入「签名相同」轨道，正确计入 stalled（03 §2D 论证：消息 id 链误判率高已弃用）。
- **重置**：本轮有成功工具结果（tool_success_count > 0）→ stalled_rounds=0 并更新签名；签名变化 → stalled_rounds=0。
- **与空转护栏的关系**（01 敲定 #21 分场景并存）：stalled 独立计数管「签名相同无进展」；decide_idle_resume 空转护栏（IDLE_RESUME_MAX_EMPTY_ROUNDS=3，core_run_commands.rs:2571）管「无 AI 产出」（resume_turn_index==0 && resume_tool_calls==0，:2877-2878）——两条独立停机路径（03 护栏 3 注释、selection-03 D3）。
- **error 轮不计 stalled**：§3.3 步骤 2 已拦截（stalled_delta=0）。
- **重启打断的轮不计 stalled**：被打断 run 无收口评估，stalled_rounds 保持（03 护栏 8、动态决策 03-8）。

### 3.5 完成判定 L0+L1（裁决 #10）

| 级别 | 条件 | 本轮实现 | 证据 |
|---|---|---|---|
| L0 文案信号 | DONE /「目标已完成」 | 仅候选；无 checklist 时才可收口 | 与 replyLooksGoalDone 同构（goalModeController.ts:52-56）；archive 03-goal-loop:126 |
| L1 结构化 | checklist 全勾 && 评估通过 | **完成主门禁**：parseChecklistTasks 同构解析（正则 `^\s*[-*]\s+\[[ xX]\]`，goalModeController.ts:103-122；伪任务「本轮总结」丢弃 :22/:114 同构）+ all done | archive 03-goal-loop:127；selection-01 分歧 5 |
| L2 证据 | 策略要求的 tool 成功证据 | **退化为计数**：tool_success_count 进入 goal-round-completed 载荷（evidence 字段），不硬性要求 | 03 §2E「L2 退化为本轮成功 tool 结果计数，成本≈0」 |
| L3 磁盘 oracle | 约定路径/内容/哈希 | **后置**（长程回归设施，不捆绑产品路径） | archive 03-goal-loop:129（「软件内 AI 测试强制」）；selection-01 分歧 5 裁决 |

**反假完成**：文案 DONE 但 checklist 非空且未全勾 → 不 complete（prematureDoneClaim 语义对齐 goalModeController.ts:232）；禁止无证据 markAllGoalTasksDone（goalModeController.ts:150-153 注释纪律在引擎侧同样成立——引擎不因 DONE 勾满任何状态）。

### 3.6 decide_idle_resume 四源扩展（与 D2 同批接线）

**改动区**：core_run_commands.rs:2505-2593（decide_idle_resume），**error 分支（D2）与 goal_pending 分支（D5）同批改完**（01 敲定 §3 第3条、00 §4 同批约束；selection-02 P-8）。

```
:2513  硬条件区（保持，语义扩展为双分支）：
       if abort || user_touched → None                          // 用户停止永不续（护栏2）
       reason==Error && retryable && 预算内 && !熔断 → D2 分支  // 01 敲定 #8/#17（D2 属主）
       reason==Stop → 进入三源 + goal_pending 判定               // D5 分支
       reason∈{MaxTurns, Aborted, Stopped} → None               // 边界写清：Stopped/Aborted 永不误放行（00 §6 契约冲突唯一注意点）

:2555  三源判定后追加 goal_pending 第四源：
       goal_pending = load_goal_state(session).filter(|g|
           g.status == Active
           && g.current_round < g.max_rounds
           && allows_auto_continue(reason))                     // normalize.rs:177-179 首个生产调用
           .is_some()
       且 !(queue_pending || timer_active || cron_enabled) 时独立命中；
       四源任一命中即续

:2583  注入拼接（03 决策 2 注入优先级）：
       queue_pending → 队列条目为主源（drain_pending_to_inject_messages，:2603-2626）
       goal_pending（无队列条目）→ 纯 goal 前缀注入（§3.7）
       队列条目 + goal_pending 并存 → 条目文本在前，goal 前缀拼接其后（一条消息）
```

**子代理不参与**：判定入口沿用 :2872 `active.subagent.is_none()`（03 护栏 7、selection-01 M6）。

### 3.7 续轮注入文本构造（裁决 #7、03 决策 7）

**主源 = goal_state.goal 前缀**（每轮必有），**增强 = 最新 summary_json 的 nextSteps**（有则拼、无则仅前缀）：

```
[目标模式 · 系统指令]
你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。
目标：{goal_state.goal}
当前第 {current_round + 1}/{max_rounds} 轮（自动续写上限 {max_rounds} 轮）。
请工作直至目标实质完成；不要半途停下或只列计划而不执行。
请在回复中维护 markdown 任务清单（`- [ ]` / `- [x]`），便于进度同步。
若目标已完成，请在回复末尾明确写出 DONE 或「目标已完成」。
{nextSteps 增强段（有最新 summary_json 时）：
  上轮进度小结（供续接）：
  - 下一步：{nextSteps 逐条}
}
---
```
（模板对齐 buildGoalModePrefix，goalModeController.ts:74-95）

**nextSteps 读取辅助**（proposals/03 F1，读面镜像写面 blocks.rs:66-87）：

```rust
/// 查询最新 compression_block.summary_json（LocalDb::list_blocks / get_block，
/// conex-db blocks.rs:243/:278），解析 Schema V1 JSON 取 nextSteps/goal；
/// 无块/坏 JSON → None（fail-open，不阻断注入——注入主源是 goal 前缀）。
pub fn read_latest_summary_next_steps(db: &LocalDb, session_id: &str) -> Option<SummaryNextSteps>
```

**续轮 run 装配**：spawn_idle_resume_run（:2637-2671）在 goal_pending 命中时：mode 置 `"goal-continue"`（03 §1.2；与 D2 的 error-retry、现有 idle-resume 的 mode 语义并存，selection-02 §1.3 已确认不冲突）；注入消息 metadata `{kind:"goal-continue"}`；goal 三字段从 goal_state 重建（续轮不再依赖前端下发）。

### 3.8 模式切换语义（03 决策 1 / selection-03 M7）

| 场景 | 行为 | 理由 |
|---|---|---|
| 普通 run（mode 非 goal）收口 | **不评估、不清理 goal_state**（保留挂起状态，用户可再发 /goal 续接） | goal 是会话级长期意图，用户闲聊不应中断或重置它（03 决策 1；与前端「Stop 清 goalMode」现状语义分叉——引擎化后以引擎为准） |
| 新 /goal（mode=goal + visible_goal）下发 | **覆盖旧 goal_state**（新 goal、round 计数归零、新 max_rounds/max_stalled_rounds） | 对齐前端 createInitialGoalMode 语义（goalModeController.ts:275-287）；覆盖由 run_task_impl 装配处执行 |
| goal 完成/blocked 终态 | status=Completed/Blocked 落库；后续 goal_pending 恒 false（A3）；用户可再发 /goal 重新开始 | 03 决策 3：blocked 终态展示缺口保留（tasks 缺口），供用户续跑决策 |
| 重启 | goal_state 重读不清理（A7） | 跨重启续接（05 领域文档 P2-11） |

### 3.9 事件发射点（裁决 #14 集中登记）

| 事件 | 发射点 | 载荷 | 通道 |
|---|---|---|---|
| goal-round-started | run_task_impl 装配 goal_state 后（run 启动，session 级串行上下文） | goal / round（=current_round+1）/ maxRounds | 当前 run 的 BufferedRunEventBridge emit（envelope 带 run_id+sequence，core_run_commands.rs:3263-3266） |
| goal-round-completed | drive_run_loop 收口 RoundAssessment 后（:2872 判定前） | round / 产出统计（toolCallCount、toolSuccessCount、messageCount）/ 评估结论（decision/reasonDetail/stalledDelta）/ evidence（L2 计数） | 同上 |
| goal-continuation-decided | decide_idle_resume 命中 goal_pending（注入拼接处） | 对齐 GoalContinuationDecision：action=continue/complete/block、reason、prompt、progressSignature、detail（orchestration.ts:38-44；progressSignature 与 goal_state.progress_signature 同源——05 §2B「必须同源同函数」） | 同上 |

登记改动面 = 05 §2A 六处 + 生成产物（与 D3 的 recovery-* ×5 同批，禁止分两次；01 敲定 §3 第4条）。事件登记后 Rust 侧 `event_backpressure` 补 goal 域分支，backpressure 全 critical（05 §2A；对齐 timer-fired 先例，changelog 1.5）。

### 3.10 CompletionRequirement 轻量版（08 §3 P1，挂同评估点）

- **评估点**：与 RoundAssessment 同一收口（§3.3 步骤 5/6 之间），独立于 stalled（selection-03 §3.2-3 补充护栏同源）。
- **语义（轻量化）**：goal 未完成 && 本轮**成功工具结果数为 0**（无实质执行）→ 注入「请使用工具实际执行推进，勿仅文字总结」reminder，续轮文本拼接于 goal 前缀之后。
- **独立预算**：内存态计数 `requirement_nudges`（会话级 CoreRunState 字段），每轮最多注入 1 次、累计上限默认 2 次（对齐 grok TodoGate fire 上限思想，08 §1.2 turn.rs:2398-2451）；达上限后不再注入但**不终止 goal**（stalled/max_rounds 仍是停机路径）——轻量版定位为「提醒」而非硬门禁。
- **与 08 全量版差异**（显式降级，非砍项）：全量版需 `completion_requirement {tool, reminder, max_retries, base_delay_ms, max_delay_ms}` 声明与退避重试（grok turn.rs:1509-1647），需 RunTaskOptions/子代理配置扩展；轻量版零字段扩展、零退避，直接服务「半途而废」最低成本兜底。⚠️若后续需必备工具清单，在 RunTaskOptions 加 `required_tools: Option<Vec<String>>`（serde 缺省 None 向前兼容），不破坏本维度冻结的三字段形状。

---

## 4. 数据面

### 4.1 session_meta `goal_state` 键（冻结，01 敲定 §2.1；单写方 = run 收口 RoundAssessment）

```json
{
  "schemaVersion": 1,
  "goal": "修复构建",
  "maxRounds": 12,
  "maxStalledRounds": 2,
  "currentRound": 3,
  "stalledRounds": 0,
  "progressSignature": "tools:fnv1a:7f3a…",
  "stoppedReason": "stop",
  "updatedAtMs": 1789000000000
}
```

- 键命名空间独占 `goal_state`（不复用 recover_* 前缀，05 §2B 纪律；01 敲定 §2.1）。
- 宽容解析 fail-open：缺键=无 goal、坏 JSON=无 goal（recovery.rs:327-335、1286-1292 先例）；内嵌 schemaVersion 仅为自描述，缺省视为 1，不参与迁移判定（05 §4-4）。
- 字段说明：stoppedReason ∈ {stop, goal-completed, goal-max-rounds, goal-stalled, error, max-turns, aborted, stopped}（终态后 status 由 stoppedReason 推断，completedRounds 不单列——避免双计数源，05 §2B 的 completedRounds 字段以 stoppedReason 表达，见 §8 决策 3）。

### 4.2 goal-* 事件载荷（对齐 TS 契约孤儿，05 §2A）

| 事件 | 载荷字段 | 对齐 |
|---|---|---|
| goal-round-started | goal、round、maxRounds | OrchestratorGoalRunState 子集（orchestration.ts:49-60） |
| goal-round-completed | round、decision、reasonDetail、toolCallCount、toolSuccessCount、stalledRounds、evidence | GoalRoundAssessmentState 子集（orchestration.ts:62-89：progress{toolCallCount/toolResultCount}、budget{currentRound/maxRounds/stalledRounds/maxStalledRounds}） |
| goal-continuation-decided | action、reason、prompt、progressSignature、detail | GoalContinuationDecision 全字段（orchestration.ts:38-44） |

### 4.3 RunTaskOptions 新增字段（01 敲定 §2.3）

| 字段 | 类型 | serde | 缺省 |
|---|---|---|---|
| visible_goal | Option\<String\> | camelCase（= visibleGoal） | None（向前兼容，旧前端不发） |
| max_rounds | Option\<u32\> | camelCase（= maxRounds） | None → 装配时取 DEFAULT_GOAL_MAX_ROUNDS=12 |
| max_stalled_rounds | Option\<u32\> | camelCase（= maxStalledRounds） | None → 装配时取 DEFAULT_GOAL_MAX_STALLED_ROUNDS=2 |

### 4.4 nextSteps 读取面（§3.7）

- 读：conex-db `get_block`（blocks.rs:243）/ `list_blocks`（:278）→ 最新块 summary_json → Schema V1 解析（字段 `goal`/`nextSteps`，summary_dispatch.rs:403-408、summary_coordinator.rs:317-322 载荷形状已验证）。
- 写面不动（blocks.rs:66-87 保持现状，D2 一致性：goal_state 是唯一写权威，摘要 goal/nextSteps 保持压缩触发时写入，续轮注入读 goal_state 优先、缺省回退摘要——05 §6 D2 决策）。

---

## 5. 测试策略

### 5.1 单元测试（RoundAssessment 纯函数，无 IO 直接测）

| # | 用例 | 断言 |
|---|---|---|
| U1 | goal 未完成 stop 收场 | decision=Continue、should_continue=true（allows_auto_continue 生产调用首例，normalize.rs:177-179） |
| U2 | checklist 全勾 stop 收场 | Completed（L1）；stoppedReason=goal-completed |
| U3 | 无 checklist 文案 DONE stop 收场 | Completed（L0 收口） |
| U4 | 文案 DONE 但 checklist 未全勾 | 不 Completed → Continue（prematureDoneClaim 对齐） |
| U5 | 工具批指纹连续相同 | stalled_delta=1；达 max_stalled → Blocked(goal-stalled) |
| U6 | 无工具轮（纯文字总结） | 签名沿用 → stalled_delta=1（03 D2 语义） |
| U7 | 成功工具结果重置 stalled | stalled_delta=0、签名更新 |
| U8 | max_rounds 耗尽 | Blocked(goal-max-rounds)；后续评估 should_continue=false |
| U9 | error 收场 | Blocked；stalled_delta=0、current_round 不递增（01 §3 第3条） |
| U10 | max-turns/aborted/stopped 收场 | 不触发 goal_pending（allows_auto_continue 语义） |
| U11 | 无 goal_state / 坏 JSON | NoGoal，不评估不写（fail-open） |
| U12 | L2 退化计数 | tool_success_count 进入载荷 evidence 字段 |

### 5.2 集成测试（引擎壳层）

| # | 用例 | 断言 |
|---|---|---|
| I1 | /goal 三字段透传 | core_run_task 下发 visibleGoal/maxRounds → run_task_impl 装配 goal_state（serde camelCase 激活，ConnectionLifecycle.ts:628-631 已发字段不再丢弃） |
| I2 | goal 未完成 stop 收场 → 自动续轮 | 收口后 spawn_idle_resume_run 拉起 mode=goal-continue 新 run；注入文本含 goal 前缀 |
| I3 | 工具批指纹 stalled → goal-stalled | 连续 max_stalled_rounds 轮签名相同 → 终态 reason=goal-stalled 落库（is_blocked_reason 命中，restore.rs:812-817） |
| I4 | max_rounds 耗尽 → goal-max-rounds | 终态 reason 落库；后续收口 goal_pending 恒 false |
| I5 | 错误收场不触发 goal_pending | provider error 收场 → 无续轮；stalled_rounds/current_round 不变 |
| I6 | error 轮不计 stalled | error 轮之间穿插 stalled 判定，计数不递增 |
| I7 | 重启恢复 | run_restore 后重读 goal_state：current_round 不归零；续轮从断点继续；被打断轮不计 stalled |
| I8 | 模式切换 | 普通 run 收口不清理 goal_state；新 /goal 覆盖旧 goal_state |
| I9 | 事件流 | goal-round-started/completed/continuation-decided 出现在事件流（envelope runId/sequence 注入）；载荷与 TS 契约对齐 |
| I10 | 注入优先级 | 队列条目 + goal_pending 并存 → 条目在前 goal 前缀在后；仅 goal_pending → 纯前缀 |

### 5.3 回归面

- recovery.rs 40+ 单测 + 4 集成测试作接线回归面（01 敲定 §4-4；本次 goal_state 读写/指纹不触碰 recover_* 键）。
- normalize.rs allows_auto_continue 既有测试（normalize.rs:521-525）保持，新增生产调用断言。
- 前端：useStreamCallbacks.ts:661 `?? 5` → 12 后，goalModeController 单测基线不变（GOAL_DEFAULT_MAX_ITERATIONS 已是 12）；npm run typecheck + vitest 门禁。
- 事件登记后 registry_drift 绿 + fixtures 全量解析 + `v1_baseline_has_exactly_4X_event_types` 改名留痕（05 §2A 六处）。

---

## 6. 风险与护栏

| # | 风险 | 护栏 | 证据 |
|---|---|---|---|
| 1 | **goal 轮次 token 成本失控（selection-03 S4）** | 轮数硬上限 max_rounds（默认 12，落 goal_state）+ stalled 上限 + 成本观测（core_get_status goalState.currentRound 投影，05 §2E RecoveryStatus 载荷）；失败尝试不记账（01 §5 护栏 10） | 00 §5 护栏 5/10；03 §5 护栏 1/2 |
| 2 | 空转语义分叉 | 定时器/Cron 空注入不计 streak（待命正常态）vs goal 无产出计入空转且按 stalled 独立计数——实现按唤醒源类型区分计数分支（01 敲定 #21） | 00 §5 护栏 4；selection-03 D3 |
| 3 | 前端双续轮竞态（过渡期） | 引擎事件到达 → 前端以事件为准（投影）；事件缺失 → 前端兜底 decideGoalContinuation；双写竞态由 run 串行守卫兜底（后发者被拒，core_run_commands.rs:3208-3216） | 03 §5 护栏 6 |
| 4 | max_rounds 默认值分叉 | 引擎 goal_state.max_rounds 为准（默认 12）；useStreamCallbacks.ts:661 `?? 5` 统一为 GOAL_DEFAULT_MAX_ITERATIONS（12）——引擎权威后前端数值仅是投影初始值 | selection-01 M1 / selection-02 P-10 |
| 5 | 用户停止误放行 | abort_signal + user_touched + reason!=Stop 硬条件（:2513-2519）扩展至 goal_pending；Stopped/Aborted 边界显式写清（00 §6 契约冲突唯一注意点） | 00 §5 护栏 2 |
| 6 | stalled 误判（参数噪声） | 指纹只取 tool_name + 参数顶层 key 集合（容忍值噪声）；无工具轮签名不变语义正确 | 03 §2D |
| 7 | goal_state 并发写 | 单写方 = run 收口 RoundAssessment；会话串行守卫保证无并发；读-改-写走 spawn_blocking | 05 §2B；01 敲定 §3-5 |
| 8 | 摘要缺失时续轮空洞 | 注入主源 = goal_state.goal（每轮必有），nextSteps 仅「有最新 summary_json」时增强拼接 | 03 决策 7；05 §6 D2 |
| 9 | 重启误判停滞 | 重启打断的轮不参与 stalled 计数（恢复轮不评估） | 03 §5 护栏 8 |
| 10 | 事件登记拆批返工 | 与 D3 recovery-* 集中一次登记（六处改动面），禁止分两批 | 01 敲定 #14 / §3 第4条 |

---

## 7. 与其他维度的接口对接（00 §6 契约表）

| 接口 | 方向 | 契约 | 本维度落点 |
|---|---|---|---|
| decide_idle_resume 分支同批 | D2 ↔ D5 | error 分支（reason==Error&&retryable&&预算内&&!熔断）与 goal_pending 分支（reason==Stop）在 :2513 区域一次改完；error 轮不计 stalled | §3.6；core_run_commands.rs:2505-2593 |
| goal_state 键 | D5 → D6 | 唯一写方 = run 收口 RoundAssessment；会话内串行守卫保证无并发写；D6 watcher/恢复条目只读消费（goal_pending 只是额外拉起源，watcher 本体不依赖 goal 任何部件） | 00 §6；03 §4 D3 |
| 事件登记 | D3/D5 → conex-types | recovery-* ×5 + goal-* ×3 主注册表一次登记；recovery 域走 append_event 直写，goal 域走 envelope emit（前端投影需实时推送，§3.9） | 01 §2.2；05 §2A |
| 队列与拉起器 | D5/D6 共享 | PendingMessageQueue + decide_idle_resume + spawn_idle_resume_run；goal 续轮注入消息 metadata {kind:"goal-continue"}；恢复条目 group_id 前缀与 goal 前缀可合并注入（03 §3 组合语义） | §3.7 |
| 重启恢复 | D6 → D5 | run_restore 后 goal_state 惰性重读进 CoreRunState 内存面；恢复轮不计 stalled | §3.2；03 护栏 8 |
| UI 投影 | D8 → D5 | core_get_status 暴露 GoalStatusSummary（05 §2E）；前端 goalLifecycleToSessionMode 复用（goalModeController.ts:463-474）；goal-completed → phase=completed、goal-max-rounds/goal-stalled → phase=blocked+blockedReason（ui-projections.ts:165-176 展示判定接上） | 03 §1.3；05 §2E |
| 前端 `?? 5` 修正 | D5（投影轮） | useStreamCallbacks.ts:661 统一为 GOAL_DEFAULT_MAX_ITERATIONS（12） | §1.2 A5 |

**V4 核查项（敲定 §5）**：goal-completed 终态 reason 与前端 completed 判定兼容性——完成轮 run 终态 = Completed 类 + reason=goal-completed（run.rs:613-648 状态机映射不动，reason 仅观测区分，03 决策 4）；前端 sessionModeToGoalLifecycle 对 inactive+allDone 判 completed 的既有逻辑（goalModeController.ts:497-509）在投影化后由事件驱动取代，无 schema 破坏；过渡期前端兜底判定（checklist 全勾→done）与引擎判定同构，双写窗口由串行守卫兜底。

---

## 8. 动态决策记录（输入文档未覆盖处的自决与理由）

| # | 问题 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 1 | RoundAssessment 纯函数的放置域 | orchestrator 域新模块（纯函数），壳层 drive_run_loop 收口调用 | 03 选型 A1 已裁决位置；纯函数无 IO 直接单测；orchestrator 域可被壳层与未来内核复用；steering BeforeTurn 相位错位论证成立（03 §2A） | §3.3 |
| 2 | current_round 的递增规则 | 仅正常 Stop 收场轮递增；error/max-turns/aborted/stopped 轮不递增 | error 轮不消耗轮数预算（与「error 轮不计 stalled」同语义，01 §3 第3条精神）；max-turns 是 run 内预算耗尽，goal 轮数预算是跨 run 独立预算，不互斥消耗 | §3.3 |
| 3 | goal_state 键是否含 completedRounds | 不含——stoppedReason 表达完成状态（stoppedReason=goal-completed），避免双计数源 | 05 §2B 形状含 completedRounds；01 敲定 §2.1 冻结形状不含。以敲定冻结形状为准（completedRounds 可由 stoppedReason 推导），键形状与敲定严格一致 | §4.1 |
| 4 | goal-* 事件通道：envelope emit 而非 append_event | 三个事件都经当前 run 的 BufferedRunEventBridge emit（envelope 带 runId/sequence） | 前端投影化消费需要实时推送（03 §1.3）；与 recovery 域「append_event 直写」不同——recovery 事件无需前端实时（05 §6 D1），goal 投影需要。落库由 EventQueue 既有机制保证 | §3.9 |
| 5 | goal-continuation-decided 的发射时序 | 在 decide_idle_resume 命中 goal_pending、注入拼接处发射（:2585-2592 区） | 决策与发射同位，事件承载决策产物（prompt/progressSignature）；run 已移出注册表（:2809-2813）但 bridge 仍持有，可 emit | §3.9 |
| 6 | CompletionRequirement 轻量版输入形态 | 不新增 RunTaskOptions 字段；语义 =「未完成且无成功工具结果」→ reminder 注入，内存态独立预算（上限 2） | 全量版需必备工具清单声明与退避重试（grok turn.rs:1509-1647），字段扩展超出敲定冻结的三字段面；轻量版零扩展直接服务「半途而废」；若未来升级，`required_tools: Option<Vec<String>>` 为向后兼容扩展 | §3.10 |
| 7 | 续轮 run 的 mode 与 goal 字段来源 | mode="goal-continue"（03 §1.2）；goal 三字段从 goal_state 重建，不依赖前端再下发 | 续轮是引擎自主行为，前端可能已关闭页面；goal_state 是权威 | §3.7 |
| 8 | 前端「Stop 清 goalMode」与引擎「普通 run 不清理 goal_state」的语义分叉 | 引擎为权威：普通 run 不清理；前端投影化后以引擎 goal_state 为准 | 03 决策 1（goal 是会话级长期意图）；前端 Stop 清空属现状文本环行为，过渡期双写由「引擎事件优先」裁决 | §3.8 |
| 9 | stalled 阈值默认值 | max_stalled_rounds 默认 2（GOAL_DEFAULT_MAX_STALLED_ROUNDS，goalModeController.ts:19 已是 2；前端传了不用，引擎激活后与前端一致） | 03 §2D「默认 2」；前端常量与引擎默认值已一致，无分叉 | §4.3 |
| 10 | 重启后 goal_state 装载点 | CoreRunState 装配处（run_restore 成功路径后）惰性读取一次进内存面，收口写经 spawn_blocking 回写 | 对齐 03 恢复阶梯 A3 接线点；避免每次判定都走 SQLite（收口判定性能） | §3.2 |

---

## 附：关键证据索引

- 引擎壳层：`apps/agent-workbench/src-tauri/src/core_run_commands.rs`（decide_idle_resume :2505-2593、drain_pending_to_inject_messages :2603-2626、spawn_idle_resume_run :2637-2671、drive_run_loop 收口 :2688-2913、RunTaskOptions :3121-3143、mode 仅日志 :3715、串行守卫 :3208-3216）
- 引擎循环：`crates/session-loop/src/loop/handlers/turn_complete.rs`（:33-192）、`no_tool_calls.rs`（:59-63）、`steering/mod.rs`（:52-61 BeforeTurn 占位）、`loop/end.rs`（RunOutcome :99-125）
- orchestrator：`normalize.rs`（:170-179 allows_auto_continue）、`blocks.rs`（:66-87 摘要写面）、`restore.rs`（:807-817 blocked reason）、`run.rs`（:55-56/:149 GoalComplete 无发射点）
- conex-types：`events.rs`（:306 AgentEvent 41 变体、:867 event_backpressure）、`error.rs`（:182-185 goal 域 3 码）、`contracts/engine-events.json`（eventCount 41）
- 摘要载荷：`summary_dispatch.rs`（:292 summary_json 产出、:403-408 载荷）、`summary_coordinator.rs`（:317-322）、`conex-db/blocks.rs`（:243 get_block、:278 list_blocks）
- 前端：`goalModeController.ts`（:16/:19 默认值、:52-56 replyLooksGoalDone、:103-122 parseChecklistTasks、:202-273 decideGoalContinuation、:232 prematureDoneClaim、:463-474 goalLifecycleToSessionMode、:497-509 completed 判定、:548-813 生命周期）、`useStreamCallbacks.ts`（:656-663 `?? 5`）、`ConnectionLifecycle.ts`（:628-631 三字段已发）、`useGoalMode.ts`（:34-77）
- TS 契约（孤儿）：`packages/shared-types/src/orchestration.ts`（:23-26 终态字面量、:36-89 三类型）、`stored-event.ts`（:14-16）
- 门禁定义：`docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md`（§4.1 L0-L3 :126-129）
- 参照系：`docs/continuity-repair/08-参照系任务连续性能力对比.md`（§1.2 grok CompletionRequirement/TodoGate、§3 P1）

> 本文档为只读分析产出（唯一写面）；未修改任何代码、未执行任何 git 操作。行号以抽查当日代码为准，如漂移以代码为真源。
