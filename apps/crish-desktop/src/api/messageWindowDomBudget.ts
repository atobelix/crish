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

export interface ThinkingBudgetOptions {
  cap?: number;
  mode?: 'head' | 'tail';
}

export interface ThinkingBudgetResult {
  displayText: string;
  isTruncated: boolean;
  totalChars: number;
  omittedHeadChars?: number;
}

/**
 * Safe Markdown Tail Slicer (DEC-06 / DIM-06):
 * 截取尾部 cap 字符时对齐最近的换行符 \n，并通过单遍轻量状态机自动补齐
 * 未闭合的 Markdown Code Fences (``` / ~~~) 与 LaTeX 界标 ($$ / $)，
 * 消除虚拟滚动与流式渲染时的重排抖动（Layout Thrashing）。
 */
export function sliceSafeTailMarkdown(
  text: string,
  cap: number = THINKING_INLINE_CHAR_CAP
): {
  displayText: string;
  isTruncated: boolean;
  totalChars: number;
  omittedHeadChars: number;
} {
  const totalChars = text?.length ?? 0;
  if (!Number.isFinite(cap) || cap <= 0 || !text || totalChars <= cap) {
    return {
      displayText: text || '',
      isTruncated: false,
      totalChars,
      omittedHeadChars: 0,
    };
  }

  const safeCap = Math.floor(cap);
  const rawStart = totalChars - safeCap;

  // 1. 对齐最近的换行符 \n（优先向后寻找换行符，避免切断单词或行中 markdown）
  let alignedStart = rawStart;
  const nextNewline = text.indexOf('\n', rawStart);
  if (nextNewline !== -1 && nextNewline < totalChars - 100) {
    alignedStart = nextNewline + 1;
  } else {
    const prevNewline = text.lastIndexOf('\n', rawStart);
    if (prevNewline !== -1 && prevNewline > rawStart - 500) {
      alignedStart = prevNewline + 1;
    }
  }

  const tail = text.slice(alignedStart);
  const omittedHeadChars = alignedStart;

  // 2. 分析前缀 text.slice(0, alignedStart) 的代码块与 LaTeX 界标状态
  const prefix = text.slice(0, alignedStart);
  const prefixLines = prefix.split(/\r?\n/);
  let inCodeBlock = false;
  let codeFence = '';
  let codeLang = '';

  for (const line of prefixLines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '';
      const lang = fenceMatch[2]?.trim() || '';
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fence;
        codeLang = lang;
      } else if (fence.startsWith(codeFence.slice(0, 3))) {
        inCodeBlock = false;
        codeFence = '';
        codeLang = '';
      }
    }
  }

  // 检查前缀 LaTeX $$ 块
  let prefixDoubleDollarCount = 0;
  let idx = 0;
  while ((idx = prefix.indexOf('$$', idx)) !== -1) {
    prefixDoubleDollarCount++;
    idx += 2;
  }
  const inDoubleDollar = prefixDoubleDollarCount % 2 !== 0;

  // 3. 头部补齐：如果切割点位于代码块或公式内部，在尾巴开头自动注入前导界标
  let prefixPatch = '';
  if (inCodeBlock && codeFence) {
    prefixPatch += `${codeFence}${codeLang ? ` ${codeLang}` : ''}\n`;
  }
  if (inDoubleDollar) {
    prefixPatch += '$$\n';
  }

  // 4. 分析 tail 内部的代码块与公式闭合情况
  const combined = prefixPatch + tail;
  const tailLines = combined.split(/\r?\n/);
  let tailInCode = false;
  let tailFence = '';

  for (const line of tailLines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '';
      if (!tailInCode) {
        tailInCode = true;
        tailFence = fence;
      } else if (fence.startsWith(tailFence.slice(0, 3))) {
        tailInCode = false;
        tailFence = '';
      }
    }
  }

  let tailDoubleDollarCount = 0;
  idx = 0;
  while ((idx = combined.indexOf('$$', idx)) !== -1) {
    tailDoubleDollarCount++;
    idx += 2;
  }
  const tailInDoubleDollar = tailDoubleDollarCount % 2 !== 0;

  // 5. 尾部补齐：若尾部有未闭合的代码块或公式，自动闭合
  let suffixPatch = '';
  if (tailInDoubleDollar) {
    suffixPatch += '\n$$';
  }
  if (tailInCode && tailFence) {
    suffixPatch += `\n${tailFence}`;
  }

  return {
    displayText: combined + suffixPatch,
    isTruncated: true,
    totalChars,
    omittedHeadChars,
  };
}

/**
 * 计算思考文本 DOM 预算与截断状态（默认 10000 字符行内视口预算）
 */
export function budgetThinkingText(
  text: string,
  options?: number | ThinkingBudgetOptions
): ThinkingBudgetResult {
  const cap =
    typeof options === 'number'
      ? options
      : (options?.cap ?? THINKING_INLINE_CHAR_CAP);
  const mode = typeof options === 'object' ? (options?.mode ?? 'head') : 'head';
  const totalChars = text?.length ?? 0;

  if (!Number.isFinite(cap) || cap < 0 || !text || totalChars <= cap) {
    return {
      displayText: text || '',
      isTruncated: false,
      totalChars,
      omittedHeadChars: 0,
    };
  }

  if (mode === 'tail') {
    return sliceSafeTailMarkdown(text, cap);
  }

  const safeCap = Math.floor(cap);
  return {
    displayText: text.slice(0, safeCap),
    isTruncated: true,
    totalChars,
    omittedHeadChars: 0,
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
