# DEEPCHECK-07 事件面与插件系统交叉检查（E3 子代理）

- 日期：2026-08-09
- 角色：E3 事件面与插件系统检查（只读分析）
- 范围：AgentEvent 事件面（41 变体）与插件系统（I8 E1 hook surface 14 事件 / I8 E2 plugin-sdk 运行时）交叉检查
- 方法：源码阅读 + 生成器 drift 实跑（node scripts/generate-engine-bindings.mjs）+ 测试护栏核对

## 0. 结论先行

| 检查项 | 结论 |
| --- | --- |
| 事件面总数 | **41 变体**（用户前提"27"已过时：24 + 3 cache = 27 之后并行阵营又新增 14 个） |
| 3 cache 事件 vs hook 事件 | **无重复无重叠**（cache-* 属"无对应钩子"清单，事件总线消费） |
| hook tool 事件 vs ToolUpdate | **无重叠**（tool.pre/post/error 的源是 tool-start/tool-end；tool-update 无钩子映射） |
| schema 一致性 | 一致：41 == 注册表 41 == V1_EVENT_TYPES 41；生成器实跑**零漂移** |
| 前端消费面 | 41 键全覆盖（穷举测试锁定）；显式空实现 10/41（24.4%） |
| 插件运行时 | **SDK 库面完成但宿主接线为零**（pluginRuntime.ts 不存在、HookRegistry 无生产构造点）——最严重一项 |
| 遥测 vs 缓存事件 | 单发射路径无双写；逐 miss 归因 in-loop 发射未接线（attribution 恒 Unknown，诚实兜底） |
| 事件负载 | cache 三事件定长标量无风险；事件桥按条数水位（64/256）+ 节流 + 输出截断三层保护 |
| 版本兼容（c15c0d64） | fail-open 于 schemaVersion、fail-closed 于事件类型（F8-45 契约） |

## 1. 事件面总数与清单（AgentEvent 41 变体）

`crates/conex-types/src/events.rs` 的 `AgentEvent` 当前 **41 变体**（`ALL_TYPE_NAMES` 41 项，events.rs:806-848）。演进史（注释 events.rs:295-296、测试 events_schema_version.rs:11-15）：24 基线 → +3 cache（2026-08-03）→ 27 → +1 security-audit → 28 → +3 subagent → 31 → +7 task（2026-08-04）→ 38 → +2 timer（2026-08-05）→ 40 → +1 cron-fired → **41**。

