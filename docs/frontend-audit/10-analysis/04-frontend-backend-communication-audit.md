# 前端后端通信层（IPC / 事件 / 契约）审计报告

> 审计范围：命令 invoke 面、事件通道面（workbench-run-event）、共享类型契约、错误传播、序列化性能、命令权限与敏感数据。
> 审计方式：只读，全部结论附 `文件:行号` 证据。
> 审计日期：2026-08-09。

## 0. 结论摘要

- **总体架构健康**：命令面有「编译期注册宏 → manifest 真源 → 前端镜像 → 启动拉取对照」四重一致性机制；事件面有「Rust enum → JSON 注册表 → registry_drift 测试 → 生成 TS → CI 生成物 diff」五重锁定链；错误面有 77 码双向漂移测试。契约基建在同类项目中属于上乘。
- **但存在 3 条断链命令**（前端调用名 ≠ Rust wire 名，其中 2 条使 Rust markdown 加速自始未生效、1 条使 telemetry 落盘永久失败）与 **11 条纯幽灵命令 + 4 条分裂标签**（registered=true 但前端无消费 / 消费名与 manifest 名不一致）。
- 无 P0 级问题；P1 级 3 组、P2 级 5 组、P3 级 7 组，详见第 7 节。

## 1. 契约体系现状

### 1.1 命令面契约链（四重一致性，双端同源）

| 环节 | 位置 | 说明 |
|---|---|---|
| ①编译期注册宏 | `apps/agent-workbench/src-tauri/src/main.rs:79-88`（`command_registry!`）| 二元组（wire 名，实现路径）同源生成 `COMMAND_REGISTRY_NAMES` 与 `generate_handler!` 分发 |
| ②manifest 真源 | `apps/agent-workbench/src-tauri/src/command_manifest.rs:68-186` | `COMMAND_MANIFEST` 92 条 = 注册面 88 + 登记先行 4；`manifest_*` 测试锁定条数/幽灵排除/命名唯一 |
| ③前端内置快照 | `apps/crish-desktop/src/api/transport/commandManifest.ts:54-173` | 镜像 Rust manifest；启动经 `invokeTyped('core_list_commands')` 拉真源缓存，失败回退快照（commandManifest.ts:211-229） |
| ④运行时对照 | `apps/crish-desktop/src/api/transport/commandMap.ts:58-67` | `checkCommandMapConsistency`：清单内命令不在注册面 → `logger.warn`（不崩） |

调用门禁：`TauriTransport.call/request` 一律经 `resolveTauriCommand`（commandMap.ts:49-51）→ `isRegisteredCommand`（commandManifest.ts:203-205），非 registered 直接显式 missing（tauriTransport.ts:158-167、186-189）。

**发现的问题**：

- **契约面真源存在三处不一致的"第 4 份清单"**：`COMMAND_REGISTRY_NAMES`（注册面）、`COMMAND_MANIFEST`（manifest 面）、前端 `BUILTIN_COMMAND_MANIFEST`（镜像面）之外，**Rust 实际生效的 invoke 键是 Tauri 宏按「函数名或 rename」展开的键**（main.rs:112-118 注释自证）。workflow 6 条与 markdown 5 条靠 `#[tauri::command(rename=...)]` 对齐（main.rs:173-179、markdown_commands.rs:22/35/51/67/81），而 fs 4 条无 rename（fs_commands/mod.rs:18-57）——「函数名 = invoke 键」这条隐规则没有编译期强制，正是第 2 节分裂与断链的根源。
- **注释条数过时**：command_manifest.rs:7 写「88 = 注册面 84 + 登记先行 4，F11b 后待镜像同步为 89 = 85 + 4」，与同文件 :212-214 实际断言「92 = 88 + 4」矛盾（前端 commandManifest.ts:48-49 也是 92 = 88 + 4）。注释未随 F11b/trash/workflow 轮次更新。

### 1.2 事件面契约链（五重锁定，最完整）

