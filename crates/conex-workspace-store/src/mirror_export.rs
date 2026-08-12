//! W2-E：MD mirror 导出 + 延迟水位（**SD-38** · 自 `lib` 门面抽出）。
//!
//! # 模块内聚（**SD-38** · 黄带体积切开）
//! - **本文件**：[`WorkspaceStore::export_md_mirror`] / [`WorkspaceStore::note_authority_advanced`] /
//!   [`WorkspaceStore::mirror_lag`] + [`safe_doc_id`] / [`note_authority_advanced_conn`]
//! - 接线：`mod mirror_export`（无孤儿）；公开方法仍挂 [`WorkspaceStore`]；
//!   `lib` `pub(crate) use` 保持 `crate::safe_doc_id` / `crate::note_authority_advanced_conn`
//! - 测仍在 `lib_tests.rs`（**不**重做 SD-27 测旁挂）
//!
//! **不变量（S1）**：
//! - Conex-MD mirror = 人/git 契约视图，**非**第二写入口、**非**权威。
//! - 工具默认 **禁止** 读 mirror 文件当权威；工具默认读 = 即时 S(树) / 编码态导出。
//! - 本 API 仅服务人/git 可 diff 契约；延迟水位 [`WorkspaceStore::mirror_lag`] 可观测。
//! - **无**「读 mirror 当权威」API（detect/import 仅提案；见 [`crate::mirror`]）。
//!
//! **诚实**：**≠ EL-03**；**≠ Wave 2「存储完成」**。结构切开 ≠ 假关恢复 / ≠ 存储完成。
//! **≠** 重做 SD-27 测旁挂；**≠** 并回 refs / os_watch / persist / import。

use crate::mirror::file_mtime_ms;
use crate::{content_hash, StoreError, WorkspaceStore};
use conex_doc_collab::BlockTree;
use conex_md_ast::serialize_tree;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

impl WorkspaceStore {
    /// 将 `tree` 序列化为 Conex-MD 并原子写入 `mirror_root/{safe_doc_id}.md`。
    ///
    /// - 内容来自 [`serialize_tree`]（含 `<!--c:UUID-->` 块 ID 注释）
    /// - 原子写：tmp + rename（Windows 上若目标已存在先 remove）
    /// - 更新 `mirror_meta`：`last_export_rev = rev`、`pending_lag = 0`、
    ///   `content_hash`（SHA-256）+ `file_mtime_ms`（供 [`Self::detect_mirror_drift`]）
    ///
    /// **勿**将写出路径作为工具默认读源（见模块不变量）。
    pub fn export_md_mirror(
        &self,
        doc_id: &str,
        tree: &BlockTree,
        rev: u64,
        mirror_root: &Path,
    ) -> Result<PathBuf, StoreError> {
        std::fs::create_dir_all(mirror_root)?;

        let safe = safe_doc_id(doc_id);
        let final_path = mirror_root.join(format!("{safe}.md"));
        let md = serialize_tree(tree);
        let hash = content_hash(md.as_bytes());

        // 原子写：先写临时文件再 rename 到目标
        let tmp_name = format!(
            "{safe}.md.tmp.{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let tmp_path = mirror_root.join(tmp_name);
        std::fs::write(&tmp_path, md.as_bytes())?;
        // Windows：目标存在时 rename 会失败，先删再换
        if final_path.exists() {
            let _ = std::fs::remove_file(&final_path);
        }
        std::fs::rename(&tmp_path, &final_path)?;

        let mtime = file_mtime_ms(&final_path);
        let path_str = final_path.to_string_lossy().to_string();
        let rev_i = rev as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            r#"
            INSERT INTO mirror_meta(
                doc_id, path, last_export_rev, last_export_at, pending_lag,
                content_hash, file_mtime_ms
            )
            VALUES (?1, ?2, ?3, strftime('%s','now'), 0, ?4, ?5)
            ON CONFLICT(doc_id) DO UPDATE SET
                path = excluded.path,
                last_export_rev = excluded.last_export_rev,
                last_export_at = excluded.last_export_at,
                pending_lag = 0,
                content_hash = excluded.content_hash,
                file_mtime_ms = excluded.file_mtime_ms
            "#,
            params![doc_id, path_str, rev_i, hash, mtime],
        )?;

        Ok(final_path)
    }

    /// 权威 rev 前进时更新 mirror 延迟水位。
    ///
    /// `pending_lag = |new_rev - last_export_rev|`（以 i64 差的绝对值）。
    /// 若该 doc 尚无 `mirror_meta` 行（从未 export），则插入骨架行：
    /// `last_export_rev=0`、`path=''`、`pending_lag = new_rev`。
    pub fn note_authority_advanced(&self, doc_id: &str, new_rev: u64) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        note_authority_advanced_conn(&conn, doc_id, new_rev)
    }

    /// 可观测 mirror 延迟水位（`pending_lag`）。
    ///
    /// 无 `mirror_meta` 行时返回 `None`（尚未有 export / advance 记录）。
    pub fn mirror_lag(&self, doc_id: &str) -> Result<Option<i64>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let lag: Option<i64> = conn
            .query_row(
                "SELECT pending_lag FROM mirror_meta WHERE doc_id=?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(lag)
    }
}

/// 将 doc_id 转为可作为文件名的安全片段（路径分隔符等替换为 `_`）。
pub(crate) fn safe_doc_id(doc_id: &str) -> String {
    let s: String = doc_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "_empty".into()
    } else {
        s
    }
}

/// 事务内：权威 rev 前进 → 更新 `mirror_meta.pending_lag`（投影管线同事务调用）。
pub(crate) fn note_authority_advanced_conn(
    conn: &Connection,
    doc_id: &str,
    new_rev: u64,
) -> Result<(), StoreError> {
    let new_rev_i = new_rev as i64;
    let existing: Option<i64> = conn
        .query_row(
            "SELECT last_export_rev FROM mirror_meta WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(last) => {
            let lag = (new_rev_i - last).abs();
            conn.execute(
                "UPDATE mirror_meta SET pending_lag = ?1 WHERE doc_id = ?2",
                params![lag, doc_id],
            )?;
        }
        None => {
            conn.execute(
                r#"
                INSERT INTO mirror_meta(doc_id, path, last_export_rev, last_export_at, pending_lag)
                VALUES (?1, '', 0, 0, ?2)
                "#,
                params![doc_id, new_rev_i],
            )?;
        }
    }
    Ok(())
}
