import React from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';
import { useDialogContext } from './dialogContext';

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogDescription 描述文案                                       */
/* -------------------------------------------------------------------------- */
export interface DialogDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  ref?: React.Ref<HTMLParagraphElement>;
}

export function DialogDescription({
  id,
  className,
  children,
  ref,
  ...props
}: DialogDescriptionProps) {
  const ctx = useDialogContext();
  const descriptionId = id ?? ctx.descriptionId;

  return (
    <p
      ref={ref}
      id={descriptionId}
      className={cn(styles.dialogDescription, styles.description, className)}
      {...props}
    >
      {children}
    </p>
  );
}
