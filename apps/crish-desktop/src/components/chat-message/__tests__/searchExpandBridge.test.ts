// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/chat-message/__tests__/searchExpandBridge.test.ts
 *
 * 双轨全文检索穿透桥接模块自动化单元测试套件（DIM-05 专项规范）
 *
 * 验证目标：
 * 1. 内存状态设置、获取、切换与默认值回退；
 * 2. 细粒度反应式订阅、状态变更通知、同值跳过与取消订阅生命周期；
 * 3. 跨会话消息隔离与精细化会话清理（清理当前会话不影响其他会话，全量清理彻底重置）；
 * 4. jumpToSearchHit 的 VSM 绝对坐标计算、滚动驱动及自动展开联动（含 Mock 与真实 VirtualScrollManager 实例）；
 * 5. 异常容错（空参数、未命中下标、scrollTo 降级 scrollTop、监听器报错隔离）；
 * 6. React Hook (useMessageProcessExpanded) 响应式集成。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { VirtualScrollManager } from '../../../api/VirtualScrollManager';
import {
  isMessageProcessExpanded,
  setMessageProcessExpanded,
  toggleMessageProcessExpanded,
  expandMessageProcess,
  collapseMessageProcess,
  subscribeMessageProcessExpansion,
  clearMessageProcessExpansionState,
  clearMessageProcessSubscribers,
  bindMessageToSession,
  bindMessagesToSession,
  getMessageSession,
  getAllExpandedMessageIds,
  jumpToSearchHit,
  useMessageProcessExpanded,
} from '../searchExpandBridge';

