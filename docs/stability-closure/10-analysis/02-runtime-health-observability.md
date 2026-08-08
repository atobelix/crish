# 运行时健康探测与可观测性：现状盘点与改进面（02）

> 分析子 Agent 产出（只读，未改任何代码）。日期：2026-08-09。
> 触发背景：tauri-plugin-mcp 的 socket（TCP 4000）日志声称"Socket server started successfully"但端口实际未监听——启动日志与真实运行状态脱节。
> 全部结论基于实读源码与 8/6-8/8 三天 workbench 日志；不确定处已标注"（未证实）"。

---

## 0. 结论先行

1. **"启动成功"是一张一次性快照，没有"持续健康"通道**。`core_get_status` 的字段（dbReady / engineReady 等）全部在 setup 期判定一次，运行期不再更新；唯一的运行期数据源是 `backgroundTasks`（T-AB-19）与 60s 快照循环，两者都不是健康探针。
2. **MCP 4000 事件的机制根因已定位（插件侧）**：`start()` 中 `TcpListener::bind` 是同步执行、失败会返回 Err（不会打"started successfully"），但 **listener task 的 `JoinHandle` 存入 struct 后从不被 poll**（socket_server.rs:305、341-344）——accept 循环中途 panic/退出时：端口关闭、无日志、无状态、无恢复，进程照常活着。这就是"启动日志成功 ≠ 持续监听"的架构断层。应用侧对此没有任何自检。
3. **发现三个连带的可观测性死角（本次分析实证）**：
   - `engine.rs:831-881` 的 TimerRegistry 启动恢复 / Watchdog 装配 / SchedulerRegistry 启动恢复三个装配点在 GUI 主线程（无 tokio runtime 上下文）被跳过，**只打 DEBUG**，生产不可见（8/8 日志 13 次启动 × 3 行实证）；
   - `cleanup_logs`（7 天 / 50MB / crash 保留 3 个的保留策略）**在壳层从未被调用**——保留策略只存在于库层与测试，运行时日志目录不受控；
   - 前端 `StatusDiagnosticsPanel` 组件**未挂载到任何页面**（只有自身与测试引用）——诊断面板是孤儿。
4. **日志噪音有实证**：每次启动固定重复 15-18 行（4 行 core + 3 行 engine DEBUG + 11 行 MCP）；8/7 一天 8 次启动连续"DB 打开失败降级"全打 ERROR，无去重、无升级、无告警出口。

---

## ① 现有可观测面盘点

### 1.1 StatusDiagnostics（壳层内存诊断）

| 项 | 现状 | 位置 |
|---|---|---|
| 结构 | 环形 20 条 `SubsystemDiagnostic{subsystem, ready, message, updatedAt}` + `lastError` 单槽（AtomicSlot） | `apps/agent-workbench/src-tauri/src/status_diagnostics.rs:22-151` |
| 写入点 | setup 期：telemetry(297)、db 打开失败(246)、workspace 成败(310/319)；运行期：`finalize_failed` 与事件桥 runtime-error 处写 lastError（注释声明，未在本文件内） | `main.rs:246/297/310/319` |
| 读取 | 仅 `core_get_status` 经 `entries()` / `last_error()` 消费 | `core_query_commands.rs:303-317` |
| 容量 | 20 条环形，新在前，超出丢弃最旧 | `status_diagnostics.rs:110-124` |

**发现（wire 层信息丢失）**：`SubsystemDiagnostic` 的 `ready: bool` 在映射为 `DiagnosticEntry{ts, level, message}` 时**被丢弃**——`level` 字段由子系统名承载、`message` 承载说明（core_query_commands.rs:303-311）。前端只能看到"某子系统有过一条记录"，无法得知它是 ready 还是异常；`ready` 的语义需要靠 message 文案猜测。

### 1.2 core_get_status 返回字段（一次快照）

