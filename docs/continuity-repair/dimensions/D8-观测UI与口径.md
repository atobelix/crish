# D8 — 观测、UI 与口径（维度详细设计）

> 目录：docs/continuity-repair/dimensions/
> 日期：2026-08-11
> 定位：任务连续性多 Agent 协同修复方案·维度文档（D8）。本维度是**横切维度**——让恢复/续跑能力被用户看见（UI）、被事件检索（数据面）、被文档正名（口径）。
> 输入：00-总纲-维度设计.md、01-敲定方案.md、proposals/01、05、reviews/selection-01~03、领域分析 03/05、docs/rust-rewrite/33-event-schema-changelog.md。
> 引用统一为 `文件路径:行号`；行号以抽查当日代码为准，漂移以代码为真源。
> **派单拆分**（02-定夺 评审02 采纳）：**D8a 事件登记+检索簇**（轮 1，与 D3/D5 同批）、**D8b UI 簇**（随 D4）、**D8c 口径簇**（可并入 D5 或 D8b）。

---

## 0. 结论速览

1. **事件登记收口（41 → 49）**：recovery-* ×5 + goal-* ×3 一次集中登记，改动面实测为 **9 处 + 生成产物**——05 方案列出的「六处」漏了 `registry_drift.rs` 硬编码 41 断言、`events_roundtrip.rs` 穷举构造、`event_hook_mapping.rs` 划分断言三处测试面（本文档 §3.1 给出逐文件清单）。
2. **检索面存在一个 05 未覆盖的架构事实**：`RecoveryStore::append_event` 直写的是**无 type 的事件体**（recovery.rs:635-651 只有 payload 无信封），而 `core_read_session_events` 的 `parse_envelopes` 只解析**信封形 payload**（core_query_commands.rs:483-491）——登记后若不处理读面，恢复事件仍然「被检索」不了。本维度裁决：读面合成（不改写面），见 §3.2 与动态决策 D-2。
3. **core_get_status 恢复域**：`RecoveryStatus`（recoverNeedsUser / recoverEpisodes / pendingRecoveries）+ `GoalStatusSummary`（goal/maxRounds/currentRound/stalledRounds/maxStalledRounds/stoppedReason），数据源 = RecoveryCoordinator 内存态访问器（recovery.rs:884-904）+ goal_state 键。
4. **前端**：失败态卡片（错误 kind/重试次数 + resume/kill/kill_all 按钮，消费 D4 命令面）+ 恢复状态行（「需人工介入」横幅）；goal 前端投影化过渡（useGoalMode 消费 goal-round-* 事件，decideGoalContinuation 保留为过渡兼容）；`useStreamCallbacks.ts:661` 的 `?? 5` 修正为**验收项**（02-定夺 M1：实现归 D5，本维度复核）。
5. **水合契约**（本维度定义，D7 接线）：error 态放行 + metadata `{kind:"failed-turn"}`，无 schema 改动；既有测试 `incomplete_and_error_status_entries_skipped`（hydrate.rs:376-387）必须改写。
6. **口径修正**：AGENTS.md 行 23/48 两处「一轮最多 12 个子 Agent」→「同时运行（未终态）子代理 ≤16、同父 ≤16、深度仅 1（16/16/1）」（引擎真值 `DEFAULT_RECURSION_GUARD` 16/16/1，subagent.rs:497-501；12/5→16/16 为用户补充需求扩额，E0 E3-3 裁决）。
7. **子代理运行中汇报展示（E3-2 扩展项）**：subagentHandlers.ts 消费面已现成（subagent-event 三 kind，45-59、131-144），生产零发射时仅终态可达；D3 §3.2.6 汇报接线后 progress 增量事件到达——「汇报进展展示」标注为 **D8b UI 簇扩展项**（§3.7.3），非本轮 D8 必做清单。
8. **命令条数基线**：107/102/5 → **108/103/5**（E2 扩展 `core_compact_now` 经 D4 双端四步登记轮计入，E2 §7.3 / D4 §3.1；本维度只跟踪口径，不重复登记）。

---

## 1. 维度目标与验收断言

> 00 总纲 §3 D8 最低线：事件注册表 + fixtures + changelog 一致（registry_drift 绿）；core_get_status 含恢复域字段；失败态卡片可操作 resume/kill；AGENTS.md 口径更新。本节细化但**不降低**。

### 1.1 维度目标（六项，对应任务书①-⑥）

| #   | 目标                                                                                                                                                 | 属主/共享                                         | 文件域                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| ①   | 事件登记收口：recovery-* ×5 + goal-* ×3 一次集中登记（41→49）；recovery 域走 append_event 直写不改造 emit 层                                         | 随 D3/D5 同批（敲定 #14）                         | conex-types 全家 + changelog + 生成产物                             |
| ②   | core_get_status 暴露恢复域：RecoveryStatus + GoalStatusSummary                                                                                       | D8 独占                                           | core_query_commands.rs                                              |
| ③   | 前端失败态卡片 + resume/kill/kill_all 按钮 + 恢复状态展示；goal 前端投影化过渡                                                                       | UI 面随 D4（00 总纲 §4）                          | crish-desktop（agent-card 组件族、useGoalMode、useStreamCallbacks） |
| ④   | 水合 error 态放行 + failed-turn 标记（本轮，非可选）                                                                                                 | 契约本维度定义，接线 D7（hydrate.rs 文件域归 D7） | 契约落点：本文件 §3.4；实现落点：hydrate.rs                         |
| ⑤   | 诉求 2 口径修正：AGENTS.md「一轮最多 12 个」→「同时运行 ≤16、同父 ≤16、深度仅 1」（16/16/1，引擎守卫真值；12/5→16/16 为用户补充需求扩额，E3-3 裁决） | D8 独占                                           | AGENTS.md                                                           |
| ⑥   | 前端 `?? 5` 分叉统一为 12（引擎权威后前端为投影初始值）——**验收项**（02-定夺 M1：实现归 D5，本维度复核）                                             | D5 实现，D8 验收复核                              | useStreamCallbacks.ts                                               |
| ⑦   | 子代理运行中汇报进展展示（E3-2 扩展项，标注为 D8b UI 簇扩展项，非本轮必做）                                                                          | D8b UI 簇                                         | subagentHandlers.ts、agent-card 组件族                              |

### 1.2 验收断言（最低线细化）

**A1 · 事件注册表一致性（registry_drift 绿）**

- `cargo test -p conex-types` 全绿；`v1_baseline_has_exactly_49_event_types`（旧名 `...41...` 留痕注释）；`registry_drift.rs` 41 锚点全量枚举（02-定夺 C11/P3-5：`:208-213`、`:501-502`、`:829-838`、`:933-938` 计数断言 41→49；`:894`/`:948` cron-fired 编号恒 41 断言保留；`:1471-1496` 双面策略事件段 `:1477` 41→49）——逐条核对 §3.1 清单；`event_hook_mapping.rs` 划分断言 `41 = 11 + 30` → `49 = 11 + 38`；`events_roundtrip.rs` 穷举构造补 8 变体。
- engine-events.json `eventCount: 49`，id 42-49 逐条与 enum 声明序一致，backpressure 全 `critical`。
- fixtures/events-v1/ 追加 8 条（event-recovery-_.json ×5 + event-goal-_.json ×3），全量解析 + roundtrip 保真。
- 生成脚本重跑产出 TS 类型后，前端 `npm run typecheck` 绿。
- changelog 33 新增 1.9 行（41→49，minor 兼容新增，对齐 1.5/1.6 先例）。

**A2 · 恢复事件可检索（本维度对「被事件检索」的具体化）**

- 模拟写入一条 body-only 的 recovery-* 事件（复刻 recovery.rs:938-950 payload）→ `core_read_session_events` 返回含该事件的页，`type` 正确、字段保真（parse_envelopes 合成 fallback 单测）。
- 旧信封形事件（41 基线）解析行为不变（合成 fallback 不影响既有路径）。

**A3 · core_get_status 恢复域字段**

