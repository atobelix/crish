// @vitest-environment jsdom
/**
 * Wave 3 W3-4: 历史消息分页查询与延迟懒加载（防止几万条历史消息一次性装载打爆内存）
 *
 * 核心验证契约：
 * 1. 会话消息首屏窗口化加载协议：
 *    - 切换进入会话优先加载最新的 N 条消息（默认 50 条），快速达到首屏可用（TTI < 30ms）；
 *    - 提供 loadOlderMessages(sessionId, beforeSeq, limit) 增量向前拉取能力；
 * 2. 与 sessionDeltaWriteBarrier（增量写屏障）深度配合：
 *    - 处于局部窗口化懒加载状态时，拦截全量清空型覆盖与尾部收缩，用户数字资产 100% 完整，绝不丢失未拉取的历史记录；
 * 3. 与 VirtualScrollManager 深度配合：
 *    - 向前拉取历史消息前插时，基于锚点保持机制平滑补偿 scrollTop，几何视口 0 像素跳跃，滚动条绝对不抖动；
 * 4. 引擎回退水合增量向前拉取能力与窗口化支持。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';

const { fakeTransport } = vi.hoisted(() => ({
  fakeTransport: {
    isReady: vi.fn(() => true),
    waitUntilConnected: vi.fn(async () => true),
    request: vi.fn(async () => ({
      events: [
        {
          type: 'message-end',
          sequence: 10,
          message: { role: 'user', content: 'older-1' },
        },
        {
          type: 'message-end',
          sequence: 20,
          message: { role: 'assistant', content: 'older-2' },
        },
        {
          type: 'message-end',
          sequence: 30,
          message: { role: 'user', content: 'older-3' },
        },
      ],
      nextAfterSequence: 30,
      hasMore: false,
    })),
  },
}));

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
}));

import type { SessionState, SessionMessage } from '../../store/types';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import {
  DEFAULT_HYDRATE_WINDOW_SIZE,
  ensureSessionBodyHydrated,
  loadOlderMessages,
  loadOlderMessagesWithScrollAnchor,
  hydrateSessionsFromRust,
  persistAllSessionsRust,
} from './sessionRustDbHydrate';
import {
  sessionDeltaWriteBarrier,
  reconcileLateArrivalSnapshot,
} from './sessionDeltaWriteBarrier';
import { VirtualScrollManager } from '../VirtualScrollManager';
import {
  hydrateSessionMessagesFromEngine,
  loadOlderEngineMessages,
} from '../sessionEventHydrate';

/** 构造模拟的 N 条结构化历史消息 (seq 0 .. count-1) */
function createMockHistoryMessages(count: number): SessionMessage[] {
  const baseTime = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    sender: i % 2 === 0 ? 'user' : 'assistant',
    text: `Message content ${i}`,
    timestamp: baseTime + i * 1000,
    seq: i,
  }));
}

function createIndexEntry(
  id: string,
  title: string,
  messageCount: number,
  updatedAt: number
): SessionIndexEntry {
  return {
    id,
    title,
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    updatedAt,
    messageCount,
  };
}

