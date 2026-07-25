import React from 'react';
import { createPortal } from 'react-dom';
import { useDragOverlay } from '../../contexts/dragContext';

export const GlobalDragOverlay: React.FC = React.memo(() => {
  const { active, node, position } = useDragOverlay();

  if (!active || !node) return null;

  return createPortal(
    <div
      className="global-drag-overlay-card"
      style={{
        position: 'fixed',
        left: position.x - 20,
        top: position.y - 20,
        pointerEvents: 'none',
        zIndex: 'var(--z-drag-overlay-max, 99999)',
        transform: 'rotate(2deg)',
        opacity: 0.9,
        transition: 'transform 0.1s, opacity 0.1s',
        willChange: 'transform',
      }}
    >
      {node}
    </div>,
    document.body,
  );
});

GlobalDragOverlay.displayName = 'GlobalDragOverlay';
