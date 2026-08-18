import { toast } from '../../services/toast/ToastContext';
/**
 * 内置预览浏览器导航 hook：导航栈 + 历史/书签状态 + 加载超时 + 外部事件。
 * 收拢 PreviewCard 的全部状态副作用；渲染层（工具栏 / 历史面板 / 内容区）
 * 只消费返回值。
 *
 * 反馈约定：导航 / 开面板成功静默；仅错误 toast。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { LOAD_TIMEOUT_MS, safeIframeSrc } from './previewCardLib';

export type UsePreviewNavigationOptions = {
};

export type UsePreviewNavigationResult = {
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
  _opts: UsePreviewNavigationOptions = {}
): UsePreviewNavigationResult {
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
  const frameSrc = useMemo(() => safeIframeSrc(activeUrl), [activeUrl]);
  const showFrame = Boolean(frameSrc) && !loadError;
  const canBack = stackIdx > 0 && stack.length > 0;
  const canForward = stackIdx < stack.length - 1;
  const canExternal = canOpenExternally(activeUrl);
  const canBookmark = !blank && Boolean(activeUrl);

  const navigate = useCallback(
    (raw: string, fromExternal = false) => {
      const checked = validateBrowseUrl(raw);
      // 错误才 toast；成功路径静默。用类型守卫收窄 reason / url。
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
      // 外部事件已由 setPreviewUrl 广播：只同步本地 UI，禁止再 setPreviewUrl，否则事件环栈溢出
      if (fromExternal) return;
      setPreviewUrl(url);
      setStack((prev) => {
        const base = prev.slice(0, stackIdx + 1);
        if (base[base.length - 1] === url) return base;
        const next = [...base, url];
        setStackIdx(next.length - 1);
        return next;
      });
    },
    [stackIdx]
  );

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const onExt = (ev: Event) => {
      const detail = (ev as CustomEvent<{ url?: unknown }>).detail;
      const url = detail?.url;
      if (typeof url !== 'string' || !url) return;
      // navigate 内 validateBrowseUrl：外部广播同样拒绝危险 scheme
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

  // 加载超时：只收 loading 态，不 toast（跨域/慢站常见，状态条已有「加载中」）
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
    // 后退/前进也走校验，避免栈内脏 URL 写入 iframe / 存储
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
    setLoadError(false);
    setLoading(!nextBlank && isEmbeddablePreviewUrl(safe));
    setBookmarked(isPreviewBookmarked(safe));
  };

  const goBack = () => {
    if (!canBack) return;
    const i = stackIdx - 1;
    const url = stack[i];
    if (!url) return;
    applyStackUrl(url, i);
  };

  const goForward = () => {
    if (!canForward) return;
    const i = stackIdx + 1;
    const url = stack[i];
    if (!url) return;
    applyStackUrl(url, i);
  };

  const reload = () => {
    if (isAboutBlank(activeUrl)) return;
    const src = safeIframeSrc(activeUrl);
    if (!src) {
      toastRef.current('当前地址无法刷新');
      return;
    }
    const el = iframeRef.current;
    setLoadError(false);
    setLoading(true);
    if (el) {
      try {
        el.src = src;
      } catch {
        setLoadError(true);
        setLoading(false);
        toastRef.current('页面无法刷新');
      }
    }
  };

  const goHome = () => {
    navigate('about:blank');
  };

  const openExternal = () => {
    if (!canOpenExternally(activeUrl)) {
      toastRef.current('当前地址无法在外部打开');
      return;
    }
    try {
      const w = window.open(activeUrl, '_blank', 'noopener,noreferrer');
      if (!w) toastRef.current('浏览器拦截了弹窗');
      // 成功打开：静默
    } catch {
      toastRef.current('无法打开系统浏览器');
    }
  };

  const onBookmark = () => {
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
    // 星标高亮即反馈，不 toast
  };

  const pickHistory = (u: string) => {
    navigate(u);
    setShowHist(false);
  };

  const removeBookmarkAt = (url: string) => {
    removePreviewBookmark(url);
    setBookmarked(isPreviewBookmarked(activeUrl));
    setHistTick((n) => n + 1);
  };

  const clearHistoryAll = () => {
    clearPreviewHistory();
    setHistTick((n) => n + 1);
  };

  const removeHistoryAt = (url: string) => {
    removePreviewHistory(url);
    setHistTick((n) => n + 1);
  };

  const onFrameLoad = () => {
    setLoading(false);
    setLoadError(false);
  };

  const onFrameError = () => {
    setLoading(false);
    setLoadError(true);
    // 内嵌失败用状态条 + 空态展示；不 toast（常见于 XFO，避免吵）
  };

  return {
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
