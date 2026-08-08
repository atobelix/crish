# 启动噪音与日志分级治理分析（03）

> 产出类型：深度分析（只读 + 本文档）；不修改任何代码。
> 数据基准：`apps/agent-workbench/logs/workbench.20260806/07/08.log` 实读 + 代码实读。
> 关联背景：2026-08-08 三个真实噪音案例（migrateLegacyProfiles 残留告警 / tiptap link 重复 / 迁移备份空路径）已修复，本分析面向"启动噪音应尽量消除、真错误必须正常显示"的整体治理。

---

## 0. 摘要（结论先行）

1. **三天日志 345 行（Rust 侧），25 次启动**。每次启动固定出现 5~9 行 Rust 侧日志 + 6~8 行前端 JS 日志；其中 **DB 打开失败 ERROR 在 25 次启动中出现了 21 次（84%）**——这是 06/07/08 连续三天每次启动必现的最大噪音源，且是真错误（sessions.db 停在 v3 形态、缺 `runs`/`pending_inputs` 表 → `migrate_v4 failed: no such table: runs` → 每次降级内存库）。08/08 15:19 起恢复成功（当天最后一次修复生效），**根因修复（migrate.rs v3→v4 缺表补建 + 回归测试）目前仍在工作区未提交**（`git diff crates/conex-db/src/migrate.rs`、`crates/conex-db/tests/migrations.rs:704-735`）。
2. 已修三案例均已确认修到位：`migrateLegacyProfiles.ts:37` 死键剥离 + `migrateLegacyProfiles.test.ts` 新增"二次启动静默"回归；`TiptapEditorField.tsx:143-155` StarterKit `link:false`；`migrate.rs:140-145` 空路径过滤（`p != ":memory:" && !p.as_os_str().is_empty()`）。
3. **分级滥用点共 10 处**（Rust 6 + 前端 4）：3 处成功提示用 INFO（快照已保存/重启恢复完成/会话数据库已打开/pty session created，该降 debug）；1 处外部插件真失败用 INFO（tauri-plugin-mcp `Command failed`，该 warn/error）；1 处绕过 tracing 直出 stderr（migrate.rs `report_backup_failure` 的 `eprintln!`）；1 处每启动 3 行的"跳过" debug 正常路径；前端 35 处裸 `console.warn` 绕过 K-05 脱敏钩子。
4. **重复噪音检测机制不存在**：`scripts/` 41 个 mjs 中无日志对比类脚本；CI 三档（ci.yml / ci-mid.yml / ci-slow.yml）均无"启动无噪音"覆盖。`scripts/audit-ui-runtime-errors.mjs`（Playwright 运行时 console 审计）是唯一运行时日志采集工具，可复用其模式。
5. **前端 logger 无任何重复抑制**（无 dedupe、无 repeat 计数）；唯一去重在 toast 层（`useToastQueue.ts:477`）与迁移门控（`migrateLegacyProfiles.ts:55` migrationInFlight）。
6. 治理建议核心：**分级规则 + `scripts/check-boot-noise.mjs` 审计脚本（跨启动对比） + 12 个一次性初始化点的"完成静默、失败出声"改造清单**（详见 §5）。

---

## 1. 三天日志全景

### 1.1 数据与方法

| 文件 | 大小 | 行数 | 启动次数（以 `setup 完成` 行计数） |
|---|---|---|---|
| `logs/workbench.20260806.log` | 1,420 B | 8 | 2 |
| `logs/workbench.20260807.log` | 5,680 B | 32 | 8 |
| `logs/workbench.20260808.log` | 57,029 B | 337 | 15（其中 4 次 DB 打开成功，11 次失败降级） |
| 合计 | — | 345 | 25 |