| # | 域 | 事件（wire 名） | 来源 | 前端消费（dispatch.ts） | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | Agent | agent-start | session-loop run 入口 | onAgentStart（显式空实现） | 已注册 |
| 2 | Agent | agent-end | run 收口 | onAgentEnd（真实） | 已消费 |
| 3 | Turn | turn-start | prepare_turn | onTurnStart（显式空实现） | 已注册 |
| 4 | Turn | turn-end | turn_complete | onTurnEnd（显式空实现） | 已注册 |
| 5 | Message | message-start | 消息水合 | onMessageStart（空实现，message-end 兜底） | 已注册 |
| 6 | Message | message-delta | 流式增量 | onMessageDelta（真实） | 已消费 |
| 7 | Message | message-end | 消息终态 | onMessageEnd（真实） | 已消费 |
| 8 | Tool | tool-start | tool_exec | onToolStart（真实） | 已消费 |
| 9 | Tool | tool-update | ToolProgress 进度缓冲 | onToolUpdate（真实） | 已消费 |
| 10 | Tool | tool-end | tool_exec | onToolEnd（真实） | 已消费 |
| 11 | Tool | tool-batch-start | 批量启动 | onToolBatchStart（真实） | 已消费 |
| 12 | Tool | tool-batch-end | 批量收口 | onToolBatchEnd（真实） | 已消费 |
| 13 | Tool | tool-input-repaired | validation/repair | onToolInputRepaired（真实） | 已消费 |
| 14 | Compression | context-compression-start | 压缩开始 | onContextCompressionStart（显式空实现） | 已注册 |
| 15 | Compression | context-compression-end | 压缩结束 | onContextCompressionEnd（显式空实现） | 已注册 |
| 16 | Diagnostic | provider-diagnostic | provider 诊断 | onProviderDiagnostic（仅日志） | 日志型 |
| 17 | Diagnostic | runtime-error | 运行期错误 | onRuntimeError（真实/日志） | 日志型 |
| 18 | Diagnostic | runtime-steering | steering 注入 | onRuntimeSteering（显式空实现） | 已注册 |
| 19 | Diagnostic | runtime-intervention-required | 需人工介入 | onRuntimeInterventionRequired（显式空实现） | 已注册 |
| 20 | Approval | approval-requested | B4/B6 审批层 | onApprovalRequested（真实） | 已消费 |
| 21 | Approval | approval-resolved | 审批裁决 | onApprovalResolved（真实） | 已消费 |
| 22 | Checkpoint | checkpoint-created | 检查点创建 | onCheckpointCreated（显式空实现） | 已注册 |
| 23 | Checkpoint | checkpoint-restored | 检查点恢复 | onCheckpointRestored（显式空实现） | 已注册 |
| 24 | Agent | run-terminal | run 终态 | onRunTerminal（真实） | 已消费 |
| 25 | **Cache** | **cache-stats-updated** | engine.rs run 收口（T-40） | onCacheStatsUpdated → cacheEventsStore（真实，T-48） | 已消费 |
| 26 | **Cache** | **cache-waste-alert** | engine.rs 收口聚合（阈值门控） | onCacheWasteAlert → cacheEventsStore（真实） | 已消费 |
| 27 | **Cache** | **cold-cache-warning** | engine.rs run 启动前一次 | onColdCacheWarning → cacheEventsStore（真实） | 已消费 |
| 28 | Security | security-audit | I2-S8 审计面 | onSecurityAudit → securityAuditStore（真实） | 已消费 |
| 29 | Subagent | subagent-started | run_subagent spawn | onSubagentStarted（真实） | 已消费 |
| 30 | Subagent | subagent-event | 子代理过程（kind 分级） | onSubagentEvent（真实） | 已消费 |
| 31 | Subagent | subagent-ended | 子代理收口 | onSubagentEnded（真实） | 已消费 |
| 32 | Task | task-started | 后台任务 adopt | onTaskStarted（刷新信号，T-AB-17） | 已消费 |
| 33 | Task | task-output | 输出增量（100ms 节流聚合） | onTaskOutput（计数/日志水位） | 已消费 |
| 34 | Task | task-heartbeat | 资源心跳 | onTaskHeartbeat（计数/日志水位） | 已消费 |
| 35 | Task | task-suspicious | 疑似卡死 | onTaskSuspicious（刷新信号+置标） | 已消费 |
| 36 | Task | task-completed | 退出码 0 | onTaskCompleted（刷新信号） | 已消费 |
| 37 | Task | task-failed | 退出码非 0 | onTaskFailed（刷新信号） | 已消费 |
| 38 | Task | task-killed | 已终止 | onTaskKilled（刷新信号） | 已消费 |
| 39 | Timer | timer-fired | TimerRegistry 到期 | onTimerFired（摘要+刷新信号） | 已消费 |
| 40 | Timer | timer-cancelled | 定时器取消 | onTimerCancelled（摘要+刷新信号） | 已消费 |
| 41 | Cron | cron-fired | SchedulerRegistry 触发 | onCronFired（摘要+刷新信号） | 已消费 |

**重复/重叠检查结论**：

- 3 cache 事件（#25-27）与并行阵营 hook 事件**无重复**：`event_hook_mapping.rs` 冻结划分 41 = 11 映射 + 30 无对应，cache-* 三事件全部在 UNMAPPED_EVENTS（event_hook_mapping.rs:71-73），事件总线消费、不进插件面。
- hook 的 tool 事件（tool.pre / tool.post / tool.error）与我们的 ToolUpdate **无重叠**：钩子源是 tool-start → tool.pre、tool-end → tool.post + tool.error（event_hook_mapping.rs:36-39）；tool-update 无钩子映射（属 30 无对应清单，event_hook_mapping.rs:60）。
- 命名空间天然隔离：引擎事件 kebab-case、钩子事件点分命名（禁令 14），无重名冲突。

## 2. 事件 schema 一致性（生成器 drift 实跑）

- **V1_EVENT_TYPES 41 == 枚举 41**：events_schema_version.rs:35-83 清单与 `AgentEvent::ALL_TYPE_NAMES` 逐项一致（测试 `v1_event_types_cover_all_agent_event_variants` 锁定，events_schema_version.rs:117-125）。
- **注册表 41 == 枚举 41**：`crates/conex-types/contracts/engine-events.json` 41 事件（id 1-41 连续、schema_version 1、backpressure 字段），registry_drift.rs 双向锁定（`registry_event_types_match_enum_declaration_order` 断言 event_count 41）。
- **生成器实跑（2026-08-09）**：`node scripts/generate-engine-bindings.mjs` 输出 `events: 41, types: 19, enums: 21`，写 4 个生成文件后 `git status` 无变更 → **无漂移**。生成产物 `ENGINE_EVENT_TYPES` 41 项（events.ts:359）。
- 新增事件登记路径完整：`engine_event_type_names!` 宏（编译期补 arm）+ 注册表 JSON + V1_EVENT_TYPES + fixtures 四重锁定，无漏登记风险。

