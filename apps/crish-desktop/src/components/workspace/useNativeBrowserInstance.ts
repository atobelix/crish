/**
 * apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts
 *
 * 为特定 tabId 维护原生 Webview 实例的导航状态与动作控制 Hook。
 *
 * 核心保证：
 * 1. 响应式同步 URL、Title、Favicon、Loading、前进/后退、HttpStatus 与 Muted 状态；
 * 2. 挂载时安全注册事件订阅，卸载或切换 tabId 时平滑注销；
 * 3. 错误安全边界：动作执行失败时更新本地 error 状态并抛出，供上层 UI 捕获；
 * 4. 动作函数引用稳定（useCallback 封装），避免引起外部无关重新渲染。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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

export interface UseNativeBrowserInstanceOptions {
  tabId: string;
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
  tabIdOrOptions: string | UseNativeBrowserInstanceOptions
): UseNativeBrowserInstanceReturn {
  const options =
    typeof tabIdOrOptions === 'string'
      ? { tabId: tabIdOrOptions }
      : tabIdOrOptions;

  const { tabId, initialUrl, autoCloseOnUnmount = false } = options;

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

  // 订阅导航状态与下载进度事件
  useEffect(() => {
    if (!tabId) return;

    const unsubNav = onNativeBrowserNavigationState((payload) => {
      if (payload.tabId !== tabId) return;
      setUrl(payload.url);
      setTitle(payload.title);
      setCanGoBack(payload.canGoBack);
      setCanGoForward(payload.canGoForward);
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
    };
  }, [tabId, autoCloseOnUnmount]);

  // 动作封装
  const navigate = useCallback(
    async (targetUrl: string) => {
      if (!tabId) return;
      try {
        setIsLoading(true);
        setError(null);
        await browserWebviewNavigate(tabId, targetUrl);
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
      setError(null);
      await browserWebviewAction(tabId, 'back');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [tabId]);

  const goForward = useCallback(async () => {
    if (!tabId) return;
    try {
      setError(null);
      await browserWebviewAction(tabId, 'forward');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [tabId]);

  const reload = useCallback(
    async (ignoreCache = false) => {
      if (!tabId) return;
      try {
        setError(null);
        await browserWebviewAction(
          tabId,
          ignoreCache ? 'reload_ignoring_cache' : 'reload'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    [tabId]
  );

  const stop = useCallback(async () => {
    if (!tabId) return;
    try {
      setError(null);
      await browserWebviewAction(tabId, 'stop');
    } catch (err) {
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
