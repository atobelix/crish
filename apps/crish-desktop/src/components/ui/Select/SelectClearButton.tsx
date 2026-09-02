import React from 'react';
import { ClearIcon } from './internal/SelectIcons';
import type { SelectClearButtonProps } from './types';
import styles from './SelectTrigger.module.css';

export function SelectClearButton({ className, onClick }: SelectClearButtonProps) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label="清空选值"
      className={`${styles.clearBtn} ${className ?? ''}`}
      data-slot="select-clear-button"
      onClick={(e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        e.preventDefault();
        onClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLSpanElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
          e.preventDefault();
          onClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>);
        }
      }}
    >
      <ClearIcon size={12} />
    </span>
  );
}
