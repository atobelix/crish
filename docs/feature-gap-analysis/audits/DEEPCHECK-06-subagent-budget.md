# DEEPCHECK-06：子 Agent 引擎 × 预算体系交叉检查

> 子代理 E2 · 只读分析 · 2026-08-09
> 范围：并行阵营子 agent 引擎（`crates/agent-tools/src/tools/subagent.rs` / `subagent_inject.rs` / `apps/agent-workbench/src-tauri/src/subagent_spawner.rs` / `wait_channel.rs` / `wakeup_summary.rs`）与 P4 预算/压缩/历史回流体系（`crates/session-loop` T-33/T-34 + `apps/agent-workbench/src-tauri/src/core_run_commands.rs` T-29/T-30 + 前端 T-31）的八个交叉点。
> 参照：grok-build `SubagentCoordinator`（`reference/grok-build/.../mvp_agent/subagent_coordinator.rs`，仅参考实现，本仓库无对应产物）、REQ-D08（嵌套禁止）、REQ-D03（多模型模式）。
> 相关审计：DEEPCHECK-11-compaction-quality.md（压缩触发链生产断链，P0-1——本文第 1 项与其部分重叠，本文聚焦子代理特有缺口）。

## 0. 结论先行

**覆盖 3 / 缺失 5**（按八项计：全覆盖 0，部分覆盖 3，缺失 5）。

| # | 检查项 | 结论 | 严重度 |
|---|---|---|---|
| 1 | 子代理会话预算覆盖（钳制/预检/溢出） | **缺失**——子代理 run 裸跑，无钳制无压缩 | **P0** |
| 2 | 子代理历史回流 | **缺失**——单 prompt run，缓存写入后无消费方 | P1 |
| 3 | 子代理缓存适配（build_cache_policy） | **部分**——同一消费点共用，但会话键注入全局未接线（T-17） | P1 |
| 4 | 深度 1 嵌套（REQ-D08） | **覆盖**——工具层剔除 + 引擎守卫层双层实现，零 run 语义 | 无 |
| 5 | 会话窗口数字一致性（80/100/200） | **部分**——三数不一致，UI 窗 < 回流上限，存在双重口径分叉 | P1 |
| 6 | 子代理产出与主会话汇总 | **部分**——落盘与事件面齐全，但摘要/汇总内容恒为占位符 | **P0** |
| 7 | 多模型模式（REQ-D03） | **缺失**——model_override 全构造点恒 None，无引擎消费通道 | P2 |
| 8 | 子代理完成唤醒 | **覆盖**——steering 摘要 + wait 通道 + 事件三路齐全 | 无 |

**最严重一项（第 1 项）**：子代理会话完全不进预算体系（`context_window: None` → `context_budget: None`），且生产态主会话本身也只有 max_tokens 钳制（compaction_policy 恒 None，见 DEEPCHECK-11 P0-1）——长任务子代理既无钳制也无压缩阶梯，超窗即 fatal，与主会话在同一生产断链下还多裸跑一层。

---

## 1. 子代理会话的预算体系覆盖（T-33/T-34）

**结论：缺失（P0）。子代理 run 裸跑。**

**证据链**（从 spawn 到预算装配）：

1. 引擎 spawner 启动子代理 run 时 `RunTaskOptions` 构造于 `subagent_spawner.rs:354-368`：
   - `context_window: None`（第 365 行）——预算唯一入站口为空；
   - `history: None`（第 364 行）。
2. `run_task_impl` 的预算装配 `core_run_commands.rs:2970`：`let context_budget = context_window.map(assemble_context_budget);` → 子代理恒得 `None`。
3. `SessionLoopOptions` 装配 `core_run_commands.rs:3187-3227` 只设 `context_budget`，`compaction_policy` 走 `..SessionLoopOptions::default()`（`loop/mod.rs:302` 恒 None，全仓库 `apps/` 无构造点——DEEPCHECK-11 §0 断链①）。
4. 预算消费链三入口全部依赖 `state.budget`：
   - 钳制：`streaming.rs:314-320` `clamp_request_max_tokens` → `state.budget` None 时透传原值；
   - 预检：`handlers/mod.rs:292-298` `maybe_compact_preflight` 首个条件 `let Some(budget) = state.budget else { return false }`；
   - 溢出：`stream_error.rs:154-160` `compression_ladder` 条件 1（budget + policy 缺任一即 fatal）。

