/**
 * useRevealedText：把 RevealPacer 接到 React 渲染时钟上（R11）。
 *
 * 输入 arrivedText 是 store 真相（只追加），输出是准许显现的前缀：
 * - 未啮合（文本 ≤ 门槛 / 非流式挂载）：恒等输出，零附加延迟；
 * - 啮合后：rAF 逐帧按速度域定速推进（utils/revealPacing）；
 * - isStreaming 落下：进收尾态——小余量 snap、大余量限速泄空，
 *   泄空期间 revealing 保持 true，消费方据此维持流式呈现形态，
 *   完成门等下游不变量不因收尾被提前摘除；
 * - prefers-reduced-motion：旁路定速，恒等输出。
 *
 * 呈现完成门（R13）在本 hook 下游：它收到的是已显现流，封口判定
 * 只源于已显现文本，结构上不可能出现封口跳变。
 */
import { useEffect, useRef, useState } from 'react';
import { RevealPacer } from './RevealPacer';
import {
  revealPacingProfile,
  type RevealPacingProfileName,
} from '../../utils/revealPacing';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

export interface RevealedText {
  /** 准许显现的文本（arrivedText 的前缀） */
  text: string;
  /** 正在定速显现中（含收尾泄空）：消费方应按流式形态继续渲染 */
  revealing: boolean;
}

export function useRevealedText(
  arrivedText: string,
  isStreaming: boolean,
  profileName: RevealPacingProfileName = 'text'
): RevealedText {
  const profile = revealPacingProfile(profileName);
  const pacerRef = useRef<RevealPacer | null>(null);
  if (pacerRef.current === null || pacerRef.current.profile !== profile) {
    // profile 按挂载点固定（正文 / 思考各一条链路），变化时换控制器
    pacerRef.current = new RevealPacer(profile);
  }
  const pacer = pacerRef.current;

  const [reducedMotion, setReducedMotion] =
    useState<boolean>(readReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    return undefined;
  }, []);

  const [paced, setPaced] = useState<{ text: string; active: boolean }>(() => ({
    text: arrivedText,
    active: false,
  }));
  const emittedRef = useRef<{ text: string; active: boolean }>({
    text: arrivedText,
    active: false,
  });
  const wasStreamingRef = useRef<boolean>(isStreaming);
  const rafRef = useRef(0);

  useEffect(() => {
    pacer.setReducedMotion(reducedMotion);
    const now = performance.now();
    pacer.noteArrived(arrivedText, now, isStreaming);
    if (wasStreamingRef.current && !isStreaming) {
      pacer.finish(now);
    }
    wasStreamingRef.current = isStreaming;

    const emit = () => {
      // 文本与「显现中」标志同为一份状态：啮合瞬间已显现文本可能未变
      // （仍为空 / 同前缀），标志翻转也必须触发渲染，否则 revealing 过期
      const next = {
        text: arrivedText.slice(0, pacer.revealedLength),
        active: pacer.isEngaged || pacer.isFinishing,
      };
      if (
        next.text !== emittedRef.current.text ||
        next.active !== emittedRef.current.active
      ) {
        emittedRef.current = next;
        setPaced(next);
      }
    };
    emit();
    if (!pacer.needsFrame) return undefined;
    const step = () => {
      pacer.tick(performance.now());
      emit();
      if (pacer.needsFrame) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [arrivedText, isStreaming, reducedMotion, pacer]);

  // 未啮合 / 已收敛 / 减动效旁路：直接透传真相，不等 state 追帧
  if (reducedMotion || pacer.isSettled) {
    return { text: arrivedText, revealing: false };
  }
  return { text: paced.text, revealing: paced.active };
}
