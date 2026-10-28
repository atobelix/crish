import React, { useCallback, useEffect, useContext } from 'react';
import { createPortal } from 'react-dom';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { useComboboxContext } from './ComboboxRoot';
import { usePositioner } from '../internal/positioner/usePositioner';
import type { ComboboxContentProps } from './types';
import styles from './SelectContent.module.css';

export function ComboboxContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  edgePadding = 8,
  portalContainer,
  children,
}: ComboboxContentProps) {
  const ctx = useComboboxContext('ComboboxContent');
  const dialogOverlay = useContext(DialogOverlayContext);

  // 三级解析策略：显式 prop > DialogOverlayContext > document.body
  const resolvedContainer =
    portalContainer ??
    dialogOverlay ??
    (typeof document !== 'undefined' ? document.body : null);

  const posReturn = usePositioner({
    open: ctx.open,
    anchor: ctx.triggerRef,
    contentRef: ctx.contentRef as React.RefObject<HTMLElement | null>,
    side,
    align,
    sideOffset,
    edgePadding,
    portalContainer: resolvedContainer,
  });

  const position = {
    x: posReturn.result?.x ?? 0,
    y: posReturn.result?.y ?? 0,
    transformOrigin: posReturn.result?.transformOrigin ?? 'top left',
    isPositioned: posReturn.isPositioned,
    side: posReturn.result?.actualSide ?? side,
    align: posReturn.result?.actualAlign ?? align,
  };

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  // 自动滚动高亮项到可视区域
  useEffect(() => {
    if (ctx.open && ctx.highlightedIndex >= 0 && ctx.contentRef.current) {
      const activeEl = ctx.contentRef.current.querySelector<HTMLElement>(
        `[data-index="${ctx.highlightedIndex}"]`
      );
      activeEl?.scrollIntoView({ block: 'nearest' });
    }
  }, [ctx.open, ctx.highlightedIndex, ctx.contentRef]);

  if (!ctx.open) return null;

  const contentClass = [styles.content, styles[`size-${ctx.size}`], className]
    .filter(Boolean)
    .join(' ');

  const contentNode = (
    <div
      ref={ctx.contentRef as React.RefObject<HTMLDivElement>}
      id={ctx.listboxId}
      role="listbox"
      tabIndex={-1}
      aria-orientation="vertical"
      className={contentClass}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
        visibility: position.isPositioned ? 'visible' : 'hidden',
        pointerEvents: position.isPositioned ? 'auto' : 'none',
      }}
      onWheel={handleWheel}
      data-slot="combobox-content"
      data-floating-layer="true"
      data-positioned={position.isPositioned ? 'true' : 'false'}
      data-side={position.side}
      data-align={position.align}
      data-state={ctx.open ? 'open' : 'closed'}
    >
      <div className={styles.list}>{children}</div>
    </div>
  );

  return resolvedContainer
    ? createPortal(contentNode, resolvedContainer)
    : contentNode;
}
