// events DAO（M5 §5.2 events：事件流镜像；(session_id, sequence) 复合主键）
// 语义（M5 §7.5 / D6 §4.6）：append 优先 + sequence 冲突幂等覆盖（重连追平可能重复投递）；
// 游标查询按 (session_id, sequence) 单调推进；审批待办由 events 派生视图（D6 §3.4）。
import type { SqlDriver } from '../driver';

/** 事件行（字段对齐 M5 §5.2 events 表） */
export interface EventRow {
  /** 会话级单调 sequence（D3 §7.4 唯一游标依据） */
  sequence: number;
  /** 事件体 id（messageId / toolCallId） */
  eventId: string;
  /** wire type（kebab-case） */
  type: string;
  /** 所属会话 */
  sessionId: string | null;
  /** 所属 run */
  runId: string | null;
  /** 事件时间戳（毫秒） */
  timestamp: number | null;
  /** 完整事件体（宽容存储，解析在数据层） */
  payloadJson: string;
  /** 事件 schema 版本 */
  schemaVersion: number;
  /** 本地落库时刻（毫秒） */
  ingestedAt: number;
}

/** 事件游标分页查询结果（含游标推进辅助） */
export interface EventPage {
  rows: EventRow[];
  /** 下一页起始游标（末行的 sequence，即「已应用最大序列」；传回 listAfter 的 afterSequence 续拉） */
  nextCursor: number;
  /** 是否还有更多（rows 长度达到 limit） */
  hasMore: boolean;
}

/** events 表 DAO 接口（CRUD + 游标语义） */
export interface EventsDao {
  /** 幂等写入：同 (session_id, sequence) 覆盖（重连追平重复投递不产生重复行） */
  upsert(row: EventRow): Promise<void>;
  /** 游标分页：取 (session_id, sequence) > afterSequence 的最多 limit 条（升序） */
  listAfter(
    sessionId: string,
    afterSequence: number,
    limit: number
  ): Promise<EventPage>;
  /** 会话最新 sequence（无事件返回 null） */
  latestSequence(sessionId: string): Promise<number | null>;
  /** 会话内事件数（清理窗口计算用） */
  countBySession(sessionId: string): Promise<number>;
  /** 全局事件数 */
  count(): Promise<number>;
  /** 删除该会话内 sequence < beforeSequence 的旧事件（每会话窗口清理，M5 §5.5） */
  deleteOlderThan(sessionId: string, beforeSequence: number): Promise<void>;
  /** 删除整个会话的事件（会话删除级联语义，D6 §5.4） */
  deleteBySession(sessionId: string): Promise<void>;
}

const SELECT_EVENT = `SELECT sequence, event_id AS eventId, type, session_id AS sessionId, run_id AS runId, timestamp, payload_json AS payloadJson, schema_version AS schemaVersion, ingested_at AS ingestedAt FROM events`;

/** 基于 SqlDriver 的 events DAO 实现（注入驱动；真实环境 expo-sqlite） */
export class SqlEventsDao implements EventsDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsert(row: EventRow): Promise<void> {
    if (row.sessionId === null) {
      // 复合主键 (session_id, sequence) 不允许 session_id 为空（对齐 D3 §7.4 会话级语义）
      throw new Error('events.upsert：sessionId 不能为空（复合主键要求）');
    }
    const existing = await this.driver.getFirst<{ sequence: number }>(
      'SELECT sequence FROM events WHERE session_id = ? AND sequence = ?',
      [row.sessionId, row.sequence]
    );
    if (existing !== null) {
      await this.driver.exec(
        `UPDATE events SET event_id = ?, type = ?, run_id = ?, timestamp = ?, payload_json = ?, schema_version = ?, ingested_at = ? WHERE session_id = ? AND sequence = ?`,
        [
          row.eventId,
          row.type,
          row.runId,
          row.timestamp,
          row.payloadJson,
          row.schemaVersion,
          row.ingestedAt,
          row.sessionId,
          row.sequence,
        ]
      );
      return;
    }
    await this.driver.exec(
      `INSERT INTO events (sequence, event_id, type, session_id, run_id, timestamp, payload_json, schema_version, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.sequence,
        row.eventId,
        row.type,
        row.sessionId,
        row.runId,
        row.timestamp,
        row.payloadJson,
        row.schemaVersion,
        row.ingestedAt,
      ]
    );
  }

  async listAfter(
    sessionId: string,
    afterSequence: number,
    limit: number
  ): Promise<EventPage> {
    const rows = await this.driver.getAll<EventRow>(
      `${SELECT_EVENT} WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      [sessionId, afterSequence, limit]
    );
    const last = rows[rows.length - 1];
    return {
      rows,
      // 游标 = 已应用最大序列（D6 §10.6 last_applied_seq 语义），调用方原样传回续拉
      nextCursor: last !== undefined ? last.sequence : afterSequence,
      hasMore: rows.length >= limit,
    };
  }

  async latestSequence(sessionId: string): Promise<number | null> {
    const row = await this.driver.getFirst<{ max: number | null }>(
      'SELECT MAX(sequence) AS max FROM events WHERE session_id = ?',
      [sessionId]
    );
    return row?.max ?? null;
  }

  async countBySession(sessionId: string): Promise<number> {
    const row = await this.driver.getFirst<{ count: number }>(
      'SELECT COUNT(*) AS count FROM events WHERE session_id = ?',
      [sessionId]
    );
    return row?.count ?? 0;
  }

  async count(): Promise<number> {
    const row = await this.driver.getFirst<{ count: number }>(
      'SELECT COUNT(*) AS count FROM events'
    );
    return row?.count ?? 0;
  }

  async deleteOlderThan(
    sessionId: string,
    beforeSequence: number
  ): Promise<void> {
    await this.driver.exec(
      'DELETE FROM events WHERE session_id = ? AND sequence < ?',
      [sessionId, beforeSequence]
    );
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.driver.exec('DELETE FROM events WHERE session_id = ?', [
      sessionId,
    ]);
  }
}
