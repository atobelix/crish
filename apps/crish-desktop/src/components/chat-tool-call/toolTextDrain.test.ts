/**
 * AN4 · ToolTextDrain 控制器单元钉（注入时钟 + 手动 rAF 队列）：
 * - 揭示长度单调增长直至全量，onDone 只触发一次；
 * - 单帧推进受 R11 frameHardCapChars 硬顶（预算封顶不倾泻）；
 * - settle() 同帧到达终态且只结算一次；dispose() 后回调全灭；
 * - 切点字素安全：任何中间揭示长度都不停在 ZWJ 家庭 emoji 簇内部。
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolTextDrain } from './toolTextDrain';
import { TEXT_REVEAL_PACING } from '../../utils/revealPacing';

function makeClock() {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let now = 1_000_000;
  return {
    deps: {
      now: () => now,
      raf: (cb: FrameRequestCallback) => {
        const id = nextId++;
        queue.set(id, cb);
        return id;
      },
      cancelRaf: (id: number) => {
        queue.delete(id);
      },
    },
    step: (advanceMs: number) => {
      now += advanceMs;
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(now);
    },
    pending: () => queue.size,
  };
}

describe('ToolTextDrain', () => {
  it('揭示长度单调增长直至全量，onDone 恰一次', () => {
    const clock = makeClock();
    const text = 'x'.repeat(2000);
    const lens: number[] = [];
    const onDone = vi.fn();
    const drain = new ToolTextDrain(
      text,
      800,
      (len) => lens.push(len),
      onDone,
      clock.deps
    );
    drain.start();
    for (let i = 0; i < 200 && !drain.isDone; i++) clock.step(16);
    expect(drain.isDone).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(lens[lens.length - 1]).toBe(text.length);
    for (let i = 1; i < lens.length; i++) {
      expect(lens[i]).toBeGreaterThan(lens[i - 1]);
    }
    const count = lens.length;
    clock.step(100);
    expect(lens.length).toBe(count);
  });

  it('单帧推进不超过 frameHardCapChars（420），长帧积压不倾泻', () => {
    const clock = makeClock();
    const text = 'y'.repeat(4600);
    const lens: number[] = [];
    const drain = new ToolTextDrain(
      text,
      900,
      (len) => lens.push(len),
      () => {},
      clock.deps
    );
    drain.start();
    // 一帧跳 500ms：名义预算 0.5 × (4600/0.9) ≈ 2555 字，须被帧顶截断
    clock.step(500);
    expect(lens.length).toBe(1);
    expect(lens[0]).toBeGreaterThan(0);
    expect(lens[0]).toBeLessThanOrEqual(TEXT_REVEAL_PACING.frameHardCapChars);
    clock.step(16);
    expect(lens[1] - lens[0]).toBeLessThanOrEqual(
      TEXT_REVEAL_PACING.frameHardCapChars
    );
    drain.dispose();
  });

  it('settle() 同帧全量且只结算一次', () => {
    const clock = makeClock();
    const text = 'z'.repeat(1500);
    const lens: number[] = [];
    const onDone = vi.fn();
    const drain = new ToolTextDrain(
      text,
      600,
      (len) => lens.push(len),
      onDone,
      clock.deps
    );
    drain.start();
    clock.step(16);
    expect(lens[lens.length - 1]).toBeLessThan(text.length);
    drain.settle();
    expect(lens[lens.length - 1]).toBe(text.length);
    expect(onDone).toHaveBeenCalledTimes(1);
    drain.settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it('dispose() 后无任何回调', () => {
    const clock = makeClock();
    const onReveal = vi.fn();
    const onDone = vi.fn();
    const drain = new ToolTextDrain(
      'w'.repeat(1500),
      600,
      onReveal,
      onDone,
      clock.deps
    );
    drain.start();
    drain.dispose();
    clock.step(1000);
    expect(onReveal).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('切点字素安全：ZWJ emoji 簇永不被切开', () => {
    const clock = makeClock();
    const family = '👨‍👩‍👧‍👦';
    const text = 'a'.repeat(300) + family + 'b'.repeat(300);
    const lens: number[] = [];
    const drain = new ToolTextDrain(
      text,
      300,
      (len) => lens.push(len),
      () => {},
      clock.deps
    );
    drain.start();
    for (let i = 0; i < 100 && !drain.isDone; i++) clock.step(16);
    expect(drain.isDone).toBe(true);
    expect(lens.length).toBeGreaterThan(2);
    for (const len of lens) {
      // 簇占 UTF-16 下标 (300, 300+family.length) 开区间：不得停在其中
      expect(len <= 300 || len >= 300 + family.length).toBe(true);
      expect(text.slice(0, len).endsWith('\u200D')).toBe(false);
    }
    expect(lens[lens.length - 1]).toBe(text.length);
  });
});