- 日志格式：tracing 双通道（文件 + stderr），ANSI 着色，`时间戳 LEVEL target: 消息 key=value...`。
- 统计口径：剥离 ANSI 与结构化字段后按 `LEVEL|target|消息头` 聚合（debug/trace 计入，MCP 连接端口号归一化）。
- 前端 JS 日志**不落盘**：仅经 tauri-plugin-mcp（`CRISH_MCP_SOCKET=1` 开启）console 拦截进内存环形缓冲（capacity 5000，重启即丢），本分析通过日志中 `query_logs` 命令的响应预览（15:24 / 15:46 / 15:50 三次快照）还原前端每启动行。

### 1.2 每次启动必现的 Rust 侧日志行（文件通道）

| 行内容（归一化） | 级别 | target | 三天总数 | 每启动 | 分类 |
|---|---|---|---|---|---|
| `setup 完成（IPC 模式）` level=… commands=88 | INFO | setup | 25 | 1 | ① 关键一次性信息（合理保留，可降级） |
| `重启恢复完成` mode=SnapshotIncremental interrupted=0 … | INFO | restore | 25 | 1 | ② 重复成功提示（噪音） |
| `快照已保存` generation=1 | INFO | restore | 25 | 1+（周期/退出还触发） | ② 重复成功提示（噪音） |
| `[DB] 打开 sessions.db 失败，降级为内存库` error=migration: migrate_v4 failed: no such table: runs | ERROR | db | 21 | 0.84 | ③ 可疑重复 error（真故障，根因已修未提交） |
| `会话数据库已打开` path=… | INFO | db | 4 | 0.16 | ② 成功提示（08/08 15:19 起才出现） |
| `TimerRegistry 启动恢复跳过：当前上下文无 tokio runtime` | DEBUG | engine | 13 | 1（08/08 起） | ② 正常条件却以"跳过"表述（正常 IPC 装配路径） |
| `Watchdog 装配跳过：当前上下文无 tokio runtime` | DEBUG | engine | 13 | 1 | 同上 |
| `SchedulerRegistry 启动恢复跳过：当前上下文无 tokio runtime` | DEBUG | engine | 13 | 1 | 同上 |
| `[TAURI_MCP] Socket server will use TCP: 127.0.0.1:4000` 等 12 行启动块 | INFO | tauri_plugin_mcp* | 12×4 | 12（仅 dev + `CRISH_MCP_SOCKET=1`） | ② 重复成功提示（插件自身） |
| `[TAURI_MCP] Accepted new TCP connection` / `Handling new client connection` / `Client disconnected cleanly` | INFO | tauri_plugin_mcp::socket_server | 15×3 | 每连接 3 | ② 重复成功提示（插件自身） |
| `[TAURI_MCP] Command get_dom/execute_js failed with error: …` + `Command error: …` | INFO | tauri_plugin_mcp::tools / socket_server | 5 | 每次失败 | ③ 真失败用 INFO（误级） |
| `failed to create webview: WebView2 error: … 0x800700AA 请求的资源在使用中` | ERROR | tauri_runtime_wry | 2 | 罕见（快速重启时） | ③ 真错误（正常显示，正确） |
| `pty session created` / `pty session killed` | INFO | pty | 2 | 每 PTY 会话 | ② 成功提示（可降 debug） |

### 1.3 每次启动必现的前端 JS 行（仅 MCP 内存缓冲，快照还原）

| 行内容 | 级别 | 来源 | 每启动 | 分类 |
|---|---|---|---|---|
| `[provider-migration] migrateLegacyProfiles 未完成：migrated=0 … residual=[crish_providers,conex_pi_providers]` | warn | `migrateLegacyProfiles.ts:158` | 1（每次启动必现，**已修**） | ③→已消除 |
| `%cDownload the React DevTools for a better development experience…` | info | React（dev only） | 1 | ② 重复成功提示（dev 环境） |
| `[crish] tauri-plugin-mcp guest listeners ready` | info | `main.tsx:115` | 1 | ② 重复成功提示 |
| `[crish] MCP app_bridge helpers registered` | info | `dev/mcpBridge.ts:95` | 1 | ② 重复成功提示 |
| `[vite] connecting…` / `[vite] connected.` | debug | vite | 2 | ② dev 环境噪音 |
| `[perf] bootstrapOrchestrator / bootstrapCore / bootstrapFull: …ms` | debug | `bootstrap-*.ts` | 3 | ② 成功提示（debug 级，可合并） |
| `prev keys: ["workspaces", …]`（超长 store 键清单） | trace | store persistence | 1 | ② 内容过大的 trace |

