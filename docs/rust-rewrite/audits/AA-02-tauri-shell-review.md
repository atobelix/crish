# AA-02 Tauri 壳深度审查报告

- 审查对象：`apps/agent-workbench/src-tauri`（只读审查，未改任何代码）
- 审查日期：2026-08-01
- 审查范围：main.rs / engine.rs / core_run_commands.rs / core_query_commands.rs / core_event_bridge.rs / core_commands.rs / core_error.rs / config/ / session_commands.rs / process.rs / pty/ / markdown_commands.rs / power.rs / host_paths.rs / fs_commands/ / host_openers/ / perf/ / commands.rs / error_bridge.rs / buffer.rs / tauri.conf.json / capabilities/
- 前端调用面依据：`apps/crish-desktop/src`（排除 dist / node_modules / 测试文件）
- 相关文档：docs/rust-rewrite/03-frontend-contract.md、21-phase-c-migration-log.md

## 一、总览

| 模块/主题 | 问题编号 | 严重度分布 |
|---|---|---|
| main.rs 状态注入与 tracing | W-1、W-2 | 重要×2 |
| 路径体系（app_dir / config_dir 打包失效） | W-3、W-4 | 重要×2 |
| 前端契约缺口（commandMap 映射不存在命令） | W-5 | 重要×1 |
| 状态诚实性（core_get_status 假字段） | W-6 | 重要×1 |
| 死面命令与重复实现（20 死面 + 双套 core_*/perf_*） | S-1、S-2、S-19、S-20 | 建议×4 |
| daemon 残留（活动 run 注册表死代码 / error_bridge 迁移残留 / 命名与 sentToDaemon） | S-3、S-5、S-6 | 建议×3 |
| 引擎与事件桥（reqwest 复用 / 丢帧无观测） | S-7、S-8 | 建议×2 |
| 命令质量（同步阻塞 / 参数校验 / stub / HTTP 面） | S-4、S-9、S-14、S-15、S-16 | 建议×5 |
| run 生命周期半成品（control no-op / 审批未接线 / 事件与会话共库） | S-10、S-11、S-18 | 建议×3 |
| pty 与 host_openers（cwd 不一致 / PS 脚本拼接） | S-12、S-13 | 建议×2 |
| 会话双数据源（SQLite 消息 vs 事件流） | S-21 | 建议×1 |
| 能力声明（capabilities mcp:default 与插件注册不一致） | S-17 | 建议×1 |
| **合计** | **27** | **阻塞 0 / 重要 6 / 建议 21** |

结论：无阻塞级（编译/崩溃）问题；核心 run 生命周期（B6）实现与测试质量高。主要风险集中在**打包环境路径失效（W-3/W-4）**、**可观测性静默（W-2）**、**daemon 概念残留导致的命令面膨胀（S-1/S-2/S-6）**三方面。
## 二、问题清单

