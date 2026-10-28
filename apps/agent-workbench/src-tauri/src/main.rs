#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri 壳集成接线（B6.4 重建版）
//!
//! 本文件是进程内核心（IPC 模式）的装配层，职责：
//! - **注册面**：[command_registry!] 宏以 (命令名, 实现路径) 二元组为编译期
//!   真源，同源生成 [COMMAND_REGISTRY_NAMES]（注册面清单）与
//!   [build_invoke_handler]（`generate_handler!` 分发）；注册面必须与
//!   `command_manifest.rs` 的 `registered=true` 集合逐项一致（壳测试锁定）；
//! - **setup 序列**（依 PE-01/PE-04/PE-08 接线契约）：
//!   ① conex-telemetry 初始化（级别：`CRISH_LOG_LEVEL` 优先，dev debug /
//!   release info；文件层 `app_dir()/logs` 双通道）+ 崩溃文件 panic hook；
//!   ② LocalDb 打开（`app_dir()/sessions.db`，失败降级内存 + `db_ready=false`）；
//!   ③ 模型配置单一存储初始化与文件变更监听；
//!   ④ [WorkspaceRegistry::init] manage（工作区沙箱真源）；
//!   ⑤ [SharedGatekeeper] / [SharedSearchState] / [SharedCompactionState] manage；
//!   ⑥ [StatusDiagnostics] manage（与 CoreRunState 共享同一实例）；
//!   ⑦ restore：`run_restore` 经 run_in_runtime 在 `manage(CoreRunState)` 之前
//!   执行（成功 seed_sequences + 立即快照；失败降级不阻断启动）；
//!   ⑧ [CoreRunState] manage + [EventBridge] manage + [SharedDb] manage；
//!   ⑨ 模型目录由核心已提交配置快照派生；
//!   ⑩ MCP 插件：debug 下 `dev_mcp::register_if_enabled(builder)`（默认开启，
//!   `CRISH_MCP_SOCKET=0` 显式关闭；2026-08-21 用户裁决）；
//!   ⑪ 多端本地服务生产装配（R1-11 G-1）：CoreStateBackend（真实
//!   `*_impl` 直调面）+ FanOutEmitter（挂 EventBridge 汇聚点，注入
//!   ServerState.event_stream）+ PairingCoordinator（set_port / rebind
//!   钩子接 restart_server）+ 服务开关（D5 D-01 红线 1：默认关闭 =
//!   不 bind 任何端口；multi_device_set_enabled 命令启停）；
//! - **退出钩子**：`RunEvent::Exit` 时 PTY 清理 + 多端服务优雅关停
//!   （ServerLifecycle 槽）+ [CoreRunState::save_snapshot_blocking]（独立线程）。

mod asset_scope;
mod auth;
mod auth_commands;
mod background;
mod browser;
mod browser_commands;
// 浏览器书签/历史落库适配（3 方案 U4：browser_import_sinks.rs 由浏览器
// 阵营交付，main.rs mod 声明缺失导致 crate 编译中断——R1-11 装配面顺手补齐）
mod browser_import_sinks;
mod command_manifest;
// 统一配置单轨测试夹具（壳层域；probe / engine_tests 共用——cfg(test) only）
#[cfg(test)]
mod config_test_support;
// 电脑操作会话槽（06 遗留⑨：ComputerSlot 命令面托管 + 工具装配接线面，
// 接线点登记见 computer/mod.rs 模块头）
mod computer;
mod config;
mod core_commands;
mod core_query_commands;
// R1 撤回命令（统一输入流收敛战役；命令面独立于 run/ 目录——I1-β 并行
// 位在改 run_idle/run_launch/engine_build，避免争写）
mod dev_mcp;
mod engine;
mod fs_commands;
mod git;
mod host_openers;
mod host_paths;
mod markdown_commands;
mod mcp_commands;
mod models_yaml;
mod retraction_commands;
// 多端互通模块族（R1-06：TLS + 自签证书 + 指纹固定，multi_device/tls.rs；
// R1-07：配对命令面，multi_device_commands.rs；R1-09：单实例锁，
// single_instance.rs——G-2 桌面多实例端口竞争）
mod multi_device;
mod multi_device_commands;
// R1-09 G-4：网络环境检测（multi_device_network.rs：注册表网络配置文件
// 类别 + 可直连 IP 枚举 + 防火墙/AP 隔离引导文案）
mod multi_device_network;
mod note_commands;
mod note_runtime;
mod perf;
mod preferences_commands;
mod probe;
mod process;
mod pty;
mod resource;
// R3-02 推送装配适配层（bin 侧：lib push 契约 ↔ bin server/WsRegistry 桥接
// ——DevicePresenceSource 适配 + PushChannel WS 实现；
// 见 push_wiring.rs 模块头注记）
mod push_wiring;

#[path = "server/core_backend/mod.rs"]
pub(crate) mod core_backend;
mod server;
mod session_commands;
// b6：首条助手回复后的短标题。命令面独立于 run/，避免和运行生命周期争写。
mod session_title_commands;
mod single_instance;
// ACT-101 / CON-01：原生窗口隐式创建 + 首绘握手唤醒（Stage 1）
mod tauri_emitter;
mod window_backdrop;
mod window_handshake;
// Win11 贴靠布局（Snap Layouts）：最大化按钮上的原生 HTMAXBUTTON 热区
mod window_snap_overlay;
// ACT-102：双 SQLite 并发装配（spawn_blocking + async 汇聚）
mod db_setup;
// sched / subagent_spawner / timers 已下沉 `conex-run` crate
// （conex_run::{sched, subagent_spawner, timers}；壳层无独立 mod 声明）。
mod system_power;
// 自动更新命令面（RUN-03/SEC-02/GAP-01：检查/下载/安装/重启四段命令 +
// workbench_apply_update 一次编排；模块头登记链路与用户裁决 §3.4-3 出处）
mod updater;
mod usage_commands;
// workflow 业务后端已下沉 `conex-run`（conex_run::workflow）；壳层只留
// Tauri IPC 薄壳（workflow_ipc.rs：六条命令 + AppHandle 事件发射 +
// create_workflow 工具通道延迟绑定）。
mod workflow_ipc;
// run IPC 薄壳（十条命令 + 回收站根解析 + 设置域直调体；业务实现 =
// conex_run::run 契约体）
mod run_ipc;

mod watchdog;
// D6-②：无人值守唤醒 watcher（任务连续性维度 D6；本体已下沉 conex-run，
// 壳层只做装配注入）。装配点（壳层面批次接线）：
// - 每会话 spawn：run_restore 成功路径 / run_task_impl 会话首次出现处
//   惰性 spawn（CoreRunState 新增 wake_watchers 幂等持有表，与
//   watchdog 每会话任务同生命周期语义——run 收口不销毁）；
// - 注入件：queue = engine.timer_steering_queue() 同实例；
//   has_active_run = active_runs 锁内同会话扫描；empty_streak =
//   resume_empty_streak 只读；launcher = spawn_idle_resume_run 包装；
// - user_stopped：run_control L2/L3 路径 set、用户新 run 装配 clear。
#[cfg_attr(not(test), allow(dead_code))]
mod outputs_config;
mod workspace;
// C3 交付物(任务连续性测试基建):可脚本化 mock SSE/HTTP server——
// 响应序列(429+Retry-After / 5xx / 发数据后断流 / 正常流)按请求序号
// 消费,记录请求供断言;供 D1/D2/D3/D5 壳层测试共用(cfg(test) 仅测试面,
// 不参与生产构建)
#[cfg(test)]
mod scripted_mock_server;

use std::sync::Arc;

use conex_run::core_event_bridge::{Emitter, EventBridge};
use tauri::Manager;
use tauri_emitter::TauriEmitter;

/// 命令注册面（编译期真源）
///
/// 每项二元组 `(命令名, 实现路径)`：命令名 = 前端 invoke 面（wire 名，必须与
/// `command_manifest.rs` 的 `registered=true` 一致）；实现路径 = `#[tauri::command]`
/// 函数。宏同源生成：
/// - [COMMAND_REGISTRY_NAMES]：注册面清单（壳测试与 manifest 对照的编译期依据）；
/// - [build_invoke_handler]：`generate_handler!` 分发（Tauri invoke 路由）。
///
/// **铁律（T-F 06，通信契约）**：wire 键 = manifest 登记名；函数名与 wire 键
/// 不一致必须显式 `#[tauri::command(rename = "...")]`；禁止函数名隐式成为
/// wire 键。改动本注册面（新增/退役/改名）必须同步 command_manifest.rs 条目 +
/// 前端 commandManifest.ts 快照 + 双端条数公式，并由 command-contract-drift
/// 测试（前端契约总门禁）与注册面一致性测试守护。
macro_rules! command_registry {
    ($(($name:literal, $path:path)),* $(,)?) => {
        pub(crate) const COMMAND_REGISTRY_NAMES: &[&str] = &[$($name),*];

        /// 构建 invoke 分发处理器（注册面真源的唯一出口）
        pub(crate) fn build_invoke_handler() -> Box<tauri::ipc::InvokeHandler<tauri::Wry>> {
            Box::new(tauri::generate_handler![$($path),*])
        }
    };
}

