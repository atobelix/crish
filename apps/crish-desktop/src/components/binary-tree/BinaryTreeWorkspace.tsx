/**
 * 二叉树工作区 — 拖拽式布局工作区主入口。
 *
 * 渲染流程：
 * 1. 从 layoutTreeStore 读取 LayoutTree
 * 2. 调用 flattenToRenderList 计算 FlatPanel[]（含 rect 百分比）
 * 3. 遍历 branch 节点，在两个 child 之间渲染 TreeResizeSash
 * 4. 每个 leaf 用 TreeLeafPanel 渲染（绝对定位）
 * 5. DropZoneOverlay portal 到 body 显示落点预览
 * 6. GlobalDragOverlay portal 显示拖拽 ghost
 *
 * 设计要点：
 * - canvas 为 position: relative，所有 leaf/sash 绝对定位
 * - leaf rect 为百分比（0-1），由 flattenToRenderList 计算
 * - sash 仅在 branch 节点上渲染，位置由 splitRatio 决定
 * - 拖拽控制器在主入口创建一次，注入到所有 leaf（避免重复挂载全局事件）
 */

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  useLayoutTreeStore,
  flattenToRenderList,
  isBranch,
  type LayoutBranch,
  type FlatPanel,
} from '../../store/layout-tree';
import { useTreeDrag } from '../../hooks/useTreeDrag';
import { useTreeResize } from '../../hooks/useTreeResize';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Tooltip } from '../Tooltip';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { Columns, Plus, RotateCcw } from 'lucide-react';

import { TreeLeafPanel } from './TreeLeafPanel';
import { TreeResizeSash } from './TreeResizeSash';
import { DropZoneOverlay } from './DropZoneOverlay';
import styles from './BinaryTreeWorkspace.module.css';

// ── Props ───────────────────────────────────────────────────────────

export interface BinaryTreeWorkspaceProps {
  /** Toast 回调（与 app 全局 ShowToastFn 对齐） */
  onShowToast: ShowToastFn;
}

// ── 主组件 ───────────────────────────────────────────────────────────

export const BinaryTreeWorkspace: React.FC<BinaryTreeWorkspaceProps> =
  React.memo(({ onShowToast }) => {
    const tree = useLayoutTreeStore((s) => s.tree);
    const activeLeafId = useLayoutTreeStore((s) => s.activeLeafId);
    const draggedSource = useLayoutTreeStore((s) => s.draggedSource);
    const resetTree = useLayoutTreeStore((s) => s.resetTree);
    const splitLeaf = useLayoutTreeStore((s) => s.splitLeaf);
    const undo = useLayoutTreeStore((s) => s.undo);
    const redo = useLayoutTreeStore((s) => s.redo);
    const canUndo = useLayoutTreeStore((s) => s.canUndo());
    const canRedo = useLayoutTreeStore((s) => s.canRedo());

    const canvasRef = useRef<HTMLDivElement>(null);
    const dragController = useTreeDrag();
    const resizeController = useTreeResize();

    // 计算渲染列表（leaf → FlatPanel）
    const panels: FlatPanel[] = React.useMemo(
      () => flattenToRenderList(tree.root),
      [tree]
    );

    // 收集所有 branch 节点（用于渲染 sash）
    const branches = React.useMemo(() => collectBranches(tree.root), [tree]);

    // 拖拽源 leaf id（用于隐藏源 leaf）
    const draggedLeafId = draggedSource?.leafId ?? null;

    // 拖拽 ghost 内容
    const ghostNode = React.useMemo(() => {
      if (!draggedSource || !dragController.ghostPosition) return null;
      const panelTitle = (() => {
        if (draggedSource.type === 'tab' && draggedSource.tabId) {
          return getPanelTitleSafe(draggedSource.tabId);
        }
        return getPanelTitleSafe(draggedSource.panelId);
      })();
      return (
        <div className={styles.ghost}>
          <span className={styles.ghostLabel}>{panelTitle}</span>
        </div>
      );
    }, [draggedSource, dragController.ghostPosition]);

    const handleReset = React.useCallback(() => {
      resetTree('chat');
      onShowToast('已重置为单面板布局');
    }, [resetTree, onShowToast]);

    const handleSplitDemo = React.useCallback(() => {
      // 演示：在当前激活 leaf 旁边 split 出一个 diff 面板
      if (!activeLeafId) return;
      splitLeaf(activeLeafId, 'horizontal', 'diff', 'after', 0.5);
    }, [activeLeafId, splitLeaf]);

    const handleUndo = React.useCallback(() => {
      if (canUndo) {
        undo();
      }
    }, [canUndo, undo]);

    const handleRedo = React.useCallback(() => {
      if (canRedo) {
        redo();
      }
    }, [canRedo, redo]);

    return (
      <div className={styles.section} data-tree-workspace="true">
        {/* 顶部控制条 */}
        <div
          className={styles.controlBar}
          role="toolbar"
          aria-label="工作区工具栏"
        >
          <span className={styles.leafTitle}>
            二叉树工作区 · {panels.length} 面板 · {branches.length} 分割
          </span>
          <span className={styles.controlSpacer} />
          <Tooltip content={canUndo ? '撤销' : '无可撤销操作'}>
            <button
              type="button"
              className={styles.controlBtn}
              onClick={handleUndo}
              disabled={!canUndo}
              aria-label="撤销布局变更"
            >
              <RotateCcw size={12} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content={canRedo ? '重做' : '无可重做操作'}>
            <button
              type="button"
              className={styles.controlBtn}
              onClick={handleRedo}
              disabled={!canRedo}
              aria-label="重做布局变更"
            >
              <RotateCcw
                size={12}
                aria-hidden
                style={{ transform: 'scaleX(-1)' }}
              />
            </button>
          </Tooltip>
          <Tooltip content="添加 diff 面板（演示）">
            <button
              type="button"
              className={styles.controlBtn}
              onClick={handleSplitDemo}
              aria-label="添加 diff 面板"
            >
              <Plus size={12} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="重置为单面板">
            <button
              type="button"
              className={styles.controlBtn}
              onClick={handleReset}
              aria-label="重置布局"
            >
              <Columns size={12} aria-hidden />
            </button>
          </Tooltip>
        </div>

        {/* Canvas：渲染所有 leaf 与 sash */}
        <AppErrorBoundary compact>
          <div
            ref={canvasRef}
            className={styles.canvas}
            data-tree-canvas="true"
            role="group"
            aria-label="二叉树布局画布"
          >
            {/* 渲染所有 leaf */}
            {panels.map((panel) => (
              <TreeLeafPanel
                key={panel.leafId}
                leaf={findLeafFromPanel(tree, panel.leafId)}
                rect={panel.rect}
                isActive={panel.leafId === activeLeafId}
                isDragSource={panel.leafId === draggedLeafId}
                dragController={dragController}
                onShowToast={onShowToast}
              />
            ))}

            {/* 渲染所有 sash（branch 节点） */}
            {branches.map((branch) => (
              <TreeResizeSash
                key={branch.id}
                branch={branch}
                containerRect={findBranchRect(panels, branch)}
                resizeController={resizeController}
              />
            ))}

            {/* Drop zone 覆盖层 */}
            <DropZoneOverlay canvasRef={canvasRef} />
          </div>
        </AppErrorBoundary>

        {/* 拖拽 ghost 浮层 */}
        {ghostNode &&
          dragController.ghostPosition &&
          createPortal(
            <div
              className={styles.ghost}
              style={{
                position: 'fixed',
                left: dragController.ghostPosition.x,
                top: dragController.ghostPosition.y,
              }}
              aria-hidden="true"
            >
              {ghostNode}
            </div>,
            document.body
          )}
      </div>
    );
  });
