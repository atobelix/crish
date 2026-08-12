// session_summaries DAO（会话摘要：M5 §5.2 sessions，对应 OrchestratorSessionEventSummary）
import type { SqlDriver } from '../driver';

/** 会话摘要行（字段对齐 M5 §5.2 sessions / 共享类型 OrchestratorSessionEventSummary） */
export interface SessionSummaryRow {
  /** 引擎会话 id */
  sessionId: string;
  /** 桌面推导标题（sessionTitle.ts 同规则，F5 §2.1） */
  title: string | null;
  /** 工作目录 */
  cwd: string | null;
  /** open | closed | archived */
  status: 'open' | 'closed' | 'archived';
  /** 是否固定（0/1） */
  isPinned: 0 | 1;
  /** 是否归档（0/1） */
  isArchived: 0 | 1;
  /** 消息计数 */
  messageCount: number;
  /** 引擎事件游标（hydratedFromEngine 对齐） */
  engineCursor: number;
  /** 最近 run id */
  engineLastRunId: string | null;
  /** 毫秒时间戳（排序键） */
  updatedAt: number;
  /** 最近消息预览 */
  lastMessagePreview: string | null;
  /** 元数据兜底 JSON */
  metadataJson: string | null;
}

/** session_summaries 表 DAO 接口 */
export interface SessionSummariesDao {
  /** 幂等写入：同 session_id 覆盖（桌面权威覆盖语义，D6 §10.6 session_projection） */
  upsert(row: SessionSummaryRow): Promise<'inserted' | 'updated'>;
  /** 按会话 id 查询 */
  findById(sessionId: string): Promise<SessionSummaryRow | null>;
  /** 最近列表（updated_at 降序，最多 limit 条） */
  listRecent(limit: number): Promise<SessionSummaryRow[]>;
  /** 全部会话（按 updated_at 升序，清理计算用） */
  listAll(): Promise<SessionSummaryRow[]>;
  /** 删除单条 */
  deleteById(sessionId: string): Promise<void>;
  /** 全部条数 */
  count(): Promise<number>;
}

const SELECT_SESSION = `SELECT session_id AS sessionId, title, cwd, status, is_pinned AS isPinned, is_archived AS isArchived, message_count AS messageCount, engine_cursor AS engineCursor, engine_last_run_id AS engineLastRunId, updated_at AS updatedAt, last_message_preview AS lastMessagePreview, metadata_json AS metadataJson FROM session_summaries`;

/** 基于 SqlDriver 的 session_summaries DAO 实现 */
export class SqlSessionSummariesDao implements SessionSummariesDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsert(row: SessionSummaryRow): Promise<'inserted' | 'updated'> {
    const existing = await this.driver.getFirst<{ session_id: string }>(
      'SELECT session_id FROM session_summaries WHERE session_id = ?',
      [row.sessionId]
    );
    if (existing !== null) {
      await this.driver.exec(
        `UPDATE session_summaries SET title = ?, cwd = ?, status = ?, is_pinned = ?, is_archived = ?, message_count = ?, engine_cursor = ?, engine_last_run_id = ?, updated_at = ?, last_message_preview = ?, metadata_json = ? WHERE session_id = ?`,
        [
          row.title,
          row.cwd,
          row.status,
          row.isPinned,
          row.isArchived,
          row.messageCount,
          row.engineCursor,
          row.engineLastRunId,
          row.updatedAt,
          row.lastMessagePreview,
          row.metadataJson,
          row.sessionId,
        ]
      );
      return 'updated';
    }
    await this.driver.exec(
      `INSERT INTO session_summaries (session_id, title, cwd, status, is_pinned, is_archived, message_count, engine_cursor, engine_last_run_id, updated_at, last_message_preview, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.sessionId,
        row.title,
        row.cwd,
        row.status,
        row.isPinned,
        row.isArchived,
        row.messageCount,
        row.engineCursor,
        row.engineLastRunId,
        row.updatedAt,
        row.lastMessagePreview,
        row.metadataJson,
      ]
    );
    return 'inserted';
  }

  async findById(sessionId: string): Promise<SessionSummaryRow | null> {
    return this.driver.getFirst<SessionSummaryRow>(
      `${SELECT_SESSION} WHERE session_id = ?`,
      [sessionId]
    );
  }

  async listRecent(limit: number): Promise<SessionSummaryRow[]> {
    return this.driver.getAll<SessionSummaryRow>(
      `${SELECT_SESSION} ORDER BY updated_at DESC LIMIT ?`,
      [limit]
    );
  }

  async listAll(): Promise<SessionSummaryRow[]> {
    return this.driver.getAll<SessionSummaryRow>(
      `${SELECT_SESSION} ORDER BY updated_at ASC`
    );
  }

  async deleteById(sessionId: string): Promise<void> {
    await this.driver.exec(
      'DELETE FROM session_summaries WHERE session_id = ?',
      [sessionId]
    );
  }

  async count(): Promise<number> {
    const row = await this.driver.getFirst<{ count: number }>(
      'SELECT COUNT(*) AS count FROM session_summaries'
    );
    return row?.count ?? 0;
  }
}
