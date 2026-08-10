/**
 * IME 隐藏输入框桥 hook（P1-B2：12 文档 §3.7 + S0-03 实测背书）。
 *
 * 职责：隐藏输入框的焦点持有、候选窗定位（点击点下方 ~20px）、
 * composition 事件 → [imeBridge] 状态机 → compositionend 整串提交回调。
 *
 * ## 焦点模型（12 §3.6/§3.7）
 * - **隐藏输入框始终持有焦点**（面板激活即 focus；点击面板任意处 →
 *   preventDefault 阻止 InputLayer 抢焦点 + 显式 focus 本框）；
 * - 面板失焦（点击聊天区/工具栏）→ 输入框 blur → 键盘转发暂停
 *   （usePanelInput 侧） + 合成期失焦重置（S0-03 R2 残余 2 / T10：
 *   清缓冲、不注入半截文本）；
 * - 页面侧焦点由 CDP 信任输入自然维持（S0-03 C5 实测：insertText 自动
 *   聚焦页面「最后可编辑元素」——页面无需真实聚焦到具体输入框，注入自动
 *   落点，桥接不干预页面焦点模型）。
 *
 * ## 提交面
 * compositionend → 非空整串经 `onCommitted` 回调（InputLayer 组装
 * `browser_input { kind: 'text', text }` → Rust InputCmd::Text → insertText）；
 * 空串（Esc 取消合成）不提交（12 §3.7 / S0-03 C2）。
 *
 * ## 接管信号
 * compositionstart 触发 `onUserInput`（接管信号观察；吊销链在维度 15
 * Coordinator，前端仅发信号——T-12/U-9③）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createImeState,
  imeBridgeStep,
  type ImeBridgeEvent,
  type ImeState,
} from './imeBridge';

/** 候选窗定位间隙（12 §3.7：点击点下方约 20px 处）。 */
const IME_ANCHOR_GAP_PX = 20;
/** 隐藏输入框可视尺寸下限（1px 隐形；可聚焦可接收 IME）。 */
const IME_BOX_PX = 1;

export interface UseImeBridgeOptions {
  /** 帧流激活才启用（停流/失活 → 复位状态机，防悬置残留）。 */
  enabled: boolean;
  /** 面板区域 rect（候选窗定位与边界钳制基准）。 */
  getRect: () => DOMRect | null;
  /** compositionend 整串文本回调（非空才调用；InputLayer 组装 text 事件上行）。 */
  onCommitted: (text: string) => void;
  /** 接管信号观察（compositionstart = 用户开始键入）。 */
  onUserInput?: () => void;
}

export interface UseImeBridgeResult {
  /** 隐藏输入框 ref（InputLayer 挂载，`data-ime-bridge` 标记）。 */
  imeInputRef: React.RefObject<HTMLInputElement | null>;
  /** 合成期标记（供 usePanelInput 阻断合成期键盘转发）。 */
  composing: boolean;
  /** 聚焦隐藏输入框（面板点击后调用；preventScroll）。 */
  focusImeInput: () => void;
  /** 候选窗定位：输入框移动至点击点下方（T8：不超出面板边界）。 */
  positionImeInput: (clientX: number, clientY: number) => void;
  /** 隐藏输入框事件处理器（composition + 229 兜底计数）。 */
  imeInputHandlers: {
    onCompositionStart: React.CompositionEventHandler<HTMLInputElement>;
    onCompositionUpdate: React.CompositionEventHandler<HTMLInputElement>;
    onCompositionEnd: React.CompositionEventHandler<HTMLInputElement>;
    onKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
  };
  /** 输入框失焦处理（合成期失焦重置，S0-03 R2 残余 2 / T10）。 */
  onImeBlur: React.FocusEventHandler<HTMLInputElement>;
}