command_registry![
    // ── GUI 专属面（workbench_*，§2.3）──
    ("workbench_run_shell", process::workbench_run_shell),
    // ACT-101 / CON-01：前端骨架屏首绘完成后的原子握手唤醒命令
    (
        "workbench_window_ready",
        window_handshake::workbench_window_ready
    ),
    // Win11 贴靠布局：前端上报最大化按钮矩形，原生子 HWND 在其上回报 HTMAXBUTTON
    (
        "workbench_set_snap_overlay_rect",
        window_snap_overlay::workbench_set_snap_overlay_rect
    ),
    // T-AB-08：后台任务查询面恢复（B01/B02；list/get_output/cancel 三命令，
    // 形状对齐前端 backgroundTasksApi.ts 解析层）
    (
        "workbench_list_background_tasks",
        background::workbench_list_background_tasks
    ),
    (
        "workbench_get_background_task_output",
        background::workbench_get_background_task_output
    ),
    (
        "workbench_cancel_background_task",
        background::workbench_cancel_background_task
    ),
    // T-AB-20：后台任务 stdin 注入（sendBackgroundTaskInput 等待的命令面；
    // F3 T-AB-19 顺手注册，参数 camelCase taskId/text/appendNewline）
    ("workbench_send_input", background::workbench_send_input),
    // PE-07 T07.3（C-02/C-03/C-04）：git 参数数组执行 + 参数 schema 白名单
    ("workbench_git_run", git::workbench_git_run),
    ("workbench_pty_create", pty::workbench_pty_create),
    ("workbench_pty_write", pty::workbench_pty_write),
    ("workbench_pty_resize", pty::workbench_pty_resize),
    ("workbench_pty_detach", pty::workbench_pty_detach),
    ("workbench_pty_attach", pty::workbench_pty_attach),
    ("workbench_pty_ping", pty::workbench_pty_ping),
    ("workbench_pty_kill", pty::workbench_pty_kill),
    (
        "workbench_list_host_openers",
        host_openers::workbench_list_host_openers
    ),
    (
        "workbench_open_host_target",
        host_openers::workbench_open_host_target
    ),
    (
        "workbench_open_path_default",
        host_openers::workbench_open_path_default
    ),
    (
        "workbench_list_file_openers",
        host_openers::workbench_list_file_openers
    ),
    // 模型字典真源（models.yaml）：读（缺则播种）/ 校验 / 原子保存
    (
        "workbench_read_models_yaml",
        models_yaml::workbench_read_models_yaml
    ),
    (
        "workbench_validate_models_yaml",
        models_yaml::workbench_validate_models_yaml
    ),
    (
        "workbench_save_models_yaml",
        models_yaml::workbench_save_models_yaml
    ),
    (
        "workbench_apply_models_config",
        models_yaml::workbench_apply_models_config
    ),
    // 出厂能力字典只读投影（替代已退役 catalog_get 的读面；纯只读，无写盘 /
    // 无状态变更）——wire 名语义：它是「能力字典」的投影，不是实现细节名
    (
        "workbench_read_capability_dictionary",
        models_yaml::workbench_read_capability_dictionary
    ),
    // T-F 06：fs 命令经 `#[tauri::command(rename = "workbench_*")]` 对齐
    // wire 键（元组名 = manifest 登记名 = wire 键逐字一致，分裂已消除）
    ("workbench_list_directory", fs_commands::list_directory),
    (
        "workbench_read_file_content",
        fs_commands::read_file_content
    ),
    (
        "workbench_write_file_content",
        fs_commands::write_file_content
    ),
    // PE-07：recent/default 根复授权；新根只能由 Rust 内部原生目录选择器登记
    (
        "workbench_open_workspace",
        workspace::workbench_open_workspace
    ),
    (
        "workbench_open_workspaces",
        workspace::workbench_open_workspaces
    ),
    (
        "workbench_activate_default_workspace",
        workspace::workbench_activate_default_workspace
    ),
    (
        "workbench_list_workspaces",
        workspace::workbench_list_workspaces
    ),
    (
        "workbench_pick_workspace_folder",
        workspace::workbench_pick_workspace_folder
    ),
    (
        "workbench_pick_workspace_folders",
        workspace::workbench_pick_workspace_folders
    ),
    (
        "workbench_discover_skills",
        fs_commands::workbench_discover_skills
    ),
    (
        "workbench_mutate_owned_skill",
        fs_commands::workbench_mutate_owned_skill
    ),
    // ── 自动更新链路（RUN-03/SEC-02/GAP-01：真实 updater，替代恒 {ok:true} stub）──
    ("workbench_apply_update", updater::workbench_apply_update),
    ("workbench_check_update", updater::workbench_check_update),
    (
        "workbench_download_update",
        updater::workbench_download_update
    ),
    (
        "workbench_install_update",
        updater::workbench_install_update
    ),
    ("workbench_restart_app", updater::workbench_restart_app),
    // ── 凭据事务：模型配置与活动选择只由 models 命令提交 ──
    ("config_secret_set", config::config_secret_set),
    ("config_secret_get", config::config_secret_get),
    ("config_secret_has", config::config_secret_has),
    ("config_secret_clear", config::config_secret_clear),
    ("config_secret_reveal", config::config_secret_reveal),
    // ── 原生探活与模型扫描（Batch 1 · G3：provider_probe_ping / provider_probe_scan_models）──
    ("provider_probe_ping", probe::provider_probe_ping),
    (
        "provider_probe_scan_models",
        probe::provider_probe_scan_models
    ),
    // ── 工具旧组（E1，§2.2-E）──
    ("core_check_command", core_commands::core_check_command),
    ("core_search_files", core_commands::core_search_files),
    (
        "core_rebuild_search_index",
        core_commands::core_rebuild_search_index
    ),
    (
        "core_compact_messages",
        core_commands::core_compact_messages
    ),
    ("core_count_tokens", core_commands::core_count_tokens),
    ("core_compute_diff", core_commands::core_compute_diff),
    // ── 查询与运行（A/B，§2.2）──
    ("core_get_status", core_query_commands::core_get_status),
    (
        "core_get_run_snapshot",
        core_query_commands::core_get_run_snapshot
    ),
    (
        "core_read_session_events",
        core_query_commands::core_read_session_events
    ),
    // F-03（DM-07）：core_read_run_events IPC 面恢复激活（T-F 06 退役登记
    // 撤销；实现委托 read_run_events_impl，与 server 直调体同源——manifest
    // registered=true + 注册面一致性测试两侧必须同步）
    (
        "core_read_run_events",
        core_query_commands::core_read_run_events
    ),
    ("core_run_task", run_ipc::core_run_task),
    ("core_run_control", run_ipc::core_run_control),
    (
        "core_set_run_permission_mode",
        run_ipc::core_set_run_permission_mode
    ),
    // R1 撤回（统一输入流收敛战役）：用户撤回入口——复用 core_run_control
    // L3 通道 + 独立 retract 语义 wire（命令面独立于 run/ 目录）
    (
        "core_session_retract",
        retraction_commands::core_session_retract
    ),
    // E2 F4（07 §3 卡 C）：手动压缩（slash /compact → 引擎命令；registered
    // 面 = make_handlers! 注册面不变量，command_manifest 同批翻 true）
    ("core_compact_now", run_ipc::core_compact_now),
    // b6：首条助手回复后生成不超过 12 字的会话标题
    (
        "core_generate_session_title",
        session_title_commands::core_generate_session_title
    ),
    ("core_cancel_run", run_ipc::core_cancel_run),
    // 会话级 Tier-2 中止（前端级联取消总线；desktopNativeFeatures 契约命名）
    ("workbench_abort_run", run_ipc::workbench_abort_run),
    ("core_approve_tool", run_ipc::core_approve_tool),
    ("core_deny_tool", run_ipc::core_deny_tool),
    // ── 多端互通配对面（R1-07：四件套）──
    (
        "multi_device_pair_start",
        multi_device_commands::multi_device_pair_start
    ),
    (
        "multi_device_pair_status",
        multi_device_commands::multi_device_pair_status
    ),
    (
        "multi_device_pair_cancel",
        multi_device_commands::multi_device_pair_cancel
    ),
    (
        "multi_device_list_devices",
        multi_device_commands::multi_device_list_devices
    ),
    (
        "multi_device_revoke_device",
        multi_device_commands::multi_device_revoke_device
    ),
    (
        "multi_device_rename_device",
        multi_device_commands::multi_device_rename_device
    ),
    // R1-09 G-4：网络环境检测（注册表网络配置文件 + 可直连 IP + 引导文案）
    (
        "multi_device_network_info",
        multi_device_commands::multi_device_network_info
    ),
    // R1-11 G-1：多端服务总开关（D5 D-01 红线 1——enabled=false 时
    // 不 bind 任何端口；状态衔接 multi_device_pair_status）
    (
        "multi_device_set_enabled",
        multi_device_commands::multi_device_set_enabled
    ),
    // ── 用户账号与云端设备管理面 ──
    ("auth_login", auth_commands::auth_login),
    ("auth_logout", auth_commands::auth_logout),
    ("auth_get_session", auth_commands::auth_get_session),
    ("auth_refresh_token", auth_commands::auth_refresh_token),
    ("auth_list_devices", auth_commands::auth_list_devices),
    ("auth_revoke_device", auth_commands::auth_revoke_device),
    (
        "auth_get_relay_ticket",
        auth_commands::auth_get_relay_ticket
    ),
    // ── 会话持久化（B，§2.2）──
    ("list_sessions", session_commands::list_sessions),
    ("load_session_body", session_commands::load_session_body),
    ("save_session_body", session_commands::save_session_body),
    ("load_session_agents", session_commands::load_session_agents),
    ("save_session_agents", session_commands::save_session_agents),
    ("get_session_meta", session_commands::get_session_meta),
    ("set_session_meta", session_commands::set_session_meta),
    (
        "cleanup_orphan_sessions",
        session_commands::cleanup_orphan_sessions
    ),
    (
        "import_from_localstorage",
        session_commands::import_from_localstorage
    ),
    // F11b（T-D-12）：DAG 只读快照查询（flow_dag_visible 开关关闭时不调用，
    // 只读通用面保留无害）
    ("get_flow_snapshot", session_commands::get_flow_snapshot),
    // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族；实现函数在
    //    markdown_commands.rs，经 `#[tauri::command(rename = ...)]` 对齐 wire 名）──
    ("core_md_render", markdown_commands::md_render),
    ("core_md_render_batch", markdown_commands::md_render_batch),
    // ── 工具 Worker 组（E，§2.2）──
    ("core_hash_compute", core_commands::core_hash_compute),
    ("core_base64_encode", core_commands::core_base64_encode),
    ("core_base64_decode", core_commands::core_base64_decode),
    ("core_detect_encoding", core_commands::core_detect_encoding),
    ("core_decode_text", core_commands::core_decode_text),
    ("core_parse_diff", core_commands::core_parse_diff),
    (
        "core_messages_to_jsonl",
        core_commands::core_messages_to_jsonl
    ),
    (
        "core_jsonl_to_messages",
        core_commands::core_jsonl_to_messages
    ),
    // ── 注册表单一化自身（T03.1；经 command_manifest 注册——Tauri 宏生成项
    //    （__cmd__*）不随 core_query_commands 的 pub use 重导出，必须直引真源）──
    ("core_list_commands", command_manifest::core_list_commands),
    // ── 误删恢复（I2-S5：trash_list / trash_restore / trash_purge）──
    ("trash_list", run_ipc::trash_list),
    ("trash_restore", run_ipc::trash_restore),
    ("trash_purge", run_ipc::trash_purge),
    // ── workflow 命令面（T-CF-14：六条实装，消除前端幽灵命令；
    //    wire 名 kebab-case，经 #[tauri::command(rename=...)] 对齐）──
    ("create-workflow", workflow_ipc::create_workflow),
    ("list-workflows", workflow_ipc::list_workflows),
    ("update-workflow", workflow_ipc::update_workflow),
    ("delete-workflow", workflow_ipc::delete_workflow),
    ("trigger-workflow", workflow_ipc::trigger_workflow),
    ("list-workflow-runs", workflow_ipc::list_workflow_runs),
    // ── 浏览器面板命令（27 方案 S6：browser_start/stop/status 代理到
    //    引擎会话槽；状态变更经 browser://state-changed 事件发射）──
    ("browser_start", browser_commands::browser_start),
    ("browser_stop", browser_commands::browser_stop),
    ("browser_status", browser_commands::browser_status),
    ("browser_input", browser_commands::browser_input),
    (
        "browser_start_frames",
        browser_commands::browser_start_frames
    ),
    ("browser_stop_frames", browser_commands::browser_stop_frames),
    (
        "browser_frame_status",
        browser_commands::browser_frame_status
    ),
    (
        "browser_export_storage_state",
        browser_commands::browser_export_storage_state
    ),
    (
        "browser_import_storage_state",
        browser_commands::browser_import_storage_state
    ),
    // ── G-4 收尾：书签/历史导入（03-方案 §4.2 U4；落库编排经
    //    browser_import_sinks 适配，SharedDb 目标表面）──
    (
        "browser_import_bookmarks",
        browser_commands::browser_import_bookmarks
    ),
    (
        "browser_import_history",
        browser_commands::browser_import_history
    ),
    (
        "browser_list_bookmarks",
        browser_commands::browser_list_bookmarks
    ),
    (
        "browser_list_history",
        browser_commands::browser_list_history
    ),
    // ── 原生多 Webview 浏览器重构命令（Native Browser Overhaul）──
    (
        "browser_webview_create",
        browser::native_commands::browser_webview_create
    ),
    (
        "browser_webview_set_bounds",
        browser::native_commands::browser_webview_set_bounds
    ),
    (
        "browser_webview_set_visible",
        browser::native_commands::browser_webview_set_visible
    ),
    (
        "browser_webview_navigate",
        browser::native_commands::browser_webview_navigate
    ),
    (
        "browser_webview_action",
        browser::native_commands::browser_webview_action
    ),
    (
        "browser_webview_close",
        browser::native_commands::browser_webview_close
    ),
    (
        "browser_webview_set_muted",
        browser::native_commands::browser_webview_set_muted
    ),
    (
        "browser_webview_set_hit_test",
        browser::native_commands::browser_webview_set_hit_test
    ),
    (
        "browser_webview_set_inspector",
        browser::native_commands::browser_webview_set_inspector
    ),
    // ── Round7+：笔记双引擎 IPC（noteApi / noteHydrateIpc / noteMirrorIpc）──
    (
        "note_document_apply_md",
        note_commands::note_document_apply_md
    ),
    ("note_query_blocks", note_commands::note_query_blocks),
    ("note_send_to_note", note_commands::note_send_to_note),
    (
        "note_document_hydrate",
        note_commands::note_document_hydrate
    ),
    ("note_document_recent", note_commands::note_document_recent),
    // A-INV-02 / W2-E 产品 IPC：detect + import 提案（不 apply；X-05；≠ EL-03）
    (
        "note_detect_mirror_drift",
        note_commands::note_detect_mirror_drift
    ),
    (
        "note_import_mirror_proposal",
        note_commands::note_import_mirror_proposal
    ),
    // CONN-B3：collab wire JSON → DocSession::apply（产品 slash 写锥 IPC）
    ("note_apply_ops", note_commands::note_apply_ops),
    ("note_undo_text", note_commands::note_undo_text),
    ("note_redo_text", note_commands::note_redo_text),
    ("note_document_list", note_commands::note_document_list),
    ("note_document_create", note_commands::note_document_create),
    ("note_document_rename", note_commands::note_document_rename),
    ("note_document_delete", note_commands::note_document_delete),
    // ── D4a 命令面：子代理显式恢复与关闭（D4 §3.1/§3.2/§3.5）。
    //    Tauri 宏约束：命令函数须以模块限定路径注册（裸标识符路径触发
    //    generate_handler! 的 `__cmd__<name>` 宏命名冲突），故命令壳定义
    //    于 [lifecycle_commands] 子模块 ──
    ("resume_subagent", lifecycle_commands::resume_subagent),
    ("kill_all", lifecycle_commands::kill_all),
    ("kill_subagent", lifecycle_commands::kill_subagent),
    // ── 用量监控与时序分析面（usage_*）──
    (
        "usage_get_dashboard_data",
        usage_commands::usage_get_dashboard_data
    ),
    (
        "usage_get_activity_matrix",
        usage_commands::usage_get_activity_matrix
    ),
    ("usage_clear_history", usage_commands::usage_clear_history),
    ("usage_record_delta", usage_commands::usage_record_delta),
    (
        "usage_import_legacy_snapshot",
        usage_commands::usage_import_legacy_snapshot
    ),
    // ── 偏好持久化（Token 与偏好 SSOT 战役 N3）──
    ("prefs_get", preferences_commands::prefs_get),
    ("prefs_set", preferences_commands::prefs_set),
    ("prefs_delete", preferences_commands::prefs_delete),
    // ── MCP 管理面（BC11-1 生产真实接入）──
    (
        "workbench_list_mcp_servers",
        mcp_commands::workbench_list_mcp_servers
    ),
    (
        "workbench_start_mcp_server",
        mcp_commands::workbench_start_mcp_server
    ),
    (
        "workbench_stop_mcp_server",
        mcp_commands::workbench_stop_mcp_server
    ),
    (
        "workbench_toggle_mcp_tool",
        mcp_commands::workbench_toggle_mcp_tool
    ),
];

