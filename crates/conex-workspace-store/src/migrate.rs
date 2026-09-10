//! Schema 迁移（幂等：CREATE IF NOT EXISTS + 版本抬升 + 列补齐）。
//!
//! # 模块内聚（**SD-31** · 测旁挂）
//! - **本文件**：`migrate` / `ensure_blocks_fts` / `ensure_column`（schema 语义不变）
//! - [`tests`]（`migrate_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::migrate::*` / `lib` `pub use`）
//!
//! SD-02：自 `lib.rs` 门面拆出。
//! **诚实**：**SD-31** · **≠ EL-03** · **≠ Wave 2 存储完成**；本包仅为测旁挂，**不**静默改 schema。

use crate::{StoreError, SCHEMA_VERSION};
use rusqlite::{params, Connection, OptionalExtension};

/// 最小可用 schema 迁移（幂等；CREATE IF NOT EXISTS + 版本抬升）。
///
/// 已建：doc_meta / doc_snapshots / doc_updates / doc_clocks / **blocks** / **blocks_fts** /
/// **mirror_meta** / **block_refs** / **blob_cas** / **block_attachments**。
/// 后续扩展点（W2-D Strict，非本 -S）：CAS GC、外置 `blobs/` 大文件 path 策略。
pub fn migrate(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        -- 版本登记（可空实现：仅一行 version）
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS doc_meta (
            doc_id TEXT PRIMARY KEY,
            -- rev 默认 0（DEF-NOTE-CAS-01）。新建未提交文档 rev=0；首笔 commit_ops CAS expect_rev=0 推进至 1。
            rev INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
            title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );

        CREATE TABLE IF NOT EXISTS doc_snapshots (
            doc_id TEXT PRIMARY KEY,
            blob BLOB,
            updated_at INTEGER NOT NULL
        );

        -- seq 单调、UNIQUE(doc_id,seq) 保证有序加载 pending
        CREATE TABLE IF NOT EXISTS doc_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            blob BLOB NOT NULL,
            kind TEXT NOT NULL DEFAULT 'combined',
            tx_id TEXT,
            UNIQUE(doc_id, seq)
        );

        -- CRDT peer clock（可空实现：表在、行可无）
        CREATE TABLE IF NOT EXISTS doc_clocks (
            doc_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            clock INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (doc_id, peer_id)
        );

        -- W2-C：块投影（派生，可丢；权威仍为 snapshot+updates）
        -- 复合主键：同 workspace 内 block_id 可跨 doc 碰撞
        CREATE TABLE IF NOT EXISTS blocks (
            doc_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            parent_id TEXT,
            kind TEXT NOT NULL DEFAULT '',
            order_key TEXT NOT NULL DEFAULT '',
            plain_text TEXT NOT NULL DEFAULT '',
            props_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            PRIMARY KEY (doc_id, block_id)
        );

        -- W2-E：MD mirror 元数据（人/git 契约视图水位；**非**权威）
        -- path：最近一次导出的绝对/相对路径；pending_lag：权威 rev − last_export_rev
        -- content_hash / file_mtime_ms：P6 detect 指纹（v7；旧库 ensure_column 补齐）
        CREATE TABLE IF NOT EXISTS mirror_meta (
            doc_id TEXT PRIMARY KEY,
            path TEXT NOT NULL DEFAULT '',
            last_export_rev INTEGER NOT NULL DEFAULT 0,
            last_export_at INTEGER NOT NULL DEFAULT 0,
            pending_lag INTEGER NOT NULL DEFAULT 0,
            content_hash TEXT NOT NULL DEFAULT '',
            file_mtime_ms INTEGER NOT NULL DEFAULT 0
        );

        -- W2-F+：块引用物化（派生；可丢可重建）
        -- kind 参与 PK：同 from→to 可有多种引用类型
        CREATE TABLE IF NOT EXISTS block_refs (
            doc_id TEXT NOT NULL,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (doc_id, from_id, to_id, kind)
        );

        -- W2-D-S：CAS 附件骨架（内容寻址；**非**文档权威；≠ 生产 / ≠ GC 满关）
        -- hash = SHA-256 hex；bytes 可空时 path 指向外置文件（-S 默认内联 bytes）
        CREATE TABLE IF NOT EXISTS blob_cas (
            hash TEXT PRIMARY KEY,
            size INTEGER NOT NULL DEFAULT 0,
            bytes BLOB,
            path TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        -- 块 → blob 引用（多对多；删块时清链接，blob 行留给 W2-D GC）
        CREATE TABLE IF NOT EXISTS block_attachments (
            doc_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            PRIMARY KEY (doc_id, block_id, hash)
        );
        "#,
    )?;

    // 兼容 W1 早期表（无 kind 列）：幂等加列
    ensure_column(
        conn,
        "doc_updates",
        "kind",
        "TEXT NOT NULL DEFAULT 'combined'",
    )?;
    // 兼容早期 doc_meta 无 updated_at
    ensure_column(conn, "doc_meta", "updated_at", "INTEGER NOT NULL DEFAULT 0")?;
    // Migration v8 字段幂等补齐（极简 5 列真源）
    ensure_column(conn, "doc_meta", "title", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "doc_meta", "created_at", "INTEGER NOT NULL DEFAULT 0")?;
    // W2-E P6：detect 用 content_hash / file_mtime_ms（旧库幂等加列）
    ensure_column(
        conn,
        "mirror_meta",
        "content_hash",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        conn,
        "mirror_meta",
        "file_mtime_ms",
        "INTEGER NOT NULL DEFAULT 0",
    )?;

    // 有序加载 / 投影 / refs 辅助索引
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_doc_updates_doc_seq
            ON doc_updates(doc_id, seq);
        CREATE INDEX IF NOT EXISTS idx_doc_clocks_doc
            ON doc_clocks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_doc
            ON blocks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_doc_parent
            ON blocks(doc_id, parent_id);
        CREATE INDEX IF NOT EXISTS idx_block_refs_to
            ON block_refs(doc_id, to_id);
        CREATE INDEX IF NOT EXISTS idx_block_refs_from
            ON block_refs(doc_id, from_id);
        CREATE INDEX IF NOT EXISTS idx_block_attachments_hash
            ON block_attachments(hash);
        CREATE INDEX IF NOT EXISTS idx_block_attachments_block
            ON block_attachments(doc_id, block_id);

        -- Migration v8: 单列更新倒序高效查询索引（极简覆盖）
        CREATE INDEX IF NOT EXISTS idx_doc_meta_updated
            ON doc_meta(updated_at DESC);
        "#,
    )?;

    // FTS5 全文虚表（bundled SQLite 已 SQLITE_ENABLE_FTS5）。
    // tokenize=unicode61：英文/数字 token 可用；连续 CJK 整段成一词，子串 MATCH 为 known gap
    // （A-FTS-ZH-01：search_fulltext / query_blocks 对含 CJK 查询走 plain_text instr 回退）。
    // 与 blocks 手动同步（非 content= 外部表）：reindex/remove 维护；损坏走 rebuild_fts。
    ensure_blocks_fts(conn)?;

    // 登记 / 抬升 schema_version 并施加 BUG-A04 版本门闩
    let current: Option<i64> = conn
        .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()?;
    match current {
        None => {
            conn.execute(
                "INSERT INTO schema_version(version) VALUES (?1)",
                params![SCHEMA_VERSION],
            )?;
        }
        Some(v) if v < SCHEMA_VERSION => {
            if v < 8 {
                backfill_legacy_doc_meta_v8(conn)?;
            }
            conn.execute(
                "UPDATE schema_version SET version = ?1",
                params![SCHEMA_VERSION],
            )?;
        }
        Some(_) => {}
    }

    Ok(())
}

