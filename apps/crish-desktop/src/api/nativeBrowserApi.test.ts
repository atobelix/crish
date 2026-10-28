// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/api/nativeBrowserApi.test.ts
 *
 * 原生浏览器 API 单元测试。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  browserWebviewAction,
  browserWebviewAcquire,
  browserWebviewClose,
  browserWebviewCreate,
  browserWebviewNavigate,
  browserWebviewSetBounds,
  browserWebviewSetHitTest,
  browserWebviewSetMuted,
  browserWebviewSetVisible,
  onNativeBrowserDownloadProgress,
  onNativeBrowserNavigationState,
  EVENT_BROWSER_DOWNLOAD_PROGRESS,
  EVENT_BROWSER_NAVIGATION_STATE,
  type NavigationStatePayload,
  type DownloadProgressPayload,
} from './nativeBrowserApi';
import { resetNativeBrowserLifecyclesForTesting } from './nativeBrowserLifecycle';
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../test-setup';
import { resetNativeBrowserLifecyclesForTesting } from './nativeBrowserLifecycle';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

describe('nativeBrowserApi', () => {
  const tabId = 'tab-test-1';

  beforeEach(() => {
    vi.clearAllMocks();
    resetNativeBrowserLifecyclesForTesting();
    resetNativeBrowserLifecyclesForTesting();
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
        visible: true,
      });
    });

    it('首次创建隐藏 tab 时把 visible=false 交给原生 create，不发创建后 hide', async () => {
      const hiddenTabId = 'tab-create-hidden';
      const commandOrder: string[] = [];
      mockTauriCommand('browser_webview_create', (args: any) => {
        commandOrder.push(`create:${args.visible}`);
        return null;
      });
      mockTauriCommand('browser_webview_set_visible', (args: any) => {
        commandOrder.push(`visible:${args.visible}`);
        return null;
      });
      mockTauriCommand('browser_webview_close', () => null);

      await browserWebviewCreate({
        tabId: hiddenTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        visible: false,
      });

      expect(commandOrder).toEqual(['create:false']);
      await browserWebviewClose(hiddenTabId);
    });

    it('同一 tabId 的并发 create 只调用一次原生命令', async () => {
      const concurrentTabId = 'tab-create-single-flight';
      let releaseCreate!: () => void;
      let signalCreateStarted!: () => void;
      let createCalls = 0;
      const createStarted = new Promise<void>((resolve) => {
        signalCreateStarted = resolve;
      });
      mockTauriCommand('browser_webview_create', () => {
        createCalls += 1;
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      });
      mockTauriCommand('browser_webview_close', () => null);

      const args = {
        tabId: concurrentTabId,
        initialUrl: 'https://example.com',
        bounds: { x: 1, y: 2, width: 640, height: 480 },
        visible: true,
      };
      const firstCreate = browserWebviewCreate(args);
      await createStarted;
      const secondCreate = browserWebviewCreate(args);

      expect(createCalls).toBe(1);
      releaseCreate();
      await Promise.all([firstCreate, secondCreate]);
      await browserWebviewClose(concurrentTabId);
    });

    it('并发 create 的新 URL、bounds 与显隐状态在首个 create 后同步', async () => {
      const tabId = 'tab-create-reconcile-latest';
      const commandOrder: string[] = [];
      let releaseCreate!: () => void;
      let signalCreateStarted!: () => void;
      const createStarted = new Promise<void>((resolve) => {
        signalCreateStarted = resolve;
      });
      mockTauriCommand('browser_webview_create', () => {
        commandOrder.push('create');
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      });
      mockTauriCommand('browser_webview_set_visible', (args: any) => {
        commandOrder.push(`visible:${args.visible}`);
        return null;
      });
      mockTauriCommand('browser_webview_set_bounds', () => {
        commandOrder.push('bounds');
        return null;
      });
      mockTauriCommand('browser_webview_navigate', (args: any) => {
        commandOrder.push(`navigate:${args.url}`);
        return null;
      });
      mockTauriCommand('browser_webview_close', () => null);

      const firstCreate = browserWebviewCreate({
        tabId,
        initialUrl: 'https://first.example',
        bounds: { x: 0, y: 0, width: 300, height: 200 },
        visible: false,
      });
      await createStarted;
      const latestCreate = browserWebviewCreate({
        tabId,
        initialUrl: 'https://latest.example',
        bounds: { x: 5, y: 6, width: 500, height: 400 },
        visible: true,
      });

      releaseCreate();
      await Promise.all([firstCreate, latestCreate]);

      expect(commandOrder).toEqual([
        'create',
        'bounds',
        'navigate:https://latest.example',
        'visible:true',
      ]);
      await browserWebviewClose(tabId);
    });

    it('create 前的导航等待创建完成后按序发送', async () => {
      const queuedTabId = 'tab-navigation-queued-before-create';
      const releaseLease = browserWebviewAcquire(queuedTabId);
      const commandOrder: string[] = [];
      mockTauriCommand('browser_webview_create', () => {
        commandOrder.push('create');
        return null;
      });
      mockTauriCommand('browser_webview_navigate', (args: any) => {
        commandOrder.push(`navigate:${args.url}`);
        return null;
      });
      mockTauriCommand('browser_webview_set_visible', () => null);
      mockTauriCommand('browser_webview_close', () => null);

      let navigationFinished = false;
      const navigation = browserWebviewNavigate(
        queuedTabId,
        'https://queued-first.example'
      );
      const secondNavigation = browserWebviewNavigate(
        queuedTabId,
        'https://queued-second.example'
      );
      const navigations = Promise.all([navigation, secondNavigation]).then(
        () => {
          navigationFinished = true;
        }
      );
      await Promise.resolve();
      expect(navigationFinished).toBe(false);
      expect(commandOrder).toEqual([]);

      await browserWebviewCreate({
        tabId: queuedTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        visible: false,
      });
      await navigations;

      expect(commandOrder).toEqual([
        'create',
        'navigate:https://queued-first.example',
        'navigate:https://queued-second.example',
      ]);
      await browserWebviewClose(queuedTabId);
      releaseLease();
    });

    it('create 失败时明确拒绝所有排队导航', async () => {
      const failedTabId = 'tab-navigation-create-fails';
      const releaseLease = browserWebviewAcquire(failedTabId);
      const createError = new Error('native create failed');
      mockTauriError('browser_webview_create', createError);
      mockTauriCommand('browser_webview_close', () => null);

      const navigation = browserWebviewNavigate(
        failedTabId,
        'https://queued.example'
      );
      const navigationFailure = expect(navigation).rejects.toThrow(
        'native create failed'
      );
      await expect(
        browserWebviewCreate({
          tabId: failedTabId,
          initialUrl: 'about:blank',
          bounds: { x: 0, y: 0, width: 400, height: 300 },
        })
      ).rejects.toThrow('native create failed');
      await navigationFailure;

      await expect(
        browserWebviewNavigate(failedTabId, 'https://still-failed.example')
      ).rejects.toThrow('create is retried');
      mockTauriCommand('browser_webview_create', () => null);
      mockTauriCommand('browser_webview_navigate', () => null);
      await browserWebviewCreate({
        tabId: failedTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      });
      await browserWebviewNavigate(failedTabId, 'https://retry.example');
      await browserWebviewClose(failedTabId);
      releaseLease();
    });

    it('lease 重挂时清除旧等待态，最后释放时回收 close tombstone', async () => {
      const leasedTabId = 'tab-lifecycle-lease-reacquire';
      const releaseFirst = browserWebviewAcquire(leasedTabId);
      const abandonedNavigation = browserWebviewNavigate(
        leasedTabId,
        'https://abandoned.example'
      );
      const abandonedFailure = expect(abandonedNavigation).rejects.toThrow(
        /lease released|no active owner/
      );

      // 对应 StrictMode 的 acquire -> release -> acquire 效果重放。
      releaseFirst();
      await abandonedFailure;

      const releaseSecond = browserWebviewAcquire(leasedTabId);
      const commandOrder: string[] = [];
      mockTauriCommand('browser_webview_create', () => {
        commandOrder.push('create');
        return null;
      });
      mockTauriCommand('browser_webview_navigate', (args: any) => {
        commandOrder.push(`navigate:${args.url}`);
        return null;
      });
      mockTauriCommand('browser_webview_close', () => null);

      const navigation = browserWebviewNavigate(
        leasedTabId,
        'https://active.example'
      );
      await browserWebviewCreate({
        tabId: leasedTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      });
      await navigation;
      await browserWebviewClose(leasedTabId);
      await expect(
        browserWebviewNavigate(leasedTabId, 'https://late.example')
      ).rejects.toThrow('closed');
      releaseSecond();

      await expect(
        browserWebviewNavigate(leasedTabId, 'https://orphan.example')
      ).rejects.toThrow('without an active lifecycle lease');
      expect(commandOrder).toEqual([
        'create',
        'navigate:https://active.example',
      ]);
    });

    it('没有生命周期 lease 时单独 navigate 明确 reject', async () => {
      await expect(
        browserWebviewNavigate(
          'tab-without-lifecycle',
          'https://orphan.example'
        )
      ).rejects.toThrow('without an active lifecycle lease');
    });

    it('最后一个 lease 在 create 在途时释放，会拒绝导航并串行关闭晚到的 child', async () => {
      const tabId = 'tab-release-during-create';
      const releaseLease = browserWebviewAcquire(tabId);
      const commandOrder: string[] = [];
      let releaseCreate!: () => void;
      let signalCreateStarted!: () => void;
      const createStarted = new Promise<void>((resolve) => {
        signalCreateStarted = resolve;
      });
      mockTauriCommand('browser_webview_create', () => {
        commandOrder.push('create');
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      });
      mockTauriCommand('browser_webview_close', () => {
        commandOrder.push('close');
        return null;
      });

      const create = browserWebviewCreate({
        tabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 320, height: 240 },
      });
      await createStarted;
      const navigation = browserWebviewNavigate(
        tabId,
        'https://queued.example'
      );
      const navigationFailure =
        expect(navigation).rejects.toThrow('no active owner');
      releaseLease();
      await navigationFailure;

      releaseCreate();
      await create;
      await browserWebviewClose(tabId);
      expect(commandOrder).toEqual(['create', 'close']);
    });

    it('最后一个 lease 释放时回收 failed create 状态', async () => {
      const tabId = 'tab-release-after-failed-create';
      const releaseLease = browserWebviewAcquire(tabId);
      mockTauriError('browser_webview_create', new Error('create failed'));

      await expect(
        browserWebviewCreate({
          tabId,
          initialUrl: 'about:blank',
          bounds: { x: 0, y: 0, width: 320, height: 240 },
        })
      ).rejects.toThrow('create failed');
      releaseLease();

      await expect(
        browserWebviewNavigate(tabId, 'https://after-release.example')
      ).rejects.toThrow('without an active lifecycle lease');
    });

    it('close 清除已创建状态，允许后续为同一 tabId 重新 create', async () => {
      const reopenedTabId = 'tab-create-after-close';
      const releaseLease = browserWebviewAcquire(reopenedTabId);
      let createCalls = 0;
      mockTauriCommand('browser_webview_create', () => {
        createCalls += 1;
        return null;
      });
      mockTauriCommand('browser_webview_close', () => null);

      const args = {
        tabId: reopenedTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 320, height: 240 },
      };
      await browserWebviewCreate(args);
      await browserWebviewClose(reopenedTabId);
      await browserWebviewCreate(args);

      expect(createCalls).toBe(2);
      await browserWebviewClose(reopenedTabId);
      await expect(
        browserWebviewNavigate(reopenedTabId, 'https://after-close.example')
      ).rejects.toThrow('closed');
      releaseLease();
    });

    it('create 在途时 close 等待创建结束，期间导航明确拒绝', async () => {
      const closingTabId = 'tab-close-during-create';
      const releaseLease = browserWebviewAcquire(closingTabId);
      const commandOrder: string[] = [];
      let releaseCreate!: () => void;
      let signalCreateStarted!: () => void;
      const createStarted = new Promise<void>((resolve) => {
        signalCreateStarted = resolve;
      });
      mockTauriCommand('browser_webview_create', () => {
        commandOrder.push('create');
        signalCreateStarted();
        return new Promise((resolve) => {
          releaseCreate = () => resolve(null);
        });
      });
      mockTauriCommand('browser_webview_close', () => {
        commandOrder.push('close');
        return null;
      });

      const create = browserWebviewCreate({
        tabId: closingTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 320, height: 240 },
      });
      await createStarted;
      const close = browserWebviewClose(closingTabId);
      await expect(
        browserWebviewNavigate(closingTabId, 'https://closed.example')
      ).rejects.toThrow('closed');

      releaseCreate();
      await Promise.all([create, close]);
      expect(commandOrder).toEqual(['create', 'close']);
      releaseLease();
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

    it('browserWebviewSetHitTest 返回后端明确的 unsupported 诊断', async () => {
      mockTauriCommand('browser_webview_set_hit_test', (args: any) => {
        expect(args).toMatchObject({ tabId, hitTest: false });
        return {
          status: 'unsupported',
          reason: 'native hit-test is unavailable',
        };
      });

      await expect(browserWebviewSetHitTest(tabId, false)).resolves.toEqual({
        status: 'unsupported',
        reason: 'native hit-test is unavailable',
      });
    });

    it('browserWebviewSetHitTest 将 transport error 与 missing 显式 reject', async () => {
      mockTauriError(
        'browser_webview_set_hit_test',
        new Error('hit-test IPC failed')
      );
      await expect(browserWebviewSetHitTest(tabId, true)).rejects.toThrow(
        'hit-test IPC failed'
      );

      mockTauriMissing('browser_webview_set_hit_test');
      await expect(browserWebviewSetHitTest(tabId, true)).rejects.toThrow(
        'Tauri command is unavailable: browser_webview_set_hit_test'
      );
    });

    it('browserWebviewNavigate 在创建后调用', async () => {
      const navTabId = 'tab-navigate-test';
      let passedArgs: unknown = null;
      mockTauriCommand('browser_webview_create', () => null);
      mockTauriCommand('browser_webview_navigate', (args) => {
        passedArgs = args;
        return null;
      });
      mockTauriCommand('browser_webview_close', () => null);

      await browserWebviewCreate({
        tabId: navTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      });
      await browserWebviewNavigate(navTabId, 'https://github.com');
      expect(passedArgs).toMatchObject({
        tabId: navTabId,
        url: 'https://github.com',
      });
      await browserWebviewClose(navTabId);
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

    it('动作与静音命令缺失时都明确 reject', async () => {
      mockTauriMissing('browser_webview_action');
      mockTauriMissing('browser_webview_set_muted');

      await expect(browserWebviewAction(tabId, 'back')).rejects.toThrow(
        'Tauri command is unavailable: browser_webview_action'
      );
      await expect(browserWebviewSetMuted(tabId, true)).rejects.toThrow(
        'Tauri command is unavailable: browser_webview_set_muted'
      );
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
      const errorTabId = 'tab-navigation-command-error';
      mockTauriCommand('browser_webview_create', () => null);
      mockTauriCommand('browser_webview_close', () => null);
      await browserWebviewCreate({
        tabId: errorTabId,
        initialUrl: 'about:blank',
        bounds: { x: 0, y: 0, width: 320, height: 240 },
      });
      mockTauriError(
        'browser_webview_navigate',
        new Error('Security error: forbidden protocol')
      );

      await expect(
        browserWebviewNavigate(errorTabId, 'file:///etc/passwd')
      ).rejects.toThrow('Security error: forbidden protocol');
      await browserWebviewClose(errorTabId);
    });
  });

  describe('event listeners', () => {
    it('navigation-state 可省略原生历史能力字段', async () => {
      let listenerCallback:
        ((event: { payload: NavigationStatePayload }) => void) | null = null;
      vi.mocked(listen).mockImplementation(async (_eventName, cb) => {
        listenerCallback = cb as any;
        return vi.fn();
      });

      const received: NavigationStatePayload[] = [];
      const cleanup = onNativeBrowserNavigationState((payload) =>
        received.push(payload)
      );
      await Promise.resolve();

      const payload: NavigationStatePayload = {
        tabId,
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
      };
      listenerCallback?.({ payload });

      expect(received).toEqual([payload]);
      expect(received[0].canGoBack).toBeUndefined();
      expect(received[0].canGoForward).toBeUndefined();
      cleanup();
    });

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
