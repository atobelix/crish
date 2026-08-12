// approval_history DAO（审批决策记录：M5 §5.2 approvals；D6 §3.4 派生视图哲学）
// 哲学（D6 §3.4）：审批待办是 events 表白名单事件（approval-requested）的派生视图，
// 本表只保存「决策记录」（已决/过期/冲突等收敛结果），pending 恒保留（F2 待办角标可查）。
import type { SqlDriver } from '../driver';

/** 审批决策记录行（字段对齐 M5 §5.2 approvals） */
export interface ApprovalHistoryRow {
  /** 幂等键（引擎 toolCallId） */
  toolCallId: string;
  sessionId: string | null;
  runId: string | null;
  /** 工具名（PermissionRequest.toolName） */
  toolName: string;
  /** 审批摘要（工具参数摘要） */
  summary: string | null;
  /** 仲裁者：user | main-agent */
  arbiter: 'user' | 'main-agent';
  /** 危险等级 1|2 */
  dangerLevel: 1 | 2;
  /** 状态：pending|deciding|queued|approved|denied|expired|superseded|conflict */
  status: string;
  /** 收敛后的决策值（approved | denied） */
  decision: 'approved' | 'denied' | null;
  /** 完整 PermissionRequest JSON（宽容存储） */
  requestJson: string;
  /** 本地推导 riskMeta JSON（F2 §3.3） */
  riskMetaJson: string | null;
  /** 收到时刻（毫秒） */
  requestedAt: number;
  /** 决策时刻（毫秒） */
  decidedAt: number | null;
  /** 本地倒计时时刻（requestedAt + 120s，F2 §8.3） */
  expiresAt: number | null;
}

/** approval_history 表 DAO 接口 */
export interface ApprovalHistoryDao {
  /** 幂等写入：同 tool_call_id 覆盖（approval-resolved 到达即更新状态，D4 §7.5） */
  upsert(row: ApprovalHistoryRow): Promise<'inserted' | 'updated'>;
  /** 按幂等键查询 */
  findById(toolCallId: string): Promise<ApprovalHistoryRow | null>;
  /** 待办视图（pending 角标查询，F2 §6.3）：status='pending' 按 requested_at 升序 */
  listPending(): Promise<ApprovalHistoryRow[]>;
  /** 决策历史（已决记录）：按 decided_at 降序，最多 limit 条 */
  listDecided(limit: number): Promise<ApprovalHistoryRow[]>;
  /** 删除单条 */
  deleteById(toolCallId: string): Promise<void>;
  /**
   * 清理（M5 §5.5：已决/过期条目保留 30 天，pending 恒保留）：
   * 删除 status 非待办态（非 pending/deciding/queued）且 decided_at 早于 beforeMs 的条目。
   */
  deleteDecidedOlderThan(beforeMs: number): Promise<void>;
  /** 全部条数 */
  count(): Promise<number>;
}

const SELECT_HISTORY = `SELECT tool_call_id AS toolCallId, session_id AS sessionId, run_id AS runId, tool_name AS toolName, summary, arbiter, danger_level AS dangerLevel, status, decision, request_json AS requestJson, risk_meta_json AS riskMetaJson, requested_at AS requestedAt, decided_at AS decidedAt, expires_at AS expiresAt FROM approval_history`;

/** 基于 SqlDriver 的 approval_history DAO 实现 */
export class SqlApprovalHistoryDao implements ApprovalHistoryDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsert(row: ApprovalHistoryRow): Promise<'inserted' | 'updated'> {
    const existing = await this.driver.getFirst<{ tool_call_id: string }>(
      'SELECT tool_call_id FROM approval_history WHERE tool_call_id = ?',
      [row.toolCallId]
    );
    if (existing !== null) {
      await this.driver.exec(
        `UPDATE approval_history SET session_id = ?, run_id = ?, tool_name = ?, summary = ?, arbiter = ?, danger_level = ?, status = ?, decision = ?, request_json = ?, risk_meta_json = ?, requested_at = ?, decided_at = ?, expires_at = ? WHERE tool_call_id = ?`,
        [
          row.sessionId,
          row.runId,
          row.toolName,
          row.summary,
          row.arbiter,
          row.dangerLevel,
          row.status,
          row.decision,
          row.requestJson,
          row.riskMetaJson,
          row.requestedAt,
          row.decidedAt,
          row.expiresAt,
          row.toolCallId,
        ]
      );
      return 'updated';
    }
    await this.driver.exec(
      `INSERT INTO approval_history (tool_call_id, session_id, run_id, tool_name, summary, arbiter, danger_level, status, decision, request_json, risk_meta_json, requested_at, decided_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.toolCallId,
        row.sessionId,
        row.runId,
        row.toolName,
        row.summary,
        row.arbiter,
        row.dangerLevel,
        row.status,
        row.decision,
        row.requestJson,
        row.riskMetaJson,
        row.requestedAt,
        row.decidedAt,
        row.expiresAt,
      ]
    );
    return 'inserted';
  }

  async findById(toolCallId: string): Promise<ApprovalHistoryRow | null> {
    return this.driver.getFirst<ApprovalHistoryRow>(
      `${SELECT_HISTORY} WHERE tool_call_id = ?`,
      [toolCallId]
    );
  }

  async listPending(): Promise<ApprovalHistoryRow[]> {
    return this.driver.getAll<ApprovalHistoryRow>(
      `${SELECT_HISTORY} WHERE status = 'pending' ORDER BY requested_at ASC`
    );
  }

  async listDecided(limit: number): Promise<ApprovalHistoryRow[]> {
    return this.driver.getAll<ApprovalHistoryRow>(
      `${SELECT_HISTORY} WHERE status != 'pending' ORDER BY decided_at DESC LIMIT ?`,
      [limit]
    );
  }

  async deleteById(toolCallId: string): Promise<void> {
    await this.driver.exec(
      'DELETE FROM approval_history WHERE tool_call_id = ?',
      [toolCallId]
    );
  }

  async deleteDecidedOlderThan(beforeMs: number): Promise<void> {
    // pending/deciding/queued 恒保留（M5 §5.5）；非待办态且 decided_at 超窗删除
    await this.driver.exec(
      `DELETE FROM approval_history WHERE status NOT IN ('pending', 'deciding', 'queued') AND decided_at < ?`,
      [beforeMs]
    );
  }

  async count(): Promise<number> {
    const row = await this.driver.getFirst<{ count: number }>(
      'SELECT COUNT(*) AS count FROM approval_history'
    );
    return row?.count ?? 0;
  }
}
