import React from 'react';

interface ColumnResizeHandleProps {
  orientation: 'vertical' | 'horizontal';
  onPointerDown: (e: React.PointerEvent) => void;
  className?: string;
  'aria-label'?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  style?: React.CSSProperties;
}

export const ColumnResizeHandle: React.FC<ColumnResizeHandleProps> = React.memo(
  ({ orientation, onPointerDown, className = '', ...aria }) => {
    return (
      <div
        className={`splitter ${orientation === 'vertical' ? 'col-splitter' : 'group-splitter'} ${className}`}
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation={orientation}
        tabIndex={0}
        {...aria}
      />
    );
  },
);

ColumnResizeHandle.displayName = 'ColumnResizeHandle';