| 编号 | 文件:行号 | 严重度 | 描述 | 建议 |
|---|---|---|---|---|
| W-1 | main.rs:136-201；core_commands.rs:135-144 | 重要 | `core_check_command` 依赖 `State<'_, SharedGatekeeper>`，但 setup 只 manage 了 SharedSearchState / SharedDb / CoreRunState，**SharedGatekeeper 从未注入**。命令恒失败（Tauri「state not managed」）。前端 rustCore.ts:101 的 checkCommand 静默兜底为 `'Allowed'`，真实行为与兜底掩盖了故障。 | 在 setup 中 `app.manage(SharedGatekeeper::new())`；或删除该命令，改为复用 process.rs 的 gatekeeper 检查路径。 |
| W-2 | main.rs 全文件（无任何 tracing subscriber 初始化） | 重要 | 壳内 20+ 处 `tracing::info!/warn!/debug!/error!`（DB 降级、引擎未就绪、PTY 生命周期、run 注册等），但 **conex_telemetry::init_default / install_panic_hook 从未被调用**（仅 error_bridge.rs:105 用了 catch_unwind）。所有日志静默丢弃，启动失败路径（main.rs:151-176 DB 降级）完全不可观测；error_bridge.rs:16-18 注释声称的「全局 install_panic_hook」实际不存在，panic 无记录。 | main 入口调用 `conex_telemetry::init_default(...)` + `install_panic_hook()`；确认日志文件/控制台输出目标。 |
| W-3 | host_paths.rs:6-24 | 重要 | `app_dir()` 用 `env!("CARGO_MANIFEST_DIR")`（**编译机路径**）探测 `parent/package.json`。dev 环境成立；**打包后在用户机器上该路径不存在**，回落 current_dir 向上查找（安装目录无 apps/agent-workbench/package.json）→ 大概率 Err。后果链：main.rs:145-177 sessions.db 打开失败→降级内存 DB 且 not-ready；engine.rs:189-193 工具注册 workspace_root 退化为空路径；fs_commands 默认工作区根失效。 | 打包环境改用 `tauri::path::BaseDirectory::AppData` / `app.path().app_data_dir()`（setup 中提前解析并缓存）；dev 用 CARGO_MANIFEST_DIR 仅作 fallback。 |
| W-4 | config/persistence.rs:35-47 | 重要 | `config_dir()` 硬编码 `%APPDATA%\Crish\AgentWorkbench`（仅 CRISH_WORKBENCH_CONFIG_DIR 可覆盖），与 W-3 的 app_dir 路径体系**分裂**：provider-config.json / *.dpapi 写到 APPDATA，sessions.db 写到源码目录/内存。打包后配置可持久、DB 不可持久，状态不一致。 | 统一路径真源：配置与 DB 同根（app_data_dir），env 覆盖仅用于测试。 |
| W-5 | crish-desktop/src/api/transport/commandMap.ts:31-39 | 重要 | 9 个 WS type 映射到 **Rust 侧不存在**的命令：`workbench_git_status` / `workbench_git_diff`（git_commands.rs 不存在）、`workbench_list_mcp_servers` / `workbench_start_mcp_server` / `workbench_stop_mcp_server`、`workbench_preview_conversation_rewind` / `workbench_apply_conversation_rewind`、`workbench_send_to_subagent` / `workbench_get_subagent_status`。调用方（gitApi.ts:460/521、mcpApi.ts:307/434/489、conversationRewindApi.ts:43/76、subagentApi.ts:35/59、clientApi.ts:888/902/912）全部依赖 missing 兜底，功能实际未接通。 | 与 21-phase-c-migration-log.md 的 ③ 类清单核对：要么 Rust 回补实现，要么从映射表删除并改走本机 fallback（gitApi 已具备）。 |
| W-6 | core_query_commands.rs:330-342 | 重要 | `core_get_status` 的 `compaction_ready` 硬编码 true；`search_index_ready` 以「文件数>0」推断；`initialized` 恒 true（setup 走到即成功）。状态字段不诚实，前端 tauriTransport.isCoreReady 用 engineReady/dbReady 任一 true 判就绪，掩盖核心未就绪状态。 | compaction_ready 反映 CompactionEngine 真实初始化；initialized 在 setup 失败时置 false；补充 EngineHandle 未就绪时 engineReady 的语义文档。 |
| S-1 | main.rs:41-47、54-66；config/mod.rs:68-144；power.rs:42-44；process.rs:50 | 建议 | 20 个死面命令（前端 src 零引用）：`save_api_config`、`get_api_config`、`workbench_profile_secret_set/get/has/clear`、`workbench_performance_snapshot`、`workbench_set_keep_awake`、`perf_hash_compute`、`perf_base64_encode`、`perf_base64_decode`、`perf_encoding_detect`、`perf_encoding_decode`、`perf_diff_parse`、`perf_jsonl_read`、`perf_jsonl_write`、`perf_fs_read_chunk`、`perf_fs_file_info`、`perf_fs_watch_start`、`perf_fs_watch_stop`。 | 从 make_handlers! 移除；保留实现与测试（供后续/测试用），或删除并留 git 历史。 |
| S-2 | main.rs:54-66 vs 105-113；core_commands.rs:198-295 | 建议 | Stream E 的 `core_hash_compute` 等 9 命令与 `perf_*` 6 命令**同功能双注册**（core_* 包装 perf_* 实现，main.rs 两套都注册）。注释称「perf_* 别名保留兼容」，但前端已全部改用 core_*，perf_* 无调用方（除 perf_jsonl_append）。 | 保留 core_*，移除 perf_* 的注册与包装层（perf_* 实现可保留为内部函数，去掉 #[tauri::command]）。 |
| S-3 | process.rs:104-133 | 建议 | `register_active_run` / `unregister_active_run` **无任何调用方**（daemon 时代残留：run 由 sidecar 进程执行时记录 pid）。`workbench_performance_snapshot` 依赖的 active_runs 恒为空 → activeRuns/树内存统计恒为空。 | 删除死代码与命令，或接入 core_run_commands 的活动 run 注册表（run_id → pid 为进程内直调，pid 即自身，语义需重定义）。 |
| S-4 | commands.rs:5-28；commands.rs:25-28 | 建议 | `WorkbenchRunTaskRequest` 结构体从未被消费（daemon run-task 残留，进程内已改 core_run_task）；`workbench_apply_update` 为恒 `{ok:true}` stub，前端 updateStore.ts:62 调用，用户感知「更新成功」但实际无更新。 | 删除 WorkbenchRunTaskRequest；workbench_apply_update 接入真实 updater 或让前端在未配置时明确提示不可用。 |
| S-5 | error_bridge.rs:1-193 | 建议 | 整个模块 `#[allow(dead_code)]`，无调用方（CrishErrorPayload 迁移中间态残留）。`map_core_err` 的有损映射（InvalidInput→common.unsupported）若未来接入会丢失错误语义。 | 决定迁移终点：若采用 CoreError 协议则删除本模块；若切换 CrishErrorPayload 则替换所有命令错误类型。 |
| S-6 | config/provider.rs:372-383、409-499；resolution.rs:54-61 | 建议 | daemon 概念残留：`update_daemon_config` 命令名、`sentToDaemon` 恒 false 字段（注释已承认「C4.4 随 main.rs 清理再评估命令重命名」）、`daemon_api_key_source` / `ApiKeySource::daemon_value`（dead_code）。前端 engineConfig.ts 仍在调用。 | 重命名 `update_daemon_config` → `update_provider_config`（前端 commandMap 同步改）；删除 sentToDaemon / daemon_* API。 |
| S-7 | engine.rs:445 | 建议 | `SessionLoopProducer::produce` 每次 run `reqwest::Client::new()`——**连接池/TLS 会话不跨 run 复用**，多 run 场景每轮重建连接。 | EngineHandle 持有共享 `reqwest::Client`（Arc），HttpProviderCall 引用它。 |
| S-8 | engine.rs:77-81；core_event_bridge.rs:185-191 | 建议 | `BufferedRunEventBridge::emit` 丢弃 `enqueue_envelope` 返回的 `EmitReport`（emitted/buffered/dropped 全无观测）；`EventBridge.next_sequence` 路径 dead_code。**背压丢帧发生但不可见**，故障排查无数据。 | 将 EmitReport 汇入 tracing 计数（W-2 修复后生效）或暴露到 core_get_status。 |
| S-9 | fs_commands/mod.rs:18-41；perf/fs.rs:264-308；perf/jsonl.rs:192-220 | 建议 | 同步命令（非 async fn）在 Tauri IPC 线程执行：`list_directory` 无条目上限、`read_file_content` 最坏 1MB+5000 行、`perf_fs_read_chunk` mmap 大文件、`perf_jsonl_append` 带 `sync_all`（fsync 可能数百 ms）。高负载时阻塞其他命令的 IPC 响应。 | 改 `async fn` + `spawn_blocking`（对齐 session_commands/markdown_commands 模式）；list_directory 加分页/上限。 |
| S-10 | core_run_commands.rs:487-495 | 建议 | `core_run_control` 的 `continue` / `soft_inject` 分支为 no-op 返回 Ok（TODO(Phase C) 注释）。前端 runControlClient.ts 调用后无实际效果，UI 状态与引擎状态脱节。 | Phase C 接线前，对未实现 level 返回明确错误（如 CoreError::NotImplemented），避免假成功。 |
| S-11 | core_run_commands.rs:586-658 | 建议 | 审批半成品：`deny` 不恢复状态机（run 停在 AwaitingApproval），且 session-loop 审批门未接线（Phase C），当前 approve/deny 只落 approval-resolved 事件，无法实际驱动工具执行流。命令已对前端开放。 | Phase C 前在命令文档标注能力边界；或将 awaiting-approval 状态仅在审批门接线后暴露。 |
| S-12 | pty/session.rs:102-120 vs process.rs:510-526 | 建议 | `resolve_cwd`（PTY）与 `resolve_shell_cwd`（run_shell）行为不一致：PTY 对不存在的 cwd **静默返回原路径**（shell 可能启动失败），run_shell 报错。 | 统一：PTY 对不存在 cwd 报错或显式 fallback 工作区根。 |
| S-13 | host_openers/execute.rs:106-190 | 建议 | `open_with_shortcut` 用 PowerShell 字符串拼接（`-Command` + 单引号转义），注入面虽经 gatekeeper 检查，但 `Start-Process -ArgumentList @('...')` 对含空格/引号路径的兼容性脆弱，且 WScript Shell COM 调用不可测试。 | 改用 `Command::new("powershell")` + 结构化参数或 rust lnk 解析库（如 lnk-rs），避免脚本拼接。 |
| S-14 | commands.rs:32-85 | 建议 | `workbench_http_request` 无 URL 长度/body 大小限制；允许任意 http(s) 目标（含内网 SSRF 面，功能需要但无白名单/确认）。 | 加 URL 长度上限（如 4KB）、body 上限（如 1MB）、可选目标域白名单。 |
| S-15 | 各命令参数校验不统一 | 建议 | `core_approve_tool`/`core_deny_tool` 的 run_id 未 trim/校验（NotFound 兜底可接受但语义含糊）；`save_api_config` 的 api_key/base_url/model 无长度上限；正例：`profile_secret_path` 的 sanitize（persistence.rs:87-104，ASCII 白名单+128 长度）与 session_commands 的 require_session_id。 | 建立统一校验 helper（trim + 长度上限 + 显式 InvalidInput），覆盖 run_id/session_id/api_key/url。 |
| S-16 | core_query_commands.rs:346-385 | 建议 | `core_get_run_snapshot` / `core_read_run_events` / `core_read_session_events` 对空 run_id/session_id 未显式校验（空串→NotFound，报错文案歧义）。 | 显式 InvalidInput（对齐 run_task_impl:428-430）。 |
| S-17 | capabilities/default.json:25 | 建议 | `mcp:default` 权限在 **release** 构建中引用——tauri-plugin-mcp 仅 debug 注册（main.rs:126-134），需验证 release 下 capability 校验是否通过/权限是否空转。 | release 下移除 mcp 权限或确认插件权限在未注册时被安全忽略。 |
| S-18 | main.rs:178-195 | 建议 | sessions.db（SharedDb）与 W1 事件库（LocalDbStore）**共用同一 LocalDb 连接**：SQLite 单连接 Mutex 串行化，会话读写与 run 事件落库互斥，高频场景（事件流 + 会话保存）成瓶颈。 | 事件库与会话库分文件/分连接；或确认 conex_db 连接池支持。 |
| S-19 | perf/encoding.rs:118-125 | 建议 | `perf_encoding_encode` 定义了 #[tauri::command] 但**未在 main.rs 注册**（与 core_text_encode 功能重叠，仅 Rust 内部可用）。 | 删除或注册；与 S-2 一并处理。 |
| S-20 | core_commands.rs:157-172 | 建议 | 旧 `core_get_status`（dead_code 保留，注释说明与 core_query_commands 版本冲突）——重复实现的静态残留。 | 直接删除（git 历史可回溯）。 |
| S-21 | session_commands.rs 全文件 | 建议 | 会话读取存在**双数据源**：`load_session_body`（SQLite 消息）与 `core_read_session_events`（事件流）并存，前端 sessionHydration.ts 与 sessionEventHydrate.ts 分别消费；写入路径（save_session_body）与事件落库（EventQueue）也可能不一致（会话消息与事件序列无关联键）。 | 明确「SQLite 消息 = 事件流的投影」关系，或在 hydration 层统一真源，避免双写漂移。 |

