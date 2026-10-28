//! 笔记文档元数据模型与 WorkspaceStore 多文档管理实现。
//!
//! 铁律（遵循 AGENTS.md 与 AUDIT-SIMPLICITY-FINAL）：
//! 1. 严格杜绝 tags_json、is_archived、is_pinned 等过度设计；
//! 2. 统一使用 13 位毫秒 Unix 时间戳（< 10_000_000_000 自动 * 1000 归一化）；
//! 3. 彻底事务级联物理硬删除 9 张关联表（含 blocks_fts）；
//! 4. 新建文档初始 rev 规范为 0（DEF-NOTE-CAS-01），对齐内存水合 DocSession 初始态 rev = 0，
//!    根除首笔编辑 expect_rev = 0 触发的 CAS 乐观锁版本冲突。

use crate::{StoreError, WorkspaceStore};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// 数据库底层查询行映射
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMetaRow {
    pub doc_id: String,
    pub rev: i64,
    pub updated_at: i64,
    pub title: String,
    pub created_at: i64,
    pub block_count: usize,
}

/// 笔记文档元数据记录（IPC 传输统一为 camelCase）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocumentMeta {
    /// 文档唯一标识符（例如 `doc_m1k2a9z0` 或历史存量 `strict-default`）
    pub id: String,
    /// 笔记标题
    pub title: String,
    /// 创建时间戳（13 位标准毫秒级 Unix 时间戳）
    pub created_at: i64,
    /// 最后更新时间戳（13 位标准毫秒级 Unix 时间戳）
    pub updated_at: i64,
    /// 实时聚合计算的块总数
    pub block_count: usize,
    /// CRDT 修订版本号
    pub rev: i64,
}

impl DocMetaRow {
    pub fn into_meta(self) -> NoteDocumentMeta {
        let now_ms = current_time_ms();
        let created_at = normalize_timestamp_ms(self.created_at, now_ms);
        let updated_at = normalize_timestamp_ms(self.updated_at, now_ms);

        NoteDocumentMeta {
            id: self.doc_id,
            title: self.title,
            created_at,
            updated_at,
            block_count: self.block_count,
            rev: self.rev,
        }
    }
}

/// 获取当前 13 位毫秒级时间戳
pub fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 时间戳规范化为 13 位毫秒 Unix 时间戳。
/// 若存量时间戳 < 10_000_000_000 且 > 0，则自动 * 1000 归一化；若 <= 0 则回退至 fallback_ms。
pub fn normalize_timestamp_ms(ts: i64, fallback_ms: i64) -> i64 {
    if ts > 0 && ts < 10_000_000_000 {
        ts * 1000
    } else if ts <= 0 {
        fallback_ms
    } else {
        ts
    }
}

impl WorkspaceStore {
    /// 1. 获取文档列表（带实时块计数，按更新时间倒序排序，100% 命中 idx_doc_meta_updated 索引）
    pub fn list_note_documents(&self) -> Result<Vec<DocMetaRow>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;

