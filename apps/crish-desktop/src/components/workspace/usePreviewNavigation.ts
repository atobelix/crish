/**
 * apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts
 *
 * 预览浏览器导航 Hook：组合 useNativeBrowserInstance 实现原生 Webview 驱动，
 * 收拢历史/书签状态、地址栏智能补全与工具栏联动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { logger } from '../../services/LoggerService';
import {
  canOpenExternally,
  clearPreviewBookmarks,
  clearPreviewHistory,
  getPreviewBookmarks,
  getPreviewHistory,
  getPreviewHomepage,
  isAboutBlank,
  isEmbeddablePreviewUrl,
  isPreviewBookmarked,
  previewDisplayHost,
  removePreviewBookmark,
  removePreviewHistory,
  togglePreviewBookmark,
} from '../../api/previewBrowserStore';
import { useNativeBrowserInstance } from './useNativeBrowserInstance';
import { usePreviewNavigationTransaction } from './usePreviewNavigationTransaction';
import { LOAD_TIMEOUT_MS } from './previewCardLib';
import { resolveBrowserTabId } from './nativeBrowserTabId';
import {
  shouldConsumeScopedEvent,
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';

export { resolveBrowserTabId } from './nativeBrowserTabId';

export type UsePreviewNavigationOptions = {
  tabId?: string | null;
  leafId?: string | null;
  sessionId?: string | null;
  /** 初始 URL（参数直通，优先于全局历史） */
  initialUrl?: string | null;
};

export type UsePreviewNavigationResult = {
  tabId: string;
  urlInput: string;
  setUrlInput: (v: string) => void;
  activeUrl: string;
  loadError: boolean;
  loading: boolean;
  bookmarked: boolean;
  showHist: boolean;
  setShowHist: (v: boolean) => void;
  history: string[];
  bookmarks: { url: string; title?: string }[];
  rootRef: React.RefObject<HTMLDivElement | null>;
  histRef: React.RefObject<HTMLDivElement | null>;
  blank: boolean;
  canEmbed: boolean;
  frameSrc: string | null;
  showFrame: boolean;
  canBack: boolean;
  canForward: boolean;
  canExternal: boolean;
  canBookmark: boolean;
  navigate: (raw: string, fromExternal?: boolean) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  goHome: () => void;
  openExternal: () => void;
  onBookmark: () => void;
  pickHistory: (u: string) => void;
  removeBookmarkAt: (url: string) => void;
  clearHistoryAll: () => void;
  clearBookmarksAll: () => void;
  removeHistoryAt: (url: string) => void;
};

