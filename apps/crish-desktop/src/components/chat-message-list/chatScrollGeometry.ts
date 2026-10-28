/**
 * 会话消息流虚拟滚动垂直节奏常量（与 ChatMessageList 几何 SSOT 对齐）。
 * 绝对定位切片不吃 CSS padding，必须进入文档高度与 translate 偏移。
 * P3-T02/T03: 水平内衬已单点收敛至 .listInner 的 CSS 变量（--stream-pad-x），
 * 切片绝对定位使用 left: 0, right: 0，不再维护 TS 侧静态 CHAT_SCROLL_PAD_X 双源常量。
 */
export const CHAT_SCROLL_PAD_TOP = 48;
export const CHAT_SCROLL_PAD_BOTTOM = 16;

/**
 * 运行时从 DOM 元素或全局读取 `--stream-pad-x`（兼容 fallback `--chat-stream-pad-x`, 20px）。
 * CSS 为唯一样式真源，本函数仅供非样式计算场景安全读取。
 */
export function readStreamPadX(el?: HTMLElement | null): number {
  if (
    typeof window === 'undefined' ||
    typeof getComputedStyle === 'undefined'
  ) {
    return 20;
  }
  const target =
    el || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return 20;
  const style = getComputedStyle(target);
  const raw =
    style.getPropertyValue('--stream-pad-x') ||
    style.getPropertyValue('--chat-stream-pad-x');
  const val = parseFloat(raw);
  return Number.isFinite(val) && val >= 0 ? val : 20;
}

/**
 * 运行时从 DOM 元素读取对话流水平安全内衬（左侧行首线 + 右侧功能区避让区）。
 * 严格基于盒模型与 --chat-stream-pad-x 契约，保证几何测量与 CSS 布局的单源真理（SSOT）。
 */
export function readStreamPadding(el?: HTMLElement | null): {
  padStart: number;
  padEnd: number;
} {
  const padX = readStreamPadX(el);
  if (
    typeof window === 'undefined' ||
    typeof getComputedStyle === 'undefined'
  ) {
    return { padStart: padX, padEnd: padX };
  }
  const target =
    el || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return { padStart: padX, padEnd: padX };
  const style = getComputedStyle(target);
  const padLeftRaw = parseFloat(style.getPropertyValue('padding-left'));
  const padRightRaw = parseFloat(style.getPropertyValue('padding-right'));
  const padStart =
    Number.isFinite(padLeftRaw) && padLeftRaw > 0 ? padLeftRaw : padX;
  const padEnd =
    Number.isFinite(padRightRaw) && padRightRaw > 0 ? padRightRaw : padX;
  return {
    padStart,
    padEnd,
  };
}

export function chatSpacerHeight(contentHeight: number): number {
  const h =
    Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  return CHAT_SCROLL_PAD_TOP + h + CHAT_SCROLL_PAD_BOTTOM;
}

/** 将 VSM 内容偏移映射到滚动文档坐标（含顶部内衬） */
export function contentOffsetToDocOffset(contentOffset: number): number {
  return CHAT_SCROLL_PAD_TOP + Math.max(0, contentOffset);
}
