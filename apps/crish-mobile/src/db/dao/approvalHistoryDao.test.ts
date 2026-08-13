// approval_history DAO 单测（审批决策记录，D6 §3.4 派生视图哲学）：
// 幂等写入（同 tool_call_id 覆盖）/ 待办视图（pending 升序）/ 决策历史（decided_at 降序 + limit）/
// 非待办态超窗清理（pending/deciding/queued 恒保留）/ 计数。
import { migrateIfNeeded } from '../db';
import { MemorySqlDriver } from '../driver';
import {
  SqlApprovalHistoryDao,
  type ApprovalHistoryRow,
} from './approvalHistoryDao';

function makeRow(
  toolCallId: string,
  overrides: Partial<ApprovalHistoryRow> = {}
): ApprovalHistoryRow {
  return {
    toolCallId,
    sessionId: 's-1',
    runId: 'r-1',
    toolName: 'write_file',
    summary: '写入文件',
    arbiter: 'user',
    dangerLevel: 1,
    status: 'pending',
    decision: null,
    requestJson: '{"toolCallId":"' + toolCallId + '"}',
    riskMetaJson: null,
    requestedAt: 1000,
    decidedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe('approval_history DAO（M5 §5.2 approvals / D6 §3.4）', () => {
  it('upsert 插入返回 inserted；同 tool_call_id 覆盖返回 updated（状态收敛更新）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    expect(await dao.upsert(makeRow('call-1'))).toBe('inserted');
    expect(
      await dao.upsert(
        makeRow('call-1', {
          status: 'approved',
          decision: 'approved',
          decidedAt: 2000,
        })
      )
    ).toBe('updated');
    expect(db.rowCount('approval_history')).toBe(1);
    const row = await dao.findById('call-1');
    expect(row?.status).toBe('approved');
    expect(row?.decision).toBe('approved');
  });

  it('findById 不存在返回 null；字段别名映射完整（snake_case → camelCase）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    expect(await dao.findById('ghost')).toBeNull();
    await dao.upsert(makeRow('call-1'));
    const row = await dao.findById('call-1');
    expect(row).toMatchObject({
      toolCallId: 'call-1',
      sessionId: 's-1',
      toolName: 'write_file',
      dangerLevel: 1,
      requestJson: '{"toolCallId":"call-1"}',
      requestedAt: 1000,
    });
  });

  it('listPending 仅 pending 且按 requested_at 升序（F2 §6.3 待办角标数据面）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(makeRow('call-1', { requestedAt: 3000 }));
    await dao.upsert(
      makeRow('call-2', { requestedAt: 1000, status: 'queued' })
    );
    await dao.upsert(makeRow('call-3', { requestedAt: 2000 }));
    const pending = await dao.listPending();
    expect(pending.map((r) => r.toolCallId)).toEqual(['call-3', 'call-1']);
  });

  it('listDecided 排除 pending 按 decided_at 降序 + LIMIT', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(
      makeRow('call-1', {
        status: 'approved',
        decision: 'approved',
        decidedAt: 1000,
      })
    );
    await dao.upsert(
      makeRow('call-2', { status: 'expired', decision: null, decidedAt: 3000 })
    );
    await dao.upsert(makeRow('call-3', { status: 'pending' }));
    const decided = await dao.listDecided(10);
    expect(decided.map((r) => r.toolCallId)).toEqual(['call-2', 'call-1']);
    expect(await dao.listDecided(1)).toHaveLength(1);
  });

  it('deleteById / count', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(makeRow('call-1'));
    await dao.upsert(makeRow('call-2'));
    expect(await dao.count()).toBe(2);
    await dao.deleteById('call-1');
    expect(await dao.count()).toBe(1);
    expect(await dao.findById('call-1')).toBeNull();
  });

  it('deleteDecidedOlderThan：非待办态超窗删除；pending/deciding/queued 恒保留（M5 §5.5）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(
      makeRow('call-old', { status: 'approved', decidedAt: 100 })
    );
    await dao.upsert(
      makeRow('call-new', { status: 'denied', decidedAt: 9000 })
    );
    await dao.upsert(makeRow('call-pending', { status: 'pending' }));
    await dao.upsert(makeRow('call-deciding', { status: 'deciding' }));
    await dao.upsert(makeRow('call-queued', { status: 'queued' }));
    await dao.deleteDecidedOlderThan(5000);
    expect(db.rowCount('approval_history')).toBe(4);
    expect(await dao.findById('call-old')).toBeNull();
  });
});
