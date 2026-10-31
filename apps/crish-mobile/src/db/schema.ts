// 本地存储 schema（Z0 R2-13 / M5 §5.2；v2 收敛为 3 张生效表）
// 纪律（M5 §1.2 规则 2）：存储层不得 import 网络层；与 src/network 互不可见。
// 迁移纪律（M5 §5.4）：已发布迁移 SQL 禁止修改，新需求走 v2+；本文件只追加表定义。

/**
 * 生效表清单（v2 收敛，实现波总方案 D5）：
 * 1. approval_queue   outbox 待发队列（SqlApprovalQueueDao）
 * 2. settings         键值存储（SqlSettingsDao）
 * 3. notifications    应用内通知/角标状态（SqlNotificationsDao）
 *
 * v1 曾声明 8 表；其中 `events` / `approval_history` / `session_summaries` /
 * `push_tokens` / `device_info` 五表自始至终无 DAO 无读写（早期全量镜像方案的
 * 死 DDL，与「内存流投影伴侣」架构相悖），v2 迁移统一 DROP（见 V2_CLEANUP_SQL）。
 */

/** 当前 schema 版本（PRAGMA user_version 目标值） */
export const SCHEMA_VERSION = 2;

/** 全部生效表名（供测试与工具使用） */
export const TABLES = ['approval_queue', 'settings', 'notifications'] as const;

export type TableName = (typeof TABLES)[number];

/**
 * v1 建表 SQL（历史迁移，append-only 保留原样；PRAGMA user_version = 1 由迁移层负责）。
 * 与 M5 §5.2 / D4 §7.2 对齐，字段名统一 snake_case。
 * 注意：v1 按 8 表口径建表，其中 5 张死表由 v2 迁移统一 DROP（见 V2_CLEANUP_SQL）。
 */
export const SCHEMA_SQL: readonly string[] = [
  // 事件流（M5 §5.2 events）：引擎事件信封本地镜像；sequence 为会话级单调游标。
  // 复合主键 (session_id, sequence) 保证游标唯一性（M5 §5.2 注释：跨 run 不重置、并发 run 唯一）。
  `CREATE TABLE IF NOT EXISTS events (
    sequence       INTEGER NOT NULL,
    event_id       TEXT NOT NULL,
    type           TEXT NOT NULL,
    session_id     TEXT,
    run_id         TEXT,
    timestamp      INTEGER,
    payload_json   TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    ingested_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, sequence DESC)`,
  // 按 type 索引：审批待办派生视图（approval-requested / approval-resolved 配对查询）依赖（D6 §3.4）
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,

  // outbox 待发队列（任务书 R2-13 指定字段对齐 outbox.ts：toolCallId/decision/reason/runId/msgId/status/attempts；
  // 其余对齐 M5 §5.2 outbox 与 D6 §10.6 approval_queue）
  `CREATE TABLE IF NOT EXISTS approval_queue (
    id               TEXT PRIMARY KEY,
    tool_call_id     TEXT NOT NULL,
    decision         TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
    reason           TEXT,
    run_id           TEXT,
    msg_id           TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    next_retry_at_ms INTEGER,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    UNIQUE (tool_call_id, decision)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status, created_at_ms)`,

  // 审批决策记录（M5 §5.2 approvals：本地待批队列 + 历史；payload 为 PermissionRequest JSON）
  // D6 §3.4 哲学：待办是 events 表派生视图，本表保存决策记录（pending 恒保留，已决 30 天清理）
  `CREATE TABLE IF NOT EXISTS approval_history (
    tool_call_id   TEXT PRIMARY KEY,
    session_id     TEXT,
    run_id         TEXT,
    tool_name      TEXT NOT NULL,
    summary        TEXT,
    arbiter        TEXT NOT NULL DEFAULT 'user',
    danger_level   INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL,
    decision       TEXT,
    request_json   TEXT NOT NULL,
    risk_meta_json TEXT,
    requested_at   INTEGER NOT NULL,
    decided_at     INTEGER,
    expires_at     INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approval_history_status ON approval_history(status, requested_at DESC)`,

  // 会话摘要（M5 §5.2 sessions：对应共享类型 OrchestratorSessionEventSummary / list_sessions 返回）
  `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id           TEXT PRIMARY KEY,
    title                TEXT,
    cwd                  TEXT,
    status               TEXT NOT NULL DEFAULT 'open',
    is_pinned            INTEGER NOT NULL DEFAULT 0,
    is_archived          INTEGER NOT NULL DEFAULT 0,
    message_count        INTEGER NOT NULL DEFAULT 0,
    engine_cursor        INTEGER NOT NULL DEFAULT 0,
    engine_last_run_id   TEXT,
    updated_at           INTEGER NOT NULL,
    last_message_preview TEXT,
    metadata_json        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON session_summaries(updated_at DESC)`,

  // 键值存储（M5 §5.2 kv：订阅游标/通知偏好等运行态；D6 §10.6 sync_meta 同形态）
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // 推送注册（D7 §8.1：移动端只持有「自己的 token」，上报桌面端 push_devices；随设备解绑即删）
  `CREATE TABLE IF NOT EXISTS push_tokens (
    platform   TEXT PRIMARY KEY,
    vendor     TEXT NOT NULL,
    token      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // 设备与配对元数据（M5 §5.2 device_meta：非敏感部分；敏感密钥在 secure-store）
  `CREATE TABLE IF NOT EXISTS device_info (
    device_id              TEXT PRIMARY KEY,
    desktop_id             TEXT NOT NULL,
    device_name            TEXT,
    paired_at              INTEGER NOT NULL,
    host_url               TEXT,
    cert_fingerprint_tail  TEXT,
    contract_version       TEXT
  )`,

  // 通知与角标状态（M5 §5.2 notifications：推送去重/角标断点；id 为去重键）
  `CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    tool_call_id TEXT,
    run_id      TEXT,
    seq         INTEGER,
    title       TEXT,
    body        TEXT,
    route       TEXT,
    status      TEXT NOT NULL,
    received_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, received_at DESC)`,
];

/**
 * v2 清理 SQL：删除 5 张幽灵表及其索引（零 DAO 零读写的死 DDL，实现波总方案 D5）。
 * DROP IF EXISTS 保证从任意 v1 状态升级幂等。
 */
export const V2_CLEANUP_SQL: readonly string[] = [
  `DROP INDEX IF EXISTS idx_events_run`,
  `DROP INDEX IF EXISTS idx_events_type`,
  `DROP INDEX IF EXISTS idx_approval_history_status`,
  `DROP INDEX IF EXISTS idx_sessions_updated`,
  `DROP TABLE IF EXISTS events`,
  `DROP TABLE IF EXISTS approval_history`,
  `DROP TABLE IF EXISTS session_summaries`,
  `DROP TABLE IF EXISTS push_tokens`,
  `DROP TABLE IF EXISTS device_info`,
];