// ── D4a：子代理显式恢复与关闭命令壳（D4 §3.1 双端登记第 ① 步）──────

/// D4a 命令壳模块：子代理显式恢复与关闭（resume_subagent / kill_all /
/// kill_subagent）。命令体 = 同步准备（spawn_blocking，F2-27）+ 引擎侧
/// [orchestrator::lifecycle::SubagentLifecycleService] 调用。
pub(crate) mod lifecycle_commands {
    use super::*;

    /// 生命周期错误 → CoreError（命令面唯一错误协议，PE-03 T03.3）。
    ///
    /// - NotFound → `CoreError::NotFound`（目标子代理/run 不存在）；
    /// - InvalidState → `CoreError::InvalidInput`（参数或状态非法）；
    /// - PersistFailed → `CoreError::Io`（落库失败，detail 保留操作语义）；
    /// - Recovery → 按恢复域错误分类映射（预算耗尽等保持可观测）。
    fn map_lifecycle_err(
        err: orchestrator::lifecycle::LifecycleError,
    ) -> conex_run::core_error::CoreError {
        use orchestrator::lifecycle::LifecycleError;
        match err {
            LifecycleError::NotFound { message } => {
                conex_run::core_error::CoreError::NotFound(message)
            }
            LifecycleError::InvalidState { message } => {
                conex_run::core_error::CoreError::InvalidInput(message)
            }
            LifecycleError::PersistFailed { message } => {
                conex_run::core_error::CoreError::Io(format!("store.lifecycle: {message}"))
            }
            LifecycleError::Recovery(err) => match err {
                orchestrator::recovery::RecoveryError::NotFound { message } => {
                    conex_run::core_error::CoreError::NotFound(message)
                }
                orchestrator::recovery::RecoveryError::PersistFailed { message } => {
                    conex_run::core_error::CoreError::Io(format!("store.recovery: {message}"))
                }
                other => {
                    conex_run::core_error::CoreError::InvalidInput(format!("恢复域失败：{other}"))
                }
            },
        }
    }

    /// D4 §3.2：kill_subagent 命令壳——单目标终止子代理（同步 SQLite 面经
    /// spawn_blocking，F2-27；tokio worker 不执行同步 SQLite）。
    #[tauri::command]
    pub(crate) async fn kill_subagent(
        state: tauri::State<'_, Arc<conex_run::run::CoreRunState>>,
        session_id: String,
        subagent_id: String,
        reason: Option<String>,
    ) -> Result<orchestrator::lifecycle::KillSubagentResult, conex_run::core_error::CoreError> {
        let service = state.lifecycle_service().ok_or_else(|| {
            conex_run::core_error::CoreError::internal("LocalDb 不可用（测试替身 store）")
        })?;
        let reason = reason.unwrap_or_default();
        tokio::task::spawn_blocking(move || {
            service.kill_subagent(&session_id, &subagent_id, &reason)
        })
        .await
        .map_err(|e| {
            conex_run::core_error::CoreError::internal(format!("kill_subagent 阻塞任务失败：{e}"))
        })?
        .map_err(map_lifecycle_err)
    }

    /// D4 §3.1：kill_all 命令壳——批量终止主会话全部 running 子代理（同步
    /// SQLite 面经 spawn_blocking，F2-27；批量语义保持 lifecycle 引擎侧）。
    #[tauri::command]
    pub(crate) async fn kill_all(
        state: tauri::State<'_, Arc<conex_run::run::CoreRunState>>,
        session_id: String,
        reason: Option<String>,
    ) -> Result<orchestrator::lifecycle::KillAllOutcome, conex_run::core_error::CoreError> {
        let service = state.lifecycle_service().ok_or_else(|| {
            conex_run::core_error::CoreError::internal("LocalDb 不可用（测试替身 store）")
        })?;
        let reason = reason.unwrap_or_default();
        tokio::task::spawn_blocking(move || service.kill_all(&session_id, &reason))
            .await
            .map_err(|e| {
                conex_run::core_error::CoreError::internal(format!("kill_all 阻塞任务失败：{e}"))
            })?
            .map_err(map_lifecycle_err)
    }

    /// D4 §3.5：resume_subagent 命令壳——fork 新 run 承接同一目标。
    ///
    /// 两段式：
    /// - ① 同步准备段 [orchestrator::lifecycle::SubagentLifecycleService::
    ///   prepare_resume]（取行 + 定位 + kill-for-resume + 任务/叶子推导，
    ///   纯 DB + 内存）经 spawn_blocking（F2-27）；
    /// - ② fork 段 [orchestrator::lifecycle::SubagentLifecycleService::
    ///   resume_with_prepared] 经调用方持有的 RecoveryCoordinator 权威
    ///   实例（D3 装配；未装配 → 结构化错误「恢复协调器未装配」——全原生异步
    ///   获取 L2 锁并 await 执行，零 block_on 违规）。
    #[tauri::command]
    pub(crate) async fn resume_subagent(
        state: tauri::State<'_, Arc<conex_run::run::CoreRunState>>,
        session_id: String,
        subagent_id: String,
        prompt: Option<String>,
    ) -> Result<orchestrator::lifecycle::ResumeOutcome, conex_run::core_error::CoreError> {
        let service = state.lifecycle_service().ok_or_else(|| {
            conex_run::core_error::CoreError::internal("LocalDb 不可用（测试替身 store）")
        })?;
        // ① 同步准备段（F2-27：同步 SQLite 面经 spawn_blocking）
        let prepared = {
            let service = service.clone();
            let sid = session_id.clone();
            let aid = subagent_id.clone();
            tokio::task::spawn_blocking(move || {
                service.prepare_resume(&sid, &aid, prompt.as_deref())
            })
            .await
            .map_err(|e| {
                conex_run::core_error::CoreError::internal(format!(
                    "resume 准备段阻塞任务失败：{e}"
                ))
            })?
            .map_err(map_lifecycle_err)?
        };
        // ② fork 段：全异步获取 L2 锁并执行，零 block_on
        let coord = state.coordinator_for(&session_id).ok_or_else(|| {
            conex_run::core_error::CoreError::internal(
                "恢复协调器未装配（D3 未接线，resume 暂不可用）",
            )
        })?;

        let mut coordinator = coord.lock().await;
        service
            .resume_with_prepared(&mut coordinator, &session_id, prepared)
            .await
            .map_err(map_lifecycle_err)
    }
}

