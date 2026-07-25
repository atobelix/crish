import { useEffect, useCallback, useRef } from 'react';

interface UseKeyboardSensorOptions {
  /** 可聚焦的元素选择器 */
  targetSelector: string;
  /** 方向键移动步长（px） */
  step?: number;
  /** 起始方向 */
  orientation?: 'horizontal' | 'vertical';
  /** 拖拽开始回调 */
  onStart?: () => void;
  /** 移动回调：方向（1=正向，-1=负向）和步长 */
  onMove?: (direction: number, step: number) => void;
  /** 拖拽结束回调 */
  onEnd?: () => void;
}

/**
 * 键盘传感器 hook。
 * 
 * 为可聚焦元素添加键盘拖拽支持：
 * - Enter/Space：开始/确认
 * - ArrowLeft/ArrowRight：水平移动
 * - ArrowUp/ArrowDown：垂直移动
 * - Escape：取消
 */
export function useKeyboardSensor({
  targetSelector,
  step = 10,
  orientation = 'horizontal',
  onStart,
  onMove,
  onEnd,
}: UseKeyboardSensorOptions): void {
  const activeRef = useRef(false);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = (e.target as HTMLElement)?.closest(targetSelector);
    if (!target) return;

    // Enter/Space 开始/确认
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!activeRef.current) {
        activeRef.current = true;
        onStart?.();
      } else {
        activeRef.current = false;
        onEnd?.();
      }
      return;
    }

    if (!activeRef.current) return;

    let dir = 0;
    switch (e.key) {
      case 'ArrowLeft':
        if (orientation === 'horizontal') dir = -1;
        break;
      case 'ArrowRight':
        if (orientation === 'horizontal') dir = 1;
        break;
      case 'ArrowUp':
        if (orientation === 'vertical') dir = -1;
        break;
      case 'ArrowDown':
        if (orientation === 'vertical') dir = 1;
        break;
      case 'Escape':
        e.preventDefault();
        activeRef.current = false;
        onEnd?.();
        return;
    }

    if (dir !== 0) {
      e.preventDefault();
      onMove?.(dir, e.shiftKey ? step * 2 : step);
    }
  }, [targetSelector, step, orientation, onStart, onMove, onEnd]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // 失焦时自动结束
  useEffect(() => {
    const handleBlur = () => {
      if (activeRef.current) {
        activeRef.current = false;
        onEnd?.();
      }
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [onEnd]);
}
