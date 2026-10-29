# Tauri 壳收敛 · 实施方案

> 模块代号：**TS**　分支：`refactor/tauri-shell`　worktree：`C:\Users\orange\rf-tauri`　批次标签：`[BATCH-TAURI-SHELL]`
> 波次：W5，排在 HS 与 SB-P6 之后。提交：`refactor(TS-P<n>): <摘要> [BATCH-TAURI-SHELL]`
> 进度写 worktree 同目录 `tauri-shell.progress.md`。依据：g4（只作线索）+ 2026-10-29 对 `C:\Software\conex` 工作区的只读核实（HEAD `bf3d60fa3`）。行号会过期，探针用函数名。
> g4 没有名为 tauri-bootstrap 的模块。C6 的目标是壳内 `AppBootstrap`。g5 的 `app/AppBootstrap.ts` 是前端，本方案不改。

## 硬性规则
1. 只看代码，不看仓库 `docs/`、README、任何仓库内 `*.md`。
2. 彻底改进：先删后改，不留双形态参数、旧命令名、转发 re-export。
3. 非必要不兼容。该删的命令、死栈、一次性迁移，删掉。
4. 测试只在 TS-P9 集中跑，改阶段不跑 cargo / npm。
5. 每阶段一个提交，不 amend 已引用的提交。
6. 禁止作弊：不加 allow、`#[ignore]`、skip、不调基线、不放宽阈值、不用 `--no-verify` 或 continue-on-error。
7. 不 stash，不 push，不用 gh。主仓库只读；改动只在 worktree。

## a. 范围与门控
**A 组归 HS，本方案不改** `src/server/`、`src/push/`、`src/multi_device/`、`src/multi_device*`、`src/remote/`，也不重新设计出壳、不拆 OS 进程。HS 留下的 `MultiDeviceService` 只当启停点使用。

可改：`apps/agent-workbench/src-tauri` 的其余源码与 `Cargo.toml`、`build.rs`、`capabilities/`、`tauri.conf.json`；为契约必须同步的 `apps/crish-desktop/src/api/blockedExecutableExtensions.ts`、`authApi.ts`、命令清单生成物。新建进程内 crate 仅限 `crates/conex-process`（D 组）。不改 `crates/conex-relay`，不改 `device-protocol.json`。

**门控 G-TS（编写时未满足：src-tauri porcelain 105 行。未满足就不要开工）：**
```
git -C C:\Software\conex status --porcelain -- apps/agent-workbench/src-tauri
```
必须为空，且集成分支已含 HS（`BATCH-HUB-SERVER-EXTRACT` / `HS-P`）与 SB-P6（`check_launch`，`patterns()` 已删）。E1 还要求下面两条为空（脚本现在是 `M`，`path_safety.rs` 未跟踪）：
```
git -C C:\Software\conex status --porcelain -- scripts/check-blocked-executable-ssot.mjs
git -C C:\Software\conex status --porcelain -- apps/crish-desktop/src/api/blockedExecutableExtensions.ts
```

## b. 核实表
结论针对工作区，不是 g4 旧行号。rg 根目录为 `C:\Software\conex`。

