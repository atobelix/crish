// 远程会话事件持久化 DAO（remote_events 表）
// 纪律：UTF-8 无 BOM、中文注释、按设备与会话物理分区，事件信封为本地单一真源（SSOT）。
import type { SqlDriver } from '../driver';

/** 远程事件持久化行契约 */
export interface RemoteEventRow {
  deviceId: string;
  sessionId: string;
  sequence: number;
  kind: string;
  eventType: string;
  receivedAtMs: number;
  rawPayload: string; // 完整序列化 JSON 信封 (TEXT)
}

/** 远程事件 DAO 接口 */
export interface RemoteEventDao {
  /** 批量插入事件（INSERT OR REPLACE 幂等，事务提交） */
  insertEvents(events: readonly RemoteEventRow[]): Promise<void>;
  /** 读取最新 N 条事件（秒开会话专用，按 sequence ASC 升序排列返回） */
  getRecentEvents(
    deviceId: string,
    sessionId: string,
    limit?: number
  ): Promise<RemoteEventRow[]>;
  /** 向上翻页：加载指定 sequence 之前的历史事件（按 sequence ASC 升序排列返回） */
  getEventsBefore(
    deviceId: string,
    sessionId: string,
    beforeSequence: number,
    limit?: number
  ): Promise<RemoteEventRow[]>;
  /** 获取某会话本地已落盘的最大 sequence（无记录返回 0） */
  getLatestSequence(deviceId: string, sessionId: string): Promise<number>;
  /** 删除指定会话全部事件 */
  deleteSessionEvents(deviceId: string, sessionId: string): Promise<void>;
  /** 删除指定设备全部事件 */
  deleteDeviceEvents(deviceId: string): Promise<void>;
}

/** 基于 SqlDriver 的远程事件 DAO 实现 */
export class SqlRemoteEventDao implements RemoteEventDao {
  constructor(private readonly driver: SqlDriver) {}

  async insertEvents(events: readonly RemoteEventRow[]): Promise<void> {
    if (events.length === 0) return;
    await this.driver.withTransaction(async () => {
      for (const ev of events) {
        await this.driver.exec(
          `INSERT OR REPLACE INTO remote_events (
            device_id, session_id, sequence, kind, event_type, received_at_ms, raw_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            ev.deviceId,
            ev.sessionId,
            ev.sequence,
            ev.kind,
            ev.eventType,
            ev.receivedAtMs,
            ev.rawPayload,
          ]
        );
      }
    });
  }

  async getRecentEvents(
    deviceId: string,
    sessionId: string,
    limit = 100
  ): Promise<RemoteEventRow[]> {
    const rows = await this.driver.getAll<RemoteEventRow>(
      `SELECT device_id AS deviceId, session_id AS sessionId, sequence, kind,
              event_type AS eventType, received_at_ms AS receivedAtMs, raw_payload AS rawPayload
       FROM remote_events
       WHERE device_id = ? AND session_id = ?
       ORDER BY sequence DESC
       LIMIT ?`,
      [deviceId, sessionId, limit]
    );
    // 倒序翻转回正序 sequence ASC，供时间线视图按序消费
    return rows.reverse();
  }

  async getEventsBefore(
    deviceId: string,
    sessionId: string,
    beforeSequence: number,
    limit = 50
  ): Promise<RemoteEventRow[]> {
    const rows = await this.driver.getAll<RemoteEventRow>(
      `SELECT device_id AS deviceId, session_id AS sessionId, sequence, kind,
              event_type AS eventType, received_at_ms AS receivedAtMs, raw_payload AS rawPayload
       FROM remote_events
       WHERE device_id = ? AND session_id = ? AND sequence < ?
       ORDER BY sequence DESC
       LIMIT ?`,
      [deviceId, sessionId, beforeSequence, limit]
    );
    return rows.reverse();
  }

  async getLatestSequence(
    deviceId: string,
    sessionId: string
  ): Promise<number> {
    const row = await this.driver.getFirst<{ maxSeq: number | null }>(
      `SELECT MAX(sequence) AS maxSeq
       FROM remote_events
       WHERE device_id = ? AND session_id = ?`,
      [deviceId, sessionId]
    );
    return row?.maxSeq ?? 0;
  }

  async deleteSessionEvents(
    deviceId: string,
    sessionId: string
  ): Promise<void> {
    await this.driver.exec(
      'DELETE FROM remote_events WHERE device_id = ? AND session_id = ?',
      [deviceId, sessionId]
    );
  }

  async deleteDeviceEvents(deviceId: string): Promise<void> {
    await this.driver.exec('DELETE FROM remote_events WHERE device_id = ?', [
      deviceId,
    ]);
  }
}
