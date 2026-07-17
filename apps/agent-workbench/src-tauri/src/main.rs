#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
mod cli_bridge;
mod commands;
mod config;
mod daemon_discovery;
mod fs_commands;
mod host_openers;
mod host_paths;
mod process;
mod sidecar;

/// 公共命令列表。debug / release 共用，避免两份 ~55 项完全重复。
/// `register_handlers!()` = 仅公共；`register_handlers!(dev)` = 公共 + cli_bridge 开发命令。
macro_rules! register_handlers {
    () => {
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
            fs_commands::list_directory,
            fs_commands::read_file_content,
            fs_commands::write_file_content,
            fs_commands::workbench_discover_skills,
            commands::workbench_http_request,
        ]
    };
    (dev) => {
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
            fs_commands::list_directory,
            fs_commands::read_file_content,
            fs_commands::write_file_content,
            fs_commands::workbench_discover_skills,
            commands::workbench_http_request,
            // 开发专用命令
            cli_bridge::workbench_dev_cli_probe,
            cli_bridge::workbench_dev_cli_task_snapshot,
            cli_bridge::workbench_dev_cli_bootstrap,
            cli_bridge::workbench_dev_cli_continuation,
            cli_bridge::workbench_dev_cli_background_demo,
            cli_bridge::workbench_dev_cli_run_task,
            cli_bridge::workbench_dev_cli_run_goal,
        ]
    };
}

fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(register_handlers!(dev));

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(register_handlers!());

    builder
        .setup(|app| {
            sidecar::init_state();
            config::init_api_config_store();

            // Product: engine is part of the app. Start sidecar immediately and
            // keep retrying so the UI never sits in a permanent "shell-only" state.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let app_dir = match crate::host_paths::app_dir() {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("[Sidecar][engine.startup] app_dir() failed: {e}");
                        return;
                    }
                };

                let mut attempt: u32 = 0;
                loop {
                    attempt = attempt.saturating_add(1);
                    match crate::sidecar::ensure_sidecar_connected(&handle, &app_dir).await {
                        Ok(sender) => {
                            println!(
                                "[Sidecar][engine.startup] ready (attempt={}, generation={}, pid={:?})",
                                attempt,
                                sender.generation,
                                crate::sidecar::sidecar_supervisor_snapshot().pid,
                            );
                            break;
                        }
                        Err(e) => {
                            eprintln!(
                                "[Sidecar][engine.startup] attempt {} failed (will retry): {e}",
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
