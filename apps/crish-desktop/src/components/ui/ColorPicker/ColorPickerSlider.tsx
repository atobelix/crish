import React from 'react';
import type { CSSProperties } from 'react';
import { motion, useTransform } from 'motion/react';
import { clamp } from '../../../utils/color/colorMath';
import { stepFor, useFollow, usePad } from './types';
import styles from './ColorPicker.module.css';

export interface ColorPickerSliderProps {
  label: string;
  value: number;
  valueText: string;
  max: number;
  unit: number;
  onChange: (value: number) => void;
  className?: string;
  style?: CSSProperties;
  reduced: boolean;
  fill: string;
  active: boolean;
  onActive: (active: boolean) => void;
}

/**
 * 物理阻尼滑块组件（用于 Hue 与 Alpha 调节）
 */
export function ColorPickerSlider({
  label,
  value,
  valueText,
  max,
  unit,
  onChange,
  className,
  style,
  reduced,
  fill,
  active,
  onActive,
}: ColorPickerSliderProps) {
  const x = useFollow(value / max, reduced, active);
  const left = useTransform(x, (v) => `${v * 100}%`);
  const pad = usePad((fx) => onChange(fx * max), onActive);

  return (
    <div
      className={`${styles.slider} ${className ?? ''}`}
      style={style}
      {...pad}
    >
      <motion.div
        className={styles.sliderThumb}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
        aria-valuetext={valueText}
        style={{ left, '--thumb-fill': fill } as unknown as CSSProperties}
        data-active={active || undefined}
        onKeyDown={(event) => {
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            onChange(event.key === 'Home' ? 0 : max);
            return;
          }
          const step = stepFor(event, 'x');
          if (!step) return;
          event.preventDefault();
          onChange(clamp(value + step[0] * unit, 0, max));
        }}
      />
    </div>
  );
}

export default ColorPickerSlider;
