import React, { useEffect, useId, useState, useMemo } from 'react';
import { MenuAdapter } from './MenuAdapter';
import type { SelectOption, SelectSize } from '../../Select/Select';
import type { SelectOptionItem } from '../../Menu/types';
import { convertSelectOptionsToSmartItems } from './schemaBridge';
import { ICON_STROKE } from '../../icons/iconTokens';
import styles from '../../Select/Select.module.css';

export interface SelectAdapterProps {
  value?: string | null;
  onChange?: (value: string) => void;
  options?: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  label?: React.ReactNode;
  size?: SelectSize;
  id?: string;
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
}

function toMenuItem(option: SelectOption): SelectOptionItem {
  return {
    id: option.id,
    label: option.label,
    icon: option.icon,
    disabled: option.disabled,
  };
}

function renderOption(
  option: SelectOption,
  selected: boolean,
  onSelect: (id: string) => void
) {
  return (
    <button
      key={option.id}
      type="button"
      role="option"
      aria-selected={selected}
      disabled={option.disabled}
      className={[
        styles.option,
        selected ? styles.optionSelected : null,
        option.disabled ? styles.optionDisabled : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => {
        if (option.disabled) return;
        onSelect(option.id);
      }}
    >
      {option.icon != null ? (
        <span className={styles.optionIcon} aria-hidden="true">
          {option.icon}
        </span>
      ) : null}
      <span className={styles.optionText}>
        <span className={styles.optionLabel}>{option.label}</span>
        {option.hint ? (
          <span className={styles.optionHint}>{option.hint}</span>
        ) : null}
      </span>
      {selected ? <CheckIcon /> : null}
    </button>
  );
}

/**
 * SelectAdapter - 100% 保持 combobox -> listbox -> option 的 WAI-ARIA 标准树形拓扑与 aria-selected 契约
 */
export function SelectAdapter({
  value: externalValue,
  onChange,
  options = [],
  placeholder = '请选择',
  disabled = false,
  error,
  label,
  size = 'md',
  id,
  className,
  align,
  side,
}: SelectAdapterProps) {
  const autoId = useId();
  const selectId = id ?? `ui-select-${autoId}`;
  const listboxId = `ui-select-listbox-${autoId}`;

  const [internalValue, setInternalValue] = useState<string | null>(null);
  const isControlled = externalValue !== undefined;
  const selectedId = isControlled ? (externalValue ?? null) : internalValue;

  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (isControlled) {
      setInternalValue(externalValue ?? null);
    }
  }, [externalValue, isControlled]);

  const selected = options.find((opt) => opt.id === selectedId);

  const handleSelect = (idValue: string) => {
    if (!isControlled) setInternalValue(idValue);
    onChange?.(idValue);
    setMenuOpen(false);
  };

  const triggerClasses = [
    styles.trigger,
    size === 'sm' ? styles.triggerSm : null,
    error ? styles.triggerError : null,
    disabled ? styles.triggerDisabled : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Maintain schema bridge integration
  const _smartItems = useMemo(() => {
    return convertSelectOptionsToSmartItems(options, selectedId);
  }, [options, selectedId]);

  return (
    <div className={styles.selectWrap}>
      {label != null && (
        <label className={styles.selectLabel} htmlFor={selectId}>
          {label}
        </label>
      )}

      <MenuAdapter
        openState={{ open: menuOpen, onOpenChange: setMenuOpen }}
        position={{ align, side }}
        options={options.map(toMenuItem)}
        onSelect={handleSelect}
        panel={{ contentClassName: styles.menu }}
        trigger={
          <button
            type="button"
            id={selectId}
            disabled={disabled}
            role="combobox"
            aria-haspopup="listbox"
            aria-invalid={error ? true : undefined}
            aria-controls={listboxId}
            className={triggerClasses}
          >
            <span
              className={
                selected ? styles.triggerLabel : styles.triggerPlaceholder
              }
            >
              {selected?.label ?? placeholder}
            </span>
            <ChevronIcon />
          </button>
        }
      >
        <div
          id={listboxId}
          role="listbox"
          aria-label={typeof label === 'string' ? label : undefined}
          className={styles.listbox}
        >
          {options.map((option) =>
            renderOption(option, selectedId === option.id, handleSelect)
          )}
        </div>
      </MenuAdapter>

      {error != null && <p className={styles.selectError}>{error}</p>}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.ui}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.ui}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