| 环节 | 位置 | 说明 |
|---|---|---|
| ①Rust 真源 | `crates/conex-types/src/events.rs:306-851` | `AgentEvent` enum 41 变体，serde rename 41 个 wire 名（events.rs:811-851） |
| ②机器可读注册表 | `crates/conex-types/contracts/engine-events.json` | 生成器输入 |
| ③JSON↔Rust 漂移测试 | `crates/conex-types/tests/registry_drift.rs` | 锁 JSON ↔ Rust 一致 |
| ④生成脚本 | `scripts/generate-engine-bindings.mjs` | 输出 `packages/shared-types/src/generated/engine/`（events.ts/types.ts/parser.ts/index.ts，固定集、确定性内容） |
| ⑤CI 生成物 diff | `.github/workflows/ci.yml:99-113`（`engine-bindings-drift` job）| 重跑生成器 + `git diff --exit-code`，Rust/JSON 变更未跑生成器即失败 |

前端消费侧：生成 `ENGINE_EVENT_TYPES` 41 键（generated/engine/events.ts:360-361）→ `engineDispatchTable` 41 键全覆盖（dispatch.ts:78-134）→ 分派入口唯一化 `parseBridgeEvent`（eventParser.ts:866-905）。事件信封顶层平铺 `{type, runId, sessionId, sequence, schemaVersion, ...}`，由 `core_event_bridge.rs` 保证（core_event_bridge.rs:194-220 测试断言）。事件订阅链路：`ConnectionLifecycle.ts:493` → `transport.onMessage`（tauriTransport.ts:204-210）→ `EventRouter.onMsg`（EventRouter.ts:92-132）。

### 1.3 前端 invoke 类型安全程度

- **无运行时校验**：`invokeTyped<T>` 的 T 是调用方手工标注的泛型（tauriInvoke.ts:167-182），仅编译期名义类型，无 zod/schema 运行时验证。
- `packages/shared-types/src/validators/typed-invoke.ts:8-25` 提供了 `createTypedInvoke`（zod 响应校验），但**全仓无消费方**（仅 validators/index.ts:1 与 shared-types index.ts:337 的 re-export）——死代码。
- 事件面有真正运行时校验（生成 parser 逐字段校验 + 深度守卫 parser.ts:65-100，256 层防 RangeError），命令面没有。
- 新代码占比：生产代码中 `invokeTyped` 约 31 处（rustProfileStore 8 / tauriTransport 8 / workflowRunner 5 / trashApi 4 / commandManifest 3 / FlowDagView 2 / tauriInvoke 内部 8 中含定义），旧 `invokeResult`/`invokeCmd` 仍大量存在（sessionRustDb 15 / rustCore 19 / modelCatalog 6 / backgroundTasksApi 10 / hostOpenersApi 7 / ptySessionApi 5 / workspaceFsApi 5 / skillsApi 1）。

### 1.4 事件类型新增/删除流程

- 流程完整：改 events.rs → 改/生成 engine-events.json（registry_drift.rs 锁）→ 跑 `node scripts/generate-engine-bindings.mjs`（package.json:26 `gen:engine-bindings`）→ 提交生成物 → CI 复核 diff。
- schemaVersion 契约有锚定测试：`parser.adversarial.test.ts:134-170`（F8-45）——信封 schemaVersion 字段不进事件体校验（fail-open）、新 schemaVersion + 未知事件类型 → fail-closed 解析失败、无 schemaVersion 旧帧照常解析。
- **缺口**：宽容归一器（eventParser.ts ENGINE_NORMALIZERS，40 键）是**手写双轨**，不在五重锁定链内——新增事件类型后归一器无需新增（strict 解析优先），但**归一器输出形状与生成类型的漂移无任何测试锁定**（详见 §3.3）。

## 2. 命令面清单（幽灵 / 断链 / 分裂）

对照方法：`command_registry!` 注册面 88 条（main.rs:90-209）× 前端生产代码实际 invoke 名（逐文件 grep）。

