/* eslint-disable max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChatScrollRegistry,
  chatScrollRegistry,
  clearAllSessionScroll,
  clearSessionLive,
  clearSessionScroll,
  isSessionLive,
  restoreSessionScroll,
  saveSessionScroll,
  setSessionLive,
  type SessionScrollSnapshot,
} from '../chatScrollRegistry';

describe('chatScrollRegistry 跨会话滚动记忆与恢复注册表', () => {
  beforeEach(() => {
    chatScrollRegistry.clearAll();
    chatScrollRegistry.clearSessionLive();
    chatScrollRegistry.setLivePredicate(null);
  });

  afterEach(() => {
    chatScrollRegistry.dispose();
  });

  describe('1. 基础保存、读取与精确快照契约', () => {
    it('能够准确保存并恢复会话滚动快照的全部字段', () => {
      const snapshot: SessionScrollSnapshot = {
        scrollTop: 1280,
        observedTopKey: 'msg-turn-4',
        observedTopOffset: -15.5,
        isAtBottom: false,
        timestamp: 1725000000000,
        heightSnapshot: {
          'msg-turn-1': 120,
          'msg-turn-2': 240,
        },
      };

      saveSessionScroll('session-alpha', snapshot);

      const restored = restoreSessionScroll('session-alpha');
      expect(restored).toBeDefined();
      expect(restored).toEqual(snapshot);
      expect(chatScrollRegistry.size).toBe(1);
      expect(chatScrollRegistry.has('session-alpha')).toBe(true);
    });

    it('读取未保存过的会话应返回 undefined', () => {
      expect(restoreSessionScroll('unknown-session')).toBeUndefined();
      expect(chatScrollRegistry.has('unknown-session')).toBe(false);
    });

    it('具备外部引用隔离与防御性克隆，避免被外部修改污染', () => {
      const original: SessionScrollSnapshot = {
        scrollTop: 500,
        isAtBottom: false,
        timestamp: 1000,
        heightSnapshot: { 'node-1': 100 },
      };

      saveSessionScroll('session-clone', original);

      // 尝试在保存后篡改原始对象
      original.scrollTop = 9999;
      if (original.heightSnapshot) {
        original.heightSnapshot['node-1'] = 9999;
      }

      const restored = restoreSessionScroll('session-clone');
      expect(restored?.scrollTop).toBe(500);
      expect(restored?.heightSnapshot?.['node-1']).toBe(100);

      // 尝试篡改恢复出来的对象
      if (restored) {
        restored.scrollTop = 8888;
      }
      const restoredAgain = restoreSessionScroll('session-clone');
      expect(restoredAgain?.scrollTop).toBe(500);
    });

    it('非法或空入参应静默防御，不抛异常也不破坏状态', () => {
      // @ts-expect-error 测试异常入参
      saveSessionScroll('', null);
      // @ts-expect-error 测试异常入参
      saveSessionScroll(null, { scrollTop: 100 });
      // @ts-expect-error 测试异常入参
      expect(restoreSessionScroll('')).toBeUndefined();
      // @ts-expect-error 测试异常入参
      expect(restoreSessionScroll(null)).toBeUndefined();
      expect(chatScrollRegistry.size).toBe(0);
    });
  });

  describe('2. 会话状态更新与幂等覆盖', () => {
    it('多次保存相同 sessionId 应覆盖旧值，且注册表条数不递增', () => {
      const snap1: SessionScrollSnapshot = {
        scrollTop: 100,
        isAtBottom: false,
        timestamp: 1000,
      };
      const snap2: SessionScrollSnapshot = {
        scrollTop: 450,
        observedTopKey: 'msg-node-9',
        observedTopOffset: -8,
        isAtBottom: true,
        timestamp: 2000,
      };

      saveSessionScroll('session-update', snap1);
      expect(chatScrollRegistry.size).toBe(1);
      expect(restoreSessionScroll('session-update')?.scrollTop).toBe(100);

      saveSessionScroll('session-update', snap2);
      expect(chatScrollRegistry.size).toBe(1);
      const updated = restoreSessionScroll('session-update');
      expect(updated?.scrollTop).toBe(450);
      expect(updated?.observedTopKey).toBe('msg-node-9');
      expect(updated?.isAtBottom).toBe(true);
    });
  });

  describe('3. LRU 淘汰算法与容量防泄漏保护', () => {
    it('小容量测试（maxSessions = 3）：超出容量时自动逐出最久未使用的会话', () => {
      const registry = new ChatScrollRegistry({ maxSessions: 3 });

      registry.save('session-1', { scrollTop: 10, isAtBottom: false, timestamp: 1 });
      registry.save('session-2', { scrollTop: 20, isAtBottom: false, timestamp: 2 });
      registry.save('session-3', { scrollTop: 30, isAtBottom: false, timestamp: 3 });

      expect(registry.getLRUKeys()).toEqual(['session-1', 'session-2', 'session-3']);
      expect(registry.size).toBe(3);

      // 插入第 4 个会话，最久未使用的 session-1 应被逐出
      registry.save('session-4', { scrollTop: 40, isAtBottom: false, timestamp: 4 });

      expect(registry.size).toBe(3);
      expect(registry.has('session-1')).toBe(false);
      expect(registry.restore('session-1')).toBeUndefined();
      expect(registry.getLRUKeys()).toEqual(['session-2', 'session-3', 'session-4']);
    });

    it('读取（restore）操作会更新访问时序，保护热点会话不被淘汰', () => {
      const registry = new ChatScrollRegistry({ maxSessions: 3 });

      registry.save('session-A', { scrollTop: 100, isAtBottom: false, timestamp: 1 });
      registry.save('session-B', { scrollTop: 200, isAtBottom: false, timestamp: 2 });
      registry.save('session-C', { scrollTop: 300, isAtBottom: false, timestamp: 3 });

      // 访问 session-A，将其时序重排至最新末尾
      const restoredA = registry.restore('session-A');
      expect(restoredA?.scrollTop).toBe(100);
      expect(registry.getLRUKeys()).toEqual(['session-B', 'session-C', 'session-A']);

      // 插入新会话 session-D，此时最久未访问的 session-B 被淘汰，session-A 留存
      registry.save('session-D', { scrollTop: 400, isAtBottom: false, timestamp: 4 });

      expect(registry.has('session-B')).toBe(false);
      expect(registry.has('session-A')).toBe(true);
      expect(registry.has('session-C')).toBe(true);
      expect(registry.has('session-D')).toBe(true);
      expect(registry.getLRUKeys()).toEqual(['session-C', 'session-A', 'session-D']);
    });

    it('更新（save 已存在 key）操作会刷新其时序至最新', () => {
      const registry = new ChatScrollRegistry({ maxSessions: 3 });

      registry.save('s1', { scrollTop: 10, isAtBottom: false, timestamp: 1 });
      registry.save('s2', { scrollTop: 20, isAtBottom: false, timestamp: 2 });
      registry.save('s3', { scrollTop: 30, isAtBottom: false, timestamp: 3 });

      // 更新 s1
      registry.save('s1', { scrollTop: 15, isAtBottom: false, timestamp: 4 });
      expect(registry.getLRUKeys()).toEqual(['s2', 's3', 's1']);

      // 插入 s4，s2 最旧被淘汰
      registry.save('s4', { scrollTop: 40, isAtBottom: false, timestamp: 5 });
      expect(registry.has('s2')).toBe(false);
      expect(registry.has('s1')).toBe(true);
    });

    it('默认实例严格限制最大 50 个活跃会话，连续存入 60 个自动淘汰前 10 个', () => {
      expect(chatScrollRegistry.maxSessions).toBe(50);

      // 存入 60 个会话
      for (let i = 1; i <= 60; i++) {
        saveSessionScroll(`batch-session-${i}`, {
          scrollTop: i * 10,
          isAtBottom: false,
          timestamp: Date.now() + i,
        });
      }

      expect(chatScrollRegistry.size).toBe(50);

      // 前 10 个 (1 ~ 10) 应该已被 LRU 逐出
      for (let i = 1; i <= 10; i++) {
        expect(restoreSessionScroll(`batch-session-${i}`)).toBeUndefined();
      }

      // 后 50 个 (11 ~ 60) 应完整存在
      for (let i = 11; i <= 60; i++) {
        expect(restoreSessionScroll(`batch-session-${i}`)?.scrollTop).toBe(i * 10);
      }
    });

    it('动态缩减 maxSessions 时立即裁剪多余的最旧条目', () => {
      const registry = new ChatScrollRegistry({ maxSessions: 5 });
      for (let i = 1; i <= 5; i++) {
        registry.save(`s-${i}`, { scrollTop: i, isAtBottom: false, timestamp: i });
      }
      expect(registry.size).toBe(5);

      // 调整为 2
      registry.maxSessions = 2;
      expect(registry.size).toBe(2);
      expect(registry.getLRUKeys()).toEqual(['s-4', 's-5']);
    });

    it('peek 读取快照不改变 LRU 访问次序', () => {
      const registry = new ChatScrollRegistry({ maxSessions: 3 });
      registry.save('s1', { scrollTop: 10, isAtBottom: false, timestamp: 1 });
      registry.save('s2', { scrollTop: 20, isAtBottom: false, timestamp: 2 });
      registry.save('s3', { scrollTop: 30, isAtBottom: false, timestamp: 3 });

      // peek s1
      const peeked = registry.peek('s1');
      expect(peeked?.scrollTop).toBe(10);
      // 次序依然是 s1, s2, s3
      expect(registry.getLRUKeys()).toEqual(['s1', 's2', 's3']);
    });
  });

  describe('4. 清理与重置操作', () => {
    it('clearSessionScroll 仅移除指定会话，不影响其他会话', () => {
      saveSessionScroll('s-a', { scrollTop: 10, isAtBottom: false, timestamp: 1 });
      saveSessionScroll('s-b', { scrollTop: 20, isAtBottom: false, timestamp: 2 });

      clearSessionScroll('s-a');

      expect(restoreSessionScroll('s-a')).toBeUndefined();
      expect(restoreSessionScroll('s-b')?.scrollTop).toBe(20);
      expect(chatScrollRegistry.size).toBe(1);
    });

    it('clearAllSessionScroll 清空全部会话滚动快照', () => {
      saveSessionScroll('s-1', { scrollTop: 10, isAtBottom: false, timestamp: 1 });
      saveSessionScroll('s-2', { scrollTop: 20, isAtBottom: false, timestamp: 2 });

      clearAllSessionScroll();

      expect(chatScrollRegistry.size).toBe(0);
      expect(restoreSessionScroll('s-1')).toBeUndefined();
      expect(restoreSessionScroll('s-2')).toBeUndefined();
    });
  });

  describe('5. Live 流式会话判定与优先贴底行为', () => {
    it('静态历史会话（非 Live）返回精确保存的快照，isAtBottom 保持原值', () => {
      saveSessionScroll('static-session', {
        scrollTop: 800,
        observedTopKey: 'anchor-node-3',
        observedTopOffset: -20,
        isAtBottom: false,
        timestamp: 1000,
      });

      expect(isSessionLive('static-session')).toBe(false);

      const restored = restoreSessionScroll('static-session');
      expect(restored?.isAtBottom).toBe(false);
      expect(restored?.scrollTop).toBe(800);
      expect(restored?.observedTopKey).toBe('anchor-node-3');
    });

    it('处于 live 流式进行中的会话，恢复时优先推荐贴底（isAtBottom = true）', () => {
      // 用户在翻阅上方历史期间保存了快照
      saveSessionScroll('live-session', {
        scrollTop: 350,
        observedTopKey: 'anchor-node-2',
        observedTopOffset: -10,
        isAtBottom: false,
        timestamp: 1000,
      });

      // 标记该会话后台处于 live 流式生成中
      setSessionLive('live-session', true);
      expect(isSessionLive('live-session')).toBe(true);

      // 切回恢复时，优先推荐贴底以保证最新流式 Token 实时可见
      const restored = restoreSessionScroll('live-session');
      expect(restored).toBeDefined();
      expect(restored?.isAtBottom).toBe(true);
      // 物理坐标与语义锚点仍完整保留
      expect(restored?.scrollTop).toBe(350);
      expect(restored?.observedTopKey).toBe('anchor-node-2');

      // 当流式生成结束，取消 live 标记后，恢复精确快照
      setSessionLive('live-session', false);
      expect(isSessionLive('live-session')).toBe(false);

      const restoredAfterLive = restoreSessionScroll('live-session');
      expect(restoredAfterLive?.isAtBottom).toBe(false);
    });

    it('clearSessionLive 支持精确清除单个或全部 live 标记', () => {
      setSessionLive('live-1', true);
      setSessionLive('live-2', true);

      clearSessionLive('live-1');
      expect(isSessionLive('live-1')).toBe(false);
      expect(isSessionLive('live-2')).toBe(true);

      clearSessionLive();
      expect(isSessionLive('live-2')).toBe(false);
    });

    it('支持外部注入 livePredicate 函数', () => {
      const liveSet = new Set(['ext-session-1', 'ext-session-2']);
      chatScrollRegistry.setLivePredicate((id) => liveSet.has(id));

      expect(isSessionLive('ext-session-1')).toBe(true);
      expect(isSessionLive('ext-session-3')).toBe(false);

      saveSessionScroll('ext-session-1', {
        scrollTop: 100,
        isAtBottom: false,
        timestamp: 100,
      });
      const restored = restoreSessionScroll('ext-session-1');
      expect(restored?.isAtBottom).toBe(true);
    });

    it('支持 fallbackToBottomIfLive 选项：无快照的 live 会话返回默认贴底快照', () => {
      setSessionLive('new-live-session', true);

      // 默认情况下，无快照返回 undefined
      expect(restoreSessionScroll('new-live-session')).toBeUndefined();

      // 开启 fallbackToBottomIfLive，返回贴底初始快照
      const fallback = restoreSessionScroll('new-live-session', {
        fallbackToBottomIfLive: true,
      });
      expect(fallback).toBeDefined();
      expect(fallback?.isAtBottom).toBe(true);
      expect(fallback?.scrollTop).toBe(0);
    });

    it('支持 overrideLive 选项覆盖 live 行为', () => {
      saveSessionScroll('override-session', {
        scrollTop: 120,
        isAtBottom: false,
        timestamp: 100,
      });
      setSessionLive('override-session', true);

      // overrideLive: false 强制返回原始静态快照
      const raw = restoreSessionScroll('override-session', {
        overrideLive: false,
      });
      expect(raw?.isAtBottom).toBe(false);
    });
  });

  describe('6. 纯函数接口与单例状态双向贯通', () => {
    it('纯函数直接操作单例 chatScrollRegistry', () => {
      saveSessionScroll('sync-test', {
        scrollTop: 777,
        isAtBottom: true,
        timestamp: 999,
      });

      expect(chatScrollRegistry.restore('sync-test')?.scrollTop).toBe(777);

      chatScrollRegistry.save('sync-test-2', {
        scrollTop: 888,
        isAtBottom: false,
        timestamp: 1000,
      });

      expect(restoreSessionScroll('sync-test-2')?.scrollTop).toBe(888);
    });
  });
});
