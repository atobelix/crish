/**
 * Tooltip — 自定义工具提示组件
 *
 * 替代原生 HTML title 属性，提供 Notion 风格的圆角 pill 提示。
 * 零依赖（不使用 tippy.js），纯 CSS + React state 实现。
 */

import React, { useState, useRef, useCallback } from 'react';

interface TooltipProps {
  content: string;
  children: React.ReactElement;
  position?: 'top' | 'bottom';
  delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = 'top',
  delay = 300,
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  return (
    <span className="tooltip-anchor" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <span className={`tooltip-bubble tooltip-bubble--${position}`} role="tooltip">
          {content}
        </span>
      )}
    </span>
  );
};
