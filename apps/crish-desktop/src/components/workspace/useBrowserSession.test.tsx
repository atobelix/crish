/**
 * useBrowserSession hook 测试：初始查询 / 事件驱动状态机 / 操作 invoke / 错误路径。
 * invoke 走 test-setup 全局 mock；事件订阅 mock @tauri-apps/api/event。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import { useBrowserSession } from './useBrowserSession';
import {
  BROWSER_START_CMD,
  BROWSER_STATE_EVENT,
  BROWSER_STATUS_CMD,
  BROWSER_STOP_CMD,
} from '../../api/browserSessionApi';

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

function setupDefaultStatus() {
  mockTauriCommand(BROWSER_STATUS_CMD, async () => ({ state: 'idle' as const }));
}

describe('useBrowserSession', () => {
  const toast = vi.fn();

  beforeEach(() => {
    toast.mockClear();
    eventMock.handlers.clear();
    eventMock.listen.mockImplementation(
      async (event: string, handler: TauriEventHandler): Promise<() => void> => {
        eventMock.handlers.set(event, handler);
        return () => {
          eventMock.handlers.delete(event);
        };
      },
    );
    setupDefaultStatus();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('挂载：查询 browser_status 并同步状态与 url', async () => {
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'running' as const,
      url: 'https://example.com',
    }));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('running'));
    expect(result.current.url).toBe('https://example.com');
    expect(toast).not.toHaveBeenCalled();
  });

  it('挂载：查询失败 → error 状态 + 错误 toast（引擎未接线诊断）', async () => {
    mockTauriError(BROWSER_STATUS_CMD, new Error('command not registered'));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/查询浏览器状态失败/),
    );
  });

  it('订阅 browser://state-changed：事件驱动状态迁移（含 url）', async () => {
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    act(() => emitBrowserEvent({ state: 'launching' }));
    expect(result.current.state).toBe('launching');

    act(() => emitBrowserEvent({ state: 'running', url: 'https://a.b' }));
    expect(result.current.state).toBe('running');
    expect(result.current.url).toBe('https://a.b');

    act(() => emitBrowserEvent({ state: 'stopping' }));
    expect(result.current.state).toBe('stopping');

    act(() => emitBrowserEvent({ state: 'stopped' }));
    expect(result.current.state).toBe('stopped');
  });

  it('事件 payload 中的 starting 归一为 launching', async () => {
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));
    act(() => emitBrowserEvent({ state: 'starting' }));
    expect(result.current.state).toBe('launching');
  });

  it('非法事件载荷静默丢弃（状态不变、无 toast）', async () => {
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));
    act(() => emitBrowserEvent({ state: 'unknown' }));
    act(() => emitBrowserEvent(null));
    act(() => emitBrowserEvent('running'));
    expect(result.current.state).toBe('idle');
    expect(toast).not.toHaveBeenCalled();
  });

  it('start：调用 browser_start；starting 归一为 launching', async () => {
    const impl = vi.fn(async () => ({ state: 'starting' as const }));
    mockTauriCommand(BROWSER_START_CMD, impl);
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('launching'));
    expect(impl).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('start：返回 error + reason → error 状态 + 失败 toast', async () => {
    mockTauriCommand(BROWSER_START_CMD, async () => ({
      state: 'error' as const,
      reason: 'chrome missing',
    }));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/启动浏览器失败/));
  });

  it('start：invoke 报错 → error 状态 + 错误 toast', async () => {
    mockTauriError(BROWSER_START_CMD, new Error('engine busy'));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/启动浏览器失败：engine busy/),
    );
  });

  it('stop：调用 browser_stop 并置 stopped', async () => {
    const impl = vi.fn(async () => ({ state: 'stopped' as const }));
    mockTauriCommand(BROWSER_STOP_CMD, impl);
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({ state: 'running' as const }));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('running'));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe('stopped'));
    expect(impl).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('stop：invoke 报错 → error 状态 + 错误 toast', async () => {
    mockTauriError(BROWSER_STOP_CMD, new Error('kill failed'));
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({ state: 'running' as const }));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('running'));

    act(() => result.current.kill());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/停止浏览器失败：kill failed/),
    );
  });

  it('kill 与 stop 同一命令（急停走 browser_stop）', async () => {
    const impl = vi.fn(async () => ({ state: 'stopped' as const }));
    mockTauriCommand(BROWSER_STOP_CMD, impl);
    mockTauriCommand(BROWSER_STATUS_CMD, async () => ({
      state: 'launching' as const,
    }));
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('launching'));

    act(() => result.current.kill());
    await waitFor(() => expect(result.current.state).toBe('stopped'));
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('busy：操作进行中为 true，完成后复位（互斥防连点）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockTauriCommand(
      BROWSER_START_CMD,
      () => gate.then(() => ({ state: 'running' as const })),
    );
    const { result } = renderHook(() => useBrowserSession({ onShowToast: toast }));
    await waitFor(() => expect(result.current.state).toBe('idle'));

    act(() => result.current.start());
    expect(result.current.busy).toBe(true);
    // busy 期间的第二次 start 被互斥拦截（invoke 只调用一次）
    act(() => result.current.start());
    expect(result.current.busy).toBe(true);

    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.state).toBe('running');
  });

  it('卸载：取消监听与未决状态更新', async () => {
    const { result, unmount } = renderHook(() =>
      useBrowserSession({ onShowToast: toast }),
    );
    await waitFor(() => expect(eventMock.handlers.has(BROWSER_STATE_EVENT)).toBe(true));
    unmount();
    expect(eventMock.handlers.has(BROWSER_STATE_EVENT)).toBe(false);
    // 卸载后事件不再驱动状态（no-op，不抛错）
    act(() => emitBrowserEvent({ state: 'running' }));
    expect(result.current.state).toBe('idle');
  });
});
