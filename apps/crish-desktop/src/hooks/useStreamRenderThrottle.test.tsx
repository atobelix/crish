// @vitest-environment jsdom
/**
 * useStreamRenderThrottle 测试（PE-02 T02.3 节流生效锚点）。
 *
 * 覆盖：
 *   1. 同帧多次更新合并为一次 setState（rAF 对齐刷新率）
 *   2. 视口外（visible=false）paused=true 且不调度渲染
 *   3. 完成态（isStreaming=false）立即同步，无 rAF 延迟
 *   4. 恢复可见后取最新文本渲染
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStreamRenderThrottle } from './useStreamRenderThrottle';

let rafCb: FrameRequestCallback | null = null;
let seq = 0;

beforeEach(() => {
  rafCb = null;
  seq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb;
    seq += 1;
    return seq;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fireRaf(): void {
  const cb = rafCb;
  rafCb = null;
  if (cb) act(() => cb(performance.now()));
}

describe('useStreamRenderThrottle', () => {
  it('同帧多次更新合并为一次（不每 delta 触发 state 更新）', () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) =>
        useStreamRenderThrottle(text, true, true),
      { initialProps: { text: 'a' } }
    );
    expect(result.current.text).toBe('a');

    // 同一帧内连续三次更新：rAF 未触发前只合并为最新
    rerender({ text: 'ab' });
    rerender({ text: 'abc' });
    rerender({ text: 'abcd' });
    expect(result.current.text).toBe('a');
    expect(rafCb).not.toBeNull();

    fireRaf();
    expect(result.current.text).toBe('abcd');
    expect(result.current.paused).toBe(false);
  });

  it('视口外 paused=true 且不调度渲染', () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) =>
        useStreamRenderThrottle(text, true, false),
      { initialProps: { text: 'a' } }
    );
    expect(result.current.paused).toBe(true);
    expect(rafCb).toBeNull();

    rerender({ text: 'ab' });
    rerender({ text: 'abc' });
    expect(rafCb).toBeNull();
    expect(result.current.text).toBe('a');
  });

  it('完成态立即同步（无 rAF 延迟）', () => {
    const { result } = renderHook(() =>
      useStreamRenderThrottle('final text', false, true)
    );
    expect(result.current.text).toBe('final text');
    expect(result.current.paused).toBe(false);
    expect(rafCb).toBeNull();
  });

  it('恢复可见后取最新文本渲染', () => {
    const { result, rerender } = renderHook(
      ({ text, visible }: { text: string; visible: boolean }) =>
        useStreamRenderThrottle(text, true, visible),
      { initialProps: { text: 'a', visible: false } }
    );
    expect(result.current.paused).toBe(true);

    rerender({ text: 'ab', visible: true });
    expect(result.current.paused).toBe(false);
    expect(result.current.text).toBe('a'); // rAF 尚未触发
    expect(rafCb).not.toBeNull();

    rerender({ text: 'abc', visible: true });
    fireRaf();
    expect(result.current.text).toBe('abc');
  });
});
