import React from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogFooter 底部操作栏                                         */
/* -------------------------------------------------------------------------- */
export interface DialogFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogFooter({
  className,
  children,
  ref,
  ...props
}: DialogFooterProps) {
  return (
    <div
      ref={ref}
      className={cn(styles.dialogFooter, styles.footer, className)}
      {...props}
    >
      {children}
    </div>
  );
}
