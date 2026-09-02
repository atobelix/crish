import React from 'react';
import { useSelectContext } from './SelectRoot';
import type { SelectValueProps } from './types';
import styles from './SelectTrigger.module.css';

export function SelectValue({
  placeholder = '请选择...',
  className,
  children,
}: SelectValueProps) {
  const ctx = useSelectContext('SelectValue');

  if (children) {
    const rendered = typeof children === 'function' ? children(ctx.value) : children;
    return (
      <span className={`${styles.value} ${className ?? ''}`} data-slot="select-value">
        {rendered}
      </span>
    );
  }

  const hasValue = ctx.multiple
    ? Array.isArray(ctx.value) && ctx.value.length > 0
    : ctx.value != null && ctx.value !== '';

  if (!hasValue) {
    return (
      <span
        className={`${styles.value} ${styles.placeholder} ${className ?? ''}`}
        data-slot="select-value"
      >
        {placeholder}
      </span>
    );
  }

  if (ctx.multiple && Array.isArray(ctx.value)) {
    const labels = ctx.value.map((v) => ctx.itemMap.get(v)?.label || v);
    return (
      <span className={`${styles.value} ${className ?? ''}`} data-slot="select-value">
        {labels.join(', ')}
      </span>
    );
  }

  const currentLabel =
    typeof ctx.value === 'string'
      ? ctx.itemMap.get(ctx.value)?.label || ctx.value
      : String(ctx.value ?? '');

  return (
    <span className={`${styles.value} ${className ?? ''}`} data-slot="select-value">
      {currentLabel}
    </span>
  );
}