- `build_status` 追加 `recovery` 参数后，序列化断言：`recoverNeedsUser` / `recoverEpisodes`（含 `fingerprint`/`count`）/ `pendingRecoveries` / `goalState`（含 `goal`/`maxRounds`/`currentRound`/`stalledRounds`/`maxStalledRounds`/`stoppedReason`）camelCase 在场；空值缺省省略（skip_serializing_if）；无 snake_case 键。
- `core_get_status` 集成测试：coordinator 有 needs_user/pending/budget 状态时字段非空；无 coordinator 时 `recovery` 键缺省（诚实化，不假装成功）。

**A4 · 前端失败态卡片可操作**

- 子代理 failed 卡片展示错误 kind 与重试次数（数据源：subagent-ended summary + recovery-* 事件流 + run 终态 error，三级回退）。
- 会话域断言（02-定夺 W7）：recovery-* 事件（含 recovery-escalated）落**子代理会话（sub-sess-*）**事件流；前端经 subagent 会话事件消费面读取或经 subagent 行关联检索可命中（失败卡片 kind 数据源成立）。
- resume / kill / kill_all 按钮调用 D4 命令面 wrapper（命令未注册期按钮禁用——UI 面随 D4 批次落地）；触发后事件留痕（resume→recovery-fork 或新 run 事件）。
- 恢复状态行：`recoverNeedsUser` 非空展示「需人工介入：run X」；`pendingRecoveries` 计数展示；组件单测 + typecheck 绿。

**A5 · 水合契约（D7 接线后验收）**

- error 态消息水合保留（不复被过滤），且 `metadata == {"kind":"failed-turn"}`；无 schema 改动；旧数据（无 status）行为不变。

**A6 · 口径更新**

- AGENTS.md 行 23/48 两处替换为新口径文本（§3.5，16/16/1）；仓库内无残留「同父 ≤5」「全局 ≤12」引擎上限口径表述（调度批次惯例「每轮 ≤12」保留并已加注区分；grep 验证，E3 §3.5 扩展口径）。

**A7 · 前端 ?? 5 统一（验收项：D5 实现，本维度复核）**

- `useStreamCallbacks.ts:661` 的 `?? 5` 改为 `?? GOAL_DEFAULT_MAX_ITERATIONS`（12）（02-定夺 M1：实现归 D5）；断言/组件测试覆盖（本维度复核）。

---

## 2. 现状基线（文件:行号，当前行为）

### 2.1 事件面：recovery-* 在 M7 注册表外、goal-* 仅 TS 孤儿

- `crates/conex-types/src/events.rs:3-8` 声明「AgentEvent 是 41 种域事件的 serde tagged enum（Rust enum 为双端唯一事实源）」；41 变体清单 `engine_event_type_names!`（events.rs:810-852）到 `CronFired` 为止，**无任何恢复域/goal 域变体**。
- `crates/orchestrator/src/recovery.rs:99-111` 自述：「恢复域事件类型（events 表留痕；M7 事件注册表外，M14 事件源补齐时登记进 conex-types 注册表与 engine-events.json）」——五事件常量 `RECOVER_ESCALATED/STEERING/FORK/REPORT/BUDGET_DENIED_EVENT`（recovery.rs:103-111）是纯字符串，通过 `RecoveryStore::append_event`（recovery.rs:635-651）直写事件表。
- `packages/shared-types/src/stored-event.ts:14-16`：`goal-round-started / goal-round-completed / goal-continuation-decided` 仅存在于 TS `StoredEventType` 联合（孤儿类型，05 领域文档确认 Rust 注册表无对应、无发射点）。
- `crates/conex-types/contracts/engine-events.json` `eventCount: 41`（:7），事件编号 1-41 与 enum 声明序一一对应（registry_drift 锁定）。
- **登记面现状**：`crates/conex-types/tests/events_schema_version.rs:35-83` V1_EVENT_TYPES 清单（41 条）；`:96-105` `v1_baseline_has_exactly_41_event_types`；`crates/conex-types/tests/registry_drift.rs` 41 锚点分散多处——计数断言 `:208-213`、`:501-502`、`:829-838`（`registry_drift_timer_events_registered`）、`:933-938`（`registry_drift_cron_fired_registered`），双面策略事件段 `:1477`（:1471-1496 9.4 锚点），另 `:894`/`:948` cron-fired 编号恒 41 断言（02-定夺 C11/P3-5 全量枚举）；`crates/conex-types/tests/events_roundtrip.rs:243-` `all_events()` 穷举构造（41 实例，与 ALL_TYPE_NAMES 序一一对应）；`crates/conex-types/tests/event_hook_mapping.rs:157-183` 划分断言 `41 = 11 映射 + 30 无对应`。

### 2.2 检索面：append_event 直写事件当前不可被 core_read_session_events 读到（05 未覆盖的事实）

- `RecoveryStore::append_event`（recovery.rs:635-651）payload = **事件体**（如 recovery.rs:941-946 的 `{"subagentRunId","kind","retries","elapsedMs"}`），无 `type`/`sessionId` 顶层字段。
- 读面 `parse_envelopes`（core_query_commands.rs:483-491）把 payload 整体 `serde_json::from_str::<AgentEventEnvelope>`——`AgentEventEnvelope::deserialize`（events.rs:966-992）要求 payload 含 `type` 字段才能反序列化 AgentEvent。**body-only payload 解析失败 → filter_map 跳过**（core_query_commands.rs:486-488）。结论：恢复域事件即使登记为注册表变体，若不处理读面，经 append_event 落库的事件在 `core_read_session_events` 里仍不可见（这正是 03 领域文档 G4「观测/检索缺位」的底层原因，03-恢复阶梯机制与接线现状.md:62）。
- 信封形事件（emit 层写入，payload = 扁平 `{type, runId, sequence, schemaVersion, sessionId, ...}`）解析正常（events.rs:941-964 序列化面）。

### 2.3 core_get_status：无恢复域

- `CoreStatus`（core_query_commands.rs:147-181）含 restore/snapshot/background_tasks 三增量域，**无恢复域字段**；`RestoreStatus`（:88-104）已含 `interruptedCount`（重启打断观测锚点）。
- `build_status`（:189-225）是唯一组装函数，各域以追加参数并入（F2 串行序）；测试 `build_status_serializes_to_camel_case`（:649-750）锁定现有字段形状。
- 数据源访问器现成：`RecoveryBudget` 快照 `budget()`（recovery.rs:884-886）、`pending_notifications()`（:889-894）、`needs_user()`（:897-899）——但生产壳层**无 RecoveryCoordinator 实例**（F2-08，recovery.rs:57-62；D3 装配前该域数据源恒缺）。

### 2.4 前端：无失败态卡片、无恢复状态、goal 权威在前端

- 子代理失败态**已有展示骨架但无恢复动作**：`InlineAgentPanel.tsx`（主时间线内联面板）——failed 空态文案「暂无消息（运行失败）。可在下方重试。」（:195）、is-failed 样式（:214-215）、failed 徽标（:252-253）；**但只有运行中的 stop（L2）/force-stop（L3）按钮（:291-304、:324-336），无 failed 态的 resume/kill 按钮**。
- `subagentHandlers.ts` 消费 subagent-ended（dispatch.ts:119/141 注册）——失败通知链已在前端；且已消费 subagent-event 三 kind（progress/message/tool，45-59、131-144 `applySubagentEventToAgent` 投影 agent 时间线）——汇报进展展示面现成，生产零发射时仅终态可达（E3 §2.1；D3 §3.2.6 汇报接线后 progress 到达）。
- `core_get_status` 前端消费面：engineStatus.ts:53、engineConfig.ts 等（无 recovery 字段读取）。
- goal 权威在前端：`goalModeController.ts` `decideGoalContinuation`（:202-273）+ `GOAL_DEFAULT_MAX_ITERATIONS = 12`（:16）；`useGoalMode.ts:34-77` 是续写循环；`useStreamCallbacks.ts:656-663` goalOpts 组装——**`:661` `maxIterations: liveGm.maxIterations ?? 5` 与 12 分叉**（03 评审 M9 事实修正）；`useGoalMode.ts:98` 已用 `GOAL_DEFAULT_MAX_ITERATIONS`（分叉只此一处）。`ConnectionLifecycle.ts:559-569、629-631` 已发 `visibleGoal/maxRounds/maxStalledRounds`（serde 被 Rust 静默丢弃，core_run_commands.rs:3123-3143 无字段——D5 补）。
- 前端无 goal-round-* / goal-continuation-decided 事件消费（TS 类型孤儿，05-Goal模式与主动结束后继续能力.md:12）。

