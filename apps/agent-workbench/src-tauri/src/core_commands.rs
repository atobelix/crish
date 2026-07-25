use conex_compaction::compaction::CompactionEngine;
use conex_diff::diff_engine::DiffEngine;
use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
use conex_search::fuzzy::FuzzyMatcher;
use conex_search::search::{search_files, search_files_parallel, FileHit};
use conex_search::walker::build_directory_index;
use conex_types::{CompactionResult, DiffResult, Message};
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use tauri::State;

const SEARCH_PARALLEL_THRESHOLD: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustCoreStatus {
    pub search_index_ready: bool,
    pub db_ready: bool,
    pub compaction_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildSearchIndexResponse {
    pub file_count: usize,
}

pub struct SharedSearchState {
    pub files: RwLock<Vec<String>>,
}

impl SharedSearchState {
    pub fn new() -> Self {
        Self {
            files: RwLock::new(Vec::new()),
        }
    }
}

impl Default for SharedSearchState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn core_search_files(
    query: String,
    limit: Option<usize>,
    state: State<'_, SharedSearchState>,
) -> Result<Vec<FileHit>, String> {
    let files = state
        .files
        .read()
        .map_err(|e| format!("search index lock: {e}"))?
        .clone();
    let limit = limit.unwrap_or(20);
    let hits = tokio::task::spawn_blocking(move || {
        let matcher = FuzzyMatcher::new(false);
        let files = std::sync::Arc::new(files);
        if files.len() >= SEARCH_PARALLEL_THRESHOLD {
            search_files_parallel(&query, &files, limit, &matcher)
        } else {
            search_files(&query, &files, limit, &matcher)
        }
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?;
    Ok(hits)
}

#[tauri::command]
pub async fn core_rebuild_search_index(
    root: String,
    state: State<'_, SharedSearchState>,
) -> Result<RebuildSearchIndexResponse, String> {
    let root = root.trim().to_string();
    if root.is_empty() {
        return Err("root path is empty".to_string());
    }
    let built = tokio::task::spawn_blocking(move || build_directory_index(&root))
        .await
        .map_err(|e| format!("rebuild task failed: {e}"))?;
    let count = built.len();
    *state
        .files
        .write()
        .map_err(|e| format!("search index lock: {e}"))? = built;
    Ok(RebuildSearchIndexResponse { file_count: count })
}

#[tauri::command]
pub async fn core_compact_messages(
    messages: Vec<Message>,
    max_tokens: usize,
) -> Result<CompactionResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        let engine = CompactionEngine::new(max_tokens);
        let mut msgs = messages;
        engine.compact(&mut msgs);
        CompactionResult {
            compacted: false,
            messages: msgs,
            tokens_consumed: 0,
            cache_hit_rate_optimized: false,
        }
    })
    .await
    .map_err(|e| format!("compact task failed: {e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn core_count_tokens(text: String) -> Result<usize, String> {
    let count = tokio::task::spawn_blocking(move || conex_compaction::count_tokens(&text))
        .await
        .map_err(|e| format!("token count task failed: {e}"))?;
    Ok(count)
}

#[tauri::command]
pub async fn core_check_command(
    cmd: String,
    args: Vec<String>,
) -> Result<GatekeeperResult, String> {
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let gatekeeper = CommandGatekeeper::new();
    let result = gatekeeper.check_command(&cmd, &args_ref);
    Ok(result)
}

#[tauri::command]
pub async fn core_compute_diff(
    old_text: String,
    new_text: String,
) -> Result<DiffResult, String> {
    let result = tokio::task::spawn_blocking(move || DiffEngine::diff(&old_text, &new_text))
        .await
        .map_err(|e| format!("diff task failed: {e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn core_get_status(
    state: State<'_, SharedSearchState>,
) -> Result<RustCoreStatus, String> {
    let count = state.files.read().map(|g| g.len()).unwrap_or(0);
    Ok(RustCoreStatus {
        search_index_ready: count > 0,
        db_ready: true,
        compaction_ready: true,
    })
}
