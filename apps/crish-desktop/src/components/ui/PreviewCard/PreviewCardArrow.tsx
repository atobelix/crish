/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCardArrow.tsx
 * 双层贝塞尔平滑小三角渲染器
 */
import React from 'react';
import styles from './PreviewCard.module.css';
import { ICON_STROKE } from '../icons/iconTokens';
import type { PreviewCardArrowProps } from './types';

export const PreviewCardArrow: React.FC<PreviewCardArrowProps> = ({
  side,
  offset = 0,
  className,
  style,
  ...restProps
}) => {
  const isHorizontal = side === 'left' || side === 'right';
  const posOffset = isHorizontal ? offset - 9 : offset - 13;
  const sign = posOffset >= 0 ? '+' : '-';
  const absOffset = Math.abs(posOffset);

  const positionStyle: React.CSSProperties = isHorizontal
    ? { top: `calc(50% ${sign} ${absOffset}px)`, ...style }
    : { left: `calc(50% ${sign} ${absOffset}px)`, ...style };

  return (
    <div
      data-slot="preview-card-arrow"
      data-side={side}
      className={`${styles.arrowContainer} ${className || ''}`}
      style={positionStyle}
      {...restProps}
    >
      <svg
        width="26"
        height="18"
        viewBox="0 0 26 18"
        fill="none"
        aria-hidden="true"
      >
        {/* 1. 外层边框描边（2px 圆角连续三次贝塞尔） */}
        <path
          className={styles.arrowStroke}
          d="M21 9 L15.9819 3.36153 C14.3897 1.57244 11.5927 1.57413 10.0026 3.36516 L5 9"
          stroke="currentColor"
          strokeWidth={ICON_STROKE.ui}
          strokeLinecap="round"
        />
        {/* 2. 内层背景填充（深插入卡片内部 8.25px，遮蔽底边） */}
        <path
          className={styles.arrowFill}
          d="M9.82943 4.57564 C11.4308 2.51078 14.5497 2.51076 16.1511 4.5756 L20.9774 10.7986 C23.0157 13.4269 21.1426 17.25 17.8166 17.25 L8.16409 17.25 C4.83808 17.25 2.96496 13.4269 5.00325 10.7987 L9.82943 4.57564Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
};
PreviewCardArrow.displayName = 'PreviewCardArrow';
