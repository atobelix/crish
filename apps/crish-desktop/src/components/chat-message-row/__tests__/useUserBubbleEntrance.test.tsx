// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useUserBubbleEntrance,
  _resetAnimatedMessageIdsForTesting,
} from '../useUserBubbleEntrance';

describe('useUserBubbleEntrance hook', () => {
  beforeEach(() => {
    _resetAnimatedMessageIdsForTesting();
    vi.useRealTimers();
  });

  it('activates entrance animation for recently created messages (within 2s)', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-new-1', now - 150)
    );

    expect(result.current.isEntering).toBe(true);
  });

  it('skips entrance animation for historical messages (> 2000ms old)', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-old-1', now - 3500)
    );

    expect(result.current.isEntering).toBe(false);
  });

  it('skips entrance animation for invalid or non-positive timestamps', () => {
    const r1 = renderHook(() => useUserBubbleEntrance('msg-inv-1', undefined));
    expect(r1.result.current.isEntering).toBe(false);

    const r2 = renderHook(() => useUserBubbleEntrance('msg-inv-2', 0));
    expect(r2.result.current.isEntering).toBe(false);

    const r3 = renderHook(() => useUserBubbleEntrance('msg-inv-3', -100));
    expect(r3.result.current.isEntering).toBe(false);

    const r4 = renderHook(() => useUserBubbleEntrance('msg-inv-4', NaN));
    expect(r4.result.current.isEntering).toBe(false);
  });

  it('skips entrance animation for empty message ID', () => {
    const now = Date.now();
    const { result } = renderHook(() => useUserBubbleEntrance('', now));
    expect(result.current.isEntering).toBe(false);
  });

  it('tolerates small clock skew up to 500ms in the future', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-skew-ok', now + 250)
    );
    expect(result.current.isEntering).toBe(true);
  });

  it('rejects timestamp too far in the future (> 500ms)', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-skew-bad', now + 800)
    );
    expect(result.current.isEntering).toBe(false);
  });

  it('prevents re-animating during virtual scrolling remounts', () => {
    const now = Date.now();
    // 第一次挂载：触发入场
    const hook1 = renderHook(() =>
      useUserBubbleEntrance('msg-virtual-1', now - 100)
    );
    expect(hook1.result.current.isEntering).toBe(true);

    // 虚拟滚动离开视口 unmount
    hook1.unmount();

    // 虚拟滚动再次滑入视口 remount：同一个 ID 绝不再次触发
    const hook2 = renderHook(() =>
      useUserBubbleEntrance('msg-virtual-1', now - 100)
    );
    expect(hook2.result.current.isEntering).toBe(false);
  });

  it('clears isEntering on handleAnimationEnd when target matches currentTarget', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-anim-end', now - 50)
    );
    expect(result.current.isEntering).toBe(true);

    const targetDiv = document.createElement('div');
    act(() => {
      result.current.handleAnimationEnd({
        target: targetDiv,
        currentTarget: targetDiv,
      } as unknown as React.AnimationEvent);
    });

    expect(result.current.isEntering).toBe(false);
  });

  it('ignores handleAnimationEnd when bubbling up from a child element', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-child-event', now - 50)
    );
    expect(result.current.isEntering).toBe(true);

    const parentDiv = document.createElement('div');
    const childDiv = document.createElement('span');
    act(() => {
      result.current.handleAnimationEnd({
        target: childDiv,
        currentTarget: parentDiv,
      } as unknown as React.AnimationEvent);
    });

    // 依然维持 entering 状态，不受子节点动画冒泡干扰
    expect(result.current.isEntering).toBe(true);
  });

  it('clears isEntering via safety timer after 350ms if animationEnd never fires', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const { result } = renderHook(() =>
      useUserBubbleEntrance('msg-timeout-test', now)
    );
    expect(result.current.isEntering).toBe(true);

    act(() => {
      vi.advanceTimersByTime(360);
    });

    expect(result.current.isEntering).toBe(false);
  });

  it('evicts oldest entries when FIFO Ring Set exceeds 500 items', () => {
    const now = Date.now();
    // 填充 500 个条目
    for (let i = 0; i < 500; i++) {
      const { unmount } = renderHook(() =>
        useUserBubbleEntrance(`bulk-msg-${i}`, now)
      );
      unmount();
    }

    // 此时 bulk-msg-0 已在缓存中，再次挂载不应进入
    const probeOld = renderHook(() => useUserBubbleEntrance('bulk-msg-0', now));
    expect(probeOld.result.current.isEntering).toBe(false);
    probeOld.unmount();

    // 插入第 501 个条目，触发 FIFO 淘汰 bulk-msg-0
    const hook501 = renderHook(() =>
      useUserBubbleEntrance('bulk-msg-500', now)
    );
    hook501.unmount();

    // bulk-msg-0 已被淘汰，若时间窗口仍然合格，可重新获得动画资格
    const probeEvicted = renderHook(() =>
      useUserBubbleEntrance('bulk-msg-0', now)
    );
    expect(probeEvicted.result.current.isEntering).toBe(true);
  });
});