| ID | 结论 | 函数 / 符号 | rg |
|---|---|---|---|
| A1–A7 | 归 HS，不在此改 | `MultiDeviceService` | 不设计 |
| B1 | 仍存在 | `browser/mod.rs` 的 `#[path]` 挂 `native_commands_fallback` / `native_manager_fallback`；`AllowAllPolicy` 与 `NativeWebviewManager` 并存 | `rg -n "#\[path\]|AllowAllPolicy|NativeWebviewManager" apps/agent-workbench/src-tauri/src/browser` |
| B2 | 仍存在 | `browser_webview_create` 等返回 `Result<_, String>` | `rg -n "Result<.*String>" apps/agent-workbench/src-tauri/src/browser/native_commands.rs` |
| B3 | 仍存在 | `browser_webview_create` 同时收 `args` 与扁平参数 | 同上文件 `:29` |
| B4 | 仍存在 | `create_webview` 使用调用方传入的 `workspace_root` | `rg -n "fn create_webview" apps/agent-workbench/src-tauri/src/browser/native_manager.rs` |
| B5 | 仍存在 | `create_webview` 先锁查 `webviews`，中途 `.await`，末尾 `guard.insert` | 同函数 |
| B6 | 仍存在 | `resolve_browser_udf_path` 用 `dirs::data_local_dir`；`storage_root` 用 `app_dir/browser-storage` | `rg -n "fn resolve_browser_udf_path|storage_root" apps/agent-workbench/src-tauri/src/browser` |
| B7 | 仍存在 | `is_trusted_certificate_target` 把 `0.0.0.0` 当可信；生产调用只有 re-export | `rg -n "is_trusted_certificate_target\(" apps/agent-workbench/src-tauri/src` |
| B8 | 仍存在 | `create_webview` / `browser_webview_create` 里 `let _ =`；窗口写死 `get_window("main")` | `rg -n "get_window\(\"main\"\)" apps/agent-workbench/src-tauri/src/browser` |
| B9 | 仍存在 | `NativeWebviewManager::create_webview` 从约 :344 延伸到接管与新建两支 | 同函数 |
| B10 | 仍存在 | `browser/mod.rs` 构造 `AllowAllPolicy`；`MvpDomainGate::new(&[], &[])` | `rg -n "AllowAllPolicy|MvpDomainGate" apps/agent-workbench/src-tauri/src/browser/mod.rs` |
| C1 | 仍存在 | `command_registry!`、`command_manifest.rs`、前端手写清单 | `rg -n "command_registry!|BUILTIN_COMMAND_MANIFEST" apps` |
| C2 | 仍存在（条数漂移，不是误报） | 注释仍写 166；`entry(` 约 171（含定义），`, false)` 尾为 0 | `rg -n "166" apps/agent-workbench/src-tauri/src/command_manifest.rs` |
| C3 | 仍存在 | `power.rs` 的 `workbench_set_keep_awake` 无 `mod power`；`perf_hash_compute` / `perf_base64_*` / `perf_diff_parse` 仍有 `#[tauri::command]`，注册名是 `core_hash_compute` | `rg -n "mod power|perf_hash_compute|workbench_set_keep_awake" apps/agent-workbench/src-tauri/src` |
| C4 | 仍存在 | 前缀混用（`workbench_` / `core_` / kebab / 无前缀） | `rg -n "create-workflow|trash_list" apps/agent-workbench/src-tauri/src/command_registry.rs` |
| C5 | 仍存在 | `import_from_localstorage`、`usage_import_legacy_snapshot`、`migrate_legacy_release_data`（`main` 启动即调） | `rg -n "import_from_localstorage|migrate_legacy_release_data" apps/agent-workbench/src-tauri/src` |
| C6 | 仍存在 | `main.rs` 单个 setup（文件约 934 行），没有壳内 `AppBootstrap` | `rg -n "fn main|\.setup\(" apps/agent-workbench/src-tauri/src/main.rs` |
| C7 | 仍存在 | `restore_state.run_restore` 被 `let _ =`；TokenStore 目录 `current_dir().unwrap_or_default()` | `rg -n "run_restore|current_dir" apps/agent-workbench/src-tauri/src/main.rs` |
| C8 | 仍存在 | `EngineHost::install` 里 `set_run_launch_hooks`、`set_committed_config_source`、`set_runtime_handle`、`set_app_data_dir`、`set_note_backend_factory`，并用 `block_on` 取 Handle | `rg -n "set_run_launch_hooks|block_on" apps/agent-workbench/src-tauri/src/engine_build.rs` |
| C9 | 仍存在 | `main.rs` 顶部 `not(windows)` 整文件 allow | 文件头 |
| C10 | 仍存在 | 装配注释仍在 | 随 P8 删，不单开阶段 |
| D1 | 仍存在 | `ProcessJobGuard::new_for_pid`；`shell_exec.rs` 与 `conex-browser` 另有 Job | `rg -n "struct ProcessJobGuard|AssignProcessToJobObject" apps/agent-workbench/src-tauri/src/process crates` |
| D2 | 仍存在 | `workbench_run_shell` 先 `child_cmd.spawn()` 再 `new_for_pid`，失败则 warn 降级 | `process/mod.rs` 该函数 |
| D3 | 仍存在 | `workbench_run_shell`、`resolve_cwd` 用 `host_paths::workspace_root`，失败则 `current_dir` | `rg -n "fn workspace_root|fn resolve_cwd|fn workbench_run_shell" apps/agent-workbench/src-tauri/src` |
| D4 | 仍存在（P0 再点名） | g4 指 `bg_log` / `bg_registry` 的 `thread::sleep` | `rg -n "thread::sleep" apps/agent-workbench/src-tauri/src` |
| D5 | 仍存在 | `process/mod.rs` 的 `allow(unused_imports)`；`watchdog` 的 dead_code | `rg -n "allow\(" apps/agent-workbench/src-tauri/src/process` |
| E1 | **仍存在，脚本未覆盖最低集** | 见 k。`is_blocked_executable_path` | `rg -n "BLOCKED_EXECUTABLE_EXTENSIONS" apps/agent-workbench/src-tauri apps/crish-desktop/src/api scripts/check-blocked-executable-ssot.mjs` |
| E2 | 仍存在 | `open_path_with_default_app` 只 `p.exists()`；`open_host_target` 用固定 `workspace_root` | 这两个函数 |
| E3 | 仍存在 | `CMD_METACHARS`；`open_path_with_default_app` 仍按元字符拒绝，实现已是 `open_with_shell_execute` | `rg -n "CMD_METACHARS|fn open_with_shell_execute" apps/agent-workbench/src-tauri/src/host_openers` |
| E4 | 仍存在 | `workbench_open_*` 都是同步 fn；`launch_external_url` 与 `open_path_with_default_app` 都 `spawn` 后立刻 `join` | `host_openers/mod.rs` |
| E5 | 仍存在 | `launch_external_url` 的 macOS/Linux `Command::spawn` 不等待 | 同函数 |
| E6 | 仍存在 | `execute.rs` 约 601 行 | 行数门禁，不靠拆文件名逃避 |
| F1 | 仍存在 | `credential_store.rs` 自声明 `CryptProtectData`；`agent-provider` `credentials.rs` 另有一份 | `rg -n "fn CryptProtectData" apps/agent-workbench/src-tauri/src/auth crates/agent-provider/src/credentials.rs` |
| F2 | 仍存在 | `SessionSnapshot.access_token`；`auth_get_session` 原样返回；`authApi.ts` 也有该字段 | `rg -n "fn auth_get_session|access_token" apps/agent-workbench/src-tauri/src/auth_commands.rs apps/crish-desktop/src/api/authApi.ts` |
| F3 | 仍存在 | 非 Windows 分支 `fs::write` 明文 | `credential_store.rs` 写入函数 |
| F4 | 仍存在 | `map_cloud_auth_err`：Unauthorized→InvalidInput，Network→Io | `auth_commands.rs` |
| F5 | 仍存在 | `let _ = credential_store.clear_credentials` 等 | `rg -n "clear_credentials" apps/agent-workbench/src-tauri/src/auth` |
| G1 | 仍存在 | `register_tools` / `activation` / `enablement` 为 `#[cfg(test)]`；生产仍 `attach_emitter` + `spawn_computer_stop_watcher` | `rg -n "fn register_tools|fn spawn_computer_stop_watcher" apps/agent-workbench/src-tauri/src/computer` |
| G2 | 仍存在 | `on_run_stopped` 里 `let _ = self.persist(false)` | 同函数 |
| H1 | 仍存在 | `perf/*` 含 diff/hash/base64，与 `conex-diff` 重复，壳内几乎无测试 | `rg -n "mod perf" apps/agent-workbench/src-tauri/src` |
| H2 | 同 C3 | 残留 `#[tauri::command]` | 见 C3 |
| I1 | 仍存在 | `list_directory` / `read_file_content` / `write_file_content` 返回 `FileCommandError`，`workbench_discover_skills` 返回 `CoreError` | `fs_commands/mod.rs` |
| I2 | 仍存在 | `write_file_content_with_guard`：先 `exists` 再写；先 `create_dir_all` 再查大小；`std::fs::write` | 该函数 |
| I3 | 仍存在 | `workbench_discover_skills` 同步扫目录 | 该函数 |
| I4 | 仍存在 | `host_paths::workspace_root` 与 `WorkspaceRegistry` 两套根 | `rg -n "fn workspace_root" apps/agent-workbench/src-tauri/src/host_paths.rs` |
| I5 | 仍存在 | `app_dir` 在 debug 下返回 `apps/agent-workbench` | 该函数 |
| J1 | 仍存在 | `note_commands_apply.rs` / `note_commands_hydrate.rs`：`spawn_blocking` 里 `handle.block_on` | `rg -n "block_on\(backend" apps/agent-workbench/src-tauri/src` |
| J2 | 仍存在 | `trash_list` / `trash_restore` / `trash_purge` 同步 | `run_ipc.rs` |
| J3 | 仍存在 | 多处 `too_many_arguments`（P0 按 allow 属性重列） | `rg -n "too_many_arguments" apps/agent-workbench/src-tauri/src` |
| J4 | 不在本方案全仓清 | `#[path]` 测试旁挂归 MP。本方案只禁止新的 | 见 j |
| K1 | 仍存在 | `capabilities/default.json` 含 `mcp:default` | 该文件 |
| K2 | 仍存在 | 同一 capability 授予 `main` 与 `session-*` 建窗、`allow-emit` | 同文件 `windows` |
| K3 | 仍存在 | `tauri.conf.json` 的 CSP：`frame-src` 含 `http://localhost:*` | 该文件 |
| K4 | 仍存在 | `tauri` features 含 `test` 与 `unstable`；`tokio` features `full`；`windows-sys` 0.61、`windows` 0.62、`windows-core` 0.61 | `src-tauri/Cargo.toml` |
| K5 | 仍存在 | `build.rs` 只有 `tauri_build::build()` | 该文件 |
| L1 | 仍存在 | 全仓库 Cargo.toml 无 specta/ts-rs/typeshare | `rg -n "specta|ts-rs|typeshare" --glob Cargo.toml` |
| L2 | 仍存在 | `SessionSnapshot` 默认 snake；`CloudDeviceItem` 只手动 `rename = "lastSeenAt"` | `auth_daemon.rs`、`client.rs` |
| L3 | 仍存在 | `CloudDeviceItem.metadata: Option<serde_json::Value>` | `client.rs` |