## 三、命令面冗余矩阵

命令 | 前端调用方（src） | 死面 | 重复实现
---|---|---|---
workbench_performance_snapshot | 无 | ✔ 死面 | —（active_runs 恒空，S-3）
workbench_run_shell | terminalShellApi / gitApi / hostOpenersApi / reverseFileDiff | 活跃 | gatekeeper 逻辑与 core_check_command 重复
workbench_pty_create / write / resize / kill | ptySessionApi / ptyRegistry | 活跃 | —（kill 在前端两处调用，正常 fanout）
workbench_list_host_openers / list_file_openers | hostOpenersApi | 活跃 | —
workbench_open_host_target / open_path_default | hostOpenersApi / workspaceFsApi | 活跃 | —（与 open_with_shortcut 内部双路径）
select_folder | desktopNativeFeatures | 活跃 | —
list_directory / read_file_content / write_file_content | workspaceFsApi / importFsHost | 活跃 | —（S-21 与 core_read_session_events 数据源并存）
workbench_discover_skills | skillsApi | 活跃 | —
save_api_config | 无 | ✔ 死面 | 与 update_daemon_config 写路径重叠
get_api_config | 无 | ✔ 死面 | 与 core_get_status 部分重叠
update_daemon_config | engineConfig（经 commandMap 'update-config'） | 活跃 | daemon 命名残留（S-6）
workbench_profile_secret_set/get/has/clear | 无 | ✔ 死面 | —
workbench_http_request | modelCatalog | 活跃 | —
workbench_apply_update | updateStore | 活跃（stub） | —（S-4）
perf_hash_compute | 无 | ✔ 死面 | core_hash_compute
perf_base64_encode / decode | 无 | ✔ 死面 | core_base64_encode / decode
perf_encoding_detect / decode | 无 | ✔ 死面 | core_detect_encoding / core_decode_text
perf_diff_parse | 无 | ✔ 死面 | core_parse_diff
perf_jsonl_read / write | 无 | ✔ 死面 | —
perf_jsonl_append | TelemetryMonitor | 活跃 | —
perf_fs_read_chunk / file_info / watch_start / watch_stop | 无 | ✔ 死面 | —
core_check_command | rustCore.checkCommand | 活跃但恒失败（W-1） | gatekeeper 逻辑在 process.rs / host_openers 各 new 一次
core_search_files / rebuild_search_index | rustCore | 活跃 | —
core_compact_messages / count_tokens / compute_diff | rustCore | 活跃 | —
core_get_status | tauriTransport / engineConfig / engineStatus / mcpApi / quickOpenHelpers / rustCore | 活跃 | core_commands.rs:162 旧版（dead_code，S-20）
core_get_run_snapshot / read_run_events / read_session_events | sessionEventHydrate / transport | 活跃 | —
core_run_task / run_control / cancel_run / approve_tool / deny_tool | chatApi / runControlClient / ApprovalHandler / transport | 活跃 | —（run_control 部分 level no-op，S-10）
list_sessions / load_session_body / save_session_body / delete_session / load_session_agents / save_session_agents / get_session_meta / set_session_meta / cleanup_orphan_sessions / import_from_localstorage / touch_session | sessionRustDb / sessionHydration / sessionDaemonSync / migrateFromLocalStorage | 活跃 | load_session_body 与 core_read_session_events 双数据源（S-21）
md_render / md_render_batch / md_render_stream / highlight_code / md_clear_cache | rustCore / markdownPreload / codeHighlight / AsyncMarkdownBlock | 活跃 | —
core_hash_compute / base64×2 / detect_encoding / decode_text / parse_diff / messages_to_jsonl / jsonl_to_messages / text_encode | rustCore / workers（compute-worker / io-worker / api-adapters） | 活跃 | 与 perf_* 6 对重复（S-2）
workbench_set_keep_awake | 无 | ✔ 死面 | —

