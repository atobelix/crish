/**
 * browserSessionApi invoke 桥测试：命令名 / 参数 / 三态错误路径 / 事件订阅。
 * invoke 走 test-setup 全局 mock（@tauri-apps/api/core）；事件订阅 mock
 * @tauri-apps/api/event（对齐 tauriTransport.test 先例）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import {
  BROWSER_START_CMD,
  BROWSER_STATE_EVENT,
  BROWSER_STATUS_CMD,
  BROWSER_STOP_CMD,
  fetchBrowserStatus,
  listenBrowserStateEvent,
  startBrowserSession,
  stopBrowserSession,
} from './browserSessionApi';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

function emitBrowserEvent(payload: unknown): void {
  for (const handler of eventMock.handlers.values()) {
    handler({ payload });
  }
}

describe('startBrowserSession / stopBrowserSession / fetchBrowserStatus', () => {
  it('start 成功：调用 browser_start 且返回引擎载荷', async () => {
    const impl = vi.fn(async () => ({ state: 'starting' as const }));
    mockTauriCommand(BROWSER_START_CMD, impl);
    const res = await startBrowserSession();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: 'ok', data: { state: 'starting' } });
  });

  it('start 命令未接线（missing）→ missing 三态', async () => {
    const res = await startBrowserSession();
    expect(res.status).toBe('missing');
  });

  it('start 命令报错 → error 三态（携带消息）', async () => {
    mockTauriError(BROWSER_START_CMD, new Error('engine busy'));
    const res = await startBrowserSession();
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('engine busy');
  });

  it('stop 成功：调用 browser_stop', async () => {
    const impl = vi.fn(async () => ({ state: 'stopped' as const }));
    mockTauriCommand(BROWSER_STOP_CMD, impl);
    const res = await stopBrowserSession();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: 'ok', data: { state: 'stopped' } });
  });

  it('stop 命令报错 → error 三态', async () => {
    mockTauriError(BROWSER_STOP_CMD, { kind: 'Internal', detail: 'no process' });
    const res = await stopBrowserSession();
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('no process');
  });

  it('status 成功：调用 browser_status 且返回状态与 url', async () => {
    const impl = vi.fn(async () => ({
      state: 'running' as const,
      url: 'https://example.com',
    }));
    mockTauriCommand(BROWSER_STATUS_CMD, impl);
    const res = await fetchBrowserStatus();
    expect(impl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      status: 'ok',
      data: { state: 'running', url: 'https://example.com' },
    });
  });
});

describe('listenBrowserStateEvent（事件订阅）', () => {
  beforeEach(() => {
    eventMock.handlers.clear();
    eventMock.listen.mockImplementation(
      async (event: string, handler: TauriEventHandler): Promise<() => void> => {
        eventMock.handlers.set(event, handler);
        return () => {
          eventMock.handlers.delete(event);
        };
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('按约定事件名订阅，回调收到引擎 payload', async () => {
    const handler = vi.fn();
    const unlisten = await listenBrowserStateEvent(handler);
    expect(eventMock.listen).toHaveBeenCalledWith(
      BROWSER_STATE_EVENT,
      expect.any(Function),
    );
    emitBrowserEvent({ state: 'running', url: 'https://a.b' });
    expect(handler).toHaveBeenCalledWith({ state: 'running', url: 'https://a.b' });
    unlisten();
    expect(eventMock.handlers.has(BROWSER_STATE_EVENT)).toBe(false);
  });
});
