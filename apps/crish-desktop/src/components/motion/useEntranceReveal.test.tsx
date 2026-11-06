// @vitest-environment jsdom
/**
 * 统一入场通道钩子行为钉：判定语义与 AN4（toolRevealState）同源——
 * 实况时间窗、呈现记忆、减动效降级、批次交错；外加本通道的
 * liveOnMount（运行时状态面）与 grow 变体的收尾契约。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { useEntranceReveal } from './useEntranceReveal';
import { _resetToolRevealStateForTesting } from '../chat-tool-call/toolRevealState';

function stubReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

describe('useEntranceReveal（统一入场通道）', () => {
  beforeEach(() => {
    _resetToolRevealStateForTesting();
    stubReducedMotion(false);
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('实况事件 + 新键 → 进入入场态', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-live-1', eventTs: now - 100 })
    );
    expect(result.current.entering).toBe(true);
    expect(result.current.delayMs).toBeGreaterThanOrEqual(0);
  });

  it('历史事件（出实况窗）→ 不入场', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-old-1', eventTs: now - 5000 })
    );
    expect(result.current.entering).toBe(false);
  });

  it('同键重挂载 → 呈现记忆拦截，不重播', () => {
    const now = Date.now();
    const first = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-mem-1', eventTs: now - 50 })
    );
    expect(first.result.current.entering).toBe(true);
    first.unmount();
    const second = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-mem-1', eventTs: now - 50 })
    );
    expect(second.result.current.entering).toBe(false);
  });

  it('replaceHit / disabled / 空键 → 不入场', () => {
    const now = Date.now();
    const r1 = renderHook(() =>
      useEntranceReveal({
        key: 'tool:t-rep-1',
        eventTs: now - 10,
        replaceHit: true,
      })
    );
    expect(r1.result.current.entering).toBe(false);
    const r2 = renderHook(() =>
      useEntranceReveal({
        key: 'tool:t-dis-1',
        eventTs: now - 10,
        disabled: true,
      })
    );
    expect(r2.result.current.entering).toBe(false);
    const r3 = renderHook(() => useEntranceReveal({ key: '' }));
    expect(r3.result.current.entering).toBe(false);
  });

  it('系统减动效 → 降级直出，不入场', () => {
    stubReducedMotion(true);
    const now = Date.now();
    const { result } = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-rm-1', eventTs: now - 10 })
    );
    expect(result.current.entering).toBe(false);
  });

  it('liveOnMount（运行时状态面）无事件戳 → 以挂载时刻判定入场', () => {
    const { result } = renderHook(() =>
      useEntranceReveal({ key: 'retry:1:network', liveOnMount: true })
    );
    expect(result.current.entering).toBe(true);
  });

  it('无事件戳且未声明 liveOnMount → 不入场（内容面历史安静）', () => {
    const { result } = renderHook(() =>
      useEntranceReveal({ key: 'seg:m1:k1' })
    );
    expect(result.current.entering).toBe(false);
  });

  it('同批相邻挂载领取交错延时（后到者延时不小于先到者）', () => {
    const now = Date.now();
    const a = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-stag-a', eventTs: now - 10 })
    );
    const b = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-stag-b', eventTs: now - 10 })
    );
    expect(a.result.current.entering).toBe(true);
    expect(b.result.current.entering).toBe(true);
    expect(b.result.current.delayMs).toBeGreaterThanOrEqual(
      a.result.current.delayMs
    );
  });

  it('animationend 收尾：entering 落回 false', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useEntranceReveal({ key: 'tool:t-end-1', eventTs: now - 10 })
    );
    expect(result.current.entering).toBe(true);
    act(() => {
      result.current.handleAnimationEnd();
    });
    expect(result.current.entering).toBe(false);
  });

  it('eventTs 迟到到达：首次判定无戳拒绝，到达后补判定入场（跟进二）', () => {
    const { result, rerender } = renderHook(
      ({ eventTs }: { eventTs?: number }) =>
        useEntranceReveal({ key: 'seg:m-late-1:text-0', eventTs }),
      { initialProps: { eventTs: undefined as number | undefined } }
    );
    expect(result.current.entering).toBe(false);
    act(() => {
      rerender({ eventTs: Date.now() - 10 });
    });
    expect(result.current.entering).toBe(true);
  });

  it('迟到到达的旧时间戳仍被实况窗拒绝（历史回放安静）', () => {
    const { result, rerender } = renderHook(
      ({ eventTs }: { eventTs?: number }) =>
        useEntranceReveal({ key: 'seg:m-late-2:text-0', eventTs }),
      { initialProps: { eventTs: undefined as number | undefined } }
    );
    expect(result.current.entering).toBe(false);
    act(() => {
      rerender({ eventTs: Date.now() - 60000 });
    });
    expect(result.current.entering).toBe(false);
  });

  it('已带戳判定拒绝后，换新戳不重判（一次判定仍为铁律）', () => {
    const { result, rerender } = renderHook(
      ({ eventTs }: { eventTs?: number }) =>
        useEntranceReveal({ key: 'seg:m-late-3:text-0', eventTs }),
      { initialProps: { eventTs: Date.now() - 5000 } }
    );
    expect(result.current.entering).toBe(false);
    act(() => {
      rerender({ eventTs: Date.now() - 10 });
    });
    expect(result.current.entering).toBe(false);
  });

  it('grow 变体：jsdom 零高时不锁死，animationend 后正常收尾', () => {
    const now = Date.now();
    let probe: ReturnType<typeof useEntranceReveal> | null = null;
    function Probe() {
      const e = useEntranceReveal({
        key: 'errbar:s1:m1',
        eventTs: now - 10,
        variant: 'grow',
      });
      probe = e;
      return (
        <div
          ref={e.rootRef}
          data-entering={e.entering ? 'true' : undefined}
          onAnimationEnd={e.handleAnimationEnd}
        >
          x
        </div>
      );
    }
    const { container } = render(<Probe />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('data-entering')).toBe('true');
    act(() => {
      probe?.handleAnimationEnd();
    });
    expect(el.getAttribute('data-entering')).toBeNull();
    expect(el.style.height).toBe('');
  });
});
