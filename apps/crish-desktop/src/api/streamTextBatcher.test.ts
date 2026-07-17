import { describe, expect, it, vi } from 'vitest';
import {
  StreamTextBatcher,
  StreamValueBatcher,
  streamBatchKey,
  streamToolBatchKey,
  parseStreamToolBatchKey,
  mergeToolCallPatch,
  isImmediateToolStatus,
} from './streamTextBatcher';

/** 可手动点火的确定性定时器，避免真实 clock 抖动 */
function createManualTimers() {
  const timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
  let idSeq = 1;
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const id = idSeq++;
      timers.push({ id, fn, ms, cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id: ReturnType<typeof setTimeout>) => {
      const t = timers.find((x) => x.id === (id as unknown as number));
      if (t) t.cleared = true;
    },
    active: () => timers.filter((t) => !t.cleared),
    fireActive: () => {
      const live = timers.filter((t) => !t.cleared);
      for (const t of live) {
        t.cleared = true;
        t.fn();
      }
    },
  };
}

describe('StreamTextBatcher', () => {
  it('coalesces multiple pushes into one flush per interval', () => {
    vi.useFakeTimers();
    const flushed: Array<{ key: string; text: string }> = [];
    const mt = createManualTimers();

    const batcher = new StreamTextBatcher(
      (key, text) => {
        flushed.push({ key, text });
      },
      {
        intervalMs: 50,
        setTimer: mt.setTimer,
        clearTimer: mt.clearTimer,
      },
    );

    const key = streamBatchKey('sess-1', 'msg-1');
    batcher.push(key, 'a');
    batcher.push(key, 'ab');
    batcher.push(key, 'abc');
    expect(batcher.pendingCount()).toBe(1);
    expect(batcher.hasPending(key)).toBe(true);
    expect(batcher.isScheduled()).toBe(true);
    expect(flushed).toHaveLength(0);
    expect(mt.active()).toHaveLength(1);
    expect(mt.active()[0].ms).toBe(50);

    // fire scheduled timer
    mt.fireActive();
    expect(flushed).toEqual([{ key, text: 'abc' }]);
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.isScheduled()).toBe(false);

    batcher.dispose();
    vi.useRealTimers();
  });

  it('coalesces partial token growth into latest full snapshot', () => {
    const flushed: string[] = [];
    const mt = createManualTimers();
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
      },
      { intervalMs: 40, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    // 模拟 token 流：每次 push 为累计全文，非 delta
    const tokens = ['H', 'He', 'Hel', 'Hell', 'Hello', 'Hello,', 'Hello, world'];
    for (const t of tokens) batcher.push('k', t);

    expect(batcher.pendingCount()).toBe(1);
    expect(batcher.bufferedSize()).toBe('Hello, world'.length);
    expect(flushed).toHaveLength(0);
    mt.fireActive();
    expect(flushed).toEqual(['Hello, world']);
    batcher.dispose();
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
    expect(batcher.isScheduled()).toBe(false);
    batcher.dispose();
  });

  it('reset/dispose discards pending without flushing (cancel path)', () => {
    const flushed: string[] = [];
    const mt = createManualTimers();
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
      },
      { intervalMs: 100, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    batcher.push('a', 'partial');
    batcher.push('b', 'other');
    expect(batcher.pendingCount()).toBe(2);
    expect(batcher.isScheduled()).toBe(true);

    batcher.reset();
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.isScheduled()).toBe(false);
    expect(flushed).toHaveLength(0);
    // 已 clear 的 timer 再 fire 不应产生副作用（fn 仍可能被误调时 pending 已空）
    mt.fireActive();
    expect(flushed).toHaveLength(0);

    // reset 后可复用
    batcher.push('c', 'after-reset');
    batcher.flushNow();
    expect(flushed).toEqual(['after-reset']);
    batcher.dispose();
  });

  it('drop last pending key cancels timer; drop one of many keeps schedule', () => {
    const flushed: Array<{ key: string; text: string }> = [];
    const mt = createManualTimers();
    const batcher = new StreamTextBatcher(
      (key, text) => {
        flushed.push({ key, text });
      },
      { intervalMs: 60, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    batcher.push('k1', 'one');
    batcher.push('k2', 'two');
    expect(batcher.isScheduled()).toBe(true);
    batcher.drop('k1');
    expect(batcher.hasPending('k1')).toBe(false);
    expect(batcher.hasPending('k2')).toBe(true);
    expect(batcher.isScheduled()).toBe(true);

    batcher.drop('k2');
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.isScheduled()).toBe(false);
    expect(flushed).toHaveLength(0);

    // 空 pending 时 flushNow 为 no-op
    batcher.flushNow();
    expect(flushed).toHaveLength(0);
    batcher.dispose();
  });

  it('maxBufferedChars force-flushes when cumulative text exceeds cap', () => {
    const flushed: string[] = [];
    const mt = createManualTimers();
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
      },
      {
        intervalMs: 1000,
        maxBufferedChars: 10,
        setTimer: mt.setTimer,
        clearTimer: mt.clearTimer,
      },
    );

    batcher.push('k', '12345'); // 5 chars, under cap
    expect(flushed).toHaveLength(0);
    expect(batcher.isScheduled()).toBe(true);

    // 覆盖为更长全文，触达 cap → 立即 flush
    batcher.push('k', '12345678901'); // 11 >= 10
    expect(flushed).toEqual(['12345678901']);
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.isScheduled()).toBe(false);
    batcher.dispose();
  });

  it('maxPendingKeys force-flushes when distinct keys hit cap', () => {
    const flushed: string[] = [];
    const mt = createManualTimers();
    const batcher = new StreamTextBatcher(
      (key, text) => {
        flushed.push(`${key}:${text}`);
      },
      {
        intervalMs: 1000,
        maxPendingKeys: 2,
        setTimer: mt.setTimer,
        clearTimer: mt.clearTimer,
      },
    );

    batcher.push('a', 'A');
    batcher.push('b', 'B');
    // 第 2 个 key 已达 cap → force flush
    expect(flushed).toEqual(['a:A', 'b:B']);
    expect(batcher.pendingCount()).toBe(0);

    batcher.push('c', 'C');
    expect(flushed).toEqual(['a:A', 'b:B']); // 单 key 未满 cap
    expect(batcher.isScheduled()).toBe(true);
    batcher.dispose();
  });

  it('push during onFlush is deferred to next window (no lost tokens)', () => {
    const flushed: string[] = [];
    const mt = createManualTimers();
    let reentered = false;
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
        if (!reentered && text === 'first') {
          reentered = true;
          batcher.push('k', 'from-onFlush');
        }
      },
      { intervalMs: 30, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    batcher.push('k', 'first');
    mt.fireActive();
    expect(flushed).toEqual(['first']);
    // onFlush 内 push 应排入下一窗口
    expect(batcher.hasPending('k')).toBe(true);
    expect(batcher.isScheduled()).toBe(true);
    mt.fireActive();
    expect(flushed).toEqual(['first', 'from-onFlush']);
    batcher.dispose();
  });

  it('reentrant flushNow during onFlush drains nested pushes deterministically', () => {
    const flushed: string[] = [];
    const mt = createManualTimers();
    let phase = 0;
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
        if (phase === 0 && text === 'A') {
          phase = 1;
          batcher.push('k', 'B-nested');
          batcher.flushNow(); // 嵌套 flush
        }
      },
      { intervalMs: 80, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    batcher.push('k', 'A');
    batcher.flushNow();
    expect(flushed).toEqual(['A', 'B-nested']);
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.isScheduled()).toBe(false);
    batcher.dispose();
  });

  it('race-ish sequence: coalesce → timer → push → flushNow → reset is deterministic', () => {
    const flushed: Array<{ key: string; text: string }> = [];
    const mt = createManualTimers();
    const batcher = new StreamTextBatcher(
      (key, text) => {
        flushed.push({ key, text });
      },
      { intervalMs: 25, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    const k1 = streamBatchKey('s', 'm1');
    const k2 = streamBatchKey('s', 'm2');

    batcher.push(k1, 'a');
    batcher.push(k1, 'ab');
    batcher.push(k2, 'x');
    expect(mt.active()).toHaveLength(1);

    mt.fireActive();
    expect(flushed).toEqual([
      { key: k1, text: 'ab' },
      { key: k2, text: 'x' },
    ]);

    batcher.push(k1, 'ab|c');
    batcher.push(k1, 'ab|cd');
    expect(batcher.isScheduled()).toBe(true);
    batcher.flushNow();
    expect(flushed).toEqual([
      { key: k1, text: 'ab' },
      { key: k2, text: 'x' },
      { key: k1, text: 'ab|cd' },
    ]);

    batcher.push(k2, 'stale');
    batcher.reset();
    expect(batcher.pendingCount()).toBe(0);
    expect(flushed).toHaveLength(3);
    batcher.dispose();
  });

  it('intervalMs 0 flushes synchronously on push', () => {
    const flushed: string[] = [];
    const batcher = new StreamTextBatcher(
      (_k, text) => {
        flushed.push(text);
      },
      { intervalMs: 0 },
    );
    batcher.push('k', 'sync');
    expect(flushed).toEqual(['sync']);
    expect(batcher.pendingCount()).toBe(0);
    batcher.dispose();
  });

  it('streamBatchKey joins session and message ids', () => {
    expect(streamBatchKey('s', 'm')).toBe('s::m');
  });
});