/// 当前生效日志级别：`CRISH_LOG_LEVEL` 优先，dev debug / release info
/// （PE-04 T04.1-1：非法值由 conex-telemetry 内部回退 info）。
fn log_level_from_env() -> String {
    std::env::var("CRISH_LOG_LEVEL").unwrap_or_else(|_| {
        if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "info".to_string()
        }
    })
}

fn main() {
    // setup 序列 ①（前置）：tracing 初始化在 Builder 装配之前，保证后续
    // 日志可用（PE-04 T04.1-1 双通道：文件层 + stderr）。
    let app_dir = crate::host_paths::app_dir().unwrap_or_default();
    let log_dir = app_dir.join("logs");
    let level = log_level_from_env();
    conex_telemetry::init_default(
        &level,
        Some(conex_telemetry::FileConfig {
            dir: log_dir.clone(),
            file_name_prefix: "workbench".to_string(),
        }),
    );
    // 崩溃文件（T04.1-3）：与日志同目录，panic 现场独立落盘。
    // T5-1b（崩溃台账）：崩溃文件写成功后，conex-telemetry 内部把
    // 「最后一次崩溃文件名 + 时刻」记入进程内共享标记（leaf crate 边界，
    // 不依赖 tauri，无需 manage State）——`core_get_status.lastCrash`
    // 经 `conex_telemetry::last_crash_marker()` 读出（core_query_commands.rs），
    // 前端心跳轮询一并读取，把「死文件」变成前端可读的崩溃台账。
    conex_telemetry::install_panic_hook_with_crash_dir(Some(log_dir.clone()));

    // RUN-06：日志保留策略生产接线（启动时执行一次）——crash 保留最近 N 个、
    // 按日轮转日志超龄删除、目录总量超限旧 → 新清理；清理数量与失败原因
    // 由 cleanup_logs 内部 tracing 记录（target=telemetry）。当日活跃日志
    // 文件不在清理面（按日龄/总量旧→新顺序），tracing 文件层句柄不受影响。
    let _retention_deleted =
        conex_telemetry::cleanup_logs(&log_dir, &conex_telemetry::LogRetention::default());

    // RUN-05：release 形态旧数据一次性迁移（exe 目录 → app data dir；dev no-op）。
    // 复制语义：旧目录（可能为只读安装位）原数据永不动 = 失败可回滚不丢数据；
    // 迁移标记 + 目标已有 sessions.db 双短路保证重复启动不重复迁移。
    let legacy_migration = crate::host_paths::migrate_legacy_release_data(&app_dir);

    // RUN-05 验收证据：启动日志打印三处真实路径（应用数据根 / DB / 日志）
    // + 工作区根，与迁移结果一并落日志（排障时可直接核对实际落盘位置）。
    tracing::info!(
        target: "host_paths",
        app_dir = %app_dir.display(),
        db_path = %app_dir.join("sessions.db").display(),
        log_dir = %log_dir.display(),
        workspace_root = %crate::host_paths::workspace_root(&app_dir).display(),
        legacy_migration = ?legacy_migration,
        "宿主路径与旧数据迁移结果"
    );
    if let crate::host_paths::LegacyMigration::Failed { reason } = &legacy_migration {
        tracing::warn!(
            target: "host_paths",
            reason = %reason,
            "旧数据迁移失败：原数据完好保留在旧目录，本次以空库自愈启动（下次启动自动重试）"
        );
    }

    // 共享诊断（PE-04 T04.5）：CoreRunState 与 core_get_status 共用同一实例，
    // main.rs 先构造再注入，避免「写入侧与读取侧实例漂移」。
    let diagnostics = Arc::new(conex_run::status_diagnostics::StatusDiagnostics::new());
    // setup 闭包为 'static：预克隆需要跨闭包持有的所有权
    let setup_diagnostics = Arc::clone(&diagnostics);
    let setup_log_dir = log_dir.clone();
    let setup_level = level.clone();
    let setup_app_dir = app_dir.clone();

    // G-1（R1-09）：本地服务生命周期槽（句柄 + serve task 单一真源）。
    // rebind 钩子与退出钩子共用同一实例——重建后句柄自动更新，退出关停
    // 无需再依赖 Tauri state 注入；setup 与退出闭包各自预克隆。
    let server_lifecycle: Arc<std::sync::Mutex<ServerLifecycle>> =
        Arc::new(std::sync::Mutex::new(ServerLifecycle::default()));
    let setup_lifecycle = Arc::clone(&server_lifecycle);
    let exit_lifecycle = Arc::clone(&server_lifecycle);

    // G-2 单实例锁（R1-09）：官方插件必须**最先**注册——插件 setup 在
    // build() 阶段执行，第二实例在此即 cleanup + exit(0)，不会走到 run()
    // （不初始化窗口/本地服务 8765-8775/数据库），端口竞争由此消除；
    // 首实例在插件回调里执行窗口前置提示（single_instance.rs）
    let builder = tauri::Builder::default()
        .plugin(single_instance::register())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_persisted_scope::init())
        // 自动更新（RUN-03/SEC-02/GAP-01）：官方 updater 插件；通道配置读
        // tauri.conf.json `plugins.updater`（endpoints/pubkey），Minisign 验签
        // 在插件内完成；命令面接线见 src/updater.rs
        .plugin(tauri_plugin_updater::Builder::new().build());

    // setup 序列 ⑩：MCP 调试插件（debug 默认开启，CRISH_MCP_SOCKET=0 显式关闭；
    // release 由插件自身拒绝兜底，注册点本身亦被 cfg 隔离。2026-08-21 用户裁决）。
    #[cfg(debug_assertions)]
    let builder = dev_mcp::register_if_enabled(builder);

    builder
        .invoke_handler(build_invoke_handler())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let diagnostics = &setup_diagnostics;
            let log_dir = &setup_log_dir;
            let level = &setup_level;

            // ① 已完成（main 入口）；日志目录记录进诊断
            diagnostics.record("telemetry", true, Some(log_dir.display().to_string()));

            // ①b ACT-101：窗口握手状态 + 1000ms 原生看门狗（RISK-MED-02）
            // —— 必须在双库装配前托管：握手命令 / second-launch / 看门狗
            // 三路共用 WindowHandshakeState.shown CAS 门闩。
            // StatusDiagnostics 同步前置 manage：workbench_window_ready / 看门狗
            // 均依赖 State<Arc<StatusDiagnostics>>，若拖到 ⑥ 才注入会 Command 错误。
            let handshake = Arc::new(window_handshake::WindowHandshakeState::new());
            app.manage(Arc::clone(&handshake));
            app.manage(Arc::clone(diagnostics));
            // 自动更新三段式会话槽（check→download→install 交接面，updater.rs）
            app.manage(updater::UpdaterSession::default());
            window_handshake::spawn_window_guard_dog(
                app_handle.clone(),
                window_handshake::DEFAULT_WATCHDOG_TIMEOUT,
            );

            // ①c 原生窗口系统材质（Win11 Mica 云母 / Solid 阶梯回退）
            if let Some(main_window) = app.get_webview_window(window_handshake::MAIN_WINDOW_LABEL) {
                window_backdrop::setup_window_backdrop(app, &main_window, diagnostics);
            }

            // ② 双 SQLite 并发装配（ACT-102 / INV-02 Phase-1）：
            // spawn_blocking 并发 open sessions.db + workspace.db；
            // setup 为同步闭包且 SharedDb / NoteRuntime 必须在返回前
            // manage —— 经 block_on 汇聚（内部仍并发，非串行 I/O）。
            // 禁止回潮为同步串行 open_session_db + init_default。
            let db_init = tauri::async_runtime::block_on(
                db_setup::setup_databases_concurrently(
                    setup_app_dir.clone(),
                    Arc::clone(diagnostics),
                ),
            )
            .map_err(|e| {
                tracing::error!(target: "db", error = %e, "双库并发装配任务 join 失败");
                e
            })?;
            let shared_db = db_init.session_db;
            let store: Arc<dyn orchestrator::persist::Store> =
                Arc::new(orchestrator::persist::LocalDbStore::new(shared_db.local_db()));

            // ②b NoteRuntime（并发路径已打开；失败保持 unwired）
            match db_init.note_runtime {
                Some(shared) => {
                    let path_display = shared.path().display().to_string();
                    diagnostics.record("note_runtime", true, Some(path_display));
                    app.manage(shared);
                }
                None => {
                    // 失败已在 db_setup 内记诊断（note_runtime error 分支）
                }
            }

            // ②c 双库装配完成 → 置位 db_ready 并通知握手等待者
            // （含降级路径：完成即置位，窗口不因 db 失败而死锁）
            handshake.mark_db_ready();

            // ③ 初始化唯一配置存储及已提交变更事件
            if let Err(error) = config::init_models_store(&app.handle().clone()) {
                diagnostics.record("models-config", false, Some(error.to_string()));
                tracing::error!(error = %error, "模型配置初始化或监听失败");
            }

            // ④ 工作区注册表（沙箱根真源；加载 recent 列表 + 默认应用根）
            match workspace::WorkspaceRegistry::init() {
                Ok(registry) => {
                    match asset_scope::allow_registered_workspace_roots(
                        app.handle(),
                        registry.roots(),
                    ) {
                        Ok(()) => diagnostics.record("workspace", true, None),
                        Err(error) => {
                            tracing::error!(
                                target: "workspace",
                                error = %error,
                                "无法将已授权工作区接入 asset 协议"
                            );
                            diagnostics.record("workspace", false, Some(error));
                        }
                    }
                    app.manage(registry);
                }
                Err(error) => {
                    tracing::error!(
                        target: "workspace",
                        error = %error,
                        "WorkspaceRegistry 初始化失败（文件命令按 outside_workspace 拒绝）"
                    );
                    diagnostics.record("workspace", false, Some(error.to_string()));
                }
            }

            // ④b 回收站根注入（I2-S5：None = 未注入 → 命令侧回退活动
            // 工作区 `.crish-trash`，与删除工具兜底一致；对齐
            // BuiltinToolConfig.trash_root 语义）
            app.manage(conex_run::run::TrashRootConfig::default());

            // ⑤ 共享状态：命令闸门 / 搜索索引 / 压缩能力标记
            app.manage(core_commands::SharedGatekeeper::new());
            // 只读面就绪事实快照（CoreStateBackend 注入消费；启动时索引
            // 为空 → false 诚实降级，重建后由命令面更新——核心状态查询
            // 与命令面共享同一事实源）
            // C21 接线：托管类型为 Arc<SharedSearchState>（对齐
            // Arc<CoreRunState> 先例）——命令面（core_search_files /
            // core_rebuild_search_index / core_get_status）与本地服务后端
            // （with_search_state 注入，见 ⑪a）经 Arc clone 共享同一实例，
            // 索引重建立即可见；tauri State 只暴露 &T 引用无法回取 Arc，
            // 故托管面本身必须是 Arc（未接线命令面为历史直管形态）。
            let search_state = Arc::new(core_commands::SharedSearchState::new());
            let search_index_ready = !search_state
                .files
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty();
            app.manage(Arc::clone(&search_state));
            let compaction = core_commands::SharedCompactionState::new();
            // 压缩为纯内存能力（conex-compaction），core_compact_messages 已接线）
            compaction.set_ready(true);
            let compaction_ready = compaction.is_ready();
            app.manage(compaction);

            // ⑤b 多端互通配对协调器（R1-07：令牌库 + WS 注册表；重绑钩子与
            // 端口由服务装配面（R1-11 G-1）注入；命令面先独立可用）。
            // Arc 形态托管：命令面（State<Arc<PairingCoordinator>>）与服务
            // 装配（restart_server 注入 set_port / rebind 钩子）共用同一实例。
            let pairing_tokens = crate::server::auth::TokenStore::load(
                &app.path()
                    .app_config_dir()
                    .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default())
                    .join("pairing.json"),
            );
            // G-1：WS 注册表保留 Arc 副本（唤醒恢复「已有 WS 踢重连」消费；
            // 与协调器内部持有的是同一实例；P2-5 裁决后同时注入
            // MultiDeviceService.ws_registry——路由层 / push presence /
            // 直投 / 撤销踢链全链共享同一实例）
            let ws_registry = Arc::new(crate::server::ws::WsRegistry::new());
            let pairing = Arc::new(crate::server::pairing::PairingCoordinator::new(
                std::sync::Arc::new(std::sync::Mutex::new(pairing_tokens)),
                Arc::clone(&ws_registry),
            ));
            app.manage(Arc::clone(&pairing));

            // 用户账号中心管理与系统级凭据安全存储（DPAPI）。
            // Base URL 配置化（audit-repair-202609 T16）：缺省生产地址
            // auth.flowbit.me，可经 CRISH_AUTH_BASE_URL 环境变量覆盖。
            let auth_base_url = std::env::var("CRISH_AUTH_BASE_URL")
                .ok()
                .filter(|v| !v.trim().is_empty());
            let auth_manager =
                crate::auth::AuthManager::new(setup_app_dir.clone(), auth_base_url);
            app.manage(auth_manager);

            // ⑥ 状态诊断已在 ①b 前置 manage（与 CoreRunState 共享同一实例）；
            //    此处不再重复 manage（Tauri manage 同类型重复注入会 panic）。

            // 事件桥（B6.3：workbench-run-event 通道；Tauri 发射器）——R3-02
            // 推送装配（D7 §9.2 方案 a）：PushAwareEmitter 装饰内层发射器
            // （转发原通道不变 + 旁路 push-core 决策与双轨分发——在线 WS
            // 直推 / 离线 pending 内存队列，R3-03 厂商发送器消费）。在线
            // 判定与直投数据源 = 共享 WsRegistry（与配对协调器同一实例，
            // 见 ⑤b；P2-5 裁决后路由层 ServerState 亦注入该共享实例——
            // 连接面全链统一，presence/直投/撤销观察真实连接）；适配层在
            // push_wiring.rs（Emitter 双向桥 + WsRegistry 适配 + 直投）
            let browser_emitter_handle = app_handle.clone();
            let push_dispatcher = Arc::new(crish_agent_workbench::push::PushDispatcher::new(
                Arc::clone(&ws_registry) as Arc<dyn crish_agent_workbench::push::DevicePresenceSource>,
                Arc::new(push_wiring::WsPushChannel::new(Arc::clone(&ws_registry)))
                    as Arc<dyn crish_agent_workbench::push::PushChannel>,
            ));
            let push_aware = Arc::new(crish_agent_workbench::push::PushAwareEmitter::new(
                // PushAwareEmitter 直接实现 conex_run::core_event_bridge::Emitter
                // （push/pusher.rs；双 trait 桥随 core_event_bridge 下沉合一删除）
                Arc::new(TauriEmitter::new(app_handle.clone()))
                    as Arc<dyn conex_run::core_event_bridge::Emitter>,
                push_dispatcher,
            ));
            let bridge = EventBridge::new(
                "workbench-run-event",
                // 桥上行（bin Emitter for lib PushAwareEmitter）在 push_wiring.rs
                Arc::clone(&push_aware) as Arc<dyn Emitter>,
            );

            // 快照存储（B4.3：主文件 + .prev 备份双文件模型）
            let snapshot_path = setup_app_dir.join("orchestrator-snapshot.json");
            let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> =
                Arc::new(orchestrator::restore::SnapshotFileStore::new(&snapshot_path));

            // ⑧b 后台任务注册表（T-AB-07：G1 最小底座）独立托管（不并入
            // CoreRunState，职责单一）。回收语义：run 结束不回收任务（会话级
            // 存活）；应用退出 → process.rs daemon Job 兜底全杀（孤儿保护与
            // PTY Job 同族且相互隔离）。工具执行器装配 ToolContext.background
            // 经 BuiltinToolConfig 透传（冻结接口 #1）：引擎侧接线点在
            // engine.rs:617（F1 轮末已装配 register_builtin_tools_with_config）。
            let background_tasks = Arc::new(background::BackgroundTaskRegistry::new());

            // ⑥' 引擎宿主（browser/computer 槽 + workflow 创建通道绑定 +
            // 全局注入：配置源 / runtime 句柄 / 应用数据目录 / 笔记后端）。
            // **必须先于 CoreRunState::new**——引擎装配经 EngineHostHooks
            // 消费宿主（browser 工具注册）；db 注入 timer/sched/wait/computer
            // 四 store 真适配。
            let engine_host = engine::EngineHost::new(Some(shared_db.local_db()));

            // 核心运行状态（store / 快照 / 事件桥 / 诊断 / 后台任务管理器注入）
            let core_state = Arc::new(conex_run::run::CoreRunState::new(
                Arc::clone(&store),
                Arc::clone(&snapshots),
                bridge.clone(),
                Arc::clone(diagnostics),
                Some(Arc::clone(&background_tasks)
                    as Arc<dyn agent_tools::background::BackgroundTaskManager>),
            ));
            // T-D-13：子代理 spawner 注入面装配（launcher / db / wait 广播 /
            // steering 队列——Arc 构造完成后注入，spawner 在 engine 内）
            core_state.finalize_subagent_spawner();
            // 全局运行策略读入（用户裁决：重试预算/上限可配置，进
            // settings.json 不绑供应商；文件缺失/解析失败 → 缺省）
            core_state.set_run_policy(
                config::persistence::config_dir()
                    .ok()
                    .and_then(|dir| conex_run::run_policy::read_run_policy_from(&dir)),
            );
            // 审计 01 W1（任务连续性推进轮）：kill_subagent / send_message
            // 三通道 + WaitChannel 控制总线解析器生产装配（与 spawner 同批
            // ——Arc 构造完成后经板卡绑定真实现，工具从 unsupported 升级为
            // 生产可用）
            core_state.finalize_continuity_channels();
            // 引擎句柄绑定宿主（browser/computer/workflow 通道访问面）+
            // MCP 自动拉起（auto_start 配置）
            engine_host.bind_engine(core_state.engine());
            engine_host.spawn_mcp_autostart();

            // ⑦ restore：run_in_runtime 在 manage(CoreRunState) 之前执行
            //（成功 seed_sequences + 立即快照；失败降级不阻断，门禁经
            // restore_ready 放行——conex_run::run::run_snapshot 语义）
            {
                let restore_state = Arc::clone(&core_state);
                tauri::async_runtime::spawn(async move {
                    let _ = restore_state.run_restore().await;
                });
            }

            // ⑧ CoreRunState / EventBridge / SharedDb / 后台任务注册表 manage
            // （bridge 以 clone 入管：原值继续供任务事件接线与 drain 任务使用）
            app.manage(Arc::clone(&core_state));
            app.manage(bridge.clone());
            app.manage(shared_db.clone());
            app.manage(Arc::clone(&background_tasks));

            // ⑧d 27 方案 S6：浏览器会话槽事件发射器接线——`browser://state-changed`
            // 状态迁移 → 前端面板（挂接幂等：命令面后续 attach 无副作用；
            // 启动前即挂订阅，首启 Launching→Running 迁移不丢事件）
            engine_host
                .browser_slot()
                .attach_emitter(Arc::new(TauriEmitter::new(browser_emitter_handle)));

            // ⑧e 06 遗留⑨：电脑操作会话槽装配——进程级单例托管
            // （ComputerSlot：session_meta `computer_use_enabled` 惰性恢复 +
            // 互斥门；命令面 computer_session_* 消费）。
            // 事件发射器接线：`computer://state-changed` 状态迁移 → 前端面板
            // （挂接幂等；启动前即挂订阅，enable/disable/on_run_stopped 不丢事件）。
            // 宿主持有同一实例；main.rs 取用托管给 Tauri State，命令访问面不变。
            {
                let computer_slot = engine_host.computer_slot();
                app.manage(Arc::clone(&computer_slot));
                computer_slot.attach_emitter(Arc::new(TauriEmitter::new(app_handle.clone())));
            }

            // 浏览器槽托管给 Tauri State（browser_commands 命令访问面）
            app.manage(engine_host.browser_slot());
            let native_browser_manager =
                crate::browser::NativeWebviewManager::new(setup_app_dir.clone());
            app.manage(native_browser_manager);

            // ⑧b+ 30 方案 P2/P3 装配：后台任务事件面接线（生产发射链）——
            // ① 任务事件消费器注入（先于 set_event_bridge：EventBridgeSink
            // 构造时读取消费器快照，顺序契约见 task_event_consumer.rs 模块
            // 头）；② 事件桥并入通知投递器（替换默认 LogEventSink 留痕，
            // 七事件经 workbench-run-event 发射 + security-audit 直发）
            background_tasks.set_task_event_consumer(core_state.task_events());
            background_tasks.set_event_bridge(bridge.clone(), String::new());

            // ⑧c workflow 命令后端（T-CF-14：六条命令的托管状态；30 方案
            // P6 装配收口：steering 队列注入引擎共享队列（消除 A5-H01a
            // 队列双实例——trigger 注入真实落引擎队列，idle 续 run 消费
            // 唤醒）；SchedulerRegistry 委托经 set_registry 注入共享注册
            // 表（create 即真实注册调度，A5-H01b 生产转正））
            let workflow_state = workflow_ipc::WorkflowCommandState::new(
                shared_db.local_db(),
                core_state.steering_queue(),
            );
            let workflow_backend = workflow_state.backend_handle();
            workflow_backend.set_app_context(
                setup_app_dir.clone(),
                Some(Arc::new(workflow_ipc::TauriWorkflowEventSink::new(
                    app_handle.clone(),
                ))),
            );
            let scheduled_launcher: Arc<dyn conex_run::sched::ScheduledTaskLauncher> =
                Arc::new(conex_run::workflow::ProductionScheduledLauncher::new(
                    Arc::new(workflow_ipc::TauriWorkflowEventSink::new(
                        app_handle.clone(),
                    )),
                    Arc::clone(&core_state),
                    Arc::clone(&workflow_backend),
                    setup_app_dir.clone(),
                ));
            workflow_backend.set_launcher(Arc::clone(&scheduled_launcher));
            if let Some(reg) = core_state.scheduler_registry() {
                workflow_state.set_registry(Arc::clone(&reg));
                reg.set_launcher(Arc::clone(&scheduled_launcher));
                let reg_restore = Arc::clone(&reg);
                tauri::async_runtime::spawn(async move {
                    reg_restore.restore().await;
                    tracing::info!(target: "setup", "SchedulerRegistry 异步启动恢复完成");
                });
            } else {
                tracing::warn!(
                    target: "setup",
                    "SchedulerRegistry 装配降级（workflow 走命令层独立退化路径，Cron 不参与续 run 判定）"
                );
            }

            let orphan_reaper = Arc::clone(&workflow_backend);
            tauri::async_runtime::spawn(async move {
                orphan_reaper.reap_orphan_running_runs();
                tracing::info!(target: "setup", "历史孤儿运行记录自愈收割完成");
            });
            // 维度五（05 详案 §2.4 路径 A）：create_workflow 工具通道生产
            // 转正——backend + AppHandle 注入延迟绑定面（绑定前工具
            // 返回 common.unsupported；注册链路复用 create-workflow 同一
            // 校验/注册后端，无第二套实现）
            engine_host
                .workflow_creation_channel()
                .bind(workflow_state.backend_handle(), app_handle.clone());
            app.manage(workflow_state);


            // 30 方案 P4 + Stage 6 ACT-602：timer/cron 事件 drain 改为
            // tokio::sync::Notify 事件驱动——sink.emit 即 notify_one，
            // 无事件时协程挂起于 notified().await（待机 0 Hz），取代旧
            // 500ms 盲 sleep 循环。drain 仍为 Vec::take 语义，空缓冲零开销；
            // 双 sink 各自持 Notify，select 任一唤醒后两路都 drain（防漏）
            {
                let timer_sink = core_state.timer_event_sink();
                let sched_sink = core_state.scheduler_event_sink();
                let drain_bridge = bridge.clone();
                let timer_notify = timer_sink.wake_notify();
                let sched_notify = sched_sink.wake_notify();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::select! {
                            _ = timer_notify.notified() => {}
                            _ = sched_notify.notified() => {}
                        }
                        conex_run::engine_channels::forward_drained_timer_events(&timer_sink, &drain_bridge);
                        conex_run::engine_channels::forward_drained_scheduler_events(&sched_sink, &drain_bridge);
                    }
                });
            }

            // R3-02：推送决策合并桶 drain —— Notify + next_expiry_ms 事件驱动
            // （取代旧 500ms 固定 sleep；无桶时最长 60s 挂起，入桶即唤醒）
            {
                let push_emitter = Arc::clone(&push_aware);
                tauri::async_runtime::spawn(async move {
                    let wake = push_emitter.wake_notify();
                    loop {
                        let now = server::now_ms();
                        let wait_ms = push_emitter
                            .next_expiry_ms(now)
                            .map(|exp| exp.saturating_sub(now))
                            .unwrap_or(60_000)
                            .clamp(10, 60_000);
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_millis(wait_ms)) => {}
                            _ = wake.notified() => {}
                        }
                        push_emitter.flush(server::now_ms());
                    }
                });
            }

            // 周期快照（T08.6 触发点 B：默认 60s，仅活动 run 存在时保存；
            // 幂等，restore 完成与否均可启动）
            core_state.spawn_snapshot_loop();

            // T5-2：孤儿 run 收割周期任务（默认 60s，复用 spawn_snapshot_loop
            // 骨架；驱动任务 is_finished 且连续 ORPHAN_REAP_DEBOUNCE_ROUNDS
            // 轮仍停留 activeRuns → finalize_failed 补写终态——run panic
            // 无终态事件导致的卡死/孤儿条目消除。幂等，可随时启动）
            core_state.spawn_run_reaper_loop();

            // P3：子代理心跳落库周期任务（默认检查 5s；实际节奏由会话级
            // AgentPolicy.recovery.heartbeatIntervalMs 决定，SQL 条件写去重）。
            // 幂等，可随时启动；无 DB 的测试路径自动跳过。
            core_state.spawn_subagent_heartbeat_loop();

            // PTY GC：Stage 6 ACT-605——setup 不再盲启 30s 周期协程；
            // 首次 workbench_pty_create 成功后经 notify_pty_activity 惰性
            // CAS 拉起，注册表连续两拍为空时主动自销毁（待机 0 Hz）。

            // setup 完成标记（PE-01 T01.2：initialized 如实反映）
            core_state.mark_initialized();

            // ⑪ 本地服务生产装配（R1-11 G-1：真实后端 + 事件扇出 + 配对
            // 协调器端口/钩子 + D5 红线 1 服务开关；G-1（R1-09）重绑钩子
            // 与电源监视同址装配）。启动失败 = 仅关多端服务，不阻断应用
            // （D1 §3.4 铁律；诊断经 StatusDiagnostics 环形缓冲如实上报，
            // core_get_status 可见）
            {
                // ⑪a 核心装配依赖（仅构造一次，重启/重绑复用同一实例）：
                // - CoreStateBackend：直调既有 *_impl 契约体（R1-04），
                //   注入 ServerState.backend（router 非 None 路径）；
                // - FanOutEmitter：挂 EventBridge 汇聚点（attach_fanout）
                //   ——引擎全事件流自动双通道（webview + 跨端广播）；
                //   并注入 ServerState.event_stream（WS drain task 消费，
                //   L4-4/6/7 实时推送与续传数据源）
                // ⑪a-C21：搜索索引注入（与命令面 SharedSearchState 同一
                // 实例——with_search_state 取 ⑤ 的 Arc clone，索引重建后
                // search_files / get_search_index 立即生效，不再
                // engine_not_ready）+ 工作区根注入（注册表活动根 canonical
                // 路径，relPath 剥离依据；注册表未托管 / 根不可达 → 不注入
                // 根，relPath 回退原路径，search_files 本身不受影响）
                let mut backend =
                    core_backend::CoreStateBackend::new(Arc::clone(&core_state))
                        .with_search_index_ready(search_index_ready)
                        .with_compaction_ready(compaction_ready)
                        .with_search_state(Arc::clone(&search_state));
                if let Ok(guard) = crate::workspace::resolve_guard(&app_handle, "") {
                    backend = backend.with_search_root(guard.root().to_string_lossy().into_owned());
                }
                let backend: Option<Arc<dyn server::backend::ApiBackend>> = Some(Arc::new(backend));
                let fanout = Arc::new(server::fanout::FanOutEmitter::new(vec![]));
                bridge.attach_fanout(Arc::clone(&fanout) as Arc<dyn conex_run::core_event_bridge::Emitter>);

                // ⑪b 多端服务装配状态（单一真源：重启 / 开关命令 / 退出
                // 钩子共用同一生命周期槽与依赖实例——重建后句柄自动更新）
                let md_service = Arc::new(MultiDeviceService {
                    lifecycle: Arc::clone(&setup_lifecycle),
                    diagnostics: Arc::clone(diagnostics),
                    backend,
                    fanout: Some(fanout),
                    audit_bridge: Some(bridge),
                    pairing: Arc::clone(&pairing),
                    // P2-5 连接面共享接线：同一共享注册表注入路由层（与
                    // push presence / 直投 / 配对协调器 / 唤醒踢链同实例）
                    ws_registry: Arc::clone(&ws_registry),
                    base: server::config::ServerConfig::default(),
                    // D5 D-01：服务默认关闭（enabled=false 时 restart_server
                    // 不 bind 任何端口——红线 1「无任何端口监听」可验证）
                    enabled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                });
                app.manage(Arc::clone(&md_service));

                // rebind 防抖：重建进行中忽略重复触发（低频事件：配对
                // 切换 / 睡眠唤醒，重建通常 1s 内完成）
                let rebinding = Arc::new(std::sync::atomic::AtomicBool::new(false));

                // 重绑钩子（R1-07 配对模式切换 fire_rebind 与 G-1 唤醒
                // 恢复共用）：目标模式（Lan/Loopback）→ 关停旧实例 → 等
                // 端口释放 → 重建；真实重建经 tauri::async_runtime 派发。
                // 服务开关关闭（enabled=false）时 restart_server 直接停服
                // 不 bind（红线 1）——配对切换与唤醒重绑均受开关门控。
                let rebind_hook: crate::server::pairing::RebindHook = {
                    let rebinding = Arc::clone(&rebinding);
                    let md_service = Arc::clone(&md_service);
                    Arc::new(move |lan: bool| {
                        if rebinding.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            tracing::info!(target: "server", lan, "重绑进行中，跳过重复触发");
                            return;
                        }
                        let mut config = md_service.base.clone();
                        config.bind_mode = if lan {
                            server::config::BindMode::Lan
                        } else {
                            server::config::BindMode::Loopback
                        };
                        config.pairing_enabled = lan;
                        config.multi_device_enabled = md_service.enabled();
                        // Fn 闭包可被多次调用：每次调用内 clone 一份所有权
                        // 供 async 任务消费（捕获变量不可整体 move）
                        let rebinding = Arc::clone(&rebinding);
                        let md_service = Arc::clone(&md_service);
                        tauri::async_runtime::spawn(async move {
                            restart_server(config, &md_service).await;
                            rebinding.store(false, std::sync::atomic::Ordering::SeqCst);
                        });
                    })
                };
                // 装配进配对协调器（配对切换与唤醒恢复共用同一钩子）
                pairing.set_rebind_hook(Arc::clone(&rebind_hook));

                // G-1 电源监视：唤醒事件 → lan 态判定 → rebind(true) +
                // WS 全量踢重连（Windows 注册 Suspend/Resume 回调；
                // 非 Windows no-op）
                crate::system_power::start({
                    let wake_app = app.handle().clone();
                    let rebind_hook = Arc::clone(&rebind_hook);
                    let ws_registry = Arc::clone(&ws_registry);
                    Arc::new(move || {
                        let pairing =
                            wake_app.state::<Arc<crate::server::pairing::PairingCoordinator>>();
                        let recovered = crate::system_power::run_resume_recovery(
                            pairing.pairing_enabled(),
                            &*rebind_hook,
                            &|| crate::system_power::kick_all_ws(&ws_registry),
                        );
                        if !recovered {
                            tracing::debug!(target: "system-power", "唤醒但处于 loopback 态，无需重绑");
                        }
                    })
                });

                // 初始启动（服务开关默认关闭 → 记录诊断不监听；与重绑
                // 共用同一重建路径——红线 1 语义由 restart_server 门控）
                {
                    let md_service = Arc::clone(&md_service);
                    tauri::async_runtime::spawn(async move {
                        restart_server(md_service.current_config(), &md_service).await;
                    });
                }
            }

            // 启动期后台搜索索引自动预热（RUN-04/GAP-09 收口）：多根全量、
            // 失败可见（根级/条目级 warn 记录，不静默）、边界受 WarmupLimits
            // 约束（默认 100_000 文件 / 30s 全根合计，超限如实标记）。
            {
                let search_state = Arc::clone(&search_state);
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(reg) = app_handle.try_state::<crate::workspace::WorkspaceRegistry>() {
                        let roots: Vec<String> = reg
                            .roots()
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        if roots.is_empty() {
                            tracing::debug!(target: "search", "无已授权工作区根，跳过索引预热");
                            return;
                        }
                        let built = tokio::task::spawn_blocking(move || {
                            conex_search::warmup::warm_index(
                                &roots,
                                &conex_search::warmup::WarmupLimits::default(),
                            )
                        })
                        .await;
                        match built {
                            Ok(report) => {
                                if !report.is_clean() {
                                    tracing::warn!(
                                        target: "search",
                                        root_count = report.root_count,
                                        root_errors = report.root_errors.len(),
                                        entry_errors = report.entry_error_count,
                                        truncated = report.truncated,
                                        timed_out = report.timed_out,
                                        "搜索索引预热不干净（存在失败或被边界截断，详见预热日志）"
                                    );
                                }
                                let count = report.files.len();
                                if let Ok(mut lock) = search_state.files.write() {
                                    *lock = Arc::new(report.files);
                                    tracing::info!(
                                        target: "search",
                                        file_count = count,
                                        root_count = report.root_count,
                                        "启动期后台搜索索引自动预热构建完成"
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    target: "search",
                                    error = %e,
                                    "搜索索引预热任务失败（spawn_blocking join error）"
                                );
                            }
                        }
                    }
                });
            }

            tracing::info!(
                target: "setup",
                level = %level,
                commands = COMMAND_REGISTRY_NAMES.len(),
                "setup 完成（IPC 模式）"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            // 退出钩子：PTY 清理（优雅路径）+ 退出前快照保存（独立线程，
            // save_snapshot_blocking 为阻塞语义，不拖累事件循环收口）。
            // PERSIST-02 P1-2：restore 未完成或失败时保存被
            // build_and_save_snapshot 门禁拒绝（restore_ready 未置位 /
            // restore_failed 已置位）——防「0 会话半水合快照」覆盖主快照
            // 导致会话树分支历史永久丢失；跳过时 snapshot_last_error 可观测。
            if let tauri::RunEvent::Exit = event {
                // 本地服务优雅关停（D2 §5.3：先停服务再存快照；客户端收到
                // 服务端关闭信号，避免误判断线重试风暴）。句柄经生命周期
                // 槽取得——rebind 重建后句柄已更新，同样覆盖
                if let Some(server) = exit_lifecycle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .handle
                    .take()
                {
                    server.shutdown();
                }
                pty::kill_all_sessions();
                // 原生子 Webview 关闭：RunEvent::Exit 在 cleanup_before_exit 之前触发，
                // 回调已回到主线程——Tauri 的 with_webview 在主线程走同步内联快路径，
                // 因此 block_on 不会与事件循环互锁。close_all 同时注销 COM Token 并
                // 删除 Ephemeral UDF 目录（强杀遗留由下次启动 GC 兜底）。
                if let Some(native_browser) =
                    app_handle.try_state::<crate::browser::NativeWebviewManager>()
                {
                    tauri::async_runtime::block_on(native_browser.close_all());
                }
                if let Some(core) = app_handle.try_state::<Arc<conex_run::run::CoreRunState>>() {
                    let core = Arc::clone(core.inner());
                    std::thread::spawn(move || core.save_snapshot_blocking());
                }
            }
        });
}

