# selection-01 — 选型轮评审报告（评审模型 1/3）

> 产出：评审子代理（general，只读分析 + 本文档唯一写面）· 2026-08-11
> 评审对象：`docs/continuity-repair/proposals/01~05` 五份选型总方案
> 评审方法：逐份通读 + 6 个任务指定分歧点 + 自发现分歧点全部以代码为准抽查核证（行号引用以抽查当日代码为准，漂移以代码为真源）
> 代码抽查清单：`crates/agent-provider/src/retry.rs`（provider_stream_with_observer 全貌）、`apps/agent-workbench/src-tauri/src/engine.rs`（HttpProviderCall::stream / Client::new / timer_steering_queue）、`crates/orchestrator/src/recovery.rs`（RecoveryCoordinator::new / 键 / fingerprint / F2-08 自述）、`crates/orchestrator/src/session.rs`（SessionTree 构造 / checkpoint）、`crates/orchestrator/src/restore.rs`（RestoreOutcome.sessions / interrupted）、`crates/orchestrator/src/normalize.rs`（allows_auto_continue）、`crates/session-loop/src/loop/handlers/stream_error.rs`（transient_retry / handle 分流）、`crates/session-loop/src/hydrate.rs`（error 态过滤）、`apps/agent-workbench/src-tauri/src/core_run_commands.rs`（decide_idle_resume / drain / 子代理收口 / RunTaskOptions）、`apps/agent-workbench/src-tauri/src/watchdog.rs`（每会话 spawn 模式）、`apps/agent-workbench/src-tauri/src/workflow_commands.rs`（真适配先例）、`docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md`（L0-L3）、`docs/continuity-repair/07/08`（领域文档对照）

---

## 1. 评审总评

> 裁决口径（沿用 01 §4 引用的用户裁定）：候选间代码量差距在几千行以内时，直接选效果更好的；代码量为相对估算（含测试）。

| 方案 | 强项 | 弱项 | 盲区 |
|---|---|---|---|
| **01 架构总纲** | ① D1-D8 维度划分结构完整，实施依赖序（DAG）清晰；② 红线/护栏 10 条齐备；③ 动态决策 10 条覆盖面广；④ 正确识别「四源 vs watcher 互补」 | ① 选型 A（退避外包 provider 层）基于对 `provider_stream_with_observer` 的错误前提——该函数是收集式 API（retry.rs:370-463，`Result<Vec<SseFrame>, ProviderError>`），与生产增量流（engine.rs:514-517 unfold）冲突，01 未抽查该函数签名；② D3 未讲清阶梯 1 接线时序（「AutoRetry → 复用拉起器重试」回避了「原 run 终态不可悬置」问题，02 方案 Y 是正确补全）；③ 熔断阈值/窗口参数未定；④ 01 对 D3 的「SessionTree 后置」与自身 §4-B 的「new 需五件套」存在张力（见 §2 分歧 2） | 未覆盖 hydrate error 态的直接修复（05 D1 独有）；未覆盖前端 `?? 5` 与 12 的默认值分叉（03 独有发现） |
| **02 恢复机制** | ① 对 provider_stream_with_observer 的形状核查正确（流式契约冲突论证扎实）；② 方案 Y（收口后重派）解决了 C7 注释「重试不计入 run 失败」与收口刚性时序的矛盾——最关键的接线事实修正；③ W1-W8 接线清单可直接作实现输入；④ 五层护栏表完整 | ① 熔断接线点（壳层收口判定前检查）与 04 的「transient_retry 入口检查」相比生效更晚（run 内重试仍烧 3 次）；② 「10 分钟窗口」参数无对照（04 无窗口、05 60 分钟） | 未覆盖 goal/契约面（非其视角，正常）；未覆盖 watcher 与定时器持久化的详细设计（简略引用 07） |
| **03 Goal 与调度** | ① L0-L3 完成门禁的分级落地建议（本轮 L0+L1）务实；② stalled 检测 D2 工具批指纹论证充分（D1 消息 id 链的误判率分析正确）；③ 断点 2 watcher 与四源的关系界定清晰（watcher 是补充非替代，防重入靠 run 串行守卫）；④ 发现前端 `?? 5` 默认值分叉（useStreamCallbacks.ts:656） | ① 未裁决 C7 装配形态与退避接线位置（超出其视角，正常）；② 未覆盖数据面登记细节（05 补全） | 「summary_json 仅压缩产生」的注入源限制识别正确（F 选型） |
| **04 传输层** | ① 对分歧 1 的事实修正（收集式 vs 增量流）是 5 份中唯一给出决定性证据的；② Retry-After 消费规则分错误类（429 突破 8s 封顶到 5 分钟、5xx/Timeout 纯退避）——比 01/02 更精确；③ 连接配置清单（connect_timeout/keepalive/h2 ping）逐项标注风险；④ 熔断设计（transient_retry 入口检查）生效最早 | ① 熔断「纯连续计数无时间窗」（§6 D4）在长会话中会被成功轮清零、熔断实际难以触发——与自身「防跨 run 反复撞墙」目标有张力（02/05 的时间窗语义更稳）；② failover 独立项判断正确但接入点描述略简 | 未覆盖 C7 装配与 goal（非其视角，正常） |
| **05 契约观测** | ① 20 项数据面全景地图（✅/🟡/❌ 三态）是本轮唯一完整的数据面盘点；② 事件登记 A1 方案的 6 处改动面照抄先例、否决 A2 独立注册表的论证（双序列化）有力；③ 发现 `workflow_commands.rs:400-478` 的 `sched_<cronId>+sched_index` 真适配先例（已核证属实）——store 真适配照抄即可；④ hydrate error 态保留+标记（D1）是唯一覆盖「模型失忆」的直接方案 | ① 熔断窗口默认 60 分钟偏宽（对齐 04 P2-2「3 turn 内」语义上界，但与 02 的 10 分钟不一致，需裁决）；② 「core_resume_run 命令」超出 01-04 任何方案的 P0 共识面（07 P2-6 才列），属增量项需主控确认排期 | 未覆盖退避接线位置与 C7 装配（非其视角，正常） |

