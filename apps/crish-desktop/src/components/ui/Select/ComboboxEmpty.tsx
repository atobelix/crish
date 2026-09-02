import React from 'react';
import type { ComboboxEmptyProps } from './types';
import styles from './Combobox.module.css';

export function ComboboxEmpty({ className, children = '无匹配结果' }: ComboboxEmptyProps) {
  return (
    <div
      className={`${styles.empty} ${className ?? ''}`}
      data-slot="combobox-empty"
    >
      {children}
    </div>
  );
}
