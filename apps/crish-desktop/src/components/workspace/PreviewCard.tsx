import React from 'react';

import styles from './PreviewCard.module.css';
import { Button, Tooltip } from '@/components/ui';
import {
  resolveBrowserTabId,
  usePreviewNavigation,
} from './usePreviewNavigation';
import { PreviewToolbar } from './PreviewToolbar';
import { PreviewHistoryPanel } from './PreviewHistoryPanel';
import { PreviewStartPage } from './PreviewStartPage';
import { useActiveDevPorts } from './activePortDetector';
import {
  buildDomReferenceChipPayload,
  serializeDomReferenceChipForComposer,
  HIST_PANEL_ID,
} from './previewCardLib';
import { PreviewCardInspectorOverlay } from './PreviewCardInspectorOverlay';
import { useNativeInspectorBridge } from './useNativeInspectorBridge';
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
} from './previewProtocol';
import { useSessionStore } from '../../store/storeAccess';
import {
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';
import { useToast } from '../../services/toast/ToastContext';
import { isAboutBlank } from '../../api/previewBrowserStore';
import { onNativeBrowserNavigationState } from '../../api/nativeBrowserApi';
import { emitUiEvent } from '../../api/uiEvents';
import { AppIcon } from '@/components/ui/icons';
import { NativeBrowserSurface } from './NativeBrowserSurface';

export interface PreviewCardProps {
  /** 标签页唯一实例标识（直接对应 Tauri 原生 Webview tabId，单一真理来源） */
  tabId?: string | null;
  /** 兼容别名标识（对齐 ViewRenderContext.panelId） */
  panelId?: string | null;
  wsId?: string;
  /**
   * 初始目标 URL（参数直通，优先于 params.target）：
   * 由 ViewRenderContext.params.url（或 params.target）直通下发，
   * 彻底清退从 viewId: 'preview:https://...' 弱类型字符串解析。
   */
  initialTarget?: string | null;
  initialUrl?: string | null;
  sessionId?: string | null;
  leafId?: string | null;
  /** 视口是否处于激活状态（Tab 激活与分屏聚焦），非激活时隐藏 HWND */
  isActive?: boolean;
}

/**
 * 内置原生预览浏览器：地址栏 + Native WebView 直接加载目标 URL。
 * 页面拾取由 native inspector bridge 接入原生浏览器命令和事件。
 * DOM 拾取通过 browser_webview_set_inspector 启停，并由
 * browser://inspector-event 按 tabId 路由结果；宿主保留悬停浮层、详情卡、
 * 复制选择器 / HTML、发送到 AI 与 Esc 退出交互。
 */
export const PreviewCard: React.FC<PreviewCardProps> = ({
  tabId,
  panelId,
  wsId: _wsId,
  initialTarget,
  initialUrl,
  sessionId,
  leafId,
  isActive = true,
}) => {
  const { showToast } = useToast();
  const scope = useLeafScope();
  const scopedSessionId = useScopedSessionId(sessionId);
  const effectiveLeafId = leafId ?? scope.leafId;
  const targetTabId = tabId?.trim() || panelId?.trim();
  const effectiveTabId = resolveBrowserTabId(targetTabId, effectiveLeafId);
  const effectiveInitialUrl = (initialUrl ?? initialTarget)?.trim() || null;
  const nav = usePreviewNavigation({
    tabId: effectiveTabId,
    leafId: effectiveLeafId,
    sessionId: scopedSessionId,
    initialUrl: effectiveInitialUrl,
  });
  const { ports: activePorts } = useActiveDevPorts();
  const [pageMeta, setPageMeta] = React.useState<{
    tabId: string;
    url: string;
    title: string;
  } | null>(null);
  React.useEffect(() => {
    setPageMeta(null);
    return onNativeBrowserNavigationState((state) => {
      if (state.tabId === effectiveTabId) {
        setPageMeta({
          tabId: state.tabId,
          url: state.url,
          title: state.isLoading ? '' : state.title,
        });
      }
    });
  }, [effectiveTabId]);
  const isAiStreaming = useSessionStore(
    React.useCallback(
      (s) => {
        if (!scopedSessionId) return false;
        const sess = s.sessionsById[scopedSessionId];
        return Boolean(
          sess?.messages?.some((m) => m.status === 'processing') ||
          sess?.agents?.some((a) => a.status === 'running')
        );
      },
      [scopedSessionId]
    )
  );

  const handleStopAi = () => {
    emitUiEvent('stop-generation', {
      sessionId: scopedSessionId,
      leafId: effectiveLeafId ?? undefined,
    });
    window.dispatchEvent(
      new CustomEvent('crish:chat-stop', {
        detail: {
          sessionId: scopedSessionId,
          leafId: effectiveLeafId ?? undefined,
        },
      })
    );
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
    rootRef,
    histRef,
    blank,
    canEmbed,
    frameSrc,
    showFrame: _showFrame,
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
  } = nav;
  const pageTitle =
    pageMeta?.tabId === effectiveTabId && pageMeta.url === activeUrl
      ? pageMeta.title
      : '';

  const shouldMountNativeSurface =
    !blank && canEmbed && Boolean(frameSrc) && !loadError;
  const [nativeSurfaceReady, setNativeSurfaceReady] = React.useState(false);
  React.useEffect(() => {
    if (!shouldMountNativeSurface) setNativeSurfaceReady(false);
  }, [shouldMountNativeSurface]);
  const onNativeSurfaceReadyChange = React.useCallback((ready: boolean) => {
    setNativeSurfaceReady(ready);
  }, []);
  // Navigation loading does not clear readiness or the user's Inspector intent.
  // The new document announces INSPECT_READY and the hook re-enables its probe.
  const isInspectorAvailable = shouldMountNativeSurface && nativeSurfaceReady;
  const inspector = useNativeInspectorBridge(
    effectiveTabId,
    isInspectorAvailable,
    !loading
  );
  const {
    isActive: isInspectorActive,
    canToggle: canToggleInspector,
    hoverElement,
    selectedElement,
    toggle: handleToggleInspector,
  } = inspector;

  // 最近访问（最多展示 8 条，排除当前空白或空串）
  const recentPages = React.useMemo(() => {
    return (history || [])
      .filter((u): u is string => Boolean(u && !isAboutBlank(u)))
      .slice(0, 8);
  }, [history]);

  // T20 / V2 参数直通：挂载时或 initialTarget 导航一次（ref 锁防重入；
  // navigate 内部经 validateBrowseUrl 校验，非法目标被拒并 toast）。
  const initialTargetRef = React.useRef<string | null | undefined>(
    effectiveInitialUrl
  );
  React.useEffect(() => {
    const target = initialTargetRef.current;
    initialTargetRef.current = undefined;
    if (!target || isAboutBlank(target)) return;
    navigate(target);
  }, [navigate]);

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

  // 预览导航事件监听
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const source = event.data?.source;
      if (
        source === CRISH_PREVIEW_INSPECTOR_SOURCE ||
        source === CRISH_PREVIEW_HOST_SOURCE
      ) {
        return;
      }
      if (
        event.data?.type === 'preview:navigate' &&
        typeof event.data.href === 'string'
      ) {
        navigate(event.data.href);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate]);

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
    if (!scopedSessionId) {
      showToast('当前没有可用的对话，无法发送 DOM 引用');
      return;
    }
    const payload = buildDomReferenceChipPayload(
      selectedElement,
      activeUrl,
      pageTitle
    );
    const text = serializeDomReferenceChipForComposer(payload);
    useSessionStore.getState().setComposerDraft(scopedSessionId, text);
    showToast('已发送到对话输入框');
  }, [activeUrl, pageTitle, selectedElement, scopedSessionId, showToast]);

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
          isInspectorAvailable: canToggleInspector,
        }}
        navigation={{
          onBack: goBack,
          onForward: goForward,
          onHome: goHome,
          onReload: reload,
          onStop: stop,
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
          id={HIST_PANEL_ID}
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
                icon={<AppIcon name="square" size={11} fill="currentColor" />}
              >
                停止
              </Button>
            </Tooltip>
          </div>
        )}
        {!canEmbed || blank || !frameSrc ? (
          <div className={styles.emptyContainer}>
            <PreviewStartPage
              activePorts={activePorts}
              recentPages={recentPages}
              onNavigate={navigate}
            />
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
          <NativeBrowserSurface
            tabId={effectiveTabId}
            initialUrl={activeUrl}
            isActive={isActive}
            onReadyChange={onNativeSurfaceReadyChange}
          />
        )}

        <PreviewCardInspectorOverlay
          isInspectorActive={isInspectorActive}
          hoverElement={hoverElement}
          selectedElement={selectedElement}
          onCopySelector={handleCopySelector}
          onCopyHtml={handleCopyHtml}
          onSendToAi={handleSendToAi}
          onClearSelected={inspector.clearSelection}
        />
      </div>
    </div>
  );
};