**前端调用但 Rust 未注册（契约缺口，W-5 同类）**：
- workbench_git_status / workbench_git_diff（gitApi.ts:460/521）
- workbench_list_mcp_servers / start_mcp_server / stop_mcp_server（mcpApi.ts、clientApi.ts）
- workbench_preview_conversation_rewind / apply_conversation_rewind（conversationRewindApi.ts）
- workbench_send_to_subagent / get_subagent_status（subagentApi.ts）
- workbench_list_background_tasks / get_background_task_output / cancel_background_task（backgroundTasksApi.ts:512/519/537）

## 四、高严重度详述

### 4.1 W-1：core_check_command 的 SharedGatekeeper 从未注入（命令恒失败）
- 证据：main.rs setup（136-201 行）仅 manage 三个状态；core_commands.rs:139 声明 `State<'_, SharedGatekeeper>`；SharedGatekeeper 类型（core_commands.rs:48-64）无 manage 调用点。
- 影响：前端 rustCore.ts:97-103 的 checkCommand 调用恒失败，`invokeCmd` 返回 null → 兜底 `'Allowed'`。命令审批预检功能静默失效；若未来有 UI 依赖「Blocked」结果展示，会表现为不拦截。
- 建议：setup 中注入；同时把 gatekeeper 检查收敛为单一实例（process.rs:420、host_openers/execute.rs:60/131/203 三处各自 `CommandGatekeeper::new()`）。

