//! 迁移步骤域：v1→v11 逐版本具体 DDL/DML 结构变更与数据升级函数。

/// 查询表的列名清单（`PRAGMA table_info`；v5 col-check 幂等复用）。
pub(crate) fn table_columns(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let mapped = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(mapped.filter_map(|c| c.ok()).collect::<Vec<String>>())
}

/// v1 → v2：sessions 补 folder 等列（ADD COLUMN，避免 RENAME+DROP 父表
/// 触发 ON DELETE CASCADE 清空 session_messages / session_agents 数据）。
pub(crate) fn migrate_v1_to_v2(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let cols: Vec<String> = tx
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    let add =
        |tx: &rusqlite::Transaction<'_>, col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
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
pub(crate) fn migrate_v2_to_v3(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
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
pub(crate) fn migrate_v3_to_v4(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    // 历史早期形态库可能缺 runs / pending_inputs 表（2026-08-08 现场：
    // apps/agent-workbench/sessions.db user_version=3 无这两张表——早期
    // v1 形态不含它们，后续版本才引入；v1→v3 迁移链不创建，v3→v4 却
    // 无条件查询 → `no such table: runs` 迁移崩溃、DB 打不开降级内存库）。
    // 缺失时按 v3 老 DDL 创建（无 FK 形态），再走下方重建逻辑幂等推进；
    // 已有表时跳过（对齐 session_sequence 的 col-check 幂等模式）。
    let table_exists =
        |tx: &rusqlite::Transaction<'_>, name: &str| -> Result<bool, rusqlite::Error> {
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

/// v4 → v5：runs 补 run 级 usage/cache 列 + session_messages 补 usage_json（P5 §3.1.4 / C8）。
///
/// 纯 ADD COLUMN（无 DROP、无重建），col-check 幂等（对齐 v1→v2 模式，migrate.rs:161-183）：
/// - runs：prompt/completion/total/cache_read/cache_write/cache_miss/sample_count/missed_tokens
///   （NOT NULL DEFAULT 0，旧行自动补 0）+ warm_until_ms（NULL 兼容）；
/// - session_messages：usage_json TEXT（消息级 usage 快照，前端 saveSessionBody 写入面）。
///   hit_ratio / write_ratio 不落库（可派生，口径一致）。
pub(crate) fn migrate_v4_to_v5(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let runs_cols = table_columns(tx, "runs")?;
    let add_run_col = |col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !runs_cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE runs ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add_run_col("prompt_tokens", "prompt_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col(
        "completion_tokens",
        "completion_tokens INTEGER NOT NULL DEFAULT 0",
    )?;
    add_run_col("total_tokens", "total_tokens INTEGER NOT NULL DEFAULT 0")?;
    add_run_col(
        "cache_read_tokens",
        "cache_read_tokens INTEGER NOT NULL DEFAULT 0",
    )?;
    add_run_col(
        "cache_write_tokens",
        "cache_write_tokens INTEGER NOT NULL DEFAULT 0",
    )?;
    add_run_col(
        "cache_miss_tokens",
        "cache_miss_tokens INTEGER NOT NULL DEFAULT 0",
    )?;
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
pub(crate) fn migrate_v5_to_v6(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
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
    add_agent_col("allowed_write_paths_json", "allowed_write_paths_json TEXT")?;
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
pub(crate) fn migrate_v6_to_v7(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
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

/// v7 → v8：新增 imported_bookmarks / imported_history 两张浏览器导入目标表
/// （浏览器协同 G-4 收尾，03-方案-书签历史入conex-db目标表 §2.1/§2.2）。
///
/// 零既有列改动（只建新表 + 索引），不触发全表重写；`CREATE TABLE IF NOT EXISTS`
/// / `CREATE INDEX IF NOT EXISTS` 天然幂等（崩溃中间态重跑自愈，对齐「每版本
/// 独立事务」约定）。create_v5_schema 不包含新表——缺表兜底走读写面
/// sqlite_master 探测降级（imported.rs，对齐 compression_blocks 先例）。
///
/// 列语义（03-方案 §2）：
/// - imported_bookmarks 主键 (url, name)——与解析层去重键（bookmarks.rs）
///   逐字节对齐，INSERT OR IGNORE 天然幂等；folder_path_json 为 JSON 数组
///   字符串（对齐 *_json 惯例）；guid 首版恒 NULL 预留；source 信息列不入
///   主键（跨来源同键合并）；
/// - imported_history 主键 (url, visited_at)——(url, visit_time) 去重口径
///   （维度 16 §6.2）：同 URL 不同秒的访问各保留一条；title NULL 兼容。
pub(crate) fn migrate_v7_to_v8(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS imported_bookmarks (
            url              TEXT NOT NULL,
            name             TEXT NOT NULL,
            folder_path_json TEXT NOT NULL,
            guid             TEXT,
            source           TEXT NOT NULL DEFAULT 'default',
            imported_at      INTEGER NOT NULL,
            PRIMARY KEY (url, name)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_imported_bookmarks_imported_at
            ON imported_bookmarks (imported_at DESC);
        CREATE TABLE IF NOT EXISTS imported_history (
            url         TEXT NOT NULL,
            visited_at  INTEGER NOT NULL,
            title       TEXT,
            source      TEXT NOT NULL DEFAULT 'default',
            imported_at INTEGER NOT NULL,
            PRIMARY KEY (url, visited_at)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_imported_history_visited_at
            ON imported_history (visited_at DESC);
        CREATE INDEX IF NOT EXISTS idx_imported_history_url
            ON imported_history (url);",
    )
}

/// v8 → v9：事件 run 归属第一类数据 + session_agents 子会话列（agent 循环
/// 全链路可追溯性战役 D-01 DM-01；runs.model 列本战役不建，主控裁决 F-02）。
///
/// 纯 ADD COLUMN + 索引（无 DROP、无重建），col-check 幂等（对齐 v5→v6 模式，
/// migrate.rs:500-523，含表缺失守卫）：
/// - `events.run_id TEXT`：run 归属列（查询权威；可 NULL = 会话域/未知归属，
///   **存量行不回填**——诚实未知，DM-02 写面起新行显式写列）；
/// - `idx_events_run ON events(session_id, run_id, sequence)`：按 run 过滤
///   O(log n) 直达 + limit 下推（DM-07 读面消费）；
/// - `session_agents.sub_session_id TEXT NOT NULL DEFAULT ''`：子会话归属列
///   （D-02 LK-04 主控代收列定义，旧行自动补空串；读写面轮 3 实现）。
pub(crate) fn migrate_v8_to_v9(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let has_events: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='events'",
        [],
        |r| r.get(0),
    )?;
    if has_events > 0 {
        let event_cols = table_columns(tx, "events")?;
        if !event_cols.iter().any(|c| c == "run_id") {
            tx.execute_batch("ALTER TABLE events ADD COLUMN run_id TEXT;")?;
        }
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_events_run
                ON events(session_id, run_id, sequence);",
        )?;
    }
    let has_agents: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_agents'",
        [],
        |r| r.get(0),
    )?;
    if has_agents > 0 {
        let agent_cols = table_columns(tx, "session_agents")?;
        if !agent_cols.iter().any(|c| c == "sub_session_id") {
            tx.execute_batch(
                "ALTER TABLE session_agents ADD COLUMN sub_session_id TEXT NOT NULL DEFAULT '';",
            )?;
        }
    }
    Ok(())
}

/// v9 → v10：新增 usage_records 时序流水表及 4 组复合时序索引（用量监控控制台全链路移植）。
/// 纯建表 + 索引（无 DROP、无既有列语义改动）。
pub(crate) fn migrate_v9_to_v10(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_records (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id           TEXT NOT NULL,
            run_id               TEXT,
            project_name         TEXT NOT NULL DEFAULT '',
            model                TEXT NOT NULL,
            provider             TEXT NOT NULL DEFAULT '',
            prompt_tokens        INTEGER NOT NULL DEFAULT 0,
            completion_tokens    INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
            cost_cny             REAL NOT NULL DEFAULT 0.0,
            cost_usd             REAL NOT NULL DEFAULT 0.0,
            timestamp            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_records_ts
            ON usage_records(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_records_model_ts
            ON usage_records(model, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_records_project_ts
            ON usage_records(project_name, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_records_session
            ON usage_records(session_id, timestamp);",
    )
}

/// v10 → v11：新增 app_preferences 偏好存储表（设计Token与偏好SSOT端到端重构 B1）。
/// 纯建表（无 DROP、无既有列语义改动），`CREATE TABLE IF NOT EXISTS` 天然幂等。
/// 与现存 `create_v1_schema` 中历史废弃的 `metadata` 明确隔离（不同名、不同列定义、不互跨读写）。
pub(crate) fn step_10_to_11(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    )
}

#[cfg(test)]
pub(crate) use step_10_to_11 as migrate_v10_to_v11;

/// v11 → v12：SQLite 写单轨配套迁移（D3-4 / D3-5 / SEC-12）。
///
/// - DROP `trg_session_messages_insert` / `trg_session_messages_delete`
///   （message_count 改由 `save_session_body` 批末单次重算，禁止双轨）；
/// - `sessions` 补 `body_version INTEGER NOT NULL DEFAULT 0`（CAS 锚点）；
/// - 新建 `idx_events_session_type` / `idx_sessions_updated`（D3-5 / SEC-12 复合排序对齐）。
///
/// 纯 DDL + ADD COLUMN（无表重建；对齐 v5–v11 无 DROP TABLE 策略）。
pub(crate) fn step_11_to_12(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    // DROP 双触发器（幂等；旧库可能有，新库无）
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS trg_session_messages_insert;
         DROP TRIGGER IF EXISTS trg_session_messages_delete;",
    )?;

    // sessions.body_version（col-check 幂等）
    let cols = table_columns(tx, "sessions")?;
    if !cols.iter().any(|c| c == "body_version") {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN body_version INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    // D3-5 索引（IF NOT EXISTS 幂等；events 缺表时跳过——对齐 v9 col-check 幂等模式，
    // 旧 fixture / 残缺库不因缺表迁移崩溃）
    let has_events: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='events'",
        [],
        |r| r.get(0),
    )?;
    if has_events > 0 {
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type, sequence);",
        )?;
    }
    tx.execute_batch(
        "DROP INDEX IF EXISTS idx_sessions_updated;
         CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC, id ASC);",
    )?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn migrate_v11_to_v12(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    step_11_to_12(tx)
}

/// v12 → v13：存量孤儿 session_meta 键一次性 GC（RUN-15）。
///
/// 背景：`session_meta` 为独立 KV 表（无外键级联），历史上删除会话后
/// `{session_id}:*` 会话作用域键残留（output_dir / output_root /
/// explore_docs_consumed / revert_streak_count / revert_last_at /
/// compact_stage_triggered / compact_stage_summaries 等已知后缀）。
/// v13 起删除路径（delete_session / cleanup_orphan_sessions）已在删除
/// 事务内按前缀清理键；本迁移负责**清掉升级前已残留的孤儿键**。
///
/// 删除条件（双条件锚定，防止误删全局键）：
/// 1. 键的会话段（首个 `:` 之前）**不在** `sessions` 表（孤儿判定）；
/// 2. 键以**已知会话作用域后缀**之一结尾——全局键可能含冒号（如
///    `sched:{workflow_id}` / `workflow:{workflow_id}` 定时/工作流定义、
///    `goal_state` / `recover_notifications` 等），仅凭条件 1 会把
///    「会话段碰巧不命中会话表」的全局键误删，故用后缀白名单收窄。
///
/// 幂等可重入：DELETE 语义天然幂等——重跑时孤儿键已清空即空操作；
/// 崩溃中间态重跑（结构无 DDL，仅 DML）由「每版本独立事务」保证原子。
pub(crate) fn step_12_to_13(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    // 已知会话作用域后缀（与生产写入方逐一对应）：
    // - output_dir / output_root：outputs_config.rs（G01 产出目录落键 / G03 会话级覆盖）
    // - explore_docs_consumed：agent-tools explore_quota.rs
    // - revert_streak_count / revert_last_at：agent-tools revert_guard.rs
    // - compact_stage_triggered / compact_stage_summaries：run_idle.rs F5
    const SESSION_SCOPED_SUFFIXES: [&str; 7] = [
        ":output_dir",
        ":output_root",
        ":explore_docs_consumed",
        ":revert_streak_count",
        ":revert_last_at",
        ":compact_stage_triggered",
        ":compact_stage_summaries",
    ];
    let suffix_pred = SESSION_SCOPED_SUFFIXES
        .iter()
        .map(|s| format!("key LIKE '%{s}'"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let deleted = tx.execute(
        &format!(
            "DELETE FROM session_meta
             WHERE instr(key, ':') > 1
               AND substr(key, 1, instr(key, ':') - 1) NOT IN (SELECT id FROM sessions)
               AND ({suffix_pred})"
        ),
        [],
    )?;
    if deleted > 0 {
        tracing::info!(
            target: "db",
            keys = deleted,
            "迁移 v13：孤儿 session_meta 键已清理（会话不存在 + 已知作用域后缀）"
        );
    }
    Ok(())
}

/// v13 → v14：session_agents 生命周期/可恢复扩展（子代理协作 P3）。
///
/// 纯 ADD COLUMN + 索引（无 DROP、无表重建），col-check 幂等：
/// - `capability_mode` TEXT：spawn 时声明的能力档快照（展示/恢复建议；
///   运行期生效值仍由 CapabilityCell 按父链钳制）；
/// - `model_override` TEXT：绑定的模型覆盖（跨重启保留）；
/// - `resumable` INTEGER NOT NULL DEFAULT 0：启动对账中断置 1，
///   正常终态置 0，主 agent/前端据此决定是否恢复；
/// - `last_heartbeat_ms` INTEGER：运行期心跳（epoch ms），
///   用于识别失联子代理。
///
/// 索引 `idx_session_agents_status` 支撑启动对账的 `status='running'`
/// 轻量扫描（旧库全表扫描，子代理多时冷启动变慢）。
pub(crate) fn step_13_to_14(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let has_agents: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_agents'",
        [],
        |r| r.get(0),
    )?;
    if has_agents == 0 {
        return Ok(());
    }
    let cols = table_columns(tx, "session_agents")?;
    let add_col = |col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE session_agents ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add_col("capability_mode", "capability_mode TEXT")?;
    add_col("model_override", "model_override TEXT")?;
    add_col("resumable", "resumable INTEGER NOT NULL DEFAULT 0")?;
    add_col("last_heartbeat_ms", "last_heartbeat_ms INTEGER")?;
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_session_agents_status ON session_agents(status);",
    )?;
    Ok(())
}
