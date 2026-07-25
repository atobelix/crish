/**
 * DesktopDaemonClient — real Ping/Pong heartbeat + sole transport owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopDaemonClient,
  HEARTBEAT_MISS_TOLERANCE,
  resetDesktopDaemonClientForTests,
} from './daemonClient';

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
    // Open asynchronously so openSocket can attach listeners first.
    queueMicrotask(() => this.simulateOpen());
  }

  addEventListener(type: string, cb: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: Listener) {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not OPEN');
    }
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

function parseSent(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe('DesktopDaemonClient heartbeat (real Ping/Pong)', () => {
  const HEARTBEAT_MS = 100;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    resetDesktopDaemonClientForTests();
  });

  afterEach(() => {
    resetDesktopDaemonClientForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createClient() {
    return new DesktopDaemonClient({
      heartbeatMs: HEARTBEAT_MS,
      heartbeatMissTolerance: HEARTBEAT_MISS_TOLERANCE,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
  }

  async function connectClient(client: DesktopDaemonClient) {
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(client.isConnected()).toBe(true);
  }

  it('sends ping without clearing misses, clears misses only on pong', async () => {
    const client = createClient();
    await connectClient(client);
    const ws = lastSocket();

    expect(client.getHeartbeatMisses()).toBe(0);
    expect(client.getPendingPingId()).toBeNull();

    // First heartbeat tick → send ping, misses still 0 (no prior pending)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.getPendingPingId()).not.toBeNull();
    expect(client.getHeartbeatMisses()).toBe(0);

    const pings = parseSent(ws).filter((m) => m.type === 'ping');
    expect(pings.length).toBe(1);
    const pingId = String(pings[0].requestId ?? pings[0].id);
    expect(client.getPendingPingId()).toBe(pingId);

    // Misses must NOT be zeroed merely because we sent; still zero because no prior miss.
    // Advance again without pong → previous pending counts as miss.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.getHeartbeatMisses()).toBe(1);
    // New ping is outstanding
    expect(client.getPendingPingId()).not.toBeNull();

    // Correlated pong clears misses
    const pendingId = client.getPendingPingId()!;
    ws.simulateMessage({ type: 'pong', requestId: pendingId });
    expect(client.getHeartbeatMisses()).toBe(0);
    expect(client.getPendingPingId()).toBeNull();
    expect(client.getLastLatencyMs()).toBeGreaterThanOrEqual(0);

    client.disconnect();
  });

  it('accepts uncorrelated simple {type:pong} while a ping is outstanding', async () => {
    const client = createClient();
    await connectClient(client);
    const ws = lastSocket();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.getPendingPingId()).not.toBeNull();

    ws.simulateMessage({ type: 'pong' });
    expect(client.getHeartbeatMisses()).toBe(0);
    expect(client.getPendingPingId()).toBeNull();

    client.disconnect();
  });

  it('increments miss on no-pong and force-reconnects after tolerance', async () => {
    const client = createClient();
    await connectClient(client);
    const states: string[] = [];
    client.onState((s) => states.push(s));

    // Tick HEARTBEAT_MISS_TOLERANCE times without ever answering pong.
    // Tick 1: send ping (miss=0)
    // Tick 2: miss++ → 1, send new ping
    // Tick 3: miss++ → 2, send new ping
    // Tick 4: miss++ → 3 → close + reconnect
    for (let i = 0; i < HEARTBEAT_MISS_TOLERANCE + 1; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }

    expect(client.getHeartbeatMisses()).toBeGreaterThanOrEqual(HEARTBEAT_MISS_TOLERANCE);
    expect(client.getLastError()?.message).toMatch(/heartbeat failed/i);

    // Force-close should schedule reconnect (state reconnecting once timer fires path)
    // closeSocket is suppressCloseReconnect; scheduleReconnect sets reconnecting immediately.
    expect(states).toContain('reconnecting');
    expect(client.getState()).toBe('reconnecting');

    client.disconnect();
  });

  it('does not disconnect+reconnect when already connected (connect is no-op)', async () => {
    const client = createClient();
    await connectClient(client);
    const countBefore = FakeWebSocket.instances.length;

    await client.connect();
    expect(FakeWebSocket.instances.length).toBe(countBefore);
    expect(client.isConnected()).toBe(true);

    client.disconnect();
  });

  it('startKeepAlive is idempotent and owns reconnect after heartbeat death', async () => {
    const client = createClient();
    client.startKeepAlive();
    client.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    // allow connect promise
    await vi.advanceTimersByTimeAsync(10);
    expect(client.isKeepAliveStarted()).toBe(true);
    expect(client.isConnected()).toBe(true);

    const socketsBefore = FakeWebSocket.instances.length;

    for (let i = 0; i < HEARTBEAT_MISS_TOLERANCE + 1; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
    expect(client.getState()).toBe('reconnecting');

    // Advance past reconnect backoff (base 350ms + jitter up to 1000)
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    // A new socket should have been created by client's reconnect, not an external manager.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore);

    client.disconnect();
  });
});
