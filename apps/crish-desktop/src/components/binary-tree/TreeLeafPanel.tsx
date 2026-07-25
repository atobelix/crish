/**
 * 二叉树叶子面板 — 渲染单个 leaf（含 tab 条与面板内容）。
 *
 * 与旧 CardPanel 的区别：
 * 1. 以 leafId 为唯一索引，不依赖 colIdx/groupIdx
 * 2. tab 拖拽走 useTreeDrag.startDragTab（与 leaf 拖拽统一）
 * 3. 面板内容（ChatCard/DiffCard 等）按 activeTab 渲染，懒加载
 *
 * 拖拽交互：
 * - tab 元素 onPointerDown → startDragTab
 * - leaf 标题区 onPointerDown → startDragLeaf（拖整个 leaf）
 * - leaf 激活（onPointerDownCapture）→ setActiveLeaf
 */

import React, { lazy, Suspense } from 'react';
import { X, GripVertical } from 'lucide-react';
import { useLayoutTreeStore } from '../../store/layout-tree';
import type { LayoutLeaf } from '../../store/layout-tree';
import { getPanelTitle } from '../../store/layoutHelpers';
import { useTreeDrag } from '../../hooks/useTreeDrag';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { AppErrorBoundary } from '../AppErrorBoundary';
import styles from './BinaryTreeWorkspace.module.css';

// ── 面板内容懒加载（与 CardPanelLayout 对齐） ──────────────────────

const ChatCard = lazy(() =>
  import('../ChatCard').then((m) => ({ default: m.ChatCard }))
);
const TerminalCard = lazy(() =>
  import('../TerminalCard').then((m) => ({ default: m.TerminalCard }))
);
const PreviewCard = lazy(() =>
  import('../PreviewCard').then((m) => ({ default: m.PreviewCard }))
);
const OverviewCard = lazy(() =>
  import('../OverviewCard').then((m) => ({ default: m.OverviewCard }))
);
const FilesCard = lazy(() =>
  import('../FilesCard').then((m) => ({ default: m.FilesCard }))
);
const DiffCard = lazy(() =>
  import('../DiffCard').then((m) => ({ default: m.DiffCard }))
);
const RuntimePanel = lazy(() =>
  import('../RuntimePanel').then((m) => ({ default: m.RuntimePanel }))
);
const AgentCard = lazy(() =>
  import('../AgentCard').then((m) => ({ default: m.AgentCard }))
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
  /** 拖拽控制器（由父组件注入，避免每个 leaf 自建 hook） */
  dragController: ReturnType<typeof useTreeDrag>;
  /** Toast 回调（与 app 全局 ShowToastFn 对齐） */
  onShowToast: ShowToastFn;
}

// ── 组件实现 ─────────────────────────────────────────────────────────

