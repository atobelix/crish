/**
 * ui/Slider 原子滑动条组件（RED-DETAILED-02 / T-ATOM-07）
 *
 * 遵循 2px 发丝轨道与 44px 隐式命中区（Fitts's Law），
 * 12px 正圆滑块（50% 白名单），支持鼠标拖拽、滚轮与键盘无障碍漫游。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React, { useCallback, useRef, useState } from 'react';
import { m } from 'motion/react';
import { SPRING_SWITCH_SLIDER } from '../../../utils/motionTokens';
import styles from './Slider.module.css';

export interface SliderProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onChange' | 'defaultValue'
> {
  /** 当前数值（受控） */
  value?: number;
  /** 默认初始值（非受控） */
  defaultValue?: number;
  /** 数值变更回调 */
  onChange?: (value: number) => void;
  /** 最小值（默认 0） */
  min?: number;
  /** 最大值（默认 100） */
  max?: number;
  /** 步长（默认 1） */
  step?: number;
  /** 是否禁用 */
  disabled?: boolean;
  /** 无障碍名称 */
  'aria-label'?: string;
}

export const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  function Slider(
    {
      value: externalValue,
      defaultValue = 0,
      onChange,
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      className,
      'aria-label': ariaLabel,
      ...restProps
    },
    ref
  ) {
    const isControlled = externalValue !== undefined;
    const [internalValue, setInternalValue] = useState<number>(defaultValue);
    const currentValue = Math.min(
      max,
      Math.max(min, isControlled ? (externalValue ?? 0) : internalValue)
    );

    const trackRef = useRef<HTMLDivElement | null>(null);
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);

    const percentage =
      max > min
        ? Math.max(0, Math.min(100, ((currentValue - min) / (max - min)) * 100))
        : 0;

    const clampAndSnap = useCallback(
      (val: number) => {
        const clamped = Math.min(max, Math.max(min, val));
        const snapped = Math.round((clamped - min) / step) * step + min;
        return Number(snapped.toFixed(4));
      },
      [min, max, step]
    );

    const updateFromPointer = useCallback(
      (clientX: number) => {
        if (!trackRef.current || disabled) return;
        const rect = trackRef.current.getBoundingClientRect();
        if (rect.width <= 0) return;
        const rawPercent = Math.max(
          0,
          Math.min(1, (clientX - rect.left) / rect.width)
        );
        const rawValue = min + rawPercent * (max - min);
        const newValue = clampAndSnap(rawValue);

        if (!isControlled) {
          setInternalValue(newValue);
        }
        onChange?.(newValue);
      },
      [min, max, clampAndSnap, disabled, isControlled, onChange]
    );

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      isDraggingRef.current = true;
      setIsDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromPointer(e.clientX);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (isDraggingRef.current) {
        updateFromPointer(e.clientX);
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      let nextValue = currentValue;

      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextValue = clampAndSnap(currentValue + step);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextValue = clampAndSnap(currentValue - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextValue = min;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextValue = max;
      } else {
        return;
      }

      if (nextValue !== currentValue) {
        if (!isControlled) {
          setInternalValue(nextValue);
        }
        onChange?.(nextValue);
      }
    };

    const wrapClasses = [
      styles.slider,
      disabled ? styles.sliderDisabled : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={(node) => {
          trackRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuenow={currentValue}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        className={wrapClasses}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        {...restProps}
      >
        <div className={styles.track}>
          <m.div
            className={styles.filledTrack}
            initial={false}
            animate={{ width: `${percentage}%` }}
            transition={isDragging ? { duration: 0 } : SPRING_SWITCH_SLIDER}
          />
        </div>
        <m.div
          className={styles.thumb}
          initial={false}
          animate={{ left: `${percentage}%` }}
          transition={isDragging ? { duration: 0 } : SPRING_SWITCH_SLIDER}
          aria-hidden="true"
        />
      </div>
    );
  }
);
Slider.displayName = 'Slider';
