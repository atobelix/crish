import React, { useCallback } from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';
import {
  useDialogContext,
  type DialogSize,
  type DialogRole,
} from './dialogContext';

export const SIZE_CLASS: Record<DialogSize, string | undefined> = {
  sm: styles.dialogSm,
  md: styles.dialogMd,
  lg: styles.dialogLg,
  xl: styles.dialogXl,
  '2xl': styles.dialog2xl,
  auto: styles.dialogAuto,
};

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogContent 弹窗卡片容器                                       */
/* -------------------------------------------------------------------------- */
export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: DialogSize;
  role?: DialogRole;
  ariaLabel?: string;
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogContent({
  size: explicitSize,
  role: explicitRole,
  ariaLabel: explicitAriaLabel,
  className,
  children,
  ref,
  style,
  ...props
}: DialogContentProps) {
  const ctx = useDialogContext();
  const resolvedSize = explicitSize ?? ctx.size;
  const resolvedRole = explicitRole ?? ctx.role;
  const resolvedAriaLabel = explicitAriaLabel ?? ctx.ariaLabel;
  const isExiting = ctx.state === 'exiting';

  const panelClasses = cn(
    styles.dialog,
    SIZE_CLASS[resolvedSize],
    styles[`size-${resolvedSize}`],
    styles.panel,
    isExiting ? styles.dialogExit : styles.dialogEnter,
    ctx.classNames?.panel,
    className
  );

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      (ctx.panelRef as React.MutableRefObject<HTMLDivElement | null>).current =
        node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref && 'current' in ref) {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [ctx.panelRef, ref]
  );

  return (
    <div
      ref={handleRef}
      role={resolvedRole}
      aria-modal="true"
      aria-label={resolvedAriaLabel}
      aria-labelledby={resolvedAriaLabel ? undefined : ctx.titleId}
      aria-describedby={props['aria-describedby'] ?? ctx.descriptionId}
      className={panelClasses}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      {...props}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogPopup 别名（等价 DialogContent）                            */
/* -------------------------------------------------------------------------- */
export const DialogPopup = DialogContent;
