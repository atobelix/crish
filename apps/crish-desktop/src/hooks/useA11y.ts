import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useAnnouncement：通过 aria-live 区域播报消息给屏幕阅读器。
 * 创建一个隐藏的 div[aria-live]，设置文本后自动清理。
 */
function useAnnouncement(message: string, priority: 'polite' | 'assertive' = 'polite') {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!message) return;

    let container = containerRef.current;
    if (!container) {
      container = document.createElement('div');
      container.setAttribute('aria-live', priority);
      container.setAttribute('aria-atomic', 'true');
      container.className = 'sr-only';
      document.body.appendChild(container);
      containerRef.current = container;
    }

    container.textContent = message;

    return () => {
      if (containerRef.current) {
        containerRef.current.remove();
        containerRef.current = null;
      }
    };
  }, [message, priority]);
}

/**
 * useKeyboardNavigation：通用 roving tabindex hook。
 * 支持方向键导航、Home/End、循环/非循环模式。
 */
function useKeyboardNavigation(options: {
  itemCount: number;
  onActivate: (index: number) => void;
  loop?: boolean;
}) {
  const { itemCount, onActivate, loop = false } = options;
  const [focusedIndex, setFocusedIndex] = useState(0);

  const getTabIndex = useCallback(
    (index: number): 0 | -1 => (index === focusedIndex ? 0 : -1),
    [focusedIndex],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let nextIndex: number | null = null;

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          if (focusedIndex < itemCount - 1) {
            nextIndex = focusedIndex + 1;
          } else if (loop) {
            nextIndex = 0;
          }
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          if (focusedIndex > 0) {
            nextIndex = focusedIndex - 1;
          } else if (loop) {
            nextIndex = itemCount - 1;
          }
          break;
        case 'Home':
          e.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          e.preventDefault();
          nextIndex = itemCount - 1;
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onActivate(focusedIndex);
          break;
      }

      if (nextIndex !== null && nextIndex !== focusedIndex) {
        setFocusedIndex(nextIndex);
      }
    },
    [focusedIndex, itemCount, loop, onActivate],
  );

  return { focusedIndex, getTabIndex, handleKeyDown };
}

export { useAnnouncement, useKeyboardNavigation };