### 2.1 断链命令（前端调用 → Rust 无该 wire 键，共 3 条）【P1】

| 前端调用名 | 调用点 | Rust 实际键 | Rust 侧 rename | 后果 |
|---|---|---|---|---|
| `md_render` | `apps/crish-desktop/src/api/rustCore.ts:171` | `core_md_render` | markdown_commands.rs:22 | invoke 报「command not found」→ missing → 每次静默回退 JS 渲染（rustCore.ts:172-173）。**Rust 侧 markdown 渲染加速自接线以来从未生效** |
| `highlight_code` | `apps/crish-desktop/src/api/rustCore.ts:186` | `core_highlight_code` | markdown_commands.rs:67 | 同上，高亮永远回退 highlight.js（rustCore.ts:187-188） |
| `perf_jsonl_append` | `apps/crish-desktop/src/services/TelemetryMonitor.ts:103` | `core_jsonl_append` | —（旧命令已删）| perf/jsonl.rs:5-7 注释明示「TelemetryMonitor 旧名调用迁移至 core_jsonl_append 由前端域承接」，但**前端未迁移**。每次 flush 都 missing（invokeResult 三态中 missing 不报 console.error，TelemetryMonitor.ts:109-116 只在 error 时打印）→ **telemetry 落盘功能永久静默失效**，缓冲无限回退重试 |

附加问题：TelemetryMonitor.ts:107 还硬编码 `workspaceRoot: 'c:/Software/conex'`（当前开发者机器路径），随 telemetry 一起长期存在。

### 2.2 分裂命令（Rust 注册 ✓ 前端调用 ✓，但 manifest 名 ≠ 真实 invoke 键，共 4 条）【P1】

| manifest 登记名（registered=true） | 真实 invoke 键 | 前端调用点 | 说明 |
|---|---|---|---|
| `workbench_select_folder` | `select_folder` | desktopNativeFeatures.test.ts:237-258 | fs_commands/mod.rs:18-23 无 rename，函数名即键 |
| `workbench_list_directory` | `list_directory` | workspaceFsApi.ts:104、importFsHost.ts:117 | fs_commands/mod.rs:26-32 |
| `workbench_read_file_content` | `read_file_content` | workspaceFsApi.ts:156、importFsHost.ts:142 | fs_commands/mod.rs:35-42 |
| `workbench_write_file_content` | `write_file_content` | workspaceFsApi.ts:190 | fs_commands/mod.rs:49-57 |

main.rs:112-118 已承认此分裂（「元组名 workbench_* 仅作 manifest/注册面对照标签」「登记为已知分裂、待前后端同轮推进」）。
**实际风险**：全部现有调用走裸 `invokeResult`（不经 TauriTransport 清单门禁）所以能工作；但任何经 `TauriTransport.request/call` 的新调用点对 `select_folder` 等真实键会得到「Tauri command not available」（commandManifest.ts:203-205 清单校验拦截）。manifest 的 4 条 workbench_* 名 registered=true 却无消费（标签幽灵）。

### 2.3 幽灵命令（Rust 注册 + manifest registered=true + 前端无消费，共 11 条）【P2】

| 命令 | 消费证据缺口 | 归类 |
|---|---|---|
| `core_md_render` | 前端只调断链名 `md_render`；全仓无 `core_md_render` 调用 | 接线缺口（上游断链的下游幽灵） |
| `core_md_render_batch` | 无任何调用点 | 接线缺口 |
| `core_md_render_stream` | 无任何调用点（流式渲染面无消费者）| 接线缺口 |
| `core_highlight_code` | 前端只调断链名 `highlight_code` | 接线缺口（上游断链的下游幽灵） |
| `core_md_clear_cache` | 无任何调用点 | 接线缺口 |
| `core_jsonl_append` | 前端唯一写 JSONL 处（TelemetryMonitor）仍调旧名 | 接线缺口（上游断链的下游幽灵） |
| `core_rebuild_search_index` | 无任何调用点（含 worker 面）| 能力缺口（前端未暴露重建索引入口） |
| `config_get` | engineConfig.ts 只调 `config_update` / `core_get_status`；无 `config_get` 调用 | 能力缺口（前端没有读配置入口） |
| `core_read_run_events` | 前端只消费 `core_read_session_events`（sessionEventHydrate.ts:423）| 能力缺口（历史 API 无消费） |
| `touch_session` | 无任何调用点 | 能力缺口 |
| `delete_session` | 前端删除走 IndexedDB 本地面（sessionCrudActions.ts:410-420、useSidebarContextMenu.ts:216-217），Rust 命令无消费 | 能力缺口 |