export function useImeBridge(opts: UseImeBridgeOptions): UseImeBridgeResult {
  const { enabled, getRect } = opts;
  const imeInputRef = useRef<HTMLInputElement | null>(null);
  // 状态机状态面（ref：高频事件不触发渲染；渲染面仅用 composing）
  const stateRef = useRef<ImeState>(createImeState());
  const [composing, setComposing] = useState(false);
  // 回调面（ref：事件处理器稳定引用，取最新值）
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const getRectRef = useRef(getRect);
  getRectRef.current = getRect;

  /** 状态机步进 + 渲染面同步。 */
  const step = useCallback((evt: ImeBridgeEvent) => {
    const result = imeBridgeStep(stateRef.current, evt);
    stateRef.current = result.state;
    setComposing(result.state.phase === 'composing');
    return result;
  }, []);

  // 停流/失活 → 强制复位（防合成悬置残留跨会话泄漏）
  useEffect(() => {
    if (!enabled) {
      stateRef.current = createImeState();
      setComposing(false);
    }
  }, [enabled]);

  // 面板激活 → 隐藏输入框持有焦点（可立即键入；IME 会话绑定本框焦点）
  useEffect(() => {
    if (enabled) {
      imeInputRef.current?.focus({ preventScroll: true });
    }
  }, [enabled]);

  /** 聚焦隐藏输入框（点击面板后；preventScroll 防页面跳动）。 */
  const focusImeInput = useCallback(() => {
    imeInputRef.current?.focus({ preventScroll: true });
  }, []);

  /** 候选窗定位：输入框移动至点击点下方 ~20px（OS IME 候选窗跟随本框）。
   * T8：超出面板边界 → 钳制到面板内（防候选窗不可见）。 */
  const positionImeInput = useCallback((clientX: number, clientY: number) => {
    const input = imeInputRef.current;
    if (!input) return;
    const rect = getRectRef.current();
    if (!rect) return;
    const maxX = Math.max(rect.width - IME_BOX_PX, 0);
    const maxY = Math.max(rect.height - IME_BOX_PX, 0);
    const left = Math.min(Math.max(clientX - rect.left, 0), maxX);
    const top = Math.min(Math.max(clientY - rect.top + IME_ANCHOR_GAP_PX, 0), maxY);
    input.style.left = `${left}px`;
    input.style.top = `${top}px`;
  }, []);

  /** compositionstart：接管信号 + 进入合成期（12 §3.7 清空缓冲）。 */
  const onCompositionStart = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      void e;
      optsRef.current.onUserInput?.();
      step({ type: 'compositionstart' });
    },
    [step],
  );

  const onCompositionUpdate = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      step({ type: 'compositionupdate', text: e.data });
    },
    [step],
  );

  /** compositionend：整串提交一次（空串 = Esc 取消，不注入）。 */
  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      const result = step({ type: 'compositionend', text: e.data });
      if (result.committed) {
        optsRef.current.onCommitted(result.committed);
      }
    },
    [step],
  );

  /** 229 合成键：仅兜底计数（12 §3.7；转发阻断由 usePanelInput 的
   * composing 面负责，本处理器不拦截事件冒泡）。 */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.keyCode === 229) step({ type: 'keydown229' });
    },
    [step],
  );

  // compositioncancel 非 React 合成事件清单成员（原生监听；S0-03 R2
  // 残余 2 / T10：窗口失焦等平台取消 → 退出合成不注入）
  useEffect(() => {
    const input = imeInputRef.current;
    if (!input) return;
    const onCancel = () => {
      step({ type: 'compositioncancel' });
    };
    input.addEventListener('compositioncancel', onCancel);
    return () => input.removeEventListener('compositioncancel', onCancel);
  }, [step]);

  /** 失焦：合成期 → 复位（不注入半截文本；T10 无悬置残留）。 */
  const onImeBlur = useCallback(() => {
    if (stateRef.current.phase === 'composing') {
      step({ type: 'reset' });
    }
  }, [step]);

  return {
    imeInputRef,
    composing,
    focusImeInput,
    positionImeInput,
    imeInputHandlers: {
      onCompositionStart,
      onCompositionUpdate,
      onCompositionEnd,
      onKeyDown,
    },
    onImeBlur,
  };
}
