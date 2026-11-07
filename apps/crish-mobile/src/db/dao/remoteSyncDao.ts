// 远程会话增量同步状态 DAO（remote_sync_state 表）
// 纪律：UTF-8 无 BOM、中文注释、游标单调追踪，精准支撑增量拉取与向上历史翻页。
import type { SqlDriver } from '../driver';

/** 增量同步状态行契约 */
export interface RemoteSyncStateRow {
  deviceId: string;
  sessionId: string;
  lastSyncedSequence: number;
  hasMoreHistory: boolean;
  updatedAt: number;
}

/** 增量同步状态 DAO 接口 */
export interface RemoteSyncDao {
  /** 查询指定会话的同步状态 */
  getSyncState(
    deviceId: string,
    sessionId: string
  ): Promise<RemoteSyncStateRow | null>;
  /** 读取指定会话本地已同步的最大序号（未同步返回 0） */
  getLastSyncedSequence(deviceId: string, sessionId: string): Promise<number>;
  /** 读取指定设备全部会话的最新游标映射（订阅批量上报专用） */
  getAllLatestSequences(deviceId: string): Promise<Record<string, number>>;
  /** 幂等更新同步状态与最新游标 */
  updateSyncState(
    deviceId: string,
    sessionId: string,
    lastSyncedSequence: number,
    hasMoreHistory?: boolean,
    updatedAt?: number
  ): Promise<void>;
  /** 删除指定会话的同步状态 */
  deleteSyncState(deviceId: string, sessionId: string): Promise<void>;
  /** 清空指定设备的全部同步状态 */
  deleteDeviceSyncState(deviceId: string): Promise<void>;
}

/** 基于 SqlDriver 的增量同步状态 DAO 实现 */
export class SqlRemoteSyncDao implements RemoteSyncDao {
  constructor(private readonly driver: SqlDriver) {}

  async getSyncState(
    deviceId: string,
    sessionId: string
  ): Promise<RemoteSyncStateRow | null> {
    const raw = await this.driver.getFirst<{
      deviceId: string;
      sessionId: string;
      lastSyncedSequence: number;
      hasMoreHistory: number;
      updatedAt: number;
    }>(
      `SELECT device_id AS deviceId, session_id AS sessionId,
              last_synced_sequence AS lastSyncedSequence,
              has_more_history AS hasMoreHistory,
              updated_at AS updatedAt
       FROM remote_sync_state
       WHERE device_id = ? AND session_id = ?`,
      [deviceId, sessionId]
    );
    if (!raw) return null;
    return {
      ...raw,
      hasMoreHistory: Boolean(raw.hasMoreHistory),
    };
  }

  async getLastSyncedSequence(
    deviceId: string,
    sessionId: string
  ): Promise<number> {
    const row = await this.driver.getFirst<{ lastSyncedSequence: number }>(
      `SELECT last_synced_sequence AS lastSyncedSequence
       FROM remote_sync_state
       WHERE device_id = ? AND session_id = ?`,
      [deviceId, sessionId]
    );
    return row?.lastSyncedSequence ?? 0;
  }

  async getAllLatestSequences(
    deviceId: string
  ): Promise<Record<string, number>> {
    const rows = await this.driver.getAll<{
      sessionId: string;
      lastSyncedSequence: number;
    }>(
      `SELECT session_id AS sessionId, last_synced_sequence AS lastSyncedSequence
       FROM remote_sync_state
       WHERE device_id = ?`,
      [deviceId]
    );
    const map: Record<string, number> = {};
    for (const r of rows) {
      map[r.sessionId] = r.lastSyncedSequence;
    }
    return map;
  }

  async updateSyncState(
    deviceId: string,
    sessionId: string,
    lastSyncedSequence: number,
    hasMoreHistory = true,
    updatedAt = Date.now()
  ): Promise<void> {
    await this.driver.exec(
      `INSERT OR REPLACE INTO remote_sync_state (
        device_id, session_id, last_synced_sequence, has_more_history, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        deviceId,
        sessionId,
        lastSyncedSequence,
        hasMoreHistory ? 1 : 0,
        updatedAt,
      ]
    );
  }

  async deleteSyncState(deviceId: string, sessionId: string): Promise<void> {
    await this.driver.exec(
      'DELETE FROM remote_sync_state WHERE device_id = ? AND session_id = ?',
      [deviceId, sessionId]
    );
  }

  async deleteDeviceSyncState(deviceId: string): Promise<void> {
    await this.driver.exec(
      'DELETE FROM remote_sync_state WHERE device_id = ?',
      [deviceId]
    );
  }
}
