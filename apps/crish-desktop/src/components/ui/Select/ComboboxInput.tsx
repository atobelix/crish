import React, { forwardRef, useCallback, useRef } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { ChevronUpDownIcon, ClearIcon } from './internal/SelectIcons';
import type { ComboboxInputProps } from './types';
import styles from './Combobox.module.css';

export const ComboboxInput = forwardRef<HTMLInputElement, ComboboxInputProps>(
  function ComboboxInput(
    {
      startSlot,
      endSlot,
      clearable: propClearable,
      icon = true,
      wrapperClassName,
      className,
      value: propValue,
      placeholder,
      onFocus,
      onClick,
      onChange,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      ...restProps
    },
    forwardedRef
  ) {
    const ctx = useComboboxContext('ComboboxInput');
    const isClearable = propClearable ?? ctx.clearable;

    const compositionEndStampRef = useRef(0);

    const handleCompositionStart = useCallback(
      (e: React.CompositionEvent<HTMLInputElement>) => {
        ctx.isComposingRef.current = true;
        onCompositionStart?.(e);
      },
      [ctx.isComposingRef, onCompositionStart]
    );

    const handleCompositionEnd = useCallback(
      (e: React.CompositionEvent<HTMLInputElement>) => {
        ctx.isComposingRef.current = false;
        compositionEndStampRef.current = Date.now();
        onCompositionEnd?.(e);
      },
      [ctx.isComposingRef, onCompositionEnd]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(e);
        if (
          e.defaultPrevented ||
          ctx.disabled ||
          ctx.isComposingRef.current ||
          e.nativeEvent.isComposing ||
          e.keyCode === 229 ||
          e.key === 'Process'
        ) {
          return;
        }

        const items = ctx.items.filter((i) => !i.disabled);

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!ctx.open) {
            ctx.setOpen(true);
          } else if (items.length > 0) {
            ctx.setHighlightedIndex((prev) => {
              const next = prev + 1;
              return next >= ctx.items.length ? 0 : next;
            });
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (ctx.open && items.length > 0) {
            ctx.setHighlightedIndex((prev) => {
              const next = prev - 1;
              return next < 0 ? ctx.items.length - 1 : next;
            });
          }
        } else if (e.key === 'Enter') {
          if (ctx.open) {
            const targetIndex = ctx.highlightedIndex >= 0 ? ctx.highlightedIndex : 0;
            const target = ctx.items[targetIndex];
            if (target && !target.disabled) {
              e.preventDefault();
              ctx.selectValue(target.value);
            }
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          ctx.setOpen(false);
        }
      },
      [ctx, onKeyDown]
    );

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        onChange?.(e);
        if (!e.defaultPrevented) {
          ctx.setQuery(e.target.value);
          if (!ctx.open) ctx.setOpen(true);
        }
      },
      [onChange, ctx]
    );

    const handleFocus = useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        onFocus?.(e);
        if (!ctx.open) ctx.setOpen(true);
      },
      [onFocus, ctx]
    );

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLInputElement>) => {
        onClick?.(e);
        if (!ctx.open) ctx.setOpen(true);
      },
      [onClick, ctx]
    );

    const wrapperClass = [
      styles.comboboxInputWrapper,
      styles[`size-${ctx.size}`],
      wrapperClassName,
    ]
      .filter(Boolean)
      .join(' ');

    const hasValue = Boolean(ctx.query);

    return (
      <div
        ref={(el) => {
          (ctx.triggerRef as React.MutableRefObject<HTMLElement | null>).current = el;
        }}
        className={wrapperClass}
        data-slot="combobox-input-wrapper"
      >
        {startSlot && <span className={styles.startSlot}>{startSlot}</span>}
        <input
          ref={(el) => {
            (ctx.inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
            if (typeof forwardedRef === 'function') forwardedRef(el);
            else if (forwardedRef) forwardedRef.current = el;
          }}
          id={ctx.triggerId}
          type="text"
          role="combobox"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-expanded={ctx.open}
          aria-haspopup="listbox"
          aria-controls={ctx.listboxId}
          aria-activedescendant={ctx.activeDescendantId}
          aria-autocomplete="list"
          disabled={ctx.disabled}
          placeholder={placeholder}
          value={propValue !== undefined ? propValue : ctx.query}
          className={`${styles.comboboxInput} ${className ?? ''}`}
          onChange={handleChange}
          onFocus={handleFocus}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          {...restProps}
        />
        {isClearable && hasValue && !ctx.disabled && (
          <button
            type="button"
            className={styles.clearBtn}
            aria-label="清空输入"
            onClick={(e) => ctx.clear(e)}
          >
            <ClearIcon size={12} />
          </button>
        )}
        {endSlot && <span className={styles.endSlot}>{endSlot}</span>}
        {icon && (
          <span className={styles.chevron} aria-hidden="true">
            {typeof icon === 'boolean' ? <ChevronUpDownIcon size={14} /> : icon}
          </span>
        )}
      </div>
    );
  }
);
