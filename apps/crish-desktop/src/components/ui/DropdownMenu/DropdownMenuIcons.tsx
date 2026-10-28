/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/DropdownMenuIcons.tsx
 *
 * ui/DropdownMenu 内置纯矢量图标
 */

import React from 'react';

export const CheckIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 14,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const ChevronRightIcon: React.FC<{
  size?: number;
  className?: string;
}> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);