BinaryTreeWorkspace.displayName = 'BinaryTreeWorkspace';

// ── 辅助函数 ────────────────────────────────────────────────────────

/** 收集树中所有 branch 节点（深度优先） */
function collectBranches(
  root: import('../../store/layout-tree').LayoutNode
): LayoutBranch[] {
  const result: LayoutBranch[] = [];
  const visit = (node: import('../../store/layout-tree').LayoutNode) => {
    if (isBranch(node)) {
      result.push(node);
      visit(node.children[0]);
      visit(node.children[1]);
    }
  };
  visit(root);
  return result;
}

/** 从 tree 中按 leafId 查找 leaf */
function findLeafFromPanel(
  tree: import('../../store/layout-tree').LayoutTree,
  leafId: string
): import('../../store/layout-tree').LayoutLeaf {
  // flattenToRenderList 已保证 leafId 存在；若意外丢失则返回占位
  const node = findNodeInTree(tree, leafId);
  if (node && !isBranch(node)) return node;
  // 兜底：返回一个空 leaf（不应发生）
  return {
    type: 'leaf',
    id: leafId,
    panelId: 'unknown',
    tabs: ['unknown'],
    activeTab: 'unknown',
    size: 1,
  };
}

function findNodeInTree(
  tree: import('../../store/layout-tree').LayoutTree,
  id: string
): import('../../store/layout-tree').LayoutNode | null {
  const search = (
    node: import('../../store/layout-tree').LayoutNode
  ): import('../../store/layout-tree').LayoutNode | null => {
    if (node.id === id) return node;
    if (isBranch(node)) {
      return search(node.children[0]) ?? search(node.children[1]);
    }
    return null;
  };
  return search(tree.root);
}

/** 计算 branch 的 rect（从 panels 列表中取两个 child 的并集） */
function findBranchRect(
  panels: FlatPanel[],
  branch: LayoutBranch
): { x: number; y: number; width: number; height: number } {
  // branch 的 rect = 第一个 leaf child 与第二个 leaf child 的并集
  // 简化：找到 branch 下所有 leaf，取最小外接矩形
  const leaves = collectLeafIds(branch);
  const leafPanels = panels.filter((p) => leaves.includes(p.leafId));
  if (leafPanels.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const minX = Math.min(...leafPanels.map((p) => p.rect.x));
  const minY = Math.min(...leafPanels.map((p) => p.rect.y));
  const maxX = Math.max(...leafPanels.map((p) => p.rect.x + p.rect.width));
  const maxY = Math.max(...leafPanels.map((p) => p.rect.y + p.rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function collectLeafIds(branch: LayoutBranch): string[] {
  const ids: string[] = [];
  const visit = (node: import('../../store/layout-tree').LayoutNode) => {
    if (isBranch(node)) {
      visit(node.children[0]);
      visit(node.children[1]);
    } else {
      ids.push(node.id);
    }
  };
  visit(branch);
  return ids;
}

/** 安全获取面板标题（不依赖循环 import） */
function getPanelTitleSafe(panelId: string): string {
  // 与 layoutHelpers.getPanelTitle 对齐的最小子集
  const map: Record<string, string> = {
    chat: '对话',
    diff: '变更',
    files: '文件',
    terminal: '终端',
    preview: '预览',
    overview: '概览',
    runtime: '运行时',
    agent: '协作',
    settings: '设置',
    plan: '计划',
    tasks: '任务',
  };
  return map[panelId] ?? panelId;
}
