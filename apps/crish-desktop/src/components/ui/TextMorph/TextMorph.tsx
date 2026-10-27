import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useReducedMotion,
  type AnimationPlaybackControls,
} from 'motion/react';
import styles from './TextMorph.module.css';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';

export interface TextMorphProps {
  children: string;
  as?: 'span' | 'div' | 'p' | 'strong' | 'h1' | 'h2' | 'h3';
  className?: string;
  id?: string;
  style?: React.CSSProperties;
}

const springMorph = {
  type: 'spring',
  visualDuration: 0.42,
  bounce: 0,
} as const;
const durationExit = 0.18;
const durationStandard = 0.24;
const easeEnter = [0.16, 1, 0.3, 1] as const;
const easeStandard = [0.22, 1, 0.36, 1] as const;
const blurSoft = 4;
const blurred = `blur(${blurSoft}px)`;
const HANDOFF = 0.05;
const staggerChar = 0.016;

/**
 * 字符频次索引算法（char-count）
 * 消除同名字符的 Key 冲突，跨渲染帧精确对齐保留字形与新字形。
 */
export function toGlyphs(text: string): Array<{ char: string; key: string }> {
  const seen = new Map<string, number>();
  return Array.from(text).map((char) => {
    const count = seen.get(char) ?? 0;
    seen.set(char, count + 1);
    return { char, key: `${char}-${count}` };
  });
}

const measure = (element: HTMLElement): number => {
  if (typeof window === 'undefined') return 0;
  const widthVal = parseFloat(getComputedStyle(element).width);
  return Number.isFinite(widthVal) ? widthVal : 0;
};

/**
 * TextMorph 原子组件：字形平滑形变与临界阻尼弹性容器。
 *
 * 核心机制：
 * 1. 共有字符维持 DOM 节点 key 不变，沿 layout="position" 弹簧轨道平滑滑动；
 * 2. 新增字符阶梯入场（stagger），旧字符景深模糊消散（blur）；
 * 3. 双层容器架构：外层 .frame 弹簧过渡尺寸，内层 .track 自然排版测量；
 * 4. 内置 ResizeObserver 响应式监听与全链路无障碍 srOnly 脱模。
 */
export function TextMorph({
  children,
  as = 'span',
  className,
  id,
  style,
}: TextMorphProps) {
  const Tag = as;
  const reduced = useReducedMotion();
  const frame = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const width = useRef(0);
  const sizing = useRef<AnimationPlaybackControls | null>(null);

  const glyphs = useMemo(() => toGlyphs(children), [children]);

  const [labels, setLabels] = useState({
    current: children,
    previous: children,
  });

  if (labels.current !== children) {
    setLabels({ current: children, previous: labels.current });
  }

  const kept = useMemo(
    () => new Set(toGlyphs(labels.previous).map((glyph) => glyph.key)),
    [labels.previous]
  );

  let entering = 0;

  // useLayoutEffect 瞬时测量与外层弹簧驱动
  useLayoutEffect(() => {
    const frameElement = frame.current;
    const trackElement = track.current;
    if (!frameElement || !trackElement) return;

    const next = measure(trackElement);
    if (!Number.isFinite(next) || next <= 0) return;

    if (width.current && Math.abs(next - width.current) > 0.5 && !reduced) {
      sizing.current = animate(frameElement, { width: next }, springMorph);
    } else {
      sizing.current?.stop();
      frameElement.style.width = `${next}px`;
    }
    width.current = next;
  }, [children, reduced]);

  // ResizeObserver 监控字体加载或全局缩放
  useEffect(() => {
    const frameElement = frame.current;
    const trackElement = track.current;
    if (
      !frameElement ||
      !trackElement ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }

    const ro = ResizeObserverManager.getInstance();
    const handleResize = () => {
      const next = measure(trackElement);
      if (
        !Number.isFinite(next) ||
        next <= 0 ||
        Math.abs(next - width.current) < 0.5
      ) {
        return;
      }
      sizing.current?.stop();
      frameElement.style.width = `${next}px`;
      width.current = next;
    };

    ro.observe(trackElement, handleResize);
    return () => ro.unobserve(trackElement, handleResize);
  }, []);

  return (
    <Tag id={id} className={className} style={style}>
      <span className={styles.srOnly}>{children}</span>
      <span ref={frame} className={styles.frame} aria-hidden="true">
        <span ref={track} className={styles.track}>
          <AnimatePresence mode="popLayout" initial={false}>
            {glyphs.map(({ char, key }) => {
              const order = kept.has(key) ? 0 : entering++;
              return (
                <motion.span
                  key={key}
                  layout="position"
                  className={styles.glyph}
                  data-key={key}
                  initial={
                    reduced
                      ? false
                      : { opacity: 0, scale: 0.8, y: '0.14em', filter: blurred }
                  }
                  animate={{
                    opacity: 1,
                    scale: 1,
                    y: '0em',
                    filter: 'blur(0px)',
                  }}
                  exit={
                    reduced
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          opacity: 0,
                          scale: 0.86,
                          y: '-0.1em',
                          filter: blurred,
                          transition: {
                            duration: durationExit,
                            ease: easeStandard,
                          },
                        }
                  }
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          layout: springMorph,
                          default: {
                            duration: durationStandard + 0.04,
                            ease: easeEnter,
                            delay:
                              HANDOFF + Math.min(order, 8) * staggerChar * 2,
                          },
                        }
                  }
                >
                  {char === ' ' ? '\u00a0' : char}
                </motion.span>
              );
            })}
          </AnimatePresence>
        </span>
      </span>
    </Tag>
  );
}

export default TextMorph;
