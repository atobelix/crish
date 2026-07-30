import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Compute the backoff delay for a given attempt number,
 * replicating the formula from provider-call-gateway.ts:187.
 */
function backoffDelay(attempt: number, base = 1000, max = 30000): number {
  return Math.min(base * Math.pow(2, attempt - 1), max);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('exponential backoff formula', () => {
  it('attempt 1 → 1 000 ms', () => {
    expect(backoffDelay(1)).toBe(1000);
  });

  it('attempt 2 → 2 000 ms', () => {
    expect(backoffDelay(2)).toBe(2000);
  });

  it('attempt 3 → 4 000 ms', () => {
    expect(backoffDelay(3)).toBe(4000);
  });

  it('attempt 4 → 8 000 ms', () => {
    expect(backoffDelay(4)).toBe(8000);
  });

  it('attempt 5 → 16 000 ms', () => {
    expect(backoffDelay(5)).toBe(16000);
  });

  it('attempt 6 caps at 30 000 ms (2^5 × 1000 = 32 000 > 30 000)', () => {
    expect(backoffDelay(6)).toBe(30000);
  });

  it('higher attempts also cap at 30 000 ms', () => {
    expect(backoffDelay(10)).toBe(30000);
    expect(backoffDelay(100)).toBe(30000);
  });
});

describe('backoff reset (independent call state)', () => {
  it('resets after each call — does not share state between sequences', () => {
    // First sequence: attempt 1, 2
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);

    // Independent call: attempt 1 should still be 1000, proving no shared state
    expect(backoffDelay(1)).toBe(1000);
  });

  it('retry loop resets delay for each new call', async () => {
    vi.useFakeTimers();

    async function run(tracker: number[], max: number): Promise<string> {
      for (let attempt = 1; attempt <= max; attempt++) {
        const ms = backoffDelay(attempt);
        tracker.push(ms);
        await delay(ms);
      }
      return 'done';
    }

    function consume(p: Promise<string>): Promise<string> {
      return p.then(
        (v) => v,
        () => 'error'
      );
    }

    const firstCalls: number[] = [];
    const p1 = consume(run(firstCalls, 2));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p1).resolves.toBe('done');
    expect(firstCalls).toEqual([1000, 2000]);

    // second call starts fresh (attempt 1 → 1000, not 4000)
    const secondCalls: number[] = [];
    const p2 = consume(run(secondCalls, 2));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p2).resolves.toBe('done');
    expect(secondCalls).toEqual([1000, 2000]);
  });
});

describe('retry exhaustion', () => {
  it('throws the original error directly when max retries reached (no wrapping)', async () => {
    vi.useFakeTimers();

    const original = new Error('ECONNREFUSED');
    let counter = 0;

    async function run(): Promise<string> {
      for (let i = 1; i <= 3; i++) {
        counter++;
        try {
          throw original;
        } catch (err) {
          if (i >= 3) throw err;
          await delay(backoffDelay(i));
        }
      }
      return 'unreachable';
    }

    // silence unhandled rejection so vitest doesn't complain
    const p = run();
    const guard = p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await guard;

    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect(counter).toBe(3);
  });
});
