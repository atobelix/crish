// approval_queue / approval_history DAO 测试
// 语义对齐：D6 §6.2 幂等覆盖 / outbox.ts 三态重放 / M5 §5.5 清理窗口
import { migrateIfNeeded } from '../db';
import { MemorySqlDriver } from '../driver';
import { SqlApprovalQueueDao, type ApprovalQueueRow } from './approvalQueueDao';
import {
  SqlApprovalHistoryDao,
  type ApprovalHistoryRow,
} from './approvalHistoryDao';

function makeQueueRow(
  id: string,
  overrides: Partial<ApprovalQueueRow> = {}
): ApprovalQueueRow {
  return {
    id,
    toolCallId: `tc-${id}`,
    decision: 'approved',
    reason: null,
    runId: null,
    msgId: `m-${id}`,
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRetryAtMs: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

async function setup() {
  const db = new MemorySqlDriver();
  await migrateIfNeeded(db);
  return { db, dao: new SqlApprovalQueueDao(db) };
}

describe('approval_queue DAO：幂等键覆盖（D6 §6.2）', () => {
  it('同 (tool_call_id, decision) 入队覆盖旧条目，保持原 id', async () => {
    const { dao, db } = await setup();
    await dao.upsert(
      makeQueueRow('q1', { msgId: 'm-old', attempts: 3, status: 'failed' })
    );
    const updated = await dao.upsert(
      makeQueueRow('q2', { toolCallId: 'tc-q1', msgId: 'm-new' })
    );
    expect(updated).toBe('updated');
    expect(db.rowCount('approval_queue')).toBe(1);
    const row = await dao.findById('q1');
    expect(row?.msgId).toBe('m-new');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
  });

  it('不同 decision 视为不同键（可同 tool_call_id 并存 pending 与 sent 恢复态）', async () => {
    const { dao, db } = await setup();
    await dao.upsert(makeQueueRow('q1', { toolCallId: 'tc1' }));
    await dao.upsert(
      makeQueueRow('q2', { toolCallId: 'tc1', decision: 'denied' })
    );
    expect(db.rowCount('approval_queue')).toBe(2);
  });

  it('upsert 返回值：inserted / updated', async () => {
    const { dao } = await setup();
    expect(await dao.upsert(makeQueueRow('q1'))).toBe('inserted');
    expect(await dao.upsert(makeQueueRow('q2', { toolCallId: 'tc-q1' }))).toBe(
      'updated'
    );
  });
});

describe('approval_queue DAO：三态与重放扫描（outbox.ts 同口径）', () => {
  it('listReplayable：pending 立即重放 + failed 到期重放 + FIFO 排序', async () => {
    const { dao } = await setup();
    await dao.upsert(
      makeQueueRow('q1', {
        status: 'failed',
        nextRetryAtMs: 2000,
        createdAtMs: 3000,
      })
    );
    await dao.upsert(
      makeQueueRow('q2', { status: 'pending', createdAtMs: 1000 })
    );
    await dao.upsert(
      makeQueueRow('q3', {
        status: 'failed',
        nextRetryAtMs: 5000,
        createdAtMs: 2000,
      })
    );
    await dao.upsert(makeQueueRow('q4', { status: 'sent', createdAtMs: 500 }));
    const replayable = await dao.listReplayable(4000);
    expect(replayable.map((r) => r.id)).toEqual(['q2', 'q1']); // pending 先、failed 到期后，FIFO
  });

  it('update 状态迁移（markSent / recordFailure 落库形态）', async () => {
    const { dao } = await setup();
    await dao.upsert(makeQueueRow('q1'));
    await dao.update('q1', { status: 'sent', attempts: 1, updatedAtMs: 2000 });
    const sent = await dao.findById('q1');
    expect(sent).toMatchObject({
      status: 'sent',
      attempts: 1,
      updatedAtMs: 2000,
    });
    await dao.update('q1', {
      status: 'failed',
      lastError: 'timeout',
      nextRetryAtMs: 3000,
    });
    const failed = await dao.findById('q1');
    expect(failed).toMatchObject({
      status: 'failed',
      lastError: 'timeout',
      nextRetryAtMs: 3000,
    });
  });

  it('deleteByToolCallId：approval-resolved 确认出队（confirmResolved 语义）', async () => {
    const { dao, db } = await setup();
    await dao.upsert(makeQueueRow('q1', { toolCallId: 'tcX' }));
    await dao.upsert(makeQueueRow('q2', { toolCallId: 'tcY' }));
    await dao.deleteByToolCallId('tcX');
    expect(db.rowCount('approval_queue')).toBe(1);
  });

  it('deleteSentOlderThan：sent 超窗删除，pending/failed 恒保留（M5 §5.5）', async () => {
    const { dao, db } = await setup();
    await dao.upsert(makeQueueRow('q1', { status: 'sent', updatedAtMs: 100 }));
    await dao.upsert(
      makeQueueRow('q2', { status: 'pending', updatedAtMs: 100 })
    );
    await dao.upsert(
      makeQueueRow('q3', { status: 'failed', updatedAtMs: 100 })
    );
    await dao.deleteSentOlderThan(1000);
    expect(db.rowCount('approval_queue')).toBe(2); // q2/q3 保留
    expect(await dao.findById('q1')).toBeNull();
  });
});

describe('approval_history DAO', () => {
  function makeHistoryRow(
    toolCallId: string,
    overrides: Partial<ApprovalHistoryRow> = {}
  ): ApprovalHistoryRow {
    return {
      toolCallId,
      sessionId: 's1',
      runId: 'r1',
      toolName: 'runTask',
      summary: '执行任务',
      arbiter: 'user',
      dangerLevel: 1,
      status: 'pending',
      decision: null,
      requestJson: '{}',
      riskMetaJson: null,
      requestedAt: 1000,
      decidedAt: null,
      expiresAt: 121000,
      ...overrides,
    };
  }

  it('upsert 幂等：同 tool_call_id 覆盖（approval-resolved 更新状态）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(makeHistoryRow('tc1'));
    const updated = await dao.upsert(
      makeHistoryRow('tc1', {
        status: 'approved',
        decision: 'approved',
        decidedAt: 5000,
      })
    );
    expect(updated).toBe('updated');
    expect(db.rowCount('approval_history')).toBe(1);
    const row = await dao.findById('tc1');
    expect(row).toMatchObject({
      status: 'approved',
      decision: 'approved',
      decidedAt: 5000,
    });
  });

  it('listPending 按 requested_at 升序（待办角标查询）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(makeHistoryRow('tc2', { requestedAt: 3000 }));
    await dao.upsert(makeHistoryRow('tc1', { requestedAt: 1000 }));
    const pending = await dao.listPending();
    expect(pending.map((r) => r.toolCallId)).toEqual(['tc1', 'tc2']);
  });

  it('listDecided 按 decided_at 降序，排除 pending', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(
      makeHistoryRow('tc1', {
        status: 'approved',
        decision: 'approved',
        decidedAt: 1000,
      })
    );
    await dao.upsert(
      makeHistoryRow('tc2', {
        status: 'denied',
        decision: 'denied',
        decidedAt: 3000,
      })
    );
    await dao.upsert(makeHistoryRow('tc3', { status: 'pending' }));
    const decided = await dao.listDecided(10);
    expect(decided.map((r) => r.toolCallId)).toEqual(['tc2', 'tc1']);
  });

  it('deleteDecidedOlderThan：非待办态超窗删除，pending 恒保留（M5 §5.5）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalHistoryDao(db);
    await dao.upsert(
      makeHistoryRow('tc-old', { status: 'expired', decidedAt: 100 })
    );
    await dao.upsert(
      makeHistoryRow('tc-new', {
        status: 'approved',
        decision: 'approved',
        decidedAt: 9000,
      })
    );
    await dao.upsert(makeHistoryRow('tc-pending', { status: 'pending' }));
    await dao.deleteDecidedOlderThan(5000);
    expect(db.rowCount('approval_history')).toBe(2); // tc-new + tc-pending
    expect(await dao.findById('tc-old')).toBeNull();
  });
});