无「整条误报」。C2 的 165/166 数字已过期，问题本身还在。

## c. 目标架构
壳只做 IPC、窗口、能力配置和宿主适配。浏览器只留一条栈（P0 选定：已接线的 WebView2 原生栈留下，CDP `BrowserSlot` 若无生产命令消费则删；选定写进 verify，禁止两套同时改功能）。导航信任根只来自 `WorkspaceRegistry`。命令只有一个 Rust 注册表，TS 名称与类型由脚本生成。启动是 `AppBootstrap`：每个子系统 `fn install(...) -> Result<Handle, BootError>`，失败即退出或进入命名降级，禁止 `let _ =` 与 cwd 兜底。进程启动经 `conex-process`（进程内）：先挂 Job 再恢复线程。打开文件经 `check_launch`（SB-P6 已提供），拒绝条件统一为「不是 Allowed」。工作区根只有 `WorkspaceRegistry`。`host_paths::app_dir` 的 debug 也指向独立数据目录，不写源码树。

## d. 删除清单
`power.rs`；perf 上残留的 `#[tauri::command]`；`native_*_fallback.rs` 及其 `#[path]`；`is_trusted_certificate_target`（不接线则删，禁止留着误导）；`AllowAllPolicy` 作为面板默认；`CMD_METACHARS`（仅在 P2 测试证明 ShellExecute 不经 cmd 之后）；`computer/` 的生产 watcher 与 `on_run_stopped` 落盘（工具未注册、前端无引用，整模块删除，测试随功能删除）；启动路径上的 `migrate_legacy_release_data`、`import_from_localstorage`、`usage_import_legacy_snapshot`（P0 若仍有唯一数据迁移调用方，改成显式一次性工具，不留在每次启动）；命令 `registered` 字段；手写命令快照。**不删**任何已有危险扩展名。

