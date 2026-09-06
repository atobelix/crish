/**
 * 叶内坞 resizer：拖中写 CSS 变量，松手才 updateTabDock。
 * 不是 TreeResizeSash，不改会话树拓扑。
 *
 * 防粘手四重防线：
 * 1. setPointerCapture — 锁定后续所有指针事件到本元素，彻底防 iframe 劫持
 * 2. disableIframePointerEvents — 拖拽期间屏蔽所有 iframe 的 pointer-events
 * 3. document.body.is-resizing — 全局 CSS 类，配合 :global(body.is-resizing) iframe 规则
 * 4. pointercancel 兜底 — 系统手势/失焦时安全收敛状态机
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './BinaryTreeWorkspace.module.css';
import { disableIframePointerEvents } from '../../utils/dragOverlay';

function clampDockRatio(ratio: number): number {
  return Math.min(0.75, Math.max(0.2, ratio));
}

export function LeafDockResizer({
  leafBodyRef,
  widthRatio,
  onCommitRatio,
}: {
  leafBodyRef: React.RefObject<HTMLDivElement | null>;
  widthRatio: number;
  onCommitRatio: (ratio: number) => void;
}) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const restoreIframesRef = useRef<(() => void) | null>(null);

  // 组件卸载时确保无残留全局状态
  useEffect(() => {
    return () => {
      if (restoreIframesRef.current) {
        restoreIframesRef.current();
        restoreIframesRef.current = null;
      }
      document.body.classList.remove('is-resizing', 'leaf-dock-resizing');
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const body = leafBodyRef.current;
      const handleEl = e.currentTarget;
      if (!body) return;

      // 1. Pointer Capture — 锁定，防 iframe 事件黑洞
      try {
        handleEl.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom 或非 primary 指针降级 */
      }

      // 2. 屏蔽全页 iframe pointer-events
      restoreIframesRef.current = disableIframePointerEvents();

      // 3. 全局 Body 状态机
      draggingRef.current = true;
      setDragging(true);
      body.classList.add('is-dragging');
      document.body.classList.add('is-resizing', 'leaf-dock-resizing');

      const startX = e.clientX;
      const bodyWidth = body.clientWidth;
      const startWidth = Math.max(
        200,
        Math.min(bodyWidth * 0.7, widthRatio * bodyWidth)
      );

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const next = Math.max(
          200,
          Math.min(bodyWidth * 0.7, startWidth + (startX - ev.clientX))
        );
        body.style.setProperty('--leaf-dock-width', `${next}px`);
      };

      const cleanup = (upEvent?: PointerEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);

        try {
          if (upEvent && handleEl.hasPointerCapture?.(upEvent.pointerId)) {
            handleEl.releasePointerCapture(upEvent.pointerId);
          }
        } catch { /* ignore */ }

        if (restoreIframesRef.current) {
          restoreIframesRef.current();
          restoreIframesRef.current = null;
        }
        body.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing', 'leaf-dock-resizing');

        const px = parseFloat(body.style.getPropertyValue('--leaf-dock-width'));
        if (Number.isFinite(px) && bodyWidth > 0) {
          onCommitRatio(clampDockRatio(px / bodyWidth));
        }

        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
      };

      // 4. 同时监听 pointercancel 兜底
      const onUp = (ev: PointerEvent) => cleanup(ev);
      const onCancel = () => cleanup();

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [leafBodyRef, onCommitRatio, widthRatio]
  );

  return (
    <div
      className={`${styles.leafDockResizer} layout-resizer layout-resizer-panel`}
      data-leaf-dock-resizer="true"
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(widthRatio * 100)}
      aria-valuemin={20}
      aria-valuemax={75}
      aria-label="拖拽调整右侧工具栏宽度"
    />
  );
}
