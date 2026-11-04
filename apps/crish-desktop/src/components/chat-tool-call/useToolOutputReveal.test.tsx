// @vitest-environment jsdom
/**
 * AN4 · useToolOutputReveal 行为钉（手动 rAF + 双时钟注入）：
 * - 挂载即有内容 = 基线（历史回放零动画、标记已呈现）；
 * - 空→非空到达：带内纯文本排空（前缀单调→全量→注册表清除）；
 * - 错误即时全量；结构化/巨量整块淡入（fading，animationEnd 收口，
 *   子元素冒泡事件不误收）；
 * - 小体量直出；Reduce Motion 直出；非实况完成时间戳直出。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useToolOutputReveal,
  type ToolOutputRevealInput,
} from './useToolOutputReveal';
import {
  _resetToolRevealStateForTesting,
  hasActiveToolDrain,
  hasPresentedOutput,
} from './toolRevealState';

let nowMs = 0;
const rafQueue = new Map<number, FrameRequestCallback>();
let rafSeq = 0;

function stepFrames(count: number, stepMs = 16) {
  for (let i = 0; i < count; i++) {
    nowMs += stepMs;
    const cbs = [...rafQueue.values()];
    rafQueue.clear();
    act(() => {
      for (const cb of cbs) cb(nowMs);
    });
  }
}

function mockReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const baseProps: ToolOutputRevealInput = {
  toolId: 'tool-1',
  kind: 'text',
  text: '',
  hasContent: false,
  isError: false,
  status: 'success',
  completedAt: undefined,
};

beforeEach(() => {
  _resetToolRevealStateForTesting();
  nowMs = 5_000_000;
  rafQueue.clear();
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id);
  });
  mockReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useToolOutputReveal', () => {
  it('挂载即有内容：基线直出并标记已呈现（历史回放零动画）', () => {
    const text = 'x'.repeat(2000);
    const { result } = renderHook(() =>
      useToolOutputReveal({
        ...baseProps,
        text,
        hasContent: true,
        completedAt: nowMs,
      })
    );
    expect(result.current.phase).toBe('idle');
    expect(result.current.displayText).toBe(text);
    expect(hasPresentedOutput('tool-1')).toBe(true);
    expect(hasActiveToolDrain('tool-1')).toBe(false);
  });

  it('带内纯文本到达：排空揭示，前缀单调增长至全量并清除注册', () => {
    const text = 'y'.repeat(2000);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    expect(result.current.phase).toBe('idle');
    rerender({ ...baseProps, text, hasContent: true, completedAt: nowMs });
    expect(result.current.phase).toBe('draining');
    expect(hasActiveToolDrain('tool-1')).toBe(true);

    stepFrames(5);
    const mid = result.current.displayText;
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.length).toBeLessThan(text.length);
    expect(text.startsWith(mid)).toBe(true);

    stepFrames(300);
    expect(result.current.displayText).toBe(text);
    expect(result.current.phase).toBe('idle');
    expect(hasActiveToolDrain('tool-1')).toBe(false);
    expect(hasPresentedOutput('tool-1')).toBe(true);
  });

  it('错误输出即时全量（零延迟揭示）', () => {
    const text = 'boom '.repeat(400);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    rerender({
      ...baseProps,
      text,
      hasContent: true,
      isError: true,
      status: 'error',
      completedAt: nowMs,
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.displayText).toBe(text);
    expect(hasActiveToolDrain('tool-1')).toBe(false);
  });

  it('结构化输出整块淡入：fading 直到宿主自身 animationEnd 收口', () => {
    const text = 'z'.repeat(3000);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    rerender({
      ...baseProps,
      kind: 'structured',
      text,
      hasContent: true,
      completedAt: nowMs,
    });
    expect(result.current.phase).toBe('fading');
    expect(result.current.displayText).toBe(text);
    // 子元素冒泡的 animationend 不收口
    const child = {};
    const host = {};
    act(() => {
      result.current.handleFadeEnd({
        target: child,
        currentTarget: host,
      } as unknown as React.AnimationEvent);
    });
    expect(result.current.phase).toBe('fading');
    act(() => {
      result.current.handleFadeEnd({
        target: host,
        currentTarget: host,
      } as unknown as React.AnimationEvent);
    });
    expect(result.current.phase).toBe('idle');
    expect(hasPresentedOutput('tool-1')).toBe(true);
  });

  it('巨量纯文本（>4600）整块淡入而非硬排空', () => {
    const text = 'w'.repeat(6000);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    rerender({ ...baseProps, text, hasContent: true, completedAt: nowMs });
    expect(result.current.phase).toBe('fading');
    expect(result.current.displayText).toBe(text);
    expect(hasActiveToolDrain('tool-1')).toBe(false);
  });

  it('小体量（≤240）直出', () => {
    const text = 'v'.repeat(100);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    rerender({ ...baseProps, text, hasContent: true, completedAt: nowMs });
    expect(result.current.phase).toBe('idle');
    expect(result.current.displayText).toBe(text);
  });

  it('Reduce Motion 时带内文本也直出', () => {
    mockReducedMotion(true);
    const text = 'u'.repeat(2000);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    rerender({ ...baseProps, text, hasContent: true, completedAt: nowMs });
    expect(result.current.phase).toBe('idle');
    expect(result.current.displayText).toBe(text);
  });

  it('非实况完成时间戳（历史）到达也直出', () => {
    const text = 't'.repeat(2000);
    const { result, rerender } = renderHook(
      (p: ToolOutputRevealInput) => useToolOutputReveal(p),
      { initialProps: baseProps }
    );
    rerender({
      ...baseProps,
      text,
      hasContent: true,
      completedAt: nowMs - 120_000,
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.displayText).toBe(text);
  });
});
