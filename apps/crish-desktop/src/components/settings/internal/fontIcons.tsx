import React from 'react';
import { ICON_STROKE } from '../../ui/icons/iconTokens';

export interface IconProps extends React.SVGAttributes<SVGElement> {
  size?: number;
  className?: string;
}

/**
 * 设置页内部图标集（24 网格）。
 * 线宽一律取自 iconTokens 的 ICON_STROKE.ui，禁止裸写数字——
 * 24 网格上裸写 2 / 2.5 会让图标显著粗于全应用基准。
 */
const STROKE = ICON_STROKE.ui;

export const SearchIcon: React.FC<IconProps> = ({ size = 14, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const HardDriveIcon: React.FC<IconProps> = ({ size = 14, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <line x1="22" x2="2" y1="12" y2="12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    <line x1="6" x2="6.01" y1="16" y2="16" />
    <line x1="10" x2="10.01" y1="16" y2="16" />
  </svg>
);

export const RotateCcwIcon: React.FC<IconProps> = ({ size = 14, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ size = 14, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const Loader2Icon: React.FC<IconProps> = ({ size = 14, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 14, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);
