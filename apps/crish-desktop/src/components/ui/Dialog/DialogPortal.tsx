import React, { useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';
import { FocusTrap } from '../internal/focusTrap';
import { DialogOverlayContext } from './dialogOverlayContext';
import { useDialogContext } from './dialogContext';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogPortal 挂载层                                              */
/* -------------------------------------------------------------------------- */
export interface DialogPortalProps {
  container?: HTMLElement | null;
  keepMounted?: boolean;
  children?: ReactNode;
}

export function DialogPortal({ container, children }: DialogPortalProps) {
  const ctx = useDialogContext();
  const target =
    container ??
    ctx.portalTarget ??
    (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  return createPortal(
    <FocusTrap
      active={ctx.open && ctx.isMounted}
      initialFocusRef={ctx.initialFocusRef}
    >
      {children}
    </FocusTrap>,
    target
  );
}

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogBackdrop 遮罩层                                            */
/* -------------------------------------------------------------------------- */
export interface DialogBackdropProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogBackdrop({
  className,
  onClick,
  ref,
  ...props
}: DialogBackdropProps) {
  const ctx = useDialogContext();
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    onClick?.(e);
    if (!e.defaultPrevented && ctx.closeOnBackdropClick) {
      ctx.onClose?.();
    }
  };
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-dialog-backdrop=""
      className={cn(styles.backdrop, className)}
      onClick={handleClick}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogViewport 视口居中层                                        */
/* -------------------------------------------------------------------------- */
export interface DialogViewportProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogViewport({
  className,
  children,
  ref,
  ...props
}: DialogViewportProps) {
  return (
    <div ref={ref} className={cn(styles.viewport, className)} {...props}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogOverlay 遮罩外壳（兼容层级提权与类名覆盖）                 */
/* -------------------------------------------------------------------------- */
export interface DialogOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogOverlay({
  className,
  children,
  style,
  ref,
  ...props
}: DialogOverlayProps) {
  const ctx = useDialogContext();
  const [overlayNode, setOverlayNode] = useState<HTMLDivElement | null>(null);

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      setOverlayNode(node);
      ctx.setOverlayEl(node);
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref && 'current' in ref) {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [ctx, ref]
  );

  const isExiting = ctx.state === 'exiting';
  const overlayState = isExiting ? 'exiting' : ctx.open ? 'open' : 'closed';
  const overlayClasses = cn(
    isExiting ? styles.overlayExit : styles.overlayEnter,
    ctx.classNames?.overlay,
    className
  );

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    props.onClick?.(e);
    if (
      e.target === e.currentTarget &&
      !e.defaultPrevented &&
      ctx.closeOnBackdropClick
    ) {
      ctx.onClose?.();
    }
  };

  return (
    <div
      ref={handleRef}
      className={overlayClasses}
      data-dialog-overlay=""
      data-dialog-state={overlayState}
      style={style}
      onClick={handleOverlayClick}
      {...props}
    >
      <DialogOverlayContext.Provider value={overlayNode}>
        <DialogBackdrop />
        {children}
      </DialogOverlayContext.Provider>
    </div>
  );
}
