//! schema DDL 域：v1 起点形态与 v5 目标形态的建表 SQL。
//! 仅提供纯 DDL 字符串；迁移编排在 `migrate` 模块。

/// v1 形态 schema（全新建库的迁移链起点，与 tests/migrations.rs 的
/// build_v1_fixture 结构一致；随后经 v2/v3/v4/v5 迁移到目标形态）。
pub(crate) fn create_v1_schema() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        timestamp TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);

    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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
        PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_session_messages_id ON session_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS session_agents (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        subagent_run_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        parent_tool_call_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stopped')),
        summary TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        depth INTEGER DEFAULT 0,
        subagent_path_json TEXT,
        PRIMARY KEY (session_id, agent_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_agent_messages (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
        text TEXT,
        thinking TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT,
        stream_text_offset INTEGER,
        thinking_time INTEGER,
        tool_calls_json TEXT,
        blocks_json TEXT,
        tool_call_results_json TEXT,
        PRIMARY KEY (session_id, agent_id, seq),
        FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        end_reason TEXT,
        cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS pending_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    "#
}

/// v5 目标 schema 全量 DDL（PE-08 T08.7 + P5 §3.1.4 T-39 + T-D-07 v6 新列 +
/// 战役 v9 列：events.run_id + session_agents.sub_session_id）。
///
/// 结构要点：
/// - events：组合主键 `(session_id, sequence)` + FK，无 AUTOINCREMENT id 列（P14）；
///   v9 新增 `run_id TEXT` 列（run 归属查询权威，可 NULL；新库 ensure 路径直接
///   建出含列结构，v9 col-check 对已含列新库自然跳过，幂等闭环）；
/// - runs / pending_inputs：FK 到 sessions（孤儿行迁移时过滤）；
/// - runs：v5 新增 run 级 usage/cache 列（P5 §3.1.4，`save_run_usage` 写入面；
///   hit_ratio/write_ratio 可派生不落库，warm_until_ms NULL 兼容）；
/// - session_messages：新增 `updated_at`（v4）+ `usage_json`（v5，消息级 usage 快照，C8）；
/// - session_sequence：会话级 sequence 原子分配表（T08.12）；
/// - metadata 旧表不创建（v4 删除）；
/// - session_agents：v6 新增 `task_type` / `display_label` / `allowed_write_paths_json`
///   （T-D-07 定义扩展落库；model_override 扩展点预留不落库）；
///   v9 新增 `sub_session_id TEXT NOT NULL DEFAULT ''`（D-02 LK-04 主控代收列定义，
///   读写面轮 3 实现）。
pub(crate) fn create_v5_schema() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL DEFAULT '常规会话',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        branch_parent_id TEXT,
        timestamp TEXT NOT NULL DEFAULT '',
        timestamp_source TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        pinned_message_ids TEXT,
        engine_cursor INTEGER,
        engine_last_run_id TEXT,
        hydrated_from_engine INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        run_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        end_reason TEXT,
        cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        missed_tokens INTEGER NOT NULL DEFAULT 0,
        warm_until_ms INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

    CREATE TABLE IF NOT EXISTS pending_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_inputs(session_id, created_at);

    CREATE TABLE IF NOT EXISTS session_sequence (
        session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL DEFAULT 1
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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
        updated_at INTEGER,
        usage_json TEXT,
        PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_session_messages_id ON session_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS session_agents (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        subagent_run_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        parent_tool_call_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stopped')),
        summary TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        depth INTEGER DEFAULT 0,
        subagent_path_json TEXT,
        task_type TEXT,
        display_label TEXT,
        allowed_write_paths_json TEXT,
        sub_session_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, agent_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_agent_messages (
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

    CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TRIGGER IF NOT EXISTS trg_session_messages_insert
    AFTER INSERT ON session_messages
    BEGIN
        UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_session_messages_delete
    AFTER DELETE ON session_messages
    BEGIN
        UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id;
    END;

    -- CAS 活数据与垃圾回收表（Batch 2 Unit 2.2：CAS GC、租约与多源联合引用）
    CREATE TABLE IF NOT EXISTS blob_cas (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        bytes BLOB,
        path TEXT NOT NULL DEFAULT '',
        storage_type TEXT NOT NULL DEFAULT 'inline',
        pinned INTEGER NOT NULL DEFAULT 0,
        marked_for_delete_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_blob_cas_marked ON blob_cas(marked_for_delete_at);
    CREATE INDEX IF NOT EXISTS idx_blob_cas_pinned ON blob_cas(pinned);

    CREATE TABLE IF NOT EXISTS block_attachments (
        doc_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doc_id, block_id, hash)
    );

    CREATE INDEX IF NOT EXISTS idx_block_attachments_hash ON block_attachments(hash);

    CREATE TABLE IF NOT EXISTS doc_snapshots_attachments (
        doc_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL DEFAULT '',
        blob_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doc_id, snapshot_id, blob_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_doc_snapshots_attachments_hash ON doc_snapshots_attachments(blob_hash);

    CREATE TABLE IF NOT EXISTS session_undo_blobs (
        session_id TEXT NOT NULL,
        undo_step_id TEXT NOT NULL,
        blob_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, undo_step_id, blob_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_session_undo_blobs_hash ON session_undo_blobs(blob_hash);

    CREATE TABLE IF NOT EXISTS active_blob_leases (
        lease_id TEXT PRIMARY KEY,
        blob_hash TEXT NOT NULL,
        holder TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_active_blob_leases_hash ON active_blob_leases(blob_hash);
    CREATE INDEX IF NOT EXISTS idx_active_blob_leases_expires ON active_blob_leases(expires_at);
    "#
}

/// CAS GC 与租约隔离 DDL（供独立连接或初始化使用）。
pub(crate) fn create_cas_schema() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS blob_cas (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        bytes BLOB,
        path TEXT NOT NULL DEFAULT '',
        storage_type TEXT NOT NULL DEFAULT 'inline',
        pinned INTEGER NOT NULL DEFAULT 0,
        marked_for_delete_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_blob_cas_marked ON blob_cas(marked_for_delete_at);
    CREATE INDEX IF NOT EXISTS idx_blob_cas_pinned ON blob_cas(pinned);

    CREATE TABLE IF NOT EXISTS block_attachments (
        doc_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doc_id, block_id, hash)
    );

    CREATE INDEX IF NOT EXISTS idx_block_attachments_hash ON block_attachments(hash);

    CREATE TABLE IF NOT EXISTS doc_snapshots_attachments (
        doc_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL DEFAULT '',
        blob_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doc_id, snapshot_id, blob_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_doc_snapshots_attachments_hash ON doc_snapshots_attachments(blob_hash);

    CREATE TABLE IF NOT EXISTS session_undo_blobs (
        session_id TEXT NOT NULL,
        undo_step_id TEXT NOT NULL,
        blob_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, undo_step_id, blob_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_session_undo_blobs_hash ON session_undo_blobs(blob_hash);

    CREATE TABLE IF NOT EXISTS active_blob_leases (
        lease_id TEXT PRIMARY KEY,
        blob_hash TEXT NOT NULL,
        holder TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_active_blob_leases_hash ON active_blob_leases(blob_hash);
    CREATE INDEX IF NOT EXISTS idx_active_blob_leases_expires ON active_blob_leases(expires_at);
    "#
}

