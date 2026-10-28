import { useRef, useCallback, useEffect } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useMotionValue, useTransform, animate } from 'motion/react';
import type { MotionValue } from 'motion/react';
import { rubberBand, projectVelocity } from './toastStackMath';

export interface SwipeDismissMotionOptions {
  id?: string;
  onDismiss: (id?: string) => void;
  reduceMotion?: boolean;
}

interface GestureSample {
  t: number;
  x: number;
}

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  active: boolean;
  samples: GestureSample[];
}

export interface UseSwipeDismissMotionResult {
  x: MotionValue<number>;
  swipeFade: MotionValue<number>;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  swipedOutRef: React.MutableRefObject<boolean>;
}

/**
 * useSwipeDismissMotion: 零重渲染手势引擎
 * 使用 MotionValue 直通 GPU 合成层，pointermove 手势期间绝不触发 React setState
 */
export function useSwipeDismissMotion({
  id = '',
  onDismiss,
  reduceMotion = false,
}: SwipeDismissMotionOptions): UseSwipeDismissMotionResult {
  // MotionValues: 接收 pointermove，直通 GPU 合成层，手势全过程 0 次 React 重渲染
  const x = useMotionValue(0);

  // 派生透明度: 向右滑动超过 280px 时淡出至 25%
  const swipeFade = useTransform(x, (val) =>
    val > 0 ? 1 - Math.min(val / 280, 1) * 0.75 : 1
  );

  const gestureRef = useRef<ActiveGesture | null>(null);
  const swipedOutRef = useRef(false);
  const activeAnimRef = useRef<{ stop: () => void } | null>(null);

  // 卸载守卫：停止正在运行的弹性动画，清除手势快照，杜绝回调泄漏
  useEffect(() => {
    return () => {
      if (activeAnimRef.current) {
        activeAnimRef.current.stop();
        activeAnimRef.current = null;
      }
      x.stop();
      gestureRef.current = null;
    };
  }, [x]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return; // 仅限主键
      // 避开卡片内部可交互控件
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select')) return;

      // 截流正在执行的动画或回弹弹簧
      if (activeAnimRef.current) {
        activeAnimRef.current.stop();
        activeAnimRef.current = null;
      }
      x.stop();

      gestureRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: x.get(),
        active: false,
        samples: [{ t: e.timeStamp, x: x.get() }],
      };
    },
    [x]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== e.pointerId) return;

      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;

      // 1. 防误触斜向滑动锁定 (Slop Threshold)
      if (!g.active) {
        if (Math.hypot(dx, dy) < 6) return;
        // 若纵向位移大于横向位移，认定为纵向滚动意图，放弃接管
        if (Math.abs(dy) > Math.abs(dx)) {
          gestureRef.current = null;
          return;
        }
        g.active = true;
        g.startX = g.startX + Math.sign(dx) * 6; // 扣除 slop 阈值，消除启动跳变并无缝衔接
        try {
          if (typeof e.currentTarget.setPointerCapture === 'function') {
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        } catch {
          /* jsdom fallback */
        }
        e.currentTarget.dataset.dragging = 'true';
        window.getSelection()?.removeAllRanges();
      }

      // 2. 双曲阻尼计算
      const raw = g.originX + e.clientX - g.startX;
      const cardWidth = e.currentTarget.offsetWidth || 380;

      // 右滑 1:1 跟手; 左滑施加 Apple 双曲橡皮筋阻尼
      const dampedX = raw >= 0 ? raw : -rubberBand(-raw, cardWidth);
      x.set(dampedX);
      swipeFade.set(dampedX > 0 ? 1 - Math.min(dampedX / 280, 1) * 0.75 : 1);

      // 3. 滑窗速度采样 (保留最近 100ms 样本)
      g.samples.push({ t: e.timeStamp, x: raw });
      while (g.samples.length > 2 && e.timeStamp - g.samples[0]!.t > 100) {
        g.samples.shift();
      }
    },
    [x]
  );

  const onPointerUpInternal = useCallback(
    (e: ReactPointerEvent<HTMLElement>, cancelled = false) => {
      const g = gestureRef.current;
      if (!g || (e.pointerId !== undefined && g.pointerId !== e.pointerId))
        return;
      gestureRef.current = null;

      if (!g.active) return;
      delete e.currentTarget.dataset.dragging;

      try {
        if (
          typeof e.currentTarget.releasePointerCapture === 'function' &&
          e.currentTarget.hasPointerCapture?.(e.pointerId)
        ) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* fallback */
      }

      // 提取释放速度
      const first = g.samples[0];
      const last = g.samples[g.samples.length - 1];
      const isStale = e.timeStamp - (last?.t ?? 0) > 60;
      const velocity =
        cancelled || !first || !last || last.t === first.t || isStale
          ? 0
          : ((last.x - first.x) / (last.t - first.t)) * 1000;

      const cardWidth = e.currentTarget.offsetWidth || 380;
      const currentOffset = x.get();

      // 离场决策判定: offset + projectVelocity(v) > cardWidth * 0.4
      if (
        !cancelled &&
        currentOffset > 0 &&
        velocity > -200 &&
        currentOffset + projectVelocity(velocity) > cardWidth * 0.4
      ) {
        swipedOutRef.current = true;
        if (reduceMotion) {
          x.set(cardWidth + 40);
          onDismiss(id);
        } else {
          // 速度无缝交接飞出
          try {
            const anim = animate(x, cardWidth + 60, {
              type: 'spring',
              visualDuration: 0.32,
              bounce: 0,
              velocity: Math.max(velocity, 0),
            });
            activeAnimRef.current = anim;
            anim
              .then(() => {
                activeAnimRef.current = null;
                onDismiss(id);
              })
              .catch(() => {
                activeAnimRef.current = null;
                onDismiss(id);
              });
          } catch {
            activeAnimRef.current = null;
            onDismiss(id);
          }
        }
        return;
      }

      // 未达标: 弹性复位
      if (reduceMotion) {
        x.jump(0);
        swipeFade.set(1);
      } else {
        try {
          const anim = animate(x, 0, {
            type: 'spring',
            visualDuration: 0.26,
            bounce: 0,
            velocity: currentOffset < 0 ? velocity * 0.3 : velocity,
          });
          activeAnimRef.current = anim;
          anim
            .then(() => {
              activeAnimRef.current = null;
            })
            .catch(() => {
              activeAnimRef.current = null;
            });
        } catch {
          activeAnimRef.current = null;
          x.set(0);
          swipeFade.set(1);
        }
      }
    },
    [id, onDismiss, reduceMotion, x]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      onPointerUpInternal(e, false);
    },
    [onPointerUpInternal]
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      onPointerUpInternal(e, true);
    },
    [onPointerUpInternal]
  );

  return {
    x,
    swipeFade,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    swipedOutRef,
  };
}