### 4.2 W-2：tracing 全静默 + panic 无记录（可观测性归零）
- 证据：全仓 grep `tracing_subscriber|init_tracing|conex_telemetry::init` 在 src-tauri 零命中；Cargo.toml 依赖 conex-telemetry 但仅 error_bridge.rs:105 使用 catch_unwind。
- 影响：main.rs:151-176（DB 降级）、engine.rs:115-118（引擎未就绪）、pty（生命周期）等关键路径的 tracing::error!/warn! 全部 no-op。启动失败只能靠前端 core_get_status 的布尔间接推断，错误原因（路径/权限/DPAPI）完全不可见。error_bridge.rs 注释声明的 panic hook 不存在，任何命令 panic 会直接表现为 invoke reject 且无日志。
- 建议：main() 首行 `conex_telemetry::init_default(&"debug")` + `install_panic_hook()`；配置日志落盘路径与轮转。

### 4.3 W-3/W-4：打包环境路径体系失效（配置与 DB 分裂）
- 证据链：
  - host_paths.rs:7 `env!("CARGO_MANIFEST_DIR")` 是**编译期宏**，打包产物在用户机器上该路径不存在 → app_dir() 大概率 Err（W-3）。
  - 结果：main.rs:145-177 sessions.db 打开失败 → 每次启动降级内存 DB 且 `db_ready=false`；engine.rs:189 `workspace_root(&app_dir().unwrap_or_default())` 用空路径建工具注册表；fs_commands 默认工作区根解析失败。
  - config/persistence.rs:35-47 的 `config_dir()` 却走 `%APPDATA%\Crish\AgentWorkbench`（或 CRISH_WORKBENCH_CONFIG_DIR）→ 配置与密钥可持久，DB 不可持久，两套路径逻辑不一致（W-4）。
