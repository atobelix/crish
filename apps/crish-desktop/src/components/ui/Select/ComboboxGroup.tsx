import React from 'react';
import type { ComboboxGroupProps } from './types';
import styles from './SelectContent.module.css';

export function ComboboxGroup({ className, children }: ComboboxGroupProps) {
  return (
    <div
      role="group"
      className={`${styles.group} ${className ?? ''}`}
      data-slot="combobox-group"
    >
      {children}
    </div>
  );
}
