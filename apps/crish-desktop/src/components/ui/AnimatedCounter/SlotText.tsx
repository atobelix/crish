import React, { useLayoutEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  animate,
  m,
  useMotionValue,
  usePresence,
  useReducedMotion,
  useTransform,
  useVelocity,
} from 'motion/react';
import type { SlotTextProps } from './types';
import styles from './SlotText.module.css';

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const LANDING_BEZIER = [0.12, 0.8, 0.16, 1] as const;
const CELL_PITCH_EM = 1.6;

function classOf(char: string) {
  if (DIGITS.includes(char)) return DIGITS;
  if (LOWER.includes(char)) return LOWER;
  if (UPPER.includes(char)) return UPPER;
  return null;
}

function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function buildReelStrip(
  from: string,
  to: string,
  spins: number,
  rising: boolean,
  seed: number = 1
) {
  if (from === to) return [to];
  const set = classOf(to);
  if (!set) return [from, to];
  if (set === DIGITS && classOf(from) === DIGITS) {
    const a = Number(from);
    const b = Number(to);
    const steps = spins * 10 + (rising ? (b - a + 10) % 10 : (a - b + 10) % 10);
    return Array.from({ length: steps + 1 }, (_, i) =>
      String((a + (rising ? i : -i) + 100) % 10)
    );
  }
  const random = seeded(seed);
  const fillers = Array.from({ length: Math.max(2, spins * 5 + 2) }, () => {
    const idx = Math.floor(random() * set.length);
    return set[idx] ?? to;
  });
  return [from, ...fillers, to];
}

interface SlotReelProps {
  char: string;
  order: number;
  entering: boolean;
  rising: boolean;
  duration: number;
  stagger: number;
  spins: number;
  reduced: boolean;
}

function SlotReel({
  char,
  order,
  entering,
  rising,
  duration,
  stagger,
  spins,
  reduced,
}: SlotReelProps) {
  const pos = useMotionValue(0);
  const width = useMotionValue<number | 'auto'>('auto');
  const sizerRef = useRef<HTMLSpanElement>(null);
  const [isPresent, safeToRemove] = usePresence();

  const [reel, setReel] = useState(() => ({
    char,
    strip:
      entering && !reduced
        ? buildReelStrip('', char, spins, rising, char.charCodeAt(0) + order)
        : [char],
    from: 0,
    grow: entering,
    time: duration + order * stagger,
  }));

  if (reel.char !== char) {
    const current = pos.get();
    const idx = Math.max(
      0,
      Math.min(reel.strip.length - 1, Math.round(current))
    );
    const visible = reel.strip[idx] ?? char;
    setReel({
      char,
      strip: reduced
        ? [char]
        : buildReelStrip(
            visible,
            char,
            spins,
            rising,
            char.charCodeAt(0) * 31 +
              visible.charCodeAt(0) * 7 +
              order +
              reel.strip.length
          ),
      from: reduced ? 0 : current - idx,
      grow: false,
      time: duration + order * stagger,
    });
  }

  // 速度挂钩的动态模糊与防发虚阈值 (<0.15 强制 'none')
  const blur = useTransform(useVelocity(pos), (velocity) => {
    const amt = Math.min(Math.abs(velocity) * 0.05, 2.0);
    return amt < 0.15 ? 'none' : `blur(${amt.toFixed(2)}px)`;
  });

  const y = useTransform(
    pos,
    (val) => `translate3d(0, ${(-val * CELL_PITCH_EM).toFixed(4)}em, 0)`
  );

  useLayoutEffect(() => {
    const measuredWidth = sizerRef.current?.getBoundingClientRect().width ?? 0;
    const last = reel.strip.length - 1;

    if (reduced) {
      if (typeof (pos as any).jump === 'function') {
        (pos as any).jump(last);
      } else {
        pos.set(last);
      }
      if (typeof (width as any).jump === 'function') {
        (width as any).jump(measuredWidth);
      } else {
        width.set(measuredWidth);
      }
      return;
    }

    if (typeof (pos as any).jump === 'function') {
      (pos as any).jump(reel.from);
    } else {
      pos.set(reel.from);
    }

    const spinAnim = animate(pos, last, {
      duration: last === 0 ? 0.2 : reel.time,
      ease: [...LANDING_BEZIER],
    });

    if (reel.grow) {
      if (typeof (width as any).jump === 'function') {
        (width as any).jump(0);
      } else {
        width.set(0);
      }
    }

    if (width.get() === 'auto') {
      if (typeof (width as any).jump === 'function') {
        (width as any).jump(measuredWidth);
      } else {
        width.set(measuredWidth);
      }
      return () => spinAnim.stop();
    }

    const sizeAnim = animate(width, measuredWidth, {
      type: 'spring',
      visualDuration: Math.min(reel.time, 0.45),
      bounce: 0,
    });

    return () => {
      spinAnim.stop();
      sizeAnim.stop();
    };
  }, [reel, pos, width, reduced]);

  useLayoutEffect(() => {
    if (isPresent) return;
    if (reduced) {
      safeToRemove();
      return;
    }

    const currentW =
      width.get() === 'auto'
        ? (sizerRef.current?.getBoundingClientRect().width ?? 0)
        : width.get();
    if (width.get() === 'auto') {
      width.set(currentW);
    }

    const exitAnim = animate(width, 0, {
      type: 'spring',
      visualDuration: 0.3,
      bounce: 0,
      onComplete: safeToRemove,
    });
    return () => exitAnim.stop();
  }, [isPresent, safeToRemove, width, reduced]);

  return (
    <m.span className={styles.slot} style={{ width }}>
      <span ref={sizerRef} className={styles.sizer}>
        {char === ' ' ? '\u00a0' : char}
      </span>
      <span className={styles.window}>
        <m.span className={styles.strip} style={{ transform: y, filter: blur }}>
          {reel.strip.map((c, i) => (
            <span key={i} className={styles.cell}>
              {c === ' ' ? '\u00a0' : c}
            </span>
          ))}
        </m.span>
      </span>
    </m.span>
  );
}