**总体判断**：五份方案无不可调和的冲突；分歧全部收敛在 4 个点（退避位置 / C7 装配形态 / 熔断参数与闸面 / 唤醒顺序），且每一处都能以代码证据裁决。01 提供骨架、02 提供接线事实修正、03 提供 goal 判定细节、04 提供传输层精确化、05 提供数据面登记面——整合后即为完整方案（见 §3）。

---

## 2. 分歧裁决表

### 分歧 1：退避接线位置（方案 A 外包 vs 方案 B session-loop 内 vs 方案 C 双层）

| 项 | 内容 |
|---|---|
| 各方立场 | **01**：方案 A（engine 侧外包 `provider_stream_with_observer`），复用 retry.rs 现成实现；**02**：方案 B（transient_retry 内加退避），决定性理由是流式契约冲突；**04**：方案 B，给出事实修正「provider_stream_with_observer 是收集式 API（返回 Vec\<SseFrame\>），与生产增量流矛盾」；**03/05**：未直接裁决（非其视角） |
| 代码核查结论 | **04 的事实修正是正确的，01 的前提不成立**：① `provider_stream_with_observer`（retry.rs:370-463）返回 `Result<Vec<SseFrame>, ProviderError>`（retry.rs:376），其 attempt 闭包契约 `StreamAttempt { frames: Vec<SseFrame>, error, produced_content }`（retry.rs:327-336）——**必须读完整条流才能返回**，是收集式；② 生产 `HttpProviderCall::stream`（engine.rs:435-518）返回 `Result<ProviderEventStream, ClassifiedStreamError>`（engine.rs:438），主体是 `Box::pin(unfold(...))`（engine.rs:514-517）——**增量帧流**，每帧逐事件产出；③ `provider_stream_with_observer` 生产零接线：全仓仅 retry.rs 自身测试引用（retry.rs:1054/1099/1130/1160，均 `#[cfg(test)]` 域）；④ `transient_retry`（stream_error.rs:81-95）是同步 fn、立即重发、无退避，且 `classified.retry_after_ms` 已在 `ClassifiedStreamError` 上（该字段由 engine.rs:620 填充）——会话层决策输入齐全 |
| 裁决 | **方案 B（session-loop transient_retry 内加退避 + Retry-After + 预算）**；方案 C（双层）不做，A 资产保留为 failover 载体（P3） |
| 理由 | ① 正确性：B 是流前（engine.rs:456-488 Err 上抛 → streaming.rs:133）与流中（streaming.rs:117-119）两类瞬态错误的**唯一汇合点**（stream_error.rs:47-77 分流），一处接线覆盖全部；A 任何形态只覆盖流前，A'（流式重试变体）需结构性改造共享 crate 且回归风险集中在 T09.1 增量轨；② 结构：退避是恢复阶梯（stream_error.rs 同文件有 length/压缩阶梯）的自然组成部分，与既有模块头契约一致；③ 代码量：B ≈180-270 行（02 §A.3 / 04 §2.1），A'≈400-500 行且触碰敏感路径；差距在几千行以内，B 同时效果更完整，按用户裁定标准无争议；④ 01 的核心关切「第四处镜像实现漂移」由「测试锁定同期望值」（02 W2 / 04 3-1 验收⑤）消解——recovery.rs:115-120 已有镜像先例且 40+ 测试锁定 |
| 附带裁决 | 退避基数 **750ms**（04 事实修正 2 正确：retry.rs:48 `base_delay_ms: 750`、recovery.rs:116 `RECOVERY_BASE_DELAY_MS = 750`，测试锁定 750→1500→3000，retry.rs:503-514；01 的 600ms 是旧 TS 规范残留）；429 的 Retry-After **突破 8s 封顶钳到 5 分钟**（04 §2.2 正确：retry.rs:128 `max(backoff, retry_after)` 再钳 `max_delay` 的既有语义等于「消费了但没消费」，429+30s 被钳成 8s 必再 429） |

### 分歧 2：C7 装配形态（完整 RecoveryCoordinator 生命周期 vs 仅阶梯 1+2）

| 项 | 内容 |
|---|---|
| 各方立场 | **01**：完整生命周期装配，但**分两步**——阶段 A 阶梯 1+2（fork 前「无叶子则拒绝」受控路径，recovery.rs:1066-1070），阶段 B 再装配 SessionTree 并接线 fork/resume；**02**：完整装配（含 SessionTree 重建），增量 ~200 行换 fork+resume 零二次接线；**03/05**：未直接冲突（03 §4 D3 只拆调度维度；05 §5 将 recover_* 列为 C7 自闭环） |
| 代码核查结论 | ① `RecoveryCoordinator::new`（recovery.rs:846-876）**五件套全部必传**：store/queue/tree/spawner/policy（recovery.rs:847-852），且 `new()` 自动从 session_meta 恢复预算/forks/通知/needs_user（recovery.rs:855-863）——**不存在「轻量构造」选项**，01 与 02 的分歧只在 tree 怎么来；② `SessionTree::new(session_id)`（session.rs:334）是廉价空树；`from_session_record`（session.rs:589）从快照重建（有既有往返测试，session.rs:1320-1331）；③ `RestoreOutcome.sessions: Vec<SessionRecord>`（restore.rs:100）在 restore.rs:679-694 已组装（含 branches/current_leaf_id）——**重建数据现成，无需额外查询**；④ 01 自身的 §4-B 也承认「fork_and_reassign 依赖 tree.fork（recovery.rs:1091-1098）、lifecycle.rs:276-282 依赖 subagent_path_json 推叶子」——阶段 B 补树 = 改装配点二次接线 |
| 裁决 | **采纳 02 的完整装配（同一轮含 SessionTree 重建 + spawn_blocking helper）**；01 的「分两步」否决 |
| 理由 | ① 代码量差仅 ~200 行（树重建 ~50 + spawn_blocking ~40 + 装配 ~110，02 §B.2），远在几千行以内，按用户裁定标准选效果好的；② 01 的「阶段 A 传空树」制造**假接线**：预算/通知先跑起来、fork 被结构化拒绝，阶段 B 再回来改同一装配点——违反「禁补丁/禁二次接线」纪律（02 §B.1 论证成立）；③ 树重建的输入（SessionRecord）restore 时已在手，与 `run_restore` 成功路径（core_run_commands.rs:2195-2227）同批装配成本最低；④ spawn_blocking（F2-27）不可避免（RecoveryStore 是同步 SQLite trait，recovery.rs:594-620，模块头 :61-62 明言），`save_run_usage`（core_run_commands.rs:2958）已有先例 helper |
| 附带裁决 | 阶梯 1 接线形态采纳 **02 方案 Y（收口后重派）**：原 run 照常 failed（reason=`recovery-retry`）、预算内经 spawner 重派（不消费 Episode、无 steering 通知）——run 状态机 9 态无「重试中」态、收口链刚性（on_subagent_run_terminal 在 decide_idle_resume 之前，core_run_commands.rs:2840-2852），01 的「AutoRetry → 复用拉起器重试」未讲清原 run 终态，02 是唯一自洽落地形态 |

