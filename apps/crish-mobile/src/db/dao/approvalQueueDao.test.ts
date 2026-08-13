// approval_queue DAO 单测（outbox 待发队列，字段对齐 outbox.ts OutboxItem）：
// 幂等键 (tool_call_id, decision) 覆盖入队 / 三态查询 / 可重放扫描（pending + 退避到期 failed）/
// 状态迁移 patch（含空 patch 短路）/ 幂等键删除 / 计数 / sent 超窗清理。
import { migrateIfNeeded } from '../db';
import { MemorySqlDriver } from '../driver';
import { SqlApprovalQueueDao, type ApprovalQueueRow } from './approvalQueueDao';

function makeRow(overrides: Partial<ApprovalQueueRow> = {}): ApprovalQueueRow {
  return {
    id: 'q-1',
    toolCallId: 'call-1',
    decision: 'approved',
    reason: null,
    runId: 'r-1',
    msgId: 'm-1',
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRetryAtMs: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

describe('approval_queue DAO（D6 §6.2-6.3 / M5 §4.6）', () => {
  it('upsert 插入新键返回 inserted；同幂等键覆盖返回 updated（保持原 id）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    expect(await dao.upsert(makeRow())).toBe('inserted');
    expect(await dao.upsert(makeRow({ msgId: 'm-2', status: 'failed' }))).toBe(
      'updated'
    );
    expect(db.rowCount('approval_queue')).toBe(1);
    const row = await dao.findById('q-1');
    expect(row?.msgId).toBe('m-2');
    expect(row?.status).toBe('failed');
  });

  it('同 tool_call_id 不同 decision 视为不同幂等键（各占一行）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(makeRow({ id: 'q-a', decision: 'approved' }));
    await dao.upsert(makeRow({ id: 'q-d', decision: 'denied' }));
    expect(db.rowCount('approval_queue')).toBe(2);
  });

  it('findByIdempotencyKey / listByStatus（FIFO 按 created_at_ms 升序）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(
      makeRow({
        id: 'q-1',
        toolCallId: 'call-1',
        status: 'pending',
        createdAtMs: 3000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-2',
        toolCallId: 'call-2',
        status: 'pending',
        createdAtMs: 1000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-3',
        toolCallId: 'call-3',
        status: 'sent',
        createdAtMs: 2000,
      })
    );
    const byKey = await dao.findByIdempotencyKey('call-1', 'approved');
    expect(byKey?.id).toBe('q-1');
    const pending = await dao.listByStatus('pending');
    expect(pending.map((r) => r.id)).toEqual(['q-2', 'q-1']);
    const sent = await dao.listByStatus('sent');
    expect(sent.map((r) => r.id)).toEqual(['q-3']);
  });

  it('listReplayable：pending 立即可重放 + failed 退避到期可重放，按 FIFO', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(
      makeRow({
        id: 'q-1',
        toolCallId: 'call-1',
        status: 'pending',
        createdAtMs: 1000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-2',
        toolCallId: 'call-2',
        status: 'failed',
        nextRetryAtMs: 5000,
        createdAtMs: 2000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-3',
        toolCallId: 'call-3',
        status: 'failed',
        nextRetryAtMs: 9000,
        createdAtMs: 3000,
      })
    );
    // nowMs=6000：q-1（pending）+ q-2（退避已到期）；q-3 未到期不重放
    const replayable = await dao.listReplayable(6000);
    expect(replayable.map((r) => r.id)).toEqual(['q-1', 'q-2']);
  });

  it('update 仅更新指定字段（markSent / recordFailure 落库面）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(makeRow());
    await dao.update('q-1', {
      status: 'failed',
      attempts: 1,
      lastError: 'timeout',
      nextRetryAtMs: 60000,
      updatedAtMs: 2000,
    });
    const row = await dao.findById('q-1');
    expect(row).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'timeout',
      nextRetryAtMs: 60000,
      updatedAtMs: 2000,
    });
    expect(row?.msgId).toBe('m-1'); // 未更新字段保留
  });

  it('update 空 patch 短路（无 SQL 执行，不抛错）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(makeRow());
    await expect(dao.update('q-1', {})).resolves.toBeUndefined();
    expect((await dao.findById('q-1'))?.status).toBe('pending');
  });

  it('deleteById / deleteByToolCallId（approval-resolved 确认出队）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(makeRow({ id: 'q-1', toolCallId: 'call-1' }));
    await dao.upsert(
      makeRow({ id: 'q-2', toolCallId: 'call-1', decision: 'denied' })
    );
    await dao.deleteByToolCallId('call-1');
    expect(db.rowCount('approval_queue')).toBe(0);
    await dao.upsert(makeRow({ id: 'q-1' }));
    await dao.deleteById('q-1');
    expect(await dao.count()).toBe(0);
  });

  it('count 统计；空表为 0', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    expect(await dao.count()).toBe(0);
    await dao.upsert(makeRow());
    await dao.upsert(makeRow({ id: 'q-2', toolCallId: 'call-2' }));
    expect(await dao.count()).toBe(2);
  });

  it('deleteSentOlderThan：sent 超窗删除；pending/failed 恒保留（M5 §5.5）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlApprovalQueueDao(db);
    await dao.upsert(
      makeRow({
        id: 'q-1',
        toolCallId: 'call-1',
        status: 'sent',
        updatedAtMs: 1000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-2',
        toolCallId: 'call-2',
        status: 'sent',
        updatedAtMs: 9000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-3',
        toolCallId: 'call-3',
        status: 'pending',
        updatedAtMs: 1000,
      })
    );
    await dao.upsert(
      makeRow({
        id: 'q-4',
        toolCallId: 'call-4',
        status: 'failed',
        updatedAtMs: 1000,
      })
    );
    await dao.deleteSentOlderThan(5000);
    expect(db.rowCount('approval_queue')).toBe(3);
    expect(await dao.findById('q-1')).toBeNull();
  });
});
