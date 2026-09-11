/**
 * 会话消息流虚拟滚动垂直节奏常量（与 ChatMessageList 几何 SSOT 对齐）。
 * 绝对定位切片不吃 CSS padding，必须进入文档高度与 translate 偏移。
 */
export const CHAT_SCROLL_PAD_TOP = 48;
export const CHAT_SCROLL_PAD_BOTTOM = 16;
/** 水平内边距仍由 CSS 承载（不参与纵向虚拟偏移） */
export const CHAT_SCROLL_PAD_X = 20;

export function chatSpacerHeight(contentHeight: number): number {
  const h = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  return CHAT_SCROLL_PAD_TOP + h + CHAT_SCROLL_PAD_BOTTOM;
}

/** 将 VSM 内容偏移映射到滚动文档坐标（含顶部内衬） */
export function contentOffsetToDocOffset(contentOffset: number): number {
  return CHAT_SCROLL_PAD_TOP + Math.max(0, contentOffset);
}
