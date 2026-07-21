import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import styles from './Tooltip.module.css';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: TooltipSide;
  disabled?: boolean;
  delayHide?: number;
}

function getPositionStyle(side: TooltipSide, rect: DOMRect): React.CSSProperties & Record<string, string> {
  const gap = 8;
  switch (side) {
    case 'top':
      return {
        top: `${rect.top - gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        '--tooltip-translate': 'translate(-50%, -100%)',
      };
    case 'bottom':
      return {
        top: `${rect.bottom + gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        '--tooltip-translate': 'translate(-50%, 0)',
      };
    case 'left':
      return {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.left - gap}px`,
        '--tooltip-translate': 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.right + gap}px`,
        '--tooltip-translate': 'translate(0, -50%)',
      };
  }
}

export function Tooltip({
  content,
  children,
  side = 'top',
  disabled = false,
  delayHide = 0,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { state, isMounted } = useAnimatedPresence({ visible, exitDurationMs: 120 });

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  if (disabled || !content) return children;

  const child = children as React.ReactElement<any>;

  const handleMouseEnter = (e: React.MouseEvent) => {
    clearHideTimer();
    setRect(e.currentTarget.getBoundingClientRect());
    setVisible(true);
    child.props.onMouseEnter?.(e);
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (delayHide > 0) {
      hideTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, delayHide);
    } else {
      setVisible(false);
    }
    child.props.onMouseLeave?.(e);
  };

  return (
    <>
      {React.cloneElement(child, {
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
      })}
      {isMounted && rect && createPortal(
        <div
          role="tooltip"
          className={`${styles.tooltip} ${styles[side]} ${state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter}`}
          style={getPositionStyle(side, rect)}
        >
          <div className={styles.tooltipContent}>{content}</div>
          <div className={styles.arrow} />
        </div>,
        document.body
      )}
    </>
  );
}