### 2.5 水合：error 态被过滤（模型「失忆」）

- `hydrate.rs:83-93` `is_completed` 只放行 `None`/`Some("completed")`，`Some("error")` 等一律 `false`；`hydrate_one`（:54-57）先过 `is_completed`，不过则跳过。
- 测试锁定：`incomplete_and_error_status_entries_skipped`（hydrate.rs:376-387）断言 error 态被跳过——**该测试在 D7 接线时必须改写**。
- metadata 支撑面：`AgentMessage.metadata` 为自由 JSON 可选字段（engine-events.json `AgentMessage` 类型 `metadata: JsonValue, required: false`，:1579-1583）——failed-turn 标记**无 schema 改动**。

### 2.6 口径：AGENTS.md 表述与引擎真值偏差

- `AGENTS.md:23`、`AGENTS.md:48`（重复出现两处）：「一轮最多 12 个子 Agent」。
- 引擎真值：`subagent.rs:497-501` `DEFAULT_RECURSION_GUARD { max_depth: 1, max_siblings: 16, max_concurrent: 16 }`（12/5→16/16 为用户补充需求扩额，E0 E3-3 裁决）——语义是「全会话**未终态**子代理 run ≤16、同父未终态 ≤16、深度仅 1」（RecursionGuardSnapshot 定义 :505-514）；`packages/shared-types/src/subagent.ts:57-65` 镜像同值；既有 12 上限测试 7 处数字修正随扩额同步（subagent.rs:2129-2224、2990-3093 域，E3 §3.2.3）。
- 「一轮最多 12 个」把**调度批次惯例**（每轮派发多少个）与**引擎并发上限**（同时运行多少个）混为一谈——诉求 2 是确认型诉求（03 评审 §1.3：上限已存在，缺口径统一）。

---

## 3. 改动设计

### 3.1 事件登记收口（①）：逐文件清单（九处 + 生成产物）

> 一次集中登记 8 事件（recovery-* ×5 + goal-* ×3），**禁止分两批**（敲定 #14：断言改名返工）。编号 42-49，追加在 `CronFired`（41）之后。载荷字段 = 实际 append_event payload 的 camelCase 镜像（契约镜像模式，见动态决策 D-3）。

| #   | 文件                                                | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 证据/先例                                                                            |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `crates/conex-types/src/events.rs`                  | ① AgentEvent 追加 8 变体（§3.1.1 字段表），tag kebab-case + 字段 camelCase；② `engine_event_type_names!` 追加 8 arm（:810-852，编译期强制补 arm）；③ `event_backpressure` 追加 8 分支全 `Critical`（:867-893，registry_drift 双向锁定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1.5/1.6 先例（timer/cron 域）                                                        |
| 2   | `crates/conex-types/contracts/engine-events.json`   | `eventCount` 41→49（:7）；`events` 追加 id 42-49 条目（type/rustVariant/domain/fields/backpressure=critical）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 每事件 backpressure 字段（registry_drift 锁定，:16-19）                              |
| 3   | `crates/conex-types/tests/events_schema_version.rs` | `V1_EVENT_TYPES` 追加 8 条（:35-83）；`:96` 断言改名 `v1_baseline_has_exactly_49_event_types`（旧名留痕注释，对齐 1.5/1.6 改名惯例 :89-94）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | changelog 1.5/1.6 登记行                                                             |
| 4   | `crates/conex-types/tests/fixtures/events-v1/`      | 追加 8 个同形 fixture：`event-recovery-escalated.json` / `event-recovery-steering.json` / `event-recovery-fork.json` / `event-recovery-report.json` / `event-recovery-budget-denied.json` / `event-goal-round-started.json` / `event-goal-round-completed.json` / `event-goal-continuation-decided.json`；内容 = 信封形 JSON（`type` + `sessionId` + 字段，无 schemaVersion/runId/sequence，对齐 event-timer-fired.json 既有形态）                                                                                                                                                                                                                                                                                                                                      | `v1_fixture_files_cover_all_event_types`（events_schema_version.rs:107-114）         |
| 5   | `crates/conex-types/tests/registry_drift.rs`        | ① `:208-213` 注册表数断言 41→49（`registry_event_types_match_enum_declaration_order`）；② `:501-502` 事件数断言 41→49；③ `:829-838` 累计基线断言 41→49（留痕注释；`registry_drift_timer_events_registered`，同测试内 `:894` cron-fired 编号恒 41 断言**保留 41**）；④ `:933-938` `registry_drift_cron_fired_registered` 累计基线断言（event_count/events.len()/ALL_TYPE_NAMES.len()）41→49（`:948` cron.id 恒 41 断言保留——cron-fired 仍为 41，新事件追加 42-49）；⑤ **双面策略 41 锚点**（`:1471-1496` 9.4 `device_registry_events_match_engine_and_sync_whitelist`：`:1477` 事件段 41 条→49，`:1496` 注释同步）；⑥ 新增 8 事件登记断言（id 42-49、rustVariant、domain=recovery/goal、backpressure=critical），仿 `registry_drift_timer_events_registered`（:829-849） | 本处是 05「六处」之外的实测第三处测试面；「三处 41」扩为全量枚举（02-定夺 C11/P3-5） |
| 6   | `crates/conex-types/tests/events_roundtrip.rs`      | `all_events()`（:243-）追加 8 实例（与 ALL_TYPE_NAMES 声明序一一对应；编译期强制，漏补即编译错）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 穷举 roundtrip（:1-3）                                                               |
| 7   | `crates/conex-types/tests/event_hook_mapping.rs`    | `UNMAPPED_EVENTS` 追加 8（recovery-_/goal-_ 无对应钩子）；划分断言 `41 = 11 + 30` → `49 = 11 + 38`（:163-183）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 对齐 1.6 先例「hooks 不扩展」                                                        |
| 8   | `docs/rust-rewrite/33-event-schema-changelog.md`    | 变更登记表追加 **1.9 行**（minor 兼容新增：恢复域 5 事件 + goal 域 3 事件，41→49；背压全 critical；`V1_EVENT_TYPES` 清单 41→49 断言改名留痕；fixture 追加 8 条）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1.5/1.6 行格式照抄（33-changelog:112-113）                                           |
| 9   | `scripts/generate-engine-bindings.mjs` 重跑         | 产出 `packages/shared-types/src/generated/engine/**`（types.ts/parser.ts/events.ts）——TS 类型含 8 新事件；前端 `npm run typecheck` 绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 生成链路（registry_drift.rs:5-6）                                                    |

**兜底纪律**：`cargo test -p conex-types` 全绿为登记完成门禁；changelog 行与 fixture 四件套勾稽（33-changelog:41-46 DoD）。

#### 3.1.1 新事件变体字段定义（载荷 = 既有 append_event payload 镜像）

