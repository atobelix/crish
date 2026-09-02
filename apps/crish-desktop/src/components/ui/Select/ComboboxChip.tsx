import React, { useCallback } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { ClearIcon } from './internal/SelectIcons';
import type { ComboboxChipProps } from './types';
import styles from './Combobox.module.css';

export function ComboboxChip({
  value,
  label,
  onRemove,
  disabled = false,
  className,
  children,
}: ComboboxChipProps) {
  const ctx = useComboboxContext('ComboboxChip');

  const displayLabel = children ?? label ?? (ctx.itemMap.get(value)?.label || value);

  const handleRemove = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();
      if (disabled || ctx.disabled) return;
      if (onRemove) onRemove();
      else ctx.removeChip(value);
    },
    [disabled, ctx, onRemove, value]
  );

  return (
    <span
      className={`${styles.chip} ${disabled ? styles.chipDisabled : ''} ${className ?? ''}`}
      data-slot="combobox-chip"
      data-value={value}
    >
      <span className={styles.chipLabel}>{displayLabel}</span>
      {!disabled && !ctx.disabled && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Remove ${displayLabel}`}
          className={styles.chipRemove}
          onClick={handleRemove}
        >
          <ClearIcon size={10} />
        </button>
      )}
    </span>
  );
}
