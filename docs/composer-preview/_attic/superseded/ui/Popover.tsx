/**
 * Popover — 弹出面板组件
 *
 * 用于颜色选择器、链接编辑器等浮动面板。
 * 点击外部自动关闭。
 */

import React, { useEffect, useRef } from 'react';

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export const Popover: React.FC<PopoverProps> = ({
  open,
  onClose,
  children,
  className = '',
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div ref={popoverRef} className={`popover ${className}`} role="dialog">
      {children}
    </div>
  );
};
