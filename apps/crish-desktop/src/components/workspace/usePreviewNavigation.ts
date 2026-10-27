/**
 * apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts
 *
 * 内置预览浏览器导航 hook：原生子 Webview 驱动 + 导航栈 + 历史/书签状态 + 外部事件。
 * 收拢 PreviewCard 的全部状态副作用；渲染层（工具栏 / 历史面板 / 内容区）只消费返回值。
 *
 * 核心升级：
 * 1. 彻底移除 safeIframeSrc 对代理端点的依赖，activeUrl 100% 保持公网原始 URL；
 * 2. 导航指令直接由 browserWebviewNavigate / browserWebviewAction 驱动原生 Webview；
 * 3. 监听 onNativeBrowserNavigationState 事件实现响应式状态同步（SSOT 原则）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../services/toast/ToastContext';
import {
  canOpenExternally,
  clearPreviewHistory,
  getPreviewBookmarks,
  getPreviewHistory,
  getPreviewUrl,
  isAboutBlank,
  isBrowseUrlOk,
  isEmbeddablePreviewUrl,
  isPreviewBookmarked,
  previewDisplayHost,
  removePreviewBookmark,
  removePreviewHistory,
  setPreviewUrl,
  togglePreviewBookmark,
  validateBrowseUrl,
} from '../../api/previewBrowserStore';
import {
  browserWebviewAction,
  browserWebviewNavigate,
  onNativeBrowserNavigationState,
} from '../../api/nativeBrowserApi';
import { LOAD_TIMEOUT_MS } from './previewCardLib';
import {
  shouldConsumeScopedEvent,
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';

export type UsePreviewNavigationOptions = {
  tabId?: string | null;
  leafId?: string | null;
  sessionId?: string | null;
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
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
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
  removeHistoryAt: (url: string) => void;
  /** iframe onLoad：收 loading + 清错误 */
  onFrameLoad: () => void;
  /** iframe onError：收 loading + 标错误（内嵌失败走状态条，不 toast） */
  onFrameError: () => void;
};

