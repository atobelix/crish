/**
 * apps/crish-desktop/src/components/ui/Spinner/Spinner.tsx
 *
 * ui/Spinner 持续指示原语（S8 收敛，E 类 9）：全仓唯一的旋转加载指示。
 * - 旋转关键帧走全局共享层 crish-spin（styles/indicators.css 单源），
 *   周期走 --transition-spin（= --duration-spin 1000ms）令牌；
 * - 默认规格 = 20px 环（原 ui/ContentState 与 SessionReadyCover 各自
 *   维护的同规格私有实现已收敛至此），尺寸经 size 覆盖；
 * - delayed 防闪烁门（E 类 9 口径）：250ms 内不显形，状态若在门槛前
 *   结束则永不闪现；消失随卸载即时发生，无退场。
 */

import React from 'react';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** 直径（px），默认 20（ContentState / SessionReadyCover 正典规格） */
  size?: number;
  /** 防闪烁门：显形延时 250ms（<300ms 门槛），短暂状态不闪 */
  delayed?: boolean;
  className?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({
  size = 20,
  delayed = false,
  className,
}) => {
  const cls = [
    styles.spinner,
    delayed ? styles.delayed : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      data-slot="ui-spinner"
      aria-hidden="true"
      className={cls}
      style={{ width: size, height: size }}
    />
  );
};
