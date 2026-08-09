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
//!   ③ config 初始化（`init_api_config_store`，静态存储）；
//!   ④ [WorkspaceRegistry::init] manage（工作区沙箱真源）；
//!   ⑤ [SharedGatekeeper] / [SharedSearchState] / [SharedCompactionState] manage；
//!   ⑥ [StatusDiagnostics] manage（与 CoreRunState 共享同一实例）；
//!   ⑦ restore：`run_restore` 经 run_in_runtime 在 `manage(CoreRunState)` 之前
//!   执行（成功 seed_sequences + 立即快照；失败降级不阻断启动）；
//!   ⑧ [CoreRunState] manage + [EventBridge] manage + [SharedDb] manage；
//!   ⑨ 模型目录 manage（`Arc<RwLock<ModelCatalog>>`，内置表；P3 步骤 5，
//!   catalog_get / catalog_refresh 消费）；
//!   ⑩ MCP 插件：debug 下 `dev_mcp::register_if_enabled(builder)`（默认关闭，
//!   `CRISH_MCP_SOCKET=1` 开启）；
//! - **退出钩子**：`RunEvent::Exit` 时 PTY 清理 +
//!   [CoreRunState::save_snapshot_blocking]（独立线程）。

mod background;
mod buffer;
mod browser;
mod browser_commands;
mod catalog_commands;
mod command_manifest;
mod commands;
mod config;
mod core_commands;
mod core_error;
mod core_event_bridge;
mod core_query_commands;
mod core_run_commands;
mod task_event_consumer;
mod dev_mcp;
mod engine;
mod fs_commands;
mod git;
mod host_openers;
mod host_paths;
mod markdown_commands;
mod perf;
mod power;
mod process;
mod pty;
mod resource;

mod session_commands;
mod status_diagnostics;
// T-D-13：子代理生产 spawner（SubagentSpawner 引擎侧接线；bin 模块，
// 与 core_run_commands / engine 同目标，互引 crate:: 内部路径）
mod subagent_spawner;
mod timers;
mod sched;
mod workflow_commands;
mod wakeup_summary;

mod watchdog;
mod workspace;
mod outputs_config;

use std::sync::{Arc, RwLock};