**对照**：
- **主会话**：前端 `resolveContextWindow`（`ConnectionLifecycle.ts:132-156`，模型 catalog 的 contextLength）→ `contextWindow` 入站 → `context_budget` Some → **至少钳制生效**（预检/溢出压缩同因 policy None 不触发，但这是全仓共享断链，DEEPCHECK-11 P0-1）。
- **子代理**：spawn 由引擎侧发起，前端参数不可能到达；spawner 无任何 budget 注入点（`SubagentRunConfig` 无预算字段，`SubagentSpawnRequest` 无预算字段）→ **钳制、预检、溢出压缩三级全裸**。长任务子代理超窗时无 length 阶梯兜底之外的任何恢复手段（`compression_ladder` 直接 fatal）。

**修复方向（O(1)）**：`SubagentSpawnerImpl::spawn_unchecked` 装配 `RunTaskOptions` 时按生效模型窗口注入 `context_window`（与主会话同源：engine provider 的模型 catalog），并顺带把 DEEPCHECK-11 P0-1 的 `compaction_policy` 装配一并落地（预算入站点即 policy 装配点）。

---

## 2. 子代理历史回流（HistoryMessage / SessionHistoryCache）

**结论：缺失（P1）。子代理 = 单 prompt run，无跨 run 历史。**

**证据链**：

1. `subagent_spawner.rs:364` `history: None` → `run_task_impl:3249-3250` `resolve_history_source(&history, state.session_history.get(&session_id))`：前端历史未传 → 回退缓存；但子代理 session_id = `sub-sess-{depth}-{n}`（`subagent_spawner.rs:289`），首次 spawn 时缓存必空 → `initial_conversation: None` → **单消息 run**。
2. run 内多 turn 由 `LoopState.conversation` 承载（跨 turn 自然延续），但 run 结束收口 `drive_run_loop:2390` `session_history.store(&session_id, ...)` 写入的缓存**没有下一次 run 消费**——子代理 run 只跑一次；除非用户手动打开 `sub-sess-N` 会话续聊（该会话已入前端会话列表，`upsert_session_entry`，`subagent_spawner.rs:307-321`）。
3. 与 grok-build 对照：grok 子代理会话有 session_lifecycle / 多 run 续跑；我们 C1 硬约束「同一 run 续跑不变 subagent_run_id」只保证了 id 稳定性，没有为续跑装配历史（若引擎侧未来支持续跑，`resolve_history_source(None, cache)` 自然回退缓存 200 条——机制在，无接线）。

**影响**：子代理每次 spawn 都是「系统注入段 + 单条 prompt」的冷启动上下文，无法借助此前子代理 run 的产出（复用同一子代理完成多步调研时不继承上一步结论，只能由主 agent 在 prompt 里重述）。

---

## 3. 子代理的缓存适配（build_cache_policy 断点/键注入）

**结论：部分覆盖（P1）。同一消费点共用，但会话键注入全局未接线（非子代理特有），子代理另有天然分域损耗。**

**证据链**：

1. 消费点唯一：`engine.rs:309-334` `HttpProviderCall::request_options` → `build_cache_policy(catalog, base_url, model, request.session_id, extra.cache)`（唯一运行时判定/消费入口，`cache.rs:269`）。
2. **会话键注入未接线（全仓共享缺口）**：loop 侧 `streaming.rs:301-308` `build_request` 填 `session_id: None`，注释明示「T-17 落地前该字段恒 None，缓存键不含会话维度」（P2 步骤 4b 待接）。→ `build_cache_policy` 收 None：OpenAI 系 prompt_cache_key 不注入、Grok 亲和头无会话维度。主会话与子代理同等缺。
3. **子代理特有影响**：即使 T-17 接线，子代理每次 spawn 都是新 session_id（`sub-sess-N`）→ 缓存域天然全新，且子代理 prompt 各不相同 → 断点/键注入对子代理基本无收益；唯一稳定前缀是 system 注入段与工具定义。子代理请求仍正常走 provider（无缓存坏影响，只是无缓存收益）。
4. 摘要请求缓存隔离（C14）由 Summarizer 实现方保证（`invariants.rs:263-272`）；生产 SummarizerFactory 无实现（DEEPCHECK-11 §0 断链②）——与预算同源的共享断链。

