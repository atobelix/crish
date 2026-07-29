#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
mod cli_bridge;
mod commands;
mod config;
mod core_commands;
mod daemon_discovery;
mod fs_commands;
mod host_openers;
mod host_paths;
mod markdown_commands;
mod perf;
mod power;
mod process;
mod pty;
mod session_commands;
mod sidecar;
use tauri::Manager;

/// 公共命令列表（debug / release 共用）。
/// `make_handlers!($($extra)*)` = 公共命令 + 可选附加命令。
/// `register_handlers!()` = 仅公共；`register_handlers!(dev)` = 公共 + cli_bridge 开发命令。
macro_rules! make_handlers {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            sidecar::workbench_status,
            sidecar::workbench_daemon_endpoint,
            sidecar::workbench_connection_status,
            sidecar::workbench_provider_diagnostics,
            sidecar::workbench_restart_daemon,
            sidecar::workbench_stop_daemon,
            sidecar::workbench_list_sessions,
            sidecar::workbench_list_runs,
            sidecar::workbench_apply_session_action,
            sidecar::workbench_read_session_events,
            sidecar::workbench_read_run_events,
            sidecar::workbench_get_run_snapshot,
            sidecar::workbench_get_metrics,
            sidecar::workbench_enqueue_pending_input,
            sidecar::workbench_cancel_pending_input,
            sidecar::workbench_dispatch_pending_input,
            sidecar::workbench_list_pending_inputs,
            sidecar::workbench_run_task_stream,
            sidecar::workbench_run_goal_stream,
            sidecar::workbench_cancel_run,
            process::workbench_performance_snapshot,
            process::workbench_run_shell,
            pty::workbench_pty_create,
            pty::workbench_pty_write,
            pty::workbench_pty_resize,
            pty::workbench_pty_kill,
            sidecar::workbench_approve_tool,
            sidecar::workbench_deny_tool,
            sidecar::workbench_list_mcp_servers,
            sidecar::workbench_start_mcp_server,
            sidecar::workbench_stop_mcp_server,
            sidecar::workbench_list_background_tasks,
            sidecar::workbench_list_mutation_leases,
            sidecar::workbench_git_status,
            sidecar::workbench_git_diff,
            sidecar::workbench_cancel_background_task,
            sidecar::workbench_get_background_task_output,
            sidecar::workbench_list_plan_documents,
            sidecar::workbench_create_plan_document,
            sidecar::workbench_create_requirements_alignment_plan,
            sidecar::workbench_get_plan_document,
            sidecar::workbench_patch_plan_document,
            sidecar::workbench_delete_plan_document,
            sidecar::workbench_list_artifacts,
            sidecar::workbench_get_artifact_content,
            sidecar::workbench_list_memories,
            sidecar::workbench_delete_memory,
            sidecar::workbench_list_checkpoints,
            sidecar::workbench_get_checkpoint_diff,
            sidecar::workbench_restore_checkpoint,
            sidecar::workbench_preview_conversation_rewind,
            sidecar::workbench_apply_conversation_rewind,
            sidecar::workbench_send_to_subagent,
            sidecar::workbench_get_subagent_status,
            host_openers::workbench_list_host_openers,
            host_openers::workbench_open_host_target,
            host_openers::workbench_open_path_default,
            host_openers::workbench_list_file_openers,
            fs_commands::select_folder,
            config::save_api_config,
            config::get_api_config,
            config::update_daemon_config,
            config::workbench_profile_secret_set,
            config::workbench_profile_secret_get,
            config::workbench_profile_secret_has,
            config::workbench_profile_secret_clear,
            fs_commands::list_directory,
            fs_commands::read_file_content,
            fs_commands::write_file_content,
            fs_commands::workbench_discover_skills,
            commands::workbench_http_request,
            commands::workbench_apply_update,
            perf::hash::perf_hash_compute,
            perf::hash::perf_base64_encode,
            perf::hash::perf_base64_decode,
            perf::encoding::perf_encoding_detect,
            perf::encoding::perf_encoding_decode,
            perf::diff::perf_diff_parse,
            perf::jsonl::perf_jsonl_read,
            perf::jsonl::perf_jsonl_write,
            perf::jsonl::perf_jsonl_append,
            perf::fs::perf_fs_read_chunk,
            perf::fs::perf_fs_file_info,
            perf::fs::perf_fs_watch_start,
            perf::fs::perf_fs_watch_stop,
            core_commands::core_check_command,
            core_commands::core_search_files,
            core_commands::core_rebuild_search_index,
            core_commands::core_compact_messages,
            core_commands::core_count_tokens,
            core_commands::core_compute_diff,
            core_commands::core_get_status,
            // Stream B: 会话 SQLite 持久化命令（11 个）
            session_commands::list_sessions,
            session_commands::load_session_body,
            session_commands::save_session_body,
            session_commands::delete_session,
            session_commands::load_session_agents,
            session_commands::save_session_agents,
            session_commands::get_session_meta,
            session_commands::set_session_meta,
            session_commands::cleanup_orphan_sessions,
            session_commands::import_from_localstorage,
            session_commands::touch_session,
            // Stream A: Rust Markdown 渲染命令（5 个）
            markdown_commands::md_render,
            markdown_commands::md_render_batch,
            markdown_commands::md_render_stream,
            markdown_commands::highlight_code,
            markdown_commands::md_clear_cache,
            // Stream E: Worker 池下沉命令（9 个）
            // - 6 个 core_* 复用 perf 模块实现（hash / base64 / encoding / diff），
            //   错误协议从 String 升级为 CoreError；perf_* 别名保留兼容
            // - 3 个新命令处理 JSONL / 文本编码（替代 io-worker 的对应 case）
            core_commands::core_hash_compute,
            core_commands::core_base64_encode,
            core_commands::core_base64_decode,
            core_commands::core_detect_encoding,
            core_commands::core_decode_text,
            core_commands::core_parse_diff,
            core_commands::core_messages_to_jsonl,
            core_commands::core_jsonl_to_messages,
            core_commands::core_text_encode,
            power::workbench_set_keep_awake,
            $($extra,)*
        ]
    };
}