## e. 分阶段与探针
`$B = refactor/tauri-shell`。改阶段不跑测试。每阶段结束用 `git -C $R grep` 对 `$B` 跑探针。

**TS-P0** 不改代码。重跑 G-TS，把 b 表按当时文件重标。确认 SB-P6 的三处已经改叫 `check_launch`，且阈值仍是原样（松的两处只拒 Blocked，shortcut 拒非 Allowed）。确认 HS 后 `server/` 等目录已不在壳内。写 `tauri-shell.verify.md`。

**TS-P1（门控满足后的第一可执行阶段，只做 E1）** 在 `BLOCKED_EXECUTABLE_EXTENSIONS` 与前端同名常量**追加**（不得删除、不得改序以外的重排去掩盖 diff）：`js`、`psm1`、`psd1`、`ps1xml`、`chm`、`wsc`、`msp`、`mst`、`gadget`、`application`、`library-ms`、`search-ms`、`iso`、`img`、`vhd`、`vhdx`。Rust 测试与 `blockedExecutableExtensions.test.ts` 锁定「最低集是子集，且旧项一个不少」。脚本若已干净：把抽取字符类从 `[a-z0-9]+` 收紧为 `[a-z0-9-]+`，使 `settingcontent-ms` 进入比较；用临时删一侧该项必须退出 1 来证明（证明完还原）。脚本若仍脏：不改脚本，阶段不算完成。
探针：`git grep` 最低集每个后缀在两侧各 ≥1；`rg` 不得出现从旧清单消失的后缀。