- 影响：打包发行版核心持久化（会话/事件）全部失效；dev 环境正常，属于**发布前必须修复**的缺陷。
- 建议：setup 中用 `app.path().app_data_dir()` 统一解析一次并注入（State），host_paths/config 消费同一真源；CARGO_MANIFEST_DIR 仅作 dev fallback。

### 4.4 W-5：commandMap 映射 9 个不存在的命令（C1.5 ②类残留）
- 证据：commandMap.ts:31-39 把 9 个 WS type 映射到 workbench_* 命令；git_commands.rs / mcp_commands.rs / rewind / subagent 在 src-tauri 均不存在（glob 确认）。
- 影响：gitApi.ts:460/521、mcpApi.ts、conversationRewindApi.ts、subagentApi.ts、clientApi.ts 的调用全部命中 missing → 前端兜底（gitApi 有本机 git fallback，其余多为静默失败）。MCP 服务列表/启动停止、对话回溯、子代理等**功能实际未接通**，但 UI 可能显示为可用。
- 建议：与 21-phase-c-migration-log.md ③ 类清单逐项核对，实现或删条目；至少在 commandMap 中把这些条目标记为「未回补」并让调用方显式降级。

### 4.5 W-6：core_get_status 状态不诚实
- core_query_commands.rs:330-342：`compaction_ready=true` 硬编码、`search_index_ready` 以非空推断、`initialized=true` 恒真。前端 tauriTransport.isCoreReady（任一 true 即就绪）会基于假状态判定「核心已初始化」。建议字段级真实化（W-6 表格）。

