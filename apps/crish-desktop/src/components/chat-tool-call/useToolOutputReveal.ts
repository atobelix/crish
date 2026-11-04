/**
 * useToolOutputReveal：工具输出区的呈现调度（AN4）。
 *
 * 观察输出内容从「无」到「有」的到达跃迁（pane 挂载时已在场的
 * 内容是基线——历史/重挂载一律全量直出），按 toolRevealState 的
 * 门控与分类决定本次呈现形态：
 * - 错误：即时全量（错误是要立刻读到的内容，零揭示，§三 #5）；
 * - 结构化（diff/图片/结构解析命中）：整块淡入（§三 #6）；
 * - 纯文本：量级带内行式排空（ToolTextDrain）、带外整块淡入、
 *   门槛内直出（§三 #4）。
 *
 * 排空期间的让位由 toolRevealState 注册表驱动：行内任何交互
 * （CompactToolRow 的指针/焦点捕获）settle 本工具 → 同帧全量。
 * 终帧 displayText 与静态渲染逐字一致（本 hook 只切前缀）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ToolTextDrain } from './toolTextDrain';
import {
  classifyOutputReveal,
  drainDurationMs,
  hasPresentedOutput,
  hasToolInteracted,
  isLiveEventTimestamp,
  isRevealDegraded,
  markPresentedOutput,
  registerToolDrain,
  unregisterToolDrain,
} from './toolRevealState';

export type ToolOutputRevealPhase = 'idle' | 'draining' | 'fading';

export interface ToolOutputRevealInput {
  toolId?: string | undefined;
  /** 纯文本路径的展示全文（格式化后）；结构化路径同样传入，仅作内容签名 */
  text: string;
  /** 输出内容是否存在（空输出不触发任何揭示） */
  hasContent: boolean;
  kind: 'text' | 'structured';
  isError: boolean;
  status?: string | undefined;
  completedAt?: number | undefined;
}

export interface ToolOutputRevealResult {
  /** 准许显现的文本：排空期为全文前缀，其余时刻为全文 */
  displayText: string;
  phase: ToolOutputRevealPhase;
  /** 整块淡入的 animationend 收起（挂到淡入宿主元素） */
  handleFadeEnd: (e?: React.AnimationEvent) => void;
}

export function useToolOutputReveal(
  input: ToolOutputRevealInput
): ToolOutputRevealResult {
  const { toolId, text, hasContent, kind, isError, status, completedAt } =
    input;

  const [revealedLen, setRevealedLen] = useState<number | null>(null);
  const [phase, setPhase] = useState<ToolOutputRevealPhase>('idle');

  const drainRef = useRef<ToolTextDrain | null>(null);
  const drainTextRef = useRef<string>('');
  const drainingRef = useRef(false);
  const toolIdRef = useRef(toolId);
  toolIdRef.current = toolId;
  /** 挂载基线：首帧 hasContent 即基线（在场内容 = 已呈现，不重演） */
  const prevHasContentRef = useRef<boolean | null>(null);

  const stopDrain = useCallback((markPresented: boolean) => {
    const drain = drainRef.current;
    if (drain) {
      drain.dispose();
      drainRef.current = null;
    }
    if (drainingRef.current) {
      drainingRef.current = false;
      const id = toolIdRef.current;
      if (id) {
        unregisterToolDrain(id);
        if (markPresented) markPresentedOutput(id);
      }
    }
    setRevealedLen(null);
    setPhase('idle');
  }, []);

  // 到达跃迁判定与揭示启动
  useEffect(() => {
    if (prevHasContentRef.current === null) {
      // 首帧基线：挂载时已在场的内容直接登记为已呈现
      prevHasContentRef.current = hasContent;
      if (hasContent && toolId) markPresentedOutput(toolId);
      return;
    }
    const arrived = !prevHasContentRef.current && hasContent;
    prevHasContentRef.current = hasContent;

    // 排空进行中而全文被整体替换（权威改写/迟到回注）：立即对齐
    // 新全文，不对新内容重排空（正确性优先，与 RevealPacer 分叉
    // snap 同口径）
    if (drainingRef.current && text !== drainTextRef.current) {
      stopDrain(true);
      return;
    }
    if (!arrived || !toolId) return;

    // 门控（分析 §五）：已呈现 / 已交互 / 错误即时 / 运行时（尚无
    // 终态输出）/ 非实况时间戳 / 降级——任一命中即全量直出
    if (hasPresentedOutput(toolId) || hasToolInteracted(toolId)) {
      markPresentedOutput(toolId);
      return;
    }
    if (isError || status === 'running') {
      markPresentedOutput(toolId);
      return;
    }
    if (
      completedAt !== undefined &&
      !isLiveEventTimestamp(completedAt, Date.now())
    ) {
      markPresentedOutput(toolId);
      return;
    }
    if (isRevealDegraded()) {
      markPresentedOutput(toolId);
      return;
    }

    if (kind === 'structured') {
      // 结构化输出整块淡入（无行前缀语义，半截结构比整块更糟）
      markPresentedOutput(toolId);
      setPhase('fading');
      return;
    }

    const cls = classifyOutputReveal(text.length);
    if (cls === 'direct') {
      markPresentedOutput(toolId);
      return;
    }
    if (cls === 'fade') {
      markPresentedOutput(toolId);
      setPhase('fading');
      return;
    }

    // 带内纯文本：行式排空
    const drain = new ToolTextDrain(
      text,
      drainDurationMs(text.length),
      (len) => setRevealedLen(len),
      () => {
        drainRef.current = null;
        drainingRef.current = false;
        unregisterToolDrain(toolId);
        markPresentedOutput(toolId);
        setRevealedLen(null);
        setPhase('idle');
      }
    );
    drainRef.current = drain;
    drainTextRef.current = text;
    drainingRef.current = true;
    setPhase('draining');
    setRevealedLen(0);
    registerToolDrain(toolId, () => drain.settle());
    drain.start();
  }, [hasContent, text, kind, isError, status, completedAt, toolId, stopDrain]);

  // 卸载收口：进行中的排空登记为已呈现，重挂载全量直出（门 7）
  useEffect(() => {
    return () => {
      const drain = drainRef.current;
      if (drain) {
        drain.dispose();
        drainRef.current = null;
      }
      if (drainingRef.current) {
        drainingRef.current = false;
        const id = toolIdRef.current;
        if (id) {
          unregisterToolDrain(id);
          markPresentedOutput(id);
        }
      }
    };
  }, []);

  const handleFadeEnd = useCallback((e?: React.AnimationEvent) => {
    if (e && e.target !== e.currentTarget) return;
    setPhase((p) => (p === 'fading' ? 'idle' : p));
  }, []);

  return {
    displayText: revealedLen === null ? text : text.slice(0, revealedLen),
    phase,
    handleFadeEnd,
  };
}
