import React from 'react';
import { m, useTransform } from 'motion/react';
import type { Hsva } from '../../../utils/color/colorMath';
import { clamp } from '../../../utils/color/colorMath';
import { stepFor, useFollow, usePad } from './types';
import styles from './ColorPicker.module.css';

export interface ColorPickerAreaProps {
  hsva: Hsva;
  onChange: (hsva: Hsva) => void;
  active: boolean;
  onActive: (active: boolean) => void;
  reduced: boolean;
  thumbRef?: React.Ref<HTMLDivElement>;
}

/**
 * 2D Saturation-Value 拾色面板组件
 * 横向为饱和度 [0, 1]，纵向为倒置明度 [1, 0]
 */
export function ColorPickerArea({
  hsva,
  onChange,
  active,
  onActive,
  reduced,
  thumbRef,
}: ColorPickerAreaProps) {
  const areaX = useFollow(hsva.s, reduced, active);
  const areaY = useFollow(1 - hsva.v, reduced, active);
  const left = useTransform(areaX, (v) => `${v * 100}%`);
  const top = useTransform(areaY, (v) => `${v * 100}%`);

  const areaPad = usePad(
    (x, y) => onChange({ ...hsva, s: x, v: 1 - y }),
    onActive
  );

  return (
    <div className={styles.area} data-active={active || undefined} {...areaPad}>
      <m.div
        ref={thumbRef}
        className={styles.areaThumb}
        role="slider"
        tabIndex={0}
        aria-roledescription="2D slider"
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsva.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsva.s * 100)}%, brightness ${Math.round(hsva.v * 100)}%`}
        style={{ left, top }}
        onKeyDown={(event) => {
          const step = stepFor(event, 'both');
          if (!step) return;
          event.preventDefault();
          onChange({
            ...hsva,
            s: clamp(hsva.s + step[0] / 100),
            v: clamp(hsva.v + step[1] / 100),
          });
        }}
      />
    </div>
  );
}

export default ColorPickerArea;
