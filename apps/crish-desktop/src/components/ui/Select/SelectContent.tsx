import React, { useCallback, useContext } from 'react';
import { createPortal } from 'react-dom';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { useSelectContext } from './SelectRoot';
import { useFloatingPosition } from './useFloatingPosition';
import type { SelectContentProps } from './types';
import styles from './SelectContent.module.css';

export function SelectContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  edgePadding = 8,
  portalContainer,
  alignItemWithTrigger = true,
  children,
}: SelectContentProps) {
  const ctx = useSelectContext('SelectContent');
  const dialogOverlay = useContext(DialogOverlayContext);

  // 三级解析策略：显式 prop > DialogOverlayContext > document.body
  const resolvedContainer =
    portalContainer ??
    dialogOverlay ??
    (typeof document !== 'undefined' ? document.body : null);

  const handleDismiss = useCallback(() => {
    ctx.setOpen(false);
  }, [ctx]);

  const position = useFloatingPosition({
    open: ctx.open,
    triggerRef: ctx.triggerRef,
    contentRef: ctx.contentRef,
    side,
    align,
    sideOffset,
    edgePadding,
    portalContainer: resolvedContainer,
    alignItemWithTrigger,
    onDismiss: handleDismiss,
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const enabledIndices = ctx.items
        .map((item, idx) => (!item.disabled ? idx : -1))
        .filter((idx) => idx !== -1);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (enabledIndices.length > 0) {
          const currentPos = enabledIndices.indexOf(ctx.highlightedIndex);
          const nextPos =
            currentPos < 0 ? 0 : (currentPos + 1) % enabledIndices.length;
          ctx.setHighlightedIndex(enabledIndices[nextPos]!);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (enabledIndices.length > 0) {
          const currentPos = enabledIndices.indexOf(ctx.highlightedIndex);
          const prevPos =
            currentPos <= 0
              ? enabledIndices.length - 1
              : currentPos - 1;
          ctx.setHighlightedIndex(enabledIndices[prevPos]!);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (enabledIndices.length > 0) {
          ctx.setHighlightedIndex(enabledIndices[0]!);
        }
      } else if (e.key === 'End') {
        e.preventDefault();
        if (enabledIndices.length > 0) {
          ctx.setHighlightedIndex(enabledIndices[enabledIndices.length - 1]!);
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (ctx.highlightedIndex >= 0 && ctx.items[ctx.highlightedIndex]) {
          const target = ctx.items[ctx.highlightedIndex];
          if (target && !target.disabled) {
            ctx.selectValue(target.value);
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ctx.setOpen(false);
        (ctx.triggerRef.current as HTMLElement | null)?.focus();
      }
    },
    [ctx]
  );

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  if (!ctx.open) return null;

  const sizeClass =
    ctx.size === 'sm'
      ? styles.contentSm
      : ctx.size === 'lg'
        ? styles.contentLg
        : styles.contentMd;

  const contentClass = [
    styles.content,
    sizeClass,
    className,
  ]
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
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      data-slot="select-content"
      data-floating-layer="true"
      data-side={position.side}
      data-align={position.align}
      data-state={ctx.open ? 'open' : 'closed'}
    >
      <div className={styles.list}>{children}</div>
    </div>
  );

  return resolvedContainer ? createPortal(contentNode, resolvedContainer) : contentNode;
}