| 字段 | 数据源 | 判定时机 | 运行期是否刷新 |
|---|---|---|---|
| initialized / engineReady | `CoreRunState` 静态布尔 | setup 完成时 `mark_initialized`（main.rs:448） | 否 |
| dbReady | `SharedDb.ready` + `LocalDb.get_failure()`（session_commands.rs:55-58） | DB 打开时一次（main.rs:236-253） | 否（failure latch 由操作失败置位，conex-db/src/lib.rs:46/100-105；非探针） |
| searchIndexReady | 索引文件数 > 0 推断（core_query_commands.rs:285-289） | 每次查询实时 | 是（实时算） |
| compactionReady | `SharedCompactionState`（main.rs:338 直接置 true） | setup 一次 | 否 |
| providerStatus | `config::effective_*`（core_query_commands.rs:231-239） | 每次查询实时 | 是 |
| logLevel / logDir | telemetry 当前级别 / app_dir 推导（245-250） | 每次查询实时 | 是（静态值） |
| diagnostics / lastError | StatusDiagnostics | 实时 | 是 |
| restore / snapshot | CoreRunState（PE-08） | 实时 | 是（restore 异步执行，见 main.rs:379-384） |
| backgroundTasks | 后台任务注册表汇总（T-AB-19） | 实时 | 是（`background_tasks_summary().await`） |

**Gatekeeper 预留**：`_gatekeeper: State<SharedGatekeeper>` 是"就绪诊断预留接入点（当前仅占位，未消费）"（core_query_commands.rs:272 注释）。

### 1.3 前端消费面

| 消费者 | 方式 | 说明 |
|---|---|---|
| `tauriTransport.waitUntilConnected` | 启动期轮询 `core_get_status`（engineReady/dbReady 任一 true 即 connected） | 仅启动期，6s 超时；运行期无心跳（tauriTransport.ts:221-267） |
| `StatusDiagnosticsPanel.tsx` | 5s 轮询 `fetchEngineStatus`，四区面板 | **未挂载**：全仓库只有自身与测试引用（rg 实证）；dbReady=false 时理论上显示"异常"徽标，但用户实际看不到 |
| `ChatStatusRibbons` / `SetupHintBanner` | 软提示（密钥/模型/同步三分支） | 引导面，非健康面（ChatStatusRibbons.tsx:43-48） |
| `engineStatus.ts` `fetchEngineLiveStatus` | 解析 `res.activeRuns` / `pendingApprovals` | **Rust 侧 `CoreStatus` 无 activeRuns 字段**（core_query_commands.rs:150-181）——该字段永远为空数组，daemon 协议遗留（未证实是否影响 H2 运行条，标注） |
| `useBackgroundTaskPolling` | 后台任务轮询 | 独立于状态面（ChatStatusRibbons.tsx:38-41） |

### 1.4 日志 / 崩溃文件机制

| 机制 | 细节 | 位置 |
|---|---|---|
| 双通道 | stderr compact + 文件层同格式（`writer.and(std::io::stderr)`） | `crates/conex-telemetry/src/subscriber.rs:88-93` |
| 文件轮转 | 按日 `workbench.YYYYMMDD.log` + 单文件 10MB 分片 `.{n}.log` + 单条 8KB 截断 | `crates/conex-telemetry/src/file.rs:44-179, 109-129` |
| 保留策略 | 7 天 / 目录总量 50MB / crash 保留 3 个（`cleanup_logs`） | `file.rs:242-303`；**壳层无调用方（rg 实证），运行时未执行** |
| 崩溃文件 | panic 时落 `crash-YYYYMMDD-HHMMSS-<thread>.log`（链式转发前 hook） | `panic_hook.rs:48-116`；main.rs:270 安装 |
| 降级 | 文件打开失败 → `FileSink::Null` 静默 + `eprintln` 一次 | `file.rs:169-176` |

### 1.5 运行期周期任务（全部无健康输出面）