> 快照 `counts` 显示 warn=3（15:24）→ 7（15:46）→ 8（15:50），除 provider-migration 外仍有其他 warn 来源，**无法从落盘日志还原具体内容**（前端日志不落盘）——这是"前端告警不可审计"的直接证据（详见 §3.2 脚本设计的 `--mcp` 采集模式）。

### 1.4 分类总表

| 分类 | 判定 | 三天清单 |
|---|---|---|
| ① 关键一次性信息（合理保留） | 每启动 ≤1~2 条、无重复语义 | `setup 完成`（commands=88） |
| ② 重复成功提示（噪音） | 每次启动/每次交互必现且为成功路径 | 快照已保存、重启恢复完成、会话数据库已打开、pty created/killed、MCP 12 行启动块 + 每连接 3 行、前端 guest listeners / app_bridge / React DevTools / perf×3 / vite×2 |
| ③ 可疑重复 warn/error（潜在未发现问题） | 必现且非成功路径 | DB 打开失败 ERROR×21（根因已修）、MCP Command failed INFO×5（误级）、webview ERROR×2（真错误，正确展示） |

---

## 2. 分级滥用点清单（文件:行号）

### 2.1 Rust 侧

| # | 位置 | 现状 | 问题 | 建议级别 |
|---|---|---|---|---|
| R1 | `apps/agent-workbench/src-tauri/src/main.rs:241-245` | ERROR `[DB] 打开 sessions.db 失败，降级为内存库` | 降级内存库是"已处理的故障路径"，但每启动必现 ERROR ×21 天。级别本身正确（真错误必须显示）；噪音根源在根因（迁移崩溃）——**根因修复优先于降级**；同时建议 error 行后紧跟一次 diagnostics（已有 `main.rs:246`），避免重复 | error 保留（真错误）；根因修复后自然消失 |
| R2 | `main.rs:232`（`会话数据库已打开`）、`main.rs:450-455`（`setup 完成`）、`core_run_commands.rs:1900-1907`（`重启恢复完成`）、`core_run_commands.rs:1948`（`快照已保存`）、`pty/session.rs:366`（`pty session created`） | INFO 成功提示，每启动必现 | 违反"成功静默、失败出声"：成功路径的 INFO 是纯噪音；`快照已保存`还叠加周期/退出触发 | 降 debug（失败路径 `core_run_commands.rs:1911` error 保留不动） |
| R3 | `tauri-plugin-mcp`（外部 crate，rev c7d271a，`dev_mcp.rs:58-71` 注册）：`Command get_dom failed with error` / `Command error: Missing or invalid window_label` 等 | INFO 级记录**真实失败** | 误级：失败路径用了 info，用户无从区分；且 `Missing or invalid window_label` 是客户端协议错误，应 warn/error | 上游 fix 或 fork 提级；落地前接受（dev 工具插件）并在 §5.3-7 的 wrapper/过滤方案覆盖 |
| R4 | `crates/conex-db/src/migrate.rs:75-90`（`report_backup_failure`） | `eprintln!` 直出 stderr | 绕过 tracing 双通道：文件日志看不到、无结构化字段、无 target——与"文件 + stderr 双通道"机制（`main.rs:262-268`）不一致；本次 06/07/08 日志中未出现（空路径修复后触发不到），但机制性偏离仍在 | 改 `tracing::warn!(target: "db")` + 保留 session_meta 落键 |
| R5 | `engine.rs:839-842 / 877-880 / 1291-1294`（TimerRegistry / Watchdog / SchedulerRegistry `启动恢复跳过`） | DEBUG ×3，每次启动必现 | 内容是**正常条件**（IPC 命令上下文无 tokio runtime，`engine.rs:831` try_current 守卫），却以"跳过"的失败腔调表述；三行零信息增量 | 合并为一条 trace（如 `engine 装配跳过 tokio 相关项（IPC 上下文）`）或降 trace |
| R6 | `crates/conex-db/src/blocks.rs:43-55`（`from_db_str` 未知字面量降级）、`crates/agent-provider/src/models/catalog.rs:516-532`（覆盖项被拒逐条 warn） | warn 每条目/每行一次 | 若数据中存在未知状态字面量或坏覆盖配置，则**每次启动读库/装配时逐条重复**（与 provider-migration 同款重复面）；前者语义是"未来版本扩展"属预期内 | 首次探测 warn 一次 + 后续静默（进程内去重），或按配置哈希仅在有变化时告警 |

