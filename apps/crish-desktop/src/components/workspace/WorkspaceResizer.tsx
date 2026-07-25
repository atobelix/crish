import React from 'react';

interface WorkspaceResizerProps {
  className: string;
  orientation: 'vertical' | 'horizontal';
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  style: React.CSSProperties;
  ariaLabel: string;
  ariaValueMin: number;
  ariaValueMax: number;
  ariaValueNow: number;
  ariaValueText: string;
}

export const WorkspaceResizer: React.FC<WorkspaceResizerProps> = React.memo(
  ({
    className,
    orientation,
    onPointerDown,
    onKeyDown,
    style,
    ariaLabel,
    ariaValueMin,
    ariaValueMax,
    ariaValueNow,
    ariaValueText,
  }) => (
    <div
      className={className}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      aria-valuenow={ariaValueNow}
      aria-valuetext={ariaValueText}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={style}
    />
  ),
);

WorkspaceResizer.displayName = 'WorkspaceResizer';
