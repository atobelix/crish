import React from 'react';
import { createPortal } from 'react-dom';
import { useLayoutStore } from '../store/layoutStore';

interface DropIndicatorLayerProps {
  wsId: string;
}

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: 'var(--z-drag-overlay, 1000)',
  contain: 'strict',
};

export const DropIndicatorLayer: React.FC<DropIndicatorLayerProps> = React.memo(
  ({ wsId }) => {
    const dropPreview = useLayoutStore((s) => s.dropPreview);
    const draggedTab = useLayoutStore((s) => s.draggedTab);

    if (!dropPreview || !draggedTab || draggedTab.workspaceId !== wsId) return null;

    const { left, top, width, height, className } = dropPreview;

    return createPortal(
      <div className="drop-indicator-layer" style={containerStyle}>
        <div className={className} style={{
          position: 'absolute', left, top, width, height,
        }} />
      </div>,
      document.body,
    );
  },
);

DropIndicatorLayer.displayName = 'DropIndicatorLayer';
