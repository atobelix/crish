/**
 * apps/crish-desktop/src/components/ui/PulseDot/PulseDot.tsx
 *
 * ui/PulseDot 脉冲点原语（S8 收敛，E 类 9）：运行态圆点的唯一组件入口。
 * - 关键帧走全局正典 crish-pulse-dot（styles/design-system.css 单源：
 *   scale 0.85↔1.3 + 强调色光晕环），周期走 --transition-pulse
 *   （= --duration-pulse 1600ms）令牌；
 * - 尺寸/底色由消费面经 size / className 决定，原语只管脉冲本体；
 * - 已登记的独立配方（AN2 裁定禁止合并：sync-dot-pulse、
 *   PreviewCard pulseDot、flowPulse 等）不在此列，见收敛守卫登记表。
 */

import React from 'react';
import styles from './PulseDot.module.css';

export interface PulseDotProps {
  /** 直径（px），默认 8 */
  size?: number;
  className?: string;
}

export const PulseDot: React.FC<PulseDotProps> = ({ size = 8, className }) => {
  const cls = [styles.pulseDot, className ?? ''].filter(Boolean).join(' ');
  return (
    <span
      data-slot="ui-pulse-dot"
      aria-hidden="true"
      className={cls}
      style={{ width: size, height: size }}
    />
  );
};