### 2.2 前端侧

| # | 位置 | 现状 | 问题 | 建议 |
|---|---|---|---|---|
| F1 | `services/LoggerService.ts:68,98-137` | 无 dedupe / 无 repeat 计数；每条直接进 ring buffer(200) + console | 重复告警（如本次 provider-migration）无法被抑制，只能靠调用点自行幂等 | 增加"同 (module+msg) 在时间窗口内合并为 1 条 + repeat=N"的抑制面（见 §5.1） |
| F2 | `api/provider-profiles/migrateLegacyProfiles.ts:158,256` | `logger.warn` 残留/写回失败 | 已修（死键剥离 + 幂等标记 + 回归测试 `migrateLegacyProfiles.test.ts`）；**确认不再重复** | 维持"失败才出声"模式即可 |
| F3 | `api/transport/commandMap.ts:61`、`api/transport/tauriTransport.ts:329,335` | `logger.warn` 监听器/命令映射异常 | 属失败路径，级别正确；但 tauriTransport 监听错误若在断线重连场景每轮触发，仍会重复 | 接入 F1 的 dedupe 面 |
| F4 | 裸 `console.warn` 35 处（`main.tsx:21,37,94`、`AppBootstrap.ts:99,172`、`AppShortcuts.ts:196`、`hydrateWorkspaceShell.ts:83`、`useEngineBootstrap.ts:44`、`WindowResizeBridge.ts:89`、`EventBus.ts:86`、`fontStore.ts:376,392`、`store-persistence.ts:154,296`、`adapterShape.ts:791`、`oauthTokenManager.ts:52,151`、`modelCatalog.ts:845,850`、`ptySessionApi.ts:224`、`sessionStreamManager.ts:138`、`sessionRustDb.ts:693`、`silentComplete.ts:239`、`useChatHandlers.ts:186`、`migrateFromLocalStorage.ts:176`、`streamDiag.ts:40`、`telemetryAccess.ts:160`、`userFacingErrors.ts:130`、`useToastQueue.ts:472`、`layoutAnimationStore.ts:82`、`sessionMessageActions.ts:285`、`useStreamCallbacks.ts:201`、`performance-budget.ts:17`、`emptyShellAssert.ts:140` 等） | 全部绕过 LoggerService | **双问题**：① 绕过 K-05 全局脱敏钩子（`LoggerService.ts:100-105`）——`userFacingErrors.ts:130`、`streamDiag.ts:40` 等若携带敏感串会明文进 console；② 不落 buffer，`getRecentLogs`/MCP `query_logs` 审计不到 | 逐步迁移到 `logger.warn`；确实属于 debug 面的（`performance-budget.ts:17`）改 `console.debug` |

---

## 3. 噪音检测机制现状与建议

### 3.1 现状（无）

- `scripts/` 共 41 个 `.mjs`，无任何"日志对比 / 启动噪音"类脚本。最接近的三类：
  - `check-swallowed-errors.mjs`：代码静态扫描吞错模式（`let _ =`、`if let Ok(_)`），**不读运行日志**；
  - `audit-ui-runtime-errors.mjs`：Playwright 连 `localhost:5174` 采集运行时 console——**唯一运行时日志采集工具**，可复用的接入模式（dev server + 页面加载 + console 断言），但针对 UI 会话而非启动日志；
  - `check-ui-layer.mjs` / `check-line-counts.mjs` 等：依赖/规模静态门禁。
