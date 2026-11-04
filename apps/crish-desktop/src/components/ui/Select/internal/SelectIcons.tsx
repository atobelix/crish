import React from 'react';
import { ICON_STROKE } from '../../icons/iconTokens';

interface IconProps extends React.SVGAttributes<SVGElement> {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
}

/**
 * Select / Combobox 内部图标集。
 * 线宽一律取自 iconTokens 的 ICON_STROKE（默认 fine=1.75），禁止裸写数字——
 * 保证与全应用图标视觉线宽/灰度一致。
 */
const STROKE = ICON_STROKE.fine;

export function ChevronDownIcon({
  size = 14,
  className,
  strokeWidth = STROKE,
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon="chevron-down"
      className={className}
      {...props}
    >
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}

export function ChevronUpDownIcon({
  size = 14,
  className,
  strokeWidth = STROKE,
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M5 6.5L8 3.5L11 6.5" />
      <path d="M5 9.5L8 12.5L11 9.5" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

export function ClearIcon({ size = 12, className, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

export function SearchIcon({ size = 14, className, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" />
    </svg>
  );
}