说明：这 11 条不是「WS 时代残留」（那些已被 `manifest_excludes_ghost_commands` 测试拦截，command_manifest.rs:273-295），而是「已接线命令的消费侧未跟进」——注册面与 manifest 完全自洽，问题在**前端消费面**。

### 2.4 命名规范

- 双轨并存：workflow 6 条 kebab-case（`create-workflow` 等，main.rs:203-208，经 rename 对齐）vs 其余 82 条 snake_case。属有意识选择（workflow 域 wire 名沿用 CLI 惯例），但 manifest `family=workflow` 与 wire 风格无强制关联，新增命令时无 lint 拦截风格漂移。P3。
- `TauriTransport.request(type, payload)` 的形参名仍叫 `type`（tauriTransport.ts:181-194，T18 已无 WS type 语义）——命名残留，P3。

### 2.5 返回三态处理统一度

- 新统一面：`invokeTyped` 三态（ok/missing/InvokeError{kind,message,raw}），`TauriTransport.call` 统一「清单校验 → invoke → 暂态重试一次」（tauriTransport.ts:119-121、158-167）。
- **残留旧面**：`invokeCmd<T>`（missing 与 error 都吞 null）仍被 5 个 API 使用：backgroundTasksApi.ts 5 处、hostOpenersApi.ts 3 处、skillsApi.ts 1 处、rustCore.ts 5 处、workflowRunner.ts 5 处。错误类型/信息静默丢失，与 AA-07「kebab 码优先」规范相悖。P2。

## 3. 事件面覆盖

### 3.1 消费覆盖矩阵（41 类）

- **严格解析直通**（生成 parser 命中）：agent-start / agent-end / turn-start / turn-end / message-start / message-delta / message-end / tool-start / tool-update / tool-end / tool-batch-start / tool-batch-end / tool-input-repaired / context-compression-start / context-compression-end / provider-diagnostic / runtime-error / runtime-steering / runtime-intervention-required / approval-requested / approval-resolved / checkpoint-created / checkpoint-restored / run-terminal / cache-stats-updated / cache-waste-alert / cold-cache-warning / security-audit / subagent-started / subagent-event / subagent-ended / task-* 7 / timer-fired / timer-cancelled / cron-fired（events.ts:360 与 dispatch.ts:81-133 逐键对齐，编译期由 `[ET in EngineEventType]` 保证不漏）。
- **显式空实现**：dispatch.ts:120-133 注释声称 task/timer/cron 10 键「显式空实现」，但 taskEventHandlers.ts:1-2 实为「真实消费（刷新信号最小版 T7a）」——**注释过时**（dispatch.ts 注释未随 14-T2b/T7 更新）。实际消费语义：事件仅触发轮询刷新信号 + 轻量摘要（taskEventHandlers.ts:4-16），`task-output`/`task-heartbeat` 仅计数不触发拉取（:12）。P3（文档漂移，非功能问题）。
- **legacy 信封**：subagent-* / error 4 类（eventParser.ts:70-78），双分支转发同一 handler（dispatch.ts:113-119、136-143）。
- **未知事件**：`registerUnknownEvent` 显式登记 logInternalError（EventRouter.ts:144-154），可观测、不静默吞 ✓。
- **数据面隔离**：task-*/timer-*/cron-fired 10 类由全局 dataPlaneRouter 消费（dataPlaneRouter.ts:59-60），per-run EventRouter 直接 return 防双写（EventRouter.ts:88）；`ensureDataPlaneRouter`/`ensureSubagentPlaneRouter` 已在 useEngineState.ts:178/183 装配 ✓。
- **消费侧幂等去重**：`buildEventDedupeKey`（type:messageId:sequence，EventRouter.ts:166-189），重复帧只消费一次；实时轨无 sequence 时退化为 type:messageId，注释自认存在「多轮 turn 同 id 误伤面」（EventRouter.ts:163-164，已回报）。

