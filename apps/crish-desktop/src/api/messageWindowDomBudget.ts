/**
 * 消息列表窗口·DOM 预算：长文本/工具输出写入 DOM 前的字符与像素上限。
 * 纯常量 + 纯函数，叶子模块。
 */

/** 思考块写入 DOM 的基础字符上限（兼容旧版 4000 字符基准） */
export const THINKING_DOM_CHAR_CAP = 4000;
/** 行内思维链自适应视口预算上限（8k~12k 自适应视口，超长提供沉浸式查阅器） */
export const THINKING_INLINE_CHAR_CAP = 10000;
/** 工具展开体写入 DOM 的字符上限（超长需二次点「显示全部」） */
export const TOOL_OUTPUT_DOM_CHAR_CAP = 8000;
/** 工具展开体像素高度上限（Pretext 测量，超长截断） */
export const TOOL_OUTPUT_PIXEL_CAP = 600;

export interface ThinkingBudgetResult {
  displayText: string;
  isTruncated: boolean;
  totalChars: number;
}

/**
 * 计算思考文本 DOM 预算与截断状态（默认 10000 字符行内视口预算）
 */
export function budgetThinkingText(
  text: string,
  cap: number = THINKING_INLINE_CHAR_CAP
): ThinkingBudgetResult {
  const totalChars = text?.length ?? 0;
  if (!Number.isFinite(cap) || cap < 0 || !text || totalChars <= cap) {
    return {
      displayText: text || '',
      isTruncated: false,
      totalChars,
    };
  }
  const safeCap = Math.floor(cap);
  return {
    displayText: text.slice(0, safeCap),
    isTruncated: true,
    totalChars,
  };
}

/**
 * 长文本写入 DOM 前预算：超 cap 截断，返回是否截断。
 * 思考块 / 工具输出共用，避免单节点撑爆布局与 reconcile。
 * 非有限 / 负 cap → fail-open 不截断（调用方常量损坏时不空白化）。
 */
export function budgetDomText(
  text: string,
  cap: number
): { text: string; truncated: boolean; originalLength: number } {
  const originalLength = text?.length ?? 0;
  if (!Number.isFinite(cap) || cap < 0) {
    return { text: text || '', truncated: false, originalLength };
  }
  const safeCap = Math.floor(cap);
  if (!text || originalLength <= safeCap) {
    return { text: text || '', truncated: false, originalLength };
  }
  return {
    text: text.slice(0, safeCap) + '\n…（已截断）',
    truncated: true,
    originalLength,
  };
}
