import React, { useState, useCallback, useSyncExternalStore } from 'react';
import type { AppToast, ToastPosition } from '../../services/toast/types';
import { ToastStore } from '../../services/toast/ToastStore';
import { useToastStackMeasurement } from './useToastStackMeasurement';
import { ToastCard } from './ToastCard';
import styles from './ToastStackModern.module.css';

export interface ToastViewportProps {
  position?: ToastPosition;
  toasts?: readonly AppToast[];
  onDismiss?: (id: string) => void;
}

export const ToastViewport: React.FC<ToastViewportProps> = ({
  // 单轨收敛（docs/chat-notice-convergence Step 1）：全局通知默认顶部居中
  position = 'top-center',
  toasts: propToasts,
  onDismiss: propOnDismiss,
}) => {
  const storeToasts = useSyncExternalStore(
    ToastStore.subscribe,
    ToastStore.getToasts,
    ToastStore.getToasts
  );

  const toasts = propToasts ?? storeToasts;
  const [expanded, setExpanded] = useState(false);

  const { registerNode, getOffsetY, frontmostHeight } =
    useToastStackMeasurement(toasts, expanded);

  const handleMouseEnter = useCallback(() => {
    setExpanded(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setExpanded(false);
  }, []);

  const handleDismiss = useCallback(
    (id: string) => {
      if (propOnDismiss) {
        propOnDismiss(id);
      } else {
        ToastStore.dismiss(id);
      }
    },
    [propOnDismiss]
  );

  if (!toasts || toasts.length === 0) {
    return null;
  }

  const getPositionClass = () => {
    switch (position) {
      case 'bottom-center':
        return styles.viewportBottomCenter;
      case 'bottom-left':
        return styles.viewportBottomLeft;
      case 'top-right':
        return styles.viewportTopRight;
      case 'top-center':
        return styles.viewportTopCenter;
      case 'top-left':
        return styles.viewportTopLeft;
      case 'bottom-right':
      default:
        return styles.viewportBottomRight;
    }
  };

  return (
    <section
      role="region"
      aria-label="通知中心"
      data-position={position}
      data-expanded={expanded}
      className={`${styles.viewport} ${getPositionClass()}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {toasts.map((item, index) => (
        <ToastCard
          key={item.id}
          toast={item}
          index={index}
          frontmostHeight={frontmostHeight}
          offsetY={getOffsetY(index)}
          onHeightMeasure={(el) => registerNode(item.id, el)}
          onDismiss={() => handleDismiss(item.id)}
          isExpanded={expanded}
        />
      ))}
    </section>
  );
};
