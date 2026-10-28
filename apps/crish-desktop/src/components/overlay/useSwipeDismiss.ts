import { useState, useRef, useCallback } from 'react';

export interface SwipeOptions {
  onDismiss: () => void;
  allowedAxes?: ('up' | 'down' | 'left' | 'right')[];
  threshold?: number;
}

export function useSwipeDismiss({
  onDismiss,
  allowedAxes = ['down', 'right'],
  threshold = 60,
}: SwipeOptions) {
  const [movement, setMovement] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [swiping, setSwiping] = useState(false);
  const startPos = useRef<{
    x: number;
    y: number;
    time: number;
    pointerId: number;
  } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return; // 仅主按键
    // 忽略内部交互按钮点击
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;

    try {
      if (typeof e.currentTarget.setPointerCapture === 'function') {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    } catch {
      // 忽略在 jsdom 或测试环境下的异常
    }

    startPos.current = {
      x: e.clientX,
      y: e.clientY,
      time: performance.now(),
      pointerId: e.pointerId,
    };
    setSwiping(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!startPos.current) return;
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;

      // 弹性阻尼衰减
      const applyDamping = (
        val: number,
        positiveAllowed: boolean,
        negativeAllowed: boolean
      ) => {
        if (val > 0 && !positiveAllowed) return val * 0.2;
        if (val < 0 && !negativeAllowed) return val * 0.2;
        return val;
      };

      const mx = applyDamping(
        dx,
        allowedAxes.includes('right'),
        allowedAxes.includes('left')
      );
      const my = applyDamping(
        dy,
        allowedAxes.includes('down'),
        allowedAxes.includes('up')
      );

      setMovement({ x: mx, y: my });
    },
    [allowedAxes]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!startPos.current) return;
      const dt = Math.max(1, performance.now() - startPos.current.time);
      const { x, y } = movement;
      const vx = Math.abs(x) / dt;
      const vy = Math.abs(y) / dt;

      const pointerId = startPos.current.pointerId;
      startPos.current = null;
      setSwiping(false);

      try {
        if (
          typeof e.currentTarget.releasePointerCapture === 'function' &&
          e.currentTarget.hasPointerCapture?.(pointerId)
        ) {
          e.currentTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Safe catch
      }

      // 判定条件：位移超过阈值，或满足最小滑行位移且瞬时速率达标 (Flick)
      const minFlingDistance = Math.max(25, threshold / 2);
      const isDismissedX =
        (Math.abs(x) >= threshold ||
          (Math.abs(x) >= minFlingDistance && vx > 0.45)) &&
        (x > 0 ? allowedAxes.includes('right') : allowedAxes.includes('left'));

      const isDismissedY =
        (Math.abs(y) >= threshold ||
          (Math.abs(y) >= minFlingDistance && vy > 0.45)) &&
        (y > 0 ? allowedAxes.includes('down') : allowedAxes.includes('up'));

      const isDismissed = isDismissedX || isDismissedY;

      if (isDismissed) {
        onDismiss();
      } else {
        setMovement({ x: 0, y: 0 });
      }
    },
    [movement, threshold, allowedAxes, onDismiss]
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    movement,
    swiping,
  };
}
