import React from 'react';
import type { SelectSeparatorProps } from './types';
import styles from './SelectContent.module.css';

export function SelectSeparator({ className }: SelectSeparatorProps) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={`${styles.separator} ${className ?? ''}`}
      data-slot="select-separator"
    />
  );
}
