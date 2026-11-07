// 远程会话元数据 DAO（remote_sessions 表）
// 纪律：UTF-8 无 BOM、中文注释、非必要不兼容，按设备物理隔离（M7 分区）。
import type { SqlDriver } from '../driver';

/** 远程会话元数据行契约 */
export interface RemoteSessionRow {
  deviceId: string;
  sessionId: string;
  title: string;
  cwd: string | null;
  model: string | null;
  updatedAt: number;
  isPinned: boolean;
  isArchived: boolean;
  createdAt: number;
}

/** 远程会话 DAO 接口 */
export interface RemoteSessionDao {
  /** 幂等插入或更新单条远程会话 */
  upsertSession(row: RemoteSessionRow): Promise<void>;
  /** 批量插入或更新远程会话（在单事务内完成） */
  upsertSessions(rows: readonly RemoteSessionRow[]): Promise<void>;
  /** 查询指定设备的单条会话 */
  getSession(
    deviceId: string,
    sessionId: string
  ): Promise<RemoteSessionRow | null>;
  /** 列出指定设备的所有会话（置顶优先，updated_at 倒序） */
  listSessions(deviceId: string): Promise<RemoteSessionRow[]>;
  /** 删除指定会话 */
  deleteSession(deviceId: string, sessionId: string): Promise<void>;
  /** 清空指定设备的所有会话（解绑/清理使用） */
  deleteDeviceSessions(deviceId: string): Promise<void>;
}

/** 基于 SqlDriver 的远程会话 DAO 实现 */
export class SqlRemoteSessionDao implements RemoteSessionDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsertSession(row: RemoteSessionRow): Promise<void> {
    await this.driver.exec(
      `INSERT OR REPLACE INTO remote_sessions (
        device_id, session_id, title, cwd, model, updated_at, is_pinned, is_archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.deviceId,
        row.sessionId,
        row.title,
        row.cwd ?? null,
        row.model ?? null,
        row.updatedAt,
        row.isPinned ? 1 : 0,
        row.isArchived ? 1 : 0,
        row.createdAt,
      ]
    );
  }

  async upsertSessions(rows: readonly RemoteSessionRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.driver.withTransaction(async () => {
      for (const row of rows) {
        await this.upsertSession(row);
      }
    });
  }

  async getSession(
    deviceId: string,
    sessionId: string
  ): Promise<RemoteSessionRow | null> {
    const raw = await this.driver.getFirst<{
      deviceId: string;
      sessionId: string;
      title: string;
      cwd: string | null;
      model: string | null;
      updatedAt: number;
      isPinned: number;
      isArchived: number;
      createdAt: number;
    }>(
      `SELECT device_id AS deviceId, session_id AS sessionId, title, cwd, model,
              updated_at AS updatedAt, is_pinned AS isPinned, is_archived AS isArchived,
              created_at AS createdAt
       FROM remote_sessions
       WHERE device_id = ? AND session_id = ?`,
      [deviceId, sessionId]
    );
    if (!raw) return null;
    return {
      ...raw,
      isPinned: Boolean(raw.isPinned),
      isArchived: Boolean(raw.isArchived),
    };
  }

  async listSessions(deviceId: string): Promise<RemoteSessionRow[]> {
    const rows = await this.driver.getAll<{
      deviceId: string;
      sessionId: string;
      title: string;
      cwd: string | null;
      model: string | null;
      updatedAt: number;
      isPinned: number;
      isArchived: number;
      createdAt: number;
    }>(
      `SELECT device_id AS deviceId, session_id AS sessionId, title, cwd, model,
              updated_at AS updatedAt, is_pinned AS isPinned, is_archived AS isArchived,
              created_at AS createdAt
       FROM remote_sessions
       WHERE device_id = ?
       ORDER BY is_pinned DESC, updated_at DESC`,
      [deviceId]
    );
    return rows.map((r) => ({
      ...r,
      isPinned: Boolean(r.isPinned),
      isArchived: Boolean(r.isArchived),
    }));
  }

  async deleteSession(deviceId: string, sessionId: string): Promise<void> {
    await this.driver.exec(
      'DELETE FROM remote_sessions WHERE device_id = ? AND session_id = ?',
      [deviceId, sessionId]
    );
  }

  async deleteDeviceSessions(deviceId: string): Promise<void> {
    await this.driver.exec('DELETE FROM remote_sessions WHERE device_id = ?', [
      deviceId,
    ]);
  }
}
