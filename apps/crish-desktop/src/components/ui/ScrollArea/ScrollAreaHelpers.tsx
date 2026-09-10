import React from 'react';
import type { ScrollAreaSize } from './ScrollArea.types';

/**
 * 极端圆角断头台切角动态避让算法 (M02 落地)
 * @param radius 容器外层圆角半径 (px)
 * @param margin 滚动条离容器外边缘间距 (px)，严格为 2px
 */
export function calculateSafeAreaInset(radius: number = 0, margin: number = 2): number {
  if (radius <= 0) return 0;
  const x = Math.max(0, radius - margin);
  const arcY = Math.sqrt(Math.max(0, radius * radius - x * x));
  return Math.ceil(radius - arcY) + 1;
}

/** 顶部向上大圆角贝塞尔矢量等腰三角 (宽 8px 高 6px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowUpIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 9 6"
    width="8"
    height="6"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '8px', height: '6px', display: 'block' }}
  >
    <path d="M 4.0 1.4 Q 4.5 0.5 5.0 1.4 L 8.1 4.9 Q 8.6 5.6 7.8 5.6 L 1.2 5.6 Q 0.4 5.6 0.9 4.9 Z" />
  </svg>
);

/** 底部向下大圆角贝塞尔矢量等腰三角 (宽 8px 高 6px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowDownIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 9 6"
    width="8"
    height="6"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '8px', height: '6px', display: 'block' }}
  >
    <path d="M 4.0 4.6 Q 4.5 5.5 5.0 4.6 L 8.1 1.1 Q 8.6 0.4 7.8 0.4 L 1.2 0.4 Q 0.4 0.4 0.9 1.1 Z" />
  </svg>
);

/** 左侧向左大圆角贝塞尔矢量等腰三角 (宽 6px 高 8px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowLeftIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 6 9"
    width="6"
    height="8"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '6px', height: '8px', display: 'block' }}
  >
    <path d="M 1.4 4.5 Q 0.5 4.0 1.4 3.5 L 4.9 0.4 Q 5.6 -0.1 5.6 0.7 L 5.6 7.3 Q 5.6 8.1 4.9 7.6 Z" />
  </svg>
);

/** 右侧向右大圆角贝塞尔矢量等腰三角 (宽 6px 高 8px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowRightIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 6 9"
    width="6"
    height="8"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '6px', height: '8px', display: 'block' }}
  >
    <path d="M 4.6 4.5 Q 5.5 4.0 4.6 3.5 L 1.1 0.4 Q 0.4 -0.1 0.4 0.7 L 0.4 7.3 Q 0.4 8.1 1.1 7.6 Z" />
  </svg>
);

export function getButtonDimension(size: ScrollAreaSize): number {
  return size === 'xs' ? 6 : size === 'lg' ? 10 : 8;
}

export function getScrollbarThickness(size: ScrollAreaSize): number {
  return size === 'xs' ? 6 : size === 'sm' ? 7 : size === 'lg' ? 11 : 9;
}

export function resolveStepDelta(stepSizeProp: number | 'auto' | undefined, dimension: number): number {
  if (typeof stepSizeProp === 'number' && stepSizeProp > 0) return stepSizeProp;
  const dynamic = Math.round(dimension * 0.18);
  return Math.max(32, Math.min(dynamic > 0 ? dynamic : 40, 96));
}

export function snapScrollDelta(current: number, delta: number, maxScroll: number, threshold = 4): number {
  const target = current + delta;
  if (target <= threshold) return 0;
  if (target >= maxScroll - threshold) return maxScroll;
  return Math.max(0, Math.min(target, maxScroll));
}
