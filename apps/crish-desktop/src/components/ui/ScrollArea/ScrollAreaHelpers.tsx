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

/** 顶部向上大圆角贝塞尔矢量等腰三角 (宽 8px 高 7px，顶角与两底角均带平滑圆润曲率，宽度严格对齐滑块) */
export const StepperArrowUpIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 8 7"
    width="8"
    height="7"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '8px', height: '7px', display: 'block' }}
  >
    <path d="M 5.5 6.2 L 2.5 6.2 C 1.2 6.2 0.3 5.9 0.8 4.8 L 2.4 2.3 C 3.1 1.0 4.9 1.0 5.6 2.3 L 7.2 4.8 C 7.7 5.9 6.8 6.2 5.5 6.2 Z" />
  </svg>
);

/** 底部向下大圆角贝塞尔矢量等腰三角 (宽 8px 高 7px，顶角与两底角均带平滑圆润曲率，宽度严格对齐滑块) */
export const StepperArrowDownIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 8 7"
    width="8"
    height="7"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '8px', height: '7px', display: 'block' }}
  >
    <path d="M 2.5 0.8 L 5.5 0.8 C 6.8 0.8 7.7 1.1 7.2 2.2 L 5.6 4.7 C 4.9 6.0 3.1 6.0 2.4 4.7 L 0.8 2.2 C 0.3 1.1 1.2 0.8 2.5 0.8 Z" />
  </svg>
);

/** 左侧向左大圆角贝塞尔矢量等腰三角 (宽 7px 高 8px，顶角与两底角均带平滑圆润曲率，高度严格对齐滑块) */
export const StepperArrowLeftIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 7 8"
    width="7"
    height="8"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '7px', height: '8px', display: 'block' }}
  >
    <path d="M 6.2 2.5 L 6.2 5.5 C 6.2 6.8 5.9 7.7 4.8 7.2 L 2.3 5.6 C 1.0 4.9 1.0 3.1 2.3 2.4 L 4.8 0.8 C 5.9 0.3 6.2 1.2 6.2 2.5 Z" />
  </svg>
);

/** 右侧向右大圆角贝塞尔矢量等腰三角 (宽 7px 高 8px，顶角与两底角均带平滑圆润曲率，高度严格对齐滑块) */
export const StepperArrowRightIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 7 8"
    width="7"
    height="8"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '7px', height: '8px', display: 'block' }}
  >
    <path d="M 0.8 2.5 L 0.8 5.5 C 0.8 6.8 1.1 7.7 2.2 7.2 L 4.7 5.6 C 6.0 4.9 6.0 3.1 4.7 2.4 L 2.2 0.8 C 1.1 0.3 0.8 1.2 0.8 2.5 Z" />
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
