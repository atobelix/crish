/**
 * useEntranceReveal：统一入场通道（Entrance Channel）唯一钩子实现。
 *
 * 背景：AI 工作期间会话面新增 DOM 曾有多套互不相认的入场做法——
 * AN4 的工具行/分派卡/组头走 toolRevealState 判定 + crish-row-enter，
 * 其余面（思考行、叙述段、状态行、错误条、审批卡、ribbon）或自带私有
 * keyframes、或瞬时弹入，高度突变与布局推移不丝滑（用户裁决 2026-11-06）。
 * 本通道把「何时播、播什么、播多久」收敛为单一路径，后续任何会话面
 * 新增 DOM 默认必须走本通道，不得再自带入场动画：
 *
 * - 判定层（单一）：复用 chat-tool-call/toolRevealState 的 decideEntrance
 *   ——呈现记忆（同键只播一次、虚拟重挂载不重播）、实况时间窗
 *   （[-500ms, 2000ms)，与 AN2 消息行入场同口径）、系统减动效降级、
 *   批次交错协调（claimEntranceDelay，同批相邻挂载按序 50ms/行）；
 * - 呈现层（单一）：共享 keyframes crish-row-enter（styles/design-system.css）
 *   经全局工具类 .crish-entrance-fade 消费；时长/缓动只从 token 取
 *   （--duration-fast / --ease-decelerate，TS 侧 utils/motionTokens 镜像），
 *   禁止在本通道外另写时长/曲线字面量；
 * - 变体：fade = 仅透明+微位移（正文相邻块用，文字揭示归 RevealPacer，
 *   本通道不碰）；grow = 在 fade 之外把根元素高度自 0 同步生长到自然高
 *   （离散行/卡/条用，时长由 calcAccordionDuration 按高度推导，与手风琴
 *   折叠族同口径），生长全程由宿主 ResizeObserver 观测、滚动锚定同步
 *   补偿——动画全过程与结果同步，不做「傻快」。
 *
 * 呈现键约定（key）：工具行 = toolId；分派卡 = `agent:<id>`；工具组 =
 * `group:<msgId>:<首工具 id>`（以上 AN4 既有）；思考行 =
 * `thought:<msgId>:<turnIndex>`；叙述/正文段 = `seg:<msgId>:<itemKey>`；
 * 上下文通知 = `ctx:<injectionId>`；重试状态行 = `retry:<attempt>:<kind>`；
 * 工作状态 = `work:<startTime>`；错误条 = `errbar:<sessionId>:<assistantMsgId>`；
 * 审批卡 = `approval:<toolId>`；定时任务卡 = `sched:<executionId>`。
 *
 * liveOnMount 仅限「存在本身即实况事件」的运行时状态面（重试行/错误条）：
 * 它们没有可用事件时间戳，首次判定以挂载时刻为事件时刻；呈现记忆仍
 * 保证同一应用会话内同键不重播。内容型表面禁止使用（历史会话必须安静）。
 *
 * 兼容：chat-tool-call/useRevealEntrance 已收敛为本钩子的 re-export 垫片，
 * AN4 三个消费方（工具行/分派卡/组头）行为与既有测试不变。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimEntranceDelay,
  decideEntrance,
  markEntered,
} from '../chat-tool-call/toolRevealState';
import {
  calcAccordionDuration,
  DURATION_FAST_MS,
  EASE_DECELERATE,
} from '../../utils/motionTokens';

export type EntranceVariant = 'fade' | 'grow';

export interface EntranceRevealInput {
  /** 呈现键（约定见文件头）；空串 = 未就绪，不判定 */
  key: string;
  /** 到达事件时间戳（ms）；liveOnMount 面可缺省 */
  eventTs?: number | undefined;
  /** 原地替换契约命中：禁入场（翻转即其全部动效） */
  replaceHit?: boolean | undefined;
  /** 调用方门控未就绪 */
  disabled?: boolean | undefined;
  /** 入场变体：fade（默认）| grow（高度同步生长，仅离散行/卡/条） */
  variant?: EntranceVariant | undefined;
  /** 仅运行时状态面可用：eventTs 缺省时以首次判定时刻为事件时刻 */
  liveOnMount?: boolean | undefined;
}

export interface EntranceRevealResult {
  entering: boolean;
  /** 交错延时（ms）：挂到根元素内联 --reveal-delay */
  delayMs: number;
  handleAnimationEnd: (e?: React.AnimationEvent) => void;
  /** 挂到根元素：grow 变体据此驱动高度生长；fade 变体为无副作用登记 */
  rootRef: (el: HTMLElement | null) => void;
}

interface EntranceState {
  key: string;
  entering: boolean;
  delayMs: number;
}

