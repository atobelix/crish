import { produce } from 'immer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOMBSTONE_CAPACITY,
  SessionCascadeCancellation,
  cancelSessionCascade,
  isSessionTombstoned,
  sessionCascadeCancellation,
} from './sessionCascadeCancellation';
import { createSessionActions, type SessionStoreSlice } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import type { SessionState } from './types';
import { sharedSessionStreamManager } from '../hooks/chat-stream/sessionStreamManager';
import { useStreamingStore } from './streamingStore';

function makeStateFromSessions(
  sessions: SessionState[],
  activeSessionId: string
): SessionStoreSlice {
  return {
    sessions,
    sessionsById: buildSessionsById(sessions),
    folderOrder: Array.from(new Set(sessions.map((s) => s.folder))),
    activeSessionId,
    draftFolder: '',
    activeAgentId: null,
    panelAgentId: null,
    composerDrafts: {},
  };
}

function makeHarness(sessions: SessionState[], activeId: string) {
  let state = makeStateFromSessions(sessions, activeId);
  const set = (updater: (s: SessionStoreSlice) => void) => {
    state = produce(state, updater);
  };
  const get = () => state;
  const actions = createSessionActions(set, get);
  return {
    get state() {
      return state;
    },
    actions,
  };
}

describe('SessionCascadeCancellation (三级级联取消总线 W2-3 / VULN-05)', () => {
  beforeEach(() => {
    sessionCascadeCancellation.resetForTest();
    vi.restoreAllMocks();
  });

  describe('1. 基础墓碑记录与守卫状态', () => {
    it('调用 cancelSessionCascade 时，该 sessionId 立即被登记为墓碑', () => {
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-100')).toBe(
        false
      );
      expect(
        sessionCascadeCancellation.tombstoneSessionIds.has('sess-100')
      ).toBe(false);

      sessionCascadeCancellation.cancelSessionCascade('sess-100');

      expect(sessionCascadeCancellation.isSessionTombstoned('sess-100')).toBe(
        true
      );
      expect(
        sessionCascadeCancellation.tombstoneSessionIds.has('sess-100')
      ).toBe(true);
    });

    it('isSessionTombstoned 对已删会话返回 true，对正常未删会话返回 false', () => {
      sessionCascadeCancellation.cancelSessionCascade('deleted-session');

      expect(isSessionTombstoned('deleted-session')).toBe(true);
      expect(
        sessionCascadeCancellation.isSessionTombstoned('deleted-session')
      ).toBe(true);

      expect(isSessionTombstoned('active-session')).toBe(false);
      expect(
        sessionCascadeCancellation.isSessionTombstoned('active-session')
      ).toBe(false);
    });

    it('自动修剪空白前后缀，忽略空字符串与纯空白', () => {
      sessionCascadeCancellation.cancelSessionCascade('   ');
      expect(sessionCascadeCancellation.tombstoneSessionIds.size).toBe(0);

      sessionCascadeCancellation.cancelSessionCascade('  padded-id  ');
      expect(sessionCascadeCancellation.isSessionTombstoned('padded-id')).toBe(
        true
      );
      expect(
        sessionCascadeCancellation.isSessionTombstoned('  padded-id  ')
      ).toBe(true);
      expect(
        sessionCascadeCancellation.tombstoneSessionIds.has('padded-id')
      ).toBe(true);
    });

    it('便捷导出函数 cancelSessionCascade 与 isSessionTombstoned 正常代理单例', () => {
      cancelSessionCascade('proxy-test');
      expect(isSessionTombstoned('proxy-test')).toBe(true);
    });
  });

  describe('2. LRU 语义与容量限制 (500 墓碑上限)', () => {
    it('默认容量为 500', () => {
      expect(DEFAULT_TOMBSTONE_CAPACITY).toBe(500);
    });

    it('测试墓碑集合达到 500 容量时自动淘汰最旧的记录（LRU 语义）', () => {
      // 写入 500 个墓碑
      for (let i = 0; i < 500; i++) {
        sessionCascadeCancellation.cancelSessionCascade(`sess-${i}`);
      }
      expect(sessionCascadeCancellation.tombstoneSessionIds.size).toBe(500);
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-0')).toBe(
        true
      );
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-499')).toBe(
        true
      );

      // 写入第 501 个墓碑，最旧的 sess-0 应被淘汰
      sessionCascadeCancellation.cancelSessionCascade('sess-500');

      expect(sessionCascadeCancellation.tombstoneSessionIds.size).toBe(500);
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-0')).toBe(
        false
      );
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-1')).toBe(
        true
      );
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-500')).toBe(
        true
      );
    });

    it('重新登记已有墓碑会刷新其 LRU 序，使其免于被先淘汰', () => {
      // 使用小容量实例精确验证 LRU 时序
      const lruBus = new SessionCascadeCancellation(3);

      lruBus.cancelSessionCascade('a');
      lruBus.cancelSessionCascade('b');
      lruBus.cancelSessionCascade('c');
      expect(Array.from(lruBus.tombstoneSessionIds)).toEqual(['a', 'b', 'c']);

      // 访问/重新登记 'a'，'a' 应该移至最新末尾
      lruBus.recordTombstone('a');
      expect(Array.from(lruBus.tombstoneSessionIds)).toEqual(['b', 'c', 'a']);

      // 添加 'd'，最旧的 'b' 应被淘汰，而 'a' 保留
      lruBus.cancelSessionCascade('d');
      expect(Array.from(lruBus.tombstoneSessionIds)).toEqual(['c', 'a', 'd']);
      expect(lruBus.isSessionTombstoned('b')).toBe(false);
      expect(lruBus.isSessionTombstoned('a')).toBe(true);
      expect(lruBus.isSessionTombstoned('d')).toBe(true);
    });

    it('setMaxCapacityForTest 可动态缩减容量并排空超出项', () => {
      for (let i = 0; i < 10; i++) {
        sessionCascadeCancellation.cancelSessionCascade(`s-${i}`);
      }
      expect(sessionCascadeCancellation.tombstoneSessionIds.size).toBe(10);

      sessionCascadeCancellation.setMaxCapacityForTest(5);
      expect(sessionCascadeCancellation.tombstoneSessionIds.size).toBe(5);
      expect(sessionCascadeCancellation.isSessionTombstoned('s-0')).toBe(false);
      expect(sessionCascadeCancellation.isSessionTombstoned('s-4')).toBe(false);
      expect(sessionCascadeCancellation.isSessionTombstoned('s-5')).toBe(true);
      expect(sessionCascadeCancellation.isSessionTombstoned('s-9')).toBe(true);
    });
  });

  describe('3. 三级级联取消广播 (Tier 1 / Tier 2 / Tier 3)', () => {
    it('Tier 1 计算级：通知 WorkerPool 与 WorkerCancelHandler 取消该会话', () => {
      const mockWorkerPool = {
        cancelBySession: vi.fn(),
      };
      const unregisterPool =
        sessionCascadeCancellation.registerWorkerPool(mockWorkerPool);

      const workerHandler = vi.fn();
      const unregisterHandler =
        sessionCascadeCancellation.registerWorkerCancelHandler(workerHandler);

      sessionCascadeCancellation.cancelSessionCascade('sess-compute');

      expect(mockWorkerPool.cancelBySession).toHaveBeenCalledWith(
        'sess-compute'
      );
      expect(workerHandler).toHaveBeenCalledWith('sess-compute');

      // 注销后不再收到通知
      unregisterPool();
      unregisterHandler();

      sessionCascadeCancellation.cancelSessionCascade('sess-compute-2');
      expect(mockWorkerPool.cancelBySession).toHaveBeenCalledTimes(1);
      expect(workerHandler).toHaveBeenCalledTimes(1);
    });

    it('Tier 2 通信级：通知 TransportAbortHandler 并清理 sharedSessionStreamManager 和 useStreamingStore', () => {
      const streamCancelSpy = vi.spyOn(
        sharedSessionStreamManager,
        'cancelSession'
      );
      const streamClearSpy = vi.spyOn(
        sharedSessionStreamManager,
        'clearSession'
      );
      const streamingStoreSpy = vi.spyOn(
        useStreamingStore.getState(),
        'clearSession'
      );

      const transportHandler = vi.fn();
      const unregisterTransport =
        sessionCascadeCancellation.registerTransportAbortHandler(
          transportHandler
        );

      sessionCascadeCancellation.cancelSessionCascade('sess-transport');

      expect(transportHandler).toHaveBeenCalledWith('sess-transport');
      expect(streamCancelSpy).toHaveBeenCalledWith('sess-transport');
      expect(streamClearSpy).toHaveBeenCalledWith('sess-transport');
      expect(streamingStoreSpy).toHaveBeenCalledWith('sess-transport');

      unregisterTransport();
    });

    it('Tier 3 存储屏障级：通知 StorageBarrierHandler 且 isSessionTombstoned 拦截迟到写入', () => {
      const storageHandler = vi.fn();
      const unregisterStorage =
        sessionCascadeCancellation.registerStorageBarrierHandler(
          storageHandler
        );

      sessionCascadeCancellation.cancelSessionCascade('sess-storage');

      expect(storageHandler).toHaveBeenCalledWith('sess-storage');
      expect(
        sessionCascadeCancellation.isSessionTombstoned('sess-storage')
      ).toBe(true);

      // 模拟存储写屏障检查
      const lateArrivalWrite = (sessionId: string) => {
        if (sessionCascadeCancellation.isSessionTombstoned(sessionId)) {
          return 'SUPPRESSED_BY_TOMBSTONE';
        }
        return 'SAVED_TO_SQLITE';
      };

      expect(lateArrivalWrite('sess-storage')).toBe('SUPPRESSED_BY_TOMBSTONE');
      expect(lateArrivalWrite('sess-alive')).toBe('SAVED_TO_SQLITE');

      unregisterStorage();
    });

    it('支持 CascadeCancellationSubscriber 具名全量订阅', () => {
      const subscriber = {
        id: 'full-subscriber-1',
        onWorkerCancel: vi.fn(),
        onTransportAbort: vi.fn(),
        onStorageBarrier: vi.fn(),
      };

      const unregister =
        sessionCascadeCancellation.registerSubscriber(subscriber);

      sessionCascadeCancellation.cancelSessionCascade('sess-full');

      expect(subscriber.onWorkerCancel).toHaveBeenCalledWith('sess-full');
      expect(subscriber.onTransportAbort).toHaveBeenCalledWith('sess-full');
      expect(subscriber.onStorageBarrier).toHaveBeenCalledWith('sess-full');

      unregister();

      sessionCascadeCancellation.cancelSessionCascade('sess-full-2');
      expect(subscriber.onWorkerCancel).toHaveBeenCalledTimes(1);
    });

    it('单个回调发生异常时不中断级联广播流程', () => {
      const badWorkerHandler = vi.fn(() => {
        throw new Error('Worker crash');
      });
      const goodWorkerHandler = vi.fn();

      sessionCascadeCancellation.registerWorkerCancelHandler(badWorkerHandler);
      sessionCascadeCancellation.registerWorkerCancelHandler(goodWorkerHandler);

      expect(() => {
        sessionCascadeCancellation.cancelSessionCascade('sess-safe');
      }).not.toThrow();

      expect(badWorkerHandler).toHaveBeenCalledWith('sess-safe');
      expect(goodWorkerHandler).toHaveBeenCalledWith('sess-safe');
      expect(sessionCascadeCancellation.isSessionTombstoned('sess-safe')).toBe(
        true
      );
    });
  });

  describe('4. 与 sessionCrudActions.deleteSession 协同接入', () => {
    it('在 deleteSession 时触发级联取消广播并登记墓碑', () => {
      const spy = vi.spyOn(sessionCascadeCancellation, 'cancelSessionCascade');

      const initialSessions: SessionState[] = [
        {
          id: 'victim-1',
          title: '会话 1',
          folder: 'general',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        },
        {
          id: 'survivor-2',
          title: '会话 2',
          folder: 'general',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        },
      ];

      const h = makeHarness(initialSessions, 'victim-1');

      expect(sessionCascadeCancellation.isSessionTombstoned('victim-1')).toBe(
        false
      );

      const ok = h.actions.deleteSession('victim-1');
      expect(ok).toBe(true);

      // 断言调用了取消总线且登记了墓碑
      expect(spy).toHaveBeenCalledWith('victim-1');
      expect(sessionCascadeCancellation.isSessionTombstoned('victim-1')).toBe(
        true
      );

      // survivor 会话不应受影响
      expect(sessionCascadeCancellation.isSessionTombstoned('survivor-2')).toBe(
        false
      );
    });

    it('deleteSession 传入空值时安全拦截，不向总线登记空墓碑', () => {
      const h = makeHarness([], 'empty');
      const ok = h.actions.deleteSession('');
      expect(ok).toBe(false);
      expect(sessionCascadeCancellation.tombstoneSessionIds.size).toBe(0);
    });

    it('deleteSession 删除不存在的会话时同样登记墓碑，防御在途幽灵写入', () => {
      const spy = vi.spyOn(sessionCascadeCancellation, 'cancelSessionCascade');
      const h = makeHarness([], 'empty');

      const ok = h.actions.deleteSession('non-existent-session');
      expect(ok).toBe(false);

      expect(spy).toHaveBeenCalledWith('non-existent-session');
      expect(
        sessionCascadeCancellation.isSessionTombstoned('non-existent-session')
      ).toBe(true);
    });
  });
});
