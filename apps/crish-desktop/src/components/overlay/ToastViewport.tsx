import React, {
  useState,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from 'react';
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
  // 悬停 = 暂停全部倒计时（单条也要停：否则瞄准叉号途中通知自行退场、退场期 pointer-events:none）；
  // 扇形展开只在多条时才有意义，由悬停派生，不另设状态
  const [hovered, setHovered] = useState(false);
  const expanded = hovered && toasts.length > 1;
  // 清空时本组件 return null，mouseleave 永远不会来；不复位的话下一条通知一出来就被「暂停」
  useEffect(() => {
    if (toasts.length === 0) setHovered(false);
  }, [toasts.length]);

  const { registerNode, getOffsetY, frontmostHeight } =
    useToastStackMeasurement(toasts, expanded);

  const handleMouseEnter = useCallback(() => {
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
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
      data-paused={hovered}
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
          isPaused={hovered}
        />
      ))}
    </section>
  );
};