## 3. 事件消费面完整（dispatch.ts 分派表）

`apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.ts`：

- `engineDispatchTable` **41 键全覆盖**，穷举测试 `dispatch.test.ts:40-44` 断言：遍历 ENGINE_EVENT_TYPES 逐键存在 handler + `Object.keys(engineDispatchTable).length == ENGINE_EVENT_TYPES.length`（多键/缺键立即失败）。
- legacyDispatchTable 承接 subagent-* / error 信封级事件（宽容形态兜底，与 engine 分支行为一致，dispatch.ts:113-119）。
- **空实现比例 10/41（24.4%）**：agent-start、turn-start、turn-end、message-start、context-compression-start/end、checkpoint-created/restored、runtime-steering、runtime-intervention-required——均为"暂无 UI 语义/以终态兜底"的**显式空实现**（注释声明，非漏注册）。另有 provider-diagnostic、runtime-error 为日志型（各 1 行 logInternalError）。
- 真实消费 29/41：message/tool/approval/run-terminal/cache×3/security-audit/subagent×3/task×7/timer×2/cron/agent-end。
- 注：dispatch.ts:120-133 注释称任务/定时器/cron 为"显式空实现"已过时——taskEventHandlers.ts 实为真实消费（刷新信号 + timer/cron 展示面摘要），注释与实现不一致（小瑕疵，不影响行为）。

## 4. 插件系统状态（I8 E2 验证）

**库面（packages/plugin-sdk）完整**：manifest（trust-gate/validate/engine-constraint/permissions）、registry（discoverer/loader/registry/store/state/validator）、hooks（api/lifecycle/types）、tools（plugin-api/mcp-declaration）、skills、fs，共 11 个测试文件（含 e2-runtime-wiring.test.ts 验收：manifest 双轨收敛、loader fs 注入面、TrustGate 路径逃逸、失败事件化）。

**但宿主接线为零，插件当前无法真实加载/执行**：

1. `apps/crish-desktop/src/api/pluginRuntime.ts` **不存在**（已实测 Test-Path=False）；pluginRegistryAdapter.ts:89-92 明确标注 `PLUGIN_RUNTIME_HOOK（E2 接线点）：插件运行时落地后改为 import('../../api/pluginRuntime')`——当前 v1 数据源只是内置官方插件（@crish/plugin-import-claude-codex）的 manifest + localStorage 启停，**没有真实注册表、没有加载、没有执行**。
2. Tauri 壳（apps/agent-workbench/src-tauri）**无任何插件命令**（rg "plugin" 仅命中 dev_mcp/engine/main/dialog 的无关提及）。
3. plugin-sdk 的唯一消费者是 plugin-import-claude-codex 自身（一个插件），apps/ 与 crates/ 均不引用 plugin-sdk。
4. 即便接线，加载还受安全门 `CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT` 门控（默认拒绝 import，仅注册 manifest，plugin-loader.ts:65-73）。

**插件 API 与事件面的关系**：插件经 `api.observe/on` 订阅的是 **14 个 hook 事件名**（点分命名），不是 41 个引擎事件。HookBus 实现（HookBusLike 契约，hooks.ts:308-330）在 TS 侧无实现——插件"能订阅哪些事件"目前只有类型层答案（HookPayloadMap 14 项），运行面无 HookBus。

## 5. hook surface 14 事件（I8 E1 验证）

清单（packages/shared-types/src/hooks.ts:40-55 冻结，顺序与 Rust 侧 ALL_HOOK_EVENT_KINDS 一致）：

| # | 钩子事件 | 引擎事件源 | 发射点（session-loop） | 状态 |
| --- | --- | --- | --- | --- |
| 1 | turn.start | turn-start | loop/mod.rs（prepare_turn 域） | 待接线 |
| 2 | turn.end | turn-end | loop/handlers/turn_complete.rs:92（步骤 4.5） | 待接线 |
| 3 | tool.pre | tool-start | tool_exec.rs:923（与 ToolMiddleware 同点位） | 待接线 |
| 4 | tool.post | tool-end | tool_exec.rs execute_single | 待接线 |
| 5 | tool.error | tool-end（isError 分支） | tool_exec.rs | 待接线 |
| 6 | context.compact.start | context-compression-start | loop/handlers/mod.rs apply_compaction | 待接线 |
| 7 | context.compact.end | context-compression-end | loop/handlers/mod.rs | 待接线 |
| 8 | session.start | agent-start | loop/mod.rs:706 | 待接线 |
| 9 | session.end | run-terminal | loop/mod.rs:890 | 待接线 |
| 10 | model.beforeRequest | **无引擎事件源**（M14 补源） | — | 补源待做 |
| 11 | model.afterResponse | **无引擎事件源**（M14 补源） | — | 补源待做 |
| 12 | subagent.start | subagent-started | M7 发射面 | 待接线 |
| 13 | subagent.end | subagent-ended | M7 发射面 | 待接线 |
| 14 | error.occurred | runtime-error | loop/mod.rs:661/820（含插件错误事件化） | 待接线 |

