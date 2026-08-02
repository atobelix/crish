import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './PreviewCard.module.css';
import { Tooltip } from '../Tooltip';
import { usePreviewNavigation } from './usePreviewNavigation';
import { PreviewToolbar } from './PreviewToolbar';
import { PreviewHistoryPanel } from './PreviewHistoryPanel';
import { QUICK_LOCAL } from './previewCardLib';

interface PreviewCardProps {
  wsId: string;
  onShowToast: (message: string) => void;
}

/**
 * 内置预览浏览器：地址栏 + iframe + 历史/书签。
 * 壳组件：只保留内容区（iframe / 空态）编排；导航栈/历史/书签/超时见
 * usePreviewNavigation，工具栏见 PreviewToolbar，历史面板见 PreviewHistoryPanel。
 * 供用户与 AI 共用入口（导航、存档 URL）；跨域页面受浏览器安全策略限制。
 *
 * 反馈约定：导航 / 开面板成功静默；仅错误 toast。
 */
export const PreviewCard: React.FC<PreviewCardProps> = ({
  wsId: _wsId,
  onShowToast,
}) => {
  const nav = usePreviewNavigation({ onShowToast });

  const {
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
  } = nav;

  return (
    <div className={styles.browser} ref={rootRef}>
      <PreviewToolbar
        canBack={canBack}
        canForward={canForward}
        blank={blank}
        frameSrc={frameSrc}
        loading={loading}
        urlInput={urlInput}
        canBookmark={canBookmark}
        bookmarked={bookmarked}
        showHist={showHist}
        canExternal={canExternal}
        onBack={goBack}
        onForward={goForward}
        onHome={goHome}
        onReload={reload}
        onUrlSubmit={navigate}
        onUrlChange={setUrlInput}
        onClearUrl={() => setUrlInput('')}
        onBookmark={onBookmark}
        onToggleHist={() => setShowHist(!showHist)}
        onOpenExternal={openExternal}
      />

      {showHist ? (
        <PreviewHistoryPanel
          history={history}
          bookmarks={bookmarks}
          activeUrl={activeUrl}
          blank={blank}
          histRef={histRef}
          onPickUrl={pickHistory}
          onRemoveBookmark={removeBookmarkAt}
          onClearHistory={clearHistoryAll}
          onRemoveHistory={removeHistoryAt}
        />
      ) : null}

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
            onLoad={nav.onFrameLoad}
            onError={nav.onFrameError}
          />
        )}
      </div>
    </div>
  );
};