describe('searchExpandBridge — 双轨全文检索穿透桥接模块测试套件', () => {
  beforeEach(() => {
    clearMessageProcessExpansionState();
    clearMessageProcessSubscribers();
  });

  afterEach(() => {
    clearMessageProcessExpansionState();
    clearMessageProcessSubscribers();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 一、内存状态读写、默认值与切换测试
  // ──────────────────────────────────────────────────────────────────────────
  describe('一、内存状态读写与切换', () => {
    it('未设置状态时，默认返回 false，或返回显式传入的 defaultVal', () => {
      expect(isMessageProcessExpanded('msg-101')).toBe(false);
      expect(isMessageProcessExpanded('msg-101', false)).toBe(false);
      expect(isMessageProcessExpanded('msg-101', true)).toBe(true);
      expect(isMessageProcessExpanded('')).toBe(false);
    });

    it('显式设置 setMessageProcessExpanded 后，返回实际存储状态，忽略 defaultVal', () => {
      setMessageProcessExpanded('msg-1', true);
      expect(isMessageProcessExpanded('msg-1')).toBe(true);
      expect(isMessageProcessExpanded('msg-1', false)).toBe(true);

      setMessageProcessExpanded('msg-1', false);
      expect(isMessageProcessExpanded('msg-1')).toBe(false);
      expect(isMessageProcessExpanded('msg-1', true)).toBe(false);
    });

    it('toggleMessageProcessExpanded 能够按逻辑正向和反向切换展开状态', () => {
      // 初始未设置（默认收起） -> 切换为展开
      toggleMessageProcessExpanded('msg-toggle');
      expect(isMessageProcessExpanded('msg-toggle')).toBe(true);

      // 再次切换 -> 切换回收起
      toggleMessageProcessExpanded('msg-toggle');
      expect(isMessageProcessExpanded('msg-toggle')).toBe(false);

      // 第三次切换 -> 再次展开
      toggleMessageProcessExpanded('msg-toggle');
      expect(isMessageProcessExpanded('msg-toggle')).toBe(true);
    });

    it('expandMessageProcess 与 collapseMessageProcess 语义化操作', () => {
      collapseMessageProcess('msg-sem');
      expect(isMessageProcessExpanded('msg-sem')).toBe(false);

      expandMessageProcess('msg-sem');
      expect(isMessageProcessExpanded('msg-sem')).toBe(true);

      collapseMessageProcess('msg-sem');
      expect(isMessageProcessExpanded('msg-sem')).toBe(false);
    });

    it('getAllExpandedMessageIds 返回当前所有处于展开状态的消息 ID 列表', () => {
      setMessageProcessExpanded('msg-a', true);
      setMessageProcessExpanded('msg-b', false);
      setMessageProcessExpanded('msg-c', true);

      const expanded = getAllExpandedMessageIds();
      expect(expanded.sort()).toEqual(['msg-a', 'msg-c']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 二、反应式订阅与监听生命周期
  // ──────────────────────────────────────────────────────────────────────────
  describe('二、反应式订阅与监听生命周期', () => {
    it('状态变更时精准触发已注册的回调函数', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeMessageProcessExpansion('msg-sub', callback);

      setMessageProcessExpanded('msg-sub', true);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(true);

      setMessageProcessExpanded('msg-sub', false);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith(false);

      unsubscribe();
    });

    it('设置相同的值时短路跳过，不触发冗余重绘回调', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeMessageProcessExpansion('msg-dup', callback);

      setMessageProcessExpanded('msg-dup', true);
      expect(callback).toHaveBeenCalledTimes(1);

      // 再次设置相同的值 true，应不触发
      setMessageProcessExpanded('msg-dup', true);
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('支持同一消息注册多个订阅者，状态变更时全员广播', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = subscribeMessageProcessExpansion('msg-multi', cb1);
      const unsub2 = subscribeMessageProcessExpansion('msg-multi', cb2);

      toggleMessageProcessExpanded('msg-multi');
      expect(cb1).toHaveBeenCalledWith(true);
      expect(cb2).toHaveBeenCalledWith(true);

      unsub1();
      unsub2();
    });

    it('执行取消订阅后，后续状态变更不再通知已注销的回调', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeMessageProcessExpansion('msg-unsub', callback);

      setMessageProcessExpanded('msg-unsub', true);
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      setMessageProcessExpanded('msg-unsub', false);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('某个订阅者执行抛出异常时，被隔离捕获，不阻塞其他订阅者与主流程', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const badCallback = vi.fn().mockImplementation(() => {
        throw new Error('Explosion inside listener');
      });
      const goodCallback = vi.fn();

      const unsub1 = subscribeMessageProcessExpansion('msg-err', badCallback);
      const unsub2 = subscribeMessageProcessExpansion('msg-err', goodCallback);

      expect(() => {
        setMessageProcessExpanded('msg-err', true);
      }).not.toThrow();

      expect(badCallback).toHaveBeenCalledTimes(1);
      expect(goodCallback).toHaveBeenCalledTimes(1);
      expect(goodCallback).toHaveBeenCalledWith(true);

      unsub1();
      unsub2();
      consoleSpy.mockRestore();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 三、跨会话隔离与会话级生命周期清理
  // ──────────────────────────────────────────────────────────────────────────
  describe('三、跨会话隔离与会话级生命周期清理', () => {
    it('支持消息与会话的自动绑定与手动绑定', () => {
      setMessageProcessExpanded('msg-s1', true, 'session-alpha');
      expect(getMessageSession('msg-s1')).toBe('session-alpha');

      bindMessageToSession('session-beta', 'msg-s2');
      expect(getMessageSession('msg-s2')).toBe('session-beta');

      bindMessagesToSession('session-gamma', ['msg-s3', 'msg-s4']);
      expect(getMessageSession('msg-s3')).toBe('session-gamma');
      expect(getMessageSession('msg-s4')).toBe('session-gamma');
    });

    it('当消息重新绑定到新会话时，自动迁移并清理旧会话关联', () => {
      setMessageProcessExpanded('msg-mov', true, 'session-old');
      expect(getMessageSession('msg-mov')).toBe('session-old');

      bindMessageToSession('session-new', 'msg-mov');
      expect(getMessageSession('msg-mov')).toBe('session-new');

      // 清理旧会话，不应波及已迁移到新会话的消息
      clearMessageProcessExpansionState('session-old');
      expect(isMessageProcessExpanded('msg-mov')).toBe(true);

      // 清理新会话，该消息状态被移除
      clearMessageProcessExpansionState('session-new');
      expect(isMessageProcessExpanded('msg-mov')).toBe(false);
    });

    it('精准清理指定会话：只清除该会话的消息状态，不影响其他会话', () => {
      const cbA = vi.fn();
      const cbB = vi.fn();

      subscribeMessageProcessExpansion('msg-A1', cbA);
      subscribeMessageProcessExpansion('msg-B1', cbB);

      setMessageProcessExpanded('msg-A1', true, 'session-A');
      setMessageProcessExpanded('msg-A2', true, 'session-A');
      setMessageProcessExpanded('msg-B1', true, 'session-B');

      expect(isMessageProcessExpanded('msg-A1')).toBe(true);
      expect(isMessageProcessExpanded('msg-A2')).toBe(true);
      expect(isMessageProcessExpanded('msg-B1')).toBe(true);

      // 仅清理 session-A
      clearMessageProcessExpansionState('session-A');

      // session-A 下的消息被重置，且曾为展开的消息收到 false 通知
      expect(isMessageProcessExpanded('msg-A1')).toBe(false);
      expect(isMessageProcessExpanded('msg-A2')).toBe(false);
      expect(cbA).toHaveBeenCalledWith(false);

      // session-B 下的消息完全保持不变
      expect(isMessageProcessExpanded('msg-B1')).toBe(true);
      expect(cbB).not.toHaveBeenCalledWith(false);
    });

    it('未传 sessionId 调用 clearMessageProcessExpansionState 时，全量重置所有会话与消息', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      subscribeMessageProcessExpansion('m1', cb1);
      subscribeMessageProcessExpansion('m2', cb2);

      setMessageProcessExpanded('m1', true, 'sess-1');
      setMessageProcessExpanded('m2', true, 'sess-2');
      setMessageProcessExpanded('m3-nosess', true);

      clearMessageProcessExpansionState();

      expect(isMessageProcessExpanded('m1')).toBe(false);
      expect(isMessageProcessExpanded('m2')).toBe(false);
      expect(isMessageProcessExpanded('m3-nosess')).toBe(false);
      expect(getAllExpandedMessageIds()).toEqual([]);

      expect(cb1).toHaveBeenCalledWith(false);
      expect(cb2).toHaveBeenCalledWith(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 四、jumpToSearchHit 的 VSM 坐标计算、滚动驱动与自动展开联动
  // ──────────────────────────────────────────────────────────────────────────
  describe('四、jumpToSearchHit 检索穿透与坐标寻址联动', () => {
    it('基于 Mock VSM：精准根据 getOrder / indexOf / getOffset 计算 Y 偏移并执行滚动与自动展开', () => {
      const mockVsm = {
        getOrder: vi.fn().mockReturnValue(['msg-0', 'msg-hit', 'msg-2']),
        getOffset: vi.fn().mockImplementation((idx: number) => idx * 150),
      };

      const scroller = document.createElement('div');
      scroller.scrollTo = vi.fn();

      const hitSubscriber = vi.fn();
      subscribeMessageProcessExpansion('msg-hit', hitSubscriber);

      expect(isMessageProcessExpanded('msg-hit')).toBe(false);

      // 执行检索穿透跳转
      jumpToSearchHit('msg-hit', mockVsm, scroller);

      // 断言 1：正确调用 VSM 获取顺序与偏移量（下标 1，1 * 150 = 150）
      expect(mockVsm.getOrder).toHaveBeenCalled();
      expect(mockVsm.getOffset).toHaveBeenCalledWith(1);

      // 断言 2：容器执行绝对定位滚动 scrollTo({ top: 150, behavior: 'auto' })
      expect(scroller.scrollTo).toHaveBeenCalledWith({
        top: 150,
        behavior: 'auto',
      });

      // 断言 3：自动触发 expandMessageProcess，状态变为 true 并通知订阅者
      expect(isMessageProcessExpanded('msg-hit')).toBe(true);
      expect(hitSubscriber).toHaveBeenCalledWith(true);
    });

    it('与真实 VirtualScrollManager 实例联动：利用 Fenwick Tree 前缀和求绝对高度并跳变', () => {
      const realVsm = new VirtualScrollManager(120);
      realVsm.syncOrder(['row-0', 'row-1', 'row-target', 'row-3']);

      // 模拟前两行 DOM 渲染测高：row-0 高 80px，row-1 高 220px
      realVsm.setActual('row-0', 80);
      realVsm.setActual('row-1', 220);

      // row-target 的理论前缀和偏移量 = 80 + 220 = 300px
      expect(realVsm.getOffset(2)).toBe(300);

      const scroller = document.createElement('div');
      scroller.scrollTo = vi.fn();

      jumpToSearchHit('row-target', realVsm, scroller);

      expect(scroller.scrollTo).toHaveBeenCalledWith({
        top: 300,
        behavior: 'auto',
      });
      expect(isMessageProcessExpanded('row-target')).toBe(true);
    });

    it('当 DOM scroller 未实现 scrollTo 时（如旧环境或简单容器），降级写入 scrollTop', () => {
      const mockVsm = {
        getOrder: () => ['m-fallback'],
        getOffset: () => 480,
      };

      const scroller = document.createElement('div');
      // @ts-expect-error 故意模拟无 scrollTo 方法
      scroller.scrollTo = undefined;
      scroller.scrollTop = 0;

      jumpToSearchHit('m-fallback', mockVsm, scroller);

      expect(scroller.scrollTop).toBe(480);
      expect(isMessageProcessExpanded('m-fallback')).toBe(true);
    });

    it('当目标 msgId 在 VSM 列表中不存在（indexOf === -1）时，安全跳过，不滚动且不误展开', () => {
      const mockVsm = {
        getOrder: () => ['msg-1', 'msg-2'],
        getOffset: vi.fn(),
      };

      const scroller = document.createElement('div');
      scroller.scrollTo = vi.fn();

      jumpToSearchHit('msg-non-existent', mockVsm, scroller);

      expect(mockVsm.getOffset).not.toHaveBeenCalled();
      expect(scroller.scrollTo).not.toHaveBeenCalled();
      expect(isMessageProcessExpanded('msg-non-existent')).toBe(false);
    });

    it('边界异常传参保护：空消息 ID、空 VSM 或空 scroller 零崩溃静默退出', () => {
      const scroller = document.createElement('div');
      scroller.scrollTo = vi.fn();

      expect(() => jumpToSearchHit('', null, scroller)).not.toThrow();
      expect(() => jumpToSearchHit('msg-1', null, scroller)).not.toThrow();
      expect(() => jumpToSearchHit('msg-1', {}, null as any)).not.toThrow();
      expect(scroller.scrollTo).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 五、React Hook useMessageProcessExpanded 集成测试
  // ──────────────────────────────────────────────────────────────────────────
  describe('五、React Hook 集成测试', () => {
    it('useMessageProcessExpanded 能够响应式随全局桥接状态变更而更新', () => {
      const { result } = renderHook(() =>
        useMessageProcessExpanded('hook-msg', false)
      );

      expect(result.current).toBe(false);

      // 通过桥接主动展开
      act(() => {
        setMessageProcessExpanded('hook-msg', true);
      });
      expect(result.current).toBe(true);

      // 通过桥接切换
      act(() => {
        toggleMessageProcessExpanded('hook-msg');
      });
      expect(result.current).toBe(false);
    });
  });
});
