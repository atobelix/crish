/**
 * 二叉树工作区 — 拖拽式布局工作区主入口。
 *
 * 渲染流程：
 * 1. layoutTreeStore → flattenTree
 * 2. leaf chrome（真树；不要复活 ChatHeader / UnitSessionTabStrip）：
 *    - chat 叶：UnitChromeActions（leafBody 上覆盖层；工具钮 + 右侧固定钮，坞开不卸）
 *    - 工具叶：LeafToolTabStrip（基于 leaf.tabs）
 *    - 会话身份在窗口顶栏 GlobalSessionTabBar + 侧栏列表，叶内不再做第三套标题行
 * 3. sash / DropZoneOverlay / 面板 ghost
 */

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  useLayoutTreeStore,
  flattenTree,
  listChatLeaves,
  type LayoutLeaf,
  type FlatBranch,
} from '../../store/storeAccess';
import { getPanelTitle } from '../../store/storeAccess';
import { useTreeDrag } from '../../hooks/useTreeDrag';
import { useTreeResize } from '../../hooks/useTreeResize';
import { useTreePanelEvents } from '../../hooks/useTreePanelEvents';
import { useChatPanelSync } from '../../hooks/useChatPanelSync';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { TreeLeafPanel } from './TreeLeafPanel';
import { TreeResizeSash, flatBranchEqual } from './TreeResizeSash';
import { DropZoneOverlay } from './DropZoneOverlay';
import styles from './BinaryTreeWorkspace.module.css';

// ── Props ───────────────────────────────────────────────────────────

export interface BinaryTreeWorkspaceProps {
  className?: string;
}

// ── 稳定 leaf / branch 身份 ─────────────────────────────────────────
//
// flattenTree 每次产出新 FlatPanel / FlatBranch / rect 字面量；map 内再
// new LayoutLeaf 会使 TreeLeafPanel / TreeResizeSash 的 React.memo 浅比较
// 永远失败（sibling resize commit、activeLeaf 切换等父级 re-render 都会
// 重绘所有 leaf/sash）。按 id 复用引用：内容未变则保持同一对象。

type FlatPanelItem = ReturnType<typeof flattenTree>['leaves'][number];
type LeafRect = FlatPanelItem['rect'];

interface StableLeafEntry {
  leaf: LayoutLeaf;
  rect: LeafRect;
}

function tabsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function rectEqual(a: LeafRect, b: LeafRect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function toLayoutLeaf(panel: FlatPanelItem): LayoutLeaf {
  return {
    type: 'leaf',
    id: panel.leafId,
    panelId: panel.panelId,
    tabs: panel.tabs,
    activeTab: panel.activeTab,
    ...(panel.sessionId ? { sessionId: panel.sessionId } : {}),
  };
}

function stabilizeLeafEntries(
  panels: FlatPanelItem[],
  prev: Map<string, StableLeafEntry>
): Map<string, StableLeafEntry> {
  const next = new Map<string, StableLeafEntry>();
  for (const panel of panels) {
    const cached = prev.get(panel.leafId);
    let leaf: LayoutLeaf;
    if (
      cached &&
      cached.leaf.panelId === panel.panelId &&
      cached.leaf.activeTab === panel.activeTab &&
      cached.leaf.sessionId === panel.sessionId &&
      tabsEqual(cached.leaf.tabs, panel.tabs)
    ) {
      leaf = cached.leaf;
    } else {
      leaf = toLayoutLeaf(panel);
    }

    const rect =
      cached && rectEqual(cached.rect, panel.rect) ? cached.rect : panel.rect;

    next.set(panel.leafId, { leaf, rect });
  }
  return next;
}

/** 按 branchId 复用 FlatBranch 引用（几何未变则同一对象） */
function stabilizeBranches(
  branches: FlatBranch[],
  prev: Map<string, FlatBranch>
): Map<string, FlatBranch> {
  const next = new Map<string, FlatBranch>();
  for (const branch of branches) {
    const cached = prev.get(branch.branchId);
    next.set(
      branch.branchId,
      cached && flatBranchEqual(cached, branch) ? cached : branch
    );
  }
  return next;
}

// ── 主组件 ───────────────────────────────────────────────────────────

export const BinaryTreeWorkspace: React.FC<BinaryTreeWorkspaceProps> =
  React.memo(() => {
    const tree = useLayoutTreeStore((s) => s.tree);
    const activeLeafId = useLayoutTreeStore((s) => s.activeLeafId);
    const toolColumnCollapsed = useLayoutTreeStore(
      (s) => s.toolColumnCollapsed
    );
    const draggedSource = useLayoutTreeStore((s) => s.draggedSource);
    // 注意：勿订 past/future 长度 — 历史栈变化与 canvas 渲染无关，
    // 曾导致每次 resize commit / 其它写历史动作全树 leaf+sash re-render。

    const canvasRef = useRef<HTMLDivElement>(null);
    const dragController = useTreeDrag();
    const resizeController = useTreeResize();
    useTreePanelEvents();
    useChatPanelSync();

    const {
      leaves: panels,
      branches,
      isMultiChat,
    } = React.useMemo(() => {
      // multi-chat：禁止全局 toolColumnCollapsed 压掉所有 unit 右坞
      const multi = listChatLeaves(tree.root).length > 1;
      const result = flattenTree(tree.root, {
        collapsedDomain: !multi && toolColumnCollapsed ? 'tool' : undefined,
      });
      return { ...result, isMultiChat: multi };
    }, [tree.root, toolColumnCollapsed]);

    // 跨 render 复用 leaf / rect 引用，供 TreeLeafPanel React.memo 跳过
    const leafEntryCacheRef = useRef<Map<string, StableLeafEntry>>(new Map());
    const stableLeafEntries = React.useMemo(() => {
      const next = stabilizeLeafEntries(panels, leafEntryCacheRef.current);
      leafEntryCacheRef.current = next;
      return next;
    }, [panels]);

    // 跨 render 复用 branch 引用，供 TreeResizeSash React.memo 跳过
    const branchCacheRef = useRef<Map<string, FlatBranch>>(new Map());
    const stableBranches = React.useMemo(() => {
      const next = stabilizeBranches(branches, branchCacheRef.current);
      branchCacheRef.current = next;
      return next;
    }, [branches]);

    const draggedLeafId =
      draggedSource && draggedSource.type === 'leaf'
        ? draggedSource.leafId
        : null;

    const ghostLabel = React.useMemo(() => {
      if (!draggedSource) return null;
      if (draggedSource.type === 'leaf') {
        return getPanelTitle(draggedSource.panelId);
      }
      return getPanelTitle(draggedSource.tabId);
    }, [draggedSource]);

    // 解构稳定字段，避免把整包 controller 对象传给 sash（破 memo）
    const { startResize, resizingBranchId } = resizeController;

    return (
      <div
        className={styles.section}
        data-tree-workspace="true"
      >
        <AppErrorBoundary compact>
          <div
            ref={canvasRef}
            className={`${styles.canvas} ${styles.treeBody}`}
            data-tree-canvas="true"
            role="group"
            aria-label="二叉树布局画布"
          >
            {panels.map((panel) => {
              const entry = stableLeafEntries.get(panel.leafId)!;
              return (
                <TreeLeafPanel
                  key={panel.leafId}
                  leaf={entry.leaf}
                  rect={entry.rect}
                  isActive={panel.leafId === activeLeafId}
                  isDragSource={panel.leafId === draggedLeafId}
                  isMultiChat={isMultiChat}
                />
              );
            })}

            {/* 渲染所有 sash（branch 经 branchId 缓存稳定；startResize 稳定 + isResizing 布尔） */}
            {branches.map((branch) => {
              const stable = stableBranches.get(branch.branchId) ?? branch;
              return (
                <TreeResizeSash
                  key={branch.branchId}
                  branch={stable}
                  startResize={startResize}
                  isResizing={resizingBranchId === branch.branchId}
                />
              );
            })}

            {/* Drop zone 覆盖层 */}
            <DropZoneOverlay />
          </div>
        </AppErrorBoundary>

        {/* 面板拖拽 ghost（useTreeDrag）：ref + 直接 DOM transform，跳过 React re-render */}
        {ghostLabel !== null &&
          dragController.isDragging &&
          createPortal(
            <div
              ref={dragController.setGhostRef}
              className={styles.ghost}
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                transform: 'translate(-9999px, -9999px)',
              }}
              aria-hidden="true"
            >
              <span className={styles.ghostLabel}>{ghostLabel}</span>
            </div>,
            document.body
          )}
      </div>
    );
  });
BinaryTreeWorkspace.displayName = 'BinaryTreeWorkspace';
