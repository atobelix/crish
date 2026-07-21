import { describe, it, expect, beforeEach } from 'vitest';
import { MockDaemon } from '../integration/mockDaemon';

describe('MockDaemon Stream Race Conditions', () => {
  let daemon: MockDaemon;

  beforeEach(() => {
    daemon = new MockDaemon({ latency: 0 });
  });

  it('consumes 1000 stream events with random disconnections', { timeout: 30000 }, async () => {
    const received: any[] = [];
    const interruptions: Error[] = [];

    const consumeUntilInterrupted = async () => {
      try {
        for await (const event of daemon.streamEvents('data', 1000, 1)) {
          received.push(event);
        }
      } catch (e) {
        interruptions.push(e as Error);
      }
    };

    const disruptor = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
        daemon.simulateDisconnect();
        await new Promise(r => setTimeout(r, 5));
        daemon.simulateReconnect();
        await new Promise(r => setTimeout(r, 5));
      }
    };

    await Promise.allSettled([consumeUntilInterrupted(), disruptor()]);

    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(1000);
    expect(interruptions.length).toBeGreaterThanOrEqual(1);
  });

  it('resumes new stream after disconnect and reconnect', async () => {
    const received: any[] = [];

    try {
      const gen = daemon.streamEvents('data', 5, 1);
      for await (const evt of gen) {
        received.push(evt);
        if (evt.seq === 1) {
          daemon.simulateDisconnect();
        }
      }
    } catch {
      // expected: stream interrupted
    }

    expect(received.length).toBe(2);

    daemon.simulateReconnect();
    const gen2 = daemon.streamEvents('data', 5, 1);
    for await (const evt of gen2) {
      received.push(evt);
    }

    expect(received.length).toBe(7);
  });

  it('concurrent streams do not interfere', async () => {
    const results: string[] = [];

    const stream1 = async () => {
      for await (const evt of daemon.streamEvents('alpha', 20, 1)) {
        results.push(`a:${evt.seq}`);
      }
    };

    const stream2 = async () => {
      for await (const evt of daemon.streamEvents('beta', 20, 1)) {
        results.push(`b:${evt.seq}`);
      }
    };

    await Promise.allSettled([stream1(), stream2()]);

    expect(results.length).toBe(40);
    const alphaEvents = results.filter(r => r.startsWith('a:'));
    const betaEvents = results.filter(r => r.startsWith('b:'));
    expect(alphaEvents.length).toBe(20);
    expect(betaEvents.length).toBe(20);
  });
});
