import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './PreviewCard.module.css';
import { Tooltip } from './settings/SettingsUI';
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
  normalizeBrowseUrl,
  previewDisplayHost,
  removePreviewBookmark,
  removePreviewHistory,
  setPreviewUrl,
  togglePreviewBookmark,
  validateBrowseUrl,
} from '../api/previewBrowserStore';

interface PreviewCardProps {
  wsId: string;
  onShowToast: (message: string) => void;
}

const QUICK_LOCAL = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:8765',
] as const;

/** iframe 加载卡住时收 loading，避免转圈永驻（不 toast，状态条已反馈） */
const LOAD_TIMEOUT_MS = 20_000;

const HIST_PANEL_ID = 'preview-hist-panel';

/**
 * 仅当可安全内嵌时返回 iframe src；否则 null（禁止把危险/不可嵌 URL 写入 iframe）。
 * 依赖 store 的 validateBrowseUrl + isEmbeddablePreviewUrl；about:blank 走空态不进 iframe。
 */
function safeIframeSrc(url: string): string | null {
  if (!url || isAboutBlank(url)) return null;
  const checked = validateBrowseUrl(url);
  if (!isBrowseUrlOk(checked)) return null;
  if (!isEmbeddablePreviewUrl(checked.url) || isAboutBlank(checked.url)) return null;
  return checked.url;
}

/**
 * 内置预览浏览器：地址栏 + iframe + 历史/书签。
 * 供用户与 AI 共用入口（导航、存档 URL）；跨域页面受浏览器安全策略限制。
 *
 * 反馈约定：导航 / 开面板成功静默；仅错误 toast。
 */
