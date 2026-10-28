// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/workspace/usePreviewNavigation.test.tsx
 *
 * usePreviewNavigation 原生化改造与解耦单元测试。
 * 覆盖：
 * 1. 彻底清退 <iframe> 残留契约（零 iframeRef、零 onFrameLoad/onFrameError）；
 * 2. 统一 Tab ID 命名真理来源（SSOT：resolveBrowserTabId）；
 * 3. 输入 URL 智能补全（无协议补全 https://，搜索词重定向至 Google）；
 * 4. 消除加载死锁与异常捕获（Navigate / Action 失败时清空 loading）；
 * 5. 监听 onNativeBrowserNavigationState 事件实现响应式状态同步。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePreviewNavigation,
  resolveBrowserTabId,
} from './usePreviewNavigation';
import * as nativeApi from '../../api/nativeBrowserApi';
import { getPreviewUrl, setPreviewUrl } from '../../api/previewBrowserStore';
import { logger } from '../../services/LoggerService';
import { LOAD_TIMEOUT_MS } from './previewCardLib';

const { toastShow, toastError } = vi.hoisted(() => ({
  toastShow: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../services/toast/ToastContext', () => ({
  toast: { show: toastShow, error: toastError },
}));

describe('usePreviewNavigation 原生 Webview 驱动与解耦测试', () => {
  const leafId = 'leaf-nav-1';
  const expectedTabId = `browser-${leafId}`;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Tab ID 命名真理来源（SSOT）', () => {
    it('resolveBrowserTabId 纯函数在各边界入参下行为符合规范', () => {
      // 显式指定 tabId 优先级最高
      expect(resolveBrowserTabId('custom-tab', 'leaf-99')).toBe('custom-tab');
      expect(resolveBrowserTabId('custom-tab', null)).toBe('custom-tab');
      expect(resolveBrowserTabId('  custom-tab  ', undefined)).toBe(
        'custom-tab'
      );

      // 未传 tabId 时基于 leafId 严格生成
      expect(resolveBrowserTabId(undefined, 'leaf-42')).toBe('browser-leaf-42');
      expect(resolveBrowserTabId(null, 'leaf-42')).toBe('browser-leaf-42');
      expect(resolveBrowserTabId('', 'leaf-42')).toBe('browser-leaf-42');
      expect(resolveBrowserTabId('   ', 'leaf-42')).toBe('browser-leaf-42');

      // 两者皆无时兜底 browser-default
      expect(resolveBrowserTabId(undefined, undefined)).toBe('browser-default');
      expect(resolveBrowserTabId(null, null)).toBe('browser-default');
      expect(resolveBrowserTabId('', '')).toBe('browser-default');
    });

    it('Hook 正确响应 opts.tabId 与 opts.leafId 优先级', () => {
      // 优先使用 opts.tabId
      const { result: res1 } = renderHook(() =>
        usePreviewNavigation({
          tabId: 'explicit-tab',
          leafId: 'leaf-ignored',
        })
      );
      expect(res1.current.tabId).toBe('explicit-tab');

      // 缺省 tabId 时基于 leafId 严格拼接
      const { result: res2 } = renderHook(() =>
        usePreviewNavigation({
          leafId: 'leaf-alpha',
        })
      );
      expect(res2.current.tabId).toBe('browser-leaf-alpha');

      // 缺省时兜底
      const { result: res3 } = renderHook(() => usePreviewNavigation({}));
      expect(res3.current.tabId).toBe('browser-default');
    });

    it('缺省 initialUrl 时严格默认关于空白页 about:blank，绝不回退 localStorage 中的历史地址', () => {
      setPreviewUrl('https://previous.example', { silent: true });
      const { result } = renderHook(() => usePreviewNavigation({ leafId }));

      expect(result.current.activeUrl).toBe('about:blank');
      expect(result.current.blank).toBe(true);
      expect(result.current.urlInput).toBe('');
      expect(result.current.frameSrc).toBeNull();
      expect(result.current.showFrame).toBe(false);
    });
  });

  describe('清退 <iframe> 残留契约', () => {
    it('返回值中严禁存在 iframeRef、onFrameLoad 与 onFrameError', () => {
      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      const ret = result.current as Record<string, unknown>;
      expect(ret.iframeRef).toBeUndefined();
      expect(ret.onFrameLoad).toBeUndefined();
      expect(ret.onFrameError).toBeUndefined();
    });
  });

  describe('输入 URL 智能补全与无缝重定向', () => {
    it('空白页导航立即更新 activeUrl 以挂载 Surface，IPC 确认前不写入持久化', async () => {
      let resolveNavigation!: () => void;
      const navigation = new Promise<void>((resolve) => {
        resolveNavigation = resolve;
      });
      vi.spyOn(nativeApi, 'browserWebviewNavigate').mockReturnValue(navigation);
      const { result } = renderHook(() => usePreviewNavigation({ leafId }));

      act(() => result.current.navigate('https://first-open.example'));

      expect(result.current.activeUrl).toBe('https://first-open.example');
      expect(getPreviewUrl()).toBe('about:blank');

      await act(async () => {
        resolveNavigation();
        await navigation;
      });
      expect(getPreviewUrl()).toBe('https://first-open.example');
    });

    it('无协议合法域名自动补全为 https://', async () => {
      const navigateSpy = vi
        .spyOn(nativeApi, 'browserWebviewNavigate')
        .mockResolvedValue();

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      act(() => {
        result.current.navigate('google.com');
      });

      expect(result.current.activeUrl).toBe('https://google.com');
      expect(result.current.urlInput).toBe('https://google.com');
      expect(navigateSpy).toHaveBeenCalledWith(
        expectedTabId,
        'https://google.com'
      );

      act(() => {
        result.current.navigate('github.com/trending');
      });

      expect(result.current.activeUrl).toBe('https://github.com/trending');
      expect(navigateSpy).toHaveBeenCalledWith(
        expectedTabId,
        'https://github.com/trending'
      );
    });

    it('纯搜索词自动无缝重定向至 Google 搜索', async () => {
      const navigateSpy = vi
        .spyOn(nativeApi, 'browserWebviewNavigate')
        .mockResolvedValue();

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      // 含空格的搜索短语
      act(() => {
        result.current.navigate('hello world');
      });

      const expectedGoogleUrl1 =
        'https://www.google.com/search?q=hello%20world';
      expect(result.current.activeUrl).toBe(expectedGoogleUrl1);
      expect(navigateSpy).toHaveBeenCalledWith(
        expectedTabId,
        expectedGoogleUrl1
      );

      // 无点号的单一词汇
      act(() => {
        result.current.navigate('react');
      });

      const expectedGoogleUrl2 = 'https://www.google.com/search?q=react';
      expect(result.current.activeUrl).toBe(expectedGoogleUrl2);
      expect(navigateSpy).toHaveBeenCalledWith(
        expectedTabId,
        expectedGoogleUrl2
      );
    });

    it('本地端口简写与 IP 地址正确规范化', async () => {
      const navigateSpy = vi
        .spyOn(nativeApi, 'browserWebviewNavigate')
        .mockResolvedValue();

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      act(() => {
        result.current.navigate(':5173');
      });

      expect(result.current.activeUrl).toBe('http://localhost:5173');
      expect(navigateSpy).toHaveBeenCalledWith(
        expectedTabId,
        'http://localhost:5173'
      );

      act(() => {
        result.current.navigate('127.0.0.1:8080');
      });

      expect(result.current.activeUrl).toBe('http://127.0.0.1:8080');
      expect(navigateSpy).toHaveBeenCalledWith(
        expectedTabId,
        'http://127.0.0.1:8080'
      );
    });

    it.each(['file:///C:/project/index.html', 'C:\\project\\index.html'])(
      '不可嵌入的本地路径 %s 显示错误且不会排队原生导航',
      (localPath) => {
        const navigateSpy = vi
          .spyOn(nativeApi, 'browserWebviewNavigate')
          .mockResolvedValue();
        const { result } = renderHook(() => usePreviewNavigation({ leafId }));

        act(() => {
          result.current.navigate(localPath);
        });

        expect(result.current.activeUrl).toBe('about:blank');
        expect(navigateSpy).not.toHaveBeenCalled();
        expect(toastShow).toHaveBeenCalledWith(
          expect.stringContaining('本地文件路径无法在此处打开')
        );
      }
    );
  });

  it('A 失败不能回滚较新的 B，B 确认后才写入持久化', async () => {
    setPreviewUrl('https://previous.example', { silent: true });
    let rejectA!: (error: Error) => void;
    let resolveB!: () => void;
    const navigationA = new Promise<void>((_resolve, reject) => {
      rejectA = reject;
    });
    const navigationB = new Promise<void>((resolve) => {
      resolveB = resolve;
    });
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockImplementation(
      (_tabId, url) =>
        url === 'https://navigation-a.example' ? navigationA : navigationB
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewNavigation({ leafId, initialUrl: 'https://previous.example' })
    );

    act(() => {
      result.current.navigate('https://navigation-a.example');
      result.current.navigate('https://navigation-b.example');
    });
    expect(result.current.activeUrl).toBe('https://navigation-b.example');
    expect(getPreviewUrl()).toBe('https://previous.example');

    await act(async () => {
      rejectA(new Error('A rejected'));
      await Promise.resolve();
    });
    expect(result.current.activeUrl).toBe('https://navigation-b.example');
    expect(result.current.urlInput).toBe('https://navigation-b.example');
    expect(getPreviewUrl()).toBe('https://previous.example');
    expect(toastError).not.toHaveBeenCalled();

    await act(async () => {
      resolveB();
      await navigationB;
    });
    expect(getPreviewUrl()).toBe('https://navigation-b.example');
  });

  it('A 在 B 等待期间成功时仅更新确认态，B 失败后回滚到 A', async () => {
    setPreviewUrl('https://previous.example', { silent: true });
    let resolveA!: () => void;
    let rejectB!: (error: Error) => void;
    const navigationA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const navigationB = new Promise<void>((_resolve, reject) => {
      rejectB = reject;
    });
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockImplementation(
      (_tabId, url) =>
        url === 'https://navigation-a.example' ? navigationA : navigationB
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewNavigation({ leafId, initialUrl: 'https://previous.example' })
    );

    act(() => {
      result.current.navigate('https://navigation-a.example');
      result.current.navigate('https://navigation-b.example');
    });
    await act(async () => {
      resolveA();
      await navigationA;
    });
    expect(result.current.activeUrl).toBe('https://navigation-b.example');
    expect(getPreviewUrl()).toBe('https://previous.example');

    await act(async () => {
      rejectB(new Error('B rejected'));
      await Promise.resolve();
    });
    expect(result.current.activeUrl).toBe('https://navigation-a.example');
    expect(result.current.urlInput).toBe('https://navigation-a.example');
    expect(getPreviewUrl()).toBe('https://navigation-a.example');
  });

  it('A 晚成功、B 失败时回到最新已成功的原生页面 A', async () => {
    setPreviewUrl('https://previous.example', { silent: true });
    let resolveA!: () => void;
    let rejectB!: (error: Error) => void;
    const navigationA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const navigationB = new Promise<void>((_resolve, reject) => {
      rejectB = reject;
    });
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockImplementation(
      (_tabId, url) =>
        url === 'https://navigation-a.example' ? navigationA : navigationB
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewNavigation({ leafId, initialUrl: 'https://previous.example' })
    );

    act(() => {
      result.current.navigate('https://navigation-a.example');
      result.current.navigate('https://navigation-b.example');
    });
    await act(async () => {
      rejectB(new Error('B rejected'));
      await Promise.resolve();
    });
    expect(result.current.activeUrl).toBe('https://previous.example');

    await act(async () => {
      resolveA();
      await navigationA;
    });
    expect(result.current.activeUrl).toBe('https://navigation-a.example');
    expect(result.current.urlInput).toBe('https://navigation-a.example');
    expect(getPreviewUrl()).toBe('https://navigation-a.example');
  });

  it('失败的外部 URL 事件不写入 preview URL 持久化', async () => {
    setPreviewUrl('https://previous.example', { silent: true });
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockRejectedValue(
      new Error('external navigation failed')
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewNavigation({ leafId, initialUrl: 'https://previous.example' })
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('crish-preview-url', {
          detail: {
            url: 'https://external.example',
            leafId,
          },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.activeUrl).toBe('https://previous.example');
    expect(getPreviewUrl()).toBe('https://previous.example');
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('原生浏览器导航失败')
    );
  });

  it('外部导航成功后的 native URL 事件不写入 preview URL 持久化', async () => {
    setPreviewUrl('https://previous.example', { silent: true });
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockResolvedValue();
    let navCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (callback) => {
        navCallback = callback;
        return vi.fn();
      }
    );
    const { result } = renderHook(() =>
      usePreviewNavigation({ leafId, initialUrl: 'https://previous.example' })
    );

    await act(async () => {
      result.current.navigate('https://external.example', true);
      await Promise.resolve();
    });
    expect(result.current.activeUrl).toBe('https://external.example');
    expect(getPreviewUrl()).toBe('https://previous.example');

    act(() => {
      navCallback?.({
        tabId: expectedTabId,
        url: 'https://external.example',
        title: 'External',
        isLoading: false,
      });
    });
    expect(result.current.activeUrl).toBe('https://external.example');
    expect(getPreviewUrl()).toBe('https://previous.example');
  });

  it('back/forward 状态事件更新失败导航的回滚目标', async () => {
    setPreviewUrl('https://initial.example', { silent: true });
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockRejectedValue(
      new Error('next navigation failed')
    );
    let navCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (callback) => {
        navCallback = callback;
        return vi.fn();
      }
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewNavigation({ leafId, initialUrl: 'https://initial.example' })
    );

    act(() => {
      navCallback?.({
        tabId: expectedTabId,
        url: 'https://history-page.example',
        title: 'History page',
        isLoading: false,
      });
    });
    await act(async () => {
      result.current.navigate('https://failed-next.example');
      await Promise.resolve();
    });

    expect(result.current.activeUrl).toBe('https://history-page.example');
    expect(getPreviewUrl()).toBe('https://history-page.example');
  });

  it('加载中的标题与下载进度更新不会重置超时计时', async () => {
    vi.useFakeTimers();
    let navigationStateCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    let downloadProgressCallback:
      ((payload: nativeApi.DownloadProgressPayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (callback) => {
        navigationStateCallback = callback;
        return vi.fn();
      }
    );
    vi.spyOn(nativeApi, 'onNativeBrowserDownloadProgress').mockImplementation(
      (callback) => {
        downloadProgressCallback = callback;
        return vi.fn();
      }
    );
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockResolvedValue();
    const actionSpy = vi
      .spyOn(nativeApi, 'browserWebviewAction')
      .mockResolvedValue();
    const { result } = renderHook(() => usePreviewNavigation({ leafId }));

    await act(async () => {
      result.current.navigate('https://slow.example');
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    });
    expect(actionSpy).not.toHaveBeenCalled();

    act(() => {
      navigationStateCallback?.({
        tabId: expectedTabId,
        url: 'https://slow.example',
        title: 'Still loading',
        isLoading: true,
      });
      downloadProgressCallback?.({
        tabId: expectedTabId,
        url: 'https://slow.example/file.zip',
        filename: 'file.zip',
        receivedBytes: 1024,
        totalBytes: 4096,
        state: 'progress',
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'stop');
  });

  it('A 加载中启动 B 以及页面外链跳转都会获得新的超时窗口', async () => {
    vi.useFakeTimers();
    let navigationStateCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (callback) => {
        navigationStateCallback = callback;
        return vi.fn();
      }
    );
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockResolvedValue();
    const actionSpy = vi
      .spyOn(nativeApi, 'browserWebviewAction')
      .mockResolvedValue();
    const { result } = renderHook(() => usePreviewNavigation({ leafId }));

    await act(async () => {
      result.current.navigate('https://slow-a.example');
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    });
    expect(actionSpy).not.toHaveBeenCalledWith(expectedTabId, 'stop');

    await act(async () => {
      result.current.navigate('https://slow-b.example');
      await Promise.resolve();
    });
    act(() => {
      navigationStateCallback?.({
        tabId: expectedTabId,
        url: 'https://slow-b.example',
        title: 'B',
        isLoading: true,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    });
    expect(actionSpy).not.toHaveBeenCalledWith(expectedTabId, 'stop');

    act(() => {
      navigationStateCallback?.({
        tabId: expectedTabId,
        url: 'https://external-c.example',
        title: 'External C',
        isLoading: true,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    });
    expect(actionSpy).not.toHaveBeenCalledWith(expectedTabId, 'stop');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'stop');
  });

  it('后退、前进和刷新在既有加载期间各自重新计时', async () => {
    vi.useFakeTimers();
    let navigationStateCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (callback) => {
        navigationStateCallback = callback;
        return vi.fn();
      }
    );
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockResolvedValue();
    const actionSpy = vi
      .spyOn(nativeApi, 'browserWebviewAction')
      .mockResolvedValue();
    const { result } = renderHook(() => usePreviewNavigation({ leafId }));

    await act(async () => {
      result.current.navigate('https://history.example');
      await Promise.resolve();
    });
    act(() => {
      navigationStateCallback?.({
        tabId: expectedTabId,
        url: 'https://history.example',
        title: 'History',
        canGoBack: true,
        canGoForward: true,
        isLoading: true,
      });
    });

    for (const action of [
      () => result.current.reload(),
      () => result.current.goBack(),
      () => result.current.goForward(),
    ]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
      });
      await act(async () => {
        action();
        await Promise.resolve();
      });
      expect(actionSpy).not.toHaveBeenCalledWith(expectedTabId, 'stop');
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    });
    expect(actionSpy).not.toHaveBeenCalledWith(expectedTabId, 'stop');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'reload');
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'back');
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'forward');
    expect(actionSpy).toHaveBeenCalledTimes(4);
    expect(actionSpy).toHaveBeenLastCalledWith(expectedTabId, 'stop');
  });

  describe('动作下发与加载死锁消除', () => {
    it('B 导航失败后恢复已确认的 A 页面并清除 destination error', async () => {
      setPreviewUrl('https://previous.example', { silent: true });
      vi.spyOn(nativeApi, 'browserWebviewNavigate').mockRejectedValue(
        new Error('Failed to reach server')
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      let navCallback:
        ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
      vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
        (callback) => {
          navCallback = callback;
          return vi.fn();
        }
      );
      const scopedUrls: string[] = [];
      const captureScopedUrl = (event: Event) => {
        scopedUrls.push((event as CustomEvent<{ url: string }>).detail.url);
      };
      window.addEventListener('crish-preview-url-change', captureScopedUrl);

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
          initialUrl: 'https://previous.example',
        })
      );

      await act(async () => {
        result.current.navigate('https://broken.invalid');
        navCallback?.({
          tabId: expectedTabId,
          url: 'https://broken.invalid',
          title: 'Broken',
          isLoading: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // 命令失败时保留上一个已成功 URL，并把失败原因告知用户。
      expect(result.current.loading).toBe(false);
      expect(result.current.loadError).toBe(false);
      expect(result.current.showFrame).toBe(true);
      expect(result.current.frameSrc).toBe('https://previous.example');
      expect(result.current.activeUrl).toBe('https://previous.example');
      expect(result.current.urlInput).toBe('https://previous.example');
      expect(getPreviewUrl()).toBe('https://previous.example');
      expect(scopedUrls.at(-1)).toBe('https://previous.example');
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('原生浏览器导航失败')
      );
      window.removeEventListener('crish-preview-url-change', captureScopedUrl);
    });

    it('browserWebviewAction 失败时捕获异常并清空 loading', async () => {
      const actionSpy = vi
        .spyOn(nativeApi, 'browserWebviewAction')
        .mockRejectedValue(new Error('Webview crashed'));

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      // 初始导航一次建立 activeUrl
      vi.spyOn(nativeApi, 'browserWebviewNavigate').mockResolvedValue();
      await act(async () => {
        result.current.navigate('https://google.com');
      });

      // 执行 reload
      await act(async () => {
        result.current.reload();
      });

      expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'reload');
      expect(result.current.loading).toBe(false);
      expect(result.current.loadError).toBe(true);

      // 执行 stop
      await act(async () => {
        result.current.stop();
      });

      expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'stop');
      expect(result.current.loading).toBe(false);
    });

    it('常规动作正常下发 browserWebviewAction', async () => {
      const actionSpy = vi
        .spyOn(nativeApi, 'browserWebviewAction')
        .mockResolvedValue();
      const navigateSpy = vi
        .spyOn(nativeApi, 'browserWebviewNavigate')
        .mockResolvedValue();

      let navCallback:
        ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
      vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
        (cb) => {
          navCallback = cb;
          return vi.fn();
        }
      );

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      // 模拟 Webview 广播状态支持后退与前进
      act(() => {
        navCallback?.({
          tabId: expectedTabId,
          url: 'https://site-b.com',
          title: 'Site B',
          canGoBack: true,
          canGoForward: true,
          isLoading: false,
        });
      });

      expect(result.current.canBack).toBe(true);
      expect(result.current.canForward).toBe(true);

      act(() => {
        result.current.goBack();
      });
      expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'back');
      expect(actionSpy).toHaveBeenCalledTimes(1);
      expect(navigateSpy).not.toHaveBeenCalled();

      act(() => {
        result.current.goForward();
      });
      expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'forward');
      expect(actionSpy).toHaveBeenCalledTimes(2);
      expect(navigateSpy).not.toHaveBeenCalled();

      act(() => {
        result.current.reload();
      });
      expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'reload');

      act(() => {
        result.current.stop();
      });
      expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'stop');
    });
  });

  describe('响应 onNativeBrowserNavigationState 事件（SSOT）', () => {
    it('接收 Rust 广播事件更新响应式状态', () => {
      let navCallback:
        ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
      vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
        (cb) => {
          navCallback = cb;
          return vi.fn();
        }
      );

      const { result } = renderHook(() =>
        usePreviewNavigation({
          leafId,
        })
      );

      act(() => {
        navCallback?.({
          tabId: expectedTabId,
          url: 'https://github.com/trending',
          title: 'Trending repositories on GitHub',
          canGoBack: true,
          canGoForward: true,
          isLoading: false,
          faviconUrl: 'https://github.com/favicon.ico',
          httpStatus: 200,
        });
      });

      expect(result.current.activeUrl).toBe('https://github.com/trending');
      expect(result.current.urlInput).toBe('https://github.com/trending');
      expect(result.current.canBack).toBe(true);
      expect(result.current.canForward).toBe(true);
      expect(result.current.loading).toBe(false);
      expect(result.current.loadError).toBe(false);

      // 没有能力字段的过渡事件不得把上次原生确认的历史状态变成 undefined/false。
      act(() => {
        navCallback?.({
          tabId: expectedTabId,
          url: 'https://github.com/next',
          title: 'Next page',
          isLoading: true,
        } as nativeApi.NavigationStatePayload);
      });
      expect(result.current.canBack).toBe(true);
      expect(result.current.canForward).toBe(true);
    });
  });
});
