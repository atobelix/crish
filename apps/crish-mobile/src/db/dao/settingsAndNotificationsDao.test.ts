// 元数据类 DAO 测试：settings / notifications
import { migrateIfNeeded } from '../db';
import { MemorySqlDriver } from '../driver';
import { SqlSettingsDao } from './settingsDao';
import { SqlNotificationsDao, type NotificationRow } from './notificationsDao';

describe('settings DAO（键值）', () => {
  it('set/get/delete 往返；同 key 覆盖', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlSettingsDao(db);
    expect(await dao.get('k1')).toBeNull();
    await dao.set('k1', 'v1');
    await dao.set('k1', 'v2');
    expect(await dao.get('k1')).toBe('v2');
    await dao.set('cursor:session:s1', '42');
    expect(await dao.getAll()).toHaveLength(2);
    await dao.delete('k1');
    expect(await dao.get('k1')).toBeNull();
  });
});

describe('notifications DAO（M5 §5.2 / D7 §3.4.1 去重）', () => {
  function makeNotification(
    id: string,
    overrides: Partial<NotificationRow> = {}
  ): NotificationRow {
    return {
      id,
      kind: 'approval',
      toolCallId: null,
      runId: null,
      seq: null,
      title: '审批请求',
      body: '工具请求批准',
      route: '/approval/tc1',
      status: 'shown',
      receivedAt: 1000,
      ...overrides,
    };
  }

  it('upsert 幂等（去重键 id）+ 状态迁移', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlNotificationsDao(db);
    await dao.upsert(makeNotification('n1'));
    await dao.upsert(makeNotification('n1', { title: '更新标题' }));
    expect(db.rowCount('notifications')).toBe(1);
    expect((await dao.findById('n1'))?.title).toBe('更新标题');
    await dao.updateStatus('n1', 'resolved');
    const resolved = await dao.listByStatus('resolved');
    expect(resolved.map((r) => r.id)).toEqual(['n1']);
  });

  it('deleteResolvedOlderThan：resolved 超窗删除，其他状态保留（M5 §5.5）', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlNotificationsDao(db);
    await dao.upsert(
      makeNotification('n-old', { status: 'resolved', receivedAt: 100 })
    );
    await dao.upsert(
      makeNotification('n-new', { status: 'resolved', receivedAt: 9000 })
    );
    await dao.upsert(
      makeNotification('n-shown', { status: 'shown', receivedAt: 100 })
    );
    await dao.deleteResolvedOlderThan(5000);
    expect(db.rowCount('notifications')).toBe(2);
    expect(await dao.findById('n-old')).toBeNull();
  });

  it('count：空表为 0；写入后统计条数', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlNotificationsDao(db);
    expect(await dao.count()).toBe(0);
    await dao.upsert(makeNotification('n-1'));
    await dao.upsert(makeNotification('n-2'));
    expect(await dao.count()).toBe(2);
  });

  it('deleteById 删除单条', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlNotificationsDao(db);
    await dao.upsert(makeNotification('n-1'));
    await dao.deleteById('n-1');
    expect(await dao.count()).toBe(0);
    expect(await dao.findById('n-1')).toBeNull();
  });
});
