import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './PreviewCard.module.css';
import { Button, Tooltip } from '../ui';
import { usePreviewNavigation } from './usePreviewNavigation';
import { PreviewToolbar } from './PreviewToolbar';
import { PreviewHistoryPanel } from './PreviewHistoryPanel';
import { useActiveDevPorts } from './activePortDetector';
import {
  buildInspectorAiSnippet,
  buildInspectorElementLabel,
  hasInspectorComputedStyles,
  convertInspectedElementPayload,
} from './previewCardLib';
import { enableInspector, subscribeToInspector } from './previewHostBridge';
import { installPreviewInspectorClient } from './previewClientBridge';
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
  type InspectHoverPayload,
  type InspectSelectPayload,
} from './previewProtocol';
import { parseInspectedElementPayload } from './previewDomInspector';
import {
  selectActiveSession,
  useSessionField,
  useSessionStore,
} from '../../store/storeAccess';
import { useToast } from '../../services/toast/ToastContext';
import {
  setPreviewFavicon,
  isAboutBlank,
} from '../../api/previewBrowserStore';

export interface PreviewCardProps {
  wsId?: string;
}

/**
 * 内置原生预览浏览器：地址栏 + 原生 iframe（外部站点经 127.0.0.1:8765 透明代理
 * 加载，剥离 XFO/CSP 并注入 postMessage 桥接脚本）。
 * DOM 拾取链路：工具栏 Inspect 开关 → previewHostBridge 向 iframe postMessage
 * INSPECT_TOGGLE → iframe 客户端桥上报 INSPECT_HOVER / INSPECT_SELECT →
 * 宿主展示悬停浮层 / 选中详情卡（复制选择器 / 复制 HTML / 发送到 AI / Esc 退出）。
 */
