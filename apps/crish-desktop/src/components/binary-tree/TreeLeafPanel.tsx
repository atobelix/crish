/**
 * 二叉树叶子面板 — 渲染单个 leaf 的面板内容。
 *
 * chrome 行契约：
 * - 单 unit：AppTopBar 全局会话标签；leaf 内 ChatHeader / LeafToolTabStrip
 * - 多 unit：每个 chat leaf 顶挂 UnitSessionTabStrip（per-unit 标签，替代全局条）；
 *   工具 leaf 顶挂 LeafToolTabStrip（基于 leaf.tabs，替代 rightDock 模型）
 *
 * 功能区 leaf 必须带所属 session 的 sessionId（owner），与对话 unit 绑定。
 */

import React, { lazy, Suspense, useCallback, useLayoutEffect, useRef } from 'react';
import { useLayoutTreeStore, isChatDomain } from '../../api/store-access/componentAccess';
import type { LayoutLeaf } from '../../store/layout-tree';
import { getPanelTitle } from '../../api/store-access/componentAccess';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { UnitSessionTabStrip } from './UnitSessionTabStrip';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import { useSessionTabDrag } from '../shell/SessionTabDragContext';
import styles from './BinaryTreeWorkspace.module.css';
import {
  useWorkspaceShellStore,
  openToolInSession,
} from '../../api/store-access/componentAccess';
import {
  selectActiveSessionId,
  useSessionField,
} from '../../api/store-access/componentAccess';
import { isPendingDraft } from '../../api/store-access/componentAccess';

// ── 面板内容懒加载 ──────────────────────────────────────────────────

const ChatCard = lazy(() =>
  import('../chat-card/ChatCard').then((m) => ({ default: m.ChatCard }))
);
const TerminalCard = lazy(() =>
  import('../workspace/TerminalCard').then((m) => ({ default: m.TerminalCard }))
);
const PreviewCard = lazy(() =>
  import('../workspace/PreviewCard').then((m) => ({ default: m.PreviewCard }))
);
const OverviewCard = lazy(() =>
  import('../overview/OverviewCard').then((m) => ({ default: m.OverviewCard }))
);
const FilesCard = lazy(() =>
  import('../files/FilesCard').then((m) => ({ default: m.FilesCard }))
);
const DiffCard = lazy(() =>
  import('../diff/DiffCard').then((m) => ({ default: m.DiffCard }))
);
const FileViewerCard = lazy(() =>
  import('../files/FileViewerCard').then((m) => ({ default: m.FileViewerCard }))
);
const RuntimePanel = lazy(() =>
  import('../workspace/RuntimePanel').then((m) => ({ default: m.RuntimePanel }))
);
const AgentCard = lazy(() =>
  import('../agent-card/AgentCard').then((m) => ({ default: m.AgentCard }))
);

// ── Props ───────────────────────────────────────────────────────────

interface TreeLeafPanelProps {
  leaf: LayoutLeaf;
  /** leaf 的渲染 rect（百分比，0-1） */
  rect: { x: number; y: number; width: number; height: number };
  /** 是否为激活 leaf */
  isActive: boolean;
  /** 是否为拖拽源 */
  isDragSource: boolean;
  /** Toast 回调 */
  onShowToast: ShowToastFn;
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
  ({ leaf, rect, isActive, isDragSource, onShowToast, isMultiChat = false }) => {
    const setActiveLeaf = useLayoutTreeStore((s) => s.setActiveLeaf);
    const leafElRef = useRef<HTMLDivElement>(null);
    const { startSessionDrag } = useSessionTabDrag();

    const handleActivate = useCallback(() => {
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
    }, [isActive, leaf.id, leaf.sessionId, setActiveLeaf]);

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

    const isChat = isChatDomain(leaf.panelId);

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
        onPointerDownCapture={handleActivate}
        role="region"
        aria-label={`${getPanelTitle(leaf.activeTab)} 面板`}
      >
        {/* 多 unit chat leaf：per-unit 会话标签栏（第 1 行） */}
        {isChat && isMultiChat ? (
          <UnitSessionTabStrip
            leafId={leaf.id}
            leafSessionId={leaf.sessionId}
            startSessionDrag={startSessionDrag}
          />
        ) : null}

        {/* 工具 leaf：基于 leaf.tabs 的独立标签栏 */}
        {!isChat ? <LeafToolTabStrip leaf={leaf} /> : null}

        <div className={styles.leafBody}>
          <AppErrorBoundary compact>
            <Suspense fallback={<div className={styles.emptyState}>加载中…</div>}>
              <LeafBody
                panelId={leaf.activeTab}
                leafId={leaf.id}
                leafSessionId={leaf.sessionId}
                isActiveLeaf={isActive}
                onShowToast={onShowToast}
              />
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
    prev.onShowToast === next.onShowToast &&
    prev.isMultiChat === next.isMultiChat
);
TreeLeafPanel.displayName = 'TreeLeafPanel';

// ── 面板内容路由 ────────────────────────────────────────────────────

interface LeafBodyProps {
  panelId: string;
  /** 当前 leaf id（布局标识；工具打开走 leafSessionId） */
  leafId: string;
  /** 多 chat 分屏：leaf 绑定的 sessionId → openToolInSession 作用域 */
  leafSessionId?: string;
  isActiveLeaf: boolean;
  onShowToast: ShowToastFn;
}

function LeafBody({
  panelId,
  leafSessionId,
  isActiveLeaf,
  onShowToast,
}: LeafBodyProps) {
  const activeSessionId = useSessionField(selectActiveSessionId);
  // 新对话草稿态：活动 pane 必须跟 PENDING_DRAFT（空白欢迎面），不能被 leaf.sessionId 钉死
  // 非活动分屏 pane 仍显示自己的 leaf 会话
  const inDraft = isPendingDraft(activeSessionId || '');
  const sessionForPanel =
    inDraft && isActiveLeaf
      ? activeSessionId
      : leafSessionId || activeSessionId;

  if (panelId.startsWith('file-viewer:')) {
    const filePath = panelId.substring('file-viewer:'.length);
    return <FileViewerCard filePath={filePath} onShowToast={onShowToast} />;
  }

  switch (panelId) {
    case 'chat':
      return (
        <ChatCard
          wsId="default"
          colIdx={0}
          groupIdx={0}
          handleGlobalTabClick={() => {}}
          onShowToast={onShowToast}
          // draft 时传 PENDING_DRAFT；否则优先 leaf 绑定
          sessionId={sessionForPanel ?? undefined}
        />
      );
    case 'terminal':
      return <TerminalCard sessionId={sessionForPanel ?? undefined} />;
    case 'preview':
      return <PreviewCard wsId="default" onShowToast={onShowToast} />;
    case 'overview':
      return (
        <OverviewCard
          wsId="default"
          onOpenPanel={(pid: string) => {
            if (sessionForPanel) openToolInSession(sessionForPanel, pid);
          }}
        />
      );
    case 'files':
      return <FilesCard />;
    case 'diff':
      return <DiffCard onShowToast={onShowToast} />;
    case 'runtime':
      return <RuntimePanel wsId="default" onShowToast={onShowToast} />;
    case 'agent':
      return <AgentCard />;
    default:
      return (
        <div className={styles.emptyState}>未知面板类型：{panelId}</div>
      );
  }
}
