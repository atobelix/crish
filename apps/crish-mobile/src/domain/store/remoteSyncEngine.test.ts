// 远程增量同步引擎专项单元测试
import { MemorySqlDriver } from '@/db/driver';
import { migrateIfNeeded } from '@/db/db';
import { SqlRemoteEventDao } from '@/db/dao/remoteEventDao';
import { SqlRemoteSessionDao } from '@/db/dao/remoteSessionDao';
import { SqlRemoteSyncDao } from '@/db/dao/remoteSyncDao';
import { eventStore, windowOf } from './eventStore';
import { RemoteSyncEngine } from './remoteSyncEngine';
import type { MonitorRepository } from '@/adapters/repositories/monitorRepository';

describe('RemoteSyncEngine 增量同步与持久化引擎', () => {
  let driver: MemorySqlDriver;
  let eventDao: SqlRemoteEventDao;
  let sessionDao: SqlRemoteSessionDao;
  let syncDao: SqlRemoteSyncDao;
  let syncEngine: RemoteSyncEngine;

  beforeEach(async () => {
    driver = new MemorySqlDriver();
    await migrateIfNeeded(driver);
    eventDao = new SqlRemoteEventDao(driver);
    sessionDao = new SqlRemoteSessionDao(driver);
    syncDao = new SqlRemoteSyncDao(driver);
    eventStore.getState().reset();

    syncEngine = new RemoteSyncEngine({
      eventDao,
      sessionDao,
      syncDao,
      ownerDeviceId: 'dev-desktop-1',
      batchFlushIntervalMs: 50,
      batchMaxBufferSize: 5,
    });
  });

  afterEach(() => {
    syncEngine.dispose();
  });

  describe('离线秒开水合（Offline First: Zero Latency）', () => {
    it('冷启动时从 SQLite 读取已有历史事件，0 延迟首绘，断网完全可用', async () => {
      // 模拟此前离线或退后台时落入 SQLite 的事件
      await eventDao.insertEvents([
        {
          deviceId: 'dev-desktop-1',
          sessionId: 'sess-alpha',
          sequence: 1,
          kind: 'agent-event',
          eventType: 'message-start',
          receivedAtMs: 1000,
          rawPayload: JSON.stringify({
            type: 'message-start',
            sessionId: 'sess-alpha',
            sequence: 1,
            role: 'user',
          }),
        },
        {
          deviceId: 'dev-desktop-1',
          sessionId: 'sess-alpha',
          sequence: 2,
          kind: 'agent-event',
          eventType: 'message-delta',
          receivedAtMs: 1010,
          rawPayload: JSON.stringify({
            type: 'message-delta',
            sessionId: 'sess-alpha',
            sequence: 2,
            text: '你好，请帮我分析代码',
          }),
        },
      ]);
      await syncDao.updateSyncState('dev-desktop-1', 'sess-alpha', 2);

      // 验证在无网络情况下（未注入 monitor），打开会话瞬时从 SQLite 水合
      const result = await syncEngine.hydrateSessionFromLocal('sess-alpha');
      expect(result.count).toBe(2);
      expect(result.lastSeq).toBe(2);

      const win = windowOf('sess-alpha');
      expect(win.entries).toHaveLength(2);
      expect(win.lastSeq).toBe(2);
      expect(win.entries[1]?.type).toBe('message-delta');
    });

    it('当本地无任何记录时安全返回 0，不破坏内存状态', async () => {
      const result = await syncEngine.hydrateSessionFromLocal('sess-empty');
      expect(result.count).toBe(0);
      expect(result.lastSeq).toBe(0);
      expect(windowOf('sess-empty').entries).toHaveLength(0);
    });
  });

  describe('差分续传追平（Incremental Catch-up）', () => {
    it('基于本地 SQLite 记录的最大游标，仅拉取增量差分事件并持久化', async () => {
      // 本地已经存有 sequence 1..5
      const initialEvents = [1, 2, 3, 4, 5].map((seq) => ({
        deviceId: 'dev-desktop-1',
        sessionId: 'sess-beta',
        sequence: seq,
        kind: 'agent-event',
        eventType: 'text-chunk',
        receivedAtMs: 1000 + seq,
        rawPayload: JSON.stringify({
          type: 'text-chunk',
          sessionId: 'sess-beta',
          sequence: seq,
          text: `chunk-${seq}`,
        }),
      }));
      await eventDao.insertEvents(initialEvents);
      await syncDao.updateSyncState('dev-desktop-1', 'sess-beta', 5);

      // 先本地秒开水合
      await syncEngine.hydrateSessionFromLocal('sess-beta');
      expect(windowOf('sess-beta').lastSeq).toBe(5);

      // Mock monitor，仅下发差分 sequence 6..8
      const readSessionEventsMock = jest.fn().mockResolvedValue({
        events: [
          {
            type: 'text-chunk',
            sessionId: 'sess-beta',
            sequence: 6,
            text: 'chunk-6',
          },
          {
            type: 'text-chunk',
            sessionId: 'sess-beta',
            sequence: 7,
            text: 'chunk-7',
          },
          {
            type: 'message-end',
            sessionId: 'sess-beta',
            sequence: 8,
          },
        ],
        nextAfterSequence: 8,
        latestSequence: 8,
        hasMore: false,
      });

      const mockMonitor: Partial<MonitorRepository> = {
        readSessionEvents: readSessionEventsMock,
      };
      syncEngine.setMonitor(mockMonitor as MonitorRepository);

      // 发起差分续传
      const catchUpRes = await syncEngine.catchUpSession('sess-beta');
      expect(catchUpRes.fetchedCount).toBe(3);
      expect(catchUpRes.lastSeq).toBe(8);

      // 验证发出的请求入参：afterSequence 严格等于本地最大游标 5，杜绝从 0 全量拉取！
      expect(readSessionEventsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-beta',
          afterSequence: 5,
        })
      );

      // 验证内存视图平滑追加到了 8
      const win = windowOf('sess-beta');
      expect(win.entries).toHaveLength(8);
      expect(win.lastSeq).toBe(8);

      // 验证增量事件已安全写入 SQLite
      const latestInDb = await eventDao.getLatestSequence(
        'dev-desktop-1',
        'sess-beta'
      );
      expect(latestInDb).toBe(8);
      const syncedState = await syncDao.getSyncState(
        'dev-desktop-1',
        'sess-beta'
      );
      expect(syncedState?.lastSyncedSequence).toBe(8);
    });
  });

  describe('实时推流双轨执行（Reactive Ingestion & Debounced Persistence）', () => {
    it('实时收到 events.push 时立即更新 Zustand 视图，并在后台批量落入 SQLite', async () => {
      const frame1 = {
        type: 'message-delta',
        sessionId: 'sess-gamma',
        sequence: 1,
        text: '实时第1字',
      };
      const frame2 = {
        type: 'message-delta',
        sessionId: 'sess-gamma',
        sequence: 2,
        text: '实时第2字',
      };

      // 1. 内存轨毫秒响应
      syncEngine.ingestLiveEvent('sess-gamma', frame1);
      syncEngine.ingestLiveEvent('sess-gamma', frame2);

      // 内存 store 立即能够读到两条（打字机 60fps 零延迟呈现）
      expect(windowOf('sess-gamma').entries).toHaveLength(2);
      expect(windowOf('sess-gamma').lastSeq).toBe(2);

      // 此时尚未达到 5 条阈值且未过 50ms，先验证缓冲中，数据库暂未落盘
      expect(
        await eventDao.getLatestSequence('dev-desktop-1', 'sess-gamma')
      ).toBe(0);

      // 2. 强制排空（或等待定时器触发）
      await syncEngine.flush();

      // 验证后台已安全批量落入 SQLite，且更新了游标
      expect(
        await eventDao.getLatestSequence('dev-desktop-1', 'sess-gamma')
      ).toBe(2);
      expect(
        await syncDao.getLastSyncedSequence('dev-desktop-1', 'sess-gamma')
      ).toBe(2);
    });

    it('preview 预览帧不进入落盘缓冲', async () => {
      syncEngine.ingestLiveEvent(
        'sess-preview',
        {
          type: 'message-delta',
          sessionId: 'sess-preview',
          sequence: 1,
          text: '草稿预览',
        },
        undefined,
        true // preview = true
      );

      // 内存视图已记录
      expect(windowOf('sess-preview').entries).toHaveLength(1);

      await syncEngine.flush();
      // SQLite 中不落盘 preview 帧
      expect(
        await eventDao.getLatestSequence('dev-desktop-1', 'sess-preview')
      ).toBe(0);
    });
  });

  describe('向上分页翻页加载历史（Backward Pagination）', () => {
    it('能够成功从本地 SQLite 向前加载更早历史', async () => {
      const rows = [1, 2, 3, 4, 5, 6].map((seq) => ({
        deviceId: 'dev-desktop-1',
        sessionId: 'sess-paged',
        sequence: seq,
        kind: 'agent-event',
        eventType: 'text-chunk',
        receivedAtMs: 1000 + seq,
        rawPayload: JSON.stringify({
          type: 'text-chunk',
          sessionId: 'sess-paged',
          sequence: seq,
          text: `text-${seq}`,
        }),
      }));
      await eventDao.insertEvents(rows);

      // 先只把最新 2 条水合到内存
      await syncEngine.hydrateSessionFromLocal('sess-paged', undefined, 2);
      expect(windowOf('sess-paged').entries).toHaveLength(2);
      expect(windowOf('sess-paged').entries[0]?.sequence).toBe(5);

      // 向上滑动加载 sequence < 5 的更早 3 条（应当读出 2, 3, 4）
      const paged = await syncEngine.loadEarlierEvents(
        'sess-paged',
        5,
        undefined,
        3
      );
      expect(paged.events).toHaveLength(3);
      expect(paged.events[0]?.sequence).toBe(2);
      expect(paged.events[2]?.sequence).toBe(4);

      // 内存 store 自动整合更早历史
      expect(windowOf('sess-paged').entries.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('设备物理隔离（M7）', () => {
    it('切换设备时游标与事件彼此物理隔离', async () => {
      await syncDao.updateSyncState('device-A', 'sess-shared-id', 100);
      await syncDao.updateSyncState('device-B', 'sess-shared-id', 200);

      expect(
        await syncDao.getLastSyncedSequence('device-A', 'sess-shared-id')
      ).toBe(100);
      expect(
        await syncDao.getLastSyncedSequence('device-B', 'sess-shared-id')
      ).toBe(200);

      const allA = await syncEngine.getAllLatestSequences('device-A');
      const allB = await syncEngine.getAllLatestSequences('device-B');
      expect(allA['sess-shared-id']).toBe(100);
      expect(allB['sess-shared-id']).toBe(200);
    });
  });
});
