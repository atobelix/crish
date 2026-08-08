//! 迁移链域：`PRAGMA user_version` 驱动的版本化迁移（v1→v7，PE-08 T08.7 + P5 §3.1.4
//! 及 T-D-07 v6 新列 + T-15 v7 compression_blocks 单表）。逐版本独立事务、
//! 幂等可重试；DROP 前备份采用
//! 「事务前 checkpoint + 备份」时序（[backup_before_drop]，见 [migrate]）：
//! 版本升级事务 commit 之前先 `PRAGMA wal_checkpoint(TRUNCATE)` 固化旧库到
//! 主文件再拷贝，备份内容确定 = 本版本迁移前完整旧库（11-T2 时序确定化）；
//! 备份失败按裁定案（2026-08-06）告警不阻断迁移。新库直接建 v5 结构。
//! 迁移实现保持原样，由 `LocalDb::open` 触发。

use super::schema::{create_v1_schema, create_v5_schema};
use super::{DbFailure, DbFailureKind, LocalDb, BACKUP_KEEP, LATEST_VERSION, SCHEMA_VERSION_STRING};
use std::path::Path;

impl LocalDb {
    /// 读取当前 schema 版本（PRAGMA user_version，PE-08 T08.7）。
    pub fn user_version(&self) -> Result<u32, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version", e))
    }

    /// 迁移备份：整库拷贝到 `sessions.db.bak-v{n}`，保留最近 [BACKUP_KEEP] 份。
    ///
    /// 11-T2 时序契约：调用方（[migrate]）必须在版本升级事务 commit 之前
    /// 先执行 `PRAGMA wal_checkpoint(TRUNCATE)` 再调用本函数——拷贝的主文件
    /// = 完整旧库形态（与 autocheckpoint 偶然时机无关，黄金字节对比测试锁定）。
    /// 返回 `Err(原因)` = 备份失败（不阻断迁移，由调用方 [report_backup_failure]
    /// 输出告警并落可观测键）。
    #[allow(clippy::disallowed_methods)]
    // G2 禁令豁免（clippy.toml 文件头「豁免面」）：迁移备份轮转——删除对象是
    // 迁移时本库自产的最旧备份（新备份已生成，旧备份被取代），非用户文件，
    // 进回收站/快照会留下陈旧 DB 副本（含敏感数据），轮转物理删除更正确。
    fn backup_before_drop(&self, path: &Path, version: u32) -> Result<(), String> {
        let Some(dir) = path.parent() else {
            return Err("无父目录".into());
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "sessions.db".into());
        let backup = dir.join(format!("{name}.bak-v{version}"));
        if let Err(e) = std::fs::copy(path, &backup) {
            return Err(format!("{e}（路径 {}）", path.display()));
        }
        // 清理旧备份，只保留最近 BACKUP_KEEP 份
        let mut backups: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(&format!("{name}.bak-v")))
                    .unwrap_or(false)
            })
            .collect();
        backups.sort();
        while backups.len() > BACKUP_KEEP {
            if let Some(oldest) = backups.first() {
                let _ = std::fs::remove_file(oldest);
                backups.remove(0);
            }
        }
        Ok(())
    }

    /// 备份失败告警（裁定案 2026-08-06：告警不阻断迁移——版本升级继续）。
    /// 结构化告警输出（含版本号与备份路径）+ 写入 session_meta 可观测键
    /// `migration_backup_failed`（JS 侧经 get_session_meta 读取）；可观测键
    /// 写入失败不影响迁移（顺带增强，不强制）。
    fn report_backup_failure(
        &self,
        conn: &rusqlite::Connection,
        version: u32,
        path: &Path,
        detail: &str,
    ) {
        eprintln!(
            "[conex-db] 迁移备份失败 v{version}: {detail}（备份路径 {}）—— 按裁定案告警不阻断迁移，版本升级继续",
            path.display()
        );
        let _ = conn.execute(
            "INSERT OR REPLACE INTO session_meta (key, value) VALUES ('migration_backup_failed', ?1)",
            rusqlite::params![format!("v{version}: {detail}")],
        );
    }

    /// Run schema migrations.
    ///
    /// 版本化迁移（PE-08 T08.7）：以 `PRAGMA user_version` 为权威源，
    /// 从当前版本逐级迁移到 [LATEST_VERSION]；每版本独立事务、幂等可重试；
    /// DROP 前备份（[backup_before_drop]），时序确定化（11-T2）：
    /// 每版本「checkpoint(TRUNCATE) → 备份」先于版本事务 commit 执行，
    /// 备份失败告警不阻断迁移（2026-08-06 裁定案）；新库直接建 v5 结构。
    pub(crate) fn migrate(&self) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| self.latch_error("pragma_foreign_keys", e))?;
        // WAL 模式 + busy_timeout（PE-08 T08.7：并发写友好）
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

        let current: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version_read", e))?;

        if current == LATEST_VERSION {
            // 已是目标版本：确保关键结构存在（幂等兜底，含备份恢复场景）
            conn.execute_batch(create_v5_schema())
                .map_err(|e| self.latch_error("schema_ensure", e))?;
            self.record_schema_version(&conn)?;
            return Ok(());
        }

        // 全新库（无 sessions 表）：建 v1 形态后走完整迁移链
        // （fresh_db_full_chain 测试锚定：全新建库也执行 v1..v5 全部迁移，
        // 验证迁移链自身正确性，且 DROP 前备份产生）。
        let has_sessions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error("has_sessions", e))?;
        if current == 0 && has_sessions == 0 {
            conn.execute_batch(create_v1_schema())
                .map_err(|e| self.latch_error("schema_create_v1", e))?;
            conn.execute_batch("PRAGMA user_version = 1;")
                .map_err(|e| self.latch_error("user_version_set_1", e))?;
        }

        // 逐版本迁移（旧生产形态 user_version=0 但已有旧表：按 v1 起点迁移）
        let path: Option<std::path::PathBuf> = conn
            .path()
            .map(std::path::PathBuf::from)
            .filter(|p| {
                p != Path::new(":memory:") && !p.as_os_str().is_empty()
            });
        let start_version = if current == 0 { 1 } else { current };

        for version in (start_version + 1)..=LATEST_VERSION {
            // 备份时序（11-T2 确定化）：版本事务 commit 之前执行
            // 「checkpoint(TRUNCATE) → 拷贝备份」。TRUNCATE 后 WAL 清空、
            // 主文件 = 完整旧库态，拷贝内容确定（与 autocheckpoint 偶然时机无关）。
            // v5/v6 纯 ADD COLUMN、v7 纯新建表（均无 DROP）：跳过备份，
            // 保持「DROP 前备份」语义。
            // （backup_file_contains_pre_migration_data / upgrade_e2e_backup_*
            // 锚定 v3→v4 只产 .bak-v4，v5/v6/v7 不额外产生备份）
            if let Some(p) = &path {
                if !(5..=7).contains(&version) {
                    // checkpoint 失败 → 备份内容不确定，按备份失败处理：
                    // 告警 + 跳过本次备份，不阻断迁移（裁定案）
                    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
                        self.report_backup_failure(
                            &conn,
                            version,
                            p,
                            &format!("wal_checkpoint(TRUNCATE) 失败: {e}"),
                        );
                    } else if let Err(detail) = self.backup_before_drop(p, version) {
                        self.report_backup_failure(&conn, version, p, &detail);
                    }
                }
            }
            let tx = conn
                .transaction()
                .map_err(|e| self.latch_error(&format!("migrate_tx_v{version}"), e))?;
            let step_result = match version {
                2 => migrate_v1_to_v2(&tx),
                3 => migrate_v2_to_v3(&tx),
                4 => migrate_v3_to_v4(&tx),
                5 => migrate_v4_to_v5(&tx),
                6 => migrate_v5_to_v6(&tx),
                7 => migrate_v6_to_v7(&tx),
                _ => unreachable!(),
            };
            if let Err(e) = step_result {
                let msg = format!("migrate_v{version} failed: {e}");
                let failure = DbFailure {
                    message: msg,
                    kind: DbFailureKind::Migration,
                };
                self.set_failure(failure.clone());
                return Err(failure);
            }
            // T3.1 D1（PS-03）：user_version 移入迁移事务内——SQLite 的
            // user_version 参与事务回滚，与结构迁移 commit 原子可见；
            // 消除「commit 成功 → PRAGMA 前崩溃」死态（R2 §1.3/§1.4）：
            // 修复后崩溃只可能整体回滚，重跑回到干净的旧版本形态。
            tx.execute_batch(&format!("PRAGMA user_version = {version};"))
                .map_err(|e| self.latch_error(&format!("user_version_set_v{version}"), e))?;
            tx.commit()
                .map_err(|e| self.latch_error(&format!("migrate_commit_v{version}"), e))?;
        }

        // 迁移完成后 ensure v5 结构（补触发器/索引；幂等）
        conn.execute_batch(create_v5_schema())
            .map_err(|e| self.latch_error("schema_ensure_post_migrate", e))?;
        self.record_schema_version(&conn)?;

        Ok(())
    }

    /// 登记 schema 版本到 session_meta（JS 侧经 get_session_meta 读取）。
    fn record_schema_version(&self, conn: &rusqlite::Connection) -> Result<(), DbFailure> {
        conn.execute(
            "INSERT OR IGNORE INTO session_meta (key, value) VALUES ('schema_version', ?1)",
            rusqlite::params![SCHEMA_VERSION_STRING],
        )
        .map_err(|e| self.latch_error("schema_version_set", e))?;
        conn.execute(
            "UPDATE session_meta SET value = ?1 WHERE key = 'schema_version'",
            rusqlite::params![SCHEMA_VERSION_STRING],
        )
        .map_err(|e| self.latch_error("schema_version_update", e))?;
        Ok(())
    }
}

