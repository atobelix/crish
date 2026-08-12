// approval_queue DAO（outbox 待发队列：字段对齐 src/domain/data/outbox.ts OutboxItem）
// 语义（D6 §6.2-6.3 / M5 §4.6）：幂等键 (tool_call_id, decision) 唯一，同键入队覆盖旧条目；
// 三态 pending/sent/failed；failed 退避到期才可重放（outbox.ts collectReplayable 同口径）。
import type { SqlDriver } from '../driver';

/** outbox 待发条目（字段对齐 outbox.ts OutboxItem，snake_case 落库） */
export interface ApprovalQueueRow {
  /** 本地动作 id（uuid/nextId） */
  id: string;
  /** 幂等键（引擎侧 I-02 校验） */
  toolCallId: string;
  /** 决策（deny 可带 reason） */
  decision: 'approved' | 'denied';
  /** 拒绝理由（仅 deny） */
  reason: string | null;
  /** 命令载荷 runId */
  runId: string | null;
  /** 命令消息 msgId（同 msgId 重发幂等，D3 §8.5） */
  msgId: string;
  /** 三态：pending / sent / failed */
  status: 'pending' | 'sent' | 'failed';
  /** 重试计数 */
  attempts: number;
  /** 最近失败原因 */
  lastError: string | null;
  /** 下次可重放时刻（pending 为 null；failed 由退避表计算） */
  nextRetryAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** approval_queue 表 DAO 接口（对齐 outbox.ts 语义） */
export interface ApprovalQueueDao {
  /**
   * 入队（同幂等键 (tool_call_id, decision) 覆盖，D6 §6.2 重复决策覆盖语义）：
   * 已存在 → 更新该键条目（保持原 id/createdAtMs）；不存在 → 插入。
   */
  upsert(row: ApprovalQueueRow): Promise<'inserted' | 'updated'>;
  /** 按 id 查询 */
  findById(id: string): Promise<ApprovalQueueRow | null>;
  /** 按幂等键查询（同 tool_call_id + decision） */
  findByIdempotencyKey(
    toolCallId: string,
    decision: ApprovalQueueRow['decision']
  ): Promise<ApprovalQueueRow | null>;
  /** 按状态查询（FIFO：created_at_ms 升序） */
  listByStatus(status: ApprovalQueueRow['status']): Promise<ApprovalQueueRow[]>;
  /** 可重放扫描（outbox.ts collectReplayable）：pending 或 failed 且退避到期，按 FIFO */
  listReplayable(nowMs: number): Promise<ApprovalQueueRow[]>;
  /** 状态迁移（markSent / recordFailure 落库）：仅更新指定字段 */
  update(
    id: string,
    patch: Partial<
      Pick<
        ApprovalQueueRow,
        'status' | 'attempts' | 'lastError' | 'nextRetryAtMs' | 'updatedAtMs'
      >
    >
  ): Promise<void>;
  /** 按 id 删除 */
  deleteById(id: string): Promise<void>;
  /** 按 tool_call_id 删除（approval-resolved 确认出队，outbox.ts confirmResolved） */
  deleteByToolCallId(toolCallId: string): Promise<void>;
  /** 条目数（容量上限 OUTBOX_MAX_ITEMS=200 由领域层 outbox.ts 控制，落库前校验） */
  count(): Promise<number>;
  /** 清理：sent 且 updated_at_ms 早于 beforeMs 的条目（M5 §5.5：sent 保留 7 天；pending/failed 恒保留） */
  deleteSentOlderThan(beforeMs: number): Promise<void>;
}

const SELECT_QUEUE = `SELECT id, tool_call_id AS toolCallId, decision, reason, run_id AS runId, msg_id AS msgId, status, attempts, last_error AS lastError, next_retry_at_ms AS nextRetryAtMs, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs FROM approval_queue`;

/** 基于 SqlDriver 的 approval_queue DAO 实现 */
export class SqlApprovalQueueDao implements ApprovalQueueDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsert(row: ApprovalQueueRow): Promise<'inserted' | 'updated'> {
    const existing = await this.driver.getFirst<{ id: string }>(
      'SELECT id FROM approval_queue WHERE tool_call_id = ? AND decision = ?',
      [row.toolCallId, row.decision]
    );
    if (existing !== null) {
      // 覆盖语义（D6 §6.2）：保持原 id 与 createdAtMs，其余换新
      await this.driver.exec(
        `UPDATE approval_queue SET reason = ?, run_id = ?, msg_id = ?, status = ?, attempts = ?, last_error = ?, next_retry_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        [
          row.reason,
          row.runId,
          row.msgId,
          row.status,
          row.attempts,
          row.lastError,
          row.nextRetryAtMs,
          row.updatedAtMs,
          existing.id,
        ]
      );
      return 'updated';
    }
    await this.driver.exec(
      `INSERT INTO approval_queue (id, tool_call_id, decision, reason, run_id, msg_id, status, attempts, last_error, next_retry_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.toolCallId,
        row.decision,
        row.reason,
        row.runId,
        row.msgId,
        row.status,
        row.attempts,
        row.lastError,
        row.nextRetryAtMs,
        row.createdAtMs,
        row.updatedAtMs,
      ]
    );
    return 'inserted';
  }