| 任务 | 周期 | 位置 |
|---|---|---|
| 快照循环 | 60s（仅活动 run 存在时保存） | `core_run_commands.rs:2015-2020` |
| timer/scheduler 缓冲 drain | 500ms | `main.rs:434-440` |
| 后台任务归档 | 60s | `background.rs:867` |
| Watchdog 兜底 | 60s/会话 | `watchdog.rs:307-319`；**引擎级装配被跳过，见 ②#5** |

---

## ② 健康探测缺口清单

| # | 组件 | 现状 | 失效模式 | 发现延迟 | 建议 |
|---|---|---|---|---|---|
| 1 | **MCP socket（TCP 4000）** | 注册条件 env（dev_mcp.rs:40-42）；插件 `start()` 同步 bind，成功才打 started（插件 socket_server.rs:91-128、283-296）；**listener task JoinHandle 从不 poll**（305、341-344） | listener 任务 panic/异常退出 → 端口关闭，无日志无状态；进程活着 | **无限**（直到客户端连接失败） | 端口探测自检（启用时）：每 30s `TcpStream::connect(127.0.0.1:4000)`，失败记 diagnostics（见 ⑤#3） |
| 2 | **DB（sessions.db）** | 打开时一次判定 + 操作级 failure latch（session_commands.rs:55-58；conex-db lib.rs:46/100-105） | 运行期 DB 文件被删/锁死/磁盘满/连接损坏 → db_ready 仍 true（无读探针） | 无限 | 周期读探针 `SELECT 1`（见 ⑤#2） |
| 3 | **摘要协调器** | 注册表可查会话数（summary_coordinator.rs:197-260）+ `last_outcome`（96-101）+ 全局并发计数；**无存活探针** | 退避重试任务挂死/卡住 → 摘要永不落库，静默 | 无限 | 周期检查活跃会话数与 last_outcome 新鲜度（见 ⑤#4） |
| 4 | **引擎事件循环 / run 驱动** | `engine_ready` 启动一次；drive_run_loop 无超时（core_run_commands.rs:2360-2428）；`LastWakeupTracker` 有 mark_wakeup 接线（2436 附近） | produce 永不返回 / 事件循环挂死 → run 永远 running，无超时无告警 | 无限 | 用 last_wakeup_ms 新鲜度做"疑似挂死"判定（见 ⑤#5） |
| 5 | **TimerRegistry 恢复 / Watchdog / SchedulerRegistry 恢复装配** | `tokio::runtime::Handle::try_current()` 守卫，GUI 主线程无上下文 → **全部跳过**，仅 DEBUG（engine.rs:831-843、874-881、1293） | 装配脱节不可见；引擎级 watchdog 实际从未运行（会话级在 idle_resume 路径，见 core_run_commands.rs:2309）；定时器重启恢复从未执行 | 无限（DEBUG 日志生产不可见） | try_current 失败分支升级 warn + 记 diagnostics（见 ⑤#7） |
| 6 | **崩溃 / 卡死** | panic hook 有（crash-*.log + 链式转发）；**卡死（无 panic 无响应）无任何检测** | 无响应挂死 → 用户端表现为"没反应"，无日志无文件 | 无限（等用户） | 崩溃文件扫描 + 前端心跳失联横幅（见 ⑤#6/#8） |
| 7 | **PTY 会话** | 注册表存在，仅 Exit 钩子 kill_all（pty/mod.rs:94-96）；**无列表/健康命令面**；退出靠 pty-exit 事件 | 会话挂死/幽灵残留 → 不可查询 | 无限 | 追加只读列表命令（低优先） |
| 8 | **provider 连接** | 无连接级监控；仅请求失败时经 lastError 落痕 | provider 长期不可达仅在使用时暴露 | 使用期 | 接受现状（请求驱动），可选：健康循环里加一次轻量 ping（低优先） |
| 9 | **前端心跳** | `waitUntilConnected` 仅启动期轮询（tauriTransport.ts:221-267）；运行期无 | Rust 挂死时前端无感知 | 无限 | 前端 10s 心跳轮询 + 失联横幅（见 ⑤#8） |
| 10 | **日志文件层健康** | 打开失败 → Null 目标静默（file.rs:169-176）；`core_get_status` 不暴露降级状态 | C 盘满/句柄占用 → 日志静默丢失，无状态面 | 无限 | init 返回值透传 + 状态面新增 fileLayerOk（见 ⑤#9） |