export function useEntranceReveal(
  input: EntranceRevealInput
): EntranceRevealResult {
  const decidedKeyRef = useRef<string | null>(null);
  /**
   * 迟到时间戳补判定（跟进二）：键首次判定时的 eventTs 缺省，只意味
   * 「当时未知」，不是「已判定拒绝」——时间戳到达后（同一键、同一
   * DOM 节点复用）允许补判定一次。已带戳判定过（无论通过/拒绝）或
   * 已入场者永不重判；迟到的旧时间戳仍由实况窗拒绝，历史回放安静。
   * 实测来源：流式尾正文项先于分段记账块挂载（无 startTime），落块
   * 后同键项才带上 startTime；旧实现的一次判定使该段永失入场。
   */
  const decidedEventTsRef = useRef<number | undefined>(undefined);
  const [state, setState] = useState<EntranceState>({
    key: '',
    entering: false,
    delayMs: 0,
  });
  const variant: EntranceVariant = input.variant ?? 'fade';

  const elRef = useRef<HTMLElement | null>(null);
  const fadeDoneRef = useRef(false);
  const growDoneRef = useRef(variant !== 'grow');
  const growCleanupRef = useRef<(() => void) | null>(null);
  const finishRef = useRef<() => void>(() => {});

  const rootRef = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => (s.entering ? { ...s, entering: false } : s));
  }, []);

  // 统一收尾：清 grow 内联样式 + 释放入场状态（fade/grow 双通道任一
  // 未完成时不提前收尾，避免高度生长被 fade 的 animationend 截断）
  const finish = useCallback(() => {
    growCleanupRef.current?.();
    growCleanupRef.current = null;
    dismiss();
  }, [dismiss]);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  const tryFinish = useCallback(() => {
    if (fadeDoneRef.current && growDoneRef.current) finishRef.current();
  }, []);

  // 呈现键首次就绪时判定（render 期调整 state，与 AN2/AN4 既有语义
  // 等价；组聚合形成时键由空串变为组键，在形成的那一帧判定）。
  // eventTs 迟到到达时补判定一次（见 decidedEventTsRef 注释）。
  const eventTsForDecision =
    input.eventTs ?? (input.liveOnMount ? Date.now() : undefined);
  const keyChanged = input.key !== decidedKeyRef.current;
  const lateTsArrived =
    input.key !== '' &&
    decidedKeyRef.current === input.key &&
    decidedEventTsRef.current === undefined &&
    eventTsForDecision !== undefined;
  if (input.key && (keyChanged || lateTsArrived)) {
    decidedKeyRef.current = input.key;
    decidedEventTsRef.current = eventTsForDecision;
    const now = Date.now();
    const enter = decideEntrance({
      key: input.key,
      eventTs: eventTsForDecision,
      now,
      replaceHit: input.replaceHit,
      disabled: input.disabled,
    });
    if (enter) {
      markEntered(input.key);
      const delayMs = claimEntranceDelay(now);
      if (state.key !== input.key || !state.entering) {
        fadeDoneRef.current = false;
        growDoneRef.current = variant !== 'grow';
        setState({ key: input.key, entering: true, delayMs });
      }
    } else if (state.key !== input.key && state.entering) {
      setState({ key: input.key, entering: false, delayMs: 0 });
    }
  }

  const handleAnimationEnd = useCallback(
    (e?: React.AnimationEvent) => {
      if (e && e.target !== e.currentTarget) return;
      fadeDoneRef.current = true;
      tryFinish();
    },
    [tryFinish]
  );

  // grow 变体：入场开始后把根高度自 0 生长到自然高；内容高度在生长
  // 期间漂移（字体/换行落定）时逐帧重靶向，终点以 transitionend 为准
  useEffect(() => {
    if (!state.entering || variant !== 'grow') return undefined;
    const el = elRef.current;
    if (!el) return undefined;

    let target = el.scrollHeight;
    if (target <= 0) {
      growDoneRef.current = true;
      tryFinish();
      return undefined;
    }
    const durationMs = calcAccordionDuration(target, true);
    let raf = 0;
    let done = false;

    const restore = () => {
      // 退场接管中（data-exiting 由 useExitReveal 置）：不清除退场方
      // 的内联高度/过渡，入场收尾让位（S4 契约 7）。
      if (el.dataset.exiting === 'true') return;
      el.style.removeProperty('height');
      el.style.removeProperty('overflow');
      el.style.removeProperty('transition');
    };
    const onTransitionEnd = (ev: TransitionEvent) => {
      if (ev.propertyName !== 'height' || ev.target !== el) return;
      // 退场接管的高度过渡不属于入场生长：不认作入场完成
      if (el.dataset.exiting === 'true') return;
      growDoneRef.current = true;
      tryFinish();
    };

    growCleanupRef.current = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      el.removeEventListener('transitionend', onTransitionEnd);
      restore();
    };

    el.style.overflow = 'hidden';
    el.style.height = '0px';
    // 强制回流使起始高生效后再设过渡与目标高
    void el.offsetHeight;
    el.style.transition = `height ${durationMs}ms ${EASE_DECELERATE}`;
    el.style.height = `${target}px`;
    el.addEventListener('transitionend', onTransitionEnd);

    const retarget = () => {
      if (done) return;
      // 退场接管中：停止重靶向生长高度，循环即刻让位（S4 契约 7）
      if (el.dataset.exiting === 'true') return;
      const nowTarget = el.scrollHeight;
      if (Math.abs(nowTarget - target) > 2) {
        target = nowTarget;
        el.style.height = `${target}px`;
      }
      raf = requestAnimationFrame(retarget);
    };
    raf = requestAnimationFrame(retarget);

    return () => {
      growCleanupRef.current?.();
      growCleanupRef.current = null;
    };
  }, [state.entering, state.key, variant, tryFinish]);

  // 保底安全定时器：CSS 动画未触发（后台标签页/被 token 归零）时
  // 也释放入场状态并清 grow 样式，避免根元素长期挂入场类或高度被锁
  useEffect(() => {
    if (!state.entering) return undefined;
    const growBudget =
      variant === 'grow'
        ? calcAccordionDuration(elRef.current?.scrollHeight ?? 0, true)
        : 0;
    const timer = window.setTimeout(
      () => finishRef.current(),
      state.delayMs + Math.max(DURATION_FAST_MS, growBudget) + 500
    );
    return () => window.clearTimeout(timer);
  }, [state.entering, state.delayMs, variant]);

  return {
    entering: state.entering,
    delayMs: state.delayMs,
    handleAnimationEnd,
    rootRef,
  };
}
