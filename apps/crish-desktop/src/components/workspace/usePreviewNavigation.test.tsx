// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/workspace/usePreviewNavigation.test.tsx
 *
 * usePreviewNavigation 原生化改造单元测试。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewNavigation } from './usePreviewNavigation';
import * as nativeApi from '../../api/nativeBrowserApi';

describe('usePreviewNavigation 原生 Webview 驱动升级测试', () => {
  const leafId = 'leaf-nav-1';
  const expectedTabId = `browser-${leafId}`;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('初始状态装配并计算 effectiveTabId', () => {
    const { result } = renderHook(() =>
      usePreviewNavigation({
        leafId,
      })
    );

    expect(result.current.tabId).toBe(expectedTabId);
    expect(result.current.blank).toBe(true);
    expect(result.current.frameSrc).toBeNull();
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);
  });

  it('navigate 校验通过后驱动 browserWebviewNavigate', async () => {
    const navigateSpy = vi
      .spyOn(nativeApi, 'browserWebviewNavigate')
      .mockResolvedValue();

    const { result } = renderHook(() =>
      usePreviewNavigation({
        leafId,
      })
    );

    act(() => {
      result.current.navigate('https://google.com');
    });

    expect(result.current.activeUrl).toBe('https://google.com');
    expect(result.current.urlInput).toBe('https://google.com');
    // frameSrc 100% 保持公网原始 URL，无 /__crish_preview_proxy 前缀
    expect(result.current.frameSrc).toBe('https://google.com');
    expect(navigateSpy).toHaveBeenCalledWith(
      expectedTabId,
      'https://google.com'
    );
  });

  it('goBack, goForward, reload, stop 直接驱动 browserWebviewAction', async () => {
    const actionSpy = vi
      .spyOn(nativeApi, 'browserWebviewAction')
      .mockResolvedValue();

    const { result } = renderHook(() =>
      usePreviewNavigation({
        leafId,
      })
    );

    // 连续导航推入栈以便测试前进后退
    act(() => {
      result.current.navigate('https://site-a.com');
    });
    act(() => {
      result.current.navigate('https://site-b.com');
    });

    expect(result.current.canBack).toBe(true);

    // 后退
    act(() => {
      result.current.goBack();
    });
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'back');

    // 前进
    act(() => {
      result.current.goForward();
    });
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'forward');

    // 刷新
    act(() => {
      result.current.reload();
    });
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'reload');

    // 停止
    act(() => {
      result.current.stop();
    });
    expect(actionSpy).toHaveBeenCalledWith(expectedTabId, 'stop');
  });

  it('响应 onNativeBrowserNavigationState 事件更新状态', () => {
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
  });
});
