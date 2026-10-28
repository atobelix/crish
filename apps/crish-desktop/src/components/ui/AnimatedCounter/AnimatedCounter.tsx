import React, { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  animate,
  m,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from 'motion/react';
import {
  partsFor,
  calculateGlyphOffset,
  calculateOdometerDelta,
} from './animatedCounterMath';
import { useStreamingCounter } from './useStreamingCounter';
import type { AnimatedCounterProps } from './types';
import styles from './AnimatedCounter.module.css';

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// 临界阻尼弹簧配置：单调无回弹
const SPRING_SMOOTH = {
  type: 'spring',
  visualDuration: 0.4,
  bounce: 0,
} as const;
const SPRING_MORPH = {
  type: 'spring',
  visualDuration: 0.38,
  bounce: 0,
} as const;

/** 环境安全的视口可见性 Hook（防御 SSR / JSDOM 下缺少 IntersectionObserver 的断裂） */
function useSafeInView(
  ref: React.RefObject<Element | null>,
  options: { once?: boolean; amount?: number }
): boolean {
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return;
    }
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsInView(true);
          if (options.once) {
            observer.disconnect();
          }
        } else if (!options.once) {
          setIsInView(false);
        }
      },
      { threshold: options.amount ?? 0 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, options.once, options.amount]);

  return isInView;
}

/** 单个数字字形：负责 0~9 的物理垂直位移与亚像素渲染保护 */
function Glyph({
  position,
  digit,
}: {
  position: MotionValue<number>;
  digit: number;
}) {
  // 核心环形模映射公式：折叠在 [-5, +4] 对称区间
  const offset = useTransform(position, (current) =>
    calculateGlyphOffset(digit, current)
  );
  const y = useTransform(offset, (current) => `${current}em`);
  const opacity = useTransform(offset, (current) =>
    Math.max(0, 1 - Math.abs(current))
  );
  // O(1) 视口裁剪：出界时彻底 hidden
  const visibility = useTransform(offset, (current) =>
    Math.abs(current) >= 1 ? 'hidden' : 'visible'
  );
  // ClearType 保护：微偏差 (<0.02) 强制卸载滤镜着色器
  const filter = useTransform(offset, (current) => {
    const abs = Math.abs(current);
    if (abs < 0.02 || abs >= 1) return 'none';
    return `blur(${(abs * 2).toFixed(2)}px)`;
  });

  return (
    <m.span
      className={styles.glyph}
      style={{ y, opacity, filter, visibility }}
      aria-hidden="true"
    >
      {digit}
    </m.span>
  );
}

const columnPresence = {
  initial: { width: 0, opacity: 0 },
  animate: { width: 'auto', opacity: 1 },
  exit: { width: 0, opacity: 0 },
};

/** 单列数字滚轮：维持自身物理 target 累加 */
function Column({
  digit,
  direction,
  armed,
  delay,
  reduceMotion,
  enableOdometer,
}: {
  digit: number;
  direction: number;
  armed: boolean;
  delay: number;
  reduceMotion: boolean;
  enableOdometer: boolean;
}) {
  const position = useMotionValue(armed ? 0 : digit);
  const wheel = useRef({
    digit: armed ? 0 : digit,
    target: armed ? 0 : digit,
    revealed: !armed,
  });

  useEffect(() => {
    const state = wheel.current;
    if (armed || state.digit === digit) {
      if (!armed) state.revealed = true;
      return;
    }

    // 计算方向性目标增量（里程表环形累加）
    const delta = calculateOdometerDelta(
      state.digit,
      digit,
      direction < 0 && state.revealed ? -1 : 1
    );

    state.target += delta;
    state.digit = digit;

    if (reduceMotion || !enableOdometer) {
      if (typeof (position as any).jump === 'function') {
        (position as any).jump(state.target);
      } else {
        position.set(state.target);
      }
      state.revealed = true;
      return undefined;
    } else {
      const controls = animate(position, state.target, {
        ...SPRING_SMOOTH,
        delay: state.revealed ? 0 : delay,
      });
      state.revealed = true;
      return () => controls.stop();
    }
  }, [armed, delay, digit, direction, position, reduceMotion, enableOdometer]);

  return (
    <m.span
      className={styles.column}
      {...columnPresence}
      transition={reduceMotion ? { duration: 0 } : SPRING_MORPH}
    >
      {/* 隐藏的 Sizer 撑开布局盒，保证零回流 */}
      <span className={styles.sizer}>0</span>
      {DIGITS.map((item) => (
        <Glyph key={item} position={position} digit={item} />
      ))}
    </m.span>
  );
}

export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  label,
  prefix = '',
  suffix = '',
  decimals = 0,
  locale = 'en-US',
  animateOnView = false,
  isStreaming = false,
  disabled = false,
  className,
  style,
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useSafeInView(ref, { once: true, amount: 0.6 });
  const reduceMotion = Boolean(useReducedMotion()) || disabled;

  // 挂载流式节流守卫
  const { displayValue, enableOdometer } = useStreamingCounter({
    value,
    isStreaming,
    throttleMs: 100,
  });

  const [previous, setPrevious] = useState(displayValue);
  const [direction, setDirection] = useState(1);

  if (displayValue !== previous) {
    setPrevious(displayValue);
    setDirection(displayValue >= previous ? 1 : -1);
  }

  const parts = partsFor(displayValue, decimals, locale);
  const armed = animateOnView && !inView;

  const isNegative = displayValue < 0;
  const effectivePrefix =
    isNegative && !prefix.includes('-') ? `-${prefix}` : prefix;

  // 构造供屏幕阅读器读取的纯文本
  const fullAccessibleText = `${effectivePrefix}${parts
    .map((p) => (p.type === 'digit' ? p.digit : p.text))
    .join('')}${suffix}`;

  return (
    <span
      ref={ref}
      className={[styles.counter, className].filter(Boolean).join(' ')}
      style={style}
    >
      {label && (
        <span className={styles.label}>
          <span className={styles.labelText}>{label}</span>
        </span>
      )}

      {/* 无障碍隐藏纯净读屏文本 */}
      <span className={styles.srOnly}>{fullAccessibleText}</span>

      {/* 视觉渲染层（对读屏隐藏） */}
      <span className={styles.valueRow} aria-hidden="true">
        {effectivePrefix && (
          <span className={styles.symbol}>{effectivePrefix}</span>
        )}
        <AnimatePresence initial={false}>
          {parts.map((part) =>
            part.type === 'digit' ? (
              <Column
                key={part.key}
                digit={part.digit}
                direction={direction}
                armed={armed}
                delay={Math.min(part.order * 0.035, 0.25)}
                reduceMotion={reduceMotion}
                enableOdometer={enableOdometer}
              />
            ) : (
              <m.span
                key={part.key}
                className={styles.symbol}
                {...columnPresence}
                transition={reduceMotion ? { duration: 0 } : SPRING_MORPH}
              >
                {part.text}
              </m.span>
            )
          )}
        </AnimatePresence>
        {suffix && <span className={styles.symbol}>{suffix}</span>}
      </span>
    </span>
  );
};

export default AnimatedCounter;