**MCP 场景 30s 内发现的可行路径**（对任务书问题的直接回答）：当前机制下**无法在 30s 内发现**——插件把 listener 句柄私有，应用侧唯一可行手段是端口探测（connect 探活，30s 周期即可达标）。若接受小改动，可在 `register_if_enabled`（dev_mcp.rs:58-71）注册后 spawn 一个自检任务，利用 `TcpStream::connect` 判定（不依赖插件内部状态）。

---

## ③ 日志体系审计结论

### 3.1 机制现状（已验证）
- 双通道成立：文件层 + stderr 同格式（subscriber.rs:88-93）；文件层失败降级 Null 不阻断启动（file.rs:169-176，PE-04 R3 符合）。
- 轮转成立：按日 + 10MB 分片 + 8KB 单条截断（file.rs:44-179），有单测覆盖（file.rs:478-559）。
- **保留策略未接线（本次实证）**：`cleanup_logs` 在 `apps/agent-workbench/src-tauri` 全目录无调用方（rg 实证）。库层默认值（7 天/50MB/crash 3）与单测都存在（file.rs:205-225、562-645），但运行时从未执行——日志目录与 crash 文件只增不减。当前规模小（8/8 单日 57KB），长期不受控。

### 3.2 重复噪音实证（8/6-8/8 三天）

| 日期 | 启动次数（按 setup 完成行计数） | 每次启动固定重复行 | 例证 |
|---|---|---|---|
| 8/6 | 2 | 4 行（DB 失败 + setup + 快照 + 恢复） | workbench.20260806.log 全 8 行 |
| 8/7 | 8 | 4 行 × 8 = 32 行，**完全相同** | 8 次"打开 sessions.db 失败降级"全 ERROR（15:32-15:50） |
| 8/8 | 13 | 4 行 core + 3 行 engine DEBUG（TimerRegistry/Watchdog/SchedulerRegistry 跳过）+ 11 行 MCP 启动序列 = 18 行/次 | 11:44/15:00/15:01/15:22 四次完整 MCP 序列 |

**噪音分级结论**：
- `restore` 的"快照已保存 generation=1 + 重启恢复完成"每次启动必打 2 行 INFO——空库场景是固定噪音，可降 debug。
- engine 的"启动恢复跳过"三连是**装配脱节信号**，却被 DEBUG 级别掩盖——应升级并归入 diagnostics（见 ⑤#7）。
- MCP 每次启动 11 行 INFO（will use / token generated / will start / Setting up / Initializing / Starting / token written / running flag / Spawning / started successfully / setup complete）——插件固定输出，应用侧可降级或忽略。
- MCP 命令交互：**每命令一个 TCP 连接**（Accepted → Handling → ... → Disconnected），8/8 单日 20 条 MCP 行含多条 6-10 行/命令的序列（15:23-15:50）。

### 3.3 告警升级缺失
- 8/6-8/7 连续两天**每次启动**都"DB 打开失败降级内存库"（`migrate_v4 failed: no such table: runs`），每次都是 ERROR、无去重、无升级、无状态面反映（dbReady=false 仅在孤儿面板可见）。同类根因的重复错误应有"首次 ERROR + 后续 once"或按日去重策略。

### 3.4 日志丢失场景
1. **C 盘满 / 目录不可写**：打开失败 → Null 目标，仅 `eprintln` 一次（file.rs:169-176）——stderr 在 GUI 模式未必可见，且无任何状态面。
2. **Windows 句柄占用**：日志文件被外部程序（编辑器/杀软）锁定时 append 失败 → 同样 Null 降级。
3. **崩溃文件写失败静默**（panic_hook.rs:112-115）——符合"崩溃处理路径不二次 panic"原则，可接受。