### 3.2 事件消费方统计（handler 目录）

41 个 handler 分散在 9 个模块：messageHandlers / toolHandlers / lifecycleHandlers / diagnosticHandlers / compressionHandlers / approvalHandlers / subagentHandlers / cacheEventHandlers / securityAuditHandlers / taskEventHandlers（dispatch.ts:15-71 导入面）。无「未实现 throw」型 handler。

### 3.3 宽容归一器与生成类型的双轨漂移风险【P2】

- 双轨机制本身是设计决策（strict 优先、宽容兜底，eventParser.ts:4-11），40 键归一器（eventParser.ts:399-859）覆盖：6 个历史别名（text-delta、run-completed/failed/cancelled）+ 全部 41 类事件中的大部分。
- **漂移风险点**：
  1. 归一器输出无运行时校验——标注为生成类型（如 `EngineTaskStartedEvent`，eventParser.ts:722-734）但构造时无 zod 复核，形状漂移静默存活。
  2. **静默默认值吞噬漂移**：`normalizeRunTerminal` 未知 terminal 兜底 `completed`（eventParser.ts:224）、`isToolCategory` 兜底 `terminal`（:264）、`isAuditOperation` 兜底 `command-exec`、`isAuditDecision` 兜底 `denied`（:848/851）——后两处安全向 fail-closed 正确，但 terminal/category 兜底会把 Rust 侧新枚举值静默降级为旧值。
  3. registry_drift.rs 只锁 JSON↔Rust，**不锁「归一器 ↔ 生成类型」**；归一器与生成类型之间无对照测试（对比 type-drift.test.ts 对手写 events.ts/tool.ts 有 `expectTypeOf` 双向相等断言，归一器没有）。
  4. 生成 parser 深度守卫 256 层（parser.ts:65-100）只保护 strict 路径；宽容路径的 `normalizeDeltaBlock`/`normalizeBatchCalls` 对深层载荷无深度守卫——但 EventRouter.onMsg 顶层 try/catch 兜底（EventRouter.ts:109-115）防 RangeError 逃逸。
- 未知事件：非生成类型且无归一器 → parseErr → 显式登记 ✓（eventParser.ts:905）。

### 3.4 事件面无 schemaVersion 执行面

信封 `schemaVersion` 由 Rust 注入（core_event_bridge.rs:217 测试断言 =1），前端 strict parser 不进事件体校验（fail-open，parser.adversarial.test.ts:135-150）。契约演进靠事件类型层 fail-closed（:164-170）。合理设计。

## 4. 错误传播

### 4.1 路径完整度

```
Rust 命令 → CoreError {kind, detail}（conex-types 权威定义）
  → 前端 invokeTyped 提取 kind/message（tauriInvoke.ts:72-102 extractErrorKind）
  → 命令面统一入口 TauriTransport（logger.error 落 LoggerService，tauriTransport.ts:106-111）
  → 页面层 classifyErrorDomain / classifySoftFailure（userFacingErrors.ts）
  → 差异化六域文案 S1-S6（userFacingErrors.ts:108-118）
```