| 事件（type / rustVariant）                              | 字段（camelCase）                                                                                    | payload 真源                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recovery-escalated` / `RecoveryEscalated`              | sessionId, subagentRunId: Option\<String\>, kind, retries, elapsedMs, detail: Option\<String\>       | recovery.rs:941-946（escalate 升级留痕）；双发射方（02-定夺 W1）：子代理侧 subagentRunId=Some、detail=None；熔断侧（D1 §3.2.2 C5）subagentRunId=None、detail=Some("circuit-trip")                                                                                                              |
| `recovery-steering` / `RecoverySteering`                | sessionId, subagentId, subagentRunId, fingerprint, retries, remainingStatus, pending, createdAtMs    | `RecoveryNotification` serde camelCase（recovery.rs:341-358）经 :1008-1016 序列化                                                                                                                                                                                                              |
| `recovery-fork` / `RecoveryFork`                        | sessionId + `ForkRecord` 全字段（fingerprint, subagentId, fromRunId, fromLeafId, newRunId, ...）     | `ForkRecord` serde camelCase（recovery.rs:445-464 起）经 :1162-1168 序列化                                                                                                                                                                                                                     |
| `recovery-report` / `RecoveryReport`                    | sessionId + `UserReport` 全字段                                                                      | `build_user_report` 产出（recovery.rs:518-531、:1185-1193）经 :1198-1204 序列化                                                                                                                                                                                                                |
| `recovery-budget-denied` / `RecoveryBudgetDenied`       | sessionId, subagentRunId: Option\<String\>, fingerprint, count, max                                  | 双发射方（02-定夺 W6）：D2 主 run 侧（subagentRunId=None，预算耗尽留痕，D2 §3.4 伪代码 / recovery.rs:111）+ D3 子代理侧（subagentRunId=Some，recovery.rs:1054-1059 预算拒绝留痕）                                                                                                              |
| `goal-round-started` / `GoalRoundStarted`               | round, maxRounds, goal                                                                               | 新载荷（D5 RoundAssessment 发射）；round 从 1 计；envelope 事件不列 sessionId 变体字段（读侧信封已含，02-定夺 B2 约定）                                                                                                                                                                        |
| `goal-round-completed` / `GoalRoundCompleted`           | round, toolCallCount, toolSuccessCount, messageCount, decision, reasonDetail, stalledDelta, evidence | 新载荷（02-定夺 B2 统一单一字段集，与 D5 §3.9 同批同形状）；字段名按仓库惯例 snake_case 序列化；stalledDelta 表达本轮增量，stalled 总数在 goal_state 键；decision ∈ Continue/Completed/NoProgress/Blocked/NoGoal（D5 §3.3 GoalDecision）；envelope 事件不列 sessionId 变体字段（读侧信封已含） |
| `goal-continuation-decided` / `GoalContinuationDecided` | action, reason, prompt?, progressSignature?, detail?                                                 | 对齐 TS `GoalContinuationDecision`（orchestration.ts:38-44：action/reason/prompt/progressSignature/detail）；envelope 事件不列 sessionId 变体字段（读侧信封已含）                                                                                                                              |

- 全部字段 `String`/`u32`/`u64`/`bool` 基元，**不引入新 payload struct 与 enum**（注册表可达性护栏：无死条目，registry_drift.rs:20-21）；可选字段 `#[serde(default, skip_serializing_if = "Option::is_none")]`（33-changelog:27-28 纪律）。
- **payload 语义属主**：recovery 五事件 = D3（escalate/fork/report 发射点已存在，recovery.rs:938、1008、1162、1198、1051）——**recovery-escalated 与 recovery-budget-denied 为双发射方**：escalated 另含 D1 熔断侧（detail=Some("circuit-trip")，02-定夺 W1）、budget-denied 另含 D2 主 run 侧（subagentRunId=None，02-定夺 W6）；goal 三事件 = D5（RoundAssessment 收口发射，新写）。D8 只登记契约 + 暴露检索，**不移动发射点、不改写面**（敲定 §2.2「recovery 域继续走 append_event 直写，不改造 emit 层」）。
- 字段镜像漂移防护：登记同批时以 recovery.rs 实际 append_event payload 为准写 fixture；events.rs 变体字段与 fixture 由 registry_drift roundtrip 锁定（注册表 → AgentEvent → 回序列化，registry_drift.rs:12-14），orchestrator 侧载荷形状由 fixture 作为跨层锚点（动态决策 D-3）。

### 3.2 恢复事件检索面：parse_envelopes 合成 fallback（对「被事件检索」的落地）

**问题**（§2.2）：append_event 直写事件（body-only payload）经 `core_read_session_events` 读不到。

**设计**：`core_query_commands.rs` `parse_envelopes`（:483-491）加宽容分支：

```rust
// 伪代码：payload 先按信封解析；失败时用事件行(event_type, session_id)合成信封
fn parse_envelopes(events: &[PersistedEvent]) -> Vec<(u64, AgentEventEnvelope)> {
    events.iter().filter_map(|event| {
        if let Ok(env) = serde_json::from_str::<AgentEventEnvelope>(&event.payload) {
            return Some((event.sequence, env));           // 既有路径：信封形 payload
        }
        // 合成路径：body-only payload（append_event 直写形态）
        let mut value: serde_json::Value = serde_json::from_str(&event.payload).ok()?;
        let map = value.as_object_mut()?;
        map.insert("type".into(), json!(event.event_type));
        map.insert("sessionId".into(), json!(event.session_id));
        serde_json::from_value::<AgentEventEnvelope>(value).ok().map(|env| (event.sequence, env))
    }).collect()
}
```

- **改动面**：`parse_envelopes` ~12 行 + 单测；无 schema 改动、无事件表迁移。
- **会话域**（02-定夺 W7）：append_event 的 session_id 语义保持现状——子代理恢复事件落**子代理会话（sub-sess-\*）**；合成路径以事件行 `(event_type, session_id)` 合成信封，session_id 即子代理会话 id，读侧按子代理会话检索（前端已有 subagent 会话事件消费面，见 §3.7.1）。
- **语义**：写入面零改动（遵守敲定「recovery 域继续走 append_event 直写」）；读面对 41 基线信封形事件行为完全不变（`filter_map` 失败回退仅发生在 payload 无 type 时）。
- **历史行**：若历史存在 body-only recovery 事件行（测试库/未来生产），合成后自动可读；损坏 payload（非 JSON）仍跳过（防御性不变，:481-482 注释语义）。
- **验收**：A2 断言。

### 3.3 core_get_status 恢复域（②）：结构定义

```rust
/// 恢复预算条目（recoverEpisodes 投影项：操作指纹 → 已消费次数）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryBudgetEntry {
    pub fingerprint: String,
    pub count: u32,
}

/// goal 状态摘要（goal_state 键投影：currentRound/maxRounds/stalledRounds 为
/// 轮数成本观测与 stalled 告警的消费面，护栏 10 引用）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStatusSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub max_rounds: u32,
    pub current_round: u32,
    pub stalled_rounds: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_stalled_rounds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_reason: Option<String>,
}

/// core_get_status 恢复域增量（无 coordinator / 无 goal 会话 → 整域缺省）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    /// 阶梯 4 需用户介入的 run id 列表（recover_needs_user 键投影）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recover_needs_user: Vec<String>,
    /// 恢复预算快照（recover_episodes 键投影：指纹 → 已消费次数）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recover_episodes: Vec<RecoveryBudgetEntry>,
    /// 待处理（pending 位）阶梯 2 通知数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_recoveries: Option<usize>,
    /// goal 状态摘要（goal_state 键投影；非 goal 会话缺省）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_state: Option<GoalStatusSummary>,
}
```

- **挂载**：`CoreStatus` 追加 `pub recovery: RecoveryStatus`（对齐 T-AB-19 `background_tasks` 增量位，core_query_commands.rs:177-180）；`build_status` 追加参数（F2 串行序追加，:189-225 注释纪律）。
- **数据源与刷新**：
  - recover 域：RecoveryCoordinator 内存态访问器 `budget()` / `pending_notifications()` / `needs_user()`（recovery.rs:884-904）——**读写分离**（05 动态决策 D8：coordinator 唯一写方，读侧锁内克隆不跨锁 await）；coordinator 未装配（D3 前）→ 整域缺省（诚实化，对齐 `build_status_defaults_are_honest` 语义 :752-799）。
  - goal 域：`goal_state` 键读取（D5 写入），run_restore 成功后惰性加载（与 coordinator 同装配点）；fail-open 解析（坏 JSON → 无 goal）。
  - 刷新时机：**拉取式**（前端 core_get_status 轮询）；写面（escalate/fork/report/round 收口）完成后读即有，无需新增事件推送面（05 动态决策 D4）。
