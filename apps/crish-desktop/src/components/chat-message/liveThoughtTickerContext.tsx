/**
 * liveThoughtTickerContext.tsx
 *
 * 运行态思考行的跨层传递通道（用户裁决 2026-11-06 第 8/9 条合成口径）：
 * AI 运行期间，过程段的当前思考与最新工具活动共用工具组组头 ticker
 * 作为唯一动态面——思考内容在摘要行内滚动/轮替呈现，思考行本身回到
 * 静态标签（「思考中」+ 状态点），不再自带第二条动态通道。
 *
 * 提供方（按段/节粒度，二选一、内层优先）：
 * - FoldableProcessSection：段内含 thought 与 tools 且段 live 时提供；
 * - MessageToolCallsSection：items 内混合 thought 且其 live 时提供。
 * 消费方：
 * - FoldableToolGroup：未封口时把 line 注入 useHeaderTicker 的思考项；
 * - ReasoningRow：hosted 时抑制自身 live 摘要（防双通道同内容并行滚动）。
 *
 * 本模块只依赖 React，禁止反向引用任何组件模块（防循环依赖）。
 */
import * as React from 'react';

export interface LiveThoughtTickerValue {
  /** 当前思考的最新行（纯文本，已剥除行内 markdown 标记）；无则 null */
  line: string | null;
  /** 本段思考是否已由组头 ticker 承载（思考行据此抑制自身 live 摘要） */
  hosted: boolean;
  /**
   * 本段是否处于流式活跃态。组级 isSealed 缺失（undefined，单项领衔的
   * 组块在 MessageToolCallsSection 处取不到组封口信号）时，组以本信号
   * 回退判定自身 live——否则这类组运行中不轮播、思考不入列、封口不收敛。
   */
  sectionLive: boolean;
}

const DEFAULT_VALUE: LiveThoughtTickerValue = {
  line: null,
  hosted: false,
  sectionLive: false,
};

const LiveThoughtTickerContext =
  React.createContext<LiveThoughtTickerValue>(DEFAULT_VALUE);

export const LiveThoughtTickerProvider = LiveThoughtTickerContext.Provider;

export function useLiveThoughtTicker(): LiveThoughtTickerValue {
  return React.useContext(LiveThoughtTickerContext);
}