### 分歧 3：goal 位置（收口 RoundAssessment + session_meta goal_state 键）

| 项 | 内容 |
|---|---|
| 各方立场 | 01/02/03/05 全部收敛于：`RunTaskOptions` 补三字段（serde 静默丢弃已核证：core_run_commands.rs:3123-3143 无 visible_goal/max_rounds/max_stalled_rounds）→ session_meta `goal_state` 键 → 收口 RoundAssessment 纯函数 → 四源判定扩展 → 事件登记。05 补充事件登记细节（goal-round-*/goal-continuation-decided，载荷对齐 TS GoalContinuationDecision） |
| 代码核查结论 | 无实质冲突。佐证：`allows_auto_continue`（normalize.rs:177-179）仅 Stop 放行、**零生产调用**（仅测试 normalize.rs:521-525），是「首个生产调用方」论断的现成载体；steering BeforeTurn 占位（03 §2A 论证的相位错位）成立 |
| 裁决 | **一致采纳**（本分歧无裁决必要，确认收敛即可）；事件登记细节以 05 §2A 的 A1 主注册表路线为准（6 处改动面先例照抄） |
| 附带裁决 | 采纳 03 的 stalled 签名 D2（工具批指纹、无工具轮不变）与「注入主源 = goal_state.goal、nextSteps 仅压缩发生时增强拼接」（summary_json 仅压缩产生，03 F 选型正确） |

### 分歧 4：熔断与预算的键设计（独立键 vs 同一键不同指纹）

| 项 | 内容 |
|---|---|
| 各方立场 | 主 run 预算：01 = 同键 `recover_episodes` + 指纹前缀 `main-` + session_id + 任务哈希；02 = 同键同池，`subagent_id="main"` + 任务文本（复用 `fingerprint(subagent_id, task)` 签名，recovery.rs:251）；熔断：01/02/05 均为独立键 `provider_fail_streak`（05 明确不复用 recover_* 前缀）。**各方实质一致，无 01 §4-F 渲染的「独立键 vs 同键」对立** |
| 代码核查结论 | ① `fingerprint(subagent_id, task)`（recovery.rs:251）签名即（id, task）；`RecoveryBudget`（recovery.rs:276-336）按 fingerprint 计数、`can_recover/record_fork`（:299-316）按指纹判上限——同键不同指纹天然隔离，无需新机制；② `recover_episodes` 键形状已冻结（recovery.rs:84-93），宽容解析 fail-open（:327-335） |
| 裁决 | ① 主 run 预算：**同键 `recover_episodes` + `subagent_id="main"` 参与指纹**（采纳 02 形态；01 的 `main-` 字符串前缀与现有签名不一致，且 session_id 已隐含在会话键域，属冗余）；② 熔断：**独立键 `provider_fail_streak`**（采纳 01/02/05 共识，05 的「不复用 recover_* 前缀」纪律成立——熔断按会话计数、预算按指纹计数，语义不同）；③ 熔断窗口：**采纳 02 的 10 分钟窗口 ≥6 次（可配）**，否决 04 的纯连续计数（成功即清零在长会话中使熔断几乎不触发，与「防跨 run 反复撞墙」目标相悖）、否决 05 的 60 分钟（过宽，6 次瞬态 fatal 在 1 小时内几乎必然发生，熔断失甄别力） |
| 附带裁决 | 熔断闸面：**采纳 04**——熔断期内跳过 run 内重试（transient_retry 入口检查，直接 fatal 转上报），同时闸跨 run 自动恢复；否决 02 的「run 内保留」：连续 6 次 fatal 后 run 内 3 次立即重试大概率仍撞墙，等于继续烧 3 次配额；用户手动路径不受限（04 §6 D7 与「用户显式停止永不自动续」红线对称） |

### 分歧 5：完成判定 L0-L3（本轮做几级）

| 项 | 内容 |
|---|---|
| 各方立场 | **03**：本轮 L0（文案 DONE 仅候选）+ L1（checklist 全勾 && decision=complete），L2 退化为「本轮有成功 tool 结果」计数（成本≈0），L3（磁盘 oracle）后置；**08 领域文档**：无显式 L0-L3 表述，但其 P1 列 CompletionRequirement（与 01 D5 轻量版同源），oracle 属「软件级 AI 测试强制」设施 |
| 代码核查结论 | L0-L3 定义源：`docs/archive/campaigns/system-completion-plans/plans/03-goal-loop-and-inapp-ai-testing.md:126-129`（L0 文案 / L1 结构化 / L2 证据 / L3 磁盘 oracle「软件级 AI 测试强制、长程回归强制」）——L3 定位本就是测试门禁而非产品路径；01 D5 ⑦ 的 CompletionRequirement 独立预算与 03 的 L0+L1 正交不冲突 |
| 裁决 | **采纳 03**（本轮 L0+L1，L2 退化为计数，L3 后置随长程回归设施） |
| 理由 | ① L1 的 Rust 侧 checklist 解析 ~150 行且与前端 prematureDoneClaim 语义对齐（03 §2E）；② L3 需新约定路径/内容/哈希 + 回归 runner，是「AI 长程测试」的门禁，捆绑本轮会拖慢产品路径；③ 与 grok 参照系一致（CompletionRequirement/TodoGate 也是轻量判据而非 classifier 全链，08 §4 排除项 3） |

