import React from 'react';
import type { SelectIconProps } from './types';
import styles from './SelectTrigger.module.css';

export function SelectIcon({ className, children }: SelectIconProps) {
  return (
    <span
      className={`${styles.chevron} ${className ?? ''}`}
      aria-hidden="true"
      data-slot="select-icon"
    >
      {children}
    </span>
  );
}
