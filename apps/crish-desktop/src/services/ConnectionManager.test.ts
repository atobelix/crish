/**
 * ConnectionManager — transport 驱动的核心连接状态投影器测试。
 * C3.1：无 WS 心跳 / 重连 / 认证；phase 由 isReady / onStatus / waitUntilConnected 驱动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport, TransportStatus } from '../api/transport';
import { ConnectionManager } from './ConnectionManager';

/** 可编程假 transport（模拟 onStatus / waitUntilConnected / isReady） */
class FakeTransport implements Transport {
  status: TransportStatus = 'disconnected';
  ready = false;
  private statusListeners = new Set<
    (s: TransportStatus, err?: Error) => void
  >();
  public waitResult = true;
  public waitResolve: ((v: boolean) => void) | null = null;

  call = vi.fn(async () => ({ status: 'ok' as const, data: null }));
  request = vi.fn(async () => null);
  send = vi.fn(async () => undefined);
  onMessage = vi.fn(() => () => undefined);
  stop = vi.fn(() => undefined);

  onStatus(listener: (s: TransportStatus, err?: Error) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  waitUntilConnected(_timeoutMs?: number): Promise<boolean> {
    // 镜像真实 TauriTransport：成功即置 ready + connected
    if (this.waitResult) {
      this.ready = true;
      this.status = 'connected';
    }
    return Promise.resolve(this.waitResult);
  }

  getStatus(): TransportStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 测试驱动：置状态并通知订阅者 */
  emitStatus(s: TransportStatus, err?: Error): void {
    this.status = s;
    if (s === 'connected') this.ready = true;
    if (s === 'disconnected' || s === 'failed') this.ready = false;
    for (const cb of this.statusListeners) {
      cb(s, err);
    }
  }
}

describe('ConnectionManager (transport 投影)', () => {
  let transport: FakeTransport;
  let cm: ConnectionManager;

  beforeEach(() => {
    ConnectionManager.resetInstanceForTests();
    transport = new FakeTransport();
    cm = ConnectionManager.createForTest(transport);
  });

  afterEach(() => {
    cm.dispose();
    ConnectionManager.resetInstanceForTests();
    vi.restoreAllMocks();
  });

  it('connect → waitUntilConnected 成功后 phase=ready 且 isReady=true', async () => {
    transport.waitResult = true;
    const phases: string[] = [];
    cm.onStateChange((s) => phases.push(s.phase));

    await cm.connect();

    expect(cm.getState().phase).toBe('ready');
    expect(cm.isReady()).toBe(true);
    expect(phases).toContain('ready');
  });

  it('connect → waitUntilConnected 失败时投影 recovering（不崩，等 onStatus 纠正）', async () => {
    transport.waitResult = false;
    await cm.connect();
    expect(cm.getState().phase).toBe('recovering');
    expect(cm.isReady()).toBe(false);
  });

  it('onStatus(connected) 直接驱动 ready；failed → recovering；disconnected → disconnected', async () => {
    transport.emitStatus('connecting');
    expect(cm.getState().phase).toBe('connecting');

    transport.emitStatus('connected');
    expect(cm.getState().phase).toBe('ready');
    expect(cm.isReady()).toBe(true);

    transport.emitStatus('failed');
    expect(cm.getState().phase).toBe('recovering');

    transport.emitStatus('disconnected');
    expect(cm.getState().phase).toBe('disconnected');
  });

  it('ready 后 connect 为 no-op（不重复 waitUntilConnected）', async () => {
    transport.emitStatus('connected');
    const spy = vi.spyOn(transport, 'waitUntilConnected');
    await cm.connect();
    await cm.connect();
    expect(spy).not.toHaveBeenCalled();
    expect(cm.getState().phase).toBe('ready');
  });

  it('disconnect 复位投影为 disconnected', async () => {
    transport.emitStatus('connected');
    expect(cm.getState().phase).toBe('ready');
    cm.disconnect();
    expect(cm.getState().phase).toBe('disconnected');
  });

  it('reconnect = disconnect + connect', async () => {
    transport.emitStatus('connected');
    await cm.reconnect();
    expect(cm.getState().phase).toBe('ready');
  });

  it('事件总线广播 daemon:connection:change（phase 随 ready 切换）', async () => {
    const received: string[] = [];
    const unsub = cm.onStateChange((s) => received.push(s.phase));
    transport.emitStatus('connected');
    transport.emitStatus('failed');
    unsub();
    expect(received).toEqual(['ready', 'recovering']);
  });
});