**关键发现（最严重项）**：Rust 侧 `HookRegistry`（session-loop/src/hooks.rs，1242 行：14 HookEventKind、双模式 observe/on、matcher 正则过滤、timeout 竞速、failStrategy、错误事件化，测试完备）**生产接线为零**：

- `LoopOptions.hooks` 默认 `None`（loop/mod.rs:297），`with_hooks` 全仓**无生产调用点**（engine.rs / orchestrator 均不构造 HookRegistry；rg 结果只有测试与类型声明）。
- 全部 14 个钩子的 dispatch 调用点都在 `if let Some(hooks)` 保护下——当前运行的应用中 **hook 事件实际不广播**。

**hook 面与 41 事件的关系**：hook 面是引擎事件的**消费者/投影面**（钩子源 = 引擎事件，I7-M13 映射表冻结于 event_hook_mapping.rs；41 = 11 映射 + 30 无对应）。独立于事件总线：hook 不经 buffer/落库/WS，走进程内 Handler 调用；缓存（cache-*）、任务（task-*）、定时器（timer-*）、cron 事件**不进 hook 面**（02-CF §4.7「hooks 不扩展」）。

## 6. 遥测事件 vs 缓存事件（双写/漏写检查）

- **conex-telemetry 不是事件订阅者**：它是叶子 crate（只依赖 std），提供纯函数（cache/miss.rs 归因分类、cold.rs 冷缓存判定、math.rs 恒等式）与阈值常量 `WARN_MISSED_TOKENS`（20_000）、`WARN_MISSED_COST_USD`（0.1）；不监听事件总线，无 subscribe/emit 代码。
- **唯一发射路径**：`apps/agent-workbench/src-tauri/src/engine.rs` produce()：
  - cold-cache-warning：run 启动前 `emit_cold_cache_warning_if_cold()` 实时轨 DeltaSink 发一次（engine.rs:2020、2122-2129）；
  - cache-stats-updated：run 收口入收口轨一次（engine.rs:2091-2097，outcome.events → 既有事件桥，信封注入 runId/sequence）；
  - cache-waste-alert：run 收口按阈值（missed_tokens ≥ 20_000）经 DeltaSink 发一次（engine.rs:2101-2107、waste_alert_event engine.rs:1545-1562）。
- **无双写**：三事件各自单点发射；RunOutcome.cache_stats 双消费（落库 runs 表 v5 列 + 事件）但事件只发一次。
- **漏写风险（待并轮缺口，非 bug）**：逐 miss 归因的 in-loop 发射未接线——streaming.rs:163 注释"CacheMiss 由 T-40 按告警阈值转 cache-waste-alert 事件"但该处未实现；engine.rs:1543-1544 明示"该文件不在本任务文件域，合并后本函数降级为兜底路径"。当前 cache-waste-alert 恒 `attribution=Unknown / idle_ms=0 / missedCostUsd=None`（诚实兜底：浪费量实测、归因宁缺勿误报）。缓存命中/统计本身不漏（cache-stats-updated 每 run 必发，无阈值）。

## 7. 事件负载大小（防事件流膨胀）

- **cache 三事件**：payload 全部定长标量（RunCacheStats 15 个 u64/f64/Option 字段；CacheWasteAlert 6 字段；ColdCacheWarning 4 字段），序列化后仅数百字节，无膨胀风险。发射频率也受控：stats 每 run 1 次、alert 每 run ≤1 次（阈值门控）、warning 每 run ≤1 次。
- **事件桥水位**：EventBuffer 入队时即序列化为字符串（buffer.rs:3-5），默认水位 Soft 64 / Critical 256 条/run（buffer.rs:200-206）；message-delta 是唯一 DropClass::Soft（可丢，message-end 全文兜底），Critical 事件永不丢（防御性可超限，buffer.rs:16-17）。
- **大负载路径**：
  - tool-update：ToolProgressUpdate{text/json/metadata} 小结构；工具大输出走 output_budget_bytes 预算截断（T06.4.2，executor 测试锁定）；
  - task-output：发射端 100ms 节流聚合（background.rs:1822）+ 前端 1s 刷新节流（DATA_PLANE_REFRESH_THROTTLE_MS=1000，taskEventHandlers.ts:28）；
  - message-delta：唯一可丢类，前端 streamTextBatcher 批量渲染。
