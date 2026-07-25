/**
 * ConnectionManager — UI projection only; no dual reconnect / probe stack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep attemptConnect off the real Tauri dynamic-import / sidecar poll path under fake timers.
vi.mock('../api/tauriInvoke', () => ({
  tryInvokeTauri: vi.fn(async () => null),
  invokeResult: vi.fn(async () => ({ status: 'error' as const, message: 'unavailable in test' })),
}));

import {
  DesktopDaemonClient,
  HEARTBEAT_MISS_TOLERANCE,
  resetDesktopDaemonClientForTests,
} from '../api/daemonClient';
import { ConnectionManager } from './ConnectionManager';

type Listener = (ev?: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.simulateOpen());
  }

  addEventListener(type: string, cb: Listener) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener) {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  simulateOpen() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  simulateMessage(msg: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(msg) });
  }

  private emit(type: string, ev?: unknown) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(ev);
    }
  }
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('no FakeWebSocket');
  return ws;
}

describe('ConnectionManager (UI projection)', () => {
  // Slow heartbeat so it does not interfere with auth / projection tests.
  const HEARTBEAT_MS = 60_000;
  let client: DesktopDaemonClient;
  let cm: ConnectionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    resetDesktopDaemonClientForTests();
    ConnectionManager.resetInstanceForTests();

    client = new DesktopDaemonClient({
      heartbeatMs: HEARTBEAT_MS,
      heartbeatMissTolerance: HEARTBEAT_MISS_TOLERANCE,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    cm = ConnectionManager.createForTest(client);
  });

  afterEach(() => {
    cm.dispose();
    client.disconnect();
    ConnectionManager.resetInstanceForTests();
    resetDesktopDaemonClientForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Drive connect to ready under fake timers.
   *
   * Client attemptConnect may spend up to ~3s in sidecar poll timers before openSocket;
   * soft-auth then needs either `{type:authenticated}` or AUTH_TIMEOUT_MS (3s).
   * Flush both layers so we never hang on a pending connect Promise.
   */
  async function connectUntilReady() {
    const connectP = cm.connect();

    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(100);
      // Allow real microtasks (dynamic import / queueMicrotask open) to settle.
      await Promise.resolve();
      await Promise.resolve();

      if (FakeWebSocket.instances.length > 0) {
        const ws = lastSocket();
        if (ws.readyState === FakeWebSocket.OPEN) {
          // Complete soft-auth if still waiting
          ws.simulateMessage({ type: 'authenticated' });
        }
      }

      if (cm.getState().phase === 'ready') {
        // Do not advance further — short-heartbeat tests would miss-out and reconnect.
        await connectP;
        return;
      }
    }

    // Drain sidecar poll leftovers + soft-auth timeout if still pending
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await Promise.resolve();
    if (FakeWebSocket.instances.length > 0) {
      const ws = lastSocket();
      if (ws.readyState === FakeWebSocket.OPEN) {
        ws.simulateMessage({ type: 'authenticated' });
      }
    }
    await vi.advanceTimersByTimeAsync(3_000);
    await connectP;
  }

  it(
    'maps client connected → authenticating → ready without independent probe timers',
    async () => {
      const phases: string[] = [];
      cm.onStateChange((s) => phases.push(s.phase));

      await connectUntilReady();

      expect(cm.getState().phase).toBe('ready');
      expect(cm.isReady()).toBe(true);
      expect(phases).toContain('connecting');
      expect(phases).toContain('authenticating');
      expect(phases).toContain('ready');

      // No echo probe frames from ConnectionManager
      const sent = lastSocket().sent.map((s) => JSON.parse(s) as { type?: string });
      expect(sent.some((m) => m.type === 'echo')).toBe(false);
      expect(sent.some((m) => m.type === 'authenticate')).toBe(true);
    },
    15_000,
  );

  it('does not call client.disconnect on transport drop — projects recovering', async () => {
    await connectUntilReady();
    expect(cm.getState().phase).toBe('ready');

    const disconnectSpy = vi.spyOn(client, 'disconnect');

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(0);

    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(client.isKeepAliveStarted()).toBe(true);
    expect(cm.getState().phase).toBe('recovering');
  });

  it('mirrors client heartbeat misses into probeMissCount (no second probe)', async () => {
    cm.dispose();
    client.disconnect();

    // Heartbeat slower than metrics mirror (500ms) so we can observe miss=1
    // without accumulating to HEARTBEAT_MISS_TOLERANCE and force-reconnecting.
    const shortHb = 1_000;
    client = new DesktopDaemonClient({
      heartbeatMs: shortHb,
      heartbeatMissTolerance: HEARTBEAT_MISS_TOLERANCE,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    cm = ConnectionManager.createForTest(client);

    await connectUntilReady();
    expect(cm.getState().phase).toBe('ready');

    // One interval: send ping (miss still 0)
    await vi.advanceTimersByTimeAsync(shortHb);
    expect(client.getPendingPingId()).not.toBeNull();
    expect(client.getHeartbeatMisses()).toBe(0);

    // Second interval without pong → miss = 1 (still under tolerance)
    await vi.advanceTimersByTimeAsync(shortHb);
    expect(client.getHeartbeatMisses()).toBe(1);

    // Metrics mirror interval is 500ms (no extra heartbeat tick within 500ms)
    await vi.advanceTimersByTimeAsync(500);
    expect(cm.getState().probeMissCount).toBe(1);

    const pending = client.getPendingPingId();
    if (pending) {
      lastSocket().simulateMessage({ type: 'pong', requestId: pending });
    } else {
      lastSocket().simulateMessage({ type: 'pong' });
    }
    // pong handler on CM syncs immediately via handleDaemonMessage
    expect(client.getHeartbeatMisses()).toBe(0);
    expect(cm.getState().probeMissCount).toBe(0);
  });

  it('connect is a no-op tear-down when client already connected', async () => {
    await connectUntilReady();

    const socketsBefore = FakeWebSocket.instances.length;
    await cm.connect();
    expect(FakeWebSocket.instances.length).toBe(socketsBefore);
    expect(cm.getState().phase).toBe('ready');
  });

  it('explicit disconnect is the only path that stops client keepAlive', async () => {
    await connectUntilReady();

    expect(client.isKeepAliveStarted()).toBe(true);
    cm.disconnect();
    expect(client.isKeepAliveStarted()).toBe(false);
    expect(cm.getState().phase).toBe('disconnected');
  });
});