- **访问器契约落点**：CoreRunState 新增 `recovery_status() -> RecoveryStatus`（D3 装配 coordinator 后实现；D3 前返回缺省——见 §7 接口）。

### 3.4 水合契约（④，D8 定义 / D7 接线）

**契约文本（D7 按此实现）**：

1. `is_completed`（hydrate.rs:87-93）放行集从 `{None, Some("completed")}` 扩展为 `{None, Some("completed"), Some("error")}`；其余（queued/processing/streaming/pending/空串）仍过滤。
2. `hydrate_one`（hydrate.rs:54-81）对 `status == Some("error")` 的消息注入 `metadata = Some(json!({"kind": "failed-turn"}))`；completed/无 status 消息保持 `metadata = None`（规则 4 裁剪不变，hydrate.rs:16、:74-75）。
3. 无 schema 改动（metadata 是 AgentMessage 既有自由 JSON 字段，engine-events.json:1579-1583；不进事件注册表）。
4. 其余水合规则（角色映射/块保真/尾部 user 截断/宽容降级）不变。
5. **测试改写**：`incomplete_and_error_status_entries_skipped`（hydrate.rs:376-387）中 `Some("error")` 条目从「跳过」改为「保留 + failed-turn 标记」，并新增断言 `hydrated[..].metadata == {"kind":"failed-turn"}`；新增单独用例 `error_status_hydrates_with_failed_turn_marker`。

**边界说明**：

- 与 D7 的共享：错误消息语义完整化（04 结构化标注 + 水合 failed-turn）归 D7 ⑤（00 总纲 D7 关键文件含 hydrate.rs）；**hydrate.rs 文件域归 D7 单写方**（同文件串行纪律），本维度只冻结契约与验收断言，不在 D8 轮触碰 hydrate.rs。
- 与 D1/D2 的关系：机制面自动续 run 的 history 源走 SessionHistoryCache（引擎缓存全角色保真，core_run_commands.rs:907-915、2718），与用户手动路径的水合修复互补（01 决策 3 + 05 D1 双路径语义，评审分歧 8 裁决两者并行）。

### 3.5 口径修正（⑤）：AGENTS.md 替换文本

**替换位置**：`AGENTS.md:23`、`AGENTS.md:48`（两处内容相同，逐字替换）。

**旧文本**：

> 一轮最多 12 个子 Agent；任务包括：分析（只读+文档）、方案（只读+文档）、评审（只读+文档）、实现（写代码+测试）、提交（仅 git）。

**新文本**：

> 同时运行（未终态）子 Agent ≤16、同父 ≤16、深度仅 1（引擎守卫真值 `DEFAULT_RECURSION_GUARD`，subagent.rs:497-501：maxDepth=1/maxSiblings=16/maxConcurrent=16，12/5→16/16 为用户补充需求扩额；「一轮最多 12 个」是调度批次惯例，不改变引擎上限）；任务包括：分析（只读+文档）、方案（只读+文档）、评审（只读+文档）、实现（写代码+测试）、提交（仅 git）。

**同步核查项**：

- `00-总纲-维度设计.md:146`「每轮 ≤12 个 Agent」——这是轮次执行规则（调度批次惯例），与引擎守卫不冲突，**保留不改**；如评审要求可在该行加注「批次惯例，非引擎上限」。
- `final/00-正式实现规范.md:84`「合并注入 ≤16 条」中的 16 是**重启恢复条目合并上限**（恢复条目数），与守卫 `max_concurrent=16` 数字重合但**语义不同**——口径轮在 00:84 加注「该 16 为恢复条目数，与 DEFAULT_RECURSION_GUARD.max_concurrent 无关联」防后续实现混淆（E0 §四 / E3 §3.1）。
- 仓库 grep 验证无残留「≤12」「同父 ≤5」引擎上限口径表述（调度批次惯例的「每轮 ≤12」允许保留并已加注区分；验收 A6）。

### 3.6 前端 ?? 5 分叉统一（⑥）——验收项（02-定夺 M1：实现归 D5，本维度复核）

> 标注：本项实现归 D5（00 总纲关键文件归属），**不作为本维度实现项**；D8 侧负责验收复核（断言/组件测试覆盖，见 A7）。

**改动（D5 实现）**：`useStreamCallbacks.ts:661` `maxIterations: liveGm.maxIterations ?? 5` → `maxIterations: liveGm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS`（`GOAL_DEFAULT_MAX_ITERATIONS = 12`，goalModeController.ts:16；useSlashSend.ts:18 与 useGoalMode.ts:7 已有该 import 先例）。

**语义**：引擎权威化后（D5 goal_state.max_rounds 默认 12），前端数值仅是**投影初始值**（03 评审建议 8）；修正分叉后，下发字段与引擎默认一致，消除「12 轮上限语义漂移」（selection-02 P-10）。

### 3.7 前端组件设计（③）

#### 3.7.1 失败态卡片（复用 InlineAgentPanel 失败态扩展）

**落点**：`apps/crish-desktop/src/components/agent-card/`（单一组件族集中纪律，05 §5「UI 组件必须集中」）；主时间线用 InlineAgentPanel 扩展，侧栏用 AgentCard 同步。

**新增内容**：

1. **失败摘要行**（failed 且空态时替换 `emptyStreamCopy` 失败文案 :195）：
   - 错误 kind：三级数据源回退——① 最近 `recovery-escalated` 事件 `kind` 字段：**读子代理会话（sub-sess-\*）事件**（前端已有 subagent 会话事件消费面）或经 subagent 行关联检索（02-定夺 W7；§3.2 合成路径使该路径成立）；② 子代理 run 终态 error 文案（`core_get_run_snapshot` RunSnapshot.error，core_query_commands.rs:436-438）；③ subagent-ended `summary`（events.rs:621-623）。
   - 重试次数：`recovery-escalated.retries`（阶梯 1 已重试次数）＋ `recoverEpisodes` 对应指纹 count（已 fork/恢复次数）。
   - 「需人工介入」徽标：`core_get_status.recovery.recoverNeedsUser` 含该 subagentRunId 时展示（对齐 recover_needs_user 设计语义 recovery.rs:30-31、897-904）。
2. **操作按钮组**（failed 态专属，运行中仍只有 stop/force-stop）：
   - `resume`：调 D4 `resume_subagent` wrapper（commandMap 白名单）→ fork 新 run（三态上下文继承，recovery.rs:1031-1173；受 16/16/1 守卫）。
   - `kill`：调 D4 `kill_subagent`（单目标 L3 强停 + mark_row_failed）。
   - `kill_all`：调 D4 `kill_all`（批量终止全部 running 子代理，lifecycle.rs:165-224）。
   - 按钮禁用逻辑：命令未注册期（D4 未落地）禁用 + tooltip「引擎未接线」；发送中/运行中禁用；resume 后卡片转 running 态。
3. **恢复状态行**（会话级，挂在 ChatStatusRibbons 或 AgentTeamBoard）：`recoverNeedsUser` 非空 → 「需人工介入：run X（Y 项）」横幅；`pendingRecoveries` > 0 → 「N 条恢复通知待处理」；`goalState` → 「目标轮次 current/max，stalled 连续 stalledRounds/maxStalledRounds」（token 成本观测护栏 10 的消费面）；**熔断横幅消费面**（02-定夺 S5/W1）：消费 `runtime-intervention-required` 事件（04 既有先例 steering_evaluation.rs:68-75）与 `recovery-escalated`（detail=Some("circuit-trip")，subagentRunId=None）→ 展示「熔断已触发，需人工介入」横幅。

**数据获取**：`core_get_status` 拉取（复用 engineStatus.ts:53 既有 IPC 面）＋ 事件面 subagent-ended 推送即时刷新（dispatch.ts:119/141 既有接线）。

#### 3.7.2 goal 前端投影化过渡（③）

**落点**：`useGoalMode.ts` + `sessionStreamManager`/事件路由。

