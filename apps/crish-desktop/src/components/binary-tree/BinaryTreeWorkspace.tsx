/**
 * 二叉树工作区 — 拖拽式布局工作区主入口。
 *
 * 渲染流程：
 * 1. 从 layoutTreeStore 读取 LayoutTree
 * 2. 调用 flattenToRenderList 计算 FlatPanel[]（含 rect 百分比）
 * 3. 遍历 branch 节点，在两个 child 之间渲染 TreeResizeSash
 * 4. 每个 leaf 用 TreeLeafPanel 渲染（绝对定位）
 * 5. DropZoneOverlay portal 到 body 显示落点预览
 * 6. ghost portal 显示拖拽 ghost（内联渲染，非独立组件）
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
  flattenTree,
  type LayoutLeaf,
} from '../../store/layout-tree';
import { getPanelTitle } from '../../store/layoutHelpers';
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
    // 直接订阅 past/future 长度，避免在 selector 中调用 action（get() 反模式）
    const canUndo = useLayoutTreeStore((s) => s.past.length > 0);
    const canRedo = useLayoutTreeStore((s) => s.future.length > 0);

    const canvasRef = useRef<HTMLDivElement>(null);
    const dragController = useTreeDrag();
    const resizeController = useTreeResize();

    // 单次遍历计算 leaf + branch 渲染列表（含 rect）
    // flattenTree 同时输出 leaves 和 branches，共享同一递归，
    // 替代旧实现的 flattenToRenderList + collectBranches 两次遍历
    const { leaves: panels, branches } = React.useMemo(
      () => flattenTree(tree.root),
      [tree]
    );

    // 拖拽源 leaf id（用于隐藏源 leaf）
    const draggedLeafId = draggedSource?.leafId ?? null;

    // 拖拽 ghost 内容（仅 label，外层 .ghost 容器由 portal 统一提供）
    // 仅依赖 draggedSource — ghostPosition 每帧变化但 label 内容不变，
    // 由 JSX 处的 ghostPosition 检查决定是否渲染 portal
    const ghostLabel = React.useMemo(() => {
      if (!draggedSource) return null;
      return draggedSource.type === 'tab' && draggedSource.tabId
        ? getPanelTitle(draggedSource.tabId)
        : getPanelTitle(draggedSource.panelId);
    }, [draggedSource]);

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
            {panels.map((panel) => {
              // FlatPanel 已包含全部 leaf 数据（flattenToRenderList 与 tree 同步），
              // 无需再 findNodeById — 直接构造 LayoutLeaf 即可，避免 O(n log n) 查找
              const leaf: LayoutLeaf = {
                type: 'leaf',
                id: panel.leafId,
                panelId: panel.panelId,
                tabs: panel.tabs,
                activeTab: panel.activeTab,
              };
              return (
                <TreeLeafPanel
                  key={panel.leafId}
                  leaf={leaf}
                  rect={panel.rect}
                  isActive={panel.leafId === activeLeafId}
                  isDragSource={panel.leafId === draggedLeafId}
                  dragController={dragController}
                  onShowToast={onShowToast}
                />
              );
            })}

            {/* 渲染所有 sash（branch 节点，使用 flattenTree 计算的 rect 定位） */}
            {branches.map((branch) => (
              <TreeResizeSash
                key={branch.branchId}
                branch={branch}
                resizeController={resizeController}
              />
            ))}

            {/* Drop zone 覆盖层 */}
            <DropZoneOverlay />
          </div>
        </AppErrorBoundary>

        {/* 拖拽 ghost 浮层（单层 .ghost 容器，避免重复包裹）
            位置由 useTreeDrag 通过 ref + 直接 DOM 更新（跳过 React re-render）。
            初始 transform 把 ghost 移出视口，setGhostRef 回调在挂载时立即
            应用 ghostPosRef 中的真实位置，避免首帧闪现在 (0,0)。 */}
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
