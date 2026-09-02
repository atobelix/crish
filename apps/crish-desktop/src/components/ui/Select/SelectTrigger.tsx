import React, { forwardRef, useCallback } from 'react';
import { useSelectContext } from './SelectRoot';
import { ChevronUpDownIcon } from './internal/SelectIcons';
import { SelectClearButton } from './SelectClearButton';
import type { SelectTriggerProps } from './types';
import styles from './SelectTrigger.module.css';

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger(
    {
      startSlot,
      endSlot,
      clearable: propClearable,
      className,
      children,
      onKeyDown,
      onClick,
      disabled: propDisabled,
      ...restProps
    },
    forwardedRef
  ) {
    const ctx = useSelectContext('SelectTrigger');
    const disabled = propDisabled ?? ctx.disabled;
    const isClearable = propClearable ?? ctx.clearable;
    const hasValue = ctx.multiple
      ? Array.isArray(ctx.value) && ctx.value.length > 0
      : ctx.value != null && ctx.value !== '';

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        if (disabled) return;
        onClick?.(e);
        if (!e.defaultPrevented) {
          ctx.setOpen(!ctx.open);
        }
      },
      [disabled, onClick, ctx]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || disabled) return;

        if (!ctx.open) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            ctx.setOpen(true);
          } else if ((e.key === 'Backspace' || e.key === 'Delete') && isClearable && hasValue) {
            e.preventDefault();
            ctx.clear(e);
          }
          return;
        }

        const enabledIndices = ctx.items
          .map((item, idx) => (!item.disabled ? idx : -1))
          .filter((idx) => idx !== -1);

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (enabledIndices.length > 0) {
            const currentPos = enabledIndices.indexOf(ctx.highlightedIndex);
            const nextPos =
              currentPos < 0 ? 0 : (currentPos + 1) % enabledIndices.length;
            ctx.setHighlightedIndex(enabledIndices[nextPos]!);
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (enabledIndices.length > 0) {
            const currentPos = enabledIndices.indexOf(ctx.highlightedIndex);
            const prevPos =
              currentPos <= 0
                ? enabledIndices.length - 1
                : currentPos - 1;
            ctx.setHighlightedIndex(enabledIndices[prevPos]!);
          }
        } else if (e.key === 'Home') {
          e.preventDefault();
          if (enabledIndices.length > 0) {
            ctx.setHighlightedIndex(enabledIndices[0]!);
          }
        } else if (e.key === 'End') {
          e.preventDefault();
          if (enabledIndices.length > 0) {
            ctx.setHighlightedIndex(enabledIndices[enabledIndices.length - 1]!);
          }
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (ctx.highlightedIndex >= 0 && ctx.items[ctx.highlightedIndex]) {
            const target = ctx.items[ctx.highlightedIndex];
            if (target && !target.disabled) {
              ctx.selectValue(target.value);
            }
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          ctx.setOpen(false);
        } else if ((e.key === 'Backspace' || e.key === 'Delete') && isClearable && hasValue) {
          e.preventDefault();
          ctx.clear(e);
        }
      },
      [disabled, onKeyDown, ctx, isClearable, hasValue]
    );

    const sizeClass =
      ctx.size === 'sm'
        ? styles.triggerSm
        : ctx.size === 'lg'
          ? styles.triggerLg
          : styles.triggerMd;

    const variantClass =
      ctx.variant === 'soft' ? styles.triggerSoft : styles.triggerOutline;

    const triggerClass = [
      styles.trigger,
      sizeClass,
      variantClass,
      ctx.error ? styles.triggerError : null,
      ctx.open ? styles.open : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={(el) => {
          (ctx.triggerRef as React.MutableRefObject<HTMLElement | null>).current = el;
          if (typeof forwardedRef === 'function') forwardedRef(el);
          else if (forwardedRef) forwardedRef.current = el;
        }}
        id={ctx.triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={ctx.open}
        aria-controls={ctx.listboxId}
        aria-activedescendant={ctx.activeDescendantId}
        aria-disabled={disabled}
        aria-invalid={Boolean(ctx.error)}
        disabled={disabled}
        className={triggerClass}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        data-slot="select-trigger"
        data-state={ctx.open ? 'open' : 'closed'}
        {...restProps}
      >
        {startSlot && <span className={styles.startSlot}>{startSlot}</span>}
        <span className={styles.value}>{children}</span>
        {isClearable && hasValue && !disabled && (
          <SelectClearButton onClick={(e) => ctx.clear(e)} />
        )}
        {endSlot && <span className={styles.endSlot}>{endSlot}</span>}
        <span className={styles.chevron} aria-hidden="true">
          <ChevronUpDownIcon size={ctx.size === 'lg' ? 16 : 14} />
        </span>
      </button>
    );
  }
);
