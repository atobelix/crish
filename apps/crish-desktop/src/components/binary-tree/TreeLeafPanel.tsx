import { AppIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui';
/**
 * 二叉树叶子面板 — 声明式微内核叶子容器。
 *
 * 架构契约：
 * - 纯几何叶子空间容器，100% 剥离 switch(panelId) 静态硬编码；
 * - 依据 Rule G-08 规约，通过 tabViewAdapter 动态映射 UnifiedTab 视图；
 * - 内部右坞完全委托给 DockSplitWorkspace（含 LeafToolTabStrip）渲染二叉空间分屏树；
 * - 仍禁止复活 ChatHeader / UnitSessionTabStrip / GlobalSessionTabBar。
 * 未提交的新对话不占标签；画面会话 = 本叶选中 tab，否则为本叶草稿哨兵。
 */

import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { UnitChromeActions } from '../chat-card/UnitChromeActions';
import { LeafDockResizer } from './LeafDockResizer';
import { PaneHeader } from './PaneHeader';
import { computePaneEdges } from './paneEdgeGeometry';
import { DockSplitWorkspace } from './DockSplitWorkspace';
import styles from './BinaryTreeWorkspace.module.css';
import {
  openToolInLeaf,
  updateLeafDock,
  useLayoutStore,
  useSessionStore,
  useLayoutTreeStore,
  getCompositionRoot,
  isPendingDraft,
  isDockTreeEmpty,
  findSpatialNode,
  type DockLeaf,
} from '../../store/storeAccess';
import { LeafScopeProvider } from '../../contexts/LeafScopeContext';
import { resolveTabView } from './tabViewAdapter';
import {
  COLLAPSED_DOCK,
  leafPropsEqual,
  readActiveTab,
  readActiveTabId,
  readLeafTabs,
  rectPropsEqual,
  resolveLeafSessionId,
  sessionShell,
  type TreeLeafPanelProps,
} from './treeLeafPanelModel';
import {
  viewRegistry,
  SlotOutlet,
  type ViewRenderContext,
} from '../../services/view-registry';

const isCloseTarget = (e?: React.SyntheticEvent) =>
  Boolean(
    e?.target &&
    'closest' in (e.target as HTMLElement) &&
    (e.target as HTMLElement).closest(
      '[data-tab-close], [data-pane-close], [data-prevent-leaf-activate="true"], button[aria-label*="关闭"], button[title*="关闭"]'
    )
  );

export const TreeLeafPanel: React.FC<TreeLeafPanelProps> = React.memo(
  ({ leaf, rect, isActive, isDragSource }) => {
    const leafElRef = useRef<HTMLDivElement>(null);
    const leafBodyRef = useRef<HTMLDivElement>(null);
    const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
    const isChatSurface = chatMainSurface === 'chat';

    const globalActiveSessionId = useSessionStore((s) => s.activeSessionId);
    const rawActiveTab = readActiveTab(leaf);
    const isLeafDraft =
      !rawActiveTab ||
      ((!rawActiveTab.kind || rawActiveTab.kind === 'chat') &&
        isPendingDraft(rawActiveTab.sessionId));
    const activeTab =
      isLeafDraft && !rawActiveTab?.sessionId ? undefined : rawActiveTab;

    const tabResolution = useMemo(
      () => resolveTabView(activeTab),
      [
        activeTab?.tabId,
        activeTab?.kind,
        activeTab?.sessionId,
        activeTab?.terminalKey,
        activeTab?.cwd,
        activeTab?.url,
      ]
    );

    const fallbackSessionId = resolveLeafSessionId(leaf, {
      isFocused: isActive,
      globalActiveSessionId,
    });
    const effectiveSessionId = tabResolution.sessionId ?? fallbackSessionId;
    const sessionForPanel = effectiveSessionId;
    const dock = activeTab?.dock ?? leaf.dock ?? COLLAPSED_DOCK;
    const isTerminalTab = activeTab?.kind === 'terminal';
    const isBrowserTab = activeTab?.kind === 'browser';
    const isStandaloneTab = isTerminalTab || isBrowserTab;
    const dockOpen =
      isChatSurface &&
      !isLeafDraft &&
      !isStandaloneTab &&
      dock.collapsed !== true &&
      Boolean(dock.tree && !isDockTreeEmpty(dock.tree));

    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
      if (!dockOpen && isMaximized) {
        setIsMaximized(false);
      }
    }, [dockOpen, isMaximized]);

    const handleCaptureActivate = useCallback(
      (e: React.SyntheticEvent) => {
        if (isCloseTarget(e) || chatMainSurface !== 'chat') return;

        // 幂等短路守卫（Guard-2）：若当前叶子已是全局激活叶且 activeSessionId 已对齐，立即 return
        const currentActiveLeafId = useLayoutTreeStore.getState().activeLeafId;
        const currentActiveSessionId =
          useSessionStore.getState().activeSessionId;
        if (
          isActive &&
          currentActiveLeafId === leaf.id &&
          currentActiveSessionId === effectiveSessionId
        ) {
          return;
        }

        if (!isActive) {
          useLayoutTreeStore.getState().setActiveLeaf(leaf.id);
          // 🔒 铁律：只有 ChatTab 才允许触碰 sessionStore 状态机！
          // 独立终端与独立浏览器绝不调用 setActiveSessionId 或 enterDraftMode，杜绝聊天会话指针污染
          if (!isStandaloneTab) {
            const sessionStore = useSessionStore.getState();
            if (isPendingDraft(effectiveSessionId)) {
              if (!isPendingDraft(sessionStore.activeSessionId)) {
                sessionStore.enterDraftMode(
                  sessionStore.draftFolder || undefined,
                  {
                    draftSessionId: effectiveSessionId,
                  }
                );
              }
            } else {
              sessionStore.setActiveSessionId(effectiveSessionId);
            }
          }
          const tabId = readActiveTabId(leaf);
          if (tabId) {
            sessionShell().activateTab(leaf.id, tabId);
          } else {
            getCompositionRoot().shell.focusLeaf(leaf.id);
          }
        }
      },
      [chatMainSurface, effectiveSessionId, isActive, isStandaloneTab, leaf]
    );

    const handleActivate = useCallback(
      (e?: React.PointerEvent) => {
        if (isCloseTarget(e) || chatMainSurface !== 'chat') return;
        const tabId = readActiveTabId(leaf);
        if (tabId) {
          sessionShell().activateTab(leaf.id, tabId);
        } else {
          getCompositionRoot().shell.focusLeaf(leaf.id);
        }
      },
      [leaf, chatMainSurface]
    );

    /**
     * 几何由 layoutEffect 写 DOM，不用 React style prop。
     * live resize（body.tree-resizing）期间 useTreeResize 直接刷 leaf 几何；
     * 若此处用 style={}，任意 re-render 会把两侧面板拽回 store 旧 rect，
     * 表现为「拖 sash 时右侧不跟手」。
     */
    useLayoutEffect(() => {
      const el = leafElRef.current;
      if (!el || document.body.classList.contains('tree-resizing')) return;
      el.style.top = `${rect.y * 100}%`;
      el.style.left = `${rect.x * 100}%`;
      el.style.width = `${rect.width * 100}%`;
      el.style.height = `${rect.height * 100}%`;
    }, [rect.x, rect.y, rect.width, rect.height]);

    useLayoutEffect(() => {
      const el = leafBodyRef.current;
      if (!el || !dockOpen) return;
      const w = el.clientWidth;
      if (w <= 0) return;
      const px = Math.max(200, Math.min(w * 0.7, (dock.widthRatio || 0.5) * w));
      el.style.setProperty('--leaf-dock-width', `${px}px`);
    }, [dockOpen, dock.widthRatio]);

    const handleOpenTool = useCallback(
      (panelId: string) => {
        openToolInLeaf(leaf.id, panelId);
      },
      [leaf.id]
    );

    const handleCommitDockRatio = useCallback(
      (ratio: number) => {
        updateLeafDock(leaf.id, { widthRatio: ratio });
      },
      [leaf.id]
    );

    const handleToggleDock = useCallback(() => {
      if (!isChatSurface || isStandaloneTab) return;
      if (dockOpen) {
        updateLeafDock(leaf.id, { collapsed: true });
        return;
      }
      updateLeafDock(leaf.id, {
        collapsed: false,
      });
    }, [dockOpen, isChatSurface, isStandaloneTab, leaf.id]);

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const mainViewId = tabResolution.viewId;
    const mainResolved = viewRegistry.resolveView(mainViewId);

    const mainParams = useMemo(() => {
      if (!mainResolved.params && !tabResolution.params) return undefined;
      return { ...mainResolved.params, ...tabResolution.params };
    }, [mainResolved.params, tabResolution.params]);

    const mainCtx: ViewRenderContext = useMemo(
      () => ({
        panelId: mainViewId,
        leafId: leaf.id,
        sessionId: tabResolution.sessionId ?? sessionForPanel ?? undefined,
        isActive,
        openView: handleOpenTool,
        params: mainParams,
      }),
      [
        mainViewId,
        leaf.id,
        tabResolution.sessionId,
        sessionForPanel,
        isActive,
        handleOpenTool,
        mainParams,
      ]
    );

    const activeDockViewId = useMemo(() => {
      if (!dock.tree) return null;
      const activeLeafId = dock.tree.activeDockLeafId;
      if (!activeLeafId) return null;
      const leafNode = findSpatialNode(dock.tree.root, activeLeafId);
      if (!leafNode || !('tabs' in leafNode)) return null;
      const dLeaf = leafNode as DockLeaf;
      const tab = dLeaf.tabs.find((t) => t.tabId === dLeaf.activeTabId);
      return tab?.viewId ?? null;
    }, [dock.tree]);

    const edges = useMemo(() => computePaneEdges(rect), [rect]);
    const tabCount = readLeafTabs(leaf).length;

    return (
      <div
        ref={leafElRef}
        className={styles.leaf}
        data-leaf-id={leaf.id}
        data-panel-id="chat"
        data-tab-count={tabCount}
        data-session-id={effectiveSessionId || undefined}
        data-active={isActive ? 'true' : 'false'}
        data-dragging-source={isDragSource ? 'true' : 'false'}
        data-has-strip="true"
        data-dock-open={dockOpen ? 'true' : 'false'}
        data-top-row={edges.isTopRow ? 'true' : undefined}
        data-left-edge={edges.isLeftEdge ? 'true' : undefined}
        data-right-edge={edges.isRightEdge ? 'true' : undefined}
        data-bottom-row={edges.isBottomRow ? 'true' : undefined}
        onPointerDownCapture={handleCaptureActivate}
        onFocusCapture={handleCaptureActivate}
        onPointerDown={handleActivate}
        role="region"
        aria-label={`${viewRegistry.getTitle(mainViewId, mainCtx)} 面板`}
      >
        <LeafScopeProvider
          leafId={leaf.id}
          sessionId={effectiveSessionId}
          isActive={isActive}
          leafRootRef={leafElRef}
          openTool={handleOpenTool}
        >
          <PaneHeader
            leaf={leaf}
            isActive={isActive}
            isChat
            isTopRow={edges.isTopRow}
          />
          <div
            ref={leafBodyRef}
            className={styles.leafBody}
            data-dock-open={dockOpen ? 'true' : 'false'}
          >
            <div className={styles.leafChatColumn}>
              {isChatSurface &&
                !isLeafDraft &&
                !isMaximized &&
                mainViewId === 'chat' && (
                  <UnitChromeActions
                    activeSessionId={sessionForPanel}
                    dockOpen={dockOpen}
                    dockPanelId={activeDockViewId}
                    onOpenPreview={() => handleOpenTool('preview')}
                    onOpenFiles={() => handleOpenTool('files')}
                  />
                )}
              <AppErrorBoundary compact title={`面板 [${mainViewId}] 渲染异常`}>
                <Suspense
                  fallback={<div className={styles.emptyState}>加载中…</div>}
                >
                  {mainResolved.definition ? (
                    <SlotOutlet
                      slotKey="workspace.leaf.panel"
                      context={mainCtx}
                      entryKey={mainResolved.definition.id}
                      fallback={
                        <div className={styles.emptyState}>
                          未知面板类型：{mainViewId}
                        </div>
                      }
                    />
                  ) : (
                    <div className={styles.emptyState}>
                      未知面板类型：{mainViewId}
                    </div>
                  )}
                </Suspense>
              </AppErrorBoundary>
            </div>
            {dockOpen ? (
              <>
                {!isMaximized && (
                  <LeafDockResizer
                    leafBodyRef={leafBodyRef}
                    widthRatio={dock.widthRatio || 0.5}
                    onCommitRatio={handleCommitDockRatio}
                  />
                )}
                <div
                  className={`${styles.leafDockDrawer} ${
                    isMaximized ? styles.maximized : ''
                  } chat-side-panel`}
                  data-drawer-strip="true"
                  data-leaf-dock-drawer="true"
                  data-maximized={isMaximized ? 'true' : 'false'}
                >
                  <DockSplitWorkspace
                    leafId={leaf.id}
                    sessionId={sessionForPanel}
                    dock={dock}
                    isMaximized={isMaximized}
                    onToggleMaximize={() => setIsMaximized((prev) => !prev)}
                  />
                </div>
              </>
            ) : null}
          </div>
          {isChatSurface && !isLeafDraft && !isStandaloneTab && (
            <Button
              type="button"
              variant="ghost"
              className={`${styles.topSidePanelBtn} top-action-btn top-side-panel-btn`}
              data-testid="top-quick-dock-btn"
              data-active={dockOpen ? 'true' : 'false'}
              aria-label={dockOpen ? '收起右侧工具栏' : '展开右侧工具栏'}
              onClick={handleToggleDock}
            >
              <AppIcon name="sidebar-right" size={16} aria-hidden />
            </Button>
          )}
        </LeafScopeProvider>
      </div>
    );
  },
  (prev, next) =>
    leafPropsEqual(prev.leaf, next.leaf) &&
    rectPropsEqual(prev.rect, next.rect) &&
    prev.isActive === next.isActive &&
    prev.isDragSource === next.isDragSource
);
TreeLeafPanel.displayName = 'TreeLeafPanel';