- CI 三档（`.github/workflows/ci.yml` 快层 5 job：typecheck/lint/vitest-fast/audit/engine-bindings-drift/cargo-deny/secret-scan；`ci-mid.yml`；`ci-slow.yml`）：均无启动日志或噪音断言。
- 前置条件缺失：Tauri 桌面进程无法在 ubuntu CI 启动；本地也没有"启动后自动落盘并可比对"的固定入口（前端日志不落盘，见 §1.3）。

### 3.2 建议：`scripts/check-boot-noise.mjs`（规格）

目标：**跨启动对比，找出"每次启动都出现的行"**，按白名单断言，防重复噪音回潮（2026-08-08 三案即此类）。

```
输入：
  --logs <dir|glob>      默认 apps/agent-workbench/logs/workbench.*.log
  --min-sessions N       参与判定所需启动簇数（默认 3；不足则跳过判定，--strict 时失败）
  --allowlist <json>     允许的"必现行"白名单（默认 scripts/boot-noise-allowlist.json）
  --level-threshold      判定级别下界（默认 warn——只盯 warn/error；--all 则含 info）
  --mcp-snapshot         附加模式：若 MCP socket 可用，用 query_logs 采集前端 JS 行一并判定
  --update               把当前"必现行"写回 allowlist（显式登记，对齐 check-swallowed-errors.mjs 基线机制）
  --strict               出现未登记必现行即 exit 1（CI 用）；默认 exit 1 仅对 warn/error
```

处理管道：
1. 剥离 ANSI + 结构化字段，按 `LEVEL|target|消息头` 归一化（端口/时间戳/路径参数掩码化，对齐 §1.1 口径）；
2. 按时间戳间隙（>10s）分簇 → 启动簇；每簇以 `setup 完成` 行锚定（存在时）；
3. 求"簇出现率 = 100%"的行集 = 必现行；对每行标注出现簇数/总簇数/级别/来源 target；
4. 分类输出：① 命中 allowlist（放行）② warn/error 必现（违规，红线）③ info 必现（提示降级，`--strict` 时违规）④ debug/trace 必现（提示合并，不违规）；
5. 退出码：无违规 0；有 ②/③ 违规 1（② 恒 1，③ 仅 `--strict`）。

断言清单（默认 allowlist 草案，随修复逐步清空）：
- 放行：`setup 完成`（关键一次性）、`[TAURI_MCP] Socket server will use TCP`（dev 工具）等有意保留项；
- 红线（出现即失败）：任何必现 warn / error——本分析的三天数据下，DB 打开失败 ERROR 已被根因修复清除，allowlist 应保持**空 error 清单**，杜绝"用 allowlist 掩盖真错误"。

CI 接入点：
- 本地门禁：`npm run check:boot-noise`（读近期 3 个日志日文件，退出码进 commit hook 可选）；
- CI：ubuntu 无法跑桌面进程 → 在 `ci-slow.yml` 加**Windows runner 可选 job**（`continue-on-error: true` 或 report-only 模式），启动 `npm run tauri dev` 一次 + 关停后跑脚本 `--min-sessions 1 --mcp-snapshot`，产出噪音报告 artifact；红线（必现 warn/error）在本地 pre-push 由开发者自证；
- 与 `audit-ui-runtime-errors.mjs` 合并演进：其 Playwright console 采集可与本脚本的 `--mcp-snapshot` 共用同一采集器（二选一，避免双套机制）。

---

## 4. 前端告警面盘点

### 4.1 LoggerService 重复抑制现状（无）

