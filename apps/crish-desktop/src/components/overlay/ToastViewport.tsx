import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import type { AppToast, ToastPosition } from '../../services/toast/types';
import { ToastStore } from '../../services/toast/ToastStore';
import { layerStackService } from '@/components/ui';
import { useToastStackMeasurement } from './useToastStackMeasurement';
import { layoutStack } from './toastStackMath';
import { ToastCard } from './ToastCard';
import styles from './ToastStackModern.module.css';

export interface ToastViewportProps {
  position?: ToastPosition;
  toasts?: readonly AppToast[];
  onDismiss?: (id: string) => void;
  portal?: boolean;
  containerId?: string;
  portalContainer?: HTMLElement | null;
}

export const ToastViewport: React.FC<ToastViewportProps> = ({
  // 单轨收敛（docs/chat-notice-convergence Step 1）：全局通知默认顶部居中
  position = 'top-center',
  toasts: propToasts,
  onDismiss: propOnDismiss,
  portal = false,
  containerId = 'toast-root',
  portalContainer,
}) => {
  const viewportRef = useRef<HTMLElement | null>(null);
  const storeToasts = useSyncExternalStore(
    ToastStore.subscribe,
    ToastStore.getToasts,
    ToastStore.getToasts
  );

  const toasts = propToasts ?? storeToasts;
  // 悬停 = 暂停全部倒计时（单条也要停：否则瞄准叉号途中通知自行退场）；
  // 扇形展开只在多条时才有意义，由悬停派生
  const [hovered, setHovered] = useState(false);
  const expanded = hovered && toasts.length > 1;

  // 清空时本组件 return null，mouseleave 永远不会来；不复位的话下一条通知一出来就被「暂停」
  useEffect(() => {
    if (toasts.length === 0) setHovered(false);
  }, [toasts.length]);

  // 窗口失焦时自动复位悬停态，避免切屏后悬停状态被永久冻结
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleBlur = () => setHovered(false);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // 接入 LayerStackManager 浮层中枢，确保顶层模态框开启时 Toast 层级协调受控
  useEffect(() => {
    if (toasts.length === 0) return;

    const targetContainer =
      portalContainer ??
      (typeof document !== 'undefined'
        ? (document.getElementById(containerId) ?? document.body)
        : null);

    const unregister = layerStackService.register({
      id: 'toast-viewport',
      type: 'toast',
      dismissible: false,
      modal: false,
      elementRef: viewportRef,
      portalContainer: targetContainer,
      onDismiss: () => {},
    });

    return () => {
      unregister();
    };
  }, [toasts.length, portalContainer, containerId]);

  const { registerNode, getOffsetY, frontmostHeight, heights } =
    useToastStackMeasurement(toasts, expanded);

  const isTop = position.startsWith('top');
  const { targets, listHeight } = layoutStack(
    toasts,
    heights,
    expanded,
    3,
    isTop
  );

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

  const content = (
    <section
      ref={viewportRef}
      role="region"
      aria-label="通知中心"
      data-position={position}
      data-expanded={expanded}
      data-paused={hovered}
      className={`${styles.viewport} ${getPositionClass()}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <ol
        className={styles.list}
        style={{
          height: listHeight > 0 ? `${listHeight}px` : undefined,
        }}
        data-expanded={expanded}
      >
        <AnimatePresence initial={false}>
          {toasts.map((item, index) => (
            <ToastCard
              key={item.id}
              toast={item}
              index={index}
              target={targets[index]}
              expanded={expanded}
              front={index === 0}
              frontmostHeight={frontmostHeight}
              offsetY={getOffsetY(index)}
              onHeightMeasure={(el) => registerNode(item.id, el)}
              onDismiss={() => handleDismiss(item.id)}
              isPaused={hovered}
            />
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );

  if (portal) {
    const targetContainer =
      portalContainer ??
      (typeof document !== 'undefined'
        ? (document.getElementById(containerId) ?? document.body)
        : null);
    if (targetContainer) {
      return createPortal(content, targetContainer);
    }
  }

  return content;
};
