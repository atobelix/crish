/**
 * 二叉树叶子面板 — 声明式微内核叶子容器。
 *
 * 架构契约：
 * - 纯几何叶子空间容器，100% 剥离 switch(panelId) 静态硬编码；
 * - 面板内容全量改由 SlotOutlet('workspace.leaf.panel') + ViewRegistry 动态渲染；
 * - 标题统一由 ViewRegistry 派生。
 * - chat 叶 chrome：UnitChromeActions（leafBody 上覆盖层；工具钮 + 更多/分享/坞开关，坞开不卸）。
 * - 工具叶 chrome：LeafToolTabStrip。不要复活 ChatHeader / UnitSessionTabStrip。
 */

import React, {
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useLayoutTreeStore } from '../../store/storeAccess';
import type { LayoutLeaf } from '../../store/types';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { UnitChromeActions } from '../chat-card/UnitChromeActions';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import styles from './BinaryTreeWorkspace.module.css';
import {
  useWorkspaceShellStore,
  openToolInSession,
  openToolInActiveTab,
  selectActiveSessionId,
  useSessionField,
  isPendingDraft,
} from '../../store/storeAccess';
import {
  viewRegistry,
  SlotOutlet,
  type ViewRenderContext,
} from '../../services/view-registry';

// ── Props ───────────────────────────────────────────────────────────

interface TreeLeafPanelProps {
  leaf: LayoutLeaf;
  /** leaf 的渲染 rect（百分比，0-1） */
  rect: { x: number; y: number; width: number; height: number };
  /** 是否为激活 leaf */
  isActive: boolean;
  /** 是否为拖拽源 */
  isDragSource: boolean;
  /** 当前是否多 chat 分屏（>1 chat leaf） */
  isMultiChat?: boolean;
}

function rectPropsEqual(
  a: TreeLeafPanelProps['rect'],
  b: TreeLeafPanelProps['rect']
): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function leafPropsEqual(a: LayoutLeaf, b: LayoutLeaf): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.panelId !== b.panelId ||
    a.activeTab !== b.activeTab ||
    a.sessionId !== b.sessionId
  ) {
    return false;
  }
  if (a.tabs === b.tabs) return true;
  if (a.tabs.length !== b.tabs.length) return false;
  for (let i = 0; i < a.tabs.length; i++) {
    if (a.tabs[i] !== b.tabs[i]) return false;
  }
  return true;
}

// ── 组件实现 ─────────────────────────────────────────────────────────

export const TreeLeafPanel: React.FC<TreeLeafPanelProps> = React.memo(
  ({
    leaf,
    rect,
    isActive,
    isDragSource,
    isMultiChat = false,
  }) => {
    const setActiveLeaf = useLayoutTreeStore((s) => s.setActiveLeaf);
    const leafElRef = useRef<HTMLDivElement>(null);

    const activeSessionId = useSessionField(selectActiveSessionId);
    // 新对话草稿态：活动 pane 必须跟 PENDING_DRAFT（空白欢迎面），不能被 leaf.sessionId 钉死
    // 非活动分屏 pane 仍显示自己的 leaf 会话
    const inDraft = isPendingDraft(activeSessionId || '');
    const sessionForPanel =
      inDraft && isActive
        ? activeSessionId
        : leaf.sessionId || activeSessionId;

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
        if (!isActive) setActiveLeaf(leaf.id);
        // 多 chat：点击 pane 时把 shell active 切到该 leaf 绑定的 session
        if (leaf.sessionId) {
          const shell = useWorkspaceShellStore.getState();
          const tab = shell.openTabs.find((t) => t.sessionId === leaf.sessionId);
          if (tab) {
            if (shell.activeTabId !== tab.tabId) shell.activateTab(tab.tabId);
          } else {
            shell.openOrFocusSession(leaf.sessionId);
          }
        }
      },
      [isActive, leaf.id, leaf.sessionId, setActiveLeaf]
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

    // 统一会话感知工具分发器（裁决 ARB-06：采用自由函数分发）
    const handleOpenTool = useCallback(
      (panelId: string) => {
        const targetSessionId = sessionForPanel;
        if (targetSessionId && !targetSessionId.startsWith('__pending')) {
          openToolInSession(targetSessionId, panelId);
        } else {
          openToolInActiveTab(panelId);
        }
      },
      [sessionForPanel]
    );

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const resolved = viewRegistry.resolveView(leaf.activeTab);
    const isChat = viewRegistry.isPrimary(leaf.panelId);
    const hasDefinition = Boolean(resolved.definition);
    const isNoteTab =
      leaf.activeTab === 'note' || leaf.activeTab.startsWith('note:');

    // 纯函数视图渲染上下文
    const renderCtx: ViewRenderContext = useMemo(
      () => ({
        panelId: leaf.activeTab,
        leafId: leaf.id,
        sessionId: sessionForPanel ?? undefined,
        isActive,
        openView: handleOpenTool,
        params: resolved.params,
      }),
      [
        leaf.activeTab,
        leaf.id,
        sessionForPanel,
        isActive,
        handleOpenTool,
        resolved.params,
      ]
    );

    return (
      <div
        ref={leafElRef}
        className={styles.leaf}
        data-leaf-id={leaf.id}
        data-panel-id={leaf.panelId}
        data-tab-count={leaf.tabs.length}
        data-session-id={leaf.sessionId || undefined}
        data-active={isActive ? 'true' : 'false'}
        data-dragging-source={isDragSource ? 'true' : 'false'}
        data-unit-tab-strip={isChat && isMultiChat ? 'true' : 'false'}
        onPointerDown={handleActivate}
        role="region"
        aria-label={`${viewRegistry.getTitle(leaf.activeTab, renderCtx)} 面板`}
      >
        <div className={styles.leafBody}>
          {isChat ? (
            <UnitChromeActions
              activeSessionId={sessionForPanel}
              className={styles.leafToolHeader}
            />
          ) : (
            <LeafToolTabStrip leaf={leaf} />
          )}
          <AppErrorBoundary
            compact
            title={`面板 [${leaf.activeTab}] 渲染异常`}
          >
            <Suspense
              fallback={<div className={styles.emptyState}>加载中…</div>}
            >
              {hasDefinition ? (
                <SlotOutlet
                  slotKey="workspace.leaf.panel"
                  context={renderCtx}
                  entryKey={resolved.definition?.id ?? leaf.activeTab}
                  fallback={
                    <div className={styles.emptyState}>
                      未知面板类型：{leaf.activeTab}
                    </div>
                  }
                />
              ) : (
                <div className={styles.emptyState}>
                  未知面板类型：{leaf.activeTab}
                  {isNoteTab ? '（笔记扩展未激活）' : null}
                </div>
              )}
            </Suspense>
          </AppErrorBoundary>
        </div>
      </div>
    );
  },
  (prev, next) =>
    leafPropsEqual(prev.leaf, next.leaf) &&
    rectPropsEqual(prev.rect, next.rect) &&
    prev.isActive === next.isActive &&
    prev.isDragSource === next.isDragSource &&
    prev.isMultiChat === next.isMultiChat
);
TreeLeafPanel.displayName = 'TreeLeafPanel';