- CoreError 6 kind → 77 码映射表在 `core_error_code`（core_error.rs:12-20 文档化；conex-types error.rs codes 模块）。
- **77 码双向漂移测试**：codes-drift.test.ts:28-41 从 Rust error.rs 正则抽取全部码常量，与 TS `CRISH_ERROR_REGISTRY` 双向相等断言——改任一侧不同步立即红 ✓。
- 存储层/run 层无损映射：`map_store_err` / `map_run_err`（core_error.rs:34-54）保留操作名 + 人读消息，detail 语义完备。
- 事件面错误（runtime-error / provider-diagnostic）走独立事件类型，与命令面错误协议并行、不混流。

### 4.2 错误码注册面完整度缺口【P2】

- Rust provider kind 共 **13 个**（stream_error.rs:305-319）：`aborted` / `payload-too-large` / `gateway-challenge` / `auth` / `quota` / `endpoint-unavailable` / `context-length-exceeded` / `invalid-request` / `rate-limit` / `server-error` / `timeout` / `network` / `unknown`。
- 前端 `KEBAB_KIND_TO_SOFT` 仅登记 **8 码**（userFacingErrors.ts:65-75）：auth / endpoint-unavailable / network / timeout / quota / server-error / rate-limit / gateway-challenge。
- `KEBAB_TO_DOMAIN` 仅 6 码（userFacingErrors.ts:121-128）。
- **未登记 5 码**：`aborted` / `payload-too-large` / `context-length-exceeded` / `invalid-request` / `unknown` → 回落文本正则兜底（userFacingErrors.ts:89-96），其中 `context-length-exceeded`（上下文超限）是高频用户体验路径却无专门分类，会误判为 `ended`/`provider_fault`。建议：kebab 码表与 Rust kind_str 建双向测试（对齐 codes-drift.test.ts 模式），并补 `context-length-exceeded` → 专属分类。

### 4.3 缺失/异常路径

- `extractErrorKind` 对非 CoreError 字符串/Error 兜底 kind=`Unknown`（tauriInvoke.ts:76-78）——设计内。
- `isMissingCommandMessage` 用文本正则识别 missing（tauriInvoke.ts:55-59），与 Tauri 各版本报错文案耦合，脆弱但仅影响三态归类的边界。
- `invokeCmd` 吞错残留（§2.5）。

## 5. 序列化 / 性能

### 5.1 现状（已优化的面）

- **入队即序列化**（P9）：事件信封在缓冲入队时即 `serde_json::to_string`，flush 直发字符串，避免二次序列化（core_event_bridge.rs:107-120、engine.rs:13-16、1692-1739）。
- **背压丢帧可观测**：`EventBuffer` 双水位（默认 Soft 64 / Critical 256 条，buffer.rs:200-205），Soft 丢最旧 Delta 帧、Critical 不丢（buffer.rs:268-330 测试）；`EmitReport{emitted,buffered,dropped}` 可观测（core_event_bridge.rs:28-36）；「Delta 可丢、message-end 必达」契约（EventRouter.ts:102-104 注释）。
- 事件载荷为完整 JSON 字符串经 `app.emit`（TauriEmitter，core_event_bridge.rs:68-81），前端 `JSON.parse` 单次（tauriTransport.ts:75-85、318-323）。

### 5.2 热点与机会【P2/P3】

| 热点 | 位置 | 说明 | 建议 |
|---|---|---|---|
| 大帧无字节级水位 | buffer.rs:91-140 按条数计数 | message-end 全量 message、tool-end 全量 output（工具输出可达 MB 级）单帧不受限；高密度大帧流下内存放大 | 增加字节级水位/单帧上限，超限截断或改分页 |
| 大帧全量校验开销 | generated/engine/parser.ts 逐字段 + 深度守卫 | tool-end/tool-batch-end 的 output 全量进 zod 校验，长输出 O(n) 双份内存 | 对 output/大文本字段走宽松校验或按需惰性解析 |
| 二进制传输 | rustCore.ts:196-198 注释 | Tauri 不支持 Uint8Array 直传，`Vec<u8>` → number[]，base64 编解码放大 3-5 倍 | 低频路径，可接受；如加密/大文件面出现再评估插件化二进制通道 |
| 流式渲染未接线 | `core_md_render_stream`（幽灵） | 命令已注册无消费；大文档渲染无流式能力 | 接线或删除（见 §2.3） |
| 事件面逐帧 JSON.parse | tauriTransport.ts:318-323 | 每事件一次 parse，delta 高频下为纯 JS 开销 | 可接受（进程内 IPC）；若 delta 达万级/秒再评估聚合帧 |

