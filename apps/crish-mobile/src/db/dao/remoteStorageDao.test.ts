// 远程存储 DAO 与 v7 迁移专项单元测试
import { MemorySqlDriver } from '../driver';
import { migrateIfNeeded } from '../db';
import { SCHEMA_VERSION } from '../schema';
import { SqlRemoteSessionDao, type RemoteSessionRow } from './remoteSessionDao';
import { SqlRemoteEventDao, type RemoteEventRow } from './remoteEventDao';
import { SqlRemoteSyncDao } from './remoteSyncDao';

describe('远程控制本地持久化 DAO 与 v7 数据库架构测试', () => {
  let driver: MemorySqlDriver;
  let sessionDao: SqlRemoteSessionDao;
  let eventDao: SqlRemoteEventDao;
  let syncDao: SqlRemoteSyncDao;

  beforeEach(async () => {
    driver = new MemorySqlDriver();
    const ver = await migrateIfNeeded(driver);
    expect(ver).toBe(SCHEMA_VERSION);
    sessionDao = new SqlRemoteSessionDao(driver);
    eventDao = new SqlRemoteEventDao(driver);
    syncDao = new SqlRemoteSyncDao(driver);
  });

  describe('SqlRemoteSessionDao 会话元数据持久化', () => {
    const s1: RemoteSessionRow = {
      deviceId: 'dev_1',
      sessionId: 'sess_1',
      title: '排查线上性能问题',
      cwd: '/workspace/app',
      model: 'claude-3-5-sonnet',
      updatedAt: 1000,
      isPinned: false,
      isArchived: false,
      createdAt: 500,
    };

    const s2: RemoteSessionRow = {
      deviceId: 'dev_1',
      sessionId: 'sess_2',
      title: '重构前端架构',
      cwd: '/workspace/web',
      model: 'gpt-4o',
      updatedAt: 2000,
      isPinned: true, // 置顶
      isArchived: false,
      createdAt: 600,
    };

    const sOtherDevice: RemoteSessionRow = {
      deviceId: 'dev_2',
      sessionId: 'sess_3',
      title: '其它设备会话',
      cwd: '/root',
      model: 'qwen',
      updatedAt: 3000,
      isPinned: false,
      isArchived: false,
      createdAt: 700,
    };

    it('单条与批量保存，并能正确读取', async () => {
      await sessionDao.upsertSession(s1);
      const read1 = await sessionDao.getSession('dev_1', 'sess_1');
      expect(read1).toEqual(s1);

      await sessionDao.upsertSessions([s2, sOtherDevice]);
      const read2 = await sessionDao.getSession('dev_1', 'sess_2');
      expect(read2).toEqual(s2);

      // 设备隔离：dev_1 查不到 dev_2 的会话
      const notFound = await sessionDao.getSession('dev_1', 'sess_3');
      expect(notFound).toBeNull();
    });

    it('列表排序严格保持：置顶优先，updatedAt 倒序', async () => {
      await sessionDao.upsertSessions([s1, s2]);
      const list = await sessionDao.listSessions('dev_1');
      expect(list).toHaveLength(2);
      // s2 是 pinned，排在最前
      expect(list[0]?.sessionId).toBe('sess_2');
      expect(list[1]?.sessionId).toBe('sess_1');
    });

    it('删除单个会话与清空设备数据', async () => {
      await sessionDao.upsertSessions([s1, s2, sOtherDevice]);
      await sessionDao.deleteSession('dev_1', 'sess_1');
      const listAfterDelete = await sessionDao.listSessions('dev_1');
      expect(listAfterDelete).toHaveLength(1);
      expect(listAfterDelete[0]?.sessionId).toBe('sess_2');

      // 清空 dev_1
      await sessionDao.deleteDeviceSessions('dev_1');
      expect(await sessionDao.listSessions('dev_1')).toHaveLength(0);
      // dev_2 保持完好
      expect(await sessionDao.listSessions('dev_2')).toHaveLength(1);
    });
  });

  describe('SqlRemoteEventDao 事件信封持久化', () => {
    const makeEvents = (
      deviceId: string,
      sessionId: string,
      fromSeq: number,
      toSeq: number
    ): RemoteEventRow[] => {
      const rows: RemoteEventRow[] = [];
      for (let seq = fromSeq; seq <= toSeq; seq++) {
        rows.push({
          deviceId,
          sessionId,
          sequence: seq,
          kind: 'agent-event',
          eventType: seq % 2 === 0 ? 'text-chunk' : 'tool-call',
          receivedAtMs: 1000 + seq * 10,
          rawPayload: JSON.stringify({ seq, data: `event-content-${seq}` }),
        });
      }
      return rows;
    };

    it('批量插入事件信封并按 sequence 升序读取最新 N 条（秒开）', async () => {
      const events = makeEvents('dev_1', 'sess_1', 1, 50);
      await eventDao.insertEvents(events);

      // 读取最新 10 条（应当是 seq 41..50，且按 sequence ASC 升序排列）
      const recent10 = await eventDao.getRecentEvents('dev_1', 'sess_1', 10);
      expect(recent10).toHaveLength(10);
      expect(recent10[0]?.sequence).toBe(41);
      expect(recent10[9]?.sequence).toBe(50);
      expect(JSON.parse(recent10[9]?.rawPayload ?? '{}')).toEqual({
        seq: 50,
        data: 'event-content-50',
      });
    });

    it('向上分页读取更早历史事件（getEventsBefore）', async () => {
      const events = makeEvents('dev_1', 'sess_1', 1, 50);
      await eventDao.insertEvents(events);

      // 翻页加载 seq < 41 的前 10 条历史（应当是 31..40，且按 sequence ASC 升序排列）
      const earlier = await eventDao.getEventsBefore('dev_1', 'sess_1', 41, 10);
      expect(earlier).toHaveLength(10);
      expect(earlier[0]?.sequence).toBe(31);
      expect(earlier[9]?.sequence).toBe(40);
    });

    it('准确计算本地最大 sequence', async () => {
      expect(await eventDao.getLatestSequence('dev_1', 'sess_1')).toBe(0);

      await eventDao.insertEvents(makeEvents('dev_1', 'sess_1', 1, 25));
      expect(await eventDao.getLatestSequence('dev_1', 'sess_1')).toBe(25);

      await eventDao.insertEvents(makeEvents('dev_1', 'sess_1', 26, 68));
      expect(await eventDao.getLatestSequence('dev_1', 'sess_1')).toBe(68);
    });

    it('会话级与设备级事件删除', async () => {
      await eventDao.insertEvents(makeEvents('dev_1', 'sess_1', 1, 5));
      await eventDao.insertEvents(makeEvents('dev_1', 'sess_2', 1, 5));
      await eventDao.insertEvents(makeEvents('dev_2', 'sess_3', 1, 5));

      await eventDao.deleteSessionEvents('dev_1', 'sess_1');
      expect(await eventDao.getRecentEvents('dev_1', 'sess_1')).toHaveLength(0);
      expect(await eventDao.getRecentEvents('dev_1', 'sess_2')).toHaveLength(5);

      await eventDao.deleteDeviceEvents('dev_1');
      expect(await eventDao.getRecentEvents('dev_1', 'sess_2')).toHaveLength(0);
      expect(await eventDao.getRecentEvents('dev_2', 'sess_3')).toHaveLength(5);
    });
  });

  describe('SqlRemoteSyncDao 增量游标与同步状态', () => {
    it('游标更新与查询', async () => {
      expect(await syncDao.getLastSyncedSequence('dev_1', 'sess_1')).toBe(0);
      expect(await syncDao.getSyncState('dev_1', 'sess_1')).toBeNull();

      await syncDao.updateSyncState('dev_1', 'sess_1', 120, false, 9999);
      const state = await syncDao.getSyncState('dev_1', 'sess_1');
      expect(state).toEqual({
        deviceId: 'dev_1',
        sessionId: 'sess_1',
        lastSyncedSequence: 120,
        hasMoreHistory: false,
        updatedAt: 9999,
      });

      expect(await syncDao.getLastSyncedSequence('dev_1', 'sess_1')).toBe(120);
    });

    it('getAllLatestSequences 导出全部游标用于 events.subscribe 批量对账', async () => {
      await syncDao.updateSyncState('dev_1', 's1', 10);
      await syncDao.updateSyncState('dev_1', 's2', 25);
      await syncDao.updateSyncState('dev_2', 's3', 50);

      const dev1Cursors = await syncDao.getAllLatestSequences('dev_1');
      expect(dev1Cursors).toEqual({
        s1: 10,
        s2: 25,
      });
    });

    it('删除单个会话与清理设备状态', async () => {
      await syncDao.updateSyncState('dev_1', 's1', 10);
      await syncDao.updateSyncState('dev_1', 's2', 20);

      await syncDao.deleteSyncState('dev_1', 's1');
      expect(await syncDao.getSyncState('dev_1', 's1')).toBeNull();
      expect(await syncDao.getSyncState('dev_1', 's2')).not.toBeNull();

      await syncDao.deleteDeviceSyncState('dev_1');
      expect(await syncDao.getAllLatestSequences('dev_1')).toEqual({});
    });
  });
});