export function usePreviewNavigation(
  opts: UsePreviewNavigationOptions = {}
): UsePreviewNavigationResult {
  const leafScope = useLeafScope();
  const scopedSessionId = useScopedSessionId(opts.sessionId);
  const effectiveLeafId = opts.leafId ?? leafScope.leafId;
  const effectiveTabId = useMemo(() => {
    if (opts.tabId) return opts.tabId;
    if (effectiveLeafId) return `browser-${effectiveLeafId}`;
    return 'browser-default';
  }, [opts.tabId, effectiveLeafId]);

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

  const [urlInput, setUrlInput] = useState(() => {
    const u = getPreviewUrl();
    return isAboutBlank(u) ? '' : u;
  });
  const [activeUrl, setActiveUrl] = useState(() => getPreviewUrl());
  const [stack, setStack] = useState<string[]>(() => {
    const u = getPreviewUrl();
    return u && !isAboutBlank(u) ? [u] : [];
  });
  const [stackIdx, setStackIdx] = useState(0);
  const [nativeCanBack, setNativeCanBack] = useState<boolean | null>(null);
  const [nativeCanForward, setNativeCanForward] = useState<boolean | null>(
    null
  );
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bookmarked, setBookmarked] = useState(() =>
    isPreviewBookmarked(getPreviewUrl())
  );
  const [showHist, setShowHist] = useState(false);
  const [, setHistTick] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef((m: string) => toast.show(m));
  toastRef.current = (m: string) => toast.show(m);

  const history = useMemo(() => getPreviewHistory(), []);
  const bookmarks = useMemo(() => getPreviewBookmarks(), []);

  const blank = isAboutBlank(activeUrl);
  const canEmbed = isEmbeddablePreviewUrl(activeUrl);
  // 彻底移除代理前缀，原生 Webview 与 frameSrc 100% 直连目标 URL
  const frameSrc = useMemo(
    () => (isAboutBlank(activeUrl) ? null : activeUrl),
    [activeUrl]
  );
  const showFrame = Boolean(frameSrc) && !loadError;
  const canBack =
    nativeCanBack !== null ? nativeCanBack : stackIdx > 0 && stack.length > 0;
  const canForward =
    nativeCanForward !== null ? nativeCanForward : stackIdx < stack.length - 1;
  const canExternal = canOpenExternally(activeUrl);
  const canBookmark = !blank && Boolean(activeUrl);

  const navigate = useCallback(
    (raw: string, fromExternal = false) => {
      const checked = validateBrowseUrl(raw);
      if (!isBrowseUrlOk(checked)) {
        toastRef.current(checked.reason);
        return;
      }
      const url = checked.url;
      const nextBlank = isAboutBlank(url);
      setUrlInput(nextBlank ? '' : url);
      setActiveUrl((prev) => (prev === url ? prev : url));
      setLoadError(false);
      setLoading(!nextBlank && isEmbeddablePreviewUrl(url));
      setBookmarked(isPreviewBookmarked(url));
      emitScopedUrlChange(url);

      // 下发原生 Webview 导航命令
      browserWebviewNavigate(effectiveTabId, url).catch((err) => {
        console.warn(
          `[usePreviewNavigation] browserWebviewNavigate [${effectiveTabId}] error:`,
          err
        );
      });

      if (fromExternal) return;
      setPreviewUrl(url, { silent: true });
      setStack((prev) => {
        const base = prev.slice(0, stackIdx + 1);
        if (base[base.length - 1] === url) return base;
        const next = [...base, url];
        setStackIdx(next.length - 1);
        return next;
      });
    },
    [effectiveTabId, emitScopedUrlChange, stackIdx]
  );

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // 监听原生 Webview 广播的细粒度导航状态事件
  useEffect(() => {
    const unsub = onNativeBrowserNavigationState((payload) => {
      if (payload.tabId !== effectiveTabId) return;

      const nextUrl = payload.url;
      const nextBlank = isAboutBlank(nextUrl);

      setActiveUrl((prev) => (prev === nextUrl ? prev : nextUrl));
      setUrlInput(nextBlank ? '' : nextUrl);
      setLoading(payload.isLoading);
      setNativeCanBack(payload.canGoBack);
      setNativeCanForward(payload.canGoForward);
      setBookmarked(isPreviewBookmarked(nextUrl));
      setLoadError(false);

      if (!nextBlank) {
        setPreviewUrl(nextUrl, { silent: true });
        emitScopedUrlChange(nextUrl);
      }
    });

    return unsub;
  }, [effectiveTabId, emitScopedUrlChange]);

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

  // 加载超时保护
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => {
      setLoading(false);
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [loading, activeUrl]);

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

  const applyStackUrl = (url: string, idx: number) => {
    const checked = validateBrowseUrl(url);
    if (!isBrowseUrlOk(checked)) {
      toastRef.current(checked.reason);
      return;
    }
    const safe = checked.url;
    const nextBlank = isAboutBlank(safe);
    setStackIdx(idx);
    setUrlInput(nextBlank ? '' : safe);
    setActiveUrl(safe);
    setPreviewUrl(safe, { silent: true });
    emitScopedUrlChange(safe);
    setLoadError(false);
    setLoading(!nextBlank && isEmbeddablePreviewUrl(safe));
    setBookmarked(isPreviewBookmarked(safe));

    browserWebviewNavigate(effectiveTabId, safe).catch((err) => {
      console.warn(
        `[usePreviewNavigation] applyStackUrl [${effectiveTabId}] error:`,
        err
      );
    });
  };

  const goBack = useCallback(() => {
    if (!canBack) return;
    browserWebviewAction(effectiveTabId, 'back').catch((err) => {
      console.warn(
        `[usePreviewNavigation] back [${effectiveTabId}] error:`,
        err
      );
    });
    if (stackIdx > 0 && stack.length > 0) {
      const i = stackIdx - 1;
      const url = stack[i];
      if (url) applyStackUrl(url, i);
    }
  }, [canBack, effectiveTabId, stackIdx, stack]);

  const goForward = useCallback(() => {
    if (!canForward) return;
    browserWebviewAction(effectiveTabId, 'forward').catch((err) => {
      console.warn(
        `[usePreviewNavigation] forward [${effectiveTabId}] error:`,
        err
      );
    });
    if (stackIdx < stack.length - 1) {
      const i = stackIdx + 1;
      const url = stack[i];
      if (url) applyStackUrl(url, i);
    }
  }, [canForward, effectiveTabId, stackIdx, stack]);

  const reload = useCallback(() => {
    if (isAboutBlank(activeUrl)) return;
    setLoadError(false);
    setLoading(true);

    browserWebviewAction(effectiveTabId, 'reload').catch((err) => {
      console.warn(
        `[usePreviewNavigation] reload [${effectiveTabId}] error:`,
        err
      );
    });

    const el = iframeRef.current;
    if (el) {
      try {
        el.src = activeUrl;
      } catch {
        setLoadError(true);
        setLoading(false);
      }
    }
  }, [activeUrl, effectiveTabId]);

  const stop = useCallback(() => {
    setLoading(false);
    browserWebviewAction(effectiveTabId, 'stop').catch((err) => {
      console.warn(
        `[usePreviewNavigation] stop [${effectiveTabId}] error:`,
        err
      );
    });
  }, [effectiveTabId]);

  const goHome = useCallback(() => {
    navigate('about:blank');
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
    const on = togglePreviewBookmark(
      activeUrl,
      previewDisplayHost(activeUrl) || activeUrl
    );
    setBookmarked(on);
    setHistTick((n) => n + 1);
  }, [activeUrl]);

  const pickHistory = useCallback(
    (u: string) => {
      navigate(u);
      setShowHist(false);
    },
    [navigate]
  );

  const removeBookmarkAt = useCallback(
    (url: string) => {
      removePreviewBookmark(url);
      setBookmarked(isPreviewBookmarked(activeUrl));
      setHistTick((n) => n + 1);
    },
    [activeUrl]
  );

  const clearHistoryAll = useCallback(() => {
    clearPreviewHistory();
    setHistTick((n) => n + 1);
  }, []);

  const removeHistoryAt = useCallback((url: string) => {
    removePreviewHistory(url);
    setHistTick((n) => n + 1);
  }, []);

  const onFrameLoad = useCallback(() => {
    setLoading(false);
    setLoadError(false);
  }, []);

  const onFrameError = useCallback(() => {
    setLoading(false);
    setLoadError(true);
  }, []);

  return {
    tabId: effectiveTabId,
    urlInput,
    setUrlInput,
    activeUrl,
    loadError,
    loading,
    bookmarked,
    showHist,
    setShowHist,
    history,
    bookmarks,
    iframeRef,
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
    removeHistoryAt,
    onFrameLoad,
    onFrameError,
  };
}