### 3.5 敏感面（8/8 实证）
- MCP DEBUG 级别把 `execute_js` 的完整 response 落文件日志（8/8 15:29:43 可见 localStorage 摘要、15:46:41 provider key 状态）。debug 构建 + `CRISH_MCP_SOCKET=1` 时，`workbench.*.log` 成为含应用内部数据的审计面——属于开发环境可接受但需知悉的面（**未证实**是否含明文密钥；8/8 样例为脱敏摘要）。

---

## ④ 前端展示现状与建议

### 4.1 现状
- **设置页四区诊断面板（StatusDiagnosticsPanel）**：功能完整（子系统就绪/日志配置/最近错误/最近诊断，5s 轮询，错误横幅），**但未挂载**——全仓库除自身与测试无引用。即"能展示的东西用户看不到"。
- **对话页软提示**（ChatStatusRibbons/SetupHintBanner）：仅密钥/模型/同步三分支引导，非运行健康。
- **启动连接态**：waitUntilConnected 轮询 engineReady/dbReady（tauriTransport.ts:46-56、221-267），失败给 'failed' 态——仅启动期。
- **无**：运行期健康黄条、崩溃提示、心跳失联横幅、后台任务/摘要/PTY 的运行健康视图。

### 4.2 建议形态（三层）
1. **状态栏/头部一行**：引擎点（绿/黄/红）+ dbReady 徽标 + 最近错误角标——常驻可见，5-10s 轮询。数据源：core_get_status 现有字段即可。
2. **横幅（Banner）**：失联/降级/崩溃三类事件触发的醒目提示（lastError 非空、dbReady=false、diagnostics 里出现 health 自检失败、心跳超时）。
3. **诊断面板挂载**：把 StatusDiagnosticsPanel 挂进设置页（找一个 settings tab 入口），并补上"ready 布尔"wire 字段（见 ①1.1 的信息丢失——建议 Rust 侧 DiagnosticEntry 增加 ready 字段或保留子系统行语义）。

---

## ⑤ 探测面设计（自检项清单 + 实现锚点）

统一口径：**一个健康循环（health loop）+ 若干独立探针**。健康循环由 `tauri::async_runtime::spawn` 周期驱动，探针结果统一写入 `StatusDiagnostics.record(subsystem, ready, message)`——复用现有环形缓冲与 `core_get_status.diagnostics` 输出面，前端无需新通道（建议 wire 层补 `ready` 字段，见 ④）。

