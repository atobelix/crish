/**
 * AppIcon — 全应用图标唯一入口。
 * 禁止业务直接 import lucide-react / @hugeicons/*。
 * size 经 snapIconSize：面板内统一 14/16（≥20 空态保留）。
 */
import * as React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { iconMap, type IconEntry, type IconName } from './iconMap';
import {
  DEFAULT_ICON_SIZE,
  DEFAULT_ICON_STROKE,
  ICON_STROKE,
  snapIconSize,
  type IconStrokeKey,
} from './iconTokens';

export type AppIconProps = {
  name: IconName;
  size?: number | string;
  /** 默认 ui；chrome 与 ui 同粗细 */
  stroke?: IconStrokeKey | number;
  className?: string;
  style?: React.CSSProperties;
  color?: string;
  fill?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
  'data-icon'?: string;
};

function strokeValue(stroke: AppIconProps['stroke']): number {
  if (stroke === undefined) return DEFAULT_ICON_STROKE;
  if (typeof stroke === 'number') return stroke;
  return ICON_STROKE[stroke];
}

export const AppIcon = React.memo(function AppIcon({
  name,
  size,
  stroke,
  className,
  style,
  color,
  fill,
  'aria-hidden': ariaHidden = true,
  'aria-label': ariaLabel,
  'data-icon': dataIcon,
}: AppIconProps) {
  const entry: IconEntry | undefined = iconMap[name];
  if (!entry) {
    if (import.meta.env.DEV) {
      console.warn(`[AppIcon] 未登记的图标名: ${name}`);
    }
    return null;
  }

  const px = snapIconSize(size ?? DEFAULT_ICON_SIZE);
  const strokeWidth = strokeValue(stroke);
  const a11y =
    ariaLabel !== undefined
      ? ({ 'aria-hidden': false, 'aria-label': ariaLabel } as const)
      : ({ 'aria-hidden': ariaHidden } as const);
  const testAttr = { 'data-icon': dataIcon ?? name } as const;

  if (entry.kind === 'custom') {
    const { Component } = entry;
    // custom 与 Hugeicons 同默认 ui 描边，保证线宽/灰度一致
    return (
      <Component
        size={px}
        className={className}
        strokeWidth={strokeWidth}
        style={{ color, fill, ...style }}
        {...a11y}
        {...testAttr}
      />
    );
  }

  return (
    <HugeiconsIcon
      icon={entry.icon}
      size={px}
      strokeWidth={strokeWidth}
      color={color ?? 'currentColor'}
      className={className}
      style={fill ? { fill, ...style } : style}
      {...a11y}
      {...testAttr}
    />
  );
});

AppIcon.displayName = 'AppIcon';
