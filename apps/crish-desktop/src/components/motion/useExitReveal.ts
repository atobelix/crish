/**
 * useExitReveal：统一退场通道（Exit Channel）——入场通道的对偶。
 *
 * 背景：统一入场通道（useEntranceReveal + decideEntrance）只解决了
 * 「新增 DOM 怎么进来」，退场是直接卸载、下方内容瞬时补位（E 类 1
 * 缺口 #1；F/H 两册的退场缺口清单）。退场不是加一段 CSS：React
 * 卸载即消失，必须先有「延迟卸载」宿主才能谈退场动画——本文件即
 * 该宿主契约的最小可复用封装，与入场通道同目录。
 *
 * 三件套分工（与入场通道一一对偶）：
 * - 判定层：复用 chat-tool-call/toolRevealState 的 decideExit——
 *   decideEntrance 的对偶（已入场才可退场、无戳直落、减动效直落、
 *   虚拟窗口内卸载直落）。不另起第二套判定；
 * - 宿主层：useClosingFlag / useClosingValue——父级条件渲染的保活
 *   器。open/value 翻 false 时先播退场、再卸载；重挂即取消退场；
 *   判定不通过时立即卸载（不留不可见的空挂载）；
 * - 力学层：useExitReveal——流内行/卡的尺寸收敛（grow 入场的反向）。
 *   淡出由共享类 .crish-exit-fade / .crish-exit-popover 承载
 *   （styles/design-system.css，全局定义即安全）；尺寸收敛由本钩子
 *   内联驱动（时长/缓动只从 motionTokens 取，与 grow 同源）。
 *
 * 宿主契约（调用方必须遵守）：
 * 1. 挂载点：宿主（useClosingFlag / useClosingValue）必须位于拥有
 *    条件渲染的父级——退场保活只能发生在卸载的上一级；子元素自身
 *    保不住自己（父级卸载即连同宿主一起消失）。
 * 2. 卸载时序：卸载只由宿主的定时器驱动（退场时长 + 余量），子元素
 *    不得自行提前卸载；减动效时宿主立即卸载（decideExit 直落）。
 * 3. 减动效直卸：系统 prefers-reduced-motion 时一切退场直落——
 *    判定层已含此门，宿主不得绕过。
 * 4. 虚拟窗口互斥：虚拟器驱动的卸载（滚动出窗）不走退场宿主；
 *    宿主只接数据驱动的退场（状态变化）。inVirtualWindow=true 时
 *    decideExit 直落。
 * 5. 折叠互斥：折叠（accordion）有自己的开合状态机与视口守卫，
 *    不得与退场宿主叠加在同一元素上——折叠走类 2，退场走类 1。
 * 6. 退场期间禁指针命中：退场元素挂 .crish-exit-fade（已含
 *    pointer-events: none）或由调用方显式置 pointer-events none；
 *    退场元素同时 aria-hidden，避免读屏器读到正在消失的内容。
 * 7. 入场→退场交接：元素在入场生长（grow）未完成时被关闭，退场
 *    钩子置 data-exiting 标志，入场钩子的生长循环与收尾检测到该
 *    标志即让位（不抢高度、不清退场内联样式）——入场中被移除立即
 *    转退场，不得播完入场再退（E 类 1）。
 * 8. 引擎浮层不另造宿主：Base UI / Radix 的浮层走引擎自身的
 *    Presence 退场（data-state='closed' / data-ending-style），
 *    本通道只给它们补 CSS 退场配方；裸条件渲染的浮层用
 *    useClosingFlag 做最小宿主。
 *
 * 时长档位（E 类 1 / F §七.2）：流内行/卡退场 150ms accelerate
 * （DURATION_EXIT_MS，主档，恒 ≤ 入场）；高频浮层面 120ms
 * accelerate（DURATION_POPOVER_EXIT_MS）；窗口拖拽跟随面保持瞬时，
 * 绝不加退场动画；Dialog 状态机 keep-alive 不绕过。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { decideExit } from '../chat-tool-call/toolRevealState';
import {
  DURATION_EXIT_MS,
  DURATION_POPOVER_EXIT_MS,
  EASE_ACCELERATE,
  EXIT_SETTLE_BUFFER_MS,
} from '../../utils/motionTokens';

export { DURATION_EXIT_MS, DURATION_POPOVER_EXIT_MS };

export type ExitAxis = 'vertical' | 'horizontal';

/* ───── 力学层：尺寸收敛（grow 入场的反向） ───── */