`LoggerService.ts` 全量 160 行实读结论：
- 环形缓冲 200 条（`LoggerService.ts:68`），`pushOverwritingOldest` 直接覆盖，**无窗口合并、无 repeat 计数、无按 (module+msg) 去重**；
- 每次 `log()` 必然 `console.warn/info/…`（`LoggerService.ts:114-136`），dev 下带样式、prod 下 JSON；
- 唯一并发门控在调用点：`migrateLegacyProfiles.ts:55`（migrationInFlight 模块级共享，防 StrictMode 双跑）。
- **系统内唯一 dedupe 在 toast 层**：`useToastQueue.ts:470-484`（同文案刷新 TTL 不叠层 / success-tip 策略性丢弃），与日志无关。

### 4.2 warn 来源盘点

| 通道 | 调用点数 | 每次启动必现？ | 每次交互必现？ | 代表位置 |
|---|---|---|---|---|
| `logger.warn` | 5 | provider-migration 曾必现（**已修**）；其余仅失败时 | 否 | `migrateLegacyProfiles.ts:158,256`、`commandMap.ts:61`、`tauriTransport.ts:329,335` |
| 裸 `console.warn` | 35 | 否（均为失败路径，符合"失败才出声"） | 部分：`useChatHandlers.ts:186`（连点节流）、`EventBus.ts:86`（监听器泄漏，仅超阈值）、`ptySessionApi.ts:224`、`streamDiag.ts:40` | 见 §2.2 F4 清单 |
| tiptap `Duplicate extension names: ['link']` | — | 曾每次编辑器装配必现（repeat=4，**已修**：`TiptapEditorField.tsx:148` `link:false`） | 否 | — |

> 结论：前端 warn 的"必现重复"风险已基本清零（两大案已修）；剩余风险是**裸 console.warn 脱敏绕过**（§2.2 F4）与**未来新幂等类初始化重蹈覆辙**（provider-migration 模式）——由 §5.3 模式清单与 §3.2 审计脚本兜底。

---

## 5. 治理规范

### 5.1 日志分级规则（目标态）

| 级别 | 什么进 | 什么不进 | 一次性/重复判定 |
|---|---|---|---|
| error | 用户可见故障、功能不可用、数据风险（DB 打不开、恢复失败、迁移失败、webview 创建失败） | 已降级/已重试的成功路径 | **必现 error = 根因 bug 信号**：必须修根因，禁止静默、禁止 allowlist 掩盖；同进程内同原因可首条 + `repeat=N` |
| warn | 非预期异常、降级/兼容回退、数据跳过（坏数据逐条、覆盖项被拒、未知字面量） | 预期内成功路径、设计内分支（StrictMode 双跑、无 runtime 的 IPC 装配） | 跨启动必现 warn = 噪音（本次三案全部命中此判据）；同一数据面（坏行/坏配置）只 warn 首次或按哈希有变化才告警 |
| info | 关键一次性信息（setup 完成、版本、命令数）——每启动 ≤1~2 条 | 成功提示（迁移完成、快照已保存、恢复完成、DB 已打开、PTY 已建、监听器已注册） | 一次性信息可跨启动重复（有 info 价值）；成功提示一律 debug |
| debug/trace | 成功路径、心跳、跳过路径、perf 标记 | — | 允许重复，但语义应中性（"跳过"表述改"IPC 上下文未装配"）；三行同类合并一行 |

判定口诀：**成功静默、失败出声、必现即噪音、error 必现即 bug**。

### 5.2 审计脚本规格

见 §3.2（`scripts/check-boot-noise.mjs`：输入 `--logs/--allowlist/--strict`，输出必现行分类表，红线 = 必现 warn/error；CI 接 Windows report-only job；`--update` 显式登记基线，对齐 `check-swallowed-errors.mjs` 基线机制）。

### 5.3 一次性初始化点模式清单（"完成静默、失败才出声"）

