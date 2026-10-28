// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import {
  browserWebviewSetInspector,
  EVENT_BROWSER_INSPECTOR,
  onNativeBrowserInspectorEvent,
} from './nativeBrowserInspectorApi';
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../../test-setup';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('nativeBrowserInspectorApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('启停调用使用 native inspector command 契约', async () => {
    const calls: unknown[] = [];
    mockTauriCommand('browser_webview_set_inspector', (args) => {
      calls.push(args);
      return null;
    });

    await browserWebviewSetInspector('browser-leaf-a', true);
    await browserWebviewSetInspector('browser-leaf-a', false);

    expect(calls).toEqual([
      { tabId: 'browser-leaf-a', enabled: true },
      { tabId: 'browser-leaf-a', enabled: false },
    ]);
  });

  it('命令 transport error 和 missing 都明确 reject', async () => {
    mockTauriError(
      'browser_webview_set_inspector',
      new Error('inspector command failed')
    );
    await expect(
      browserWebviewSetInspector('browser-leaf-a', true)
    ).rejects.toThrow('inspector command failed');

    mockTauriMissing('browser_webview_set_inspector');
    await expect(
      browserWebviewSetInspector('browser-leaf-a', true)
    ).rejects.toThrow('Tauri command is unavailable');
  });

  it('订阅并校验 inspector event envelope，再安全注销 listener', async () => {
    let receive!: (event: { payload: unknown }) => void;
    const stopListening = vi.fn();
    vi.mocked(listen).mockImplementation(async (eventName, callback) => {
      expect(eventName).toBe(EVENT_BROWSER_INSPECTOR);
      receive = callback as (event: { payload: unknown }) => void;
      return stopListening;
    });

    const events: unknown[] = [];
    const onReady = vi.fn();
    const onError = vi.fn();
    const unsubscribe = onNativeBrowserInspectorEvent(
      (event) => events.push(event),
      { onReady, onError }
    );
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    receive({
      payload: {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'button',
          selector: 'button.primary',
          rect: { x: 1, y: 2, width: 40, height: 20 },
        },
      },
    });
    receive({ payload: { tabId: 'browser-leaf-a', type: 'UNKNOWN' } });
    receive({
      payload: {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_READY',
      },
    });
    receive({
      payload: {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_TOGGLE',
        payload: { enabled: false },
      },
    });
    receive({
      payload: {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_TOGGLE',
        payload: { enabled: true },
      },
    });
    receive({
      payload: {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_SELECT',
        payload: { tagName: 'button' },
      },
    });

    expect(events).toEqual([
      {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'button',
          selector: 'button.primary',
          rect: { x: 1, y: 2, width: 40, height: 20 },
        },
      },
      { tabId: 'browser-leaf-a', type: 'INSPECT_READY' },
      {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_TOGGLE',
        payload: { enabled: false },
      },
    ]);

    unsubscribe();
    expect(stopListening).toHaveBeenCalledTimes(1);
    receive({
      payload: {
        tabId: 'browser-leaf-a',
        type: 'INSPECT_READY',
        payload: {},
      },
    });
    expect(events).toHaveLength(3);
  });

  it('listen 失败时通知调用方且不会错误通知 ready', async () => {
    vi.mocked(listen).mockRejectedValue(new Error('event listen denied'));
    const onReady = vi.fn();
    const onError = vi.fn();
    const unsubscribe = onNativeBrowserInspectorEvent(vi.fn(), {
      onReady,
      onError,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0]?.[0].message).toBe('event listen denied');
    unsubscribe();
  });

  it('异步 listener 安装完成前注销也会立即释放 listener', async () => {
    let resolveListen!: (unlisten: () => void) => void;
    const stopListening = vi.fn();
    vi.mocked(listen).mockReturnValue(
      new Promise((resolve) => {
        resolveListen = resolve as (unlisten: () => void) => void;
      })
    );

    const unsubscribe = onNativeBrowserInspectorEvent(vi.fn());
    unsubscribe();
    resolveListen(stopListening);
    await Promise.resolve();

    expect(stopListening).toHaveBeenCalledTimes(1);
  });
});