/// 本地服务生命周期槽（G-1 装配）：当前句柄 + serve task 的单一真源。
///
/// 退出钩子经 handle 优雅关停；重绑（rebind 钩子）先取走旧 task 并 await
/// （serve 收尾 = listener 释放，端口立即可重绑）再重建——保证睡眠唤醒 /
/// 配对切换后端口不漂移（移动端重连沿用旧地址与二维码内嵌端口）。
/// 槽由 [MultiDeviceService] 持有（重绑 / 开关命令 / 退出钩子共用同一实例）。
#[derive(Default)]
struct ServerLifecycle {
    /// 当前生效服务句柄（退出钩子关停用）
    handle: Option<server::ServerHandle>,
    /// 当前 serve 任务（重绑前 await 等待端口释放）
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// 多端服务装配状态（R1-11 G-1 生产装配）：本地服务依赖与开关的单一真源。
///
/// setup 装配一次并 manage（`multi_device_set_enabled` 命令消费）；重绑钩子 /
/// 电源唤醒 / 开关命令 / 退出钩子共用同一生命周期槽与依赖实例——重建后
/// 句柄自动更新，退出关停无需再依赖 Tauri state 注入。
pub(crate) struct MultiDeviceService {
    /// 生命周期槽（当前句柄 + serve task；与退出钩子共用）
    lifecycle: Arc<std::sync::Mutex<ServerLifecycle>>,
    /// 诊断（环形缓冲，core_get_status 可见）
    diagnostics: Arc<conex_run::status_diagnostics::StatusDiagnostics>,
    /// 命令后端（CoreStateBackend 直调既有 *_impl 契约体；注入 router）
    backend: Option<Arc<dyn server::backend::ApiBackend>>,
    /// 事件扇出器（已挂 EventBridge 汇聚点；注入 ServerState.event_stream）
    fanout: Option<Arc<server::fanout::FanOutEmitter>>,
    /// 远程审计事件桥（R1-11：与引擎 run 上下文同一 EventBridge 实例——
    /// CoreStateBackend 经 core 透传；注入 ServerState.audit_bridge，
    /// remote-source-attempt 事件发射通道）
    audit_bridge: Option<conex_run::core_event_bridge::EventBridge>,
    /// 配对协调器（实际端口经 set_port 注入；重绑钩子已装配）
    pairing: Arc<server::pairing::PairingCoordinator>,
    /// WS 连接注册表（P2-5 连接面共享接线：与配对协调器 / push presence /
    /// 直投同一实例——restart_server 注入 ServerState，路由层升级注册即
    /// 进入共享注册表，presence 与撤销踢链观察真实连接）
    ws_registry: Arc<server::ws::WsRegistry>,
    /// 服务配置模板（端口 / 令牌路径；enabled 与 bind_mode 按当前态派生）
    base: server::config::ServerConfig,
    /// 服务总开关（D5 D-01 红线 1：enabled=false 时不 bind 任何端口）
    enabled: Arc<std::sync::atomic::AtomicBool>,
}

impl MultiDeviceService {
    /// 服务开关当前值（false = 不监听任何端口，红线 1）
    pub(crate) fn enabled(&self) -> bool {
        self.enabled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 当前生效配置（重绑钩子 / 开关命令 / 初始启动共用）：
    /// enabled 取开关当前值；bind_mode 跟随配对协调器状态（配对中 =
    /// Lan，否则 Loopback）——配对态由协调器持有，重启后保持正确绑定面。
    pub(crate) fn current_config(&self) -> server::config::ServerConfig {
        let mut config = self.base.clone();
        config.multi_device_enabled = self.enabled();
        config.pairing_enabled = self.pairing.pairing_enabled();
        config.bind_mode = if config.pairing_enabled {
            server::config::BindMode::Lan
        } else {
            server::config::BindMode::Loopback
        };
        config
    }

    /// 服务开关命令（`multi_device_set_enabled`）：开启 → 按当前配对态
    /// 绑定监听；关闭 → 停服（关停旧实例后不 bind——红线 1）。与重绑
    /// 共用 [restart_server] 单一路径。
    pub(crate) async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        self.enabled
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
        let config = self.current_config();
        restart_server(config, self).await;
        Ok(())
    }
}

/// 本地服务重建（R1-11 G-1 生产装配版：重绑钩子 / 开关命令 / 初始启动共用）：
///
/// 1. 服务开关门控（D5 §10.3 红线 1）：config.multi_device_enabled=false
///    时关停旧实例后**不 bind 任何端口**（Loopback 也不监听），记录诊断
///    并返回——「enabled=false 无任何端口监听」的 netstat 断言由本门控
///    保证（D5:948「服务关闭（不监听任何端口）」）；
/// 2. wss 强制（D5 D-02a「远程网关只提供 wss」/ D2 §12.8 裁决修正 11
///    「wss 强制 R1 即生效」）：红线 1 放行（服务开启）后**只提供 wss**
///    ——装配面置 tls_enabled=true（证书目录 None → 默认
///    config_dir()/multi-device/，tls.rs cert_dir 语义，无需显式设置；
///    明文 ws:// 握手在 TLS 层拒绝，无明文端点）；服务关闭（enabled=false）
///    时早返回不 bind，无明文/密文差异；
/// 3. 取走旧句柄与旧 serve task，shutdown 旧句柄并 await 旧 task——serve
///    收尾即 listener 释放，随后按同端口重建（8765 优先，占用探测兜底
///    语义不变，R1-02）；
/// 4. bind 新实例（绑定模式按 config：Loopback / Lan）→ 实际端口注入
///    配对协调器（set_port，二维码数据同源）→ 注入 CoreStateBackend 与
///    FanOutEmitter 构建 Router → 更新生命周期槽 → serve（新 task 入槽）。
///    失败仅记录诊断，不阻断应用（D1 §3.4 铁律）。
async fn restart_server(mut config: server::ServerConfig, service: &MultiDeviceService) {
    // ① 关停旧实例（先取走，避免退出钩子重复 shutdown——幂等无害）
    let (old_handle, old_task) = {
        let mut slot = service.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        (slot.handle.take(), slot.task.take())
    };
    if let Some(old) = old_handle {
        tracing::info!(target: "server", "关闭旧服务实例（重绑重建 / 停服）");
        old.shutdown();
    }
    if let Some(old_task) = old_task {
        // serve 收尾 = listener 释放（axum graceful shutdown 停止接受
        // 新连接后返回；已升级的 WS 连接由各自 task 继续收尾）
        let _ = old_task.await;
    }
    // ② 红线 1（D5 §10.3）：服务开关关闭 → 完全不 bind（Loopback 也不
    // 监听）——netstat 断言 876[5-9] 无监听由本门控保证
    if !config.multi_device_enabled {
        service.diagnostics.record(
            "server",
            false,
            Some("multi_device.enabled=false：服务未启动，无端口监听".to_string()),
        );
        tracing::info!(
            target: "server",
            "多端服务未开启（multi_device.enabled=false），不监听端口"
        );
        return;
    }
    // ②b wss 强制（D5 D-02a / D2 §12.8 裁决修正 11「wss 强制 R1 即生效」）：
    // 红线 1 放行（multi_device_enabled=true）后服务**只提供 wss**——置
    // tls_enabled=true；证书目录 None → 默认 config_dir()/multi-device/
    // （multi_device/tls.rs cert_dir 语义），无需显式设置。明文 ws:// 握手
    // 在 TLS 层拒绝（server/mod.rs TlsListener，fail-closed：材料失败即
    // bind 报错，绝不以明文降级），不存在明文端点（T-04 降级保护）。
    config.tls_enabled = true;
    // ③ 重建并 serve（注入真实后端与扇出器；端口同步配对协调器）
    match server::ServerInstance::bind(config).await {
        Ok(instance) => {
            let addr = instance.addr();
            let handle = instance.handle().clone();
            {
                let mut slot = service.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
                slot.handle = Some(handle);
            }
            // 实际端口注入配对协调器（二维码 / qr_data 内嵌端口同源；
            // 8765 探测兜底后二维码反映真实端口）
            service.pairing.set_port(addr.port());
            service
                .diagnostics
                .record("server", true, Some(addr.to_string()));
            tracing::info!(target: "server", addr = %addr, "本地服务已重建（重绑完成）");
            let router = instance.router(
                service.backend.clone(),
                service.fanout.clone(),
                service.audit_bridge.clone(),
                // R1-11 G-2：配对协调器接入路由层（REST /v1/pair + WS pair
                // 消息链；与命令面同一 Arc 实例）
                Some(Arc::clone(&service.pairing)),
                // P2-5 连接面共享接线：路由层注册表 = 装配面共享注册表
                //（与 push presence / 直投 / 配对协调器 / 唤醒踢链同一实例）
                Some(Arc::clone(&service.ws_registry)),
            );
            let serve_task = tauri::async_runtime::spawn(async move {
                if let Err(error) = instance.serve(router).await {
                    tracing::error!(target: "server", error = %error, "本地服务异常退出");
                }
            });
            service
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .task = Some(serve_task);
        }
        Err(error) => {
            tracing::error!(
                target: "server",
                error = %error,
                "本地服务重建失败（多端能力降级，GUI 不受影响）"
            );
            service
                .diagnostics
                .record("server", false, Some(error.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 注册面与 manifest 一致（PE-03 T03.1）：COMMAND_REGISTRY_NAMES 必须
    /// 逐项等于 `command_manifest.rs` 的 `registered=true` 命令集合——任何
    /// 不一致（漏注册 / 多注册 / 拼写漂移）都是接线 bug。
    #[test]
    fn registration_surface_matches_manifest() {
        let manifest_registered: HashSet<&str> = command_manifest::COMMAND_MANIFEST
            .commands
            .iter()
            .filter(|entry| entry.registered)
            .map(|entry| entry.name)
            .collect();
        let actual: HashSet<&str> = COMMAND_REGISTRY_NAMES.iter().copied().collect();
        assert_eq!(
            actual, manifest_registered,
            "注册面必须与 manifest registered=true 一致"
        );
    }

    /// 注册面命令名唯一（重复名会破坏 Tauri invoke 路由）。
    #[test]
    fn registration_names_are_unique() {
        let mut names = COMMAND_REGISTRY_NAMES.to_vec();
        names.sort_unstable();
        let original = names.len();
        names.dedup();
        assert_eq!(names.len(), original, "注册面命令名必须唯一");
    }

    /// 日志级别策略：CRISH_LOG_LEVEL 优先；未设置时 dev=debug / release=info。
    #[test]
    fn log_level_prefers_env_with_profile_fallback() {
        let previous = std::env::var("CRISH_LOG_LEVEL").ok();
        std::env::remove_var("CRISH_LOG_LEVEL");
        let level = log_level_from_env();
        let expected = if cfg!(debug_assertions) {
            "debug"
        } else {
            "info"
        };
        assert_eq!(level, expected);

        std::env::set_var("CRISH_LOG_LEVEL", "warn");
        assert_eq!(log_level_from_env(), "warn");

        if let Some(value) = previous {
            std::env::set_var("CRISH_LOG_LEVEL", value);
        } else {
            std::env::remove_var("CRISH_LOG_LEVEL");
        }
    }

    // ── 多端服务开关状态机（R1-11 G-1：enabled 切换 → bind/stop 语义；
    //    D5 D-01 红线 1「enabled=false 无任何端口监听」）──

    /// 测试服务装配（无 Tauri 依赖；固定高位端口避免与并行测试抢占）
    fn test_md_service(enabled: bool, port: u16) -> Arc<MultiDeviceService> {
        static MD_TEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = MD_TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tokens = Arc::new(std::sync::Mutex::new(server::auth::TokenStore::new(
            std::env::temp_dir().join(format!(
                "md-switch-{}-{seq}-pairing.json",
                std::process::id()
            )),
        )));
        let ws_registry = Arc::new(server::ws::WsRegistry::new());
        let pairing = Arc::new(server::pairing::PairingCoordinator::new(
            tokens,
            Arc::clone(&ws_registry),
        ));
        let mut base = server::config::ServerConfig::new(std::env::temp_dir());
        base.port = port;
        // wss 强制（装配层语义）：restart_server 在 enabled=true 时置
        // tls_enabled=true——测试注入唯一临时证书目录，隔离真实配置目录
        // （默认 config_dir()/multi-device/ 不得被测试污染）
        base.tls_cert_dir = Some(
            std::env::temp_dir().join(format!("md-switch-{}-{seq}-certs", std::process::id())),
        );
        Arc::new(MultiDeviceService {
            lifecycle: Arc::new(std::sync::Mutex::new(ServerLifecycle::default())),
            diagnostics: Arc::new(conex_run::status_diagnostics::StatusDiagnostics::new()),
            backend: None,
            fanout: None,
            audit_bridge: None,
            pairing,
            ws_registry,
            base,
            enabled: Arc::new(std::sync::atomic::AtomicBool::new(enabled)),
        })
    }

    /// 尝试独占绑定指定端口（成功 = 端口当前空闲 / 无监听）
    async fn port_is_free(port: u16) -> bool {
        tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .is_ok()
    }

    /// 红线 1 语义：enabled=false 时 restart_server 完全不 bind（Loopback
    /// 也不监听）——生命周期槽无句柄，端口可被独立绑定。
    #[tokio::test]
    async fn disabled_service_never_binds_any_port() {
        let service = test_md_service(false, 19081);
        restart_server(service.current_config(), &service).await;

        assert!(
            service
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle
                .is_none(),
            "enabled=false 不得持有服务句柄"
        );
        assert!(
            port_is_free(19081).await,
            "enabled=false 时端口必须无监听（红线 1：netstat 876[5-9] 亦同）"
        );
        // 诊断如实上报（core_get_status 可见「服务未启动」）
        assert!(
            service
                .diagnostics
                .entries()
                .iter()
                .any(|entry| entry.subsystem == "server" && !entry.ready),
            "禁用态必须记录 server=false 诊断"
        );
    }

    /// 开关状态机：enabled=true → 绑定监听（端口被占）；关闭 → 停服
    /// （句柄取走 + 端口释放）。enabled 切换 → bind/stop 语义闭环。
    #[tokio::test]
    async fn switch_enables_bind_then_disable_stops_listening() {
        let service = test_md_service(false, 19082);
        assert!(!service.enabled(), "初始必须为关闭态（D-01）");

        // 开启 → 绑定监听（端口被占 = 有监听）
        service.set_enabled(true).await.expect("开启必须成功");
        assert!(service.enabled());
        assert!(
            !port_is_free(19082).await,
            "enabled=true 时端口必须被监听（绑定占用）"
        );
        // 实际端口已注入配对协调器（二维码数据同源：restart_server 的
        // set_port 生效，QR 内嵌 19082 而非默认 8765）
        let now = server::now_ms();
        let result = service
            .pairing
            .start_pairing(now)
            .expect("激活配对必须成功");
        assert!(
            result.qr.contains(":19082"),
            "二维码必须内嵌实际监听端口（set_port 注入）：{}",
            result.qr
        );

        // 关闭 → 停服：句柄取走 + serve 收尾 → 端口释放
        service.set_enabled(false).await.expect("关闭必须成功");
        assert!(!service.enabled());
        assert!(port_is_free(19082).await, "关闭后端口必须释放（无监听）");
        assert!(
            service
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle
                .is_none(),
            "关闭后生命周期槽不得残留句柄"
        );
    }

    /// 装配辅助纯逻辑：current_config 派生——enabled 取开关当前值；
    /// bind_mode 跟随配对协调器状态（配对中 = Lan，否则 Loopback）。
    #[test]
    fn current_config_follows_switch_and_pairing_state() {
        let service = test_md_service(false, 0);
        // 关闭态：Loopback + enabled=false
        let config = service.current_config();
        assert!(!config.multi_device_enabled);
        assert_eq!(config.bind_mode, server::config::BindMode::Loopback);
        assert!(!config.pairing_enabled);

        // 配对开启 → Lan（协调器状态驱动）
        let now = server::now_ms();
        service
            .pairing
            .start_pairing(now)
            .expect("激活配对必须成功");
        let config = service.current_config();
        assert_eq!(config.bind_mode, server::config::BindMode::Lan);
        assert!(config.pairing_enabled);
        // 开关仍关闭 → enabled 不被配对态带起（红线 1 门控不变）
        assert!(!config.multi_device_enabled);

        // 开关开启 → 派生配置带 enabled=true（同步写入开关位；set_enabled
        // 的异步重启路径由 switch_enables_bind_then_disable_stops_listening
        // 覆盖）
        service
            .enabled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let config = service.current_config();
        assert!(config.multi_device_enabled);
        assert_eq!(config.bind_mode, server::config::BindMode::Lan);
    }

    /// 重绑钩子语义：服务关闭时 rebind 触发 → restart_server 停服不 bind
    /// （配对切换在开关关闭下不得产生监听）。
    #[tokio::test]
    async fn rebind_while_disabled_is_noop() {
        let service = test_md_service(false, 19083);
        // 模拟配对切换触发重绑（enabled=false 门控）
        let mut config = service.base.clone();
        config.bind_mode = server::config::BindMode::Lan;
        config.pairing_enabled = true;
        config.multi_device_enabled = false;
        restart_server(config, &service).await;
        assert!(
            port_is_free(19083).await,
            "开关关闭时配对重绑不得产生监听（红线 1）"
        );
    }

    /// 服务开启即 wss-only（D5 D-02a / D2 §12.8 裁决修正 11）：restart_server
    /// 在 multi_device_enabled=true 时强制置 tls_enabled=true——TLS 材料
    /// 生成（bind 内 load_or_generate_in 落盘 CA/叶子）即强制置位的落点
    /// 证据；明文 ws 端点不存在（TLS 层拒绝，mod.rs TlsListener 语义）。
    #[tokio::test]
    async fn enabled_service_forces_tls_wss_only() {
        let service = test_md_service(true, 19084);
        // 基线断言：测试构造的服务 config.tls_enabled=false——TLS 材料
        // 生成只能来自 restart_server 的强制置位，而非结构默认值
        assert!(
            !service.base.tls_enabled,
            "测试基线必须为明文构造（验证强制语义）"
        );
        restart_server(service.current_config(), &service).await;
        // 服务已监听（enabled=true）
        assert!(!port_is_free(19084).await, "enabled=true 必须监听端口");
        // TLS 材料已生成：证书目录出现 CA 与叶子文件（load_or_generate_in
        // 仅在 tls_enabled=true 时被 bind 调用——wss 强制的直接证据）
        let cert_dir = service
            .base
            .tls_cert_dir
            .clone()
            .expect("测试必须注入证书目录");
        for file in ["ca_cert.pem", "server_cert.pem"] {
            assert!(
                cert_dir.join(file).exists(),
                "wss 强制：证书材料 {file} 必须已生成（TLS 装配被触发）"
            );
        }
    }
}
