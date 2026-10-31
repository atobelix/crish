// notifications DAO（应用内通知/角标状态：M5 §5.2 notifications，推送去重/角标断点）
// 语义（D7 §3.4.1 去重 / M5 §5.2）：id 为去重键（sequence | toolCallId），双通道（WS + 推送）同键只留一条。
import type { SqlDriver } from '../driver';

/** 通知行（字段对齐 M5 §5.2 notifications） */
export interface NotificationRow {
  /** 通知去重键（sequence | toolCallId） */
  id: string;
  /** 类型：approval | run-ended | task-failed | ... */
  kind: string;
  toolCallId: string | null;
  runId: string | null;
  /** 事件序列（事件驱动来源） */
  seq: number | null;
  title: string | null;
  body: string | null;
  /** 深链（D7 §7.4 路由映射表） */
  route: string | null;
  /** 状态：shown | dismissed | resolved */
  status: 'shown' | 'dismissed' | 'resolved';
  /** 接收时刻（毫秒） */
  receivedAt: number;
}

/** notifications 表 DAO 接口 */
export interface NotificationsDao {
  /** 幂等写入：同 id 覆盖（原子 ON CONFLICT upsert，双通道并发安全，D7 §3.4.1） */
  upsert(row: NotificationRow): Promise<void>;
  /** 按去重键查询 */
  findById(id: string): Promise<NotificationRow | null>;
  /** 按状态列表（角标统计/清理用，received_at 降序） */
  listByStatus(status: NotificationRow['status']): Promise<NotificationRow[]>;
  /** 状态迁移（dismissed/resolved） */
  updateStatus(id: string, status: NotificationRow['status']): Promise<void>;
  /** 删除单条 */
  deleteById(id: string): Promise<void>;
  /** 清理：resolved 且 received_at 早于 beforeMs（M5 §5.5：resolved 保留 7 天） */
  deleteResolvedOlderThan(beforeMs: number): Promise<void>;
  /** 全部条数 */
  count(): Promise<number>;
}

const SELECT_NOTIFICATION = `SELECT id, kind, tool_call_id AS toolCallId, run_id AS runId, seq, title, body, route, status, received_at AS receivedAt FROM notifications`;

/** 基于 SqlDriver 的 notifications DAO 实现 */
export class SqlNotificationsDao implements NotificationsDao {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * 原子 upsert：单条 `INSERT ... ON CONFLICT(id) DO UPDATE`。
   * 消除 Check-Then-Act 竞态（WS 实时帧与系统推送并发写同一 id 时，
   * 两段式会同时查空并同时 INSERT → UNIQUE 冲突异常中断摄入管道）。
   */
  async upsert(row: NotificationRow): Promise<void> {
    await this.driver.exec(
      `INSERT INTO notifications (id, kind, tool_call_id, run_id, seq, title, body, route, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = ?, tool_call_id = ?, run_id = ?, seq = ?, title = ?, body = ?, route = ?, status = ?, received_at = ?`,
      [
        row.id,
        row.kind,
        row.toolCallId,
        row.runId,
        row.seq,
        row.title,
        row.body,
        row.route,
        row.status,
        row.receivedAt,
        row.kind,
        row.toolCallId,
        row.runId,
        row.seq,
        row.title,
        row.body,
        row.route,
        row.status,
        row.receivedAt,
      ]
    );
  }

  async findById(id: string): Promise<NotificationRow | null> {
    return this.driver.getFirst<NotificationRow>(
      `${SELECT_NOTIFICATION} WHERE id = ?`,
      [id]
    );
  }

  async listByStatus(
    status: NotificationRow['status']
  ): Promise<NotificationRow[]> {
    return this.driver.getAll<NotificationRow>(
      `${SELECT_NOTIFICATION} WHERE status = ? ORDER BY received_at DESC`,
      [status]
    );
  }

  async updateStatus(
    id: string,
    status: NotificationRow['status']
  ): Promise<void> {
    await this.driver.exec('UPDATE notifications SET status = ? WHERE id = ?', [
      status,
      id,
    ]);
  }

  async deleteById(id: string): Promise<void> {
    await this.driver.exec('DELETE FROM notifications WHERE id = ?', [id]);
  }

  async deleteResolvedOlderThan(beforeMs: number): Promise<void> {
    await this.driver.exec(
      'DELETE FROM notifications WHERE status = ? AND received_at < ?',
      ['resolved', beforeMs]
    );
  }

  async count(): Promise<number> {
    const row = await this.driver.getFirst<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notifications'
    );
    return row?.count ?? 0;
  }
}
