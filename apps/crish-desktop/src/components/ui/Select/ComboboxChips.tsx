import React, { useCallback, useEffect } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { ComboboxChip } from './ComboboxChip';
import { ClearIcon } from './internal/SelectIcons';
import type { ComboboxChipsProps } from './types';
import styles from './Combobox.module.css';

export function ComboboxChips({
  placeholder = '搜索或选择...',
  inputProps,
  clearable = false,
  startSlot,
  className,
  children,
  onClick,
  ...restProps
}: ComboboxChipsProps) {
  const ctx = useComboboxContext('ComboboxChips');
  const valuesArray = Array.isArray(ctx.value) ? ctx.value : [];

  useEffect(() => {
    if (ctx.activeChipIndex >= valuesArray.length) {
      ctx.setActiveChipIndex(valuesArray.length - 1);
    }
  }, [valuesArray.length, ctx.activeChipIndex, ctx]);

  const handleWrapperClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
      ctx.inputRef.current?.focus();
      if (!ctx.open) ctx.setOpen(true);
    },
    [onClick, ctx]
  );

  const handleInputFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      inputProps?.onFocus?.(e);
      if (!ctx.open) ctx.setOpen(true);
    },
    [inputProps, ctx]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      inputProps?.onKeyDown?.(e);
      if (e.defaultPrevented || ctx.disabled) return;

      if (e.key === 'Backspace' && !ctx.query && valuesArray.length > 0) {
        if (
          ctx.activeChipIndex >= 0 &&
          ctx.activeChipIndex < valuesArray.length
        ) {
          const valToRemove = valuesArray[ctx.activeChipIndex];
          if (valToRemove !== undefined) {
            ctx.removeChip(valToRemove);
            ctx.setActiveChipIndex(-1);
          }
        } else {
          ctx.setActiveChipIndex(valuesArray.length - 1);
        }
      } else if (
        e.key === 'ArrowLeft' &&
        !ctx.query &&
        valuesArray.length > 0
      ) {
        ctx.setActiveChipIndex((prev) =>
          prev > 0 ? prev - 1 : valuesArray.length - 1
        );
      } else if (
        e.key === 'ArrowRight' &&
        !ctx.query &&
        ctx.activeChipIndex >= 0
      ) {
        ctx.setActiveChipIndex((prev) =>
          prev < valuesArray.length - 1 ? prev + 1 : -1
        );
      } else if (ctx.activeChipIndex >= 0 && e.key !== 'Backspace') {
        ctx.setActiveChipIndex(-1);
      }
    },
    [inputProps, ctx, valuesArray]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      inputProps?.onChange?.(e);
      if (!e.defaultPrevented) {
        ctx.setQuery(e.target.value);
        ctx.setActiveChipIndex(-1);
        if (!ctx.open) ctx.setOpen(true);
      }
    },
    [inputProps, ctx]
  );

  return (
    <div
      ref={(el) => {
        (ctx.triggerRef as React.MutableRefObject<HTMLElement | null>).current =
          el;
      }}
      className={`${styles.chipsWrapper} ${className ?? ''}`}
      onClick={handleWrapperClick}
      data-slot="combobox-chips"
      {...restProps}
    >
      {startSlot && <span className={styles.startSlot}>{startSlot}</span>}
      {children
        ? children
        : valuesArray.map((val, idx) => (
            <ComboboxChip
              key={val}
              value={val}
              className={
                ctx.activeChipIndex === idx ? styles.chipActive : undefined
              }
            />
          ))}
      <input
        ref={(el) => {
          (
            ctx.inputRef as React.MutableRefObject<HTMLInputElement | null>
          ).current = el;
        }}
        id={ctx.triggerId}
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-expanded={ctx.open}
        aria-haspopup="listbox"
        aria-controls={ctx.listboxId}
        aria-activedescendant={ctx.activeDescendantId}
        disabled={ctx.disabled}
        placeholder={valuesArray.length === 0 ? placeholder : ''}
        value={ctx.query}
        className={styles.chipsInput}
        onFocus={handleInputFocus}
        onChange={handleInputChange}
        onKeyDown={handleInputKeyDown}
        {...inputProps}
      />
      {clearable && valuesArray.length > 0 && !ctx.disabled && (
        <button
          type="button"
          className={styles.clearBtn}
          aria-label="清空所有选项"
          onClick={(e) => ctx.clear(e)}
        >
          <ClearIcon size={12} />
        </button>
      )}
    </div>
  );
}
