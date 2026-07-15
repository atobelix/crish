import { describe, expect, it, vi } from 'vitest';
import { StreamTextBatcher, streamBatchKey } from './streamTextBatcher';

describe('StreamTextBatcher', () => {
  it('coalesces multiple pushes into one flush per interval', () => {
    vi.useFakeTimers();
    const flushed: Array<{ key: string; text: string }> = [];
    const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
    let idSeq = 1;

    const batcher = new StreamTextBatcher(
      (key, text) => {
        flushed.push({ key, text });
      },
      {
        intervalMs: 50,
        setTimer: (fn, ms) => {
          const id = idSeq++;
          timers.push({ id, fn, ms });
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (id) => {
          const i = timers.findIndex((t) => t.id === (id as unknown as number));
          if (i >= 0) timers.splice(i, 1);
        },
      },
    );

    const key = streamBatchKey('sess-1', 'msg-1');
    batcher.push(key, 'a');
    batcher.push(key, 'ab');
    batcher.push(key, 'abc');
    expect(batcher.pendingCount()).toBe(1);
    expect(flushed).toHaveLength(0);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(50);

    // fire scheduled timer
    timers[0].fn();
    expect(flushed).toEqual([{ key, text: 'abc' }]);
    expect(batcher.pendingCount()).toBe(0);

    batcher.dispose();
    vi.useRealTimers();
  });

  it('flushNow writes latest pending immediately and clears timer', () => {
    const flushed: string[] = [];
    let cleared = 0;
    const timers: Array<() => void> = [];
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
      },
      {
        intervalMs: 1000,
        setTimer: (fn) => {
          timers.push(fn);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {
          cleared += 1;
          timers.length = 0;
        },
      },
    );

    batcher.push('k', 'hello');
    batcher.push('k', 'hello world');
    expect(flushed).toHaveLength(0);
    batcher.flushNow();
    expect(flushed).toEqual(['hello world']);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(batcher.pendingCount()).toBe(0);
    batcher.dispose();
  });

  it('streamBatchKey joins session and message ids', () => {
    expect(streamBatchKey('s', 'm')).toBe('s::m');
  });
});
