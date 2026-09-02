/**
 * 叶内坞 resizer：拖中写 CSS 变量，松手才 updateTabDock。
 * 不是 TreeResizeSash，不改会话树拓扑。
 */

import React, { useCallback, useRef, useState } from 'react';
import styles from './BinaryTreeWorkspace.module.css';

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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const body = leafBodyRef.current;
      if (!body) return;
      draggingRef.current = true;
      setDragging(true);
      body.classList.add('is-dragging');
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
      const onUp = () => {
        draggingRef.current = false;
        setDragging(false);
        body.classList.remove('is-dragging');
        const px = parseFloat(
          body.style.getPropertyValue('--leaf-dock-width')
        );
        if (Number.isFinite(px) && bodyWidth > 0) {
          onCommitRatio(clampDockRatio(px / bodyWidth));
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
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
    />
  );
}
