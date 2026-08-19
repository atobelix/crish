/**
 * 二叉树 Drop Zone 指示器 — 拖拽时显示落点预览。
 *
 * 根据当前 activeDropZone 计算覆盖层 rect：
 * - merge-tab：覆盖整个目标 leaf
 * - split-left/right/top/bottom：覆盖目标 leaf 的一半
 *
 * 渲染策略：portal 到 document.body，pointer-events: none，避免干扰拖拽
 *
 * 重计算时机（系统性约束）：
 * 拖拽期间 tree 不可变（commitDrop 仅在 pointerUp 触发），故 leaf DOM rect
 * 稳定。覆盖层仅需在以下场景重算：
 * 1. dropZone 变化（目标 leaf 或 zone 类型改变）
 * 2. viewport 变化（window resize / scroll 改变 leaf 屏幕坐标）
 * 旧实现的 rAF 轮询每帧强制 getBoundingClientRect → 触发 layout，60fps 拖拽
 * 下每秒 60 次无效布局计算，已移除。
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { useLayoutTreeStore } from '../../store/storeAccess';
import type { DropZone } from '../../store/storeAccess';
import styles from './BinaryTreeWorkspace.module.css';

/** 覆盖层位置（屏幕坐标） */
interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
  className: string;
}

/**
 * 根据 drop zone 类型与目标 leaf rect 计算覆盖层位置。
 */
function computeOverlayRect(zone: DropZone, leafRect: DOMRect): OverlayRect {
  const { left, top, width, height } = leafRect;
  const pad = 2;

  switch (zone.type) {
    case 'merge-tab':
      return {
        left: left + pad,
        top: top + pad,
        width: width - pad * 2,
        height: height - pad * 2,
        className: styles.dropOverlayFull || '',
      };
    case 'split-left':
      return {
        left: left + pad,
        top: top + pad,
        width: width * 0.5 - pad * 2,
        height: height - pad * 2,
        className: styles.dropOverlaySplitLeft || '',
      };
    case 'split-right':
      return {
        left: left + width * 0.5 + pad,
        top: top + pad,
        width: width * 0.5 - pad * 2,
        height: height - pad * 2,
        className: styles.dropOverlaySplitRight || '',
      };
    case 'split-top':
      return {
        left: left + pad,
        top: top + pad,
        width: width - pad * 2,
        height: height * 0.5 - pad * 2,
        className: styles.dropOverlaySplitTop || '',
      };
    case 'split-bottom':
      return {
        left: left + pad,
        top: top + height * 0.5 + pad,
        width: width - pad * 2,
        height: height * 0.5 - pad * 2,
        className: styles.dropOverlaySplitBottom || '',
      };
    default:
      return { left: 0, top: 0, width: 0, height: 0, className: '' };
  }
}

export const DropZoneOverlay: React.FC = React.memo(() => {
  const dropZone = useLayoutTreeStore((s) => s.activeDropZone);
  const draggedSource = useLayoutTreeStore((s) => s.draggedSource);
  const [overlay, setOverlay] = React.useState<OverlayRect | null>(null);

  // 重算覆盖层位置：dropZone 变化时计算一次
  // （拖拽期间 tree 不可变，leaf DOM rect 稳定，无需 rAF 轮询）
  const recompute = React.useCallback(() => {
    if (!dropZone) {
      setOverlay(null);
      return;
    }
    const targetEl = document.querySelector<HTMLElement>(
      `[data-leaf-id="${dropZone.targetLeafId}"]`
    );
    if (!targetEl) {
      setOverlay(null);
      return;
    }
    setOverlay(computeOverlayRect(dropZone, targetEl.getBoundingClientRect()));
  }, [dropZone]);

  React.useEffect(() => {
    if (!dropZone || !draggedSource) {
      setOverlay(null);
      return;
    }
    recompute();
  }, [dropZone, draggedSource, recompute]);

  // viewport 变化（resize/scroll）触发重算 — 唯一使 leaf 屏幕坐标变化的因素
  React.useEffect(() => {
    if (!dropZone || !draggedSource) return;
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [dropZone, draggedSource, recompute]);

  if (!overlay) return null;

  return createPortal(
    <div
      className={`${styles.dropOverlay} ${overlay.className}`}
      style={{
        left: overlay.left,
        top: overlay.top,
        width: overlay.width,
        height: overlay.height,
      }}
      aria-hidden="true"
    />,
    document.body
  );
});
DropZoneOverlay.displayName = 'DropZoneOverlay';