export const SlotText: React.FC<SlotTextProps> = ({
  value,
  format,
  duration = 0.8,
  stagger = 0.04,
  spins = 0,
  align,
  announce = false,
  className,
  style,
}) => {
  const reduced = Boolean(useReducedMotion());
  const text =
    typeof value === 'number'
      ? format
        ? format(value)
        : value.toLocaleString('en-US')
      : value;
  const chars = Array.from(text);
  const fromEnd =
    (align ?? (typeof value === 'number' ? 'end' : 'start')) === 'end';

  // 符号前缀判定：保留前缀独立 key，其余逆向对齐
  const lead = fromEnd ? chars.findIndex((c) => /[\p{L}\p{N}]/u.test(c)) : 0;
  const prefixLen = lead < 0 ? chars.length : lead;
  const getKey = (idx: number) =>
    idx < prefixLen
      ? `p${idx}`
      : fromEnd
        ? `e${chars.length - 1 - idx}`
        : `s${idx}`;

  const [initialKeys] = useState(() => new Set(chars.map((_, i) => getKey(i))));
  const [trend, setTrend] = useState({ value, rising: true });

  if (trend.value !== value) {
    setTrend({
      value,
      rising:
        typeof value === 'number' && typeof trend.value === 'number'
          ? value >= trend.value
          : true,
    });
  }

  return (
    <span
      className={[styles.slotRoot, className].filter(Boolean).join(' ')}
      style={style}
    >
      <span
        className={styles.srOnly}
        aria-live={announce ? 'polite' : undefined}
      >
        {text}
      </span>
      <span className={styles.reels} aria-hidden="true">
        <AnimatePresence initial={false}>
          {chars.map((char, i) => (
            <SlotReel
              key={getKey(i)}
              char={char}
              order={i}
              entering={!initialKeys.has(getKey(i))}
              rising={trend.rising}
              duration={duration}
              stagger={stagger}
              spins={spins}
              reduced={reduced}
            />
          ))}
        </AnimatePresence>
      </span>
    </span>
  );
};

export default SlotText;
