// 元数据类 DAO 测试：session_summaries / settings / push_tokens / device_info / notifications
import { migrateIfNeeded } from '../db';
import { MemorySqlDriver } from '../driver';
import {
  SqlSessionSummariesDao,
  type SessionSummaryRow,
} from './sessionSummariesDao';
import { SqlSettingsDao } from './settingsDao';
import { SqlPushTokensDao, type PushTokenRow } from './pushTokensDao';
import { SqlDeviceInfoDao, type DeviceInfoRow } from './deviceInfoDao';
import { SqlNotificationsDao, type NotificationRow } from './notificationsDao';

function makeSession(sessionId: string, updatedAt: number): SessionSummaryRow {
  return {
    sessionId,
    title: `会话 ${sessionId}`,
    cwd: '/workspace',
    status: 'open',
    isPinned: 0,
    isArchived: 0,
    messageCount: 0,
    engineCursor: 0,
    engineLastRunId: null,
    updatedAt,
    lastMessagePreview: null,
    metadataJson: null,
  };
}

describe('session_summaries DAO', () => {
  it('upsert 幂等 + listRecent 按 updated_at 降序', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlSessionSummariesDao(db);
    await dao.upsert(makeSession('s1', 1000));
    await dao.upsert(makeSession('s2', 3000));
    await dao.upsert(makeSession('s3', 2000));
    expect(db.rowCount('session_summaries')).toBe(3);
    // 覆盖更新
    await dao.upsert({ ...makeSession('s1', 9000), title: '改标题' });
    expect(db.rowCount('session_summaries')).toBe(3);
    const recent = await dao.listRecent(2);
    expect(recent.map((r) => r.sessionId)).toEqual(['s1', 's2']);
    expect((await dao.findById('s1'))?.title).toBe('改标题');
  });

  it('deleteById + count', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlSessionSummariesDao(db);
    await dao.upsert(makeSession('s1', 1000));
    await dao.upsert(makeSession('s2', 2000));
    await dao.deleteById('s1');
    expect(await dao.count()).toBe(1);
    expect(await dao.findById('s1')).toBeNull();
  });
});

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

describe('push_tokens DAO（D7 §8.1 推送注册）', () => {
  function makeToken(platform: 'android' | 'ios' = 'android'): PushTokenRow {
    return {
      platform,
      vendor: 'hms',
      token: `token-${platform}`,
      updatedAt: 1000,
    };
  }

  it('upsert 按 platform 覆盖 + 查询 + 删除', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlPushTokensDao(db);
    await dao.upsert(makeToken('android'));
    await dao.upsert(makeToken('ios'));
    expect(await dao.listAll()).toHaveLength(2);
    await dao.upsert({ ...makeToken('android'), token: 'token-android-v2' });
    expect(await dao.listAll()).toHaveLength(2);
    expect((await dao.getByPlatform('android'))?.token).toBe(
      'token-android-v2'
    );
    await dao.deleteByPlatform('ios');
    expect(await dao.getByPlatform('ios')).toBeNull();
  });
});

describe('device_info DAO（M5 §5.2 device_meta）', () => {
  function makeDevice(): DeviceInfoRow {
    return {
      deviceId: 'dev-1',
      desktopId: 'desktop-1',
      deviceName: '我的手机',
      pairedAt: 1000,
      hostUrl: 'wss://192.168.1.5:8765',
      certFingerprintTail: 'ABCD1234',
      contractVersion: '1.0.0',
    };
  }

  it('upsert/get/delete；重新配对覆盖桌面信息', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlDeviceInfoDao(db);
    expect(await dao.get()).toBeNull();
    await dao.upsert(makeDevice());
    expect((await dao.get())?.deviceName).toBe('我的手机');
    await dao.upsert({ ...makeDevice(), desktopId: 'desktop-2' });
    expect((await dao.get())?.desktopId).toBe('desktop-2');
    expect(db.rowCount('device_info')).toBe(1);
    await dao.delete();
    expect(await dao.get()).toBeNull();
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
});
