/**
 * 消息列表窗口·视口切片：估算高度下的可视切片（轻量 overscan 窗口）。
 * 消息行高可变，仅作二次裁剪参考；生产路径优先 content-visibility + 尾部窗口。
 * 依赖 messageWindowPrimitives（normalizeMessageCount）。
 */

import { normalizeMessageCount } from './messageWindowPrimitives';

/**
 * 估算高度下的可视切片（轻量 overscan 窗口）。
 * 返回 [start, end) 与上下 spacer（px）。
 */
export type MessageViewportSlice = {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  windowed: boolean;
};

export const MESSAGE_VIEWPORT_OVERSCAN = 6;
const MESSAGE_VIEWPORT_THRESHOLD = 60;
export const MESSAGE_ESTIMATED_ROW_HEIGHT = 120;

/**
 * 从 heightCache 读取已知行高，合并 fallback（120）后返回平均行高。
 * 渐进精确：actual > estimated > 120。
 * 首次加载 cache 空 → fallback=120，行为不变。
 */
export function computeMessageViewportSlice(opts: {
  count: number;
  scrollTop?: number;
  viewportHeight?: number;
  estimatedRowHeight?: number;
  overscan?: number;
  threshold?: number;
  /** true = 不过滤（搜索 / 待审批 / 强制全量） */
  forceFull?: boolean;
}): MessageViewportSlice {
  // 避免 |0 截断大整数 / NaN 变成 0 的隐蔽路径：显式 finite + floor
  const count = normalizeMessageCount(opts.count);
  const full: MessageViewportSlice = {
    start: 0,
    end: count,
    topPad: 0,
    bottomPad: 0,
    windowed: false,
  };
  if (count === 0) return full;
  if (opts.forceFull) return full;
  const threshold =
    opts.threshold === undefined || !Number.isFinite(opts.threshold)
      ? MESSAGE_VIEWPORT_THRESHOLD
      : Math.max(0, Math.floor(opts.threshold));
  if (count <= threshold) return full;

  // 行高 / 视口 / 滚动 / overscan 全部 finite，杜绝 NaN pad 与 start
  const rowH =
    opts.estimatedRowHeight == null ||
    !Number.isFinite(opts.estimatedRowHeight) ||
    opts.estimatedRowHeight <= 0
      ? MESSAGE_ESTIMATED_ROW_HEIGHT
      : opts.estimatedRowHeight;
  const overscan =
    opts.overscan === undefined || !Number.isFinite(opts.overscan)
      ? MESSAGE_VIEWPORT_OVERSCAN
      : Math.max(0, Math.floor(opts.overscan));
  const scrollTop =
    opts.scrollTop == null || !Number.isFinite(opts.scrollTop)
      ? 0
      : Math.max(0, opts.scrollTop);
  const viewportHeight =
    opts.viewportHeight == null ||
    !Number.isFinite(opts.viewportHeight) ||
    opts.viewportHeight <= 0
      ? 600
      : opts.viewportHeight;

  const rawStart = Math.floor(scrollTop / rowH) - overscan;
  const start = Math.max(0, Math.min(count, rawStart));
  const visible = Math.ceil(viewportHeight / rowH) + overscan * 2;
  const end = Math.min(count, Math.max(start, start + visible));

  return {
    start,
    end,
    topPad: start * rowH,
    bottomPad: Math.max(0, (count - end) * rowH),
    windowed: start > 0 || end < count,
  };
}