export function usePreviewNavigation(
  opts: UsePreviewNavigationOptions = {}
): UsePreviewNavigationResult {
  const leafScope = useLeafScope();
  const scopedSessionId = useScopedSessionId(opts.sessionId);
  const effectiveLeafId = opts.leafId ?? leafScope.leafId;
  const effectiveTabId = useMemo(
    () => resolveBrowserTabId(opts.tabId, effectiveLeafId),
    [opts.tabId, effectiveLeafId]
  );

  const initialUrl = useMemo(
    () => opts.initialUrl?.trim() || 'about:blank',
    [opts.initialUrl]
  );

  // 接入原生实例 Hook 作为底层驱动（单一真相源 SSOT）
  const native = useNativeBrowserInstance({
    tabId: effectiveTabId,
    initialUrl,
    autoCloseOnUnmount: false,
  });
  const nativeActionsRef = useRef(native);
  nativeActionsRef.current = native;
  const [loadingAttemptEpoch, setLoadingAttemptEpoch] = useState(0);
  const lastTargetUrlRef = useRef<string | null>(initialUrl);
  const markLoadingAttempt = useCallback(() => {
    setLoadingAttemptEpoch((current) => current + 1);
  }, []);
  const navigateNative = useCallback(
    (url: string) => {
      lastTargetUrlRef.current = url;
      markLoadingAttempt();
      return nativeActionsRef.current.navigate(url);
    },
    [markLoadingAttempt]
  );

  const scopeTargetRef = useRef({
    leafId: effectiveLeafId,
    sessionId: scopedSessionId,
    isActive: leafScope.inLeafScope ? leafScope.isActive : undefined,
  });
  scopeTargetRef.current = {
    leafId: effectiveLeafId,
    sessionId: scopedSessionId,
    isActive: leafScope.inLeafScope ? leafScope.isActive : undefined,
  };

  const emitScopedUrlChange = useCallback((url: string) => {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(
        new CustomEvent('crish-preview-url-change', {
          detail: {
            url,
            leafId: scopeTargetRef.current.leafId ?? undefined,
            sessionId: scopeTargetRef.current.sessionId || undefined,
          },
        })
      );
    } catch {
      /* ignore */
    }
  }, []);

  const [urlInput, setUrlInput] = useState(() =>
    isAboutBlank(initialUrl) ? '' : initialUrl
  );
  const [activeUrl, setActiveUrl] = useState(initialUrl);
  const [showHist, setShowHist] = useState(false);
  const [, setHistTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef((m: string) => toast.show(m));
  toastRef.current = (m: string) => toast.show(m);

  const history = useMemo(() => getPreviewHistory(), []);
  const bookmarks = useMemo(() => getPreviewBookmarks(), []);

  const navigate = usePreviewNavigationTransaction({
    tabId: effectiveTabId,
    initialUrl,
    nativeUrl: native.url,
    nativeNavigate: navigateNative,
    clearNativeError: native.clearError,
    setActiveUrl,
    setUrlInput,
    emitScopedUrlChange,
  });

  const blank = isAboutBlank(activeUrl);
  const canEmbed = isEmbeddablePreviewUrl(activeUrl);
  const frameSrc = useMemo(
    () => (isAboutBlank(activeUrl) ? null : activeUrl),
    [activeUrl]
  );
  const loadError = Boolean(native.error);
  const showFrame = Boolean(frameSrc) && !loadError;
  const canBack = native.canGoBack;
  const canForward = native.canGoForward;
  const canExternal = canOpenExternally(activeUrl);
  const canBookmark = !blank && Boolean(activeUrl);
  const bookmarked = isPreviewBookmarked(activeUrl);

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // 外部全局事件监听
  useEffect(() => {
    const onExt = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          url?: unknown;
          leafId?: string;
          sessionId?: string;
        }>
      ).detail;
      if (!shouldConsumeScopedEvent(detail, scopeTargetRef.current)) {
        return;
      }
      const url = detail?.url;
      if (typeof url !== 'string' || !url) return;
      navigateRef.current(url, true);
    };
    const onBooks = () => setHistTick((n) => n + 1);
    const onHist = () => setHistTick((n) => n + 1);
    window.addEventListener('crish-preview-url', onExt);
    window.addEventListener('crish-preview-bookmarks', onBooks);
    window.addEventListener('crish-preview-history', onHist);
    return () => {
      window.removeEventListener('crish-preview-url', onExt);
      window.removeEventListener('crish-preview-bookmarks', onBooks);
      window.removeEventListener('crish-preview-history', onHist);
    };
  }, []);

  // 加载超时兜底
  const isNativeLoading = native.isLoading;
  const stopNativeLoading = native.stop;
  const currentTargetUrl = activeUrl || native.url;

  useEffect(() => {
    if (!isNativeLoading) {
      lastTargetUrlRef.current = currentTargetUrl;
      return;
    }
    // 加载过程中如果底层页面跳转至新的不同目标地址，递增 epoch 以重置超时计时
    if (
      native.url &&
      !isAboutBlank(native.url) &&
      lastTargetUrlRef.current &&
      !isAboutBlank(lastTargetUrlRef.current) &&
      native.url !== lastTargetUrlRef.current &&
      `${native.url}/` !== lastTargetUrlRef.current &&
      native.url !== `${lastTargetUrlRef.current}/`
    ) {
      lastTargetUrlRef.current = native.url;
      markLoadingAttempt();
    }
  }, [isNativeLoading, markLoadingAttempt, native.url, currentTargetUrl]);

  useEffect(() => {
    if (!isNativeLoading) return;
    const t = window.setTimeout(() => {
      stopNativeLoading().catch((error) => {
        logger.warn(
          'Preview navigation timeout could not stop native loading',
          {
            err: {
              message: error instanceof Error ? error.message : String(error),
            },
          }
        );
      });
    }, LOAD_TIMEOUT_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [isNativeLoading, loadingAttemptEpoch, stopNativeLoading]);

  // Esc 关历史浮层；点击外部关闭
  useEffect(() => {
    if (!showHist) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowHist(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (histRef.current?.contains(t)) return;
      if (
        rootRef.current
          ?.querySelector('.preview-nav-btn[data-hist-toggle]')
          ?.contains(t)
      ) {
        return;
      }
      setShowHist(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [showHist]);

  // 原生 history 驱动动作（消除双发竞态）
  const goBack = useCallback(() => {
    if (!canBack) return;
    markLoadingAttempt();
    nativeActionsRef.current.goBack().catch((err) => {
      console.warn(
        `[usePreviewNavigation] back [${effectiveTabId}] error:`,
        err
      );
    });
  }, [canBack, effectiveTabId, markLoadingAttempt]);

  const goForward = useCallback(() => {
    if (!canForward) return;
    markLoadingAttempt();
    nativeActionsRef.current.goForward().catch((err) => {
      console.warn(
        `[usePreviewNavigation] forward [${effectiveTabId}] error:`,
        err
      );
    });
  }, [canForward, effectiveTabId, markLoadingAttempt]);

  const reload = useCallback(() => {
    if (isAboutBlank(activeUrl)) return;
    markLoadingAttempt();
    nativeActionsRef.current.reload().catch((err) => {
      console.warn(
        `[usePreviewNavigation] reload [${effectiveTabId}] error:`,
        err
      );
    });
  }, [activeUrl, effectiveTabId, markLoadingAttempt]);

  const stop = useCallback(() => {
    nativeActionsRef.current.stop().catch((err) => {
      console.warn(
        `[usePreviewNavigation] stop [${effectiveTabId}] error:`,
        err
      );
    });
  }, [effectiveTabId]);

  const goHome = useCallback(() => {
    navigate(getPreviewHomepage());
  }, [navigate]);

  const openExternal = useCallback(() => {
    if (!canOpenExternally(activeUrl)) {
      toastRef.current('当前地址无法在外部打开');
      return;
    }
    try {
      const w = window.open(activeUrl, '_blank', 'noopener,noreferrer');
      if (!w) toastRef.current('浏览器拦截了弹窗');
    } catch {
      toastRef.current('无法打开系统浏览器');
    }
  }, [activeUrl]);

  const onBookmark = useCallback(() => {
    if (isAboutBlank(activeUrl) || !activeUrl) {
      toastRef.current('空白页无法加入书签');
      return;
    }
    togglePreviewBookmark(
      activeUrl,
      previewDisplayHost(activeUrl) || activeUrl
    );
    setHistTick((n) => n + 1);
  }, [activeUrl]);

  const pickHistory = useCallback(
    (u: string) => {
      navigate(u);
      setShowHist(false);
    },
    [navigate]
  );

  const removeBookmarkAt = useCallback((url: string) => {
    removePreviewBookmark(url);
    setHistTick((n) => n + 1);
  }, []);

  const clearBookmarksAll = useCallback(() => {
    clearPreviewBookmarks();
    setHistTick((n) => n + 1);
  }, []);

  const clearHistoryAll = useCallback(() => {
    clearPreviewHistory();
    setHistTick((n) => n + 1);
  }, []);

  const removeHistoryAt = useCallback((url: string) => {
    removePreviewHistory(url);
    setHistTick((n) => n + 1);
  }, []);

  return {
    tabId: effectiveTabId,
    urlInput,
    setUrlInput,
    activeUrl,
    loadError,
    loading: native.isLoading,
    bookmarked,
    showHist,
    setShowHist,
    history,
    bookmarks,
    rootRef,
    histRef,
    blank,
    canEmbed,
    frameSrc,
    showFrame,
    canBack,
    canForward,
    canExternal,
    canBookmark,
    navigate,
    goBack,
    goForward,
    reload,
    stop,
    goHome,
    openExternal,
    onBookmark,
    pickHistory,
    removeBookmarkAt,
    clearHistoryAll,
    clearBookmarksAll,
    removeHistoryAt,
  };
}