/// v1 → v2：sessions 补 folder 等列（ADD COLUMN，避免 RENAME+DROP 父表
/// 触发 ON DELETE CASCADE 清空 session_messages / session_agents 数据）。
fn migrate_v1_to_v2(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let cols: Vec<String> = tx
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    let add = |tx: &rusqlite::Transaction<'_>, col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add(tx, "folder", "folder TEXT NOT NULL DEFAULT '常规会话'")?;
    add(tx, "is_pinned", "is_pinned INTEGER NOT NULL DEFAULT 0")?;
    add(tx, "is_archived", "is_archived INTEGER NOT NULL DEFAULT 0")?;
    add(tx, "branch_parent_id", "branch_parent_id TEXT")?;
    add(tx, "timestamp_source", "timestamp_source TEXT")?;
    add(tx, "pinned_message_ids", "pinned_message_ids TEXT")?;
    add(tx, "engine_cursor", "engine_cursor INTEGER")?;
    add(tx, "engine_last_run_id", "engine_last_run_id TEXT")?;
    add(tx, "hydrated_from_engine", "hydrated_from_engine INTEGER")?;
    Ok(())
}

/// v2 → v3：session_agent_messages 重建补 CHECK (status IN ...) 约束（数据拷贝）。
fn migrate_v2_to_v3(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "ALTER TABLE session_agent_messages RENAME TO sam_v2;
         CREATE TABLE session_agent_messages (
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            id TEXT NOT NULL,
            sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
            text TEXT,
            thinking TEXT,
            timestamp INTEGER NOT NULL,
            status TEXT CHECK (status IN ('queued','processing','completed','error')),
            stream_text_offset INTEGER,
            thinking_time INTEGER,
            tool_calls_json TEXT,
            blocks_json TEXT,
            tool_call_results_json TEXT,
            PRIMARY KEY (session_id, agent_id, seq),
            FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO session_agent_messages
            (session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
             stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json)
            SELECT session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
             stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json
            FROM sam_v2;
         DROP TABLE sam_v2;",
    )
}