export const PreviewCard: React.FC<PreviewCardProps> = ({
  wsId: _wsId,
  onShowToast,
}) => {
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
    isPreviewBookmarked(getPreviewUrl()),
  );
  const [showHist, setShowHist] = useState(false);
  const [histTick, setHistTick] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef(onShowToast);
  toastRef.current = onShowToast;

  const history = useMemo(
    () => getPreviewHistory(),
    [activeUrl, showHist, histTick],
  );
  const bookmarks = useMemo(
    () => getPreviewBookmarks(),
    [bookmarked, activeUrl, histTick],
  );

  const blank = isAboutBlank(activeUrl);
  const hostLabel = useMemo(
    () => (blank ? '' : previewDisplayHost(activeUrl)),
    [activeUrl, blank],
  );
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
    [stackIdx],
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
      onShowToast('当前地址无法刷新');
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
        onShowToast('页面无法刷新');
      }
    }
  };

  const goHome = () => {
    navigate('about:blank');
  };

  const openExternal = () => {
    if (!canOpenExternally(activeUrl)) {
      onShowToast('当前地址无法在外部打开');
      return;
    }
    try {
      const w = window.open(activeUrl, '_blank', 'noopener,noreferrer');
      if (!w) onShowToast('浏览器拦截了弹窗');
      // 成功打开：静默
    } catch {
      onShowToast('无法打开系统浏览器');
    }
  };

  const onBookmark = () => {
    if (isAboutBlank(activeUrl) || !activeUrl) {
      onShowToast('空白页无法加入书签');
      return;
    }
    const on = togglePreviewBookmark(
      activeUrl,
      previewDisplayHost(activeUrl) || activeUrl,
    );
    setBookmarked(on);
    setHistTick((n) => n + 1);
    // 星标高亮即反馈，不 toast
  };

  const pickHistory = (u: string) => {
    navigate(u);
    setShowHist(false);
  };

  const iconSz = 14;
  const histCount = history.length;
  const bookCount = bookmarks.length;

  return (
    <div className={styles.browser} ref={rootRef}>
      <div
        className={styles.bar}
        role="toolbar"
        aria-label="预览浏览器工具栏"
      >
        <Tooltip content="后退">
          <button
            type="button"
            className={styles.navBtn}
            disabled={!canBack}
            onClick={goBack}
            aria-label="后退"
          >
            <Lucide.ChevronLeft size={iconSz} strokeWidth={1.75} />
          </button>
        </Tooltip>
        <Tooltip content="前进">
          <button
            type="button"
            className={styles.navBtn}
            disabled={!canForward}
            onClick={goForward}
            aria-label="前进"
          >
            <Lucide.ChevronRight size={iconSz} strokeWidth={1.75} />
          </button>
        </Tooltip>
        <Tooltip content="主页（空白预览）">
          <button
            type="button"
            className={`${styles.navBtn} ${styles.hideNarrow}`}
            onClick={goHome}
            aria-label="主页"
          >
            <Lucide.Home size={iconSz} strokeWidth={1.75} />
          </button>
        </Tooltip>
        <Tooltip content="刷新">
          <button
            type="button"
            className={styles.navBtn}
            disabled={blank || !frameSrc}
            onClick={reload}
            aria-label="刷新"
            aria-busy={loading || undefined}
          >
            {loading ? (
              <Lucide.Loader2
                size={iconSz}
                strokeWidth={1.75}
                className={styles.spin}
              />
            ) : (
              <Lucide.RotateCw size={iconSz} strokeWidth={1.75} />
            )}
          </button>
        </Tooltip>
        <form
          className={styles.urlForm}
          aria-label="预览地址栏"
          onSubmit={(e) => {
            e.preventDefault();
            // 空提交 → about:blank（validateBrowseUrl 成功静默路径）
            navigate(urlInput.trim() ? urlInput : 'about:blank');
          }}
        >
          <Lucide.Globe
            size={iconSz}
            className={styles.urlIco}
            strokeWidth={1.75}
            aria-hidden
          />
          <input
            className={styles.urlInput}
            value={urlInput}
            placeholder="localhost:5173 或 https://…"
            onChange={(e) => setUrlInput(e.target.value)}
            spellCheck={false}
            aria-label="预览地址"
            autoComplete="off"
            inputMode="url"
            enterKeyHint="go"
          />
          {urlInput ? (
            <Tooltip content="清空">
              <button
                type="button"
                className={styles.urlClear}
                onClick={() => setUrlInput('')}
                aria-label="清空地址"
              >
                <Lucide.X size={12} strokeWidth={1.75} />
              </button>
            </Tooltip>
          ) : null}
        </form>
        <Tooltip
          content={
            !canBookmark
              ? '空白页无法加入书签'
              : bookmarked
                ? '取消书签'
                : '加入书签'
          }
        >
          <button
            type="button"
            className={`${styles.navBtn} ${bookmarked ? styles.isOn : ''}`}
            onClick={onBookmark}
            disabled={!canBookmark}
            aria-label={bookmarked ? '取消书签' : '加入书签'}
            aria-pressed={bookmarked}
          >
            <Lucide.Star
              size={iconSz}
              strokeWidth={1.75}
              fill={bookmarked ? 'currentColor' : 'none'}
            />
          </button>
        </Tooltip>
        <Tooltip content="历史与书签">
          <button
            type="button"
            className={`${styles.navBtn} ${showHist ? styles.isOn : ''}`}
            data-hist-toggle=""
            onClick={() => setShowHist((v) => !v)}
            aria-label="历史与书签"
            aria-expanded={showHist}
            aria-controls={HIST_PANEL_ID}
            aria-haspopup="dialog"
          >
            <Lucide.History size={iconSz} strokeWidth={1.75} />
          </button>
        </Tooltip>
        <Tooltip content={canExternal ? '系统浏览器打开' : '当前地址无法外部打开'}>
          <button
            type="button"
            className={`${styles.navBtn} ${styles.hideXNarrow}`}
            onClick={openExternal}
            disabled={!canExternal}
            aria-label="系统浏览器打开"
          >
            <Lucide.ExternalLink size={iconSz} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>


      {showHist && (
        <div
          id={HIST_PANEL_ID}
          ref={histRef}
          className={`${styles.histPanel} ${styles.histPanelFloat}`}
          role="dialog"
          aria-modal="true"
          aria-label="书签与历史"
        >
          <div className={styles.histCol}>
            <div className={styles.histTitle}>
              书签{bookCount > 0 ? `（${bookCount}）` : ''}
            </div>
            {bookmarks.length === 0 ? (
              <div className={styles.histEmpty}>暂无书签</div>
            ) : (
              bookmarks.map((b) => {
                const isCurrent = b.url === activeUrl && !blank;
                return (
                  <div key={b.url} className={styles.histRow}>
                    <Tooltip content={b.url}>
                      <button
                        type="button"
                        className={styles.histItem}
                        onClick={() => pickHistory(b.url)}
                        aria-current={isCurrent ? 'true' : undefined}
                      >
                        {isCurrent
                          ? `当前 · ${b.title || b.url}`
                          : b.title || b.url}
                      </button>
                    </Tooltip>
                    <Tooltip content="移除书签">
                      <button
                        type="button"
                        className={styles.histX}
                        aria-label={`移除书签 ${b.title || b.url}`}
                        onClick={() => {
                          removePreviewBookmark(b.url);
                          setBookmarked(isPreviewBookmarked(activeUrl));
                          setHistTick((n) => n + 1);
                        }}
                      >
                        <Lucide.X size={12} />
                      </button>
                    </Tooltip>
                  </div>
                );
              })
            )}
          </div>
          <div className={styles.histCol}>
            <div className={styles.histTitleRow}>
              <div className={styles.histTitle}>
                最近访问{histCount > 0 ? `（${histCount}）` : ''}
              </div>
              {history.length > 0 ? (
                <Tooltip content="清空全部历史">
                  <button
                    type="button"
                    className={styles.histClear}
                    aria-label="清空全部历史"
                    onClick={() => {
                      clearPreviewHistory();
                      setHistTick((n) => n + 1);
                    }}
                  >
                    清空
                  </button>
                </Tooltip>
              ) : null}
            </div>
            {history.length === 0 ? (
              <div className={styles.histEmpty}>暂无历史</div>
            ) : (
              history.slice(0, 14).map((u) => {
                const isCurrent = u === activeUrl && !blank;
                const label = previewDisplayHost(u) || u;
                return (
                  <div key={u} className={styles.histRow}>
                    <Tooltip content={u}>
                      <button
                        type="button"
                        className={styles.histItem}
                        onClick={() => pickHistory(u)}
                        aria-current={isCurrent ? 'true' : undefined}
                      >
                        {isCurrent ? `当前 · ${label}` : label}
                      </button>
                    </Tooltip>
                    <Tooltip content="从历史移除">
                      <button
                        type="button"
                        className={styles.histX}
                        aria-label={`从历史移除 ${label}`}
                        onClick={() => {
                          removePreviewHistory(u);
                          setHistTick((n) => n + 1);
                        }}
                      >
                        <Lucide.X size={12} />
                      </button>
                    </Tooltip>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <div
        className={styles.frame}
        aria-busy={loading || undefined}
        aria-label="预览内容区"
      >
        {!canEmbed || blank || !frameSrc ? (
          <div className={styles.empty}>
            <Lucide.Globe
              size={22}
              strokeWidth={1.5}
              className={styles.emptyIco}
              aria-hidden
            />
            <div className={styles.emptyTitle}>预览浏览器</div>
            <div className={styles.emptyDesc}>
              输入本地地址（如 <code>localhost:5173</code>）或完整 URL。
              <span className={styles.browserNote}>
                {' '}
                部分站点禁止嵌入；可用外部打开。
              </span>
            </div>
            <div className={styles.quickRow} role="group" aria-label="快捷本地地址">
              {QUICK_LOCAL.map((u) => (
                <Tooltip key={u} content={u}>
                  <button
                    type="button"
                    className={styles.quickChip}
                    onClick={() => navigate(u)}
                  >
                    {u.replace(/^https?:\/\//, '')}
                  </button>
                </Tooltip>
              ))}
            </div>
            {!canEmbed && !blank ? (
              <div className={styles.localPath}>
                <code className={styles.localCode}>{activeUrl}</code>
                <button
                  type="button"
                  className={styles.quickChip}
                  onClick={openExternal}
                  disabled={!canExternal}
                >
                  外部打开
                </button>
              </div>
            ) : null}
          </div>
        ) : loadError || !showFrame ? (
          <div className={styles.empty} role="alert">
            <Lucide.AlertTriangle
              size={20}
              strokeWidth={1.5}
              className={styles.emptyIco}
              aria-hidden
            />
            <div className={styles.emptyTitle}>
              {loadError ? '无法内嵌加载' : '预览空白'}
            </div>
            <div className={styles.emptyDesc}>
              {loadError
                ? '站点可能设置了 X-Frame-Options / CSP，或地址无效。'
                : '输入地址后在此内嵌打开；不支持的协议不会加载。'}
            </div>
            <div className={styles.quickRow}>
              {loadError ? (
                <button
                  type="button"
                  className={styles.quickChip}
                  onClick={reload}
                >
                  重试
                </button>
              ) : null}
              {!blank ? (
                <button
                  type="button"
                  className={styles.quickChip}
                  onClick={openExternal}
                  disabled={!canExternal}
                >
                  系统浏览器打开
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            key={frameSrc}
            aria-label="预览页面"
            src={frameSrc}
            className={styles.iframe}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            // 禁止顶层导航逃逸；加载结果仅靠 onLoad / 超时收态
            loading="lazy"
            onLoad={() => {
              setLoading(false);
              setLoadError(false);
            }}
            onError={() => {
              setLoading(false);
              setLoadError(true);
              // 内嵌失败用状态条 + 空态展示；不 toast（常见于 XFO，避免吵）
            }}
          />
        )}
      </div>
    </div>
  );
};

// re-export for tests / callers that want pure normalize without store side-effects
export { normalizeBrowseUrl };