### 分歧 6：唤醒机制（四源扩展 vs 独立 watcher）

| 项 | 内容 |
|---|---|
| 各方立场 | **01**：互补关系，两者都做，顺序先四源后 watcher；**03**（按任务书转述）：「四源扩展为主、独立 watcher 必要性存疑」；**07 领域文档**：独立 watcher 是关键一跳（P0-2） |
| 代码核查结论 | **任务书对 03 的转述与实际文档不符**：03 §3 断点 2 明确「最小接线（独立唤醒 watcher）」，且明言「断点 2 watcher 是『无人值守』最关键的最后一跳（07 §5 P0-2）」（03 :222），§4 D3 将 watcher 列为「可拆、可先于 D1 落地」——**03 与 01/07 在「watcher 必须做」上完全一致**，差异仅在顺序与耦合。事实基础：`decide_idle_resume` 只在收口判定（core_run_commands.rs:2505-2593，调用点 :2861-2872）；AI 休眠后定时器到期条目入队无消费方（07 G2 断点 A）；watchdog 只管子代理 dispatch 场景（watchdog.rs:233-302），但每会话 tokio 周期任务 spawn 模式现成（watchdog.rs:307-312） |
| 裁决 | **都做**（01/03/07 共识）：① 四源扩展（goal_pending）随 D5 goal 维度落地（依赖 goal_state）；② 独立 watcher 随调度唤醒维度**独立先行**（不依赖 goal 任何部件，03 §4 D3 论证成立），顺序按 07：定时器/Cron 真适配（P0-1）→ watcher（P0-2）→ 恢复条目（P1-3）；③ 否决 01 的「先四源后 watcher」顺序——watcher 是「收口后新事件到达」的唯一消费方，且不依赖四源，先落地即可覆盖子代理完成/定时器源；watcher 判定条件与 decide_idle_resume 护栏对齐（复用 resume_empty_streak，core_run_commands.rs:2561-2582）、防重入靠同会话单活动 run 守卫（core_run_commands.rs:3208-3216） |
| 附带裁决 | 空转护栏对「仅定时器源续 run 空注入轮」的误伤处理采纳 01 决策 7（空注入轮不计入 streak——按「本轮是否有真实任务输入」区分），与 07 G5 同向 |

### 自发现分歧（评审过程中追加裁决）

| # | 分歧点 | 各方 | 核查结论 | 裁决 |
|---|---|---|---|---|
| 7 | 阶梯 1 接线时序 | 01 未明说原 run 终态；02 方案 Y（收口后重派，原 run failed reason=recovery-retry） | 收口链刚性：produce → 置终态 → on_subagent_run_terminal（core_run_commands.rs:2840-2852）→ 移出注册表；run 状态机无「重试中」态 | **采纳 02 方案 Y**（见分歧 2 附带裁决） |
| 8 | hydrate error 态处理 | 01 决策 3：机制面恢复走 SessionHistoryCache，前端路径 error 态过滤维持现状（双路径统一列 D8 可选收尾）；05 D1：hydrate 放行 error 态 + metadata 标记（15-30 行） | hydrate.rs:87-93 `is_completed` 只放行 completed/空串，error 态跳过（有测试锁定 :376-382）——「模型失忆」真实存在 | **采纳 05 D1（直接修复，改动小）**，01 的「缓存主源」作为机制面保障并行（两者互补：05 治「用户手动路径的水合」，01 治「自动恢复路径的 history 源」） |
| 9 | 熔断闸面 | 02：熔断只闸跨 run 自动恢复、run 内 3 次保留；04：熔断跳过 run 内重试直接 fatal | 04 的接线点（transient_retry 入口 + options 注入 streak）生效最早 | **采纳 04**（见分歧 4 附带裁决） |
| 10 | 主 run 预算指纹形状 | 01：`main-` + session_id + 任务哈希；02：`subagent_id="main"` + 任务文本 | `fingerprint(subagent_id, task)`（recovery.rs:251）签名即 (id, task) | **采纳 02**（贴现有签名，隔离语义等价） |
| 11 | `core_resume_run` 命令 | 05 新增（复用 run_task_impl + history 水合）；07 P2-6 列 | 命令面引擎侧全通只差 IPC（lifecycle.rs:243-321；core_run_commands.rs:2103-2120 `#[cfg_attr(not(test), allow(dead_code))]` T-D-12 注释为唯一拦路牌） | **接纳为 P2 项**（与 resume_subagent/kill_all 同一命令登记轮，05 §2.C 的 C1 路线），不占 P0/P1 排期 |

---

## 3. 最佳整合方案（在 01 骨架上的整合）

### 3.1 目标架构一句话

把「继续工作」收敛为**单一「run 边界决策 + 唤醒源汇聚 + 拉起器复用」机制**：所有自动继续（error 可重试 / goal 未完成 / 定时器到期 / 子代理失败 / 重启恢复 / watcher 异步唤醒）共用 `PendingMessageQueue + decide_idle_resume + spawn_idle_resume_run` 通道（core_run_commands.rs:2505-2671），差异仅在唤醒源与注入文本；恢复语义由 C7 RecoveryCoordinator（完整装配）与 Episode 预算制托底；用户显式停止永不自动续。

### 3.2 维度划分（对 01 的 D1-D8 的增删改）

