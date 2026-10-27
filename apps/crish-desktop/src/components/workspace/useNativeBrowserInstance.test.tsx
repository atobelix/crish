// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.test.tsx
 *
 * useNativeBrowserInstance Hook 单元测试。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNativeBrowserInstance } from './useNativeBrowserInstance';
import * as nativeApi from '../../api/nativeBrowserApi';

describe('useNativeBrowserInstance', () => {
  const tabId = 'test-tab-42';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('初始状态正确装配', () => {
    const { result } = renderHook(() =>
      useNativeBrowserInstance({
        tabId,
        initialUrl: 'https://example.com',
      })
    );

    expect(result.current.tabId).toBe(tabId);
    expect(result.current.url).toBe('https://example.com');
    expect(result.current.title).toBe('');
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isMuted).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('接收 navigation-state 事件时更新响应式状态', () => {
    let navCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (cb) => {
        navCallback = cb;
        return vi.fn();
      }
    );

    const { result } = renderHook(() => useNativeBrowserInstance(tabId));

    act(() => {
      navCallback?.({
        tabId,
        url: 'https://github.com',
        title: 'GitHub',
        canGoBack: true,
        canGoForward: false,
        isLoading: false,
        faviconUrl: 'https://github.com/favicon.ico',
        httpStatus: 200,
        isMuted: true,
      });
    });

    expect(result.current.url).toBe('https://github.com');
    expect(result.current.title).toBe('GitHub');
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
    expect(result.current.faviconUrl).toBe('https://github.com/favicon.ico');
    expect(result.current.httpStatus).toBe(200);
    expect(result.current.isMuted).toBe(true);
  });

  it('忽略非当前 tabId 的事件', () => {
    let navCallback:
      ((payload: nativeApi.NavigationStatePayload) => void) | null = null;
    vi.spyOn(nativeApi, 'onNativeBrowserNavigationState').mockImplementation(
      (cb) => {
        navCallback = cb;
        return vi.fn();
      }
    );

    const { result } = renderHook(() => useNativeBrowserInstance(tabId));

    act(() => {
      navCallback?.({
        tabId: 'another-tab',
        url: 'https://another.com',
        title: 'Another',
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
    });

    expect(result.current.url).toBe('');
    expect(result.current.title).toBe('');
  });

  it('navigate 动作正常下发并处理 loading', async () => {
    const navigateSpy = vi
      .spyOn(nativeApi, 'browserWebviewNavigate')
      .mockResolvedValue();

    const { result } = renderHook(() => useNativeBrowserInstance(tabId));

    await act(async () => {
      await result.current.navigate('https://google.com');
    });

    expect(navigateSpy).toHaveBeenCalledWith(tabId, 'https://google.com');
    expect(result.current.error).toBeNull();
  });

  it('动作执行失败时设置 error 状态', async () => {
    vi.spyOn(nativeApi, 'browserWebviewNavigate').mockRejectedValue(
      new Error('Navigation failed: connection refused')
    );

    const { result } = renderHook(() => useNativeBrowserInstance(tabId));

    await act(async () => {
      await expect(
        result.current.navigate('https://unreachable.invalid')
      ).rejects.toThrow('Navigation failed');
    });

    expect(result.current.error).toBe('Navigation failed: connection refused');
    expect(result.current.isLoading).toBe(false);
  });

  it('autoCloseOnUnmount 为 true 时组件卸载触发 close', () => {
    const closeSpy = vi
      .spyOn(nativeApi, 'browserWebviewClose')
      .mockResolvedValue();

    const { unmount } = renderHook(() =>
      useNativeBrowserInstance({
        tabId,
        autoCloseOnUnmount: true,
      })
    );

    unmount();
    expect(closeSpy).toHaveBeenCalledWith(tabId);
  });
});
