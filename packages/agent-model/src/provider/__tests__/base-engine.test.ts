import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AbstractBaseEngine, fetchWithRetry } from '../engines/base-engine';
import type { ProviderStreamEvent } from '@crish/shared-types';
import type {
  AgentProviderRequest,
  EngineOptions,
  EngineRequest,
} from '../types';

class TestEngine extends AbstractBaseEngine {
  readonly id = 'test-engine';

  buildRequest(
    _request: AgentProviderRequest,
    _options: EngineOptions
  ): EngineRequest {
    return { url: 'https://test/api', init: { method: 'POST' } };
  }

  async *parseStream(
    _response: Response,
    _signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'stop', reason: 'stop' };
  }

  async *parseResponse(_body: unknown): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'stop', reason: 'stop' };
  }
}

describe('ErrorClassification', () => {
  const engine = new TestEngine();

  it('classifies 401 as auth error', () => {
    const result = engine.classifyError(new Error('Unauthorized'), 401);
    expect(result.kind).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  it('classifies 403 as auth error', () => {
    const result = engine.classifyError(new Error('Forbidden'), 403);
    expect(result.kind).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  it("classifies 'invalid api key' message as auth error", () => {
    const result = engine.classifyError(new Error('Invalid API key provided'));
    expect(result.kind).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  it('classifies 429 as rate-limit error', () => {
    const result = engine.classifyError(new Error('Too Many Requests'), 429);
    expect(result.kind).toBe('rate-limit');
    expect(result.retryable).toBe(true);
  });

  it("classifies 'rate limit' message as rate-limit error", () => {
    const result = engine.classifyError(new Error('rate limit exceeded'));
    expect(result.kind).toBe('rate-limit');
    expect(result.retryable).toBe(true);
  });

  it('classifies 402 as quota error', () => {
    const result = engine.classifyError(new Error('Payment Required'), 402);
    expect(result.kind).toBe('quota');
    expect(result.retryable).toBe(false);
  });

  it("classifies 'quota exceeded' message as quota error", () => {
    const result = engine.classifyError(new Error('Quota exceeded for API'));
    expect(result.kind).toBe('quota');
    expect(result.retryable).toBe(false);
  });

  it('classifies 500/502/503/504 as server error', () => {
    for (const status of [500, 502, 503, 504, 520, 522, 523, 524]) {
      const result = engine.classifyError(new Error('Server Error'), status);
      expect(result.kind).toBe('server');
      expect(result.retryable).toBe(true);
    }
  });

  it('classifies timeout message as timeout error', () => {
    const result = engine.classifyError(new Error('Timeout after 120000ms'));
    expect(result.kind).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it("classifies 'timed out' message as timeout error", () => {
    const result = engine.classifyError(new Error('Connection timed out'));
    expect(result.kind).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies context-length-exceeded message as context-overflow', () => {
    const result = engine.classifyError(new Error('context length exceeded'));
    expect(result.kind).toBe('context-overflow');
    expect(result.retryable).toBe(false);
  });

  it("classifies 'maximum context' message as context-overflow", () => {
    const result = engine.classifyError(new Error('maximum context tokens'));
    expect(result.kind).toBe('context-overflow');
    expect(result.retryable).toBe(false);
  });

  it('classifies network error messages', () => {
    const messages = [
      'fetch failed',
      'econnreset',
      'econnrefused',
      'enotfound',
    ];
    for (const msg of messages) {
      const result = engine.classifyError(new Error(msg));
      expect(result.kind).toBe('network');
      expect(result.retryable).toBe(true);
    }
  });

  it('classifies cancelled signal error', () => {
    const signal = AbortSignal.abort('User cancelled');
    const result = engine.classifyError(
      new Error('aborted'),
      undefined,
      signal
    );
    expect(result.kind).toBe('cancelled');
    expect(result.retryable).toBe(false);
  });

  it("classifies 'cancelled' message as cancelled", () => {
    const result = engine.classifyError(new Error('Request was cancelled'));
    expect(result.kind).toBe('cancelled');
    expect(result.retryable).toBe(false);
  });

  it('returns unknown for unrecognized errors', () => {
    const result = engine.classifyError(new Error('some random error'));
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('handles non-Error input gracefully', () => {
    const result = engine.classifyError('string error');
    expect(result.kind).toBe('unknown');
  });

  it('handles null/undefined error gracefully', () => {
    const result1 = engine.classifyError(null);
    expect(result1.kind).toBe('unknown');
    const result2 = engine.classifyError(undefined);
    expect(result2.kind).toBe('unknown');
  });

  it('prioritises auth check over server error when status is 500 but message says unauthorized', () => {
    const result = engine.classifyError(new Error('Unauthorized'), 500);
    expect(result.kind).toBe('auth');
  });
});

describe('fetchWithRetry', () => {
  describe('with fake timers (retry/backoff)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
    });

    afterEach(() => {
      vi.useRealTimers();
      (fetchSpy as any).mockRestore();
    });

    it('returns response on successful fetch', async () => {
      (fetchSpy as any).mockResolvedValueOnce(
        new Response('ok', { status: 200 })
      );

      const signal = new AbortController().signal;
      const result = await fetchWithRetry('https://test/api', {}, signal, 0);
      expect(result.status).toBe(200);
      const text = await result.text();
      expect(text).toBe('ok');
    });

    it('retries on failure and succeeds', async () => {
      (fetchSpy as any)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const signal = new AbortController().signal;
      const promise = fetchWithRetry('https://test/api', {}, signal, 1);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.status).toBe(200);
    });

    it('throws after exhausting retries', async () => {
      (fetchSpy as any).mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            const onAbort = () => reject(new Error('Network error'));
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          })
      );

      const signal = new AbortController().signal;
      const promise = fetchWithRetry(
        'https://test/api',
        { timeoutMs: 50 } as RequestInit & { timeoutMs?: number },
        signal,
        1
      );
      // Attempt 0: timeout after 50ms, then backoff 1000ms, then attempt 1: timeout after 50ms
      await vi.advanceTimersByTimeAsync(1100);
      await expect(promise).rejects.toThrow('Network error');
    });
  });

  describe('with real timers (abort/timeout)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
    });

    afterEach(() => {
      (fetchSpy as any).mockRestore();
    });

    it('respects abort signal and stops retrying', async () => {
      const controller = new AbortController();
      (fetchSpy as any).mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            if (signal) {
              if (signal.aborted) {
                reject(new Error('Aborted'));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(new Error('Aborted')),
                { once: true }
              );
            }
          })
      );

      const promise = fetchWithRetry(
        'https://test/api',
        {},
        controller.signal,
        3
      );
      controller.abort();
      await expect(promise).rejects.toThrow('Aborted');
    });

    it('applies timeout via init.timeoutMs', async () => {
      (fetchSpy as any).mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            if (signal) {
              const onAbort = () => {
                const reason = signal.reason;
                reject(reason instanceof Error ? reason : new Error('Aborted'));
              };
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener('abort', onAbort, { once: true });
              }
            }
          })
      );

      const promise = fetchWithRetry(
        'https://test/api',
        { timeoutMs: 100 } as RequestInit & { timeoutMs?: number },
        new AbortController().signal,
        0
      );
      // Internal setTimeout fires after 100ms -> controller.abort -> promise rejects
      await expect(promise).rejects.toThrow('Timeout after 100ms');
    }, 10_000);
  });
});
