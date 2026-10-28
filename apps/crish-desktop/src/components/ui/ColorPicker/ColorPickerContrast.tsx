import React from 'react';
import { AnimatePresence, m, useTransform } from 'motion/react';
import { getWcagGrade } from '../../../utils/color/colorMath';
import { useFollow } from './types';
import styles from './ColorPicker.module.css';

export interface ColorPickerContrastProps {
  ratio: number;
  reduced: boolean;
}

/**
 * 120fps 零重渲染实时对比度指示仪组件
 * 采用 useFollow 弹簧数值逼近 + useTransform 直写 DOM textContent，
 * 避免在拾色拖拽高刷场景下触发整体组件树的 Reconciliation。
 */
export function ColorPickerContrast({
  ratio,
  reduced,
}: ColorPickerContrastProps) {
  const ratioValue = useFollow(ratio, reduced);
  const ratioText = useTransform(ratioValue, (v) => v.toFixed(2));
  const grade = getWcagGrade(ratio);

  const hidden = reduced
    ? { opacity: 0 }
    : { opacity: 0, y: '0.3em', filter: 'blur(2px)' };

  return (
    <div className={styles.contrast}>
      <span className={styles.sample} aria-hidden="true">
        Aa
      </span>
      <span className={styles.ratio}>
        <m.span>{ratioText}</m.span>:1
      </span>
      <span className={styles.against}>against background</span>
      <span
        className={styles.grade}
        data-grade={
          grade === 'Fails' ? 'fail' : grade === 'AA large' ? 'large' : 'pass'
        }
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <m.span
            key={grade}
            initial={hidden}
            animate={{ opacity: 1, y: '0em', filter: 'blur(0px)' }}
            exit={{ ...hidden, transition: { duration: 0.12 } }}
            transition={
              reduced
                ? { duration: 0.12 }
                : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }
            }
          >
            {grade}
          </m.span>
        </AnimatePresence>
      </span>
      <span className={styles.srOnly}>
        {`Contrast ${ratio.toFixed(2)} to 1, ${grade === 'Fails' ? 'fails' : `passes ${grade}`}`}
      </span>
    </div>
  );
}

export default ColorPickerContrast;
