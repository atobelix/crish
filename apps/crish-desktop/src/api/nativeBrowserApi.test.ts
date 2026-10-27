// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/api/nativeBrowserApi.test.ts
 *
 * 原生浏览器 API 单元测试。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  browserWebviewAction,
  browserWebviewClose,
  browserWebviewCreate,
  browserWebviewNavigate,
  browserWebviewSetBounds,
  browserWebviewSetMuted,
  browserWebviewSetVisible,
  onNativeBrowserDownloadProgress,
  onNativeBrowserNavigationState,
  EVENT_BROWSER_DOWNLOAD_PROGRESS,
  EVENT_BROWSER_NAVIGATION_STATE,
  type NavigationStatePayload,
  type DownloadProgressPayload,
} from './nativeBrowserApi';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

describe('nativeBrowserApi', () => {
  const tabId = 'tab-test-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('invoke commands', () => {
    it('browserWebviewCreate 正常调用', async () => {
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_create', (args) => {
        passedArgs = args;
        return null;
      });

      await browserWebviewCreate({
        tabId,
        initialUrl: 'https://example.com',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
      });

      expect(passedArgs).toMatchObject({
        tabId,
        initialUrl: 'https://example.com',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      });
    });

    it('browserWebviewSetBounds 正常调用', async () => {
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_set_bounds', (args) => {
        passedArgs = args;
        return null;
      });

      const bounds = { x: 10, y: 20, width: 1000, height: 700 };
      await browserWebviewSetBounds(tabId, bounds);

      expect(passedArgs).toMatchObject({ tabId, bounds });
    });

    it('browserWebviewSetVisible 正常调用', async () => {
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_set_visible', (args) => {
        passedArgs = args;
        return null;
      });

      await browserWebviewSetVisible(tabId, false);
      expect(passedArgs).toMatchObject({ tabId, visible: false });

      await browserWebviewSetVisible(tabId, true);
      expect(passedArgs).toMatchObject({ tabId, visible: true });
    });

    it('browserWebviewNavigate 正常调用', async () => {
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_navigate', (args) => {
        passedArgs = args;
        return null;
      });

      await browserWebviewNavigate(tabId, 'https://github.com');
      expect(passedArgs).toMatchObject({ tabId, url: 'https://github.com' });
    });

    it('browserWebviewAction 正常调用各种动作', async () => {
      const actionsSent: string[] = [];
      mockTauriCommand('browser_webview_action', (args: any) => {
        actionsSent.push(args.action);
        return null;
      });

      await browserWebviewAction(tabId, 'back');
      await browserWebviewAction(tabId, 'forward');
      await browserWebviewAction(tabId, 'reload');
      await browserWebviewAction(tabId, 'reload_ignoring_cache');
      await browserWebviewAction(tabId, 'stop');

      expect(actionsSent).toEqual([
        'back',
        'forward',
        'reload',
        'reload_ignoring_cache',
        'stop',
      ]);
    });

    it('browserWebviewClose 正常调用', async () => {
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_close', (args) => {
        passedArgs = args;
        return null;
      });

      await browserWebviewClose(tabId);
      expect(passedArgs).toMatchObject({ tabId });
    });

    it('browserWebviewSetMuted 正常调用', async () => {
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_set_muted', (args) => {
        passedArgs = args;
        return null;
      });

      await browserWebviewSetMuted(tabId, true);
      expect(passedArgs).toMatchObject({ tabId, muted: true });
    });

    it('命令失败时抛出 Error', async () => {
      mockTauriError(
        'browser_webview_navigate',
        new Error('Security error: forbidden protocol')
      );

      await expect(
        browserWebviewNavigate(tabId, 'file:///etc/passwd')
      ).rejects.toThrow('Security error: forbidden protocol');
    });
  });

  describe('event listeners', () => {
    it('onNativeBrowserNavigationState 订阅并接收事件', async () => {
      const unlisten = vi.fn();
      let listenerCallback:
        ((event: { payload: NavigationStatePayload }) => void) | null = null;

      vi.mocked(listen).mockImplementation(async (eventName, cb) => {
        if (eventName === EVENT_BROWSER_NAVIGATION_STATE) {
          listenerCallback = cb as any;
        }
        return unlisten;
      });

      const received: NavigationStatePayload[] = [];
      const cleanup = onNativeBrowserNavigationState((payload) => {
        received.push(payload);
      });

      // 等待微任务中的 listen Promise 建立
      await Promise.resolve();

      expect(listen).toHaveBeenCalledWith(
        EVENT_BROWSER_NAVIGATION_STATE,
        expect.any(Function)
      );

      // 模拟触发事件
      const samplePayload: NavigationStatePayload = {
        tabId,
        url: 'https://news.ycombinator.com',
        title: 'Hacker News',
        canGoBack: true,
        canGoForward: false,
        isLoading: false,
        faviconUrl: 'https://news.ycombinator.com/favicon.ico',
        httpStatus: 200,
      };

      listenerCallback?.({ payload: samplePayload });
      expect(received).toEqual([samplePayload]);

      // 验证注销
      cleanup();
      await Promise.resolve();
      expect(unlisten).toHaveBeenCalled();
    });

    it('onNativeBrowserDownloadProgress 订阅并接收事件', async () => {
      const unlisten = vi.fn();
      let listenerCallback:
        ((event: { payload: DownloadProgressPayload }) => void) | null = null;

      vi.mocked(listen).mockImplementation(async (eventName, cb) => {
        if (eventName === EVENT_BROWSER_DOWNLOAD_PROGRESS) {
          listenerCallback = cb as any;
        }
        return unlisten;
      });

      const received: DownloadProgressPayload[] = [];
      const cleanup = onNativeBrowserDownloadProgress((payload) => {
        received.push(payload);
      });

      await Promise.resolve();

      expect(listen).toHaveBeenCalledWith(
        EVENT_BROWSER_DOWNLOAD_PROGRESS,
        expect.any(Function)
      );

      const samplePayload: DownloadProgressPayload = {
        tabId,
        downloadId: 'dl-1',
        url: 'https://example.com/file.zip',
        filename: 'file.zip',
        receivedBytes: 500,
        totalBytes: 1000,
        state: 'progress',
      };

      listenerCallback?.({ payload: samplePayload });
      expect(received).toEqual([samplePayload]);

      cleanup();
      await Promise.resolve();
      expect(unlisten).toHaveBeenCalled();
    });
  });
});
