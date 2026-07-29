//! Stream B: Tauri 命令层 —— 会话 SQLite 持久化入口
//!
//! 本模块提供 11 个 `#[tauri::command]`，包装 `conex_db::LocalDb` 的会话存储方法，
//! 对齐 `crish-desktop/src/api/session-persistence/sessionLocalStorage.ts` 的 13 个 API。
//! CPU/IO 密集操作统一走 `tokio::task::spawn_blocking`，参考 `core_commands.rs` 模式。
//!
//! 命令错误统一为 `CoreError`（serde tagged enum），JS 侧可按 `error.kind` 分类处理。

use std::collections::HashMap;
use std::sync::Arc;

use conex_db::{DbFailure, LocalDb};
use conex_types::{CoreError, ImportStats, SessionAgent, SessionIndexEntry, SessionMessage};
use tauri::State;

/// SharedDb 包装 LocalDb，注入到 Tauri 的 State 系统。
///
/// 设计：
/// - `LocalDb` 内部已是 `Arc<Mutex<Connection>>`，Clone 廉价；此处再包一层 Arc
///   是为了让 `SharedDb` 自身 Clone 廉价（State<'_, SharedDb> 拿到的是引用，无需 Clone）。
/// - `db_ready()` 暴露给 `core_get_status`，让 `db_ready` 字段反映真实状态而非硬编码。
/// - `inner()` 返回 `LocalDb` clone（Arc 引用计数 +1），供 `spawn_blocking` 闭包拥有数据。
#[derive(Clone)]
pub struct SharedDb {
    db: Arc<LocalDb>,
    ready: Arc<std::sync::atomic::AtomicBool>,
}

impl SharedDb {
    pub fn new(db: LocalDb) -> Self {
        Self {
            db: Arc::new(db),
            ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        }
    }

    /// 数据库是否已就绪（setup 完成且无 fatal failure）。
    pub fn db_ready(&self) -> bool {
        self.ready.load(std::sync::atomic::Ordering::Relaxed)
            && self.db.get_failure().is_none()
    }

    /// 获取 `LocalDb` clone（Arc +1），供异步任务拥有数据副本。
    ///
    /// 注意：方法名不能取 `inner`，否则会被 `tauri::State::inner()` 遮蔽
    /// （`db_state.inner().local_db()` 返回 `&SharedDb` 而非 `LocalDb`）。
    pub fn local_db(&self) -> LocalDb {
        (*self.db).clone()
    }

