//! 迁移链域：`PRAGMA user_version` 驱动的版本化迁移（v1→v14，PE-08 T08.7 + P5 §3.1.4
//! 及 T-D-07 v6 新列 + T-15 v7 compression_blocks 单表 + v8 浏览器导入目标表 +
//! v9 事件 run 归属列 + v10 usage_records 时序表 + v11 app_preferences 偏好表 +
//! v13 孤儿 session_meta 键 GC（RUN-15））。逐版本独立事务、
//! 幂等可重试；DROP 前备份采用
//! 「事务前 checkpoint + 备份」时序（[LocalDb::backup_before_drop]，见 [LocalDb::migrate]）：
//! 版本升级事务 commit 之前先 `PRAGMA wal_checkpoint(TRUNCATE)` 固化旧库到
//! 主文件再拷贝，备份内容确定 = 本版本迁移前完整旧库（11-T2 时序确定化）；
//! 备份失败按裁定案（2026-08-06）告警不阻断迁移。新库直接建 v5 结构。
//! 迁移实现保持原样，由 `LocalDb::open` 触发。

use super::migrate_steps::*;
use super::schema::{create_v1_schema, create_v5_schema};
use super::{
    DbFailure, DbFailureKind, LocalDb, BACKUP_KEEP, LATEST_VERSION, SCHEMA_VERSION_STRING,
};
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
    /// 11-T2 时序契约：调用方（[LocalDb::migrate]）必须在版本升级事务 commit 之前
    /// 先执行 `PRAGMA wal_checkpoint(TRUNCATE)` 再调用本函数——拷贝的主文件
    /// = 完整旧库形态（与 autocheckpoint 偶然时机无关，黄金字节对比测试锁定）。
    /// 返回 `Err(原因)` = 备份失败（不阻断迁移，由调用方 [LocalDb::report_backup_failure]
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
                // 旧备份清理属 best-effort 收尾：残留仅多占一份磁盘副本，
                // 不影响本次备份与迁移，故记录告警而不上抛（否则会误报迁移失败）
                if let Err(err) = std::fs::remove_file(oldest) {
                    if err.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(
                            error = %err,
                            path = %oldest.display(),
                            "清理超出保留份数的旧迁移备份失败，已保留残留"
                        );
                    }
                }
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
        // 可观测键写入失败不影响迁移（顺带增强，不强制）——但必须留痕，
        // 否则「备份失败」这一事实在 UI/日志侧完全不可见
        if let Err(err) = conn.execute(
            "INSERT OR REPLACE INTO session_meta (key, value) VALUES ('migration_backup_failed', ?1)",
            rusqlite::params![format!("v{version}: {detail}")],
        ) {
            tracing::warn!(
                error = %err,
                version,
                "写入迁移备份失败可观测键 session_meta.migration_backup_failed 失败"
            );
        }
    }

    /// Run schema migrations.
    ///
    /// 版本化迁移（PE-08 T08.7）：以 `PRAGMA user_version` 为权威源，
    /// 从当前版本逐级迁移到 [LATEST_VERSION]；每版本独立事务、幂等可重试；
    /// DROP 前备份（[LocalDb::backup_before_drop]），时序确定化（11-T2）：
    /// 每版本「checkpoint(TRUNCATE) → 备份」先于版本事务 commit 执行，
    /// 备份失败告警不阻断迁移（2026-08-06 裁定案）；新库直接建 v5 结构。
    pub(crate) fn migrate(&self) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| self.latch_error("pragma_foreign_keys", e))?;
        // WAL 模式 + busy_timeout（PE-08 T08.7：并发写友好）：与上面 FK pragma
        // 同为迁移前置不变量（写入并发能力依赖它），失败必须 fail-fast 上抛，
        // 否则会以「偶发 SQLITE_BUSY」的形式在后续写路径隐式暴露
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
            .map_err(|e| self.latch_error("pragma_wal_busy_timeout", e))?;

        let current: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version_read", e))?;

        if current > LATEST_VERSION {
            // 未来版本库（新二进制写、旧二进制读）：拒绝打开而不是按当前
            // 结构「修复」——后者会 DROP 未来版本触发器/索引并把
            // schema_version 回写为旧值。
            let failure = DbFailure {
                message: format!(
                    "database schema version {current} is newer than supported {LATEST_VERSION}"
                ),
                kind: DbFailureKind::Migration,
            };
            self.set_failure(failure.clone());
            return Err(failure);
        }

        if current == LATEST_VERSION {
            // 已是目标版本：幂等修复。只重跑 v5 起的**幂等 DDL 步骤**
            // （ADD COLUMN col-check / CREATE TABLE IF NOT EXISTS / 孤儿键
            // 清理），修复残缺库（如 usage_records / compression_blocks 等
            // 晚出版本表缺失）；v2..v4 含表重建，禁止在最新结构上重演。
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| self.latch_error("schema_repair_tx", e))?;
            tx.execute_batch(create_v5_schema())
                .map_err(|e| self.latch_error("schema_ensure", e))?;
            type RepairStep = fn(&rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error>;
            // v13 为数据清理（删除孤儿 session_meta 键），不属于结构修复：
            // 每次打开都重跑会误删「先写 meta、后建会话行」的合法场景，
            // 故修复面只含 idempotent 结构步骤（v5..v12 + v14）。
            let repair_steps: [(u32, RepairStep); 10] = [
                (5, migrate_v4_to_v5),
                (6, migrate_v5_to_v6),
                (7, migrate_v6_to_v7),
                (8, migrate_v7_to_v8),
                (9, migrate_v8_to_v9),
                (10, migrate_v9_to_v10),
                (11, step_10_to_11),
                (12, step_11_to_12),
                (14, step_13_to_14),
                (15, step_14_to_15),
            ];
            for (version, step) in repair_steps {
                step(&tx).map_err(|e| self.latch_error(&format!("schema_repair_v{version}"), e))?;
            }
            tx.commit()
                .map_err(|e| self.latch_error("schema_repair_commit", e))?;
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
            .filter(|p| p != Path::new(":memory:") && !p.as_os_str().is_empty());
        let start_version = if current == 0 { 1 } else { current };

        for version in (start_version + 1)..=LATEST_VERSION {
            // 备份时序（11-T2 确定化）：版本事务 commit 之前执行
            // 「checkpoint(TRUNCATE) → 拷贝备份」。TRUNCATE 后 WAL 清空、
            // 主文件 = 完整旧库态，拷贝内容确定（与 autocheckpoint 偶然时机无关）。
            // v5/v6/v9/v14 纯 ADD COLUMN、v7/v8/v10/v11/v12 纯新建表/纯 DDL、
            // v13 纯 DML（均无 DROP）：跳过备份，保持「DROP 前备份」语义。
            // （backup_file_contains_pre_migration_data / upgrade_e2e_backup_*
            // 锚定 v3→v4 只产 .bak-v4，v5..v14 不额外产生备份）
            if let Some(p) = &path {
                if !(5..=15).contains(&version) {
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
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| self.latch_error(&format!("migrate_tx_v{version}"), e))?;
            // IMMEDIATE 已持有写锁：事务内复核版本，跨进程并发迁移时后到者
            // 直接跳过已推进版本，不在新结构上重演旧步骤（避免 DROP 列/
            // 重建表导致的数据丢失）。
            let in_tx_version: u32 = tx
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(|e| self.latch_error(&format!("migrate_version_recheck_v{version}"), e))?;
            if in_tx_version >= version {
                tx.commit()
                    .map_err(|e| self.latch_error(&format!("migrate_skip_commit_v{version}"), e))?;
                continue;
            }
            let step_result = match version {
                2 => migrate_v1_to_v2(&tx),
                3 => migrate_v2_to_v3(&tx),
                4 => migrate_v3_to_v4(&tx),
                5 => migrate_v4_to_v5(&tx),
                6 => migrate_v5_to_v6(&tx),
                7 => migrate_v6_to_v7(&tx),
                8 => migrate_v7_to_v8(&tx),
                9 => migrate_v8_to_v9(&tx),
                10 => migrate_v9_to_v10(&tx),
                11 => step_10_to_11(&tx),
                12 => step_11_to_12(&tx),
                13 => step_12_to_13(&tx),
                14 => step_13_to_14(&tx),
                15 => step_14_to_15(&tx),
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