## 6. 安全面

### 6.1 命令权限

- **自定义命令无 Tauri ACL**：capabilities/default.json:6-26 只配置 core:default / core:event / core:window / dialog / mcp 插件权限，**自定义命令（88 条）不在 capability 权限模型内**——Tauri 2 中自定义命令默认即可 invoke，权限面 = 「注册面 + 前端清单门禁」的应用层组合。自家前端单窗（windows:["main"]）场景风险可控，但任何未来多窗/iframe 扩展需重审。
- `core:event:allow-emit` 对前端开放（default.json:10）——前端可 emit 任意事件名；当前无消费方，建议收紧为仅 `allow-listen`。

### 6.2 敏感数据（密钥）

- **K-02 协议执行良好**：除 `config_secret_reveal(ui_confirm=true)` 外所有命令只回 `{ hasKey, apiKeyLast4 }`，不回明文（config/credentials.rs:9-10、212-235）；`config_secret_set` 成功日志只记 last4（credentials.rs:257-262，K-05）。
- `config_secret_reveal` 为「显示密钥」一次性确认入口（rustProfileStore.ts:78-85），明文只在用户显式确认后进前端设置页——设计内。
- 载荷整形面：`config_update` 整形器剥离 `apiKey` 字段（commandMap.ts:77-82，PE-07 T07.4 K-05），明文 key 一律走 config_secret_set/config_profile_apply ✓。
- 存储面：密钥落 DPAPI（credentials.rs:5 `{profileId}.dpapi`）。
- CI 有 gitleaks secret-scan（ci.yml:117-121）✓。
- **问题**：TelemetryMonitor.ts:107 硬编码 `workspaceRoot: 'c:/Software/conex'`——开发者机器路径泄漏进产品代码（非密钥，但属于敏感路径残留），P3。

## 7. 严重度分级清单

### P0（无）

未发现立即致瘫或数据损失问题。

### P1（3 组，功能承诺失效或持续静默失败）

1. **markdown 双命令断链**：`md_render` / `highlight_code`（rustCore.ts:171/186）≠ 注册键 `core_md_render` / `core_highlight_code`（markdown_commands.rs:22/67）。Rust 渲染/高亮加速自接线以来从未生效，每次调用失败回退 JS；上游 5 条 core_md_* 幽灵由此而生。
   - 修法：前端改调 core_* 名（或 Rust 侧去掉 rename 并同步 manifest），双端同一轮推进；补充「前端 invoke 名 × 注册键」双向测试。
2. **telemetry 断链**：`perf_jsonl_append`（TelemetryMonitor.ts:103）旧名未迁 `core_jsonl_append`（perf/jsonl.rs:5-7 已注明迁移责任在前端域）。落盘永久静默失败（missing 不报错、缓冲无限回退），错误日志面长期缺失。
   - 修法：改名 + 删除硬编码 workspaceRoot；给 invokeResult 的 missing 分支加一条可观测日志。
3. **fs 4 命令 manifest 分裂**：真实 invoke 键（select_folder/list_directory/read_file_content/write_file_content，函数名）不在清单内，清单登记的 workbench_* 名无消费（main.rs:112-118 自认已知分裂）。TauriTransport 通道对真实键永远 missing，分裂靠「调用方全走裸 invokeResult」维持。
   - 修法：manifest 名与 invoke 键对齐（推荐 manifest 登记真实键），或 4 条加 rename 统一到 workbench_* 并同步前端调用名。

