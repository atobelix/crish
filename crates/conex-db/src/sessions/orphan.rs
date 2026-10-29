//! 孤儿会话清理（宽限期 + 豁免护栏）与会话级 session_meta 前缀键清理。

use crate::{DbFailure, DbFailureKind, ORPHAN_GRACE_MS, ORPHAN_GRACE_MS_KEY};
use rusqlite::OptionalExtension;

/// 孤儿清理单个结果（RUN-07）：被删会话 id + 删除事务内捕获的产出 meta 值。
///
/// 产出 meta 键（`{session_id}:output_dir` / `{session_id}:output_root`）
/// 在删行前读取——RUN-15 起删除路径同事务清理前缀键，行删后无从反查。
/// 壳层（session_commands::cleanup_orphan_sessions）消费该值把产出目录
/// 送回收站（trash）并通知用户。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanCleanupOutcome {
    /// 被删除的会话 id
    pub session_id: String,
    /// `{session_id}:output_dir` 键值（G01 首次 resolve 落键；未落为 None）
    pub output_dir: Option<String>,
    /// `{session_id}:output_root` 键值（G03 会话级覆盖；未落为 None）
    pub output_root: Option<String>,
}

/// 孤儿会话清理连接级纯函数（D-P11：供 `write_blocking` 闭包调用；
/// 绝对禁止捕获 `LocalDb` / 调用 `self.*` / 开启 `conn.transaction()`——
/// 外层 Actor 已持 `BEGIN IMMEDIATE`，本函数直接在其事务内顺序执行）。
pub(crate) fn cleanup_orphan_sessions_conn(
    conn: &rusqlite::Connection,
    active_ids: &[String],
) -> Result<Vec<OrphanCleanupOutcome>, DbFailure> {
    // 宽限期（PE-08 T08.2）：updated_at 距今小于该值的会话不被清理。
    // 值可从 session_meta 的 orphan_grace_ms 覆盖（默认 ORPHAN_GRACE_MS）。
    let grace_ms: i64 = conn
        .query_row(
            "SELECT value FROM session_meta WHERE key = ?1",
            rusqlite::params![ORPHAN_GRACE_MS_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(ORPHAN_GRACE_MS);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let grace_cutoff = now_ms - grace_ms;

    // 豁免条件（两个删除分支共用）：引擎子代理会话 + 活动 run 会话 +
    // 未决 pending 输入。hydrated_from_engine 为 NULL（普通会话）时
    // COALESCE 取 0 → 可删。
    let protected = "COALESCE(hydrated_from_engine, 0) != 1
            AND NOT EXISTS (
                SELECT 1 FROM runs r
                WHERE r.session_id = sessions.id
                  AND r.status IN (
                      'queued','initializing','running','awaiting-approval',
                      'completing','cancelling'
                  )
            )
            AND NOT EXISTS (
                SELECT 1 FROM pending_inputs p
                WHERE p.session_id = sessions.id
            )";

    // SEC-11：直接采用 conn.execute() 返回的受影响行数（sqlite3_changes 仅计入直接目标表 sessions，
    // 不计入外键级联子表），彻底消除删除前后两次全表 SELECT COUNT(*) 扫描。
    // RUN-15：先按同一条件收集将被删除的会话 id（供删除后同事务清理其
    // session_meta 前缀键），再执行 DELETE——meta 无 FK 级联，行删后无从反查。
    // RUN-07：收集时同步捕获产出 meta 值（output_dir/output_root，删行/删键
    // 前的最后一读），随结果返回给壳层做回收站清理与用户通知。
    let mut orphan_ids: Vec<String> = Vec::new();
    let mut outcomes: Vec<OrphanCleanupOutcome> = Vec::new();
    {
        let id_sql = if active_ids.is_empty() {
            format!("SELECT id FROM sessions WHERE updated_at < ?1 AND {protected}")
        } else {
            let placeholders: Vec<String> =
                (0..active_ids.len()).map(|_| "?".to_string()).collect();
            format!(
                "SELECT id FROM sessions WHERE id NOT IN ({}) AND updated_at < ?{} AND {protected}",
                placeholders.join(", "),
                active_ids.len() + 1
            )
        };
        let mut params: Vec<&dyn rusqlite::ToSql> = active_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        params.push(&grace_cutoff);
        let mut stmt = conn.prepare(&id_sql).map_err(|e| DbFailure {
            message: format!("cleanup_orphan_collect_ids: {e}"),
            kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
        })?;
        let rows = stmt
            .query_map(params.as_slice(), |r| r.get::<_, String>(0))
            .map_err(|e| DbFailure {
                message: format!("cleanup_orphan_collect_ids_map: {e}"),
                kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
            })?;
        for id in rows {
            let id = id.map_err(|e| DbFailure {
                message: format!("cleanup_orphan_collect_ids_row: {e}"),
                kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
            })?;
            // RUN-07：删除事务内捕获产出 meta 值（键后缀与 outputs_config.rs
            // SESSION_META_KEY_OUTPUT_DIR/OUTPUT_ROOT、v13 GC 白名单同源）
            let read_meta = |suffix: &str| -> Result<Option<String>, DbFailure> {
                let key = format!("{id}:{suffix}");
                conn.query_row(
                    "SELECT value FROM session_meta WHERE key = ?1",
                    rusqlite::params![key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| DbFailure {
                    message: format!("cleanup_orphan_capture_meta: {e}"),
                    kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
                })
            };
            let output_dir = read_meta("output_dir")?;
            let output_root = read_meta("output_root")?;
            outcomes.push(OrphanCleanupOutcome {
                session_id: id.clone(),
                output_dir,
                output_root,
            });
            orphan_ids.push(id);
        }
    }

    let _deleted = if active_ids.is_empty() {
        // 空 keepIds 的全表清理由壳层守卫（confirm_empty）把关；
        // 库层仍执行宽限期 + 豁免保护（近宽限期内新建 / 引擎 / 活动 run 保留）。
        conn.execute(
            &format!("DELETE FROM sessions WHERE updated_at < ?1 AND {protected}"),
            rusqlite::params![grace_cutoff],
        )
        .map_err(|e| DbFailure {
            message: format!("cleanup_orphan_delete_all: {e}"),
            kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
        })?
    } else {
        // 构造 IN (?, ?, ...) 占位符
        let placeholders: Vec<String> = (0..active_ids.len()).map(|_| "?".to_string()).collect();
        let sql = format!(
            "DELETE FROM sessions WHERE id NOT IN ({}) AND updated_at < ?{} AND {protected}",
            placeholders.join(", "),
            active_ids.len() + 1
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = active_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        params.push(&grace_cutoff);
        conn.execute(&sql, params.as_slice())
            .map_err(|e| DbFailure {
                message: format!("cleanup_orphan_delete: {e}"),
                kind: DbFailureKind::Other("cleanup_orphan_sessions".to_string()),
            })?
    };

    // RUN-15：同事务内清理被删孤儿会话的 session_meta 前缀键（独立 KV 表
    // 无 FK 级联；删行后按收集到的 id 逐个前缀清理，键不残留）与
    // session_sequence 序列槽（无 FK，必须显式删）。
    for id in &orphan_ids {
        delete_session_meta_prefix_conn(conn, id)?;
        delete_session_sequence_conn(conn, id)?;
    }

    // RUN-07：返回带产出 meta 捕获的结果列表（长度 = 实际删除行数，
    // 收集条件与 DELETE 条件完全同构）。
    Ok(outcomes)
}

/// 删除会话的事件序列号槽（`session_sequence` 无 FK 级联：旧实现删会话后
/// 该行永久残留，长期运行库体积只增不减）。
pub(crate) fn delete_session_sequence_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<usize, DbFailure> {
    conn.execute(
        "DELETE FROM session_sequence WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|e| DbFailure {
        message: format!("delete_session_sequence: {e}"),
        kind: DbFailureKind::Other("delete_session_sequence".to_string()),
    })
}

/// 按会话 id 前缀删除 session_meta 键（`{session_id}:*`；RUN-15）。
///
/// 实现口径：`substr(key, 1, length(id)+1) = id || ':'` 的**精确前缀匹配**，
/// 不走 LIKE——会话 id 含 `%`/`_`/`\` 等 LIKE 通配符时不会被展开误删。
/// 全局键（`schema_version` / `active_session_id` / `sched:{wf}` 等）无该
/// 前缀，天然不受影响。返回删除的键数（调用方打日志可观测）。
pub(crate) fn delete_session_meta_prefix_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<usize, DbFailure> {
    let prefix = format!("{session_id}:");
    let deleted = conn
        .execute(
            "DELETE FROM session_meta WHERE substr(key, 1, ?1) = ?2",
            rusqlite::params![prefix.chars().count() as i64, prefix],
        )
        .map_err(|e| DbFailure {
            message: format!("delete_session_meta_prefix: {e}"),
            kind: DbFailureKind::Other("delete_session_meta_prefix".to_string()),
        })?;
    if deleted > 0 {
        tracing::debug!(
            target: "db",
            session_id,
            keys = deleted,
            "删除会话：session_meta 前缀键已级联清理"
        );
    }
    Ok(deleted)
}
