import React from 'react';
import { useComboboxContext } from './ComboboxRoot';
import type { ComboboxListProps } from './types';
import styles from './Combobox.module.css';

export function ComboboxList<T = any>({
  cols: propCols,
  className,
  children,
}: ComboboxListProps<T>) {
  const ctx = useComboboxContext('ComboboxList');
  const cols = propCols ?? ctx.cols;
  const isGrid = ctx.grid || cols > 1;

  const listStyle = isGrid
    ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
    : undefined;

  let content: React.ReactNode = null;
  if (typeof children === 'function') {
    content = (ctx.filteredItems as T[]).map((item, index) =>
      (children as (item: T, index: number) => React.ReactNode)(item, index)
    );
  } else {
    content = children;
  }

  return (
    <div
      className={`${isGrid ? styles.gridList : ''} ${className ?? ''}`}
      style={listStyle}
      data-slot="combobox-list"
    >
      {content}
    </div>
  );
}
