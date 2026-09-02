import React, { useId, useEffect, useCallback, useMemo } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { CheckIcon } from './internal/SelectIcons';
import { highlightMatches } from './internal/comboboxHighlight';
import type { ComboboxItemProps } from './types';
import styles from './SelectContent.module.css';

export function ComboboxItem({
  value,
  label,
  disabled = false,
  icon,
  hint,
  shortcut,
  autoHighlight = true,
  className,
  children,
  onClick,
}: ComboboxItemProps) {
  const ctx = useComboboxContext('ComboboxItem');
  const registerItem = ctx.registerItem;
  const autoId = useId();
  const itemId = `${ctx.listboxId}-item-${autoId}`;

  const labelText = useMemo(() => {
    if (label) return label;
    if (typeof children === 'string') return children;
    return value;
  }, [label, children, value]);

  useEffect(() => {
    return registerItem(itemId, value, disabled, labelText);
  }, [registerItem, itemId, value, disabled, labelText]);

  const isSelected = useMemo(() => {
    if (ctx.multiple && Array.isArray(ctx.value)) {
      return ctx.value.includes(value);
    }
    return ctx.value === value;
  }, [ctx.multiple, ctx.value, value]);

  const itemIndex = ctx.items.findIndex((i) => i.id === itemId);
  const isHighlighted = ctx.highlightedIndex >= 0 && ctx.highlightedIndex === itemIndex;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled) return;
      onClick?.(e);
      if (!e.defaultPrevented) {
        ctx.selectValue(value);
      }
    },
    [disabled, onClick, ctx, value]
  );

  const handleMouseEnter = useCallback(() => {
    if (!disabled && itemIndex >= 0) {
      ctx.setHighlightedIndex(itemIndex);
    }
  }, [disabled, itemIndex, ctx]);

  const itemClass = [
    styles.item,
    isSelected ? styles.itemSelected : null,
    isHighlighted ? styles.itemHighlighted : null,
    disabled ? styles.itemDisabled : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const content = autoHighlight && typeof labelText === 'string'
    ? highlightMatches(children ?? labelText, ctx.query)
    : children ?? labelText;

  return (
    <button
      id={itemId}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={isSelected}
      aria-disabled={disabled}
      disabled={disabled}
      data-index={itemIndex}
      data-value={value}
      data-slot="combobox-item"
      data-highlighted={isHighlighted ? '' : undefined}
      className={itemClass}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
    >
      {icon && <span className={styles.itemIcon}>{icon}</span>}
      {hint ? (
        <div className={styles.textCol}>
          <span className={styles.title}>{content}</span>
          <span className={styles.desc}>{hint}</span>
        </div>
      ) : (
        <span className={styles.itemLabel}>{content}</span>
      )}
      {shortcut && <span className={styles.itemShortcut}>{shortcut}</span>}
      {isSelected && (
        <span className={styles.itemCheck}>
          <CheckIcon size={14} />
        </span>
      )}
    </button>
  );
}