export interface ExitRevealInput {
  /** 宿主已判定进入退场（closing 标志由 useClosingFlag/Value 发放） */
  closing: boolean;
  /** 收敛轴：vertical = 高度（默认，流内行/卡）；horizontal = 宽度（附件 chip 横向条） */
  axis?: ExitAxis | undefined;
  /**
   * horizontal 时抵消的条带 gap（px）：宽度收到 0 的同时以负 margin
   * 抵消一份 gap，卸载时零跳变（标签条离场同法，见 tabStrip 契约）。
   * 附件条 gap 为 8px（ComposerAttachmentBar.module.css）。
   */
  gapPx?: number | undefined;
  /** 退场时长（ms）：缺省 DURATION_EXIT_MS，与 .crish-exit-fade 同档 */
  durationMs?: number | undefined;
}

export interface ExitRevealResult {
  /** 挂到退场元素根上：closing 翻 true 时驱动尺寸收敛 */
  rootRef: (el: HTMLElement | null) => void;
}

export function useExitReveal(input: ExitRevealInput): ExitRevealResult {
  const axis: ExitAxis = input.axis ?? 'vertical';
  const durationMs = input.durationMs ?? DURATION_EXIT_MS;
  const elRef = useRef<HTMLElement | null>(null);
  const collapseCleanupRef = useRef<(() => void) | null>(null);
  const finishRef = useRef<() => void>(() => {});

  const rootRef = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  // 收尾：清退场内联样式（closing 取消/组件卸载时恢复自然尺寸）
  const finish = useCallback(() => {
    collapseCleanupRef.current?.();
    collapseCleanupRef.current = null;
  }, []);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  useEffect(() => {
    const el = elRef.current;
    if (!input.closing || !el) return undefined;
    // 退场开始：置标志，入场钩子的生长循环与收尾见到即让位（契约 7）
    el.dataset.exiting = 'true';

    const sizeProp = axis === 'vertical' ? 'height' : 'width';
    const start =
      axis === 'vertical' ? el.offsetHeight : el.offsetWidth;
    if (start <= 0) {
      delete el.dataset.exiting;
      return undefined;
    }

    const gapPx = axis === 'horizontal' ? (input.gapPx ?? 0) : 0;
    let done = false;
    const restore = () => {
      el.style.removeProperty(sizeProp);
      el.style.removeProperty('overflow');
      el.style.removeProperty('transition');
      if (gapPx > 0) el.style.removeProperty('margin-right');
      delete el.dataset.exiting;
    };
    const onTransitionEnd = (ev: TransitionEvent) => {
      if (ev.propertyName !== sizeProp || ev.target !== el) return;
      done = true;
      el.removeEventListener('transitionend', onTransitionEnd);
      // 退场播完不立即清内联样式：宿主定时器卸载前元素须保持 0 尺寸，
      // 否则高度回弹一跳；样式随卸载一同消失。
    };

    collapseCleanupRef.current = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onTransitionEnd);
      restore();
    };

    el.style.overflow = 'hidden';
    el.style[sizeProp as 'height' | 'width'] = `${start}px`;
    // 强制回流使起始尺寸生效后再设过渡与目标尺寸
    void el.offsetHeight;
    el.style.transition =
      gapPx > 0
        ? `${sizeProp} ${durationMs}ms ${EASE_ACCELERATE}, margin-right ${durationMs}ms ${EASE_ACCELERATE}`
        : `${sizeProp} ${durationMs}ms ${EASE_ACCELERATE}`;
    el.style[sizeProp as 'height' | 'width'] = '0px';
    if (gapPx > 0) el.style.marginRight = `${-gapPx}px`;
    el.addEventListener('transitionend', onTransitionEnd);

    return () => {
      collapseCleanupRef.current?.();
      collapseCleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closing 翻 true 时启动一次；翻 false 时由取消分支接管
  }, [input.closing]);

  // closing 取消（退场中被恢复）：从当前进度反向生长回自然高——
  // 过渡仍在，设回自然高即平滑回弹；过渡结束后再清内联样式。
  useEffect(() => {
    if (input.closing) return undefined;
    const el = elRef.current;
    if (!el || el.dataset.exiting !== 'true') return undefined;
    const sizeProp = axis === 'vertical' ? 'height' : 'width';
    const natural =
      axis === 'vertical' ? el.scrollHeight : el.scrollWidth;
    el.style[sizeProp as 'height' | 'width'] = `${natural}px`;
    const onEnd = (ev: TransitionEvent) => {
      if (ev.propertyName !== sizeProp || ev.target !== el) return;
      el.removeEventListener('transitionend', onEnd);
      finishRef.current();
    };
    el.addEventListener('transitionend', onEnd);
    const safety = window.setTimeout(() => {
      el.removeEventListener('transitionend', onEnd);
      finishRef.current();
    }, durationMs + EXIT_SETTLE_BUFFER_MS);
    return () => {
      window.clearTimeout(safety);
      el.removeEventListener('transitionend', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 closing 翻 false 时接管一次
  }, [input.closing]);

  return { rootRef };
}

/* ───── 宿主层：延迟卸载（条件渲染的保活器） ───── */

export interface ClosingHostInput {
  /** 呈现键：与入场键同约定（工具行 = toolId；审批卡 = approval:<toolId>…） */
  key: string;
  /** 退场时长（ms）：流内面缺省 DURATION_EXIT_MS；浮层面传 DURATION_POPOVER_EXIT_MS */
  durationMs?: number | undefined;
  /**
   * 该键是否已完成过入场；缺省读呈现记忆（hasEntered）。
   * 引擎/浮层宿主若已在挂载期亲眼见过元素，可显式传 true
   * （它们不走入场通道，记忆里没有它们的键）。
   */
  entered?: boolean | undefined;
  /** 调用方门控未就绪 */
  disabled?: boolean | undefined;
  /** 处于虚拟窗口内：虚拟器驱动的卸载直落 */
  inVirtualWindow?: boolean | undefined;
}

export interface ClosingFlagResult {
  /** 是否仍挂载（含退场播映期） */
  visible: boolean;
  /** 是否正在播退场 */
  closing: boolean;
}

/**
 * useClosingFlag：布尔型条件的退场宿主。
 * open=true → 挂载；open 翻 false → decideExit 通过则 closing=true
 * 播退场（durationMs + 余量后卸载），不通过则立即卸载；open 在退场
 * 中途翻回 true → 取消退场、恢复挂载。
 */
export function useClosingFlag(
  open: boolean,
  input: ClosingHostInput
): ClosingFlagResult {
  const [state, setState] = useState<ClosingFlagResult>({
    visible: open,
    closing: false,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationMs = input.durationMs ?? DURATION_EXIT_MS;

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    if (open) {
      clearTimer();
      setState((s) =>
        s.visible && !s.closing ? s : { visible: true, closing: false }
      );
      return undefined;
    }
    const allow = decideExit({
      key: input.key,
      entered: input.entered,
      disabled: input.disabled,
      inVirtualWindow: input.inVirtualWindow,
    });
    if (!allow) {
      clearTimer();
      setState((s) =>
        !s.visible && !s.closing ? s : { visible: false, closing: false }
      );
      return undefined;
    }
    setState((s) =>
      s.visible && s.closing ? s : { visible: true, closing: true }
    );
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        setState({ visible: false, closing: false });
      },
      durationMs + EXIT_SETTLE_BUFFER_MS
    );
    return clearTimer;
  }, [
    open,
    input.key,
    durationMs,
    input.entered,
    input.disabled,
    input.inVirtualWindow,
  ]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    []
  );

  return state;
}

export interface ClosingValueResult<T> {
  /** 当前值；退场播映期为最后一次非空值，卸载后为 null */
  value: T | null;
  /** 是否正在播退场 */
  closing: boolean;
}

/**
 * useClosingValue：值型条件的退场宿主（useClosingFlag 的值保持版）。
 * value 非空 → 挂载并呈现该值；value 翻空 → decideExit 通过则
 * 保持最后一次非空值播退场，之后卸载；不通过则立即卸载。
 * 供「子元素自身按 store 数据决定是否渲染、父级无法替它快照」
 * 的面（如 ApprovalDock 的 shouldRenderApprovalDock 自门、
 * MessageContent 内三处 inFlowRetry）。
 */
export function useClosingValue<T>(
  value: T | null | undefined,
  input: ClosingHostInput
): ClosingValueResult<T> {
  const heldRef = useRef<T | null>(value ?? null);
  // 呈现期调整 ref：值到达即快照；值翻空后快照保留到卸载
  // （与 useEntranceReveal 的 render 期判定同法，幂等）。
  if (value != null) heldRef.current = value;
  const flag = useClosingFlag(value != null, input);
  const outValue = value ?? (flag.visible ? heldRef.current : null);
  return { value: outValue, closing: flag.closing };
}
