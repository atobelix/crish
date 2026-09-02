import React from 'react';
import type { SelectGroupProps, SelectGroupLabelProps } from './types';
import styles from './SelectContent.module.css';

export function SelectGroup({ className, children }: SelectGroupProps) {
  return (
    <div
      role="group"
      className={`${styles.group} ${className ?? ''}`}
      data-slot="select-group"
    >
      {children}
    </div>
  );
}

export function SelectGroupLabel({ className, children }: SelectGroupLabelProps) {
  return (
    <div
      className={`${styles.groupLabel} ${className ?? ''}`}
      data-slot="select-group-label"
    >
      {children}
    </div>
  );
}

export const SelectLabel = SelectGroupLabel;