| 01 维度 | 整合后 | 变化 | 理由 |
|---|---|---|---|
| D1 传输层退避与连接硬化 | **保留，改接线点** | 接线点从「外包 provider_stream_with_observer」改为「transient_retry 内退避 + Retry-After + 预算」（分歧 1 裁决）；熔断并入本维度（04 闸面，分歧 4/9 裁决）；连接配置（Client::builder）保留 | 收集式/增量流事实修正 |
| D2 主 run 错误收场自动续 run | **保留** | 预算指纹改为 `subagent_id="main"`（分歧 4 附带）；`RunOutcome.provider_error` 数据面（W1）先行 | — |
| D3 C7 恢复阶梯生产接线 | **保留，改装配形态** | 完整装配含 SessionTree 重建（分歧 2 裁决）；阶梯 1 接线采纳 02 方案 Y | 假接线否决 |
| D4 子代理显式恢复命令面 | **保留** | 追加 05 的 `core_resume_run` 为 P2（分歧 11）；wait 持久化（MemoryWaitStore 换真适配）保留 | — |
| D5 goal 引擎化与完成契约 | **保留，增细节** | stalled 签名 = 工具批指纹（03 D2）；完成判定本轮 L0+L1（分歧 5）；注入主源 = goal_state.goal、nextSteps 增强拼接（03 F）；前端 `?? 5` 分叉统一（03 独有发现） | — |
| D6 无人值守唤醒链路 | **保留，调整顺序** | watcher 独立先行（不依赖 D5），顺序：定时器/Cron 真适配 → watcher → 恢复条目（分歧 6 裁决）；否决 01 的「先四源后 watcher」 | — |
| D7 checkpoint 机制面闭环 | **保留** | 采集接线 + 恢复注入（read_leaf_checkpoint 现成，session.rs:514-574） | — |
| D8 观测、UI 与口径对齐 | **保留，增一项** | 增 hydrate error 态修复（05 D1，15-30 行）——从 01 决策 3 的「可选收尾」提升为本轮项（分歧 8）；其余（事件登记/口径修正/失败态卡片）不变 | 「模型失忆」直接修复成本极低 |

**增删结论**：不增不删维度，8 个维度全部保留；D1 换接线点、D3 换装配形态、D6 调整内部顺序、D8 增 hydrate 项。维度间接口契约（01 §2.2 表）维持：`RunOutcome.provider_error`（D1→D2/D3）、recover_* 键与 RecoveryCoordinator 装配（D3→D4）、goal_state 键与四源（D5→D6）、队列与拉起器（D2/D6/D7 共享）——无冲突、无缺口（详见 §4）。

### 3.3 各维度要点（整合后的完整形态）

**D1 传输层**：① `transient_retry` 改 async（stream_error.rs:81-95），`sleep = max(指数退避 750ms×2^(n-1), retry_after_ms)`，429 钳 5 分钟、其余钳 8s、再钳 60s 剩余预算（04 §2.2）；`LoopState.transient_retry_started_at` 预算起点；`SessionLoopOptions.retry_backoff: Option<...>`（None=现状，向后兼容）；② 熔断：session_meta `provider_fail_streak`（JSON：count/window_start/tripped_until，10 分钟窗口 ≥6 次 → 熔断 5 分钟，可配），transient_retry 入口检查直接 fatal，壳层收口成功清零；③ `Client::builder()`（connect_timeout 10s / tcp_keepalive 30s / h2 ping 30s+5s，不设总超时，engine.rs:1093 封装 `build_http_client` 单点）；④ 流中断标注增强（04 §2.6：providerErrorKind/providerErrorRetryable）。

**D2 主 run error 续 run**：`RunOutcome.provider_error`（fatal 填充，stream_error.rs:237-269）+ `decide_idle_resume` 放行 `reason==Error && retryable && !熔断 && 预算内`（:2513 硬条件处新增分支）→ 队列入队系统条目 → `spawn_idle_resume_run` 拉起；预算指纹 `fingerprint("main", 首条 user 消息文本)` 落 `recover_episodes`；护栏：连续 error ≤3（预算）+ 退避 + user_touched/abort 不续 + 非 retryable 不续。

**D3 C7 接线**：完整装配（core_run_commands.rs:1474-1600 CoreRunState::new 增 `recovery_coordinators`/`session_trees` 两张表 + `blocking_store_call` helper 仿 :2958；run_restore 成功路径 :2195-2227 后 `from_session_record` 重建树 + `restore_steering_notifications()`）；触发点：子代理收口（:2844-2852）on_subagent_run_terminal 前还原 RunFailureContext → `on_subagent_run_failure`（recovery.rs:914）；阶梯 1 = 方案 Y（重派新 run，mode=recovery-retry，不消费 Episode、无 steering）；阶梯 2 steering+落库；阶梯 4 上报；全部持久化调用 spawn_blocking（F2-27）。

**D4 命令面**：`resume_subagent`/`kill_all` 翻注册（lifecycle.rs:131-321 现成，去 dead_code 豁免）+ `core_resume_run`（P2）；MemoryWaitStore 换 session_meta 真适配（wait_channel.rs:104-162，键 `dispatch_*`/`dispatch_outputs` 已冻结）；命令双端四步登记（main.rs + command_manifest.rs + commandManifest.ts + commandMap.ts）。

**D5 goal 引擎化**：RunTaskOptions 三字段（camelCase 对齐前端）→ session_meta `goal_state`（JSON：goal/max_rounds/max_stalled_rounds/current_round/stalled_rounds/progress_signature/stopped_reason，fail-open 解析）→ 收口 RoundAssessment 纯函数（L0+L1 完成门禁 + 工具批指纹 stalled）→ 四源 goal_pending（`allows_auto_continue` 首个生产调用）→ 续轮注入（goal 前缀 + nextSteps 增强）→ `goal-round-*`/`goal-continuation-decided` 事件登记（05 §2A 六处照抄）；CompletionRequirement 轻量版挂同评估点（独立预算，01 决策 9）。

**D6 唤醒链路**：① TimerStore/SchedStore 真适配（workflow_commands.rs:400-478 先例照抄，键 `timer_<id>`/`sched_<id>` + 索引键）；② 独立 watcher（复用 watchdog.rs:307-312 每会话 spawn 模式，判定 = 队列非空 && 无活动 run → spawn_idle_resume_run，护栏对齐）；③ 重启恢复条目（run_restore 对 interrupted 逐条生成 group_id=`restore-<run_id>` 条目，watcher/收口消费）。

**D7 checkpoint**：收口 `collect_checkpoint_from_messages`（safe_point.rs:255-278）→ `set_leaf_checkpoint`（session.rs:545-574）；`spawn_idle_resume_run` 注入时 `read_leaf_checkpoint`（session.rs:514-538）拼「检查点摘要」；损坏载荷降级不阻断。

