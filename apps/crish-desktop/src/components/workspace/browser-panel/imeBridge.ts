/**
 * IME 隐藏输入框桥 —— 纯状态机层（P1-B2：12 文档 §3.7 + S0-03 实测背书）。
 *
 * 零副作用、可独立单测；DOM 事件由 useImeBridge 接入。
 *
 * ## 流程（12 文档 §3.7）
 * - compositionstart → 进入合成期，清空缓冲；
 * - compositionupdate → 缓冲 = 组合文本（提交面不使用缓冲——见下）；
 * - compositionend → 整串文本一次注入（S0-03 C3：防 surrogate pair 切分）；
 *   文本为空（Esc 取消合成）→ 不注入（S0-03 C2/C4 语义）；
 * - compositioncancel（平台取消合成，S0-03 R2 残余 2 / P1 T10）→ 退出合成不注入；
 * - keydown(229) 合成键兜底计数（12 §3.7：无 composition 事件的 229 键流
 *   ≥ 阈值且 500ms 无更新 → 合成悬置，缓冲清空重置，防缓冲泄漏）。
 *
 * ## 提交面说明（缓冲 vs 事件数据）
 * 提交文本取 `compositionend` 事件自身的 `data`（DOM 权威值），不使用
 * 逐次 compositionupdate 累加的缓冲——个别输入法事件序列异常（缺 end /
 * 延迟 end）时，缓冲可能陈旧，事件数据才是上屏的最终文本（12 §3.7 整串
 * 注入语义 + S0-03 C2 实测：页面仅收 beforeinput(insertText)+input）。
 * 缓冲仅服务于悬置兜底计数与后续内联预览增强（S0-03 R6：面板内预览列为
 * 后续增强，本期不做）。
 */

/** 合成相位（idle = 无活动合成；composing = 合成进行中）。 */
export type ImePhase = 'idle' | 'composing';

/** IME 桥状态（纯逻辑面，ref 持有，不驱动渲染——渲染面仅用 phase）。 */
export interface ImeState {
  phase: ImePhase;
  /** compositionupdate 缓冲（悬置兜底与后续预览用；提交以 end 事件数据为准）。 */
  buffer: string;
  /** 229 合成键计数（12 §3.7 兜底：无 composition 事件的 229 键流悬置判定）。 */
  hangCount: number;
  /** 最近一次事件时间戳（悬置窗口判定基准）。 */
  lastEventAt: number;
}

/** 状态机事件（DOM 事件归一化；reset = 窗口失焦/停流等强制复位）。 */
export type ImeBridgeEvent =
  | { type: 'compositionstart' }
  | { type: 'compositionupdate'; text: string }
  | { type: 'compositionend'; text: string }
  | { type: 'compositioncancel' }
  | { type: 'keydown229' }
  | { type: 'reset' };

/** 状态机选项（阈值/时钟可注入，测试用）。 */
export interface ImeBridgeOptions {
  /** 229 键流悬置阈值（12 §3.7：计数超 3 次）。 */
  hangThreshold?: number;
  /** 悬置判定窗口（12 §3.7：500ms 无更新）。 */
  hangWindowMs?: number;
  /** 时钟注入（测试用；缺省 Date.now）。 */
  now?: () => number;
}

/** 状态机步进结果。 */
export interface ImeBridgeResult {
  state: ImeState;
  /** compositionend 待注入整串文本；null = 不注入（合成取消/空串/悬置）。 */
  committed: string | null;
  /** 本次步进触发了悬置重置（229 键流计数超限，防缓冲泄漏）。 */
  hungReset: boolean;
}

/** 229 键流悬置阈值默认值（12 §3.7：计数超 3 次）。 */
export const DEFAULT_HANG_THRESHOLD = 3;
/** 悬置判定窗口默认值（12 §3.7：500ms 无更新）。 */
export const DEFAULT_HANG_WINDOW_MS = 500;

/** 初始状态（idle，无缓冲；时间戳注入供测试确定性）。 */
export function createImeState(now = 0): ImeState {
  return { phase: 'idle', buffer: '', hangCount: 0, lastEventAt: now };
}

/** 状态机步进：单事件推进，返回新状态 + 提交面（committed/hungReset）。 */
export function imeBridgeStep(
  prev: ImeState,
  evt: ImeBridgeEvent,
  opts: ImeBridgeOptions = {},
): ImeBridgeResult {
  const threshold = opts.hangThreshold ?? DEFAULT_HANG_THRESHOLD;
  const windowMs = opts.hangWindowMs ?? DEFAULT_HANG_WINDOW_MS;
  const now = (opts.now ?? Date.now)();

  switch (evt.type) {
    case 'compositionstart':
      return {
        state: { phase: 'composing', buffer: '', hangCount: 0, lastEventAt: now },
        committed: null,
        hungReset: false,
      };
    case 'compositionupdate':
      if (prev.phase !== 'composing') {
        // 防御乱序：无合成期不记缓冲（DOM 契约 start 先于 update）
        return { state: prev, committed: null, hungReset: false };
      }
      return {
        state: { ...prev, buffer: evt.text, lastEventAt: now },
        committed: null,
        hungReset: false,
      };
    case 'compositionend':
      if (prev.phase !== 'composing') {
        // 悬置 end（无活动合成）忽略：不注入陈旧文本（T10 无残留语义）
        return { state: prev, committed: null, hungReset: false };
      }
      return {
        state: { phase: 'idle', buffer: '', hangCount: 0, lastEventAt: now },
        committed: evt.text ? evt.text : null,
        hungReset: false,
      };
    case 'compositioncancel':
      // 平台取消合成（窗口失焦等，S0-03 R2 残余 2）：不注入
      return { state: createImeState(now), committed: null, hungReset: false };
    case 'keydown229': {
      const hangCount = prev.hangCount + 1;
      // 12 §3.7 兜底：229 键流计数超阈值且 500ms 无更新 → 合成悬置，
      // 缓冲清空重置（防缓冲泄漏；相位保持——真正的 end 仍以其数据提交）
      if (hangCount > threshold && now - prev.lastEventAt >= windowMs) {
        return {
          state: { ...createImeState(now), phase: prev.phase },
          committed: null,
          hungReset: true,
        };
      }
      return {
        state: { ...prev, hangCount, lastEventAt: now },
        committed: null,
        hungReset: false,
      };
    }
    case 'reset':
      return { state: createImeState(now), committed: null, hungReset: false };
  }
}