  async findById(id: string): Promise<ApprovalQueueRow | null> {
    return this.driver.getFirst<ApprovalQueueRow>(
      `${SELECT_QUEUE} WHERE id = ?`,
      [id]
    );
  }

  async findByIdempotencyKey(
    toolCallId: string,
    decision: ApprovalQueueRow['decision']
  ): Promise<ApprovalQueueRow | null> {
    return this.driver.getFirst<ApprovalQueueRow>(
      `${SELECT_QUEUE} WHERE tool_call_id = ? AND decision = ?`,
      [toolCallId, decision]
    );
  }

  async listByStatus(
    status: ApprovalQueueRow['status']
  ): Promise<ApprovalQueueRow[]> {
    return this.driver.getAll<ApprovalQueueRow>(
      `${SELECT_QUEUE} WHERE status = ? ORDER BY created_at_ms ASC`,
      [status]
    );
  }

  async listReplayable(nowMs: number): Promise<ApprovalQueueRow[]> {
    // pending 立即可重放；failed 且退避到期可重放（outbox.ts collectReplayable 同口径）
    return this.driver.getAll<ApprovalQueueRow>(
      `${SELECT_QUEUE} WHERE status = 'pending' OR (status = 'failed' AND next_retry_at_ms <= ?) ORDER BY created_at_ms ASC`,
      [nowMs]
    );
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        ApprovalQueueRow,
        'status' | 'attempts' | 'lastError' | 'nextRetryAtMs' | 'updatedAtMs'
      >
    >
  ): Promise<void> {
    const cols: string[] = [];
    const params: unknown[] = [];
    for (const [col, key] of [
      ['status', 'status'],
      ['attempts', 'attempts'],
      ['last_error', 'lastError'],
      ['next_retry_at_ms', 'nextRetryAtMs'],
      ['updated_at_ms', 'updatedAtMs'],
    ] as const) {
      const v = patch[key];
      if (v !== undefined) {
        cols.push(`${col} = ?`);
        params.push(v);
      }
    }
    if (cols.length === 0) return;
    params.push(id);
    await this.driver.exec(
      `UPDATE approval_queue SET ${cols.join(', ')} WHERE id = ?`,
      params
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.driver.exec('DELETE FROM approval_queue WHERE id = ?', [id]);
  }

  async deleteByToolCallId(toolCallId: string): Promise<void> {
    await this.driver.exec(
      'DELETE FROM approval_queue WHERE tool_call_id = ?',
      [toolCallId]
    );
  }

  async count(): Promise<number> {
    const row = await this.driver.getFirst<{ count: number }>(
      'SELECT COUNT(*) AS count FROM approval_queue'
    );
    return row?.count ?? 0;
  }

  async deleteSentOlderThan(beforeMs: number): Promise<void> {
    await this.driver.exec(
      'DELETE FROM approval_queue WHERE status = ? AND updated_at_ms < ?',
      ['sent', beforeMs]
    );
  }
}