---

## 4. 深度 1 嵌套与预算（REQ-D08）

**结论：覆盖（无缺口）。双层实现 + 零 run 语义；深度超限根本不产生会话，预算/压缩不涉及。**

**实现分层**：

| 层 | 位置 | 机制 |
|---|---|---|
| 工具面防护 | `readonly.rs:84` + `run_task_impl:2895-2900` | 子代理 run 装配注册表时剔除 `run_subagent`（`filter_out_subagent_spawner`，`subagent.rs:653-659`）——防浪费非安全边界，非安全边界 |
| 引擎守卫层（安全边界） | `SubagentSpawnerImpl::check_guard`（`subagent_spawner.rs:267-274`）→ `check_recursion_guard`（agent-tools 纯函数） | `DEFAULT_RECURSION_GUARD`（`subagent.rs:497-501`）：maxDepth=1 / maxSiblings=5 / maxConcurrent=12；新会话深度 > 1 → `NestingDenied`（错误码 `subagent.nesting_denied`，文案「所有子 Agent 由主 Agent 分配」）；批量路径前瞻快照统一判定（`spawn_many`，`subagent_spawner.rs:786-825`） |
| 死锁检查 | `check_ancestor_chain` + `ancestor_sessions`（`subagent_spawner.rs:715-733`） | 祖先链循环 fork 拒绝 |

**深度超限时的预算/压缩表现**：拒绝发生在 spawn 判定点，**零 run**（`spawn_nesting_denied_from_subagent_run` 测试断言 session_agents 无新增行，`subagent_spawner.rs:1052-1087`）——不产生会话即不产生预算/压缩问题。守卫拒绝以工具错误形式返回主 agent run 的 tool 结果，主会话自身的预算/压缩不受影响。maxSiblings/maxConcurrent 超限同为零 run。

**与 REQ-D08 对照**：REQ-D08「嵌套禁止」由守卫层（安全边界）兜底 + 工具层（防浪费）双保险，语义完整；守卫配置引擎侧统一（flow 调度器可配位不传导，`subagent_spawner.rs:109-110`）。

---

## 5. 会话窗口数字一致性（80 vs 100 vs 200）

**三个数字（真源）**：

