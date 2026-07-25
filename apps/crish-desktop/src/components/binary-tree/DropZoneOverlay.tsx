/**
 * 二叉树 Drop Zone 指示器 — 拖拽时显示落点预览。
 *
 * 根据当前 activeDropZone 计算覆盖层 rect：
 * - merge-tab：覆盖整个目标 leaf
 * - split-left/right/top/bottom：覆盖目标 leaf 的一半
 *
 * 渲染策略：portal 到 document.body，pointer-events: none，避免干扰拖拽
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { useLayoutTreeStore } from '../../store/layout-tree';
import type { DropZone } from '../../store/layout-tree';
import styles from './BinaryTreeWorkspace.module.css';

interface DropZoneOverlayProps {
  /** canvas 容器 ref（用于计算相对坐标） */
  canvasRef: React.RefObject<HTMLDivElement | null>;
}

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

  switch (zone.type) {
    case 'merge-tab':
      return {
        left,
        top,
        width,
        height,
        className: styles.dropOverlayFull || '',
      };
    case 'split-left':
      return {
        left,
        top,
        width: width * 0.5,
        height,
        className: styles.dropOverlaySplitLeft || '',
      };
    case 'split-right':
      return {
        left: left + width * 0.5,
        top,
        width: width * 0.5,
        height,
        className: styles.dropOverlaySplitRight || '',
      };
    case 'split-top':
      return {
        left,
        top,
        width,
        height: height * 0.5,
        className: styles.dropOverlaySplitTop || '',
      };
    case 'split-bottom':
      return {
        left,
        top: top + height * 0.5,
        width,
        height: height * 0.5,
        className: styles.dropOverlaySplitBottom || '',
      };
    default:
      return { left: 0, top: 0, width: 0, height: 0, className: '' };
  }
}

export const DropZoneOverlay: React.FC<DropZoneOverlayProps> = React.memo(
  () => {
    const dropZone = useLayoutTreeStore((s) => s.activeDropZone);
    const draggedSource = useLayoutTreeStore((s) => s.draggedSource);
    const [overlay, setOverlay] = React.useState<OverlayRect | null>(null);

    // 监听 dropZone 变化，重新计算覆盖层位置
    React.useEffect(() => {
      if (!dropZone || !draggedSource) {
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
      const rect = targetEl.getBoundingClientRect();
      setOverlay(computeOverlayRect(dropZone, rect));
    }, [dropZone, draggedSource]);

    // 拖拽过程中 leaf 位置可能变化，用 rAF 持续更新
    React.useEffect(() => {
      if (!dropZone || !draggedSource) return;
      let rafId = 0;
      const update = () => {
        const targetEl = document.querySelector<HTMLElement>(
          `[data-leaf-id="${dropZone.targetLeafId}"]`
        );
        if (targetEl) {
          const rect = targetEl.getBoundingClientRect();
          setOverlay(computeOverlayRect(dropZone, rect));
        }
        rafId = requestAnimationFrame(update);
      };
      rafId = requestAnimationFrame(update);
      return () => cancelAnimationFrame(rafId);
    }, [dropZone, draggedSource]);

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
  }
);
DropZoneOverlay.displayName = 'DropZoneOverlay';