use core_event_bridge::{EventBridge, TauriEmitter};
use tauri::Manager;

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
    // T-AB-08：后台任务查询面恢复（B01/B02；list/get_output/cancel 三命令，
    // 形状对齐前端 backgroundTasksApi.ts 解析层）
    ("workbench_list_background_tasks", background::workbench_list_background_tasks),
    ("workbench_get_background_task_output", background::workbench_get_background_task_output),
    ("workbench_cancel_background_task", background::workbench_cancel_background_task),
    // T-AB-20：后台任务 stdin 注入（sendBackgroundTaskInput 等待的命令面；
    // F3 T-AB-19 顺手注册，参数 camelCase taskId/text/appendNewline）
    ("workbench_send_input", background::workbench_send_input),
    // PE-07 T07.3（C-02/C-03/C-04）：git 参数数组执行 + 参数 schema 白名单
    ("workbench_git_run", git::workbench_git_run),
    ("workbench_fs_delete_file", fs_commands::workbench_fs_delete_file),
    ("workbench_pty_create", pty::workbench_pty_create),
    ("workbench_pty_write", pty::workbench_pty_write),
    ("workbench_pty_resize", pty::workbench_pty_resize),
    ("workbench_pty_kill", pty::workbench_pty_kill),
    ("workbench_list_host_openers", host_openers::workbench_list_host_openers),
    ("workbench_open_host_target", host_openers::workbench_open_host_target),
    ("workbench_open_path_default", host_openers::workbench_open_path_default),
    ("workbench_list_file_openers", host_openers::workbench_list_file_openers),
    // T-F 06：fs 四命令经 `#[tauri::command(rename = "workbench_*")]` 对齐
    // wire 键（元组名 = manifest 登记名 = wire 键逐字一致，分裂已消除）
    ("workbench_select_folder", fs_commands::select_folder),
    ("workbench_list_directory", fs_commands::list_directory),
    ("workbench_read_file_content", fs_commands::read_file_content),
    ("workbench_write_file_content", fs_commands::write_file_content),
    ("workbench_discover_skills", fs_commands::workbench_discover_skills),
    ("workbench_http_request", commands::workbench_http_request),
    ("workbench_apply_update", commands::workbench_apply_update),
    // ── 配置族（§2.2-C，F5 终态名：config_get/config_update/config_secret_*）──
    ("config_get", config::config_get),
    ("config_update", config::config_update),
    ("config_secret_set", config::config_secret_set),
    ("config_secret_get", config::config_secret_get),
    ("config_secret_has", config::config_secret_has),
    ("config_secret_clear", config::config_secret_clear),
    ("config_profile_apply", config::config_profile_apply),
    ("config_secret_reveal", config::config_secret_reveal),
    // ── G03 产出根配置（T-EG-12：agentOutputsRoot 全局设置 + 校验）──
    ("config_get_outputs_root", outputs_config::config_get_outputs_root),
    ("config_set_outputs_root", outputs_config::config_set_outputs_root),
    // ── 工具旧组（E1，§2.2-E）──
    ("core_check_command", core_commands::core_check_command),
    ("core_search_files", core_commands::core_search_files),
    ("core_rebuild_search_index", core_commands::core_rebuild_search_index),
    ("core_compact_messages", core_commands::core_compact_messages),
    ("core_count_tokens", core_commands::core_count_tokens),
    ("core_compute_diff", core_commands::core_compute_diff),
    // ── 查询与运行（A/B，§2.2）──
    ("core_get_status", core_query_commands::core_get_status),
    ("core_get_run_snapshot", core_query_commands::core_get_run_snapshot),
    ("core_read_session_events", core_query_commands::core_read_session_events),
    ("core_run_task", core_run_commands::core_run_task),
    ("core_run_control", core_run_commands::core_run_control),
    ("core_cancel_run", core_run_commands::core_cancel_run),
    ("core_approve_tool", core_run_commands::core_approve_tool),
    ("core_deny_tool", core_run_commands::core_deny_tool),
    // ── 会话持久化（B，§2.2；含 F3 冻结的 upsert_session_entry）──
    ("list_sessions", session_commands::list_sessions),
    ("load_session_body", session_commands::load_session_body),
    ("save_session_body", session_commands::save_session_body),
    ("load_session_agents", session_commands::load_session_agents),
    ("save_session_agents", session_commands::save_session_agents),
    ("get_session_meta", session_commands::get_session_meta),
    ("set_session_meta", session_commands::set_session_meta),
    ("cleanup_orphan_sessions", session_commands::cleanup_orphan_sessions),
    ("import_from_localstorage", session_commands::import_from_localstorage),
    ("upsert_session_entry", session_commands::upsert_session_entry),
    // F11b（T-D-12）：DAG 只读快照查询（flow_dag_visible 开关关闭时不调用，
    // 只读通用面保留无害）
    ("get_flow_snapshot", session_commands::get_flow_snapshot),
    // G03 会话级产出根覆盖（T-EG-12：session_meta `{session_id}:output_root`）
    ("set_session_output_root", outputs_config::set_session_output_root),
    // ── Markdown（D，T03.4 更名 core_md_*，并入 core 族；实现函数在
    //    markdown_commands.rs，经 `#[tauri::command(rename = ...)]` 对齐 wire 名）──
    ("core_md_render", markdown_commands::md_render),
    ("core_md_render_batch", markdown_commands::md_render_batch),
    ("core_highlight_code", markdown_commands::highlight_code),
    // ── 工具 Worker 组（E，§2.2；core_jsonl_append 自 perf 迁移）──
    ("core_hash_compute", core_commands::core_hash_compute),
    ("core_base64_encode", core_commands::core_base64_encode),
    ("core_base64_decode", core_commands::core_base64_decode),
    ("core_detect_encoding", core_commands::core_detect_encoding),
    ("core_decode_text", core_commands::core_decode_text),
    ("core_parse_diff", core_commands::core_parse_diff),
    ("core_messages_to_jsonl", core_commands::core_messages_to_jsonl),
    ("core_jsonl_to_messages", core_commands::core_jsonl_to_messages),
    ("core_text_encode", core_commands::core_text_encode),
    ("core_jsonl_append", core_commands::core_jsonl_append),
    // ── 模型目录（P3 步骤 5：catalog_get / catalog_refresh）──
    ("catalog_get", catalog_commands::catalog_get),
    ("catalog_refresh", catalog_commands::catalog_refresh),
    // ── 注册表单一化自身（T03.1；经 command_manifest 注册——Tauri 宏生成项
    //    （__cmd__*）不随 core_query_commands 的 pub use 重导出，必须直引真源）──
    ("core_list_commands", command_manifest::core_list_commands),
    // ── 误删恢复（I2-S5：trash_list / trash_restore / trash_purge）──
    ("trash_list", core_run_commands::trash_list),
    ("trash_restore", core_run_commands::trash_restore),
    ("trash_purge", core_run_commands::trash_purge),
    // ── workflow 命令面（T-CF-14：六条实装，消除前端幽灵命令；
    //    wire 名 kebab-case，经 #[tauri::command(rename=...)] 对齐）──
    ("create-workflow", workflow_commands::create_workflow),
    ("list-workflows", workflow_commands::list_workflows),
    ("update-workflow", workflow_commands::update_workflow),
    ("delete-workflow", workflow_commands::delete_workflow),
    ("trigger-workflow", workflow_commands::trigger_workflow),
    ("list-workflow-runs", workflow_commands::list_workflow_runs),
    // ── 浏览器面板命令（27 方案 S6：browser_start/stop/status 代理到
    //    引擎会话槽；状态变更经 browser://state-changed 事件发射）──
    ("browser_start", browser_commands::browser_start),
    ("browser_stop", browser_commands::browser_stop),
    ("browser_status", browser_commands::browser_status),
];