**TS-P2** E2–E6 与阈值。三处（`open_host_target`、`open_with_shortcut`、`open_path_with_default_app`）在 `check_launch` 之后用同一个 `fn denied(v) -> bool`：`v != Allowed`。这是收紧原 :98/:414，不是放宽原 :236。新增拒绝的输入逐条写入 progress。路径必须落在 `WorkspaceRegistry` 已注册根内；拒绝 UNC 与设备路径。命令改为 async，阻塞放进 `spawn_blocking`，禁止 `join` 回主线程。删 `CMD_METACHARS` 前先有测试：`(x86)` 与 `报告 (1).pdf` 在工作区内、扩展名不在黑名单、`check_launch` 为 Allowed 时可以打开；含 `&` 的路径不会进入 `cmd.exe`。
探针：`rg "CMD_METACHARS|patterns\("` 在 host_openers 为 0；三处不再单独写 `== Blocked`。

**TS-P3** B 组。删 fallback 文件，平台差异用 `cfg` 写在同一模块，**不新增 `#[path]`**。命令改 `CoreError`，只留一种参数。`create_webview` 拆成占位、建 UDF、挂观察者、登记；同一 tab 并发只创建一个。存储根一个值对象，由 `host_paths` 给出。域名策略默认拒绝敏感 scheme 与内网段，空名单不得等于全放行。
探针：`rg "#\[path\].*fallback|AllowAllPolicy|Result<.*, String>"` 在 `browser/` 为 0。

