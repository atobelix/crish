//! 命令注册面（编译期真源；main.rs 拆分）。
//!
//! 每项二元组 `(命令名, 实现路径)`：命令名 = 前端 invoke 面（wire 名，必须与
//! `command_manifest.rs` 的 `registered=true` 一致）；实现路径 = `#[tauri::command]`
//! 函数。宏同源生成：
//! - [`COMMAND_REGISTRY_NAMES`]：注册面清单（壳测试与 manifest 对照的编译期依据）；
//! - [`build_invoke_handler`]：`generate_handler!` 分发（Tauri invoke 路由）。
//!
//! **铁律（T-F 06，通信契约）**：wire 键 = manifest 登记名；函数名与 wire 键
//! 不一致必须显式 `#[tauri::command(rename = "...")]`；禁止函数名隐式成为
//! wire 键。改动本注册面（新增/退役/改名）必须同步 command_manifest.rs 条目 +
//! 前端 commandManifest.ts 快照 + 双端条数公式，并由 command-contract-drift
//! 测试（前端契约总门禁）与注册面一致性测试守护。

use crate::{
    auth_commands, background, browser, browser_commands, command_manifest, config, core_commands,
    core_query_commands, fs_commands, git, host_openers, lifecycle_commands, markdown_commands,
    mcp_commands, models_yaml, multi_device_commands, note_commands, preferences_commands, probe,
    process, pty, retraction_commands, run_ipc, session_commands, session_title_commands, updater,
    usage_commands, window_handshake, window_snap_overlay, workflow_ipc, workspace,
};

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
        "workbench_open_external_url",
        host_openers::workbench_open_external_url
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
    // 首次配对信任引导：导出桌面自签 CA（系统级安装后 wss 才可被移动端接受）
    (
        "multi_device_export_ca",
        multi_device_commands::multi_device_export_ca
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
    (
        "auth_request_email_code",
        auth_commands::auth_request_email_code
    ),
    (
        "auth_confirm_email_code",
        auth_commands::auth_confirm_email_code
    ),
    ("auth_get_profile", auth_commands::auth_get_profile),
    ("auth_update_profile", auth_commands::auth_update_profile),
    ("auth_upload_avatar", auth_commands::auth_upload_avatar),
    ("auth_list_sessions", auth_commands::auth_list_sessions),
    ("auth_revoke_session", auth_commands::auth_revoke_session),
    ("auth_delete_account", auth_commands::auth_delete_account),
    (
        "auth_request_password_code",
        auth_commands::auth_request_password_code
    ),
    (
        "auth_set_password_with_code",
        auth_commands::auth_set_password_with_code
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
    ("core_md_render_stream", markdown_commands::md_render_stream),
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