- 消费 `goal-round-started` / `goal-round-completed` / `goal-continuation-decided` 事件投影到 `session.goalMode`（迭代号/轮次/阻塞原因），替代 `decideGoalContinuation` 的权威判定（05 P2-10）。
- **过渡期双写**：`decideGoalContinuation` 保留为过渡兼容（05 §4.3「过渡期内双写，以引擎为准」）；引擎 goal_state + 四源 goal_pending（D5）落地后，前端只做投影与入口，不再判定。
- **V4 核查项**（敲定 §5）：goal-completed 终态 reason 与前端 completed 判定兼容性——本维度前端投影轮验证（敲定 :105）。
- **run-terminal 映射**：goal-blocked / goal-max-rounds / goal-stalled 终态 reason 的展示判定（restore.rs:807-817 保真 reason 集）接入现有终态展示面。

#### 3.7.3 子代理运行中汇报进展展示（E3-2 扩展项，D8b UI 簇）

> 标注：本项为 **D8b UI 簇扩展项**（D3 §3.2.6 汇报接线之后的「汇报进展展示」前端面），**非本轮 D8 必做清单**——D3 同批的「汇报接线」只保证事件产出（subagent-event kind=progress），前端进度展示随 D8b UI 簇排期。

- **消费面现状**：`subagentHandlers.ts` 已消费 subagent-event 三 kind（onSubagentEvent / onSubagentEventGlobal → `applySubagentEventToAgent` 投影 agent 时间线，45-59、131-144）；per-run 面 + 全局兜底面双消费，按信封 sessionId 路由（81-83）——汇报展示所需投影面零新增。
- **扩展内容**：运行中面板进度条目（子代理轮次递进、文本块摘要、工具调用摘要）；事件源 = D3 §3.2.6 的 progress 发射（subagent-event kind=progress，载荷 = 该轮文本块）；不改变 wait 语义、不写 steering 队列（汇报=观测面，唤醒=终态面，E3 §2.3）。
- **验收（D8b 排期时）**：运行中 progress 到达 → agent 时间线新增进度条目；终态 subagent-ended 仍走既有失败卡片刷新面（§3.7.1）。

#### 3.7.4 临时通知通道（老虎机滚动重连）

> 用户约束 A：失败/重连进度放**临时通知区**（单起一行、老虎机滚动样式），不进入对话上下文——重试/重连是过程性信息，给 AI 看无价值且浪费前缀（用户约束 C：重试/重连进度不给 AI 看，仅事件流 + 临时通知双面）。

**消费面**：`provider-diagnostic` 事件（phase=Retry，载荷 attempt/max_attempts——事件面真源 D1 §4.3）前端消费，投影到临时通知区（单起一行，与主对话/事件流分离）。

| 项               | 设计                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 样式             | **老虎机滚动重连**：单行文本，attempt 递增时数字滚动切换（1/6 → 2/6 → …，分母 max_attempts 按配置下发），不新增多行堆叠、不打断阅读流 |
| 数据源           | provider-diagnostic（phase=Retry）事件流；attempt/max_attempts 均取事件载荷，前端不做本地推算                                         |
| 生命周期         | 重连完成（后续成功/请求恢复）→ **清除**；重连失败（终态）→ 清除或**转终态**（失败态卡片接管，§3.7.1）；不留残余滚动态                 |
| 对话隔离         | **不进对话历史、不进 LLM 上下文**（事件流 + 临时通知双面，AI 零感知）                                                                 |
| 与失败态卡片区分 | 卡片 = 终态失败、需用户动作（resume/kill/kill_all 按钮）；临时通知 = 过程性滚动、自动消隐、无动作按钮                                 |

**验收**：见 §5.2 临时通知两断言（滚动样式 + 完成清除）。

#### 3.7.5 信息分级注记（重试/失败/熔断三通道）

> 用户约束 C 的前端落点：重试/重连进度不给 AI 看（事件流 + 临时通知）；只有子 agent 任务失败这类终态才注入对话给 AI。三级信息分级：

| 级     | 信息                                                                                          | 通道                                                                                                         | AI 可见性                          |
| ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 过程级 | 重试/重连进度（provider-diagnostic phase=Retry，attempt/max_attempts）                        | 事件流 + 临时通知（§3.7.4）                                                                                  | **不可见**（不进对话上下文）       |
| 终态级 | 子 agent 任务失败（kind/retries，RunFailureContext 数据面 D1）                                | **双通道**：AI 可见注入（对话，失败信息注入子 agent 任务 prompt/续 run 上下文）+ UI 失败态卡片展示（§3.7.1） | **可见**（注入对话）               |
| 熔断级 | 熔断/需人工介入（runtime-intervention-required 事件；recovery-escalated detail=circuit-trip） | 事件面横幅（§3.7.1 熔断横幅消费面）                                                                          | **不可见**（事件面展示，不进对话） |

---

## 4. 数据面

### 4.1 事件（+8，41→49，全 Critical）

| 事件                      | domain   | 载荷                                                                                          | 发射方（属主）                                                                                                                                            | 背压     |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| recovery-escalated        | recovery | subagentRunId?/kind/retries/elapsedMs/detail?                                                 | 双发射方（02-定夺 W1）：D3 escalate（recovery.rs:938-950，subagentRunId=Some、detail=None）+ D1 熔断侧（subagentRunId=None、detail=Some("circuit-trip")） | critical |
| recovery-steering         | recovery | RecoveryNotification 全字段                                                                   | D3 escalate（recovery.rs:1008-1016）                                                                                                                      | critical |
| recovery-fork             | recovery | ForkRecord 全字段                                                                             | D3 fork_and_reassign（recovery.rs:1162-1168）                                                                                                             | critical |
| recovery-report           | recovery | UserReport 全字段                                                                             | D3 report_to_user（recovery.rs:1198-1204）                                                                                                                | critical |
| recovery-budget-denied    | recovery | subagentRunId?/fingerprint/count/max                                                          | 双发射方（02-定夺 W6）：D2 主 run 侧（subagentRunId=None）+ D3 子代理侧预算拒绝（recovery.rs:1051-1063）                                                  | critical |
| goal-round-started        | goal     | round/maxRounds/goal                                                                          | D5 RoundAssessment（新发射）                                                                                                                              | critical |
| goal-round-completed      | goal     | round/toolCallCount/toolSuccessCount/messageCount/decision/reasonDetail/stalledDelta/evidence | D5 RoundAssessment（新发射；02-定夺 B2 统一单一字段集，snake_case 序列化）                                                                                | critical |
| goal-continuation-decided | goal     | action/reason/prompt?/progressSignature?/detail?                                              | D5（新发射；载荷对齐 GoalContinuationDecision orchestration.ts:38-44）                                                                                    | critical |

- 全部 minor 兼容新增：不删不改既有字段（33-changelog:26-29 未知键忽略、:137 不改变现有事件字段）；信封 schemaVersion 恒 1。
- 背压理由：recovery-* 本就是 append_event 落库必达（数据面）；goal-* 对齐 timer-fired 先例「Critical 必达落库——数据面，唤醒走 steering 面」（33-changelog:99）。

### 4.2 状态字段（+2 结构，无新键）

| 项                  | 位置                     | 形状 | 数据源                                                   |
| ------------------- | ------------------------ | ---- | -------------------------------------------------------- |
| `RecoveryStatus`    | core_get_status.recovery | §3.3 | coordinator 访问器（recovery.rs:884-904）+ goal_state 键 |
| `GoalStatusSummary` | recovery.goalState       | §3.3 | goal_state 键投影（D5 写）                               |

- **无新 session_meta 键**：recover_* 五键（recovery.rs:84-93）与 goal_state 键（D5 冻结）均已存在；本维度只读投影。
- **无新命令**：resume/kill/kill_all 命令属 D4（双端四步登记，01-敲定 §2.4）；本维度是命令**消费方**（前端 wrapper 调用面），不重复登记。命令条数基线 107/102/5 → **108/103/5**（E2 扩展 `core_compact_now` 经 D4 双端四步登记轮计入，E2 §7.3 / D4 §3.1；本维度仅口径跟踪）。

