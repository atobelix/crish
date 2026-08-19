/**
 * ui/SegmentedControl 原子分段选择器（RED-DETAILED-02 / T-ATOM-06）
 *
 * 圆角锁：外框与分段按钮走 --button-radius（7px）；严禁 8px 硬编码与 9999px 药丸。
 * 落实 FLIP 动态平滑滑块与无障碍键盘漫游（ArrowLeft / ArrowRight）。
 * 支持受控/非受控双模。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ResizeObserverManager } from '../../../services/ResizeObserverManager';
import styles from './SegmentedControl.module.css';

export type SegmentedControlSize = 'xs' | 'sm' | 'md';

export interface SegmentedControlOption {
  /** 选项值唯一标识 */
  value: string;
  /** 选项显示文案或节点 */
  label: React.ReactNode;
  /** 可选图标位 */
  icon?: React.ReactNode;
  /** 禁用该单个选项 */
  disabled?: boolean;
  /** 显式无障碍标签 */
  'aria-label'?: string;
}

export interface SegmentedControlProps {
  /** 选项数组 */
  options: (SegmentedControlOption | string)[];
  /** 受控选中值 */
  value?: string;
  /** 非受控默认初始选中值 */
  defaultValue?: string;
  /** 选中值变更回调 */
  onChange?: (value: string) => void;
  /** 尺寸：xs(24px) / sm(28px) / md(32px) */
  size?: SegmentedControlSize;
  /** 禁用整组分段控制器 */
  disabled?: boolean;
  /** 通栏撑满容器宽度 */
  block?: boolean;
  /** 自定义外层类名 */
  className?: string;
  /** 无障碍组名 */
  'aria-label'?: string;
}

function normalizeOption(
  raw: SegmentedControlOption | string
): SegmentedControlOption {
  if (typeof raw === 'string') {
    return { value: raw, label: raw };
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
    'aria-label': ariaLabel,
    ...restProps
  },
  ref
) {
  const options = rawOptions.map(normalizeOption);
  const isControlled = externalValue !== undefined;
  const initialValue =
    defaultValue ?? (options.length > 0 ? (options[0]?.value ?? '') : '');
  const [internalValue, setInternalValue] = useState<string>(initialValue);
  const currentValue = isControlled ? (externalValue ?? '') : internalValue;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [sliderStyle, setSliderStyle] = useState<{
    left: number;
    width: number;
    opacity: number;
  }>({ left: 0, width: 0, opacity: 0 });

  // 同步测量选中项的几何尺寸与位移，驱动滑块平滑滑动
  const updateSlider = useCallback(() => {
    if (!containerRef.current) return;
    const activeItem = containerRef.current.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(currentValue)}"]`
    );
    if (activeItem) {
      setSliderStyle({
        left: activeItem.offsetLeft,
        width: activeItem.offsetWidth,
        opacity: 1,
      });
    } else {
      setSliderStyle((prev) => ({ ...prev, opacity: 0 }));
    }
  }, [currentValue]);

  useEffect(() => {
    updateSlider();
    const el = containerRef.current;
    if (!el) return;
    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, updateSlider);
    return () => {
      ro.unobserve(el, updateSlider);
    };
  }, [updateSlider, options.length, size]);

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

  // 左右方向键漫游支持 (Roving A11y Tabindex)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || options.length === 0) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const enabledOptions = options.filter((o) => !o.disabled);
      if (enabledOptions.length === 0) return;
      const currentIdx = enabledOptions.findIndex(
        (o) => o.value === currentValue
      );
      const nextIdx = (currentIdx + 1) % enabledOptions.length;
      const nextOption = enabledOptions[nextIdx];
      if (nextOption) {
        handleSelect(nextOption.value);
        // 聚焦到新选中的按钮
        const nextEl = containerRef.current?.querySelector<HTMLElement>(
          `[data-value="${CSS.escape(nextOption.value)}"]`
        );
        nextEl?.focus();
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const enabledOptions = options.filter((o) => !o.disabled);
      if (enabledOptions.length === 0) return;
      const currentIdx = enabledOptions.findIndex(
        (o) => o.value === currentValue
      );
      const prevIdx =
        currentIdx <= 0 ? enabledOptions.length - 1 : currentIdx - 1;
      const prevOption = enabledOptions[prevIdx];
      if (prevOption) {
        handleSelect(prevOption.value);
        const prevEl = containerRef.current?.querySelector<HTMLElement>(
          `[data-value="${CSS.escape(prevOption.value)}"]`
        );
        prevEl?.focus();
      }
    }
  };

  const wrapClasses = [
    styles.container,
    size === 'xs'
      ? styles.containerXs
      : size === 'sm'
        ? styles.containerSm
        : styles.containerMd,
    block ? styles.containerBlock : null,
    disabled ? styles.containerDisabled : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={(node) => {
        containerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      role="radiogroup"
      aria-label={ariaLabel}
      className={wrapClasses}
      data-size={size}
      onKeyDown={handleKeyDown}
      {...restProps}
    >
      {/* FLIP 平滑滑动指示块 */}
      <div
        className={styles.activeSlider}
        style={{
          transform: `translateX(${sliderStyle.left}px)`,
          width: `${sliderStyle.width}px`,
          opacity: sliderStyle.opacity,
        }}
        aria-hidden="true"
      />

      {options.map((opt) => {
        const isSelected = opt.value === currentValue;
        const isItemDisabled = disabled || Boolean(opt.disabled);

        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={opt['aria-label']}
            data-value={opt.value}
            disabled={isItemDisabled}
            tabIndex={isSelected ? 0 : -1}
            className={[
              styles.item,
              isSelected ? styles.itemActive : null,
              isItemDisabled ? styles.itemDisabled : null,
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => handleSelect(opt.value, opt.disabled)}
          >
            {opt.icon && (
              <span className={styles.itemIcon} aria-hidden="true">
                {opt.icon}
              </span>
            )}
            <span className={styles.itemLabel}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
});
SegmentedControl.displayName = 'SegmentedControl';