        let mut stmt = conn.prepare_cached(
            r#"
            SELECT 
                m.doc_id,
                m.rev,
                m.updated_at,
                m.title,
                m.created_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.doc_id = m.doc_id) AS block_count
            FROM doc_meta m
            -- 同毫秒创建/更新时以插入序（rowid）倒序兜底：跨平台/跨 SQLite
            -- 版本排序稳定，避免 list_documents 顺序漂移
            ORDER BY m.updated_at DESC, m.rowid DESC;
            "#,
        )?;

        let rows = stmt
            .query_map([], |r| {
                let doc_id: String = r.get(0)?;
                let rev: i64 = r.get(1)?;
                let raw_updated_at: i64 = r.get(2)?;
                let title: String = r.get(3)?;
                let raw_created_at: i64 = r.get(4)?;
                let block_count = r.get::<_, i64>(5)? as usize;

                let now_ms = current_time_ms();
                let updated_at = normalize_timestamp_ms(raw_updated_at, now_ms);
                let created_at = normalize_timestamp_ms(raw_created_at, updated_at);

                Ok(DocMetaRow {
                    doc_id,
                    rev,
                    updated_at,
                    title,
                    created_at,
                    block_count,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// 2. 原子化创建新文档（毫秒级时间戳，零过度设计）
    pub fn create_note_document(
        &self,
        doc_id: &str,
        title: &str,
        now_ms: i64,
    ) -> Result<DocMetaRow, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;

        let effective_now = normalize_timestamp_ms(now_ms, current_time_ms());
        let trimmed_title = title.trim();
        let final_title = if trimmed_title.is_empty() {
            "未命名笔记"
        } else {
            trimmed_title
        };

        conn.execute(
            r#"
            INSERT INTO doc_meta (doc_id, rev, updated_at, title, created_at)
            VALUES (?1, 0, ?2, ?3, ?2);
            "#,
            params![doc_id, effective_now, final_title],
        )?;

        Ok(DocMetaRow {
            doc_id: doc_id.to_string(),
            rev: 0,
            updated_at: effective_now,
            title: final_title.to_string(),
            created_at: effective_now,
            block_count: 0,
        })
    }

    /// 3. 重命名文档标题（更新 13 位毫秒级时间戳）
    pub fn rename_note_document(
        &self,
        doc_id: &str,
        new_title: &str,
        now_ms: i64,
    ) -> Result<DocMetaRow, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let effective_now = normalize_timestamp_ms(now_ms, current_time_ms());
        let trimmed_title = new_title.trim();
        let final_title = if trimmed_title.is_empty() {
            "未命名笔记"
        } else {
            trimmed_title
        };

        let affected = conn.execute(
            r#"
            UPDATE doc_meta
            SET title = ?1, updated_at = ?2
            WHERE doc_id = ?3;
            "#,
            params![final_title, effective_now, doc_id],
        )?;

        if affected == 0 {
            return Err(StoreError::Persist(format!("文档不存在: {doc_id}")));
        }

        let row: (i64, i64, i64) = conn.query_row(
            r#"
            SELECT 
                m.rev,
                m.created_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.doc_id = m.doc_id) AS block_count
            FROM doc_meta m
            WHERE m.doc_id = ?1;
            "#,
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;

        let created_at = normalize_timestamp_ms(row.1, effective_now);

        Ok(DocMetaRow {
            doc_id: doc_id.to_string(),
            rev: row.0,
            updated_at: effective_now,
            title: final_title.to_string(),
            created_at,
            block_count: row.2 as usize,
        })
    }

    /// 4. 彻底删除文档（事务级联硬删除 9 张关联表，包含 blocks_fts）
    pub fn delete_note_document(&self, doc_id: &str) -> Result<u64, StoreError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;

        // 开启独占事务，彻底物理清理全表级联关联数据（含 blocks_fts，确保 structure_gate 门禁不红）
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM blocks_fts WHERE doc_id = ?1;", params![doc_id])?;
        tx.execute(
            "DELETE FROM block_attachments WHERE doc_id = ?1;",
            params![doc_id],
        )?;
        tx.execute("DELETE FROM block_refs WHERE doc_id = ?1;", params![doc_id])?;
        tx.execute("DELETE FROM blocks WHERE doc_id = ?1;", params![doc_id])?;
        tx.execute(
            "DELETE FROM mirror_meta WHERE doc_id = ?1;",
            params![doc_id],
        )?;
        tx.execute("DELETE FROM doc_clocks WHERE doc_id = ?1;", params![doc_id])?;
        tx.execute(
            "DELETE FROM doc_updates WHERE doc_id = ?1;",
            params![doc_id],
        )?;
        tx.execute(
            "DELETE FROM doc_snapshots WHERE doc_id = ?1;",
            params![doc_id],
        )?;
        let affected = tx.execute("DELETE FROM doc_meta WHERE doc_id = ?1;", params![doc_id])?;
        tx.commit()?;

        Ok(affected as u64)
    }

    /// 对齐 doc 06 §3.2: 兼容 list_documents
    pub fn list_documents(&self) -> Result<Vec<NoteDocumentMeta>, StoreError> {
        let rows = self.list_note_documents()?;
        Ok(rows.into_iter().map(|r| r.into_meta()).collect())
    }

    /// 对齐 doc 06 §3.2: 兼容 create_document
    pub fn create_document(&self, title: Option<&str>) -> Result<NoteDocumentMeta, StoreError> {
        let now_ms = current_time_ms();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();

        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(now_ms.to_le_bytes());
        hasher.update(nanos.to_le_bytes());
        let hash_hex = hex::encode(hasher.finalize());
        let random_part = &hash_hex[..8];
        let doc_id = format!("doc_{:x}_{}", now_ms, random_part);

        let initial_title = match title {
            Some(t) if !t.trim().is_empty() => t.trim(),
            _ => "未命名笔记",
        };

        let row = self.create_note_document(&doc_id, initial_title, now_ms)?;

        // audit-repair-202609 T10：砍除 initial_markdown 直插单块分支——
        // 该分支绕过 CRDT 记账（doc_clocks / DocSession）属伪实现；带内容建
        // 文档的唯一路径 = create 空文档 + `note_document_apply_md` 事务。

        let meta = row.into_meta();
        Ok(meta)
    }

    /// 对齐 doc 06 §3.2: 兼容 rename_document
    pub fn rename_document(&self, doc_id: &str, title: &str) -> Result<i64, StoreError> {
        let now_ms = current_time_ms();
        let row = self.rename_note_document(doc_id, title, now_ms)?;
        Ok(row.updated_at)
    }

    /// 对齐 doc 06 §3.2: 兼容 delete_document
    pub fn delete_document(&self, doc_id: &str) -> Result<bool, StoreError> {
        self.delete_note_document(doc_id).map(|count| count > 0)
    }
}
