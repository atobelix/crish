// 本地存储 schema（Z0 R2-13 / M5 §5.2；v2 收敛为 3 张生效表；v3 增本地线程两表；
// v4 给 local_threads 增 title_source 列，见 V4_THREAD_TITLE_SOURCE_SQL；
// v5 给 local_messages 增 attachments_json 列，见 V5_MESSAGE_ATTACHMENTS_SQL；
// v6 给 local_messages 增 5 个搜索与工具 JSON 列，见 V6_MESSAGE_TOOLS_AND_SEARCH_SQL；
// v7 增加 remote_sessions / remote_events / remote_sync_state 远程控制持久化三表，见 V7_REMOTE_STORAGE_SQL）
// 纪律（M5 §1.2 规则 2）：存储层不得 import 网络层；与 src/network 互不可见。
// 迁移纪律（M5 §5.4）：已发布迁移 SQL 禁止修改，新需求走 v2+；本文件只追加表定义。

/**
 * 生效表清单（v7）：
 * 1. approval_queue     outbox 待发队列（SqlApprovalQueueDao）
 * 2. settings           键值存储（SqlSettingsDao）
 * 3. notifications      应用内通知/角标状态（SqlNotificationsDao）
 * 4. local_threads      本地对话线程元数据（SqlLocalThreadsDao；CON-4/L2）
 * 5. local_messages     本地对话消息历史（SqlLocalThreadsDao；CON-4/L2）
 * 6. remote_sessions    远程会话元数据（SqlRemoteSessionDao；设备物理分区隔离）
 * 7. remote_events      远程会话事件流（SqlRemoteEventDao；本地真源 SSOT）
 * 8. remote_sync_state  远程增量同步状态机游标（SqlRemoteSyncDao）
 *
 * v1 曾声明 8 表；其中 `events` / `approval_history` / `session_summaries` /
 * `push_tokens` / `device_info` 五表自始至终无 DAO 无读写（早期全量镜像方案的
 * 死 DDL，与「内存流投影伴侣」架构相悖），v2 迁移统一 DROP（见 V2_CLEANUP_SQL）。
 * v3 的本地线程两表只存对话内容与线程元数据——**不存任何凭据**：API key
 * 材料只进 SecureStore（localChatStore 纪律），本表连 apiKeyRef 都不落，
 * provider/model 只存二元身份（provider_id + model_id，与配置面 join 即可）。
 */

/** 当前 schema 版本（PRAGMA user_version 目标值） */
export const SCHEMA_VERSION = 7;

/** 全部生效表名（供测试与工具使用） */
export const TABLES = [
  'approval_queue',
  'settings',
  'notifications',
  'local_threads',
  'local_messages',
  'remote_sessions',
  'remote_events',
  'remote_sync_state',
] as const;

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

/**
 * v3 建表 SQL（CON-4 / 本地对话 L2：多线程 + 历史持久化，用户裁决 2026-11-02）：
 * - local_threads：线程元数据（标题/摘要/每线程模型二元身份/时间戳）；
 * - local_messages：消息历史（seq 为线程内单调序，UNIQUE(thread_id, seq)
 *   保证顺序唯一；stopped/tool_call_count 对齐 LocalChatMessage 可选字段）；
 * - 级联删除由 DAO 在事务内手动完成（不用 FOREIGN KEY 子句，保持与内存
 *   驱动 SQL 子集的一致口径）。
 */
export const V3_LOCAL_THREADS_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS local_threads (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    preview     TEXT NOT NULL DEFAULT '',
    provider_id TEXT,
    model_id    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_messages (
    id              TEXT PRIMARY KEY,
    thread_id       TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    stopped         INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER,
    UNIQUE (thread_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_messages_thread ON local_messages(thread_id, seq)`,
];

/**
 * v4 迁移 SQL（U4 AI 标题）：local_threads 增 title_source 列（标题来源
 * 阶梯 placeholder/derived/ai/user，见 domain/types/localChat 的
 * LocalThreadTitleSource）。存量行 DEFAULT 'derived'——不追溯生成 AI
 * 标题：存量线程保持其截断标题、用户可改名，只有新建线程走 AI 流程，
 * 避免历史标题被无声改写。本列只存来源枚举，不存任何凭据形态。
 */
export const V4_THREAD_TITLE_SOURCE_SQL: readonly string[] = [
  `ALTER TABLE local_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'derived'`,
];

/**
 * v5 迁移 SQL（本地对话附件接线）：local_messages 增 attachments_json 列——
 * 只存随用户消息真以 image_url 结构化下发的图片附件 JSON（组装形态
 * ComposerAttachment 的落存子集，供后续轮次回放图片 part）；文本/文件
 * 附件的全部信息已组装进 content，不在此重复落存。NULL = 无图片附件
 * （存量行天然如此）。本列只存图片数据，不存任何凭据形态。
 */
export const V5_MESSAGE_ATTACHMENTS_SQL: readonly string[] = [
  `ALTER TABLE local_messages ADD COLUMN attachments_json TEXT`,
];

/**
 * v6 迁移 SQL（网页搜索与沙箱工具体系集成）：
 * 给 local_messages 增加工具调用、工具结果、引用来源、搜索状态及服务端诊断 5 个 JSON 列。
 * 存量行天然为 NULL（与 attachments_json 保持同一优雅口径），零数据损毁风险。
 * 纯存元数据与文本，绝对严禁任何 API Key 或敏感 Token 落入本列！
 */
export const V6_MESSAGE_TOOLS_AND_SEARCH_SQL: readonly string[] = [
  `ALTER TABLE local_messages ADD COLUMN tool_calls_json TEXT DEFAULT NULL`,
  `ALTER TABLE local_messages ADD COLUMN tool_results_json TEXT DEFAULT NULL`,
  `ALTER TABLE local_messages ADD COLUMN citations_json TEXT DEFAULT NULL`,
  `ALTER TABLE local_messages ADD COLUMN search_state_json TEXT DEFAULT NULL`,
  `ALTER TABLE local_messages ADD COLUMN server_diagnostics_json TEXT DEFAULT NULL`,
];

/**
 * v7 迁移 SQL（远程控制本地持久化与增量同步）：
 * 1. remote_sessions：远程会话元数据（多设备物理分区支持，复合主键 device_id + session_id）；
 * 2. remote_events：会话事件信封本地持久化真源（按 sequence 升序索引）；
 * 3. remote_sync_state：每个远程会话的双向同步游标与同步状态。
 */
export const V7_REMOTE_STORAGE_SQL: readonly string[] = [
  // 1. 远程会话元数据表
  `CREATE TABLE IF NOT EXISTS remote_sessions (
    device_id   TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    cwd         TEXT,
    model       TEXT,
    updated_at  INTEGER NOT NULL,
    is_pinned   INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (device_id, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_remote_sessions_updated ON remote_sessions(device_id, updated_at DESC)`,

  // 2. 远程事件信封持久化表
  `CREATE TABLE IF NOT EXISTS remote_events (
    device_id      TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    sequence       INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    raw_payload    TEXT NOT NULL,
    PRIMARY KEY (device_id, session_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_remote_events_seq ON remote_events(device_id, session_id, sequence ASC)`,

  // 3. 增量同步状态与游标表
  `CREATE TABLE IF NOT EXISTS remote_sync_state (
    device_id            TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    last_synced_sequence INTEGER NOT NULL DEFAULT 0,
    has_more_history     INTEGER NOT NULL DEFAULT 1,
    updated_at           INTEGER NOT NULL,
    PRIMARY KEY (device_id, session_id)
  )`,
];