describe('W3-4: 历史消息分页查询与延迟懒加载 (Session Lazy Hydrate)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionDeltaWriteBarrier.reset();
  });

  describe('1. 会话消息首屏窗口化加载协议', () => {
    it('包含 200 条历史消息的大会话，首屏优先仅加载最新 50 条消息且 TTI < 30ms', async () => {
      const TOTAL_MSGS = 200;
      const allMsgs = createMockHistoryMessages(TOTAL_MSGS);
      const bodyCalls: Array<{
        sessionId: string;
        limit?: number;
        beforeSeq?: number;
      }> = [];

      mockTauriCommand('load_session_body', async (args) => {
        const a = args as {
          sessionId: string;
          limit?: number;
          beforeSeq?: number;
        };
        bodyCalls.push(a);
        return allMsgs;
      });
      mockTauriCommand('load_session_agents', async () => []);

      const startTime = performance.now();
      const loaded = await ensureSessionBodyHydrated('session-huge');
      const durationMs = performance.now() - startTime;

      // 首屏可用性能契约：TTI < 30ms
      expect(durationMs).toBeLessThan(30);

      // 仅加载最新 50 条消息 (seq 150..199)
      expect(loaded.messages.length).toBe(DEFAULT_HYDRATE_WINDOW_SIZE);
      expect(loaded.hasMore).toBe(true);
      expect(loaded.oldestSeq).toBe(150);
      expect(loaded.totalCount).toBe(TOTAL_MSGS);

      // 验证返回的消息包含正确的序列号与内容
      expect(loaded.messages[0]!.id).toBe('msg-150');
      expect(loaded.messages[0]!.seq).toBe(150);
      expect(loaded.messages[loaded.messages.length - 1]!.id).toBe('msg-199');
      expect(loaded.messages[loaded.messages.length - 1]!.seq).toBe(199);
    });

    it('通过 full 选项支持显式全量水合跳过窗口截断', async () => {
      const TOTAL_MSGS = 120;
      const allMsgs = createMockHistoryMessages(TOTAL_MSGS);

      mockTauriCommand('load_session_body', async () => allMsgs);
      mockTauriCommand('load_session_agents', async () => []);

      const loaded = await ensureSessionBodyHydrated('session-all', {
        full: true,
      });
      expect(loaded.messages.length).toBe(TOTAL_MSGS);
      expect(loaded.hasMore).toBe(false);
      expect(loaded.oldestSeq).toBe(0);
      expect(loaded.totalCount).toBe(TOTAL_MSGS);
      expect(loaded.messages[0]!.id).toBe('msg-0');
    });

    it('hydrateSessionsFromRust 冷启动仅为活跃会话窗口化装配首屏消息，历史会话保持轻量懒壳', async () => {
      const activeMsgs = createMockHistoryMessages(100);
      localStorage.setItem(
        SESSION_INDEX_KEY,
        JSON.stringify([
          createIndexEntry('sess-active', '活跃会话', 100, 300),
          createIndexEntry('sess-hist', '历史会话', 500, 200),
        ])
      );
      localStorage.setItem(SESSION_ACTIVE_KEY, 'sess-active');

      mockTauriCommand('list_sessions', async () => []);
      mockTauriCommand('load_session_body', async (args) => {
        const id = (args as { sessionId: string }).sessionId;
        if (id === 'sess-active') return activeMsgs;
        return [];
      });
      mockTauriCommand('load_session_agents', async () => []);
      mockTauriCommand('get_session_meta', async (args) => {
        if ((args as { key: string }).key === 'active_session_id')
          return 'sess-active';
        return null;
      });

      const res = await hydrateSessionsFromRust();
      expect(res.activeSessionId).toBe('sess-active');

      const activeSession = res.sessions.find((s) => s.id === 'sess-active')!;
      expect(activeSession.messagesHydrated).toBe(true);
      expect(activeSession.messages.length).toBe(50);
      expect(activeSession.hasOlderMessages).toBe(true);
      expect(activeSession.oldestLoadedSeq).toBe(50);
      expect(activeSession.messageCount).toBe(100);

      const histSession = res.sessions.find((s) => s.id === 'sess-hist')!;
      expect(histSession.messagesHydrated).toBe(false);
      expect(histSession.messages).toEqual([]);
      expect(histSession.messageCount).toBe(500);
    });
  });

  describe('2. loadOlderMessages 增量向前拉取能力', () => {
    it('支持逐页向前拉取历史消息，直至 seq = 0 触顶', async () => {
      const TOTAL_MSGS = 160;
      const allMsgs = createMockHistoryMessages(TOTAL_MSGS);

      mockTauriCommand('load_session_body', async (args) => {
        const { limit = 50, beforeSeq } = args as {
          limit?: number;
          beforeSeq?: number;
        };
        if (beforeSeq !== undefined) {
          const end = Math.min(beforeSeq, allMsgs.length);
          const start = Math.max(0, end - limit);
          return allMsgs.slice(start, end);
        }
        return allMsgs;
      });

      // 阶段 1：首屏已加载 seq 110..159 (最新 50 条)，向前拉取 beforeSeq = 110
      const page1 = await loadOlderMessages('sess-paged', 110, 50);
      expect(page1.messages.length).toBe(50);
      expect(page1.messages[0]!.id).toBe('msg-60');
      expect(page1.messages[0]!.seq).toBe(60);
      expect(page1.messages[49]!.id).toBe('msg-109');
      expect(page1.messages[49]!.seq).toBe(109);
      expect(page1.oldestSeq).toBe(60);
      expect(page1.hasMore).toBe(true);

      // 阶段 2：继续向前拉取 beforeSeq = 60
      const page2 = await loadOlderMessages('sess-paged', 60, 50);
      expect(page2.messages.length).toBe(50);
      expect(page2.messages[0]!.id).toBe('msg-10');
      expect(page2.messages[0]!.seq).toBe(10);
      expect(page2.oldestSeq).toBe(10);
      expect(page2.hasMore).toBe(true);

      // 阶段 3：继续向前拉取 beforeSeq = 10，仅余 10 条 (seq 0..9)
      const page3 = await loadOlderMessages('sess-paged', 10, 50);
      expect(page3.messages.length).toBe(10);
      expect(page3.messages[0]!.id).toBe('msg-0');
      expect(page3.messages[0]!.seq).toBe(0);
      expect(page3.oldestSeq).toBe(0);
      expect(page3.hasMore).toBe(false); // 触顶，无更多历史消息

      // 阶段 4：触顶后再次尝试 beforeSeq = 0，安全返回空数组
      const page4 = await loadOlderMessages('sess-paged', 0, 50);
      expect(page4.messages).toEqual([]);
      expect(page4.hasMore).toBe(false);
      expect(page4.oldestSeq).toBe(0);
    });

    it('空 sessionId 或 PENDING_DRAFT 时安全返回空结果', async () => {
      const empty1 = await loadOlderMessages('', 50, 50);
      const empty2 = await loadOlderMessages('__pending_draft__', 50, 50);
      expect(empty1.messages).toEqual([]);
      expect(empty1.hasMore).toBe(false);
      expect(empty2.messages).toEqual([]);
      expect(empty2.hasMore).toBe(false);
    });
  });

  describe('3. 与 sessionDeltaWriteBarrier 深度配合保证数字资产 100% 完整', () => {
    it('窗口化状态下，persistAllSessionsRust 被写屏障拦截保护，绝不执行覆写截断已有的几千条磁盘历史', async () => {
      const savedBodies: Array<{ id: string; count: number }> = [];
      mockTauriCommand('list_sessions', async () => [
        {
          id: 'sess-windowed',
          title: '大会话',
          folder: DEFAULT_SESSION_FOLDER,
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          updatedAt: Date.now(),
          messageCount: 5000,
        },
      ]);
      mockTauriCommand('save_session_body', async (args) => {
        const { sessionId, messages } = args as {
          sessionId: string;
          messages: unknown[];
        };
        savedBodies.push({ id: sessionId, count: messages.length });
        return null;
      });
      mockTauriCommand('save_session_agents', async () => null);
      mockTauriCommand('set_session_meta', async () => null);

      // 模拟内存中该会话仅装载了最新 50 条消息，但 messageCount 为 5000 且 hasOlderMessages 为 true
      const windowedSession: SessionState = {
        id: 'sess-windowed',
        title: '大会话',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: createMockHistoryMessages(50),
        messagesHydrated: true,
        messageCount: 5000,
        hasOlderMessages: true,
        oldestLoadedSeq: 4950,
      };

      sessionDeltaWriteBarrier.setHydrated(true);

      // 验证写屏障的单独拦截判定
      expect(
        sessionDeltaWriteBarrier.shouldBlockWrite('windowed_session_truncate', {
          sessionId: 'sess-windowed',
          currentLength: 50,
          totalCount: 5000,
          hasOlderMessages: true,
        })
      ).toBe(true);

      // 执行全量持久化
      await persistAllSessionsRust([windowedSession], 'sess-windowed', []);

      // 核心断言：save_session_body 绝对未被调用，5000 条历史消息 0 丢失！
      expect(savedBodies).toEqual([]);
    });

    it('当所有历史消息全部拉取完毕（hasOlderMessages=false 且数量对齐）后，正常放行全量持久化', async () => {
      const savedBodies: Array<{ id: string; count: number }> = [];
      mockTauriCommand('list_sessions', async () => []);
      mockTauriCommand('save_session_body', async (args) => {
        const { sessionId, messages } = args as {
          sessionId: string;
          messages: unknown[];
        };
        savedBodies.push({ id: sessionId, count: messages.length });
        return null;
      });
      mockTauriCommand('save_session_agents', async () => null);
      mockTauriCommand('set_session_meta', async () => null);

      const allMsgs = createMockHistoryMessages(100);
      const fullyHydratedSession: SessionState = {
        id: 'sess-fully-loaded',
        title: '完整会话',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: allMsgs,
        messagesHydrated: true,
        messageCount: 100,
        hasOlderMessages: false,
        oldestLoadedSeq: 0,
      };

      sessionDeltaWriteBarrier.setHydrated(true);

      expect(
        sessionDeltaWriteBarrier.shouldBlockWrite('windowed_session_truncate', {
          sessionId: 'sess-fully-loaded',
          currentLength: 100,
          totalCount: 100,
          hasOlderMessages: false,
        })
      ).toBe(false);

      await persistAllSessionsRust(
        [fullyHydratedSession],
        'sess-fully-loaded',
        []
      );

      // 完整加载后正常放行保存
      expect(savedBodies.length).toBe(1);
      expect(savedBodies[0]!.id).toBe('sess-fully-loaded');
      expect(savedBodies[0]!.count).toBe(100);
    });

    it('reconcileLateArrivalSnapshot 在集合论合并中无损继承窗口化状态与历史消息', () => {
      const diskSession: SessionState = {
        id: 'sess-merge',
        title: '磁盘会话',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: createMockHistoryMessages(30),
        messageCount: 300,
      };

      const liveSession: SessionState = {
        id: 'sess-merge',
        title: '内存更新标题',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: true,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: createMockHistoryMessages(50),
        messageCount: 300,
        hasOlderMessages: true,
        oldestLoadedSeq: 250,
      };

      const reconciled = reconcileLateArrivalSnapshot(
        [diskSession],
        [liveSession]
      );
      const merged = reconciled.find((s) => s.id === 'sess-merge')!;

      expect(merged).toBeDefined();
      expect(merged.hasOlderMessages).toBe(true);
      expect(merged.oldestLoadedSeq).toBe(250);
      expect(merged.messageCount).toBe(300);
      expect(merged.messages.length).toBeGreaterThanOrEqual(50);
    });
  });

  describe('4. 与 VirtualScrollManager 深度配合实现平滑滚动锚点补偿与 0 抖动', () => {
    it('向前插入 50 条消息时，锚点精确锁定当前视口相对偏移，scrollTop 平滑补偿且跳跃量为 0', () => {
      const vsm = new VirtualScrollManager(80);
      const initialIds = Array.from({ length: 50 }, (_, i) => `msg-${150 + i}`);
      vsm.syncOrder(initialIds);

      // 为首屏 50 条消息灌入实测高度（每项 80px）
      for (const id of initialIds) {
        vsm.setActual(id, 80);
      }

      // 用户当前位于 scrollTop = 260px：
      // msg-150: 0..80, msg-151: 80..160, msg-152: 160..240, msg-153: 240..320
      // 260px 处于 msg-153 的内部 20px 处 (260 - 240 = 20px)
      const currentScrollTop = 260;
      const anchor = vsm.captureScrollAnchor(currentScrollTop);
      expect(anchor.anchorId).toBe('msg-153');
      expect(anchor.anchorIndex).toBe(3);
      expect(anchor.offsetInItem).toBe(20);

      // 向前拉取 50 条历史消息 msg-100..msg-149（每项实测 80px）
      const olderIds = Array.from({ length: 50 }, (_, i) => `msg-${100 + i}`);
      const estimates = olderIds.map((id) => ({ id, height: 80 }));

      const result = vsm.prependIdsWithScrollAnchor(
        olderIds,
        currentScrollTop,
        estimates
      );

      // 验证新增 50 项，总长度为 100
      expect(result.newOrder.length).toBe(100);
      expect(result.newOrder[0]).toBe('msg-100');
      expect(result.newOrder[50]).toBe('msg-150');

      // 50 条新消息总高度增量为 50 * 80px = 4000px
      expect(result.heightDelta).toBe(4000);
      // 补偿后的 scrollTop 必须正好是 260 + 4000 = 4260px
      expect(result.compensatedScrollTop).toBe(4260);

      // 关键几何断言：在补偿后的 scrollTop = 4260px 下，视口顶部可见元素依然精确是 msg-153！
      const newVisibleIndex = vsm.findIndexAtOffset(
        result.compensatedScrollTop
      );
      expect(vsm.getOrder()[newVisibleIndex]).toBe('msg-153');

      // 且其相对视口顶部的相对偏移量依然精确为 20px（0 像素漂移！）
      const newMsgOffset = vsm.getOffset(newVisibleIndex);
      const relativeOffset = result.compensatedScrollTop - newMsgOffset;
      expect(relativeOffset).toBe(20);
    });

    it('loadOlderMessagesWithScrollAnchor 复合原语打通数据拉取与滚动锚点端到端闭环', async () => {
      const allMsgs = createMockHistoryMessages(100);
      mockTauriCommand('load_session_body', async (args) => {
        const { limit = 50, beforeSeq } = args as {
          limit?: number;
          beforeSeq?: number;
        };
        if (beforeSeq !== undefined) {
          const end = Math.min(beforeSeq, allMsgs.length);
          const start = Math.max(0, end - limit);
          return allMsgs.slice(start, end);
        }
        return allMsgs;
      });

      const vsm = new VirtualScrollManager(100);
      const currentIds = allMsgs.slice(50).map((m) => m.id);
      vsm.syncOrder(currentIds);
      for (const id of currentIds) {
        vsm.setActual(id, 100);
      }

      const initialScrollTop = 150; // msg-51 内 50px
      const res = await loadOlderMessagesWithScrollAnchor(
        'sess-anchored',
        50,
        50,
        vsm,
        initialScrollTop
      );

      expect(res.messages.length).toBe(50);
      expect(res.hasMore).toBe(false); // 触顶 (seq 0)
      expect(res.oldestSeq).toBe(0);
      expect(res.newOrder.length).toBe(100);
      // 50 条历史消息每条 fallback 100px -> 5000px 增量
      expect(res.heightDelta).toBe(5000);
      expect(res.compensatedScrollTop).toBe(5150);

      // 视口中同一项的几何偏移绝对静止
      const anchorIdx = vsm.findIndexAtOffset(res.compensatedScrollTop);
      expect(vsm.getOrder()[anchorIdx]).toBe('msg-51');
      expect(res.compensatedScrollTop - vsm.getOffset(anchorIdx)).toBe(50);
    });
  });

  describe('5. 引擎事件水合向前拉取与窗口化支持', () => {
    it('loadOlderEngineMessages 从核心事件流中按序列号向前增量过滤投影', async () => {
      fakeTransport.request.mockResolvedValueOnce({
        events: [
          {
            type: 'message-end',
            sequence: 10,
            message: { role: 'user', content: 'older-1' },
          },
          {
            type: 'message-end',
            sequence: 20,
            message: { role: 'assistant', content: 'older-2' },
          },
          {
            type: 'message-end',
            sequence: 30,
            message: { role: 'user', content: 'older-3' },
          },
        ],
        nextAfterSequence: 30,
        hasMore: false,
      });

      const older = await loadOlderEngineMessages('session-engine', 25, 10);
      // 应仅包含 sequence < 25 的事件投影 (seq 10 与 20)
      expect(older.messages.length).toBe(2);
      expect(older.oldestSequence).toBe(10);
      expect(older.hasMore).toBe(true);
    });

    it('hydrateSessionMessagesFromEngine 支持 windowSize 窗口化模式', async () => {
      fakeTransport.request.mockResolvedValueOnce({
        events: [
          {
            type: 'message-end',
            sequence: 1,
            message: { role: 'user', content: 'm1' },
          },
          {
            type: 'message-end',
            sequence: 2,
            message: { role: 'assistant', content: 'm2' },
          },
          {
            type: 'message-end',
            sequence: 3,
            message: { role: 'user', content: 'm3' },
          },
          {
            type: 'message-end',
            sequence: 4,
            message: { role: 'assistant', content: 'm4' },
          },
        ],
        nextAfterSequence: 4,
        hasMore: false,
      });

      const res = await hydrateSessionMessagesFromEngine(
        'session-engine-window',
        {
          windowSize: 2,
        }
      );
      expect(res.ok).toBe(true);
      expect(res.messages.length).toBe(2);
      expect(res.messages[0]!.text).toBe('m3');
      expect(res.messages[1]!.text).toBe('m4');
      expect(res.hasMore).toBe(true);
    });
  });
});
