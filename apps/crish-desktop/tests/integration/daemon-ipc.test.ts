import { describe, it, expect, beforeEach } from 'vitest';
import { MockDaemon } from './mockDaemon';

describe('Daemon IPC', () => {
  let daemon: MockDaemon;

  beforeEach(() => {
    daemon = new MockDaemon({ latency: 5 });
  });

  it('completes send-receive round trip', async () => {
    const received: any[] = [];
    daemon.on('message', (msg) => received.push(msg));
    await daemon.send('message', { type: 'test', content: 'hello' });
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('hello');
  });

  it('handles payload with authentication tokens', async () => {
    const received: any[] = [];
    daemon.on('auth', (msg) => received.push(msg));
    await daemon.send('auth', { token: 'sk-test-123', provider: 'anthropic' });
    expect(received).toHaveLength(1);
    expect(received[0].token).toBe('sk-test-123');
  });

  it('recovers after reconnection', async () => {
    const received: any[] = [];
    daemon.on('event', (msg) => received.push(msg));

    await daemon.send('event', { seq: 1 });

    daemon.simulateDisconnect();
    await expect(daemon.send('event', { seq: 2 })).rejects.toThrow('Connection lost');

    daemon.simulateReconnect();
    await daemon.send('event', { seq: 3 });

    expect(received).toHaveLength(2);
    expect(received[0].seq).toBe(1);
    expect(received[1].seq).toBe(3);
  });
});