## 五、正面发现

1. **B6 核心生命周期实现质量高**：core_run_commands 的 run 状态机（start_run → drive_run_loop → finalize_failed → 终态移出注册表）与 27 个测试用例（事件序列、终态唯一、串行守卫、取消路径、四源失败收口）覆盖完整；错误协议区分「invoke 同步错误」与「run 期事件通道错误」符合 03 §5.3-5。
2. **事件桥背压设计正确**：buffer.rs 的 Delta→Soft→Critical 三级丢帧策略、关键帧永不丢、flush 失败原序回置队首、高水位 512——设计合理且零 Tauri 依赖可独立测试。
3. **安全基线扎实**：
   - fs_commands 的 WorkspaceFsGuard：canonicalize + 前缀检查 + symlink 逃逸测试 + 写路径祖先链校验（types.rs:100-183），traversal/绝对路径/大文件/二进制/非 UTF-8 均有测试。
   - workbench_run_shell：红线 gatekeeper + 32KB 上限 + 600s 超时 + EncodedCommand base64 传输避免二次解析 + 输出 400KB 截断 + kill_on_drop + 树杀。
   - DPAPI 凭据（credentials.rs）：内存缓存 + 降级策略 + profile_id 白名单 sanitize（persistence.rs:87-104）。
   - pty：Windows Job Object KILL_ON_JOB_CLOSE 孤儿进程保护 + RunEvent::Exit 显式 kill_all。
4. **并发模型正确**：SessionLoopProducer 每 run 独立实例（+ 会话内串行守卫），EngineHandle 用 Mutex<Option<Endpoint>> + Arc<ToolRegistry> 只读共享，跨会话并发安全；std Mutex 均未跨 await 持有（tokio Mutex 用于异步路径）。
5. **参数与资源防护**：read_file_content 1MB/5000 行上限、perf 命令走 spawn_blocking、core_* Stream E 全走 spawn_blocking、PTY write 64KB 上限、分页 MAX_PAGE_SIZE=1000。
6. **路径安全**：perf/fs.rs 的 watcher 用 safe_canonicalize（40 级深度限制），避免深链攻击。
7. **模块解耦**：core_event_bridge 保持「零 crate:: 内部引用」以 #[path] 独立编译测试；engine.rs 适配器模式（BufferedRunEventBridge）隔离 Tauri 依赖。
8. **错误映射收敛**：map_store_err / map_run_err（core_error.rs）把存储层与状态机错误归一为 CoreError 的 io/invalid-input 两类，命令侧统一。