export const TreeLeafPanel: React.FC<TreeLeafPanelProps> = React.memo(
  ({ leaf, rect, isActive, isDragSource, dragController, onShowToast }) => {
    const setActiveTab = useLayoutTreeStore((s) => s.setActiveTab);
    const removeTabFromLeaf = useLayoutTreeStore((s) => s.removeTabFromLeaf);
    const setActiveLeaf = useLayoutTreeStore((s) => s.setActiveLeaf);

    const { startDragLeaf, startDragTab } = dragController;

    const handleTabClick = React.useCallback(
      (tabId: string) => {
        setActiveTab(leaf.id, tabId);
      },
      [leaf.id, setActiveTab]
    );

    const handleTabClose = React.useCallback(
      (tabId: string) => {
        // chat / overview 不可关闭
        if (tabId === 'chat' || tabId === 'overview') return;
        removeTabFromLeaf(leaf.id, tabId);
      },
      [leaf.id, removeTabFromLeaf]
    );

    const handleTabPointerDown = React.useCallback(
      (tabId: string, e: React.PointerEvent) => {
        // 中键关闭
        if (e.button === 1) {
          e.preventDefault();
          handleTabClose(tabId);
          return;
        }
        startDragTab(leaf.id, tabId, leaf.panelId, e);
      },
      [leaf.id, leaf.panelId, startDragTab, handleTabClose]
    );

    const handleLeafHeaderPointerDown = React.useCallback(
      (e: React.PointerEvent) => {
        // 仅在 grip 区域或标题区启动 leaf 拖拽
        startDragLeaf(leaf.id, leaf.panelId, e);
      },
      [leaf.id, leaf.panelId, startDragLeaf]
    );

    const handleActivate = React.useCallback(() => {
      if (!isActive) setActiveLeaf(leaf.id);
    }, [isActive, leaf.id, setActiveLeaf]);

    const activeTab = leaf.activeTab;
    const activeTitle = getPanelTitle(activeTab);
    const leafStyle: React.CSSProperties = {
      top: `${rect.y * 100}%`,
      left: `${rect.x * 100}%`,
      width: `${rect.width * 100}%`,
      height: `${rect.height * 100}%`,
    };

    return (
      <div
        className={styles.leaf}
        data-leaf-id={leaf.id}
        data-panel-id={leaf.panelId}
        data-active={isActive ? 'true' : 'false'}
        data-dragging-source={isDragSource ? 'true' : 'false'}
        style={leafStyle}
        onPointerDownCapture={handleActivate}
        role="region"
        aria-label={`${activeTitle} 面板`}
      >
        {/* 控制条：grip + 标题 + 关闭 */}
        <div className={styles.controlBar}>
          <span
            className={styles.controlBtn}
            role="button"
            aria-label="拖动此面板"
            onPointerDown={handleLeafHeaderPointerDown}
            style={{ cursor: 'grab' }}
          >
            <GripVertical size={14} aria-hidden />
          </span>
          <span className={styles.leafTitle} aria-hidden>
            {activeTitle}
          </span>
          <span className={styles.controlSpacer} />
          {leaf.tabs.length > 1 && (
            <button
              type="button"
              className={styles.controlBtn}
              aria-label={`关闭 ${activeTitle} 面板`}
              onClick={() => handleTabClose(activeTab)}
              disabled={activeTab === 'chat' || activeTab === 'overview'}
            >
              <X size={12} aria-hidden />
            </button>
          )}
        </div>

        {/* Tab 条（多 tab 时显示） */}
        {leaf.tabs.length > 1 && (
          <div className={styles.tabBar} role="tablist">
            {leaf.tabs.map((tabId) => {
              const isActiveTab = tabId === activeTab;
              const title = getPanelTitle(tabId);
              return (
                <div
                  key={tabId}
                  className={styles.tab}
                  data-active={isActiveTab ? 'true' : 'false'}
                  role="tab"
                  aria-selected={isActiveTab}
                  tabIndex={isActiveTab ? 0 : -1}
                  onClick={() => handleTabClick(tabId)}
                  onPointerDown={(e) => handleTabPointerDown(tabId, e)}
                >
                  <span>{title}</span>
                  {tabId !== 'chat' && tabId !== 'overview' && (
                    <span
                      className={styles.tabClose}
                      role="button"
                      aria-label={`关闭 ${title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTabClose(tabId);
                      }}
                    >
                      <X size={10} aria-hidden />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 面板内容（懒加载 + 错误边界） */}
        <div className={styles.leafBody}>
          <AppErrorBoundary compact>
            <Suspense
              fallback={<div className={styles.emptyState}>加载中…</div>}
            >
              <LeafBody panelId={activeTab} onShowToast={onShowToast} />
            </Suspense>
          </AppErrorBoundary>
        </div>
      </div>
    );
  }
);
TreeLeafPanel.displayName = 'TreeLeafPanel';

// ── 面板内容路由 ────────────────────────────────────────────────────

interface LeafBodyProps {
  panelId: string;
  onShowToast: ShowToastFn;
}

const LeafBody: React.FC<LeafBodyProps> = React.memo(
  ({ panelId, onShowToast }) => {
    switch (panelId) {
      case 'chat':
        return (
          <ChatCard
            wsId="default"
            colIdx={0}
            groupIdx={0}
            handleGlobalTabClick={() => {}}
            onShowToast={onShowToast}
          />
        );
      case 'terminal':
        return <TerminalCard />;
      case 'preview':
        return <PreviewCard wsId="default" onShowToast={onShowToast} />;
      case 'overview':
        return <OverviewCard wsId="default" onOpenPanel={() => {}} />;
      case 'files':
        return <FilesCard />;
      case 'diff':
        return <DiffCard onShowToast={onShowToast} />;
      case 'runtime':
        return <RuntimePanel wsId="default" onShowToast={onShowToast} />;
      case 'agent':
        return <AgentCard />;
      default:
        return <div className={styles.emptyState}>未知面板类型：{panelId}</div>;
    }
  }
);
LeafBody.displayName = 'LeafBody';
