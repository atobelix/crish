/**
 * ui/Select 受控选择器（PE-05 T05.1.6）
 *
 * 基于 ui/Menu 基座的 listbox 语义选择器：坐标/Esc/外点关闭/键盘漫游
 * 全部来自 Menu 基座（T05.3.2 中 SettingsSelect 迁移即以此为落点）。
 *
 * 结构：combobox 触发器（aria-haspopup=listbox，aria-expanded 由 Menu
 * 基座的 Radix Trigger 注入）+ listbox 选项区（role=option + aria-selected）。
 * 面板开关走 Menu 受控双模：选择后由本组件关闭。
 *
 * 分层契约：只依赖 react 与 tokens CSS 变量；动画/定位由 Menu 基座承担。
 */
import React, { useEffect, useId, useState } from 'react';
import { Menu } from '../Menu/Menu';
import type { SelectOptionItem } from '../Menu/types';
import styles from './Select.module.css';

export interface SelectOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** 选项辅助说明（行内次级文案；菜单开时 Tooltip 会被静音，故不用 Tooltip） */
  hint?: string;
}

export interface SelectProps {
  /** 受控选中值；null 表示未选择 */
  value?: string | null;
  /** 选中变更回调 */
  onChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** 校验错误文案（aria-invalid + 错误描边） */
  error?: string;
  /** 字段标签（关联触发器） */
  label?: React.ReactNode;
  /** 尺寸：sm 对齐 control-height-sm */
  size?: 'sm' | 'md';
  /** 触发器 id（label 关联目标） */
  id?: string;
  /** 追加到触发器的类名 */
  className?: string;
  /** 面板水平对齐 */
  align?: 'start' | 'center' | 'end';
  /** 面板弹出方向 */
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

/** 选项节点：hint 作为行内次级文案（菜单开着时 isTooltipSilenced 会灭 Tooltip） */
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
 * 受控选择器：value 传入时完全受控，未传时内部自管（仍以 onChange 上报）。
 */
export function Select({
  value: externalValue,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  error,
  label,
  size = 'md',
  id,
  className,
  align,
  side,
}: SelectProps) {
  const autoId = useId();
  const selectId = id ?? `ui-select-${autoId}`;
  const listboxId = `ui-select-listbox-${autoId}`;

  const [internalValue, setInternalValue] = useState<string | null>(null);
  const isControlled = externalValue !== undefined;
  const selectedId = isControlled ? (externalValue ?? null) : internalValue;

  // 面板开关：Menu 受控双模（外部 onOpenChange 桥接，保证状态一致）
  const [menuOpen, setMenuOpen] = useState(false);

  // 外部受控值变化时同步内部状态
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

  return (
    <div className={styles.selectWrap}>
      {label != null ? (
        <label className={styles.selectLabel} htmlFor={selectId}>
          {label}
        </label>
      ) : null}

      <Menu
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
      </Menu>

      {error != null ? <p className={styles.selectError}>{error}</p> : null}
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
      strokeWidth="2"
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
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
