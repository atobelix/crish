// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIpcListener } from './useIpcListener';

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

describe('useIpcListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to IPC event and forwards payloads to handler', async () => {
    let capturedCallback:
      ((e: { event: string; id: number; payload: string }) => void) | null =
      null;
    const unlistenMock = vi.fn();

    eventMock.listen.mockImplementation(async (_name: string, cb: unknown) => {
      capturedCallback = cb as typeof capturedCallback;
      return unlistenMock;
    });

    const handler = vi.fn();
    const { unmount } = renderHook(() => useIpcListener('test-event', handler));

    await act(async () => {
      await Promise.resolve();
    });

    expect(eventMock.listen).toHaveBeenCalledWith(
      'test-event',
      expect.any(Function),
      undefined
    );

    // Emit event
    act(() => {
      capturedCallback?.({ event: 'test-event', id: 1, payload: 'payload-1' });
    });

    expect(handler).toHaveBeenCalledWith({
      event: 'test-event',
      id: 1,
      payload: 'payload-1',
    });

    // Unmount
    unmount();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it('uses the latest handler reference without re-subscribing', async () => {
    let capturedCallback:
      ((e: { event: string; id: number; payload: string }) => void) | null =
      null;
    const unlistenMock = vi.fn();

    eventMock.listen.mockImplementation(async (_name: string, cb: unknown) => {
      capturedCallback = cb as typeof capturedCallback;
      return unlistenMock;
    });

    let count = 0;
    const handler1 = vi.fn(() => {
      count = 1;
    });
    const handler2 = vi.fn(() => {
      count = 2;
    });

    const { rerender } = renderHook(
      ({ cb }) => useIpcListener('test-event', cb),
      { initialProps: { cb: handler1 } }
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(eventMock.listen).toHaveBeenCalledTimes(1);

    // Update handler prop
    rerender({ cb: handler2 });
    expect(eventMock.listen).toHaveBeenCalledTimes(1); // Did not re-subscribe

    // Emit event
    act(() => {
      capturedCallback?.({ event: 'test-event', id: 1, payload: 'data' });
    });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
    expect(count).toBe(2);
  });

  it('safely handles fast unmount race before listen resolves (StrictMode protection)', async () => {
    const unlistenMock = vi.fn();
    let resolveListen!: (unlisten: () => void) => void;

    eventMock.listen.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveListen = resolve;
      });
    });

    const handler = vi.fn();
    const { unmount } = renderHook(() => useIpcListener('race-event', handler));

    // Fast unmount occurs BEFORE listen resolves!
    unmount();
    expect(unlistenMock).not.toHaveBeenCalled();

    // Now listen resolves
    await act(async () => {
      resolveListen(unlistenMock);
      await Promise.resolve();
    });

    // Unlisten should be immediately executed to prevent leak
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it('does not listen when enabled is false', async () => {
    const handler = vi.fn();

    renderHook(() =>
      useIpcListener('disabled-event', handler, { enabled: false })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(eventMock.listen).not.toHaveBeenCalled();
  });

  it('handles listen rejection without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    eventMock.listen.mockRejectedValue(new Error('IPC unavailable'));

    const handler = vi.fn();
    renderHook(() => useIpcListener('failing-event', handler));

    await act(async () => {
      await Promise.resolve();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failing-event'),
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });
});