| # | 初始化点 | 现状 | 改造建议 | 状态 |
|---|---|---|---|---|
| I1 | 旧明文 profile 迁移 `migrateLegacyProfiles.ts` | 死键剥离 + 幂等标记 + 二次启动静默回归测试 | 已是标杆模式（幂等标记 + 无残留才置位 + 成功零日志） | ✅ 已修（工作区） |
| I2 | 会话 DB 打开 + v3→v4 迁移 `main.rs:225-254` / `migrate.rs:148-201` | 缺表补建（`runs`/`pending_inputs`）+ 回归测试 `migrations.rs:704-735`；成功后 `会话数据库已打开` INFO 保留 | 根因修复提交后：成功行降 debug（R2）；ERROR 行保留 | 🔧 已修未提交 |
| I3 | 快照/恢复 `core_run_commands.rs:1880-1955` | 成功 2 行 INFO / 失败 2 行 error | 成功降 debug；error 保留（已是"失败才出声"） | 待办 |
| I4 | 迁移备份失败 `migrate.rs:75-90` | 空路径已排除；`eprintln!` 机制偏离 | 改 `tracing::warn!`（R4） | 待办（半修） |
| I5 | 引擎 tokio 相关装配跳过 `engine.rs:839/877/1291` | 3 条 DEBUG | 合并 1 条 trace，语义中性化（R5） | 待办 |
| I6 | catalog 覆盖项校验 `catalog.rs:516-532` | 逐项 warn | 全通过静默；有拒绝才汇总 1 条（拒绝数 + 首因）；按覆盖配置哈希去重（R6） | 待办 |
| I7 | 压缩块状态字面量降级 `blocks.rs:43-55` | 逐行 warn | 进程内首次 warn 后静默（R6） | 待办 |
| I8 | MCP 插件（dev 工具）`dev_mcp.rs:58-71` | 启动 12 行 + 每连接 3 行 INFO；失败用 INFO | 上游提级失败行；连接生命周期行在插件侧降 debug；启动块保留（开发工具心智锚点）；必要时 tracing EnvFilter 按 target 过滤（当前仅全局级别，`main.rs:211-222` 无 target 级能力） | 待办（外部依赖） |
| I9 | 前端 MCP 桥注册 `main.tsx:115` / `dev/mcpBridge.ts:95` | 2 条 info 每启动 | 合并为 1 条 debug | 待办 |
| I10 | 前端 perf 标记 `bootstrap-orchestrator/core/full` | 3 条 debug 每启动 | 合并为 1 条 debug（首屏总耗时） | 待办 |
| I11 | PTY 会话 `pty/session.rs:366` | created/killed 各 1 条 INFO | 降 debug；失败已有 warn（session.rs:226-255）保留 | 待办 |
| I12 | 前端裸 console.warn 面（35 处） | 绕过 logger | 按 §2.2 F4 迁移至 `logger.warn`（附带 K-05 脱敏），敏感面优先（userFacingErrors/streamDiag） | 待办 |

### 5.4 落地顺序建议

1. **提交 I2 根因修复**（DB 缺表迁移）——消除 21/25 必现 ERROR（最大噪音 + 数据风险）；
2. **降级 R2 成功 INFO → debug**（快照/恢复/DB 打开/setup/pty）——每启动 -4~5 行；
3. **落地 `check-boot-noise.mjs`** + 初始 allowlist，把 06/07/08 噪音行清单固化为断言；
4. I4/I5/R6 机制修正（eprintln→tracing、跳过行合并、重复 warn 去重）；
5. 前端 F4 迁移 + F1 dedupe 面（repeat 计数）——本轮 MCP 快照已证明前端 warn 无法审计是治理盲区。

---

## 附：不确定处标注

- 前端 warn 计数（warn=3/7/8）中 provider-migration 之外的具体行内容无法还原（前端日志不落盘，仅 MCP 缓冲预览可见）——待 `--mcp-snapshot` 采集后补全（§1.3 注记）。
- 08/08 09:51/09:53 两次启动无 engine debug 三连行（11:44 起出现）——推断当天中途代码更新所致，非机制差异。
- `check-swallowed-errors.mjs` 头部注释存在 GBK 编码显示乱码（终端展示问题），不影响功能判断。