macro_rules! register_handlers {
    () => { make_handlers!() };
    (dev) => {
        make_handlers!(
            cli_bridge::workbench_dev_cli_probe,
            cli_bridge::workbench_dev_cli_task_snapshot,
            cli_bridge::workbench_dev_cli_bootstrap,
            cli_bridge::workbench_dev_cli_continuation,
            cli_bridge::workbench_dev_cli_run_task,
            cli_bridge::workbench_dev_cli_run_goal,
        )
    };
}

fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // Dev-only: MCP socket so AI agents can inspect the live workbench webview
    // (query_logs / execute_js / click / screenshot — not the system browser).
    // Windows: TCP 127.0.0.1:4000. Guest JS must call setupPluginListeners() in DEV.
    #[cfg(debug_assertions)]
    let builder = {
        use tauri_plugin_mcp::PluginConfig;
        builder.plugin(tauri_plugin_mcp::init_with_config(
            PluginConfig::new("crish-agent-workbench".to_string())
                .start_socket_server(true)
                .tcp_localhost(4000),
        ))
    };

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(register_handlers!(dev));

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(register_handlers!());

    builder
        .setup(|app| {
            sidecar::init_state();
            config::init_api_config_store();
            app.manage(core_commands::SharedSearchState::new());

            // Stream B: 初始化 SQLite 会话持久化层。
            // DB 文件路径：app_dir()/sessions.db（参考 host_paths.rs）。
            // 打开失败时降级为内存 DB 并标记 not-ready，让 core_get_status 反映真实状态。
            let shared_db = match crate::host_paths::app_dir() {
                Ok(app_dir) => {
                    let db_path = app_dir.join("sessions.db");
                    match conex_db::LocalDb::open(&db_path) {
                        Ok(db) => session_commands::SharedDb::new(db),
                        Err(e) => {
                            tracing::error!(
                                target: "db",
                                error = ?e,
                                path = %db_path.display(),
                                "[DB] failed to open sessions.db; falling back to in-memory"
                            );
                            let mem = conex_db::LocalDb::open_in_memory()
                                .expect("in-memory DB must always open");
                            let shared = session_commands::SharedDb::new(mem);
                            shared.set_ready(false);
                            shared
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(
                        target: "db",
                        error = %e,
                        "[DB] app_dir() failed; falling back to in-memory"
                    );
                    let mem = conex_db::LocalDb::open_in_memory()
                        .expect("in-memory DB must always open");
                    let shared = session_commands::SharedDb::new(mem);
                    shared.set_ready(false);
                    shared
                }
            };
            app.manage(shared_db);

            // Product: engine is part of the app. Start sidecar immediately and
            // keep retrying so the UI never sits in a permanent "shell-only" state.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let app_dir = match crate::host_paths::app_dir() {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::error!(target: "sidecar", error = %e, "[Sidecar][engine.startup] app_dir() failed");
                        return;
                    }
                };

                let mut attempt: u32 = 0;
                loop {
                    attempt = attempt.saturating_add(1);
                    match crate::sidecar::ensure_sidecar_connected(&handle, &app_dir).await {
                        Ok(sender) => {
                            tracing::info!(
                                target: "sidecar",
                                attempt,
                                generation = sender.generation,
                                pid = ?crate::sidecar::sidecar_supervisor_snapshot().pid,
                                "[Sidecar][engine.startup] ready"
                            );
                            break;
                        }
                        Err(e) => {
                            tracing::error!(
                                target: "sidecar",
                                attempt,
                                error = %e,
                                "[Sidecar][engine.startup] attempt {} failed (will retry)",
                                attempt
                            );
                            // Cap backoff so product recovers quickly after transient failures
                            let delay_ms = (300u64 * 2u64.saturating_pow(attempt.min(5)))
                                .min(5_000);
                            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Host process exit: kill all interactive PTY shells (graceful path).
            // Crash path: daemon + PTY each have their own Job Object (process.rs
            // KILL_ON_JOB_CLOSE). Explicit kill remains for clean Exit / reader races.
            // Frontend killAll (pagehide / bootstrap cleanup) is best-effort only.
            // Dock unmount must not kill PTYs.
            if let tauri::RunEvent::Exit = event {
                pty::kill_all_sessions();
            }
        });
}