| # | 自检项 | 周期 | 触发点 | 判定 | 输出面 | 实现锚点（建议） |
|---|---|---|---|---|---|---|
| H1 | **健康心跳循环** | 5s | setup 完成后常驻 | 每 tick 写 `record("health", true, uptime)`；某探针失败 → false + 原因 | diagnostics + 前端横幅 | main.rs setup：`spawn_snapshot_loop`（core_run_commands.rs:2015）旁新增 spawn |
| H2 | **DB 读探针** | 30s | 健康循环内 | `spawn_blocking(SELECT 1)` 成功 → ready=true；失败 → `record("db", false, err)` + `set_last_error` | diagnostics/lastError | `session_commands.rs` SharedDb 新增 `fn probe(&self) -> Result<(), String>`（46-75 旁）；main.rs 周期调用 |
| H3 | **MCP 端口探测**（仅 CRISH_MCP_SOCKET=1） | 30s | 健康循环内条件执行 | `TcpStream::connect("127.0.0.1:4000")` 成功 → ready；失败 → `record("mcp", false)` | diagnostics | `dev_mcp.rs:58-71` 旁新增 `pub(crate) fn probe_socket() -> bool`（只读，不改注册逻辑）；main.rs 按 `mcp_socket_enabled()` 条件接线 |
| H4 | **摘要协调器存活** | 60s | 健康循环内 | registry 会话数 + 每会话 `last_outcome` 新鲜度（超过阈值无结果且任务句柄 `is_finished()==false` 且未触发 → 疑似卡死） | diagnostics | `summary_coordinator.rs:197-260`（registry）暴露 `snapshot() -> Vec<{session, alive, last_outcome_ms}>`（96-101 last_outcome 已有）；壳侧 `core_run_commands.rs:1674-1681` 取注册表 |
| H5 | **最近 run / 事件循环存活** | 60s | 健康循环内 | 存在 running 状态 run 且 `LastWakeupTracker.last_wakeup_ms()` 距今 > N（如 10min）→ 疑似挂死 `record("run", false)` | diagnostics | `watchdog.rs:82-107` last_wakeup 已有；查询侧 `core_query_commands.rs:603` query_runs；阈值对齐 watchdog 的 `DEFAULT_WATCHDOG_IDLE_MINUTES`（watchdog.rs:41） |
| H6 | **崩溃文件扫描** | 启动 + 60s | 启动 setup 与健康循环 | 扫描 logs 目录 `crash-*.log`，出现新文件（比上次扫描多）→ `record("crash", false, path)` | diagnostics + 前端横幅 | main.rs setup（cleanup 同目录处）；`host_paths::app_dir()`（host_paths.rs:6） |
| H7 | **装配脱节告警** | 启动 | `try_current()` 失败分支 | 现 DEBUG 改为 `tracing::warn!` + `record("engine", false, "Watchdog/TimerRegistry/SchedulerRegistry 装配跳过")` | 日志升级 + diagnostics | `engine.rs:838-842、876-880、1292-1295` |
| H8 | **前端心跳** | 10s（前端） | ChatStatusRibbons 挂载后 | `core_get_status` 连续 N 次失败/超时 → "核心失联"横幅（现有 fetchEngineStatus 错误面已具备，StatusDiagnosticsPanel.tsx:119-144 同款） | 前端横幅 | `ChatStatusRibbons` 或新建 hook（tauriTransport.ts 轮询面扩展） |
| H9 | **日志层健康指示** | 启动 | `init_default` 返回值 | 返回 false（文件层降级）→ `record("telemetry", false, "文件层不可用，仅 stderr")`；顺带在 setup 期调用一次 `cleanup_logs` 补上保留策略（见 ③3.1 缺口） | diagnostics | `main.rs:262-268`（init 返回值现被丢弃）；`file.rs:242` cleanup_logs 接线 |

### 实施顺序建议
- **P0（本次稳定性闭环）**：H1 心跳循环 + H2 DB 探针 + H3 MCP 端口探测 + H7 装配脱节告警 + H9 保留策略接线（cleanup_logs 调用 + 日志层降级入诊断）——五项合计改动面小（均为主壳层新增 spawn/记录，不动引擎），覆盖任务书场景（MCP 30s 内发现）与两天的 DB 降级实证。
- **P1**：H4 摘要协调器存活 + H5 run/事件循环挂死判定 + H6 崩溃文件扫描 + H8 前端心跳横幅。
- **P2**：wire 层补 `ready` 布尔（core_query_commands.rs DiagnosticEntry）、StatusDiagnosticsPanel 挂载、PTY 只读列表命令、MCP 插件上游 PR（listener task 退出上报/重启）。

### 已知不确定项（诚实标注）
- `engineStatus.ts` 解析 `activeRuns` 但 Rust 侧无此字段——未核实前端运行条实际是否依赖该路径（daemon 协议遗留，标注待前端侧确认）。
- MCP"日志成功但端口未监听"的**具体触发实例**未能在 8/6-8/8 日志复现（三日日志均为完整成功序列）；机制缺口（JoinHandle 不 poll + 无端口自检）是源码实证，触发路径（listener 任务异常退出）为合理推断。
- 引擎级 Watchdog 被跳过对功能的影响：引擎级为"空会话占位"（engine.rs:862-873），会话级 watchdog 在 idle_resume 路径 spawn（core_run_commands.rs:2309 起）——会话级是否同样受 try_current 影响未逐行核实。
