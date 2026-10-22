//! Stream B + PE-08：Tauri 命令层 —— 会话 SQLite 持久化入口
//!
//! 本模块提供 10 个 `#[tauri::command]`，包装 `conex_db::LocalDb` 的会话存储方法，
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
//!
//! F11b（T-D-12）：`get_flow_snapshot(session_id)` —— DAG 只读查询命令
//! （读 `flow_declaration` + `flow_state` + `session_agents` 按 subagent_run_id
//! 拼装节点状态，返回冻结载荷形状；只读通用面，无任何写入）。

use std::sync::Arc;

use conex_db::{DbFailure, LocalDb};
use conex_types::{CoreError, SessionAgent, SessionIndexEntry, SessionMessage};
use tauri::State;

mod cleanup_import;
mod flow;

// `#[tauri::command]` 生成的 `__cmd__*` 隐藏宏须随命令同路径可达（main.rs
// `command_registry!` → `generate_handler![session_commands::xxx]`），故用 glob 重导出。
pub use cleanup_import::*;
pub use flow::*;

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
        self.ready.load(std::sync::atomic::Ordering::Relaxed) && self.db.get_failure().is_none()
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
///
/// `batch_version`（D3-4 / DEL-8）：`Some(v)` 走 CAS（过期批次返回可识别
/// CasConflict，禁止静默 Ok）；`None` = 显式非 CAS rebase（导入/恢复/旧前端兼容）。
fn self_heal_then_save_body(
    db: &LocalDb,
    session_id: &str,
    messages: &[SessionMessage],
    batch_version: Option<i64>,
) -> Result<(), DbFailure> {
    db.insert_session(session_id, "")?;
    db.save_session_body_versioned(session_id, messages, batch_version)
}

#[tauri::command]
pub async fn list_sessions(
    db_state: State<'_, SharedDb>,
) -> Result<Vec<SessionIndexEntry>, CoreError> {
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

/// `batch_version`：批次版本戳（CAS 防线 2；前端 camelCase 自动映射）。
/// 缺省 = 显式非 CAS 全量 rebase（导入/恢复/自愈路径）——禁止将缺参静默当作 CAS 通过。
#[tauri::command]
pub async fn save_session_body(
    session_id: String,
    messages: Vec<SessionMessage>,
    batch_version: Option<i64>,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || {
        self_heal_then_save_body(&db, &session_id, &messages, batch_version)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("save_session_body join: {e}")))?
    .map_err(map_db_err)?;
    Ok(())
}

/// delete_session_and_read_meta（测试使用）：删除前读取产出元数据
/// （`{session_id}:output_dir` / `{session_id}:output_root`，G01/G03 键），
/// 再删除会话行——meta 必须先读后删，否则行消失后无法定位产出目录。
#[cfg(test)]
fn delete_session_and_read_meta(
    db: &LocalDb,
    session_id: &str,
) -> Result<(Option<String>, Option<String>), DbFailure> {
    let dir_key = crate::outputs_config::session_meta_key_of(
        session_id,
        crate::outputs_config::SESSION_META_KEY_OUTPUT_DIR,
    );
    let root_key = crate::outputs_config::session_meta_key_of(
        session_id,
        crate::outputs_config::SESSION_META_KEY_OUTPUT_ROOT,
    );
    let dir = db.get_session_meta(&dir_key)?;
    let root = db.get_session_meta(&root_key)?;
    db.delete_session(session_id)?;
    Ok((dir, root))
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

#[cfg(test)]
mod tests;