export const PreviewCard: React.FC<PreviewCardProps> = ({
  wsId: _wsId,
}) => {
  const { showToast } = useToast();
  const nav = usePreviewNavigation();
  const { ports: activePorts } = useActiveDevPorts();
  const session = useSessionField(selectActiveSession);
  const isAiStreaming = Boolean(
    session?.messages?.some((m) => m.status === 'processing') ||
      session?.agents?.some((a) => a.status === 'running')
  );

  const [isInspectorActive, setIsInspectorActive] = React.useState(false);
  const [hoverElement, setHoverElement] =
    React.useState<InspectHoverPayload | null>(null);
  const [selectedElement, setSelectedElement] =
    React.useState<InspectSelectPayload | null>(null);

  const handleStopAi = () => {
    window.dispatchEvent(new CustomEvent('crish:chat-stop'));
  };

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

  // 最近访问（最多展示 3 条，排除当前空白或空串）
  const recentPages = React.useMemo(() => {
    return (history || [])
      .filter((u): u is string => Boolean(u && !isAboutBlank(u)))
      .slice(0, 3);
  }, [history]);

  const hasEmptyContent = activePorts.length > 0 || recentPages.length > 0;

  // 当前拾取态 ref：供桥回调读取最新值，避免闭包过期
  const isInspectorActiveRef = React.useRef(isInspectorActive);
  isInspectorActiveRef.current = isInspectorActive;

  const handleToggleInspector = React.useCallback(() => {
    const next = !isInspectorActiveRef.current;
    setIsInspectorActive(next);
    try {
      if (next && iframeRef.current?.contentDocument && iframeRef.current.contentWindow) {
        installPreviewInspectorClient({
          doc: iframeRef.current.contentDocument,
          win: iframeRef.current.contentWindow,
        });
      }
    } catch {
      // 跨源 iframe 忽略，由代理注入脚本处理
    }
    enableInspector(iframeRef.current, next);
    if (!next) setHoverElement(null);
  }, [iframeRef]);

  // 订阅 iframe 客户端桥上报（INSPECT_READY / INSPECT_TOGGLE / INSPECT_HOVER / INSPECT_SELECT）
  React.useEffect(() => {
    const unsubscribe = subscribeToInspector((event) => {
      if (event.type === 'INSPECT_READY') {
        // 客户端桥就绪：若仍处拾取态则补发一次激活指令（iframe 重载后恢复）
        if (isInspectorActiveRef.current) {
          enableInspector(iframeRef.current, true);
        }
        return;
      }
      if (event.type === 'INSPECT_TOGGLE') {
        // 客户端在 iframe 内按 Esc 退出拾取：同步复位宿主工具栏拾取态
        if (!event.payload.enabled && isInspectorActiveRef.current) {
          setIsInspectorActive(false);
          setHoverElement(null);
        }
        return;
      }
      if (event.type === 'INSPECT_HOVER') {
        setHoverElement(event.payload);
        return;
      }
      setHoverElement(null);
      setSelectedElement(event.payload);
    });
    return unsubscribe;
  }, [iframeRef]);

  // 拾取态下 Esc 退出拾取模式
  React.useEffect(() => {
    if (!isInspectorActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleToggleInspector();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isInspectorActive, handleToggleInspector]);

  // 预览导航事件 + 旧协议 crish:dom-inspected 兼容（previewDomInspector 运行时上报）。
  // 新协议消息（source = crish-preview-inspector / crish-preview-host）由
  // previewHostBridge 订阅处理，此处一律跳过，避免旧解析器吞掉新协议载荷。
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const source = event.data?.source;
      if (source === CRISH_PREVIEW_INSPECTOR_SOURCE || source === CRISH_PREVIEW_HOST_SOURCE) {
        return;
      }
      if (
        event.data?.type === 'preview:navigate' &&
        typeof event.data.href === 'string'
      ) {
        navigate(event.data.href);
        return;
      }
      if (
        event.data?.type === 'preview:favicon' &&
        typeof event.data.favicon === 'string'
      ) {
        setPreviewFavicon(event.data.url || activeUrl, event.data.favicon);
        return;
      }
      const payload = convertInspectedElementPayload(
        parseInspectedElementPayload(event.data)
      );
      if (!payload) return;
      setHoverElement(null);
      setSelectedElement(payload);
      showToast(`已拾取 DOM 元素：<${payload.bestSelector || payload.tagName}>`);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate, showToast, activeUrl]);

  const handleFrameLoad = () => {
    nav.onFrameLoad();
    try {
      if (iframeRef.current?.contentDocument) {
        const doc = iframeRef.current.contentDocument;
        const icon = doc.querySelector<HTMLLinkElement>(
          'link[rel~="icon"], link[rel*="icon"]'
        );
        const faviconUrl =
          icon?.href ||
          (activeUrl && !isAboutBlank(activeUrl)
            ? new URL('/favicon.ico', activeUrl).href
            : null);
        if (faviconUrl && activeUrl) {
          setPreviewFavicon(activeUrl, faviconUrl);
        }
      }
    } catch {
      // 跨源忽略，由代理注入脚本处理
    }
    try {
      if (iframeRef.current?.contentDocument && iframeRef.current.contentWindow) {
        installPreviewInspectorClient({
          doc: iframeRef.current.contentDocument,
          win: iframeRef.current.contentWindow,
        });
      }
    } catch {
      // 跨源 iframe 忽略，由代理注入脚本处理
    }
    if (isInspectorActive) {
      enableInspector(iframeRef.current, true);
    }
  };

  const handleCopySelector = React.useCallback(async () => {
    if (!selectedElement) return;
    try {
      await navigator.clipboard.writeText(selectedElement.bestSelector);
      showToast(`已复制选择器：${selectedElement.bestSelector}`);
    } catch {
      showToast('复制失败：剪贴板不可用');
    }
  }, [selectedElement, showToast]);

  const handleCopyHtml = React.useCallback(async () => {
    if (!selectedElement) return;
    try {
      await navigator.clipboard.writeText(selectedElement.outerHtmlSnippet);
      showToast('已复制 HTML 片段');
    } catch {
      showToast('复制失败：剪贴板不可用');
    }
  }, [selectedElement, showToast]);

  const handleSendToAi = React.useCallback(() => {
    if (!selectedElement) return;
    const sessionId = useSessionStore.getState().activeSessionId;
    const text = buildInspectorAiSnippet(
      selectedElement.tagName,
      selectedElement.id,
      selectedElement.classes,
      selectedElement.rect,
      selectedElement.bestSelector
    );
    if (sessionId) {
      useSessionStore.getState().setComposerDraft(sessionId, text);
    }
    showToast('已发送到对话输入框');
  }, [selectedElement, showToast]);

  return (
    <div
      className={`${styles.browser} chat-side-panel`}
      ref={rootRef}
      data-view-id="preview"
    >
      <PreviewToolbar
        preview={{
          canBack,
          canForward,
          blank,
          frameSrc,
          loading,
          urlInput,
          canBookmark,
          bookmarked,
          showHist,
          canExternal,
          isInspectorActive,
        }}
        navigation={{
          onBack: goBack,
          onForward: goForward,
          onHome: goHome,
          onReload: reload,
          onUrlSubmit: navigate,
          onUrlChange: setUrlInput,
          onClearUrl: () => setUrlInput(''),
        }}
        actions={{
          onBookmark,
          onToggleHist: () => setShowHist(!showHist),
          onOpenExternal: openExternal,
          onToggleInspector: handleToggleInspector,
        }}
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
        className={`${styles.frame} side-panel-body`}
        aria-busy={loading || undefined}
        aria-label="预览内容区"
      >
        {isAiStreaming && (
          <div className={styles.aiRunningBadge}>
            <span className={styles.aiRunningDot} aria-hidden />
            <span className={styles.aiRunningText}>AI 正在协同</span>
            <Tooltip content="停止 AI 动作">
              <Button
                type="button"
                variant="danger"
                size="sm"
                className={styles.aiStopBtn}
                onClick={handleStopAi}
                icon={<Lucide.Square size={11} fill="currentColor" />}
              >
                停止
              </Button>
            </Tooltip>
          </div>
        )}
            {!canEmbed || blank || !frameSrc ? (
              <div className={styles.emptyContainer}>
                {hasEmptyContent ? (
                  <div className={styles.minimalEmptyContent}>
                    {activePorts.length > 0 && (
                      <div className={styles.emptySection} role="group" aria-label="运行中的本地服务">
                        <div className={styles.textLinksColumn}>
                          {activePorts.map((port) => (
                            <button
                              key={port}
                              type="button"
                              className={styles.pureTextLink}
                              onClick={() => navigate(`http://localhost:${port}`)}
                              aria-label={`运行中的本地服务: localhost:${port}`}
                            >
                              <span className={styles.portLabel}>运行中的本地服务: </span>
                              <span className={styles.portValue}>localhost:{port}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {recentPages.length > 0 && (
                      <div className={styles.emptySection} role="group" aria-label="最近访问">
                        <span className={styles.emptySectionTitle}>最近访问</span>
                        <div className={styles.textLinksColumn}>
                          {recentPages.map((url) => {
                            let displayHost = url;
                            try {
                              const u = new URL(url);
                              displayHost = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname !== '/' ? u.pathname : ''}`;
                            } catch {
                              displayHost = url.replace(/^https?:\/\//, '');
                            }
                            return (
                              <button
                                key={url}
                                type="button"
                                className={styles.pureTextLinkWithIcon}
                                onClick={() => navigate(url)}
                                title={url}
                                aria-label={`打开最近网页 ${displayHost}`}
                              >
                                <Lucide.Globe size={12} className={styles.recentIcon} aria-hidden />
                                <span className={styles.recentText}>{displayHost}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={styles.pureBlankCanvas} aria-hidden="true" />
                )}
                {!canEmbed && !blank && (
                  <div className={styles.localPath}>
                    <code className={styles.localCode}>{activeUrl}</code>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={styles.quickChip}
                      onClick={openExternal}
                      disabled={!canExternal}
                    >
                      外部打开
                    </Button>
                  </div>
                )}
              </div>
            ) : loadError ? (
              <div className={styles.errorState} role="alert">
                <div className={styles.emptyTitle}>无法加载此页面</div>
                <div className={styles.emptyDesc}>站点可能设置了 X-Frame-Options / CSP，或地址无效。</div>
                <div className={styles.quickRow}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.quickChip}
                    onClick={reload}
                  >
                    重试
                  </Button>
                  {!blank && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={styles.quickChip}
                      onClick={openExternal}
                      disabled={!canExternal}
                    >
                      系统浏览器打开
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                key={activeUrl}
                aria-label="预览页面"
                src={frameSrc ?? undefined}
                className={styles.iframe}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                referrerPolicy="no-referrer"
                loading="lazy"
                onLoad={handleFrameLoad}
                onError={nav.onFrameError}
              />
            )}

        {hoverElement && isInspectorActive ? (
          <div
            className={styles.inspectorHover}
            data-inspector-hover=""
            style={{
              left: hoverElement.rect.x,
              top: hoverElement.rect.y,
              width: hoverElement.rect.width,
              height: hoverElement.rect.height,
            }}
            aria-hidden
          >
            <span className={styles.inspectorHoverTag}>
              <code>{hoverElement.tagName}</code>
              {hoverElement.selector ? (
                <em>{hoverElement.selector}</em>
              ) : null}
            </span>
          </div>
        ) : null}

        {selectedElement ? (
          <div
            className={styles.inspectorBadge}
            role="status"
            aria-label="DOM 拾取结果"
          >
            <div className={styles.inspectorResultText}>
              <Lucide.ScanSearch
                size={13}
                className={styles.inspectorResultIcon}
                aria-hidden
              />
              <span>已拾取 DOM 元素：</span>
              <code className={styles.inspectorCode}>
                {`<${buildInspectorElementLabel(
                  selectedElement.tagName,
                  selectedElement.id,
                  selectedElement.classes
                )}>`}
              </code>
              {selectedElement.bestSelector ? (
                <span className={styles.inspectorSelector}>
                  ({selectedElement.bestSelector})
                </span>
              ) : null}
              <span className={styles.inspectorDim}>
                {Math.round(selectedElement.rect.width)}×
                {Math.round(selectedElement.rect.height)}
              </span>
            </div>
            {hasInspectorComputedStyles(selectedElement) ? (
              <div className={styles.inspectorDetail}>
                <code>display: {selectedElement.computedStyles.display}</code>
                <code>position: {selectedElement.computedStyles.position}</code>
                <code>font-size: {selectedElement.computedStyles.fontSize}</code>
              </div>
            ) : null}
            <div className={styles.inspectorActions}>
              <Tooltip content="复制选择器">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.inspectorActionBtn}
                  onClick={handleCopySelector}
                  aria-label="复制选择器"
                  icon={<Lucide.Copy size={12} strokeWidth={1.75} />}
                />
              </Tooltip>
              <Tooltip content="复制 HTML 片段">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.inspectorActionBtn}
                  onClick={handleCopyHtml}
                  aria-label="复制 HTML 片段"
                  icon={<Lucide.Code2 size={12} strokeWidth={1.75} />}
                />
              </Tooltip>
              <Tooltip content="发送到 AI">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.inspectorActionBtn}
                  onClick={handleSendToAi}
                  aria-label="发送到 AI"
                  icon={<Lucide.Send size={12} strokeWidth={1.75} />}
                />
              </Tooltip>
              <Tooltip content="清除">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.inspectorActionBtn}
                  onClick={() => setSelectedElement(null)}
                  aria-label="清除拾取结果"
                  icon={<Lucide.X size={12} strokeWidth={1.75} />}
                />
              </Tooltip>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