### P2（5 组，契约缺口或降级路径不精准）

4. **幽灵命令 11 条**（§2.3）：core_md_* 5 条接线缺口 + core_jsonl_append 迁移缺口（随 P1-1/2 自动消解）；core_rebuild_search_index / config_get / core_read_run_events / touch_session / delete_session 为真实能力缺口——要么前端接线要么删命令并同步 manifest（manifest 测试锁定的 92 条公式同步调整）。
5. **kebab 错误码表不全**：Rust 13 kind（stream_error.rs:305-319）vs 前端 8 码（userFacingErrors.ts:65-75），`context-length-exceeded` 等 5 码回落文本正则；建议建「Rust kind_str × 前端码表」双向测试（对齐 codes-drift.test.ts:28-41 模式）。
6. **宽容归一器双轨漂移无锁定**：归一器输出无运行时校验、terminal/category 静默默认吞噬新枚举（eventParser.ts:224/264）、registry_drift 只锁 JSON↔Rust 不锁归一器↔生成类型；建议增加「归一器输出样本 vs 生成类型」expectTypeOf/运行时对照测试。
7. **invokeCmd 吞错残留**：backgroundTasksApi/hostOpenersApi/skillsApi/rustCore/workflowRunner 共 19 处调用仍吞 missing/error 为 null；建议迁移 invokeTyped 并给 rustCore 的 worker 回退路径保留三态分支。
8. **配置族无读面**（config_get 幽灵的衍生）：前端无读取配置入口，配置只写不读，UI 状态与 Rust 配置可能漂移。

### P3（7 组，工程卫生）

9. 命名双轨（workflow kebab vs snake，§2.4）+ `request(type, ...)` 形参名残留。
10. 大帧无字节级水位/单帧上限、大帧全量 zod 校验（§5.2）。
11. 二进制传输 number[] 放大（低频，可接受）。
12. `ipc-schemas.ts` / `typed-invoke.ts` 死代码（无消费方，仅 re-export）。
13. 注释过时两处：command_manifest.rs:7（条数 84/89 vs 实际 88/92）、dispatch.ts:120-133（task/timer/cron「显式空实现」vs taskEventHandlers 真实消费）。
14. TelemetryMonitor.ts:107 硬编码 `c:/Software/conex`。
15. `core:event:allow-emit` 未收紧（capabilities/default.json:10）。

## 8. 附：证据索引

| 主题 | 证据 |
|---|---|
| 注册宏/注册面 | main.rs:79-88、90-209 |
| manifest 真源/测试 | command_manifest.rs:68-186、200-379 |
| 前端清单镜像/拉取 | commandManifest.ts:54-173、211-229 |
| 清单门禁/运行时对照 | commandMap.ts:49-51、58-67 |
| 三态 invoke 面 | tauriInvoke.ts:18-38、134-198 |
| transport 唯一通道 | tauriTransport.ts:158-167、181-201、305-341 |
| 事件发射桥 | core_event_bridge.rs:51-145、194-220 |
| 事件背压 | buffer.rs:36-145、200-205、268-330 |
| 事件真源 41 类 | events.rs:306-851（wire 名 811-851）|
| 事件生成与 CI 锁 | generate-engine-bindings.mjs:10-49、ci.yml:99-113、registry_drift.rs |
| 事件解析单一入口 | eventParser.ts:399-859、866-905 |
| 事件分派表 41 键 | dispatch.ts:78-134 |
| 数据面路由 | dataPlaneRouter.ts:59-60、154、276、useEngineState.ts:178-183 |
| 错误映射 | core_error.rs:26-54、conex-types error.rs |
| 77 码双向测试 | codes-drift.test.ts:28-69 |
| 前端错误分类 | userFacingErrors.ts:62-97、108-189 |
| provider kind 13 码 | stream_error.rs:305-319 |
| 密钥协议 | config/credentials.rs:5-10、212-235、257-262 |
| 能力配置 | capabilities/default.json:6-26 |