- 结论：**无单事件字节上限**，但有条数水位 + 发射节流 + 输出预算截断三层保护，事件流不会拖垮前端。

## 8. 事件版本兼容（schemaVersion 语义，c15c0d64）

- **c15c0d64（2026-08-08）**：parser.adversarial.test.ts 新增 F8-45 信封 schemaVersion 消费契约：
  - **fail-open 于 schema 版本**：旧前端遇 schemaVersion=2 仍逐事件解析；schemaVersion 属信封字段，不进事件体校验（解析结果不含 schemaVersion/sequence）；
  - **fail-closed 于事件类型**：未知事件 type 即使带新 schemaVersion 也解析失败（走 error/legacy 降级）；
  - 无 schemaVersion 的旧帧照常解析（emit 层缺省注入前兼容）。
- Rust 侧对应：信封反序列化缺省补 1（events.rs:976-980）；`future_schema_version_passes_through` 测试锁定未来 major 帧版本号透传不丢弃（是否支持由消费端按 33-event-schema-changelog.md 决策）。
- **旧前端容忍路径**：所有 17 个新增事件（27→41）均为 minor 兼容新增（旧解析器对未知 type 静默忽略/失败降级、schemaVersion 恒 1、新字段全 Option + serde 缺省），旧前端无崩溃路径。

## 9. 风险清单（按严重度）

| 严重度 | 问题 | 证据 |
| --- | --- | --- |
| **高** | hook surface 与插件运行时生产接线为零：HookRegistry 无生产构造点、pluginRuntime.ts 不存在、Tauri 壳无插件命令——I8 E1/E2 产出目前只有库面与测试，实际应用加载不了插件、广播不了 hook 事件（设置页插件开关只是 localStorage 摆设） | loop/mod.rs:297（hooks: None）、with_hooks 无生产调用点、pluginRegistryAdapter.ts:89-92、plugin-loader.ts:65-73 |
| 中 | cache-waste-alert 逐 miss 归因 in-loop 发射未接线，归因恒 Unknown（诚实兜底但信息量减半）；waste_alert_event 的 cost 阈值（$0.1）因无 P3 价格数据恒不触发 | streaming.rs:163、engine.rs:1543-1544、1545-1562 |
| 中 | hook 面 2 个钩子（model.beforeRequest/afterResponse）无引擎事件源（M14 补源未做），14 钩子实际可发射 12 | event_hook_mapping.rs:116（SOURCE_PENDING_HOOKS） |
| 低 | dispatch.ts:120-133 注释称任务/定时器/cron handler"显式空实现"已过时（taskEventHandlers.ts 已真实消费），注释与实现不一致 | dispatch.ts:120 vs taskEventHandlers.ts |
| 低 | 插件加载安全门默认拒绝执行（CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT），即使接线完成，restricted/full 插件仍默认不执行——需 UI 授权流配套（已在 plugin-loader.ts:33-35 声明） | plugin-loader.ts:65-73 |

## 10. 建议

1. **插件运行时接线排期**：落地 `apps/crish-desktop/src/api/pluginRuntime.ts`（消费 plugin-sdk PluginRegistry/PluginLoader + HookBus 实现），并让 engine.rs 构造 HookRegistry 注入 LoopOptions.hooks（Rust 侧已有完整 dispatch 机制与测试，接线成本低）；
2. 逐 miss 归因发射并入轮（engine.rs:1543 声明的合并承诺），让 cache-waste-alert 携带真实 attribution；
3. model.beforeRequest/afterResponse 补事件源（M14）或明确延期登记；
4. 修正 dispatch.ts 过时注释（1 行级）。

## 附：验证记录

- `node scripts/generate-engine-bindings.mjs`：events: 41, types: 19, enums: 21，git status 无变更（零漂移）。
- 关键测试护栏：registry_drift.rs（注册表↔枚举）、events_schema_version.rs（V1_EVENT_TYPES 41 ↔ 枚举 ↔ fixtures ↔ changelog）、event_hook_mapping.rs（41 = 11 映射 + 30 无对应 ↔ hooks.ts 14 名）、dispatch.test.ts（41 键穷举）、hooks.test.ts（TS 侧 14 名类型层双向锁定）。