/// v3 → v4：events 重建为组合主键（无 id 列 + FK）、metadata 删除、
/// runs/pending_inputs 加 FK（孤儿行过滤）、session_messages 加 updated_at、
/// session_sequence 建表/对齐。
fn migrate_v3_to_v4(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    // 历史早期形态库可能缺 runs / pending_inputs 表（2026-08-08 现场：
    // apps/agent-workbench/sessions.db user_version=3 无这两张表——早期
    // v1 形态不含它们，后续版本才引入；v1→v3 迁移链不创建，v3→v4 却
    // 无条件查询 → `no such table: runs` 迁移崩溃、DB 打不开降级内存库）。
    // 缺失时按 v3 老 DDL 创建（无 FK 形态），再走下方重建逻辑幂等推进；
    // 已有表时跳过（对齐 session_sequence 的 col-check 幂等模式）。
    let table_exists = |tx: &rusqlite::Transaction<'_>, name: &str| -> Result<bool, rusqlite::Error> {
        let n: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    };
    if !table_exists(tx, "runs")? {
        tx.execute_batch(
            "CREATE TABLE runs (
                run_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                status TEXT NOT NULL,
                end_reason TEXT,
                cursor INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            ) WITHOUT ROWID;",
        )?;
    }
    if !table_exists(tx, "pending_inputs")? {
        tx.execute_batch(
            "CREATE TABLE pending_inputs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                run_id TEXT,
                payload TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL DEFAULT 0
            ) WITHOUT ROWID;",
        )?;
    }
    // 孤儿计数（会话不存在的 events/runs/pending 行）→ 写入 session_meta 可观测
    let orphan_events: i64 = tx.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    let orphan_runs: i64 = tx.query_row(
        "SELECT COUNT(*) FROM runs WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    let orphan_pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pending_inputs WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO session_meta (key, value) VALUES ('migration_v4_dropped_orphans', ?1)",
        rusqlite::params![format!("{orphan_events}:{orphan_runs}:{orphan_pending}")],
    )?;
    tx.execute_batch(
        "ALTER TABLE events RENAME TO events_v3;
         CREATE TABLE events (
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, sequence),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO events (session_id, sequence, event_type, payload, created_at)
            SELECT session_id, sequence, event_type, payload, created_at FROM events_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE events_v3;

         DROP TABLE IF EXISTS metadata;

         ALTER TABLE runs RENAME TO runs_v3;
         CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            end_reason TEXT,
            cursor INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
            SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at FROM runs_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE runs_v3;
         CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

         ALTER TABLE pending_inputs RENAME TO pending_v3;
         CREATE TABLE pending_inputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO pending_inputs (id, session_id, run_id, payload, created_at)
            SELECT id, session_id, run_id, payload, created_at FROM pending_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE pending_v3;
         CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_inputs(session_id, created_at);",
    )?;
    // T3.1 D1（PS-03）：updated_at 加列存在性检查（对齐 v1→v2 / v4→v5 的
    // col-check 模式）——崩溃中间态重跑（结构已 v4、版本仍 v3）不再因
    // `duplicate column name: updated_at` 而 latch 死库；本步是 v3→v4
    // 整段 execute_batch 中唯一非幂等步骤（R2 §1），拆出条件执行后
    // 结构重建整体幂等，重跑自愈。
    let msg_cols = table_columns(tx, "session_messages")?;
    if !msg_cols.iter().any(|c| c == "updated_at") {
        tx.execute_batch("ALTER TABLE session_messages ADD COLUMN updated_at INTEGER;")?;
    }
    // session_sequence：v3 形态可能不存在（v1/v2 fixture）——不存在则直接建；
    // 存在则重建对齐 next_sequence 列名并过滤孤儿。
    // T3.1 D1（PS-03）幂等化补充：崩溃中间态重跑时本表可能已是 v4 形态
    // （next_sequence 列名）——按源表实际列名判定，避免硬编码
    // `SELECT next_seq FROM ss_v3` 抛 `no such column: next_seq` 再次 latch 死库。
    let has_ss: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_sequence'",
        [],
        |r| r.get(0),
    )?;
    if has_ss > 0 {
        let ss_cols = table_columns(tx, "session_sequence")?;
        if ss_cols.iter().any(|c| c == "next_seq") {
            // v3 形态（next_seq 列名）：重建对齐 next_sequence + 孤儿过滤
            tx.execute_batch(
                "ALTER TABLE session_sequence RENAME TO ss_v3;
                 CREATE TABLE session_sequence (
                    session_id TEXT PRIMARY KEY,
                    next_sequence INTEGER NOT NULL DEFAULT 1
                 ) WITHOUT ROWID;
                 INSERT INTO session_sequence (session_id, next_sequence)
                    SELECT session_id, next_seq FROM ss_v3
                    WHERE session_id IN (SELECT id FROM sessions);
                 DROP TABLE ss_v3;",
            )?;
        }
        // 已是 v4 形态（next_sequence 列）：重跑幂等跳过重建
    } else {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_sequence (
                session_id TEXT PRIMARY KEY,
                next_sequence INTEGER NOT NULL DEFAULT 1
             ) WITHOUT ROWID;",
        )?;
    }
    Ok(())
}