describe('StreamValueBatcher', () => {
  it('merges patches by key within interval and flushes latest', () => {
    const flushed: Array<{ key: string; value: { n: number; s: string } }> = [];
    const mt = createManualTimers();
    const batcher = new StreamValueBatcher<{ n: number; s: string }>(
      (key, value) => {
        flushed.push({ key, value });
      },
      {
        intervalMs: 48,
        merge: (prev, next) => ({ ...prev, ...next }),
        setTimer: mt.setTimer,
        clearTimer: mt.clearTimer,
      },
    );

    batcher.push('t1', { n: 1, s: 'a' });
    batcher.push('t1', { n: 2, s: 'b' });
    batcher.push('t2', { n: 9, s: 'x' });
    expect(batcher.pendingCount()).toBe(2);
    expect(flushed).toHaveLength(0);
    expect(mt.active()).toHaveLength(1);
    expect(mt.active()[0].ms).toBe(48);

    mt.fireActive();
    expect(flushed).toEqual([
      { key: 't1', value: { n: 2, s: 'b' } },
      { key: 't2', value: { n: 9, s: 'x' } },
    ]);
    expect(batcher.pendingCount()).toBe(0);
    batcher.dispose();
  });

  it('flush order is insertion order (deterministic)', () => {
    const order: string[] = [];
    const mt = createManualTimers();
    const batcher = new StreamValueBatcher<number>(
      (key) => {
        order.push(key);
      },
      { intervalMs: 10, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    batcher.push('z', 1);
    batcher.push('a', 2);
    batcher.push('m', 3);
    batcher.push('z', 9); // 更新 z，不改变插入序
    mt.fireActive();
    expect(order).toEqual(['z', 'a', 'm']);
    batcher.dispose();
  });

  it('flushNow emits immediately for terminal tool updates', () => {
    const flushed: string[] = [];
    let cleared = 0;
    const timers: Array<() => void> = [];
    const batcher = new StreamValueBatcher<{ status: string; out?: string }>(
      (key, value) => {
        flushed.push(`${key}:${value.status}:${value.out || ''}`);
      },
      {
        intervalMs: 1000,
        merge: (prev, next) => ({ ...prev, ...next }),
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

    batcher.push('tool-a', { status: 'running', out: '...' });
    batcher.push('tool-a', { status: 'success', out: 'done' });
    expect(flushed).toHaveLength(0);
    batcher.flushNow();
    expect(flushed).toEqual(['tool-a:success:done']);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(batcher.pendingCount()).toBe(0);
    batcher.dispose();
  });

  it('flushNow requeues current key when onFlush throws (终态不丢)', () => {
    const seen: string[] = [];
    let failOnce = true;
    const batcher = new StreamValueBatcher<string>(
      (key, value) => {
        if (failOnce && key === 'a') {
          failOnce = false;
          throw new Error('boom');
        }
        seen.push(`${key}:${value}`);
      },
      {
        intervalMs: 1000,
        setTimer: (fn) => {
          void fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );

    batcher.push('a', 'A1');
    batcher.push('b', 'B1');
    expect(() => batcher.flushNow()).toThrow(/boom/);
    // 失败项 a + 未刷 b 均回填
    expect(batcher.pendingCount()).toBe(2);

    batcher.flushNow();
    expect(seen).toEqual(['a:A1', 'b:B1']);
    expect(batcher.pendingCount()).toBe(0);
    batcher.dispose();
  });

  it('onFlush throw keeps concurrent push value over requeued snapshot', () => {
    const seen: string[] = [];
    let failOnce = true;
    const batcher = new StreamValueBatcher<string>(
      (key, value) => {
        if (failOnce && key === 'a') {
          failOnce = false;
          // 失败前模拟并发更新 b
          batcher.push('b', 'B-newer');
          throw new Error('mid-flush');
        }
        seen.push(`${key}:${value}`);
      },
      {
        intervalMs: 100,
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {},
      },
    );

    batcher.push('a', 'A1');
    batcher.push('b', 'B-old');
    expect(() => batcher.flushNow()).toThrow(/mid-flush/);
    // a 回填；b 保留 push 的更新值
    expect(batcher.hasPending('a')).toBe(true);
    expect(batcher.hasPending('b')).toBe(true);

    batcher.flushNow();
    // 并发 push 先写入 b，回填 a 后插入序为 b→a；关键是值正确且终态不丢
    expect(seen).toHaveLength(2);
    expect(seen).toContain('a:A1');
    expect(seen).toContain('b:B-newer');
    expect(seen).not.toContain('b:B-old');
    batcher.dispose();
  });

  it('maxPendingKeys force flush is deterministic across keys', () => {
    const flushed: string[] = [];
    const batcher = new StreamValueBatcher<number>(
      (key, value) => {
        flushed.push(`${key}:${value}`);
      },
      {
        intervalMs: 500,
        maxPendingKeys: 3,
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {},
      },
    );

    batcher.push('k1', 1);
    batcher.push('k2', 2);
    expect(flushed).toHaveLength(0);
    batcher.push('k3', 3);
    expect(flushed).toEqual(['k1:1', 'k2:2', 'k3:3']);
    expect(batcher.pendingCount()).toBe(0);
    batcher.dispose();
  });

  it('reset cancels timer and allows reuse without emitting', () => {
    const flushed: number[] = [];
    const mt = createManualTimers();
    const batcher = new StreamValueBatcher<number>(
      (_k, v) => {
        flushed.push(v);
      },
      { intervalMs: 40, setTimer: mt.setTimer, clearTimer: mt.clearTimer },
    );

    batcher.push('x', 1);
    batcher.reset();
    expect(mt.active()).toHaveLength(0);
    expect(batcher.isScheduled()).toBe(false);
    batcher.push('x', 2);
    batcher.flushNow();
    expect(flushed).toEqual([2]);
    batcher.dispose();
  });
});

describe('tool batch helpers', () => {
  it('streamToolBatchKey / parseStreamToolBatchKey roundtrip', () => {
    const key = streamToolBatchKey('sess', 'msg', 'tool-1');
    expect(key).toBe('sess::msg::tool-1');
    expect(parseStreamToolBatchKey(key)).toEqual({
      sessionId: 'sess',
      messageId: 'msg',
      toolId: 'tool-1',
    });
    expect(parseStreamToolBatchKey('bad')).toBeNull();
  });

  it('mergeToolCallPatch keeps latest fields', () => {
    expect(
      mergeToolCallPatch(
        { id: 't', status: 'running', name: 'shell' },
        { id: 't', status: 'success', output: 'ok' },
      ),
    ).toEqual({ id: 't', status: 'success', name: 'shell', output: 'ok' });
  });

  it('isImmediateToolStatus marks terminal and approval', () => {
    expect(isImmediateToolStatus('running')).toBe(false);
    expect(isImmediateToolStatus('success')).toBe(true);
    expect(isImmediateToolStatus('error')).toBe(true);
    expect(isImmediateToolStatus('pending_approval')).toBe(true);
    expect(isImmediateToolStatus(undefined)).toBe(false);
  });
});
