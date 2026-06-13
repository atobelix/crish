mod types;
mod supervisor;
mod pending;
mod run_stream;
mod connection;
pub(crate) mod commands;

// Re-export public API from submodules so that external consumers (main.rs, etc.)
// can continue using `sidecar::workbench_*` and `sidecar::init_state` unchanged.
//
// Commands are re-exported via glob so that Tauri's #[tauri::command] macro-generated
// helper items (__cmd__*, __tauri_command_name__*) are also visible through
// the `sidecar` namespace. Individual `use` re-exports only bring the named
// item, not the macro-generated helpers that tauri::generate_handler! needs.
pub(crate) use commands::*;

// Non-command items referenced by other modules outside sidecar.
pub(crate) use types::init_state;
pub(crate) use connection::send_current_sidecar_command;
pub(crate) use connection::ensure_sidecar_connected;
pub(crate) use supervisor::sidecar_supervisor_snapshot;