| 数字 | 位置 | 语义 |
|---|---|---|
| **80** | `apps/crish-desktop/src/api/messageWindow.ts:50` `DEFAULT_RECENT_MESSAGE_COUNT` | UI 渲染窗：默认只挂载最近 80 条（可点「更早」展开，`EXPAND_OLDER_STEP=40`） |
| **100** | `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:59` `HISTORY_CAP` | 前端 → 引擎回传上限：最近 100 条**已完成 user/assistant**（`buildHistoryMessages`，过滤 tool/system/未完成态，尾部截断） |
| **200** | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:91` `SESSION_HISTORY_MAX_MESSAGES` | 引擎侧 `SessionHistoryCache` 每会话上限：run 收口写全量（含 tool/system 配对，`ensure_safe_prefix` 保协议）截 200 |

**消费优先级**（`core_run_commands.rs:888-896` `resolve_history_source`）：前端 history 非空 → 用前端（≤100 条，过滤形态）；否则回退缓存（≤200 条，保真形态）。

**不一致影响分析**：

1. **渲染窗 < 回流上限（80 < 100 < 200）**：LLM 看到的历史是 UI 默认挂载窗的**超集**——用户默认看不到第 81~100 条（前端路径）或第 81~200 条（缓存路径，idle-resume 等无前端参与场景）。方向是「LLM 看到更多」而非「LLM 缺消息」，无信息丢失；但 LLM 引用 UI 未挂载的历史时用户无法即时审计（可展开，非死路）。属可接受的体验不对称。
2. **双重口径分叉（更实质的问题）**：同一会话两条 run 路径给 LLM 的历史**内容构成不同**：
   - 用户发起（前端路径）：100 条 user/assistant 完成态，无 tool 结果；
   - 引擎自动续 run（`spawn_idle_resume_run`，`core_run_commands.rs:2309-2343`，history: None → 缓存路径）：200 条保真含 tool 结果。
   - 影响：a) LLM 对同一会话在两种启动方式下看到的上下文不同（子代理完成唤醒、定时器唤醒等自动路径与手动发送内容漂移）；b) 前缀长度不同 → 缓存命中域不同（100 前缀 vs 200 前缀互不命中）。
3. **截断位置对齐问题**：200 截断只保「首条非孤儿」（`ensure_safe_prefix`）；100 截断配合尾部 user 截断（`hydrate.rs:289-295`）。缓存路径的水合 `cached_history_to_conversation` 保真（工具结果配对不拆散）；前端路径 `hydrate_history` 过滤 + 尾部截断——两条水合规则不同（`core_run_commands.rs:3251-3256`）。
4. **子代理叠加**：子代理会话首次 run 无历史（第 2 项）；若用户从 UI 续聊 sub-sess-N，走前端 100 条路径；引擎侧若续跑走缓存 200 条路径——同一不一致再放大。

**建议（低优先）**：统一三数关系——渲染窗 ≥ 回流上限（80 → 100 或 120），或至少让 idle-resume 路径也携带前端历史（`spawn_idle_resume_run` 目前恒 `history: None`，是双重口径的根因）。

---

## 6. 子代理产出与主会话汇总（有无丢失路径）

**结论：部分覆盖（P0 级内容空洞）。落盘与事件面齐全，但「摘要/汇总」内容恒为占位符。**

**落盘现状**：

| 面 | 位置 | 内容 |
|---|---|---|
| 子代理独立会话 | `sub-sess-{depth}-{n}`（`subagent_spawner.rs:289`），会话索引条目已建（307-321） | run 消息经正常事件流 → 前端 sessionRustDb 持久化（该会话可被用户打开查看） |
| session_agents 行 | `on_subagent_terminal`（`subagent_spawner.rs:528-569`） | status/ended_at 更新；**summary = 占位符**「子代理已完成」/「子代理已结束（失败）」（545-547） |
| subagent-ended 事件 | `SubagentEndedInfo::from_subagent_state`（`subagent_events.rs:101-118`） | **summary 恒 None**（101-118），事件面不带产出 |
| 产出文件清单 | `wait_subagents` 工具：`collect_subagent_output_files` 从 write_claims 持有者记录收集（`wait_subagents.rs:746-760`），T-EG-10 | path/summary/bytes，经 `dispatch_outputs` 落 session_meta |

**主会话汇总链路**：`on_subagent_terminal` → ① wait 通道 feed（`wait_subagents` 实时返回 status+summary=None+outputFiles）；② steering 通知（`wakeup_summary.rs:63-78`「子代理 <role>（<id>）已完成：成功」模板，`subagent_spawner.rs:626-651`）→ 主 run 收口 `decide_idle_resume`（`core_run_commands.rs:2177`）→ `spawn_idle_resume_run` 注入；③ subagent-ended 事件落库 + 前端 `subagentHandlers.ts` 面板更新（`useStreamCallbacks.ts:405-484`）。

**丢失路径（三处）**：

1. **主 agent 拿不到子代理最终文本（核心空洞）**：ended 事件 summary 恒 None、DB 行 summary 恒占位符、steering 唤醒摘要只含模板句——子代理的最终结论文本只存在于 `sub-sess-N` 的消息里，而**主 agent 没有任何工具可读取子代理会话**（工具注册表仅 run_subagent + wait_subagents，无查询类工具，`tools/mod.rs:128-183`）。wait_subagents 的 outputFiles 只覆盖「写文件类产出」，纯文本结论（调研结论、分析报告内联文本）主 agent 拿不到。对照 grok-build `SubagentCoordinator::handle_query`（completed/active/pending 三态查询 + BlockingWaiter）——我们有 wait 但无 query/read-results。
2. **进度事件无生产发射方**：`SubagentEventEmitter::emit_event`（subagent-event 进度）在引擎侧**无任何调用点**（spawner 只发 started/ended，`subagent_spawner.rs:429/590`）→ 前端面板（`onSubagentEvent`，`useStreamCallbacks.ts:434-449`）只能显示 started/ended，子代理工作过程对 UI 不可见。
3. **产出目录不继承**：`SubagentRunConfig.output_dir` 恒 None（`subagent_spawner.rs:346`）——T-EG-09 产出目录注入段（`core_run_commands.rs:3175-3182`）生产永不触发；子代理自行 `resolve_output_dir` 默认 `.agent-outputs/<date>-<sub-sess-N>/`（自身会话域，与主 agent 产出目录分叉）；主控若未在 prompt 显式给 folder，汇总时各子代理产出散落各目录。

**修复方向**：① 子代理收口时把最终 assistant 文本写入 ended 事件 summary / 行 summary（或新增查询工具，最小方案是「收口摘要 = 最终消息文本前 N 字符」）；② 引擎侧为子代理 run 接 subagent-event 进度发射；③ spawner 从主控上下文继承产出目录。

---

## 7. 多模型模式（REQ-D03）

**结论：缺失（P2）。「默认当前模型」成立，「模型选择」不存在。**

**证据链**：

1. 字段存在但恒 None：`SubagentDefinition.model_override`（`subagent.rs:331`）、`SubagentSpawnRequest.model_override`（`subagent.rs:705`）——「扩展点预留（T-D-10『多模型不做』）：全构造点显式 None（编译器强制），引擎侧恒不消费（新增消费即编译断裂），不落库（session_agents 无对应列）」（703-705）。
2. 工具入参解析显式不读 modelOverride：`subagent.rs:1259-1261`「扩展点预留：工具路径恒不解析 modelOverride 入参」；批量路径同（1026-1027）。测试断言全构造点 None（1701-1702、1779、1939）。
3. `SubagentRunConfig`（`subagent_spawner.rs:71-86`）无任何模型字段；测试 `spawn_model_inheritance_and_override_never_consumed`（`subagent_spawner.rs:1033-1047`）断言 spawn 请求即使携带 model_override，launch 装配 Debug 面也不含 model——引擎无 model override 通道。
4. **「默认当前模型」成立**：子代理 run 走 `run_task_impl` 同通道，provider 取自 `state.engine.provider()`（`core_run_commands.rs:2877`）——engine provider 全局单例（`HttpProviderCall` config.model）→ 子代理与主 agent 同模型同配置。REQ-D03 的多模型选择/切换（按任务类型选模型）未落地，只有继承。

**影响**：子代理无法指定轻量模型跑调研/重量模型跑实现；与主会话共享同一生效模型。属功能缺口非缺陷（继承语义自洽）。

---

## 8. 子代理完成唤醒（SubagentCompleted 合成消息对照）

**结论：覆盖（无缺口）。事件 + wait 通道 + steering 摘要三路齐全；与 grok 差异在「唤醒消息不携带子代理产出内容」。**

**唤醒链**（`subagent_spawner.rs:489-660` `on_subagent_terminal`）：

1. **记账释放**：兄弟/并发/深度/run 注册表（506-526）；
2. **行终态更新**：status/ended_at/summary 占位符落库（528-569）；
3. **subagent-ended 事件**：非 flow 路径由 spawner 发射（M14 唯一发射方，571-612；flow 路径由 FlowScheduler 收口，`flow_graph.rs:1210`），Critical 必达落库；
4. **wait 通道 feed**：`terminal_stream.feed(&event)`（614-622）→ `wait_subagents` 订阅者实时返回（`wait_for_terminal_events`，`wait_subagents.rs:387-459`）；
5. **steering 通知**：`wakeup_summary` 模板摘要入 `PendingMessageQueue`（626-651）→ 主 run 收口 `decide_idle_resume`（`core_run_commands.rs:2177`）→ `spawn_idle_resume_run` 注入主会话（摘要 + prompt 并存送达，T-CF-11 批量注入语义）。

**与 grok-build SubagentCompleted 合成消息对照**：grok 在主会话合成一条携带子代理完成产物的消息追加进对话；我们以「steering 摘要（模板句）」+「wait 结果（status+outputFiles）」替代——**唤醒机制完整（REQ-C04 验收 3：AI 无需手动查询即知发生了什么），但唤醒内容不含子代理最终文本**（与第 6 项缺失同根：摘要字段空洞）。若第 6 项修复（收口摘要=最终消息文本），本项即闭环。

---

## 附录：证据索引

| 证据 | 位置 |
|---|---|
| 子代理 spawn 装配（context_window/history 恒 None） | apps/agent-workbench/src-tauri/src/subagent_spawner.rs:354-368 |
| 预算入站（context_window → ContextBudget） | apps/agent-workbench/src-tauri/src/core_run_commands.rs:2966-2979 |
| 钳制/预检/溢出三入口的 budget 判空 | crates/session-loop/src/loop/handlers/streaming.rs:314-320；handlers/mod.rs:292-298；handlers/stream_error.rs:154-160 |
| compaction_policy 生产恒 None | apps/agent-workbench/src-tauri/src/core_run_commands.rs:3187-3227 + crates/session-loop/src/loop/mod.rs:301-302（共享断链详见 DEEPCHECK-11 §0） |
| 历史源解析（前端优先/缓存回退） | apps/agent-workbench/src-tauri/src/core_run_commands.rs:888-896, 3241-3263 |
| SessionHistoryCache 上限 200 | apps/agent-workbench/src-tauri/src/core_run_commands.rs:91, 570-624 |
| 前端回传上限 100 | apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:59, 88-123 |
| UI 渲染窗 80 | apps/crish-desktop/src/api/messageWindow.ts:50 |
| 缓存键注入待接（session_id 恒 None） | crates/session-loop/src/loop/handlers/streaming.rs:294-296, 307 |
| build_cache_policy 唯一消费点 | apps/agent-workbench/src-tauri/src/engine.rs:309-334；crates/agent-provider/src/request/cache.rs:269-275 |
| 递归守卫默认（maxDepth=1）与拒绝码 | crates/agent-tools/src/tools/subagent.rs:497-501, 516-560 |
| 工具面剔除 run_subagent | crates/agent-tools/src/readonly.rs:84；subagent.rs:653-659；core_run_commands.rs:2895-2900 |
| 守卫判定 + 嵌套拒绝测试 | apps/agent-workbench/src-tauri/src/subagent_spawner.rs:267-274, 1052-1087 |
| model_override 恒 None（T-D-10） | crates/agent-tools/src/tools/subagent.rs:702-705, 1259-1261；subagent_spawner.rs:1033-1047 |
| 终态三路唤醒 | apps/agent-workbench/src-tauri/src/subagent_spawner.rs:489-660；wakeup_summary.rs:63-78；core_run_commands.rs:2177-2343 |
| wait_subagents 结果（summary None + outputFiles） | crates/agent-tools/src/tools/wait_subagents.rs:380-459, 746-786 |
| ended 事件 summary 恒 None | crates/orchestrator/src/subagent_events.rs:101-118 |
| 行 summary 占位符 | apps/agent-workbench/src-tauri/src/subagent_spawner.rs:544-547 |
| subagent-event 进度无生产发射方 | apps/agent-workbench/src-tauri/src/subagent_spawner.rs（仅 emit_started/emit_ended 两处） |
| 产出目录恒 None（T-EG-09 不触发） | apps/agent-workbench/src-tauri/src/subagent_spawner.rs:346；core_run_commands.rs:3175-3182 |