/// 查询表的列名清单（`PRAGMA table_info`；v5 col-check 幂等复用）。
fn table_columns(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let mapped = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(mapped.filter_map(|c| c.ok()).collect::<Vec<String>>())
}

/// v4 → v5：runs 补 run 级 usage/cache 列 + session_messages 补 usage_json（P5 §3.1.4 / C8）。
///
/// 纯 ADD COLUMN（无 DROP、无重建），col-check 幂等（对齐 v1→v2 模式，migrate.rs:161-183）：
/// - runs：prompt/completion/total/cache_read/cache_write/cache_miss/sample_count/missed_tokens
///   （NOT NULL DEFAULT 0，旧行自动补 0）+ warm_until_ms（NULL 兼容）；
/// - session_messages：usage_json TEXT（消息级 usage 快照，前端 saveSessionBody 写入面）。
///   hit_ratio / write_ratio 不落库（可派生，口径一致）。
fn migrate_v4_to_v5(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let runs_cols = table_columns(tx, "runs")?;
    let add_run_col = |col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !runs_cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE runs ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add_run_col("prompt_tokens", "prompt_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("completion_tokens", "completion_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("total_tokens", "total_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("cache_read_tokens", "cache_read_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("cache_write_tokens", "cache_write_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("cache_miss_tokens", "cache_miss_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("sample_count", "sample_count INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("missed_tokens", "missed_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col("warm_until_ms", "warm_until_ms INTEGER")?;
    let msg_cols = table_columns(tx, "session_messages")?;
    if !msg_cols.iter().any(|c| c == "usage_json") {
        tx.execute_batch("ALTER TABLE session_messages ADD COLUMN usage_json TEXT;")?;
    }
    Ok(())
}

/// v5 → v6：session_agents 补定义扩展三列（T-D-07，REQ-D04 收敛参数落库）。
///
/// 纯 ADD COLUMN（无 DROP、无重建），col-check 幂等（对齐 v1→v2 / v4→v5 模式，
/// migrate.rs:161-183）：
/// - `task_type` TEXT：任务类型 wire 名快照（analysis/design/...，kebab-case）；
/// - `display_label` TEXT：角色展示标签（2-5 字自由文本，T-D-05）；
/// - `allowed_write_paths_json` TEXT：显式写路径白名单（JSON 字符串数组，
///   硬沙箱消费输入）。
///
/// 旧行三列自动补 NULL（Option 语义，读回 None = 未声明）；`model_override`
/// 扩展点预留**不落库**（T-D-10「多模型不做」，无对应列）。
/// 表缺失守卫（对齐 v3→v4 的 session_sequence 存在性检查，migrate.rs:305-309）：
/// 极简/异常库可能无 session_agents 表——跳过本步，由迁移收尾的
/// ensure（create_v5_schema，含新列）补建，兼容不炸。
fn migrate_v5_to_v6(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let has_agents: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_agents'",
        [],
        |r| r.get(0),
    )?;
    if has_agents == 0 {
        return Ok(());
    }
    let agent_cols = table_columns(tx, "session_agents")?;
    let add_agent_col = |col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !agent_cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE session_agents ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add_agent_col("task_type", "task_type TEXT")?;
    add_agent_col("display_label", "display_label TEXT")?;
    add_agent_col(
        "allowed_write_paths_json",
        "allowed_write_paths_json TEXT",
    )?;
    Ok(())
}

/// v6 → v7：新增 compression_blocks 压缩块单表（T-15，R-A 复合主键）。
///
/// 零既有列改动（只建新表 + 索引），不触发全表重写（P5 §3.1.4 备份-DROP
/// 风险不适用）；`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
/// 天然幂等（崩溃中间态重跑自愈，对齐既有「每版本独立事务」约定）。
///
/// 列语义（00-plan §4.4 CompactionBlockMeta + 04 summary_documents 合列）：
/// - 复合主键 (session_id, block_id)——R-B 块 id 仅会话内唯一，全局主键
///   会让跨会话同序块行被 INSERT OR IGNORE 静默吞掉（评审 01 P0-3）；
/// - dropped_message_ids 为 JSON 数组字符串；state 状态机 awaiting →
///   committed | retired；summary_json 可空（stub 期为 NULL）。
fn migrate_v6_to_v7(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS compression_blocks (
            session_id          TEXT NOT NULL,
            block_id            TEXT NOT NULL,
            sequence            INTEGER NOT NULL,
            generation          INTEGER NOT NULL,
            prev_block_id       TEXT,
            dropped_message_ids TEXT NOT NULL,
            first_kept_message_id TEXT,
            summary             TEXT NOT NULL,
            summary_is_llm      INTEGER NOT NULL DEFAULT 0,
            tokens_before       INTEGER NOT NULL DEFAULT 0,
            tokens_after        INTEGER NOT NULL DEFAULT 0,
            dropped_at_ms       INTEGER NOT NULL,
            state               TEXT NOT NULL DEFAULT 'awaiting',
            summary_json        TEXT,
            schema_version      INTEGER NOT NULL DEFAULT 1,
            height              INTEGER NOT NULL DEFAULT 1,
            tier                TEXT,
            attempts            INTEGER NOT NULL DEFAULT 0,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL,
            PRIMARY KEY (session_id, block_id)
        );
        CREATE INDEX IF NOT EXISTS idx_compression_blocks_session_gen
            ON compression_blocks (session_id, generation DESC);",
    )
}