### 4.3 前端类型

- `packages/shared-types/src/generated/engine/**` 重跑生成（含 8 新事件 TS 类型）。
- `core_get_status` 消费面（engineConfig.ts 等）补 recovery 域类型（手写镜像 RecoveryStatus/GoalStatusSummary，或随生成链路产出）。

---

## 5. 测试策略

### 5.1 Rust（cargo test -p conex-types / -p agent-workbench）

| 面                    | 断言                                                                                                                                              | 文件                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 注册表一致性          | `v1_baseline_has_exactly_49_event_types`；V1_EVENT_TYPES == ALL_TYPE_NAMES；注册表数 49；fixture 8 条全量解析 + roundtrip                         | events_schema_version.rs、registry_drift.rs |
| 枚举穷举              | all_events() 49 实例 roundtrip（编译期强制）                                                                                                      | events_roundtrip.rs                         |
| 钩子划分              | 49 = 11 映射 + 38 无对应；recovery-_/goal-_ 全部无对应钩子                                                                                        | event_hook_mapping.rs                       |
| 背压                  | 8 新事件 `event_backpressure` == critical（仿 :829-849 断言风格）；注册表字段双向锁定                                                             | registry_drift.rs                           |
| 检索合成              | body-only payload（recovery.rs:941-946 形状）经 parse_envelopes 合成后可读、type/sessionId/字段保真；信封形 payload 行为不变；损坏 payload 仍跳过 | core_query_commands.rs 单测                 |
| build_status          | recovery 域 camelCase 序列化 + 空值缺省省略（仿 :649-750、:752-799）；无 snake_case 键                                                            | core_query_commands.rs                      |
| 水合（D7 接线后验收） | error 态保留 + metadata `{"kind":"failed-turn"}`；completed/无 status 不变；其余过滤不变                                                          | hydrate.rs（D7 改，断言本维度提供）         |

### 5.2 前端（vitest + typecheck）

| 面                    | 断言                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失败态卡片            | failed 态渲染错误 kind/重试次数；resume/kill/kill_all 按钮存在且调用对应命令 wrapper；命令未注册期禁用；「需人工介入」徽标条件渲染                                                    |
| 恢复状态行            | recoverNeedsUser 非空 → 横幅文案；pendingRecoveries 计数；goalState 轮次展示；熔断横幅（runtime-intervention-required / recovery-escalated detail=circuit-trip → 展示「熔断已触发」） |
| 临时通知滚动          | provider-diagnostic（phase=Retry）到达 → 临时通知区单行渲染，attempt 递增滚动（1/6 → 2/6 → …，分母 max_attempts 取事件载荷）；不进对话历史                                            |
| 临时通知清除          | 重连完成 → 临时通知清除；重连失败（终态）→ 清除或转失败态卡片接管；无残留滚动态                                                                                                       |
| goal 投影             | useGoalMode 消费 goal-round-*/goal-continuation-decided 事件 → session.goalMode 字段更新；decideGoalContinuation 过渡回退                                                             |
| ?? 5 修正（验收复核） | useStreamCallbacks goalOpts 下发 maxIterations 缺省 = 12（非 5）（D5 实现，本维度复核，02-定夺 M1）                                                                                   |

### 5.3 回归与门禁

- 命令双端条数测试（commandManifest.test.ts）在 D4 落地后回归（本维度按钮接线依赖其绿）。
- markdown-editor 门禁（reference/markdown-editor `npm test`）与 tests/e2e 5 个专项 spec 不受影响、禁止删除（AGENTS.md 铁律）。
- 前端门禁：`npm run typecheck` + `npm run test:coverage -- --project=unit`（45/70/65/45 快层）；禁止 --no-verify（01-敲定 §4 红线 4）。

---

## 6. 风险与护栏

| #   | 风险                                                             | 护栏/缓解                                                                                                                                                                             | 引用                       |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | 事件登记拆批导致断言改名返工                                     | 一次集中登记 8 事件（敲定 #14）；同批派单（事件面随 D3/D5）                                                                                                                           | 01-敲定 #14；00 总纲 §4    |
| 2   | 事件兼容破坏（major）                                            | 只新增不改删；可选字段 serde 缺省；旧解析器静默忽略；信封恒 1；changelog minor 登记 + fixture 勾稽                                                                                    | 33-changelog:24-39、:137   |
| 3   | 双路径语义：append_event 直写（body-only）vs emit 信封           | 写面零改动（敲定 §2.2）；读面合成 fallback 只读不写；合成失败仍跳过（不 panic、不改变 41 基线解析）                                                                                   | §3.2                       |
| 4   | 契约镜像漂移（events.rs 变体字段 ↔ orchestrator payload struct） | 登记同批以实际 append_event payload 写 fixture；registry_drift roundtrip 锁 events.rs 侧；fixture 作跨层锚点；changelog 1.9 行登记                                                    | 动态决策 D-3               |
| 5   | 前端旧路径过渡（decideGoalContinuation 权威残留）                | 过渡期双写、以引擎为准（05 §4.3）；事件投影化后仅保留入口；V4 兼容性核查（敲定 §5）                                                                                                   | 05 方案 §4.3；01-敲定 :105 |
| 6   | 水合行为变更（error 态从过滤→保留）                              | 只影响「重启后水合内容变多」；模型侧无 schema 契约；failed-turn 标记交模型自行判断（05 2.D D1 理由）                                                                                  | 05 方案 §4.3               |
| 7   | 恢复状态刷新陈旧（拉取式轮询）                                   | 写面完成后读即有（coordinator 内存态 + goal_state 键）；失败态卡片由 subagent-ended 推送即时驱动；不为低频状态新增推送面（05 D4）                                                     | 05 方案 §6 D4              |
| 8   | 口径「16」被误解为调度批次上限                                   | 新文本显式区分「引擎守卫真值 16/16/1（未终态）」与「调度批次惯例 ≤12」；00-总纲 :146 保留但加注（如评审要求）；00:84「合并注入 ≤16 条」为恢复条目数，与守卫 16 语义不同（加注防混淆） | §3.5                       |
| 9   | 按钮可用性与命令登记时序                                         | UI 面随 D4 批次；命令未注册期按钮禁用 + tooltip；条数测试锁定                                                                                                                         | 00 总纲 §4；01-敲定 §2.4   |
| 10  | 16/16/1 守卫不变式                                               | 本维度只读投影与命令消费，不引入任何 fork/spawn 能力；resume 的 fork 走 spawn 全流程受守卫（D4 契约）                                                                                 | 01-敲定 §4 红线 1          |

---

## 7. 与其他维度的接口对接（00 总纲 §6 契约表）

| 接口                           | 方向          | 契约                                                                                                                                        | 落点   |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 事件登记（recovery-* ×5）      | D3 → D8       | D3 发射点不动（recovery.rs:938/1008/1162/1198/1051），D8 登记契约 + 暴露检索；载荷 = 实际 append_event payload 镜像                         | §3.1.1 |
| 事件登记（goal-* ×3）          | D5 → D8       | D5 RoundAssessment 发射，载荷按本文件冻结字段表实现（D8 登记同批核对）                                                                      | §3.1.1 |
| recover_* 五键                 | D3 → D8       | 形状冻结（recovery.rs:84-93）；RecoveryCoordinator 单写方；D8 经访问器只读投影（recovery.rs:884-904）                                       | §3.3   |
| goal_state 键                  | D5 → D8       | 唯一写方 = run 收口 RoundAssessment；D8 读投影（fail-open）；GoalStatusSummary 字段为护栏 10 轮数成本观测消费面                             | §3.3   |
| 命令面（resume/kill/kill_all） | D4 → D8       | D4 双端四步登记（01-敲定 §2.4）；D8 前端按钮消费 wrapper；命令未注册期禁用；spawn_blocking 由 D4 保证（F2-27）                              | §3.7.1 |
| 水合契约                       | D8 ↔ D7       | 契约本文件 §3.4 冻结；hydrate.rs 文件域归 D7 单写方接线；D8 提供验收断言                                                                    | §3.4   |
| 失败通知链（subagent-ended）   | 既有 → D8     | 卡片即时刷新源（dispatch.ts:119/141 既有）；RunSnapshot.error 二级数据源                                                                    | §3.7.1 |
| 前端 ?? 5                      | D5 → D8       | **验收项**（02-定夺 M1）：D5 实现（引擎权威后前端数值 = 投影初始值），本维度复核                                                            | §3.6   |
| provider_error 数据面          | D1/D2 → D8    | 错误 kind/retries 经 RunFailureContext/run 终态上行（D1 数据面）；卡片展示消费（非本维度实现）                                              | §3.7.1 |
| 汇报进展展示                   | D3（E3-2）→D8 | subagent-event（kind=progress）经 subagentHandlers 投影 agent 时间线（45-59、131-144 现成）；运行中汇报展示 = D8b UI 簇扩展项（非本轮必做） | §3.7.3 |

