import React from 'react';
import type { ComboboxLabelProps } from './types';
import styles from './SelectContent.module.css';

export function ComboboxLabel({ className, children }: ComboboxLabelProps) {
  return (
    <div
      className={`${styles.groupLabel} ${className ?? ''}`}
      data-slot="combobox-label"
    >
      {children}
    </div>
  );
}
