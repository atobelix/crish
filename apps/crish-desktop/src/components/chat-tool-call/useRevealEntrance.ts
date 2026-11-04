/**
 * useRevealEntrance：组件入场状态机（AN4）。
 *
 * 工具行 / 分派卡 / 工具组头共用同一份「新到达」入场语义（与 AN2
 * useMessageRowEntrance 同构）：判定只在呈现键首次就绪时发生一次
 * （挂载、或组聚合形成的那一帧），入场延时由 toolRevealState 的
 * 批次协调器按挂载序发放；动画结束或保底定时器到点即收起状态，
 * 虚拟列表重挂载凭呈现记忆不重播。
 *
 * 呈现侧：消费方在根元素挂进入类（引用共享 keyframes
 * crish-row-enter）+ 内联 --reveal-delay，并把 handleAnimationEnd
 * 接到根元素的 onAnimationEnd。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimEntranceDelay,
  decideEntrance,
  markEntered,
} from './toolRevealState';

export interface RevealEntranceInput {
  /** 呈现键：工具行 = toolId；分派卡 = `agent:<id>`；工具组 = `group:<…>`；空串 = 未就绪 */
  key: string;
  /** 到达事件时间戳（工具行 = completedAt ?? startedAt；分派卡 = startedAt） */
  eventTs?: number | undefined;
  /** 原地替换契约命中：禁入场（翻转即其全部动效） */
  replaceHit?: boolean | undefined;
  /** 调用方门控未就绪 */
  disabled?: boolean | undefined;
}

export interface RevealEntranceResult {
  entering: boolean;
  /** 交错延时（ms）：挂到根元素内联 --reveal-delay */
  delayMs: number;
  handleAnimationEnd: (e?: React.AnimationEvent) => void;
}

interface EntranceState {
  key: string;
  entering: boolean;
  delayMs: number;
}

export function useRevealEntrance(
  input: RevealEntranceInput
): RevealEntranceResult {
  const decidedKeyRef = useRef<string | null>(null);
  const [state, setState] = useState<EntranceState>({
    key: '',
    entering: false,
    delayMs: 0,
  });

  // 呈现键首次就绪时判定（render 期调整 state，与 AN2 的
  // useState 初始化判定等价；组聚合形成时键由空串变为组键，
  // 在形成的那一帧判定，而不是组件挂载帧）
  if (input.key && decidedKeyRef.current !== input.key) {
    decidedKeyRef.current = input.key;
    const now = Date.now();
    const enter = decideEntrance({
      key: input.key,
      eventTs: input.eventTs,
      now,
      replaceHit: input.replaceHit,
      disabled: input.disabled,
    });
    if (enter) {
      markEntered(input.key);
      const delayMs = claimEntranceDelay(now);
      if (state.key !== input.key || !state.entering) {
        setState({ key: input.key, entering: true, delayMs });
      }
    } else if (state.key !== input.key && state.entering) {
      setState({ key: input.key, entering: false, delayMs: 0 });
    }
  }

  const dismiss = useCallback(() => {
    setState((s) => (s.entering ? { ...s, entering: false } : s));
  }, []);

  const handleAnimationEnd = useCallback(
    (e?: React.AnimationEvent) => {
      if (e && e.target !== e.currentTarget) return;
      dismiss();
    },
    [dismiss]
  );

  // 保底安全定时器：CSS 动画未触发（后台标签页/被 token 归零）时
  // 也释放入场状态，避免根元素长期挂入场类
  useEffect(() => {
    if (!state.entering) return undefined;
    const timer = window.setTimeout(dismiss, state.delayMs + 150 + 500);
    return () => window.clearTimeout(timer);
  }, [state.entering, state.delayMs, dismiss]);

  return {
    entering: state.entering,
    delayMs: state.delayMs,
    handleAnimationEnd,
  };
}
