import React from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';
import { useDialogContext } from './dialogContext';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogTitle 标题                                                 */
/* -------------------------------------------------------------------------- */
export interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'div' | 'span';
  ref?: React.Ref<HTMLHeadingElement>;
}

export function DialogTitle({
  as: Comp = 'h2',
  id,
  className,
  children,
  ref,
  ...props
}: DialogTitleProps) {
  const ctx = useDialogContext();
  const titleId = id ?? ctx.titleId;

  return (
    <Comp
      ref={ref}
      id={titleId}
      className={cn(styles.dialogTitle, styles.title, className)}
      {...props}
    >
      {children}
    </Comp>
  );
}
