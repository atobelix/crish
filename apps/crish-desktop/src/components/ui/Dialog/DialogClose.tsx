import React from 'react';
import styles from './Dialog.module.css';
import { ICON_STROKE } from '../icons/iconTokens';
import { cn } from '../internal/cn';
import { useDialogContext } from './dialogContext';
import { useI18n } from '../../../i18n';

export function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.ui}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogClose 关闭按钮                                             */
/* -------------------------------------------------------------------------- */
export interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label'?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

export function DialogClose({
  className,
  'aria-label': ariaLabel,
  onClick,
  children,
  ref,
  ...props
}: DialogCloseProps) {
  const ctx = useDialogContext();
  const { t } = useI18n();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (!e.defaultPrevented) {
      ctx.onClose?.();
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      className={cn(styles.dialogClose, styles.closeBtn, className)}
      aria-label={ariaLabel ?? t('common.closeDialog', '关闭弹窗')}
      onClick={handleClick}
      {...props}
    >
      {children ?? <CloseIcon />}
    </button>
  );
}
