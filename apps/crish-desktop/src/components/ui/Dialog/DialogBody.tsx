import React from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';
import { useDialogContext } from './dialogContext';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogBody 内容插槽                                             */
/* -------------------------------------------------------------------------- */
export interface DialogBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogBody({
  className,
  children,
  ref,
  ...props
}: DialogBodyProps) {
  const ctx = useDialogContext();
  return (
    <div
      ref={ref}
      className={cn(
        styles.dialogBody,
        styles.body,
        ctx.classNames?.body,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
