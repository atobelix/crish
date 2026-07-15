import { describe, expect, it } from 'vitest';
import { createDebounced } from './debouncedValue';

describe('createDebounced', () => {
  it('coalesces rapid schedules into one call with last value', () => {
    const calls: string[] = [];
    let timerFn: (() => void) | null = null;
    const d = createDebounced<string>(
      (v) => {
        calls.push(v);
      },
      200,
      {
        setTimer: (fn) => {
          timerFn = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {
          timerFn = null;
        },
      },
    );

    d.schedule('a');
    d.schedule('ab');
    d.schedule('abc');
    expect(calls).toHaveLength(0);
    expect(timerFn).toBeTruthy();
    timerFn!();
    expect(calls).toEqual(['abc']);
  });

  it('flush executes pending immediately', () => {
    const calls: number[] = [];
    const d = createDebounced<number>(
      (v) => {
        calls.push(v);
      },
      5000,
      {
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      },
    );
    d.schedule(42);
    d.flush();
    expect(calls).toEqual([42]);
  });

  it('cancel drops pending without calling fn', () => {
    const calls: string[] = [];
    const d = createDebounced<string>(
      (v) => {
        calls.push(v);
      },
      100,
      {
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      },
    );
    d.schedule('x');
    d.cancel();
    d.flush();
    expect(calls).toHaveLength(0);
  });
});
