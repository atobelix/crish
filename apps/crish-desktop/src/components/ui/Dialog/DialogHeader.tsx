import React from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogHeader 头部容器                                           */
/* -------------------------------------------------------------------------- */
export interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogHeader({
  className,
  children,
  ref,
  ...props
}: DialogHeaderProps) {
  return (
    <div
      ref={ref}
      className={cn(styles.dialogHeader, styles.header, className)}
      {...props}
    >
      {children}
    </div>
  );
}
