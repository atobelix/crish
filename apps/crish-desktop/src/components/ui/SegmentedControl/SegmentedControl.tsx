/**
 * apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx
 *
 * ui/SegmentedControl 原子分段选择器 (v2.1 连续物理弹簧与 FLIP 共享布局版)
 *
 * 核心特性：
 * 1. 彻底根治激活项 Hover 灰度二次加深 Bug（Double Alpha Stacking 消除）；
 * 2. 引入 14px 外壳 + 11px 滑块 SmartPanel 同心大圆角体系（size="panel"）；
 * 3. 升级为二阶谐振子物理弹簧（stiffness: 420, damping: 32, bounce: 0）；
 * 4. 彻底清退 ResizeObserver 与命令式 DOM 测量，全面接入 Framer Motion layoutId FLIP 投影；
 * 5. WAI-ARIA 1.2 RadioGroup 规范与 Home/End/Arrow 键盘漫游；
 * 6. 零外部重型 UI 库依赖，符合架构治理契约。
 */
import React, { useCallback, useId, useRef, useState } from 'react';
import { m, LayoutGroup } from 'motion/react';
import styles from './SegmentedControl.module.css';
import { SPRING_SWITCH_SLIDER } from '../../../utils/motionTokens';

export type SegmentedControlSize = 'xs' | 'sm' | 'md' | 'lg' | 'panel';

export interface SegmentedControlOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
}

export interface SegmentedControlProps<T extends string = string> extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onChange' | 'defaultValue'
> {
  options: (SegmentedControlOption<T> | T)[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  size?: SegmentedControlSize;
  disabled?: boolean;
  block?: boolean;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

function normalizeOption<T extends string>(
  raw: SegmentedControlOption<T> | T
): SegmentedControlOption<T> {
  if (typeof raw === 'string') {
    return { value: raw as T, label: raw };
  }
  return raw;
}

export const SegmentedControl = React.forwardRef<
  HTMLDivElement,
  SegmentedControlProps
>(function SegmentedControl(
  {
    options: rawOptions,
    value: externalValue,
    defaultValue,
    onChange,
    size = 'sm',
    disabled = false,
    block = false,
    className,
    style,
    'aria-label': ariaLabel,
    ...restProps
  },
  ref
) {
  const baseId = useId();
  const options = rawOptions.map(normalizeOption);
  const isControlled = externalValue !== undefined;
  const initialValue =
    defaultValue ?? (options.length > 0 ? (options[0]?.value ?? '') : '');
  const [internalValue, setInternalValue] = useState<string>(initialValue);
  const currentValue = isControlled ? (externalValue ?? '') : internalValue;

  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleSelect = useCallback(
    (val: string, optionDisabled?: boolean) => {
      if (disabled || optionDisabled) return;
      if (!isControlled) {
        setInternalValue(val);
      }
      if (val !== currentValue) {
        onChange?.(val);
      }
    },
    [disabled, isControlled, currentValue, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || options.length === 0 || e.nativeEvent.isComposing) return;
    const enabledOptions = options.filter((o) => !o.disabled);
    if (enabledOptions.length === 0) return;

    let targetOption: SegmentedControlOption<string> | undefined;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const currentIdx = enabledOptions.findIndex(
        (o) => o.value === currentValue
      );
      const nextIdx = (currentIdx + 1) % enabledOptions.length;
      targetOption = enabledOptions[nextIdx];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const currentIdx = enabledOptions.findIndex(
        (o) => o.value === currentValue
      );
      const prevIdx =
        currentIdx <= 0 ? enabledOptions.length - 1 : currentIdx - 1;
      targetOption = enabledOptions[prevIdx];
    } else if (e.key === 'Home') {
      e.preventDefault();
      targetOption = enabledOptions[0];
    } else if (e.key === 'End') {
      e.preventDefault();
      targetOption = enabledOptions[enabledOptions.length - 1];
    }

    if (targetOption) {
      handleSelect(targetOption.value);
      const nextEl = containerRef.current?.querySelector<HTMLElement>(
        `[data-value="${CSS.escape(targetOption.value)}"]`
      );
      nextEl?.focus();
    }
  };

  const hasSelectedMatch = options.some((o) => o.value === currentValue);

  const wrapClasses = [
    styles.container,
    size === 'xs'
      ? styles.containerXs
      : size === 'sm'
        ? styles.containerSm
        : size === 'md'
          ? styles.containerMd
          : size === 'lg'
            ? styles.containerLg
            : styles.containerPanel,
    block ? styles.containerBlock : null,
    disabled ? styles.containerDisabled : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <LayoutGroup id={baseId}>
      <div
        ref={(node) => {
          containerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref)
            (ref as React.MutableRefObject<HTMLDivElement | null>).current =
              node;
        }}
        role="radiogroup"
        aria-label={ariaLabel}
        className={wrapClasses}
        data-size={size}
        style={style}
        {...restProps}
        onKeyDown={(e) => {
          restProps.onKeyDown?.(e);
          if (!e.defaultPrevented) {
            handleKeyDown(e);
          }
        }}
      >
        {options.map((opt, idx) => {
          const isSelected = opt.value === currentValue;
          const isItemDisabled = disabled || Boolean(opt.disabled);
          const itemId = `${baseId}-opt-${idx}`;
          const tabIndex = isSelected
            ? 0
            : !hasSelectedMatch && idx === 0
              ? 0
              : -1;

          return (
            <button
              key={opt.value}
              id={itemId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={opt['aria-label']}
              data-value={opt.value}
              data-active={isSelected ? 'true' : 'false'}
              disabled={isItemDisabled}
              tabIndex={tabIndex}
              className={[
                styles.item,
                isSelected ? styles.itemActive : null,
                isItemDisabled ? styles.itemDisabled : null,
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleSelect(opt.value, opt.disabled)}
            >
              {isSelected && (
                <m.div
                  className={styles.activeSlider}
                  layoutId={`${baseId}-active-indicator`}
                  transition={SPRING_SWITCH_SLIDER}
                  aria-hidden="true"
                />
              )}
              <span className={styles.itemInner}>
                {opt.icon && (
                  <span className={styles.itemIcon} aria-hidden="true">
                    {opt.icon}
                  </span>
                )}
                <span className={styles.itemLabel}>{opt.label}</span>
                {opt.badge && (
                  <span className={styles.itemBadge}>{opt.badge}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
});

SegmentedControl.displayName = 'SegmentedControl';
