// approval_queue DAO：outbox 待发决策的持久化真源。
//
// 为什么在 SQLite 而不是 secure-store：Outbox 是「泄漏仅损失隐私」的数据
// （M5 §6.1 分层原则），而 iOS Keychain 单值上限约 2KB——outbox 容量上限
// 200 项，全量 JSON 存入必然超限，写入失败后离线决策会静默丢失。
//
// 表结构见 schema.ts 的 approval_queue（字段对齐 domain/data/outbox.ts）。
import type { SqlDriver } from '../driver';
import type { OutboxItem, OutboxStatus } from '@/domain/data/outbox';

/** approval_queue 行形状（snake_case，与 schema 对齐） */
export interface ApprovalQueueRow {
  id: string;
  tool_call_id: string;
  decision: string;
  reason: string | null;
  run_id: string | null;
  msg_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_retry_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** 行 → 领域对象 */
export function rowToOutboxItem(row: ApprovalQueueRow): OutboxItem {
  return {
    id: row.id,
    toolCallId: row.tool_call_id,
    decision: row.decision === 'denied' ? 'denied' : 'approved',
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    msgId: row.msg_id,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    nextRetryAtMs: row.next_retry_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/** approval_queue 表 DAO 接口 */
export interface ApprovalQueueDao {
  /** 读全部待发项（按创建时间升序，保证重放顺序稳定） */
  loadAll(): Promise<OutboxItem[]>;
  /** 原子替换整表内容（快照语义：outbox 每次变更整体落库） */
  replaceAll(items: readonly OutboxItem[]): Promise<void>;
  /** 清空（解除配对 / 测试隔离） */
  clear(): Promise<void>;
}

const SELECT_ALL_SQL =
  'SELECT id, tool_call_id, decision, reason, run_id, msg_id, status, attempts, ' +
  'last_error, next_retry_at_ms, created_at_ms, updated_at_ms ' +
  'FROM approval_queue ORDER BY created_at_ms ASC';

const INSERT_SQL =
  'INSERT INTO approval_queue (id, tool_call_id, decision, reason, run_id, msg_id, ' +
  'status, attempts, last_error, next_retry_at_ms, created_at_ms, updated_at_ms) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** 基于 SqlDriver 的 approval_queue DAO 实现 */
export class SqlApprovalQueueDao implements ApprovalQueueDao {
  constructor(private readonly driver: SqlDriver) {}

  async loadAll(): Promise<OutboxItem[]> {
    const rows = await this.driver.getAll<ApprovalQueueRow>(SELECT_ALL_SQL);
    return rows.map(rowToOutboxItem);
  }

  async replaceAll(items: readonly OutboxItem[]): Promise<void> {
    // 事务内先清后插：避免 DELETE 成功而 INSERT 失败留下空队列
    await this.driver.withTransaction(async () => {
      await this.driver.exec('DELETE FROM approval_queue');
      for (const item of items) {
        await this.driver.exec(INSERT_SQL, [
          item.id,
          item.toolCallId,
          item.decision,
          item.reason ?? null,
          item.runId ?? null,
          item.msgId,
          item.status,
          item.attempts,
          item.lastError,
          item.nextRetryAtMs,
          item.createdAtMs,
          item.updatedAtMs,
        ]);
      }
    });
  }

  async clear(): Promise<void> {
    await this.driver.exec('DELETE FROM approval_queue');
  }
}