**D8 观测/UI/口径**：事件登记（recovery-* ×5 + goal-* ×3，backpressure critical）；`core_get_status` 暴露 RecoveryStatus（recover_needs_user/recover_episodes/pending_recoveries/goal_state）；前端失败态卡片 + resume 按钮；hydrate error 态保留 + `failed-turn` 标记（05 D1）；AGENTS.md「一轮最多 12 个」口径修正为「同时运行 ≤12、同父 ≤5、深度 1」。

### 3.4 实施依赖序（逻辑 DAG，不含工期）

```
D1 传输层（退避+熔断+连接配置）────────────────┐
                                             ├─→ D2 主 run error 续 run ──┐
D6a 定时器/Cron 真适配 → D6b 独立 watcher ───────┘                          │
D3 C7 完整装配（含树重建）─→ D4 命令面/wait 持久化                            │
D5 goal 引擎化（含事件登记）───→ D6c 四源 goal_pending（并入 D5 同轮）─→ D7 checkpoint
D8 横切：事件登记随 D3/D5 同步；hydrate 修复可独立先行（15-30 行）；口径修正任意时点
```

- **关键路径**：D1 → D2 → D6b → D7（断网继续 → 异步唤醒 → 恢复质量）；D5 与 D1 独立可并行。
- **并行集**：{D1, D3, D5, D6a, D8-hydrate} 互相独立；D2 依赖 D1；D6b 依赖 D6a 不依赖 D5；D6c（四源）随 D5；D4 依赖 D3；D7 依赖 D6b（拉起器是注入载体）。
- **与 01 顺序的差异**：① watcher（D6b）从「D6 整体」中提前到与 D1/D3/D5 并行集（分歧 6）；② hydrate 修复从「D8 可选收尾」提前为独立可先行项（分歧 8）。

---

## 4. 维度划分评审（01 的 D1-D8）

### 4.1 互斥性

**基本互斥，有一处边界重叠**：D2 与 D5 在「decide_idle_resume 扩展」上共享判定器（D2 放行 Error+retryable、D5 新增 goal_pending 第四源）——同函数两处修改，不构成功能重叠（不同分支），但**实现上必须同批改 `decide_idle_resume`**（02 的「共享判定入口」判断正确），建议主控派单时把 D2 与 D5 的判定器修改列为同文件串行。其余维度（传输层/装配/命令面/唤醒/checkpoint/观测）按文件域天然隔离：D1=session-loop+engine，D3/D4=orchestrator+core_run_commands，D5=core_run_commands+session-loop，D6=timers/sched/watchdog+core_run_commands，D7=safe_point/session+core_run_commands，D8=conex-types+前端。

### 4.2 全覆盖性

对照 00 总览的 4 诉求 × 9 缺口（00 §二）：诉求 1（断网继续）=D1/D2；诉求 2（子代理上限口径）=D8；诉求 3（子代理恢复）=D3/D4；诉求 4（一直工作）=D5/D6/D7。缺口覆盖：G1-G3=D1，G2/G9=D2/D3，G4/G8=D8，G5/G6=D2/D8，G7=D2 数据面，G10=D6③。**覆盖完整，无遗漏缺口**。

### 4.3 接口契约（数据面/事件/命令）

| 接口 | 方向 | 契约 | 缺口/冲突 |
|---|---|---|---|
| `RunOutcome.provider_error` | L1→L2 | kind/retryable/retry_after_ms/retries | 无（01 决策 4 与 04 §3-6 一致；`retries` 语义 = LoopState.transient_retries，02 D8 已定义） |
| `RunFailureContext` 还原 | L2 壳层 | subagent_id/task/error_kind/retries/produced_content/from_leaf_id/inject_bytes/window_bytes | 02 W4 已给全装配清单；与 04 §3-6 的还原点（收口 on_subagent_run_terminal 前）一致 |
| recover_* 五键 | L2↔L3 | 形状冻结（recovery.rs:84-93），RecoveryCoordinator 单写方 | 无（05 §5「入口出口集中、机制面分散」裁定成立） |
| goal_state 键 | L2↔L3 | 唯一写方 = run 收口 RoundAssessment（round 边界），会话内串行守卫保证无并发写（core_run_commands.rs:3208-3216） | 无（05 §2B 论证） |
| 事件登记 | L2→conex-types | recovery-* ×5 + goal-* ×3，主注册表 minor 新增 6 处 | 05 §2A 已锁定改动面；recovery 域继续走 `append_event` 直写（05 D1），不改造 emit 层 |
| 命令面 | 壳层↔前端 | resume_subagent/kill_all/core_resume_run 双端四步 | 05 §2C 已锁定；`#[cfg_attr(not(test), allow(dead_code))]` 豁免需删除（core_run_commands.rs:2106） |
| hydrate 标记 | L3→模型 | error 态保留 + metadata `{kind:"failed-turn"}` | 05 D1 已定义；无 schema 改动 |
| 熔断键 | L2↔L3 | provider_fail_streak 独立前缀，宽容 fail-open | 无（分歧 4 裁决） |

**契约冲突**：无。**契约缺口**：唯一一处是 01 的「D2 放行 Error」与 `decide_idle_resume` 现有 `reason != Stop` 硬条件（core_run_commands.rs:2513）的语义扩展——必须显式写清「Error+retryable+预算内」分支与「用户显式停止（Stopped/Aborted）永不续」的边界，防止实现时把 Aborted 也放行（01 红线 3 与 02 W5 护栏均覆盖，实现时照抄即可）。

### 4.4 命名与拆分建议

| 建议 | 说明 |
|---|---|
| D5 更名「goal 引擎化与完成契约」→ 保留 | 名字已准确（含 CompletionRequirement 轻量版） |
| D6 内部拆为 D6a/D6b/D6c | 定时器持久化（纯存储，可独立验收）/ watcher（队列→拉起）/ 四源并入 D5——拆开供派单粒度使用，维度本身不必改名 |
| D1 与 04 的「连接配置」合并 | 01 D1 已含，确认即可，无需拆分 |
| 不新增「数据面」维度 | 05 的内容（事件/键/命令）分散随各机制维度走、入口出口集中（05 §5 裁定），不应为数据面单列维度——否则与 D8 横切职责重叠 |

---

## 5. 问题清单（按严重程度分组）

### 5.1 事实错误（必须修正）