/// 当前生效日志级别：`CRISH_LOG_LEVEL` 优先，dev debug / release info
/// （PE-04 T04.1-1：非法值由 conex-telemetry 内部回退 info）。
fn log_level_from_env() -> String {
    std::env::var("CRISH_LOG_LEVEL")
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "debug".to_string()
            } else {
                "info".to_string()
            }
        })
}

/// 打开会话数据库（`app_dir()/sessions.db`；失败降级内存库 + 记录诊断）。
fn open_session_db(diagnostics: &status_diagnostics::StatusDiagnostics) -> session_commands::SharedDb {
    let open_file = || -> Result<session_commands::SharedDb, String> {
        let app_dir = crate::host_paths::app_dir().map_err(|e| e.to_string())?;
        let db_path = app_dir.join("sessions.db");
        let db = conex_db::LocalDb::open(&db_path).map_err(|e| {
            format!("{}: {}", e.kind, e.message)
        })?;
        tracing::info!(target: "db", path = %db_path.display(), "会话数据库已打开");
        Ok(session_commands::SharedDb::new(db))
    };

    match open_file() {
        Ok(shared) => shared,
        Err(error) => {
            // 失败降级：内存库 + db_ready=false（core_get_status 如实反映），
            // 不阻断启动（PE-01 T01.2 诚实化）。
            tracing::error!(
                target: "db",
                error = %error,
                "[DB] 打开 sessions.db 失败，降级为内存库"
            );
            diagnostics.record("db", false, Some(format!("sessions.db 打开失败：{error}")));
            let mem = conex_db::LocalDb::open_in_memory()
                .expect("in-memory DB must always open");
            let shared = session_commands::SharedDb::new(mem);
            shared.set_ready(false);
            shared
        }
    }
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
    // 崩溃文件（T04.1-3）：与日志同目录，panic 现场独立落盘
    conex_telemetry::install_panic_hook_with_crash_dir(Some(log_dir.clone()));

    // 共享诊断（PE-04 T04.5）：CoreRunState 与 core_get_status 共用同一实例，
    // main.rs 先构造再注入，避免「写入侧与读取侧实例漂移」。
    let diagnostics = Arc::new(status_diagnostics::StatusDiagnostics::new());
    // setup 闭包为 'static：预克隆需要跨闭包持有的所有权
    let setup_diagnostics = Arc::clone(&diagnostics);
    let setup_log_dir = log_dir.clone();
    let setup_level = level.clone();
    let setup_app_dir = app_dir.clone();

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // setup 序列 ⑩：MCP 调试插件（默认关闭，CRISH_MCP_SOCKET=1 开启；
    // release 由插件自身拒绝兜底，注册点本身亦被 cfg 隔离）。
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

            // ② 会话数据库（SharedDb manage；Store 与命令共用同一 LocalDb 连接）
            let shared_db = open_session_db(diagnostics);
            let store: Arc<dyn orchestrator::persist::Store> =
                Arc::new(orchestrator::persist::LocalDbStore::new(shared_db.local_db()));

            // ③ 配置静态存储初始化（ApiConfigStore + 密钥槽）
            config::init_api_config_store();

            // ④ 工作区注册表（沙箱根真源；加载 recent 列表 + 默认应用根）
            match workspace::WorkspaceRegistry::init() {
                Ok(registry) => {
                    diagnostics.record("workspace", true, None);
                    app.manage(registry);
                }
                Err(error) => {
                    tracing::error!(
                        target: "workspace",
                        error = %error,
                        "WorkspaceRegistry 初始化失败（文件命令按 outside_workspace 拒绝）"
                    );
                    diagnostics.record("workspace", false, Some(error));
                }
            }

            // ④b 回收站根注入（I2-S5：None = 未注入 → 命令侧回退活动
            // 工作区 `.crish-trash`，与删除工具兜底一致；对齐
            // BuiltinToolConfig.trash_root 语义）
            app.manage(core_run_commands::TrashRootConfig::default());

            // ④c 全局产出根配置注入（G03 T-EG-12：agentOutputsRoot 默认
            // `.agent-outputs`；命令侧可经 config_set_outputs_root 覆盖，
            // 校验保证产出根位于工作区内）
            app.manage(outputs_config::OutputsRootConfig::default());

            // ⑤ 共享状态：命令闸门 / 搜索索引 / 压缩能力标记
            app.manage(core_commands::SharedGatekeeper::new());
            app.manage(core_commands::SharedSearchState::new());
            let compaction = core_commands::SharedCompactionState::new();
            // 压缩为纯内存能力（conex-compaction），core_compact_messages 已接线
            compaction.set_ready(true);
            app.manage(compaction);

            // ⑥ 状态诊断 manage（与 CoreRunState 共享同一实例）
            app.manage(Arc::clone(diagnostics));

            // 事件桥（B6.3：workbench-run-event 通道；Tauri 发射器）
            let browser_emitter_handle = app_handle.clone();
            let bridge = EventBridge::new(
                "workbench-run-event",
                Arc::new(TauriEmitter::new(app_handle)),
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

            // 核心运行状态（store / 快照 / 事件桥 / 诊断 / 后台任务管理器注入）
            let core_state = Arc::new(core_run_commands::CoreRunState::new(
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

            // ⑦ restore：run_in_runtime 在 manage(CoreRunState) 之前执行
            //（成功 seed_sequences + 立即快照；失败降级不阻断，门禁经
            // restore_ready 放行——core_run_commands.rs:479-520 语义）
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
            core_state.engine().browser_slot().attach_emitter(Arc::new(
                TauriEmitter::new(browser_emitter_handle),
            ));

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
            let workflow_state = workflow_commands::WorkflowCommandState::new(
                shared_db.local_db(),
                core_state.steering_queue(),
            );
            if let Some(reg) = core_state.scheduler_registry() {
                workflow_state.set_registry(reg);
            } else {
                tracing::warn!(
                    target: "setup",
                    "SchedulerRegistry 装配降级（workflow 走命令层独立退化路径，Cron 不参与续 run 判定）"
                );
            }
            app.manage(workflow_state);

            // ⑨ 模型目录（P3 步骤 5）：内置表挂 Tauri state（catalog_get /
            //    catalog_refresh 消费；覆盖/扫描合并仅经命令入口进行）
            app.manage(Arc::new(RwLock::new(
                agent_provider::models::ModelCatalog::bundled(),
            )));

            // 30 方案 P4：timer/cron 缓冲事件 drain 任务（500ms tick 调
            // 引擎转发 helper——缓冲事件 → 信封直发事件桥，A10 N-05 断头路
            // 消除；延迟 ≤ 500ms，drain 为 Vec::take 语义，空缓冲零开销；
            // 对齐 watchdog spawn 先例：tauri runtime 内无限循环 + 周期 sleep）
            {
                let timer_sink = core_state.timer_event_sink();
                let sched_sink = core_state.scheduler_event_sink();
                let drain_bridge = bridge.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        engine::forward_drained_timer_events(&timer_sink, &drain_bridge);
                        engine::forward_drained_scheduler_events(&sched_sink, &drain_bridge);
                    }
                });
            }

            // 周期快照（T08.6 触发点 B：默认 60s，仅活动 run 存在时保存；
            // 幂等，restore 完成与否均可启动）
            core_state.spawn_snapshot_loop();

            // setup 完成标记（PE-01 T01.2：initialized 如实反映）
            core_state.mark_initialized();

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
        .run(|app_handle, event| {
            // 退出钩子：PTY 清理（优雅路径）+ 退出前快照保存（独立线程，
            // save_snapshot_blocking 为阻塞语义，不拖累事件循环收口）。
            // PERSIST-02 P1-2：restore 未完成或失败时保存被
            // build_and_save_snapshot 门禁拒绝（restore_ready 未置位 /
            // restore_failed 已置位）——防「0 会话半水合快照」覆盖主快照
            // 导致会话树分支历史永久丢失；跳过时 snapshot_last_error 可观测。
            if let tauri::RunEvent::Exit = event {
                pty::kill_all_sessions();
                if let Some(core) = app_handle.try_state::<Arc<core_run_commands::CoreRunState>>() {
                    let core = Arc::clone(core.inner());
                    std::thread::spawn(move || core.save_snapshot_blocking());
                }
            }
        });
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
            actual,
            manifest_registered,
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
}
