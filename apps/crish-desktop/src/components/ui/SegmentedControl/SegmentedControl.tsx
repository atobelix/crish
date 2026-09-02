/**
 * apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx
 *
 * ui/SegmentedControl 原子分段选择器 (v2.0 现代化纯净重构版)
 *
 * 核心特性：
 * 1. 彻底根治激活项 Hover 灰度二次加深 Bug（Double Alpha Stacking 消除）；
 * 2. 引入 14px 外壳 + 11px 滑块 SmartPanel 同心大圆角体系（size="panel"）；
 * 3. 柔和物理贝塞尔与按压微触感交互；
 * 4. 支持 Sun/Moon 图标与 Kbd 徽标高保真排版；
 * 5. WAI-ARIA 1.2 RadioGroup 规范与 Home/End/Arrow 键盘漫游；
 * 6. 100% 纯原生 React 18+ 与 CSS Modules，零外部 npm 组件库依赖。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ResizeObserverManager } from '../../../services/ResizeObserverManager';
import styles from './SegmentedControl.module.css';

export type SegmentedControlSize = 'xs' | 'sm' | 'md' | 'lg' | 'panel';

export interface SegmentedControlOption<T extends string = string> {
  /** 选项唯一标识值 */
  value: T;
  /** 选项显示文案或自定义 ReactNode */
  label: React.ReactNode;
  /** 可选前置图标（如 Sun / Moon / Check 等） */
  icon?: React.ReactNode;
  /** 可选尾部徽标（如 Kbd / Badge / 计数等） */
  badge?: React.ReactNode;
  /** 禁用单个选项 */
  disabled?: boolean;
  /** 显式屏幕阅读器无障碍标签 */
  'aria-label'?: string;
}

export interface SegmentedControlProps<T extends string = string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /** 选项数组（支持对象数组或纯字符串数组） */
  options: (SegmentedControlOption<T> | T)[];
  /** 受控选中值 */
  value?: T;
  /** 非受控初始默认值 */
  defaultValue?: T;
  /** 选项变更回调 */
  onChange?: (value: T) => void;
  /** 尺寸档位：xs(24px) / sm(28px) / md(32px) / lg(38px) / panel(36px 大圆角设置专属) */
  size?: SegmentedControlSize;
  /** 禁用整组分段控制器 */
  disabled?: boolean;
  /** 通栏撑满容器宽度 (flex: 1) */
  block?: boolean;
  /** 自定义外层类名 */
  className?: string;
  /** 行内样式覆盖 */
  style?: React.CSSProperties;
  /** 无障碍组标签 (aria-label) */
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
  const currentValueRef = useRef(currentValue);
  currentValueRef.current = currentValue;

  const [isReady, setIsReady] = useState(false);
  const [sliderStyle, setSliderStyle] = useState<{
    left: number;
    width: number;
    opacity: number;
  }>({ left: 0, width: 0, opacity: 0 });

  // 同步测量选中项的几何尺寸与位移
  const updateSlider = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const val = currentValueRef.current;
    const activeItem = el.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(val)}"]`
    );

    if (activeItem && activeItem.offsetWidth > 0) {
      setSliderStyle({
        left: activeItem.offsetLeft,
        width: activeItem.offsetWidth,
        opacity: 1,
      });
      setIsReady(true);
    } else {
      setSliderStyle((prev) => (prev.opacity === 0 ? prev : { ...prev, opacity: 0 }));
    }
  }, []);

  // 稳定生命周期的 ResizeObserver 监听
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, updateSlider);
    return () => {
      ro.unobserve(el, updateSlider);
    };
  }, [updateSlider]);

  // 当选项、尺寸或选中值改变时触发测量
  useEffect(() => {
    updateSlider();
  }, [currentValue, options.length, size, updateSlider]);

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

  // WAI-ARIA 1.2 RadioGroup 键盘漫游支持（支持 ArrowLeft/Right/Up/Down、Home、End）
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
      data-ready={isReady ? 'true' : 'false'}
      style={style}
      {...restProps}
      onKeyDown={(e) => {
        restProps.onKeyDown?.(e);
        if (!e.defaultPrevented) {
          handleKeyDown(e);
        }
      }}
    >
      {/* 固体纯白滑块 (Solid Pure-White Card Slider) */}
      <div
        className={styles.activeSlider}
        style={{
          transform: `translateX(${sliderStyle.left}px)`,
          width: `${sliderStyle.width}px`,
          opacity: sliderStyle.opacity,
        }}
        aria-hidden="true"
      />

      {options.map((opt, idx) => {
        const isSelected = opt.value === currentValue;
        const isItemDisabled = disabled || Boolean(opt.disabled);
        const itemId = `${baseId}-opt-${idx}`;
        const tabIndex = isSelected ? 0 : (!hasSelectedMatch && idx === 0 ? 0 : -1);

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
  );
});

SegmentedControl.displayName = 'SegmentedControl';