| # | 位置 | 问题 | 修正依据 |
|---|---|---|---|
| F1 | 01 §4-A | 推荐「外包 provider_stream_with_observer」——该函数是收集式 API（返回 Vec\<SseFrame\>），与生产增量流（engine.rs:514-517 unfold）契约冲突，01 未核查函数签名 | retry.rs:370-376、:327-336；engine.rs:435-518（04 事实修正 1 正确） |
| F2 | 01 §4-A 对比表 | 「退避逻辑零新写」表述误导——外包方案本身不可落地，不存在「零新写」的 B 侧镜像 | 同 F1；B 方案需镜像常量但被测试锁定（04 §2.1） |
| F3 | 01 §4-F / 00 总览 | 渲染「熔断独立键 vs 预算同键」为选型对立——实际各方一致（熔断独立键、预算同键不同指纹），不存在 01 描述的「候选 2 单独计数」被否决的对立 | recovery.rs:251（fingerprint 签名天然支持同键不同指纹） |
| F4 | 01 D1 | 「缺省指数退避 600ms × attempt」——代码真值是 750ms（retry.rs:48、recovery.rs:116，测试锁定 750/1500/3000） | retry.rs:503-514（04 事实修正 2 正确） |
| F5 | 03 的「重试不计入 run 失败」（引用 recovery.rs:13-14 注释）作为可直接实现的语义 | 生产收口链刚性，阶梯 1 落地形态必须是 02 方案 Y（收口后重派）——03 未涉及此细节不算错，但整合时必须采纳方案 Y | core_run_commands.rs:2840-2852；02 §2-B.3 |

### 5.2 逻辑矛盾 / 张力（必须裁决）

| # | 位置 | 问题 | 裁决 |
|---|---|---|---|
| L1 | 01 §4-B「SessionTree 后置」vs 自身「new 需五件套」 | 阶段 A 传空树 = 假接线；阶段 B 补装配 = 二次接线 | 采纳 02 完整装配（分歧 2） |
| L2 | 02 W6 熔断「只闸跨 run」vs 04「闸 run 内重试」 | 02 的闸面让 run 内继续烧 3 次 | 采纳 04（分歧 9） |
| L3 | 04 §6 D4 熔断「纯连续计数无时间窗」vs 02/05 时间窗 | 成功即清零使熔断在长会话中几乎不触发 | 采纳 02 的 10 分钟窗口（分歧 4） |
| L4 | 01 决策 3「前端 error 态过滤维持现状」vs 05 D1「直接修复」 | 01 把根治列 D8 可选收尾，05 证明改动 15-30 行 | 采纳 05（分歧 8） |
| L5 | 01 决策 7「空注入轮不计入 streak」vs 03 护栏 3「goal 空转计入」 | 两处空转语义不同场景：01 管「仅定时器源」、03 管「goal 纯文字轮」——不矛盾但需在实现时分开计数 | 维持两处各自语义；实现时以「注入文本是否为空」与「goal 轮是否有工具批进展」分别判定 |

### 5.3 遗漏（应补入整合方案）

| # | 遗漏 | 补充来源 |
|---|---|---|
| M1 | 前端 `?? 5` 与 `GOAL_DEFAULT_MAX_ITERATIONS=12` 的默认值分叉（useStreamCallbacks.ts:656） | 03 §1.1 事实修正（仅 03 发现） |
| M2 | hydrate error 态直接修复 | 05 §2.D D1（仅 05 覆盖） |
| M3 | Retry-After 429 突破 8s 封顶钳到 5 分钟的规则 | 04 §2.2（仅 04 精确化） |
| M4 | 熔断接线点放 transient_retry 入口（比壳层收口判定早一层） | 04 §2.5 |
| M5 | `workflow_commands.rs:400-478` 真适配先例（store 照抄模板） | 05 §0-3（已核证属实：workflow_commands.rs:59-62、400-446） |
| M6 | 子代理 run 不参与 idle 续 run 的既有语义（core_run_commands.rs:2867-2871）需在 D5/D6 实现时保持 | 02 D10 / 03 护栏 7 |
| M7 | 失败尝试的 usage 不计账（防重复记账） | 04 §4.4 D5（无代码改动，仅记录纪律） |

### 5.4 过度设计（应排除或降级）

| # | 项 | 理由 |
|---|---|---|
| O1 | 05 的 `core_resume_run` 命令列入 P0/P1 | 引擎侧无实现体（07 P2-6 才列），resume_subagent/kill_all 才是「翻注册」项；core_resume_run 降 P2（分歧 11） |
| O2 | 04 的 A'（增量流重试封装） | 回归风险集中于 T09.1 增量轨，B 已吸收 90% 场景（04 §2.1 自判），不做 |
| O3 | 03 的 F2（独立 TASK.md 载体） | 需新建写路径管控 + 双份目标状态同步，300+ 行；summary 读取面（F1）+ goal 前缀主源已够（03 §2F 自判） |
| O4 | 01 决策 8 的「子代理消息序列全量 checkpoint」 | 属大件后置；最小形态 = fork 时产出清单 + 断点位置随 ForkRecord 落库（01 决策 8 已自限） |
| O5 | failover（provider 主备链）进本期 | 500-800 行 vs 熔断 80-120 行，量级差一个数量级，仅对多端点用户生效（04 §2.4 自判 P3） |

---

## 6. 建议调整清单（给主控）

### 采纳（直接并入整合方案）

