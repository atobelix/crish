/**
 * apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts
 *
 * 为特定 tabId 维护原生 Webview 实例的导航状态与动作控制 Hook。
 *
 * 核心保证：
 * 1. 响应式同步 URL、Title、Favicon、Loading、前进/后退、HttpStatus 与 Muted 状态（SSOT 来源：Rust 广播）；
 * 2. 统一 Tab ID 命名真理来源（SSOT）：通过 resolveBrowserTabId 严格收敛（opts.tabId 优先，无则基于 leafId 生成 `browser-${leafId}`，兜底 `browser-default`）；
 * 3. 智能 URL 补全：无协议域名自动补全为 https://...，纯搜索词自动重定向至 Google 搜索；
 * 4. 彻底消除加载死锁与错误处理：动作执行失败时清空 isLoading 并记录/抛出结构化 error；
 * 5. 挂载时安全注册事件订阅，卸载或切换 tabId 时平滑注销；动作函数引用稳定（useCallback）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browserWebviewAcquire,
  browserWebviewAction,
  browserWebviewClose,
  browserWebviewNavigate,
  browserWebviewSetBounds,
  browserWebviewSetMuted,
  browserWebviewSetVisible,
  onNativeBrowserDownloadProgress,
  onNativeBrowserNavigationState,
  type DownloadProgressPayload,
  type WebviewBounds,
} from '../../api/nativeBrowserApi';
import { smartResolveBrowseUrl } from '../../api/previewBrowserStore';
import { resolveBrowserTabId } from './nativeBrowserTabId';

export interface UseNativeBrowserInstanceOptions {
  tabId?: string | null;
  leafId?: string | null;
  initialUrl?: string;
  autoCloseOnUnmount?: boolean;
}

export interface UseNativeBrowserInstanceReturn {
  tabId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isMuted: boolean;
  faviconUrl: string | null;
  httpStatus: number | null;
  downloadProgress: DownloadProgressPayload | null;
  error: string | null;
  clearError: () => void;
  navigate: (url: string) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: (ignoreCache?: boolean) => Promise<void>;
  stop: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  setBounds: (bounds: WebviewBounds) => Promise<void>;
  close: () => Promise<void>;
}

export function useNativeBrowserInstance(
  tabIdOrOptions?: string | UseNativeBrowserInstanceOptions | null
): UseNativeBrowserInstanceReturn {
  const options: UseNativeBrowserInstanceOptions = useMemo(() => {
    if (typeof tabIdOrOptions === 'string') {
      return { tabId: tabIdOrOptions };
    }
    return tabIdOrOptions ?? {};
  }, [tabIdOrOptions]);

  const tabId = useMemo(
    () => resolveBrowserTabId(options.tabId, options.leafId),
    [options.tabId, options.leafId]
  );

  const { initialUrl, autoCloseOnUnmount = false } = options;

  const [url, setUrl] = useState<string>(initialUrl ?? '');
  const [title, setTitle] = useState<string>('');
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [canGoForward, setCanGoForward] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  // 当 tabId 变化时重置本地状态
  const prevTabIdRef = useRef(tabId);
  useEffect(() => {
    if (prevTabIdRef.current !== tabId) {
      prevTabIdRef.current = tabId;
      setUrl(initialUrl ?? '');
      setTitle('');
      setCanGoBack(false);
      setCanGoForward(false);
      setIsLoading(false);
      setIsMuted(false);
      setFaviconUrl(null);
      setHttpStatus(null);
      setDownloadProgress(null);
      setError(null);
    }
  }, [tabId, initialUrl]);

  // 订阅导航状态与下载进度事件（SSOT 真理来源）
  useEffect(() => {
    if (!tabId) return;

    const releaseLease = browserWebviewAcquire(tabId);

    const unsubNav = onNativeBrowserNavigationState((payload) => {
      if (payload.tabId !== tabId) return;
      setUrl(payload.url);
      setTitle(payload.title);
      if (typeof payload.canGoBack === 'boolean') {
        setCanGoBack(payload.canGoBack);
      }
      if (typeof payload.canGoForward === 'boolean') {
        setCanGoForward(payload.canGoForward);
      }
      setIsLoading(payload.isLoading);
      if (payload.faviconUrl !== undefined) {
        setFaviconUrl(payload.faviconUrl ?? null);
      }
      if (payload.httpStatus !== undefined) {
        setHttpStatus(payload.httpStatus ?? null);
      }
      if (payload.isMuted !== undefined) {
        setIsMuted(payload.isMuted);
      }
      setError(null);
    });

    const unsubDl = onNativeBrowserDownloadProgress((payload) => {
      if (payload.tabId !== tabId) return;
      setDownloadProgress(payload);
    });

    return () => {
      unsubNav();
      unsubDl();
      if (autoCloseOnUnmount) {
        browserWebviewClose(tabId).catch((err) => {
          console.warn(
            `[useNativeBrowserInstance] 卸载关闭 Webview [${tabId}] 异常:`,
            err
          );
        });
      }
      releaseLease();
    };
  }, [tabId, autoCloseOnUnmount]);

  // 动作封装：全部执行安全捕获并消除 loading 死锁
  const navigate = useCallback(
    async (targetUrl: string) => {
      if (!tabId) return;
      const resolved = smartResolveBrowseUrl(targetUrl);
      try {
        setIsLoading(true);
        setError(null);
        await browserWebviewNavigate(tabId, resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setIsLoading(false);
        throw err;
      }
    },
    [tabId]
  );

  const goBack = useCallback(async () => {
    if (!tabId) return;
    try {
      setIsLoading(true);
      setError(null);
      await browserWebviewAction(tabId, 'back');
    } catch (err) {
      setIsLoading(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [tabId]);

  const goForward = useCallback(async () => {
    if (!tabId) return;
    try {
      setIsLoading(true);
      setError(null);
      await browserWebviewAction(tabId, 'forward');
    } catch (err) {
      setIsLoading(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [tabId]);

  const reload = useCallback(
    async (ignoreCache = false) => {
      if (!tabId) return;
      try {
        setIsLoading(true);
        setError(null);
        await browserWebviewAction(
          tabId,
          ignoreCache ? 'reload_ignoring_cache' : 'reload'
        );
      } catch (err) {
        setIsLoading(false);
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    [tabId]
  );

  const stop = useCallback(async () => {
    if (!tabId) return;
    setIsLoading(false);
    try {
      setError(null);
      await browserWebviewAction(tabId, 'stop');
    } catch (err) {
      setIsLoading(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [tabId]);

  const setMuted = useCallback(
    async (muted: boolean) => {
      if (!tabId) return;
      try {
        setError(null);
        await browserWebviewSetMuted(tabId, muted);
        setIsMuted(muted);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    [tabId]
  );

  const setVisible = useCallback(
    async (visible: boolean) => {
      if (!tabId) return;
      try {
        setError(null);
        await browserWebviewSetVisible(tabId, visible);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    [tabId]
  );

  const setBounds = useCallback(
    async (bounds: WebviewBounds) => {
      if (!tabId) return;
      try {
        setError(null);
        await browserWebviewSetBounds(tabId, bounds);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    [tabId]
  );

  const close = useCallback(async () => {
    if (!tabId) return;
    try {
      setError(null);
      await browserWebviewClose(tabId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [tabId]);

  return useMemo(
    () => ({
      tabId,
      url,
      title,
      canGoBack,
      canGoForward,
      isLoading,
      isMuted,
      faviconUrl,
      httpStatus,
      downloadProgress,
      error,
      clearError,
      navigate,
      goBack,
      goForward,
      reload,
      stop,
      setMuted,
      setVisible,
      setBounds,
      close,
    }),
    [
      tabId,
      url,
      title,
      canGoBack,
      canGoForward,
      isLoading,
      isMuted,
      faviconUrl,
      httpStatus,
      downloadProgress,
      error,
      clearError,
      navigate,
      goBack,
      goForward,
      reload,
      stop,
      setMuted,
      setVisible,
      setBounds,
      close,
    ]
  );
}
