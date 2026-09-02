/**
 * 二叉树叶子面板 — 声明式微内核叶子容器。
 *
 * 架构契约：
 * - 纯几何叶子空间容器，100% 剥离 switch(panelId) 静态硬编码；
 * - chat 叶：PaneHeader + 叶内抽屉头 LeafToolTabStrip；
 * - 仍禁止复活 ChatHeader / UnitSessionTabStrip / GlobalSessionTabBar。
 * 未提交的新对话不占标签；画面会话 = 本叶选中 tab，否则为本叶草稿哨兵。
 */

import React, {
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { LayoutLeaf } from '../../store/types';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { UnitChromeActions } from '../chat-card/UnitChromeActions';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import { LeafDockResizer } from './LeafDockResizer';
import { PaneHeader } from './PaneHeader';
import { computePaneEdges } from './paneEdgeGeometry';
import styles from './BinaryTreeWorkspace.module.css';
import {
  openToolInLeaf,
  updateLeafDock,
  selectTabModeEnabled,
  useLayoutStore,
  getCompositionRoot,
} from '../../store/storeAccess';
import { mintDraftSessionId } from '../../store/draftSession';
import {
  viewRegistry,
  SlotOutlet,
  type ViewRenderContext,
} from '../../services/view-registry';

interface TreeLeafPanelProps {
  leaf: LayoutLeaf;
  /** leaf 的渲染 rect（百分比，0-1） */
  rect: { x: number; y: number; width: number; height: number };
  /** 是否为激活 leaf */
  isActive: boolean;
  /** 是否为拖拽源（旧拖拽兼容，缺省 false） */
  isDragSource?: boolean;
  /** 当前是否多 chat 分屏（>1 chat leaf）；条带不再依赖此旗标 */
  isMultiChat?: boolean;
}

interface LeafSessionTab {
  tabId: string;
  sessionId: string;
  title?: string;
  dock?: {
    collapsed: boolean;
    openPanelIds: string[];
    activePanelId: string | null;
    widthRatio: number;
  };
}

type SessionShellCommands = {
  activateTab: (leafId: string, tabId: string) => void;
};

function sessionShell(): SessionShellCommands {
  return getCompositionRoot().shell as unknown as SessionShellCommands;
}

function readLeafTabs(leaf: LayoutLeaf): LeafSessionTab[] {
  const raw = leaf.tabs as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is LeafSessionTab =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as LeafSessionTab).tabId === 'string'
  );
}

function readActiveTabId(leaf: LayoutLeaf): string {
  const id = (leaf as LayoutLeaf & { activeTabId?: string }).activeTabId;
  return typeof id === 'string' ? id : '';
}

const COLLAPSED_DOCK = {
  collapsed: true,
  openPanelIds: [] as string[],
  activePanelId: null as string | null,
  widthRatio: 0.5,
};

function readActiveTab(leaf: LayoutLeaf): LeafSessionTab | undefined {
  const tabs = readLeafTabs(leaf);
  if (tabs.length === 0) return undefined;

  const activeTabId = readActiveTabId(leaf);
  if (activeTabId) {
    const match = tabs.find((t) => t.tabId === activeTabId);
    if (match) return match;
  }

  // 核心自愈防线：若拥有会话 Tab 但 activeTabId 为空或失效，
  // 绝不能返回 undefined 沦落为草稿空屏！纯函数级默认收敛至首个真实 Tab！
  return tabs[0];
}

function rectPropsEqual(
  a: TreeLeafPanelProps['rect'],
  b: TreeLeafPanelProps['rect']
): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function dockPropsEqual(
  a: LeafSessionTab['dock'] | undefined,
  b: LeafSessionTab['dock'] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.collapsed !== b.collapsed) return false;
  if (a.activePanelId !== b.activePanelId) return false;
  if (a.widthRatio !== b.widthRatio) return false;
  if (a.openPanelIds.length !== b.openPanelIds.length) return false;
  for (let i = 0; i < a.openPanelIds.length; i++) {
    if (a.openPanelIds[i] !== b.openPanelIds[i]) return false;
  }
  return true;
}

function leafPropsEqual(a: LayoutLeaf, b: LayoutLeaf): boolean {
  if (a === b) return true;
  if (a.id !== b.id) return false;
  if (readActiveTabId(a) !== readActiveTabId(b)) return false;
  if (!dockPropsEqual(a.dock, b.dock)) return false;
  const at = readLeafTabs(a);
  const bt = readLeafTabs(b);
  if (at.length !== bt.length) return false;
  for (let i = 0; i < at.length; i++) {
    const x = at[i]!;
    const y = bt[i]!;
    if (x.tabId !== y.tabId) return false;
    if (x.sessionId !== y.sessionId) return false;
    if (!dockPropsEqual(x.dock, y.dock)) return false;
  }
  return true;
}