**TS-P4** C1–C5、L。不引入 specta（仓库零依赖，cargo deny 不新增）。桌面清单只许有一个生成脚本。`desktop-ipc-api.md` 若已落地 `scripts/generate-command-manifest.mjs`，就扩展它，不要再新增 `generate-command-bindings.mjs`。IPC 尚未合入时，本阶段创建那一个脚本，IPC 之后只消费它。删手写快照与 `registered`。命名一次改成 `domain_verb`，不留旧别名。wire 统一 camelCase。`CloudDeviceItem.metadata` 与生成类型一致。删 `power.rs` 与残留命令属性。根 `package.json` 若仍脏，不改它，脚本用 `node scripts/...` 直接调用。
探针：前端清单文件不再手写命令数组；`rg "tauri::command" apps/agent-workbench/src-tauri/src/perf apps/agent-workbench/src-tauri/src/power.rs` 为 0（power.rs 不存在）。

**TS-P5** D。抽出 `conex-process`（库，同进程）。Job 绑定顺序对齐 `conex-browser` 已有的 `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `Resume`，禁止先 spawn 再降级。`workbench_run_shell` 与 `resolve_cwd` 的 cwd 必须在已注册根内。`thread::sleep` 改为 tokio interval。**不得新写 `allow(`**。
探针：`rg "new_for_pid" apps/agent-workbench/src-tauri/src/process/mod.rs` 为 0；`cargo tree -p conex-process -e normal` 不含 tauri。

**TS-P6** F、G、H。`auth_get_session` 不再含 token。凭据写入走 agent-provider 已有 DPAPI；非 Windows 没有系统密钥链就返回错误，禁止明文 `fs::write`。`map_cloud_auth_err` 使用 EC 的 kind（见 j），不新造错误枚举。删除 `computer/`。perf 的纯函数并入已有 `conex-diff` / 小函数留在调用点，壳只留命令包装。
探针：`rg "access_token" apps/agent-workbench/src-tauri/src/auth/auth_daemon.rs` 在快照结构上为 0；`rg "mod computer" apps/agent-workbench/src-tauri/src` 为 0。

**TS-P7** I、J。文件命令统一 `CoreError`。`write_file_content_with_guard` 先校验再落盘，`create_new` 或 temp+rename。同步 I/O 命令改 async。笔记后端提供同步 API，`spawn_blocking` 内禁止 `block_on`。
探针：`rg "enum FileCommandError|block_on\(backend" apps/agent-workbench/src-tauri/src` 为 0。

**TS-P8** K 与 C6–C9。`AppBootstrap` 拆 setup。`mcp:default` 移出生产 capability。`session-*` 与 `main` 拆开。CSP 只留实际端口。去掉 tauri 的 `test` feature 与 tokio `full`；Win32 绑定收成一套。禁止 cwd 兜底。非 Windows 用 `cfg` 排除代码，去掉文件级 allow。
探针：`rg "mcp:default" apps/agent-workbench/src-tauri/capabilities/default.json` 为 0；`rg "features = \[\"full\"\]" apps/agent-workbench/src-tauri/Cargo.toml` 为 0。

**TS-P9** 只跑 §h。不提交，除非要记录「验证通过」的空提交——不要空提交。

## f. 禁止捷径
禁止新增 `#[path]`、`allow(`、独立 OS 进程、sidecar。禁止把 `== Blocked` 当成统一阈值（那是放宽 shortcut）。禁止从黑名单删后缀，禁止用白名单替换时漏掉现有后缀（若 P0 改白名单，白名单外默认拒绝，且现有危险后缀必须仍被拒绝）。禁止为过行数门禁改文件名或加 `#[path]`。禁止扩展 unwrap 基线来容纳壳里的存量。禁止 specta 等新依赖。禁止编辑 HS 已迁走的目录。

## g. 规范
包名保持 `crish-agent-workbench`。新 crate 用 `conex-*`，文件头 `//!` 中文职责。clippy `-D warnings`。错误走 `CoreError`。命令名 `domain_verb`，serde `rename_all = "camelCase"`。提交信息不写「临时」。

## h. 测试命令
仅 TS-P9，在 worktree。Node 24（根 engines `^24.3.0`）。先确认没有其他 cargo，磁盘 ≥ 25 GB。
```
$env:RUSTUP_TOOLCHAIN = "1.99.1"
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\tauri"
cargo fmt --all -- --check
cargo clippy -j 3 -p crish-agent-workbench -p conex-process --all-targets -- -D warnings
cargo test -j 3 -p crish-agent-workbench -p conex-process
npm run typecheck
npm run check:line-counts
node scripts/check-blocked-executable-ssot.mjs
npm run test:e2e:smoke
```
回归：R1 `.js` 与 `.psm1` 默认打开被拒，`.pdf` 仍可打开；R2 `(x86)` 路径不被元字符误伤；R3 UNC 被拒；R4 浏览器 file: 不能把 `C:\` 当根；R5 `auth_get_session` 响应无 token；R6 生产 capability 无 `mcp:default`。

## i. 审计
对照 §e 探针，加上 ROADMAP §7.3 作弊清单。特别看：`+allow(`、`+#[path]`、黑名单 diff 只有增、三处阈值没有从 `!= Allowed` 放宽、`access_token` 没有换个字段名继续下发。测试文件删除仅允许随 `computer/`、fallback、`power.rs` 一起消失，并在 progress 列出。

## j. 与 HS / SB / EC / TM / MP 的冲突
- **HS**：A 组已出壳。本方案不改那些目录，不恢复 `lib.rs` 的 `pub mod server`。`AppBootstrap` 只调用 HS 留下的 `MultiDeviceService`。
- **SB**：不实现第二套 `check_launch`，不恢复 `patterns()`。阈值统一只在 TS-P2，方向只收紧。
- **EC**：F4 / I1 的 kind 用 EC 的错误码真源。缺 kind 就记给 EC，不在壳里新造枚举。D10 的生成器不在本方案重写。
- **TM**：壳里若碰到自造时钟，改调用 `conex_shared::time`，不另做时间模块。
- **MP**：禁止新 `#[path]`。TS-P3 只删浏览器 fallback 的 `#[path]`。`engine_tests`、`note_commands`、`background`、`command_manifest` 测试旁挂留给 MP。
- 另外：ST 的手写类型不在此删；CF / AV 不在此做。`credentials.rs` 若开工时变脏，F1 停下。

## k. 已决
- D3：多端服务已由 HS 做成 `conex-hub-server` + `conex-push`，进程内。本方案从 HS 集成结果开始。
- D6：SB-P6 统一 `check_launch` 并删除 `patterns()`，三处原阈值保持。本方案再把阈值收成「非 Allowed 即拒绝」，不得放宽。
- D2：不整理 avatar-studio。
- **E1**：`scripts/check-blocked-executable-ssot.mjs` 只检查两侧数组相等和调用点，**没有**最低危险集。抽取正则 `[a-z0-9]+` 丢掉 `settingcontent-ms`、`appref-ms`。基线 `execute.rs` 与工作区 `path_safety.rs` 的清单相同，都没有 `js`、`psm1` 等。因此不是「脚本已覆盖、只补漏」，而是 **本方案修清单（只加不删）**，并用测试锁最低集。脚本判定不得改成放行。
- G1：生产未注册工具且前端无引用，删除 `computer/`，不补接线。
- L1：不引入 specta，用仓库已有的 Node 生成脚本风格，不新增 Rust 依赖。