**契约冲突**：无。**注意点**：① core_get_status 的 recovery 域在 D3 装配 coordinator 前返回缺省（诚实化，不假装有数据）；② hydrate.rs 同文件串行——D8 轮不触碰，D7 接线时按 §3.4 契约实现。

---

## 8. 动态决策记录（输入文档未覆盖处的自决）

| #   | 问题                                                                                                                                   | 决策                                                                                                                        | 理由                                                                                                                                                                                     | 影响面                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D-1 | 事件总数锁定 47 还是 49                                                                                                                | **49**（41 + recovery-* ×5 + goal-* ×3 = 8 事件）                                                                           | 敲定 §2.2 表已列全 8 事件（01-敲定 :54-57）；「47」是 05 方案「6-8 变体」中 goal-round-* 未计入时的下限口径，已被敲定表取代                                                              | 全部登记面（断言名/注册表数/生成产物）                 |
| D-2 | append_event 直写事件不可被 core_read_session_events 读到（05 未覆盖的读面缺口）                                                       | **读面合成**：parse_envelopes 对 body-only payload 用 (event_type, session_id) 合成信封                                     | 敲定冻结「不改造 emit 层/append_event 直写」→ 写面不可动；读面合成只读不改、对 41 基线零影响、历史行自动可读；新写专用查询命令违反最小方案（05 D3）                                      | core_query_commands.rs（§3.2）；验收 A2                |
| D-3 | recovery 事件变体载荷采用什么类型（orchestrator struct 无法进 conex-types——crate 依赖方向：orchestrator 依赖 conex-types，反向不成立） | **契约镜像**：events.rs 变体用基元字段内联镜像 append_event payload；不迁移 struct、不建新 payload 类型；fixture 作跨层锚点 | 迁移 RecoveryNotification/ForkRecord/UserReport 到 conex-types 需动 orchestrator 写面与导入面（违背「不改造」）；基元字段保持注册表可达性护栏（registry_drift.rs:20-21）与生成链路简单性 | §3.1.1；漂移风险由 fixture + 登记同批核对覆盖（§6 #4） |
| D-4 | 05 方案的登记「六处」与实际测试面不符（registry_drift/roundtrip/hook_mapping 三处漏列）                                                | 登记清单扩为九处 + 生成产物（§3.1 表）                                                                                      | 实测 `registry_drift.rs:208-213/501-502/829-838` 硬编码 41、`events_roundtrip.rs:243-` 穷举、`event_hook_mapping.rs:163-183` 划分断言均为必改面；漏改即 cargo test 红                    | 派单任务书（D8 事件登记任务范围）                      |
| D-5 | RecoveryBudgetEntry 形状（05 2.E 用 `Vec<(String, u32)>` 元组）                                                                        | **`{fingerprint, count}` 对象数组**                                                                                         | 元组数组 wire 形态 `[["fp",3],...]` 前端消费需下标魔法；对象数组自描述、与既有 LastTaskTerminal 等对象化增量位风格一致（core_query_commands.rs:120-129）                                 | §3.3；前端类型                                         |
| D-6 | 恢复状态展示的刷新频率                                                                                                                 | 拉取式轮询（core_get_status）为主 + subagent-ended 推送即时刷新失败卡片                                                     | 恢复域字段全在 coordinator 内存态，写面后读即有；goal 轮次变化只在 run 收口发生；不为低频状态新增事件推送面（05 D4 确认）                                                                | §3.7.1                                                 |
| D-7 | 00-总纲 :146「每轮 ≤12 个 Agent」是否同步改                                                                                            | 保留（调度批次惯例，非引擎上限）；如评审要求加注                                                                            | 「每轮 ≤12」是轮次执行规则（多 Agent 协同流程），与「同时运行 ≤16」引擎守卫语义不同、不冲突；诉求 2/3 只要求口径与引擎真值一致（16/16/1，扩额依据 = 用户补充需求）                       | AGENTS.md 仅两处替换（§3.5）                           |
| D-8 | goal-round-* 两事件是否本轮登记（05 曾列「可选」）                                                                                     | **登记**（49 口径内含）                                                                                                     | 敲定 §2.2 表列全 8 事件；goal 前端投影化（③）依赖 goal-round-* 事件消费；漏登则投影无事件源                                                                                              | 事件面 + 前端投影                                      |
| D-9 | 水合契约与 D7 的交接边界                                                                                                               | 契约/验收本文件 §3.4 冻结；hydrate.rs 实现归 D7（同文件单写方）                                                             | 00 总纲 D7 关键文件含 hydrate.rs；D8 轮不触碰避免同文件双改；「本轮非可选」由 D7 批次承担                                                                                                | 派单边界；验收 A5                                      |

---

## 附：关键文件索引

| 文件                                                                                                   | 角色                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| crates/conex-types/src/events.rs                                                                       | AgentEvent 41 变体 + 宏 + 背压（登记主落点 :810-893）                                                                                       |
| crates/conex-types/contracts/engine-events.json                                                        | 事件注册表机器可读导出（eventCount 41 :7）                                                                                                  |
| crates/conex-types/tests/{events_schema_version,registry_drift,events_roundtrip,event_hook_mapping}.rs | 登记四测试面（41 断言全在）                                                                                                                 |
| crates/conex-types/tests/fixtures/events-v1/                                                           | v1 同形 fixture（41 条，追加 8）                                                                                                            |
| docs/rust-rewrite/33-event-schema-changelog.md                                                         | 事件登记先例（1.1-1.8）与 1.9 登记落点                                                                                                      |
| crates/orchestrator/src/recovery.rs                                                                    | recovery-* 常量（:103-111）、append_event（:635-651）、payload 真源（:938-950/1008-1016/1051-1063/1162-1168/1198-1204）、访问器（:884-904） |
| apps/agent-workbench/src-tauri/src/core_query_commands.rs                                              | CoreStatus/build_status（:147-225）、parse_envelopes（:483-491）                                                                            |
| crates/session-loop/src/hydrate.rs                                                                     | 水合过滤（:83-93）与测试（:376-387）——D7 接线面                                                                                             |
| apps/crish-desktop/src/components/agent-card/InlineAgentPanel.tsx                                      | 失败态卡片扩展落点（failed 态已有 :195/214/252）                                                                                            |
| apps/crish-desktop/src/hooks/chat-stream/{useGoalMode,useStreamCallbacks}.ts                           | goal 投影化过渡与 ?? 5 修正（useStreamCallbacks.ts:661）                                                                                    |
| apps/crish-desktop/src/api/goalModeController.ts                                                       | GOAL_DEFAULT_MAX_ITERATIONS=12（:16）、decideGoalContinuation（:202-273）过渡兼容                                                           |
| AGENTS.md                                                                                              | 口径修正落点（:23、:48）                                                                                                                    |
| scripts/generate-engine-bindings.mjs                                                                   | 生成链路重跑（产出 shared-types/src/generated/engine/**）                                                                                   |

> 本文档为维度详细设计（只读分析 + 本文档唯一写面）；未修改任何代码、未执行任何 git 操作。行号以抽查当日代码为准，漂移以代码为真源。
