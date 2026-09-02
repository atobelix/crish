import React from 'react';
import type { ComboboxSeparatorProps } from './types';
import styles from './SelectContent.module.css';

export function ComboboxSeparator({ className }: ComboboxSeparatorProps) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={`${styles.separator} ${className ?? ''}`}
      data-slot="combobox-separator"
    />
  );
}