export const TreeLeafPanel: React.FC<TreeLeafPanelProps> = React.memo(
  ({ leaf, rect, isActive, isDragSource }) => {
    const leafElRef = useRef<HTMLDivElement>(null);
    const leafBodyRef = useRef<HTMLDivElement>(null);
    const tabModeEnabled = useLayoutStore(selectTabModeEnabled);

    const activeTab = readActiveTab(leaf);
    const sessionForPanel =
      activeTab?.sessionId || mintDraftSessionId(leaf.id);
    const dock = activeTab?.dock ?? leaf.dock ?? COLLAPSED_DOCK;
    const dockOpen =
      dock.collapsed !== true && Boolean(dock.activePanelId);
    const sessionTabId = activeTab?.tabId;

    const handleActivate = useCallback(
      (e?: React.PointerEvent) => {
        if (e && e.target && 'closest' in (e.target as HTMLElement)) {
          const target = e.target as HTMLElement;
          if (
            target.closest(
              'button, input, textarea, select, a, summary, [role="button"], [role="menuitem"], [role="menu"], [role="combobox"], [role="listbox"], [role="option"], [role="tab"], [role="switch"], [role="dialog"], [role="toolbar"], [contenteditable="true"], [data-interactive], [data-radix-popper-content-wrapper], [data-interactive="true"]'
            )
          ) {
            return;
          }
        }
        const tabId = readActiveTabId(leaf);
        if (tabId) {
          sessionShell().activateTab(leaf.id, tabId);
        } else {
          getCompositionRoot().shell.focusLeaf(leaf.id);
        }
      },
      [leaf]
    );

    /**
     * 几何由 layoutEffect 写 DOM，不用 React style prop。
     * live resize（body.tree-resizing）期间 useTreeResize 直接刷 leaf 几何；
     * 若此处用 style={}，任意 re-render 会把两侧面板拽回 store 旧 rect，
     * 表现为「拖 sash 时右侧不跟手」。
     */
    useLayoutEffect(() => {
      const el = leafElRef.current;
      if (!el) return;
      if (document.body.classList.contains('tree-resizing')) return;
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
      const px = Math.max(
        200,
        Math.min(w * 0.7, (dock.widthRatio || 0.5) * w)
      );
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

    const handleSelectToolTab = useCallback(
      (panelId: string) => {
        updateLeafDock(leaf.id, { activePanelId: panelId });
      },
      [leaf.id]
    );

    const handleCloseToolTab = useCallback(
      (panelId: string) => {
        const nextIds = dock.openPanelIds.filter((id) => id !== panelId);
        if (nextIds.length === 0) {
          updateLeafDock(leaf.id, {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
          });
          return;
        }
        const nextActive =
          dock.activePanelId === panelId
            ? nextIds[nextIds.length - 1] ?? null
            : dock.activePanelId;
        updateLeafDock(leaf.id, {
          openPanelIds: nextIds,
          activePanelId: nextActive,
        });
      },
      [dock.activePanelId, dock.openPanelIds, leaf.id]
    );

    const handleToggleDock = useCallback(() => {
      if (dockOpen) {
        updateLeafDock(leaf.id, { collapsed: true });
        return;
      }
      updateLeafDock(leaf.id, {
        collapsed: false,
        activePanelId: dock.activePanelId || 'overview',
        openPanelIds:
          dock.openPanelIds.length > 0 ? dock.openPanelIds : ['overview'],
      });
    }, [dock.activePanelId, dock.openPanelIds, dockOpen, leaf.id]);

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const chatResolved = viewRegistry.resolveView('chat');
    const toolPanelId = dock.activePanelId || 'overview';
    const toolResolved = viewRegistry.resolveView(toolPanelId);

    const chatCtx: ViewRenderContext = useMemo(
      () => ({
        panelId: 'chat',
        leafId: leaf.id,
        sessionId: sessionForPanel ?? undefined,
        isActive,
        openView: handleOpenTool,
        params: chatResolved.params,
      }),
      [
        leaf.id,
        sessionForPanel,
        isActive,
        handleOpenTool,
        chatResolved.params,
      ]
    );

    const toolCtx: ViewRenderContext = useMemo(
      () => ({
        panelId: toolPanelId,
        leafId: leaf.id,
        sessionId: sessionForPanel ?? undefined,
        isActive,
        openView: handleOpenTool,
        params: toolResolved.params,
      }),
      [
        toolPanelId,
        leaf.id,
        sessionForPanel,
        isActive,
        handleOpenTool,
        toolResolved.params,
      ]
    );

    const stackedPanelIds = tabModeEnabled
      ? [toolPanelId]
      : dock.openPanelIds.length > 0
        ? dock.openPanelIds
        : [toolPanelId];

    const edges = useMemo(() => computePaneEdges(rect), [rect]);
    const tabCount = readLeafTabs(leaf).length;

    const renderToolOutlet = (panelId: string) => {
      const resolved = viewRegistry.resolveView(panelId);
      const ctx: ViewRenderContext = {
        ...toolCtx,
        panelId,
        params: resolved.params,
      };
      const note =
        panelId === 'note' || panelId.startsWith('note:');
      if (!resolved.definition) {
        return (
          <div className={styles.emptyState}>
            未知面板类型：{panelId}
            {note ? '（笔记扩展未激活）' : null}
          </div>
        );
      }
      return (
        <SlotOutlet
          slotKey="workspace.leaf.panel"
          context={ctx}
          entryKey={resolved.definition.id}
          fallback={
            <div className={styles.emptyState}>
              未知面板类型：{panelId}
            </div>
          }
        />
      );
    };

    return (
      <div
        ref={leafElRef}
        className={styles.leaf}
        data-leaf-id={leaf.id}
        data-panel-id="chat"
        data-tab-count={tabCount}
        data-session-id={sessionForPanel || undefined}
        data-active={isActive ? 'true' : 'false'}
        data-dragging-source={isDragSource ? 'true' : 'false'}
        data-has-strip="true"
        data-dock-open={dockOpen ? 'true' : 'false'}
        data-top-row={edges.isTopRow ? 'true' : undefined}
        data-left-edge={edges.isLeftEdge ? 'true' : undefined}
        data-right-edge={edges.isRightEdge ? 'true' : undefined}
        data-bottom-row={edges.isBottomRow ? 'true' : undefined}
        onPointerDown={handleActivate}
        role="region"
        aria-label={`${viewRegistry.getTitle('chat', chatCtx)} 面板`}
      >
        <PaneHeader leaf={leaf} isActive={isActive} isChat />
        <div
          ref={leafBodyRef}
          className={styles.leafBody}
          data-dock-open={dockOpen ? 'true' : 'false'}
        >
          <div className={styles.leafChatColumn}>
            <UnitChromeActions
              activeSessionId={sessionForPanel}
              dockOpen={dockOpen}
              dockPanelId={dock.activePanelId}
              onOpenPreview={() => handleOpenTool('preview')}
              onOpenFiles={() => handleOpenTool('files')}
            />
            <AppErrorBoundary compact title="面板 [chat] 渲染异常">
              <Suspense
                fallback={<div className={styles.emptyState}>加载中…</div>}
              >
                {chatResolved.definition ? (
                  <SlotOutlet
                    slotKey="workspace.leaf.panel"
                    context={chatCtx}
                    entryKey={chatResolved.definition.id}
                    fallback={
                      <div className={styles.emptyState}>
                        未知面板类型：chat
                      </div>
                    }
                  />
                ) : (
                  <div className={styles.emptyState}>未知面板类型：chat</div>
                )}
              </Suspense>
            </AppErrorBoundary>
          </div>
          {dockOpen ? (
            <>
              <LeafDockResizer
                leafBodyRef={leafBodyRef}
                widthRatio={dock.widthRatio || 0.5}
                onCommitRatio={handleCommitDockRatio}
              />
              <div
                className={`${styles.leafDockDrawer} chat-side-panel`}
                data-drawer-strip="true"
                data-leaf-dock-drawer="true"
              >
                <LeafToolTabStrip
                  leafId={leaf.id}
                  sessionId={sessionForPanel}
                  sessionTabId={sessionTabId}
                  tabs={dock.openPanelIds}
                  activeTab={dock.activePanelId ?? ''}
                  onSelectTab={handleSelectToolTab}
                  onCloseTab={handleCloseToolTab}
                  onAddTab={handleOpenTool}
                />
                <AppErrorBoundary
                  compact
                  title={`面板 [${toolPanelId}] 渲染异常`}
                >
                  <Suspense
                    fallback={
                      <div className={styles.emptyState}>加载中…</div>
                    }
                  >
                    {tabModeEnabled
                      ? renderToolOutlet(toolPanelId)
                      : stackedPanelIds.map((pid) => (
                          <React.Fragment key={pid}>
                            {renderToolOutlet(pid)}
                          </React.Fragment>
                        ))}
                  </Suspense>
                </AppErrorBoundary>
              </div>
            </>
          ) : null}
        </div>
        <button
          type="button"
          className={`${styles.topSidePanelBtn} top-action-btn top-side-panel-btn`}
          data-testid="top-quick-dock-btn"
          data-active={dockOpen ? 'true' : 'false'}
          aria-label={dockOpen ? '收起右侧工具栏' : '展开右侧工具栏'}
          onClick={handleToggleDock}
        >
          <IconSidebarRight size={14} />
        </button>
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
