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

  describe('Tab ID 解析与初始化（SSOT）', () => {
    it('支持 options.leafId 严格生成 browser-${leafId}，显式 tabId 优先', () => {
      // 显式 tabId 优先
      const { result: r1 } = renderHook(() =>
        useNativeBrowserInstance({
          tabId: 'custom-tab',
          leafId: 'leaf-1',
        })
      );
      expect(r1.current.tabId).toBe('custom-tab');

      // 缺省 tabId 时基于 leafId 生成
      const { result: r2 } = renderHook(() =>
        useNativeBrowserInstance({
          leafId: 'leaf-abc',
        })
      );
      expect(r2.current.tabId).toBe('browser-leaf-abc');

      // 缺省时兜底 browser-default
      const { result: r3 } = renderHook(() => useNativeBrowserInstance({}));
      expect(r3.current.tabId).toBe('browser-default');
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
  });

  describe('事件驱动与响应式状态（SSOT）', () => {
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

    it('导航事件缺少历史能力字段时保留上次确认的状态', () => {
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
          url: 'https://site-a.example',
          title: 'Site A',
          canGoBack: true,
          canGoForward: false,
          isLoading: false,
        });
      });

      act(() => {
        navCallback?.({
          tabId,
          url: 'https://site-b.example',
          title: 'Site B',
          isLoading: true,
        } as nativeApi.NavigationStatePayload);
      });

      expect(result.current.url).toBe('https://site-b.example');
      expect(result.current.canGoBack).toBe(true);
      expect(result.current.canGoForward).toBe(false);
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
  });

  it('挂载时获取生命周期 lease，卸载时释放', () => {
    const releaseLease = vi.fn();
    const acquireSpy = vi
      .spyOn(nativeApi, 'browserWebviewAcquire')
      .mockReturnValue(releaseLease);

    const { unmount } = renderHook(() => useNativeBrowserInstance(tabId));

    expect(acquireSpy).toHaveBeenCalledWith(tabId);
    expect(releaseLease).not.toHaveBeenCalled();
    unmount();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  describe('动作下发与智能 URL 补全', () => {
    it('navigate 动作智能补全无协议域名或重定向纯搜索词', async () => {
      const navigateSpy = vi
        .spyOn(nativeApi, 'browserWebviewNavigate')
        .mockResolvedValue();

      const { result } = renderHook(() => useNativeBrowserInstance(tabId));

      await act(async () => {
        await result.current.navigate('github.com');
      });
      expect(navigateSpy).toHaveBeenCalledWith(tabId, 'https://github.com');

      await act(async () => {
        await result.current.navigate('react native docs');
      });
      expect(navigateSpy).toHaveBeenCalledWith(
        tabId,
        'https://www.google.com/search?q=react%20native%20docs'
      );
    });

    it('动作执行失败时设置 error 状态并清空 isLoading，消除死锁', async () => {
      vi.spyOn(nativeApi, 'browserWebviewNavigate').mockRejectedValue(
        new Error('Navigation failed: connection refused')
      );

      const { result } = renderHook(() => useNativeBrowserInstance(tabId));

      await act(async () => {
        await expect(
          result.current.navigate('https://unreachable.invalid')
        ).rejects.toThrow('Navigation failed');
      });

      expect(result.current.error).toBe(
        'Navigation failed: connection refused'
      );
      expect(result.current.isLoading).toBe(false);
    });

    it('reload / goBack / goForward 异常时安全捕获并清空 isLoading', async () => {
      vi.spyOn(nativeApi, 'browserWebviewAction').mockRejectedValue(
        new Error('Action rejected')
      );

      const { result } = renderHook(() => useNativeBrowserInstance(tabId));

      await act(async () => {
        await expect(result.current.reload()).rejects.toThrow(
          'Action rejected'
        );
      });
      expect(result.current.isLoading).toBe(false);

      await act(async () => {
        await expect(result.current.goBack()).rejects.toThrow(
          'Action rejected'
        );
      });
      expect(result.current.isLoading).toBe(false);

      await act(async () => {
        await expect(result.current.goForward()).rejects.toThrow(
          'Action rejected'
        );
      });
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
});
