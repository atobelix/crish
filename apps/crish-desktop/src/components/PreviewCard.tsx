import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  getPreviewBookmarks,
  getPreviewHistory,
  getPreviewUrl,
  isPreviewBookmarked,
  normalizeBrowseUrl,
  setPreviewUrl,
  togglePreviewBookmark,
} from '../api/previewBrowserStore';
// Lucide icons

interface PreviewCardProps {
  wsId: string;
  onShowToast: (message: string) => void;
}

/**
 * 内置预览浏览器：地址栏 + iframe + 历史/书签。
 * 供用户与 AI 共用入口（导航、存档 URL）；跨域页面受浏览器安全策略限制。
 */
export const PreviewCard: React.FC<PreviewCardProps> = ({
  wsId: _wsId,
  onShowToast,
}) => {
  const [urlInput, setUrlInput] = useState(() => {
    const u = getPreviewUrl();
    return u === 'about:blank' ? '' : u;
  });
  const [activeUrl, setActiveUrl] = useState(() => getPreviewUrl());
  const [stack, setStack] = useState<string[]>(() => {
    const u = getPreviewUrl();
    return u && u !== 'about:blank' ? [u] : [];
  });
  const [stackIdx, setStackIdx] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [bookmarked, setBookmarked] = useState(() => isPreviewBookmarked(getPreviewUrl()));
  const [showHist, setShowHist] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const history = useMemo(() => getPreviewHistory(), [activeUrl, showHist]);
  const bookmarks = useMemo(() => getPreviewBookmarks(), [bookmarked, activeUrl]);

  useEffect(() => {
    const onExt = (ev: Event) => {
      const url = (ev as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      navigate(url, true);
    };
    window.addEventListener('crish-preview-url', onExt);
    return () => window.removeEventListener('crish-preview-url', onExt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback(
    (raw: string, fromExternal = false) => {
      const url = normalizeBrowseUrl(raw);
      setUrlInput(url === 'about:blank' ? '' : url);
      setActiveUrl(url);
      setPreviewUrl(url);
      setLoadError(false);
      setBookmarked(isPreviewBookmarked(url));
      if (!fromExternal) {
        setStack((prev) => {
          const base = prev.slice(0, stackIdx + 1);
          if (base[base.length - 1] === url) return base;
          const next = [...base, url];
          setStackIdx(next.length - 1);
          return next;
        });
      }
    },
    [stackIdx],
  );

  const goBack = () => {
    if (stackIdx <= 0) return;
    const i = stackIdx - 1;
    setStackIdx(i);
    const url = stack[i];
    setUrlInput(url);
    setActiveUrl(url);
    setPreviewUrl(url);
    setLoadError(false);
  };

  const goForward = () => {
    if (stackIdx >= stack.length - 1) return;
    const i = stackIdx + 1;
    setStackIdx(i);
    const url = stack[i];
    setUrlInput(url);
    setActiveUrl(url);
    setPreviewUrl(url);
    setLoadError(false);
  };

  const reload = () => {
    const el = iframeRef.current;
    if (el) {
      try {
        el.src = activeUrl;
      } catch {
        setLoadError(true);
      }
    }
  };

  const canEmbed =
    activeUrl.startsWith('http://') ||
    activeUrl.startsWith('https://') ||
    activeUrl === 'about:blank';

  return (
    <div className="preview-browser">
      <div className="preview-browser-bar">
        <button
          type="button"
          className="preview-nav-btn"
          title="后退"
          disabled={stackIdx <= 0}
          onClick={goBack}
        >
          <Lucide.ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className="preview-nav-btn"
          title="前进"
          disabled={stackIdx >= stack.length - 1}
          onClick={goForward}
        >
          <Lucide.ChevronRight size={15} />
        </button>
        <button type="button" className="preview-nav-btn" title="刷新" onClick={reload}>
          <Lucide.RotateCw size={13} />
        </button>
        <form
          className="preview-url-form"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(urlInput || 'about:blank');
          }}
        >
          <Lucide.Globe size={13} className="preview-url-ico" />
          <input
            className="preview-url-input"
            value={urlInput}
            placeholder="输入网址，如 localhost:5173 或 https://…"
            onChange={(e) => setUrlInput(e.target.value)}
            spellCheck={false}
          />
        </form>
        <button
          type="button"
          className={`preview-nav-btn ${bookmarked ? 'is-on' : ''}`}
          title={bookmarked ? '取消书签' : '加入书签'}
          onClick={() => {
            const on = togglePreviewBookmark(activeUrl);
            setBookmarked(on);
            onShowToast(on ? '已加入书签' : '已移除书签');
          }}
        >
          <Lucide.Star size={13} fill={bookmarked ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className="preview-nav-btn"
          title="历史"
          onClick={() => setShowHist((v) => !v)}
        >
          <Lucide.History size={13} />
        </button>
        <button
          type="button"
          className="preview-nav-btn"
          title="系统浏览器打开"
          onClick={() => {
            if (canEmbed && activeUrl !== 'about:blank') {
              window.open(activeUrl, '_blank', 'noopener,noreferrer');
            } else {
              onShowToast('当前地址无法在外部打开');
            }
          }}
        >
          <Lucide.ExternalLink size={13} />
        </button>
      </div>

      {showHist && (
        <div className="preview-hist-panel">
          <div className="preview-hist-col">
            <div className="preview-hist-title">书签</div>
            {bookmarks.length === 0 ? (
              <div className="preview-hist-empty">暂无书签</div>
            ) : (
              bookmarks.map((b) => (
                <button
                  key={b.url}
                  type="button"
                  className="preview-hist-item"
                  onClick={() => {
                    navigate(b.url);
                    setShowHist(false);
                  }}
                >
                  {b.title}
                </button>
              ))
            )}
          </div>
          <div className="preview-hist-col">
            <div className="preview-hist-title">最近访问</div>
            {history.length === 0 ? (
              <div className="preview-hist-empty">暂无历史</div>
            ) : (
              history.slice(0, 12).map((u) => (
                <button
                  key={u}
                  type="button"
                  className="preview-hist-item"
                  onClick={() => {
                    navigate(u);
                    setShowHist(false);
                  }}
                >
                  {u}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="preview-browser-frame">
        {!canEmbed || activeUrl === 'about:blank' ? (
          <div className="preview-browser-empty">
            <Lucide.Globe size={28} style={{ opacity: 0.35 }} />
            <div className="preview-browser-empty-title">内置预览浏览器</div>
            <div className="preview-browser-empty-desc">
              输入本地开发地址（如 <code>http://localhost:5173</code>）或网页 URL。
              <br />
              地址会记入历史/书签，便于 AI 与你协作时回看。
              <br />
              <span className="preview-browser-note">
                部分站点禁止被嵌入（X-Frame-Options）；可用「系统浏览器打开」。
              </span>
            </div>
            <div className="preview-quick-row">
              {['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:8765'].map(
                (u) => (
                  <button key={u} type="button" className="preview-quick-chip" onClick={() => navigate(u)}>
                    {u.replace('http://', '')}
                  </button>
                ),
              )}
            </div>
          </div>
        ) : loadError ? (
          <div className="preview-browser-empty">
            <Lucide.AlertTriangle size={24} style={{ opacity: 0.4 }} />
            <div>页面无法在内嵌框架中加载</div>
            <button
              type="button"
              className="preview-quick-chip"
              onClick={() => window.open(activeUrl, '_blank', 'noopener,noreferrer')}
            >
              用系统浏览器打开
            </button>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            key={activeUrl}
            title="preview-browser"
            src={activeUrl}
            className="preview-iframe"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            onError={() => setLoadError(true)}
          />
        )}
      </div>
    </div>
  );
};
