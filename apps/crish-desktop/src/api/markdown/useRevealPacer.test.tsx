// @vitest-environment jsdom
/**
 * useRevealedText（R11）：RevealPacer 的 React 接线测试。
 * 手动 rAF 队列 + 假 performance.now，确定性推进帧。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRevealedText } from './useRevealPacer';

const FRAME_MS = 1000 / 60;

let nowMs = 0;
let rafQueue = new Map<number, FrameRequestCallback>();
let rafSeq = 0;

function stepFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    nowMs += FRAME_MS;
    const callbacks = [...rafQueue.values()];
    rafQueue.clear();
    act(() => {
      for (const cb of callbacks) cb(nowMs);
    });
  }
}

function makeText(totalChars: number): string {
  const unit = '流式显现的节奏需要保持平滑均匀，不能忽快忽慢。';
  let out = '';
  while (out.length < totalChars) out += unit;
  return out.slice(0, totalChars);
}

beforeEach(() => {
  nowMs = 0;
  rafQueue = new Map();
  rafSeq = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.set(rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useRevealedText', () => {
  it('非流式挂载（历史消息）：恒等透传、零重演', () => {
    const text = makeText(5_000);
    const { result } = renderHook(() => useRevealedText(text, false));
    expect(result.current.text).toBe(text);
    expect(result.current.revealing).toBe(false);
  });

  it('短流（≤ 门槛）：逐帧恒等到达，revealing 恒 false', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useRevealedText(text, streaming),
      { initialProps: { text: '', streaming: true } }
    );
    const full = makeText(200);
    rerender({ text: full, streaming: true });
    expect(result.current.text).toBe(full);
    expect(result.current.revealing).toBe(false);
    stepFrames(10);
    expect(result.current.text).toBe(full);
  });

  it('长流啮合定速：显现滞后于到达并持续推进，关流后收尾泄空至全显', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useRevealedText(text, streaming),
      { initialProps: { text: '', streaming: true } }
    );
    const full = makeText(3_000);
    rerender({ text: full, streaming: true });
    // 啮合后首帧：尚未显现（自基线起定速），且处于显现中
    expect(result.current.revealing).toBe(true);
    expect(result.current.text.length).toBeLessThan(full.length);
    stepFrames(30);
    const midLength = result.current.text.length;
    expect(midLength).toBeGreaterThan(0);
    expect(midLength).toBeLessThan(full.length);
    expect(result.current.text).toBe(full.slice(0, midLength));
    // 关流：大余量进收尾泄空（不 snap 倾倒），泄空期间 revealing 保持
    rerender({ text: full, streaming: false });
    expect(result.current.revealing).toBe(true);
    expect(result.current.text.length).toBeLessThan(full.length);
    stepFrames(120);
    expect(result.current.text).toBe(full);
    expect(result.current.revealing).toBe(false);
  });

  it('减动效：旁路定速，长文到达即全显', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useRevealedText(text, streaming),
      { initialProps: { text: '', streaming: true } }
    );
    const full = makeText(5_000);
    rerender({ text: full, streaming: true });
    expect(result.current.text).toBe(full);
    expect(result.current.revealing).toBe(false);
  });
});
