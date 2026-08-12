// events DAO 测试（M5 §5.2 events 语义：复合主键幂等 / 游标分页 / 会话窗口清理）
import { migrateIfNeeded } from '../db';
import { MemorySqlDriver } from '../driver';
import { SqlEventsDao, type EventRow } from './eventsDao';

function makeEvent(
  sequence: number,
  overrides: Partial<EventRow> = {}
): EventRow {
  return {
    sequence,
    eventId: `e${sequence}`,
    type: 'message',
    sessionId: 's1',
    runId: null,
    timestamp: sequence * 1000,
    payloadJson: JSON.stringify({ seq: sequence }),
    schemaVersion: 1,
    ingestedAt: sequence * 1000,
    ...overrides,
  };
}

async function setup() {
  const db = new MemorySqlDriver();
  await migrateIfNeeded(db);
  return { db, dao: new SqlEventsDao(db) };
}

describe('events DAO：幂等 upsert', () => {
  it('插入新事件；同 (session_id, sequence) 覆盖不产生重复行', async () => {
    const { dao, db } = await setup();
    await dao.upsert(makeEvent(1));
    await dao.upsert(makeEvent(2));
    expect(db.rowCount('events')).toBe(2);
    // 同键覆盖：payload 更新、行数不变
    await dao.upsert(
      makeEvent(2, { payloadJson: '{"seq":2,"v":2}', type: 'tool-start' })
    );
    expect(db.rowCount('events')).toBe(2);
    const row = await dao.latestSequence('s1');
    expect(row).toBe(2);
    const rows = await (await dao.listAfter('s1', 0, 10)).rows;
    expect(rows.find((r) => r.sequence === 2)).toMatchObject({
      type: 'tool-start',
      payloadJson: '{"seq":2,"v":2}',
    });
  });

  it('session_id 为空拒绝写入（复合主键语义）', async () => {
    const { dao } = await setup();
    await expect(dao.upsert(makeEvent(1, { sessionId: null }))).rejects.toThrow(
      'sessionId 不能为空'
    );
  });
});

describe('events DAO：游标分页', () => {
  it('listAfter 按 sequence 升序返回并给出下一页游标', async () => {
    const { dao } = await setup();
    for (let i = 1; i <= 5; i++) await dao.upsert(makeEvent(i));
    const page1 = await dao.listAfter('s1', 0, 2);
    expect(page1.rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(page1.nextCursor).toBe(2); // 游标 = 已应用最大序列
    expect(page1.hasMore).toBe(true);
    const page2 = await dao.listAfter('s1', page1.nextCursor, 2);
    expect(page2.rows.map((r) => r.sequence)).toEqual([3, 4]);
    expect(page2.nextCursor).toBe(4);
    const page3 = await dao.listAfter('s1', page2.nextCursor, 2);
    expect(page3.rows.map((r) => r.sequence)).toEqual([5]);
    expect(page3.hasMore).toBe(false);
  });

  it('空页：nextCursor 保持传入值', async () => {
    const { dao } = await setup();
    const page = await dao.listAfter('s1', 10, 10);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBe(10);
    expect(page.hasMore).toBe(false);
  });

  it('多会话隔离：游标按会话独立', async () => {
    const { dao } = await setup();
    await dao.upsert(makeEvent(1));
    await dao.upsert(makeEvent(1, { sessionId: 's2', eventId: 'x1' }));
    expect(await dao.latestSequence('s1')).toBe(1);
    expect(await dao.latestSequence('s2')).toBe(1);
    expect(await dao.count()).toBe(2);
    expect(await dao.countBySession('s1')).toBe(1);
  });
});

describe('events DAO：会话窗口清理（M5 §5.5）', () => {
  it('deleteOlderThan 删除 sequence < 下界的旧事件', async () => {
    const { dao, db } = await setup();
    for (let i = 1; i <= 10; i++) await dao.upsert(makeEvent(i));
    await dao.deleteOlderThan('s1', 6); // 保留 sequence >= 6
    expect(db.rowCount('events')).toBe(5);
    const remaining = await (await dao.listAfter('s1', 0, 10)).rows;
    expect(remaining.map((r) => r.sequence)).toEqual([6, 7, 8, 9, 10]);
  });

  it('deleteBySession 删除整会话（会话删除级联语义）', async () => {
    const { dao, db } = await setup();
    await dao.upsert(makeEvent(1));
    await dao.upsert(makeEvent(1, { sessionId: 's2', eventId: 'x1' }));
    await dao.deleteBySession('s1');
    expect(db.rowCount('events')).toBe(1);
    expect(await dao.latestSequence('s1')).toBeNull();
  });
});