1. **退避接线：方案 B（session-loop transient_retry 内）**，否决 01 的方案 A 外包（分歧 1）——01 §4-A 的推荐作废，其「备选方案 A」表述从 00 总览 §三.2 中删除。
2. **C7 装配：完整装配含 SessionTree 重建**（分歧 2），采纳 02 的 W3/W4/W7 接线清单为 D3 的实现输入。
3. **阶梯 1 形态：02 方案 Y**（收口后重派，原 run failed reason=recovery-retry，预算内重派，不消费 Episode、无 steering 通知）。
4. **熔断：独立键 provider_fail_streak + 10 分钟窗口 ≥6 次熔断 5 分钟（可配）+ 闸 run 内重试（04 闸面）**（分歧 4/9）。
5. **主 run 预算指纹：`subagent_id="main"` + 任务文本，同键 recover_episodes**（分歧 4 附带）。
6. **goal：收口 RoundAssessment + goal_state 键 + 四源 + L0/L1 完成门禁 + 工具批 stalled 签名 + 注入主源 goal 前缀**（分歧 3/5），事件登记按 05 §2A 六处照抄。
7. **唤醒：四源与 watcher 都做；watcher 独立先行（定时器真适配 → watcher → 恢复条目）**（分歧 6），否决 01 的「先四源后 watcher」顺序。
8. **hydrate error 态修复（05 D1）列为本轮 D8 项**（分歧 8）。
9. **退避基数 750ms、429 Retry-After 突破 8s 钳 5 分钟**（04 事实修正 2/§2.2）。
10. **前端 `?? 5` 分叉统一为 12**（03 §1.1，随 D5 前端投影轮处理）。
11. **wait 持久化与 timer/sched 真适配照抄 workflow_commands.rs:400-478 先例**（05 §2F，已核证）。

### 否决 / 降级

1. **否决 01 的 D3 分两步装配**（假接线，二次接线，分歧 2）。
2. **否决 04 的熔断纯连续计数**（长会话不触发，分歧 4）。
3. **否决 02 的熔断「run 内保留」闸面**（继续烧配额，分歧 9）。
4. **否决 05 的熔断 60 分钟窗口**（过宽失甄别力，分歧 4）。
5. **否决 05 的 core_resume_run 进 P0/P1**（降 P2，分歧 11）。
6. **否决 04 的 A' 增量流重试封装**（回归风险，05.4-O2）。
7. **否决 03 的 TASK.md 载体**（双份目标同步，05.4-O3）。
8. **failover 维持 P3 独立项**（05.4-O5）。

### 需主控拍板的剩余项

1. 熔断阈值/窗口的可配默认值（10 分钟/6 次/5 分钟冷却——采纳 02，但建议暴露可配键）。
2. `core_resume_run` 是否本轮排期（本评审建议 P2，若用户裁定「重启续跑」优先则提前）。
3. 阶梯 1 重试次数默认（RecoveryRetryPolicy.max_retries 默认 2——02 W3 建议壳层装配为 2，与内核 3 次叠加共 5 次瞬态尝试/任务）。
4. goal 完成轮 run 终态 reason 用 `goal-completed` 字面量（03 决策 4）是否与前端现有 completed 判定兼容——需前端投影轮验证。

---

## 7. 动态决策记录

| # | 问题 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 1 | 任务书对 03 的转述（「watcher 必要性存疑」）与实际文档不符 | 以 03 文档原文为准：03 完全支持独立 watcher（§3 断点 2、§4 D3），分歧 6 实为「顺序与耦合」分歧而非「做不做」分歧 | 评审以文档为证据面；转述差异不改变裁决结论（都做） | 分歧 6 裁决依据 |
| 2 | 熔断窗口三份方案三种值（02:10 分钟 / 04:无窗口 / 05:60 分钟） | 采纳 02 的 10 分钟，可配 | 04 无窗口在长会话失效、05 过宽；10 分钟对齐 retry 预算时长量级且匹配「两次 run 耗尽」语义 | D1 熔断参数 |
| 3 | 01 的「D8 可选收尾」与 05 的 hydrate 直接修复的排期冲突 | 采纳 05 直接修复（15-30 行），列为 D8 本轮项 | 改动极小、直接治「模型失忆」（hydrate.rs:87-93 已核证），无理由后置 | D8 范围 |
| 4 | 阶梯 1「重试不计入 run 失败」注释（recovery.rs:13-14）与收口刚性时序 | 采纳 02 方案 Y：原 run failed + 重派新 run，语义等价于「自动重试」 | run 9 态状态机无重试态、收口链不可悬置（core_run_commands.rs:2840-2852） | D3 接线形态 |
| 5 | 主 run 预算指纹形状（01 前缀式 vs 02 签名式） | 采纳 02：`fingerprint("main", task)` | 贴现有签名（recovery.rs:251），隔离语义等价，无冗余 | D2 预算 |
| 6 | 熔断键是否并入 recover_* 前缀 | 独立键 provider_fail_streak | 熔断按会话计数、预算按指纹计数，语义不同（05 §2B 纪律：各能力独占键命名空间） | D1 数据面 |

---

## 8. 结论（评审要点汇报）

**总评**：五份方案无不可调和冲突，收敛为「接线而非新写」共识；01 骨架 + 02 接线事实修正 + 03 goal 判定细节 + 04 传输层精确化 + 05 数据面登记面即为完整方案。

**六大分歧裁决**：① 退避放 **B（session-loop transient_retry）**——04 的事实修正正确（`provider_stream_with_observer` 是收集式，retry.rs:370-376，与增量流 engine.rs:514-517 冲突），01 方案 A 作废；② C7 **完整装配含 SessionTree 重建**（02）——树重建 ~50 行、restore 数据现成（restore.rs:679-694），01 分两步是假接线；③ goal 位置**收口 RoundAssessment + goal_state 键**——各方一致无冲突；④ 熔断 **独立键 + 10 分钟窗口**、主 run 预算 **同键 `subagent_id="main"` 指纹**——01/02 实质同案，取 02 签名形态；⑤ 完成判定 **本轮 L0+L1**（L3 是长程回归测试设施，03-goal-loop §4.1:126-129 定位即如此）——采纳；⑥ 唤醒 **四源与 watcher 都做**——03 实际完全支持 watcher（任务书转述有出入），watcher 独立先行（07 顺序），否决 01 的「先四源后 watcher」。

**整合方案骨架**：保留 01 的 D1-D8（不增不删），改 4 处：D1 换接线点（B 方案）、D3 换装配形态（完整装配+方案 Y）、D6 调整顺序（watcher 独立先行）、D8 增 hydrate 修复项。实施依赖序：D1→D2→D6b→D7 为关键路径；{D1, D3, D5, D6a} 并行；D6c（四源）随 D5；D8 横切同步。

**产出文件**：`docs/continuity-repair/reviews/selection-01-评审报告.md`（本文档，唯一写面；未修改任何代码、未做任何 git 操作）。