    /// 标记数据库就绪状态。
    /// 文件 DB 打开失败并降级为内存 DB 时，调用 `set_ready(false)`
    /// 让 `core_get_status` 的 `db_ready` 字段反映真实状态。
    pub fn set_ready(&self, ready: bool) {
        self.ready
            .store(ready, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 把 `DbFailure` 转换为 `CoreError`。
fn map_db_err(e: DbFailure) -> CoreError {
    CoreError::Internal(format!("{}: {}", e.kind, e.message))
}

/// 校验 session_id 非空。
fn require_session_id(session_id: &str) -> Result<(), CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id must not be empty"));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(db_state: State<'_, SharedDb>) -> Result<Vec<SessionIndexEntry>, CoreError> {
    let db = db_state.inner().local_db();
    let entries = tokio::task::spawn_blocking(move || db.list_sessions())
        .await
        .map_err(|e| CoreError::Internal(format!("list_sessions join: {e}")))?
        .map_err(map_db_err)?;
    Ok(entries)
}

#[tauri::command]
pub async fn load_session_body(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<Vec<SessionMessage>, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    let messages = tokio::task::spawn_blocking(move || db.load_session_body(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("load_session_body join: {e}")))?
        .map_err(map_db_err)?;
    Ok(messages)
}

#[tauri::command]
pub async fn save_session_body(
    session_id: String,
    messages: Vec<SessionMessage>,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.save_session_body(&session_id, &messages))
        .await
        .map_err(|e| CoreError::Internal(format!("save_session_body join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_session(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.delete_session(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("delete_session join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn load_session_agents(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<Vec<SessionAgent>, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    let agents = tokio::task::spawn_blocking(move || db.load_session_agents(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("load_session_agents join: {e}")))?
        .map_err(map_db_err)?;
    Ok(agents)
}

#[tauri::command]
pub async fn save_session_agents(
    session_id: String,
    agents: Vec<SessionAgent>,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.save_session_agents(&session_id, &agents))
        .await
        .map_err(|e| CoreError::Internal(format!("save_session_agents join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn get_session_meta(
    key: String,
    db_state: State<'_, SharedDb>,
) -> Result<Option<String>, CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("key must not be empty"));
    }
    let db = db_state.inner().local_db();
    let value = tokio::task::spawn_blocking(move || db.get_session_meta(&key))
        .await
        .map_err(|e| CoreError::Internal(format!("get_session_meta join: {e}")))?
        .map_err(map_db_err)?;
    Ok(value)
}

#[tauri::command]
pub async fn set_session_meta(
    key: String,
    value: String,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("key must not be empty"));
    }
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.set_session_meta(&key, &value))
        .await
        .map_err(|e| CoreError::Internal(format!("set_session_meta join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn cleanup_orphan_sessions(
    active_ids: Vec<String>,
    db_state: State<'_, SharedDb>,
) -> Result<usize, CoreError> {
    let db = db_state.inner().local_db();
    let deleted = tokio::task::spawn_blocking(move || db.cleanup_orphan_sessions(&active_ids))
        .await
        .map_err(|e| CoreError::Internal(format!("cleanup_orphan_sessions join: {e}")))?
        .map_err(map_db_err)?;
    Ok(deleted)
}

#[tauri::command]
pub async fn import_from_localstorage(
    index_json: String,
    bodies: HashMap<String, String>,
    agents: HashMap<String, String>,
    active_session_id: Option<String>,
    folder_order: Vec<String>,
    db_state: State<'_, SharedDb>,
) -> Result<ImportStats, CoreError> {
    let db = db_state.inner().local_db();
    let stats = tokio::task::spawn_blocking(move || {
        db.import_from_localstorage(
            &index_json,
            bodies,
            agents,
            active_session_id.as_deref(),
            &folder_order,
        )
    })
    .await
    .map_err(|e| CoreError::Internal(format!("import_from_localstorage join: {e}")))?
    .map_err(map_db_err)?;
    Ok(stats)
}

#[tauri::command]
pub async fn touch_session(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.touch_session(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("touch_session join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            id: id.to_string(),
            title: format!("Title {id}"),
            folder: "常规会话".to_string(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            updated_at: 1000,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: None,
            engine_last_run_id: None,
            hydrated_from_engine: None,
        }
    }

    fn sample_message(id: &str, sender: &str, ts: i64) -> SessionMessage {
        SessionMessage {
            id: id.to_string(),
            sender: sender.to_string(),
            text: Some(format!("text-{id}")),
            thinking: None,
            timestamp: ts,
            status: Some("completed".to_string()),
            stream_text_offset: None,
            thinking_time: None,
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
        }
    }

    #[test]
    fn shared_db_reports_ready() {
        let db = LocalDb::open_in_memory().unwrap();
        let shared = SharedDb::new(db);
        assert!(shared.db_ready());
    }

    #[test]
    fn shared_db_inner_clones() {
        let db = LocalDb::open_in_memory().unwrap();
        let shared = SharedDb::new(db);
        let _clone = shared.local_db();
        // 原始 SharedDb 仍可用
        assert!(shared.db_ready());
    }

    #[test]
    fn require_session_id_rejects_empty() {
        assert!(require_session_id("").is_err());
        assert!(require_session_id("   ").is_err());
        assert!(require_session_id("s1").is_ok());
    }

    #[test]
    fn map_db_err_preserves_message() {
        let e = DbFailure {
            message: "locked".to_string(),
            kind: "lock".to_string(),
        };
        let core = map_db_err(e);
        match core {
            CoreError::Internal(msg) => assert!(msg.contains("locked")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    #[test]
    fn end_to_end_via_shared_db() {
        // 验证 SharedDb.inner() 与 LocalDb 行为一致
        let db = LocalDb::open_in_memory().unwrap();
        let shared = SharedDb::new(db);
        let inner = shared.local_db();

        inner.upsert_session_entry(&sample_entry("s1")).unwrap();
        inner
            .save_session_body(
                "s1",
                &[
                    sample_message("m1", "user", 1),
                    sample_message("m2", "assistant", 2),
                ],
            )
            .unwrap();

        let body = inner.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2);

        let list = inner.list_sessions().unwrap();
        assert_eq!(list[0].message_count, 2);
    }
}
