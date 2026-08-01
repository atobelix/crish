//! Stream B + PE-08：Tauri 命令层 —— 会话 SQLite 持久化入口
//!
//! 本模块提供 12 个 `#[tauri::command]`，包装 `conex_db::LocalDb` 的会话存储方法，
//! 对齐 `crish-desktop/src/api/session-persistence/sessionRustDb.ts` 的调用面。
//! CPU/IO 密集操作统一走 `tokio::task::spawn_blocking`，避免阻塞 Tauri 命令线程。
//! 命令错误统一为 `CoreError`（serde tagged enum，`{kind, detail}`），JS 侧可按
//! `error.kind` 分类处理（77 码显式映射经 `conex_types::core_error_code` 展开）。
//!
//! PE-08 冻结签名：
//! - F3（T08.1）：`upsert_session_entry(entry: SessionIndexEntry)`（对象签名，
//!   session 族第 12 个命令）；`save_session_body` 执行前自愈补建会话行
//!   （`INSERT OR IGNORE`，FK 写路径兜底，不改变「索引先行」语义）；
//! - F4（T08.2）：`cleanup_orphan_sessions(active_ids, confirm_empty)` ——
//!   空 keepIds 默认拒绝（`InvalidInput: cleanup_orphan_empty_keep`），
//!   `confirm_empty = true` 才允许显式清空（仅测试 / 显式用户清空入口）。

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
/// - `local_db()` 返回 `LocalDb` clone（Arc 引用计数 +1），供 `spawn_blocking` 闭包拥有数据。
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

/// 把 `DbFailure` 映射为统一 IPC 错误协议 `CoreError`。
/// kind 携带操作名（lock / *_prepare / *_commit 等），拼接进消息便于诊断；
/// 需要 77 码时经 `conex_types::core_error_code` 显式展开（IPC 面仍为 CoreError）。
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

/// F4 冻结（T08.2）：空 keepIds 默认拒绝——防止 boot 窗口 / 未 hydrate 场景
/// 触发全库清空（AA-07 P02）；`confirm_empty = true` 仅测试 / 显式清空入口使用。
fn guard_cleanup_keep(active_ids: &[String], confirm_empty: bool) -> Result<(), CoreError> {
    if active_ids.is_empty() && !confirm_empty {
        return Err(CoreError::InvalidInput(
            "cleanup_orphan_empty_keep".to_string(),
        ));
    }
    Ok(())
}

/// 自愈写正文（T08.1）：先 `INSERT OR IGNORE` 补建会话行（空标题），再全量替换正文。
/// 等价于「`INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, '')` 再写正文」，
/// 避免 FK 失败；upsert 主路径失败时的兜底，不改变「索引先行」语义。
fn self_heal_then_save_body(
    db: &LocalDb,
    session_id: &str,
    messages: &[SessionMessage],
) -> Result<(), DbFailure> {
    db.insert_session(session_id, "")?;
    db.save_session_body(session_id, messages)
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
    tokio::task::spawn_blocking(move || self_heal_then_save_body(&db, &session_id, &messages))
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

/// 清理不在 keepIds 中的会话（孤儿清理，F4 冻结签名）。
///
/// - `active_ids` 非空：删除不在集合内的孤儿行，返回删除行数；
/// - `active_ids` 为空且 `confirm_empty = false`：**不执行任何 DELETE**，返回
///   `Err(InvalidInput, "cleanup_orphan_empty_keep")`（前端可见，防 P02 全库清空）；
/// - `active_ids` 为空且 `confirm_empty = true`：显式清空（仅测试 / 显式清空入口）。
///
/// 宽限期（`ORPHAN_GRACE_MS`，session_meta `orphan_grace_ms` 可配）与
/// `confirm_empty` 的库层实现由 conex-db 侧承接（PE-08 T08.2 产出）。
#[tauri::command]
pub async fn cleanup_orphan_sessions(
    active_ids: Vec<String>,
    confirm_empty: Option<bool>,
    db_state: State<'_, SharedDb>,
) -> Result<usize, CoreError> {
    guard_cleanup_keep(&active_ids, confirm_empty.unwrap_or(false))?;
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

/// 幂等写入会话索引条目（F3 冻结签名，session 族第 12 个命令）。
///
/// 语义 = `ON CONFLICT(id) DO UPDATE`：只更新索引列，不级联删除消息 /
/// agents（`upsert_does_not_cascade_delete_messages` 先例锚定）。
#[tauri::command]
pub async fn upsert_session_entry(
    entry: SessionIndexEntry,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&entry.id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.upsert_session_entry(&entry))
        .await
        .map_err(|e| CoreError::Internal(format!("upsert_session_entry join: {e}")))?
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
            // kind 现为 DbFailureKind 枚举（R6 收敛）；Display 仍输出操作名
            kind: conex_db::DbFailureKind::Lock,
        };
        let core = map_db_err(e);
        match core {
            CoreError::Internal(msg) => assert!(msg.contains("locked")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    // ── F4：空 keepIds 默认拒绝（PE-08 T08.2）──

    #[test]
    fn cleanup_guard_rejects_empty_keep_without_confirm() {
        let err = guard_cleanup_keep(&[], false).expect_err("must reject");
        match err {
            CoreError::InvalidInput(detail) => assert_eq!(detail, "cleanup_orphan_empty_keep"),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn cleanup_guard_allows_explicit_empty_confirm() {
        guard_cleanup_keep(&[], true).expect("explicit confirm allows clear");
        guard_cleanup_keep(&["s1".to_string()], false).expect("non-empty keep is allowed");
    }

    // ── T08.1：save_session_body 自愈补建会话行 ──

    #[test]
    fn save_session_body_self_heals_missing_session_row() {
        let db = LocalDb::open_in_memory().unwrap();
        let messages = [
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ];

        // 全新内存库：无索引行，自愈后正文可写入（不再 FK 失败）。
        self_heal_then_save_body(&db, "s1", &messages).expect("self-heal save");

        let body = db.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2);
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].id, "s1");
        // 触发器维护 message_count。
        assert_eq!(list[0].message_count, 2);
    }

    #[test]
    fn save_session_body_self_heal_keeps_existing_row() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();

        let messages = [sample_message("m1", "user", 1)];
        self_heal_then_save_body(&db, "s1", &messages).expect("save with existing row");

        // 既有索引行不被覆盖（INSERT OR IGNORE 幂等）。
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].title, "Title s1");
    }

    // ── F3：upsert_session_entry 命令层校验 ──

    #[test]
    fn upsert_requires_non_empty_entry_id() {
        let mut entry = sample_entry("s1");
        entry.id = "   ".to_string();
        assert!(require_session_id(&entry.id).is_err());
    }

    #[test]
    fn upsert_does_not_cascade_delete_messages() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body(
            "s1",
            &[
                sample_message("m1", "user", 1),
                sample_message("m2", "assistant", 2),
            ],
        )
        .unwrap();

        // 再次 upsert 同一会话，不应丢失消息。
        let mut entry = sample_entry("s1");
        entry.title = "Updated Title".to_string();
        db.upsert_session_entry(&entry).unwrap();

        let body = db.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2);
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].title, "Updated Title");
        assert_eq!(list[0].message_count, 2);
    }

    #[test]
    fn end_to_end_via_shared_db() {
        // 验证 SharedDb.local_db() 与 LocalDb 行为一致
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