/// Migration v8 历史文档元数据安全回填门闩函数 (BUG-A04)
///
/// 纪律保证：
/// 1. 仅在 current_version < 8 时由 migrate 执行，杜绝每次启动无条件扫描；
/// 2. 仅扫描 title 为空或纯空白字符的存量历史行，绝对不覆盖用户自定义标题；
/// 3. 从 blocks 中抽取首行 heading 或首段文本前 30 个字（字符感知，不截断多字节 UTF-8）；
/// 4. 将 created_at 为 0 的老数据平滑初始化为 updated_at（并归一化为 13 位毫秒）。
pub(crate) fn backfill_legacy_doc_meta_v8(conn: &Connection) -> Result<(), StoreError> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // 1. 对所有 created_at = 0 的历史记录，对齐 created_at = updated_at
    conn.execute(
        "UPDATE doc_meta SET created_at = updated_at WHERE created_at = 0",
        [],
    )?;

    // 2. 对存量 10 位标准秒级时间戳（< 10_000_000_000）安全乘以 1000 统一转换为 13 位毫秒级
    conn.execute(
        "UPDATE doc_meta SET updated_at = updated_at * 1000 WHERE updated_at > 0 AND updated_at < 10000000000",
        [],
    )?;
    conn.execute(
        "UPDATE doc_meta SET created_at = created_at * 1000 WHERE created_at > 0 AND created_at < 10000000000",
        [],
    )?;

    // 若依然有 <= 0 的时间戳，补齐为当前毫秒
    conn.execute(
        "UPDATE doc_meta SET updated_at = ?1 WHERE updated_at <= 0",
        params![now_ms],
    )?;
    conn.execute(
        "UPDATE doc_meta SET created_at = updated_at WHERE created_at <= 0",
        [],
    )?;

    // 3. 仅抓取 title 为空串的存量文档 ID
    let mut stmt = conn.prepare("SELECT doc_id FROM doc_meta WHERE length(trim(title)) = 0")?;
    let doc_ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for id in doc_ids {
        // 从 blocks 寻找首个非空文本块
        let candidate: Option<String> = conn
            .query_row(
                r#"
                SELECT plain_text FROM blocks
                WHERE doc_id = ?1 AND length(trim(plain_text)) > 0
                ORDER BY order_key ASC, updated_at ASC
                LIMIT 1
                "#,
                params![id],
                |r| r.get(0),
            )
            .optional()?;

        let resolved_title = match candidate {
            Some(text) => {
                // blocks.plain_text 可能残留字面量 `\n` 转义序列（SQL 种子 /
                // 镜像导入历史），先归一化为真实换行再取首个非空行。
                let normalized = text.replace("\\n", "\n");
                let first_line = normalized
                    .lines()
                    .map(|l| l.trim())
                    .find(|l| !l.is_empty())
                    .unwrap_or("")
                    .trim_start_matches('#')
                    .trim();
                let clean = first_line;
                if clean.is_empty() {
                    "未命名笔记".to_string()
                } else {
                    // 字符簇安全截断（取前 30 字符，不截断多字节 UTF-8）
                    clean.chars().take(30).collect::<String>()
                }
            }
            None => "未命名笔记".to_string(),
        };

        conn.execute(
            "UPDATE doc_meta SET title = ?1 WHERE doc_id = ?2",
            params![resolved_title, id],
        )?;
    }

    Ok(())
}

/// 幂等创建 `blocks_fts`（FTS5 虚表；已存在则跳过）。
pub(crate) fn ensure_blocks_fts(conn: &Connection) -> Result<(), StoreError> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blocks_fts' LIMIT 1",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        return Ok(());
    }
    // plain_text 可检索；block_id / doc_id 仅存值（UNINDEXED）便于过滤与回表
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE blocks_fts USING fts5(
            plain_text,
            block_id UNINDEXED,
            doc_id UNINDEXED,
            tokenize = 'unicode61'
        );
        "#,
    )?;
    Ok(())
}

/// 若表上不存在某列则 ADD COLUMN（SQLite 无 IF NOT EXISTS 语法时的兼容路径）。
pub(crate) fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), StoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !names.iter().any(|n| n == column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

// ── 测试（SD-31 外置） ─────────────────────────────────────────────────────

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
