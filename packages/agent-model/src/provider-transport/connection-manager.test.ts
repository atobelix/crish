import { describe, expect, it } from 'vitest';
import type { ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProvider, AgentProviderRequest } from '../provider/types';
import {
  ConnectionError,
  ConnectionManager,
  StreamInterruptedError,
  type ProviderTransport,
} from './connection-manager';

function transport(
  id: string,
  provider: AgentProvider,
  stats?: Partial<
    Pick<ProviderTransport, 'successRate' | 'avgLatency' | 'lastUsed'>
  >
): ProviderTransport {
  return {
    id,
    kind: 'https',
    provider,
    avgLatency: stats?.avgLatency ?? 100,
    successRate: stats?.successRate ?? 1,
    lastUsed: stats?.lastUsed ?? 0,
  };
}

function scriptedProvider(
  id: string,
  events: ProviderStreamEvent[] | (() => AsyncGenerator<ProviderStreamEvent>)
): AgentProvider {
  return {
    id,
    async *stream(
      _request: AgentProviderRequest
    ): AsyncGenerator<ProviderStreamEvent> {
      if (typeof events === 'function') {
        yield* events();
        return;
      }
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('ConnectionManager', () => {
  it('selectNext excludes every tried transport, not only the last id', () => {
    const manager = new ConnectionManager();
    const a = transport('a', scriptedProvider('a', []), {
      successRate: 1,
      avgLatency: 10,
      lastUsed: 3,
    });
    const b = transport('b', scriptedProvider('b', []), {
      successRate: 0.9,
      avgLatency: 20,
      lastUsed: 2,
    });
    const c = transport('c', scriptedProvider('c', []), {
      successRate: 0.8,
      avgLatency: 30,
      lastUsed: 1,
    });
    manager.addTransport(a);
    manager.addTransport(b);
    manager.addTransport(c);

    // Previously selectNext("b") could reselect "a" (higher rank) and stall failover.
    expect(manager.selectNext(['a', 'b'])?.id).toBe('c');
    expect(manager.selectNext('a')?.id).toBe('b');
    expect(manager.selectNext(['a', 'b', 'c'])).toBeNull();
  });

  it('fails over when the first transport errors with no content', async () => {
    const manager = new ConnectionManager();
    manager.addTransport(
      transport(
        'primary',
        scriptedProvider('primary', [
          { type: 'stop', reason: 'error', error: 'upstream 502' },
        ]),
        { successRate: 1, avgLatency: 5 }
      )
    );
    manager.addTransport(
      transport(
        'backup',
        scriptedProvider('backup', [
          { type: 'text-delta', text: 'recovered' },
          { type: 'stop', reason: 'stop' },
        ]),
        { successRate: 0.5, avgLatency: 50 }
      )
    );

    const seen: ProviderStreamEvent[] = [];
    for await (const event of manager.stream({
      sessionId: 's',
      cwd: '/',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      seen.push(event);
    }

    expect(seen).toEqual([
      { type: 'text-delta', text: 'recovered' },
      { type: 'stop', reason: 'stop' },
    ]);
  });

  it('does not splice a second transport after content was already yielded', async () => {
    const manager = new ConnectionManager();
    manager.addTransport(
      transport(
        'primary',
        scriptedProvider('primary', [
          { type: 'text-delta', text: 'partial' },
          { type: 'stop', reason: 'error', error: 'cut mid-stream' },
        ]),
        { successRate: 1, avgLatency: 5 }
      )
    );
    manager.addTransport(
      transport(
        'backup',
        scriptedProvider('backup', [
          { type: 'text-delta', text: 'SHOULD_NOT_APPEAR' },
          { type: 'stop', reason: 'stop' },
        ]),
        { successRate: 0.5, avgLatency: 50 }
      )
    );

    const seen: ProviderStreamEvent[] = [];
    await expect(async () => {
      for await (const event of manager.stream({
        sessionId: 's',
        cwd: '/',
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        seen.push(event);
      }
    }).rejects.toBeInstanceOf(StreamInterruptedError);

    expect(
      seen.map((e) => (e.type === 'text-delta' ? e.text : e.type))
    ).toEqual(['partial', 'stop']);
    expect(
      seen.some(
        (e) => e.type === 'text-delta' && e.text === 'SHOULD_NOT_APPEAR'
      )
    ).toBe(false);
  });

  it('throws ConnectionError when every transport fails without content', async () => {
    const manager = new ConnectionManager();
    manager.addTransport(
      transport(
        'a',
        scriptedProvider('a', [{ type: 'stop', reason: 'error', error: 'a' }])
      )
    );
    manager.addTransport(
      transport(
        'b',
        scriptedProvider('b', [{ type: 'stop', reason: 'error', error: 'b' }])
      )
    );

    await expect(async () => {
      for await (const _ of manager.stream({
        sessionId: 's',
        cwd: '/',
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        /* drain */
      }
    }).rejects.toMatchObject({
      name: 'ConnectionError',
      code: 'all-transports-exhausted',
    } satisfies Partial<ConnectionError>);
  });

  it('recordResult clamps non-finite latency so ranking stays finite', () => {
    const manager = new ConnectionManager();
    const t = transport('a', scriptedProvider('a', []));
    manager.addTransport(t);
    manager.recordResult('a', true, Number.NaN);
    manager.recordResult('a', true, Number.POSITIVE_INFINITY);
    manager.recordResult('a', false, -50);
    manager.recordResult('a', true, 40);
    expect(Number.isFinite(t.avgLatency)).toBe(true);
    expect(t.avgLatency).toBeGreaterThanOrEqual(0);
    expect(t.successRate).toBe(0.75);
  });

  it('loadSnapshot sanitizes corrupt rates and recomputes from window', () => {
    const manager = new ConnectionManager();
    manager.addTransport(
      transport('a', scriptedProvider('a', []), {
        successRate: 1,
        avgLatency: 10,
      })
    );
    manager.loadSnapshot({
      updatedAt: Date.now(),
      transports: [
        {
          id: 'a',
          kind: 'https',
          avgLatency: Number.NaN,
          successRate: 9,
          successCount: 1,
          failureCount: 0,
          lastUsed: -1,
          slidingWindow: [
            { success: true, latencyMs: 20, timestamp: 1 },
            { success: false, latencyMs: Number.NaN, timestamp: 2 },
            { success: true, latencyMs: 40, timestamp: 3 },
          ],
        },
        // unknown id ignored
        {
          id: 'missing',
          kind: 'https',
          avgLatency: 1,
          successRate: 1,
          successCount: 1,
          failureCount: 0,
          lastUsed: 0,
          slidingWindow: [],
        },
      ],
    });
    const [a] = manager.getTransports();
    expect(a?.successRate).toBeCloseTo(2 / 3);
    expect(a?.avgLatency).toBeCloseTo(20); // (20+0+40)/3
    expect(a?.lastUsed).toBe(0);
  });

  it('diagnostic-only streams still failover (diagnostics are not content)', async () => {
    const manager = new ConnectionManager();
    manager.addTransport(
      transport(
        'primary',
        {
          id: 'primary',
          async *stream() {
            yield {
              type: 'provider-diagnostic',
              diagnostic: {
                phase: 'request-start',
                providerId: 'primary',
                reason: 'connecting',
              },
            } as ProviderStreamEvent;
            throw new Error('tls fail');
          },
        },
        { successRate: 1, avgLatency: 1 }
      )
    );
    manager.addTransport(
      transport(
        'backup',
        scriptedProvider('backup', [
          { type: 'text-delta', text: 'after-diag-failover' },
          { type: 'stop', reason: 'stop' },
        ]),
        { successRate: 0.5, avgLatency: 50 }
      )
    );

    const texts: string[] = [];
    for await (const event of manager.stream({
      sessionId: 's',
      cwd: '/',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === 'text-delta') texts.push(event.text);
    }
    expect(texts).toEqual(['after-diag-failover']);
  });
});
