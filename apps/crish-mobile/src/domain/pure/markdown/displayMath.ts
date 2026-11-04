// 块级公式识别（批 E，2026-11-03)：无 markdown 数学插件的前提下，在 AST
// 层识别「独立成段的展示公式」——段落纯文本（仅 text / break span）整体被
// $$…$$ 或 \[…\] 包裹时，剥出公式原文交呈现层经 WebView KaTeX 渲染。
// 口径：
// - 只认整段公式：与正文混排的 $…$ / \(…\) 行内公式不识别，保持原文呈现
//   （RN Text 内无法嵌块级渲染面，混排公式留原文是诚实口径）；
// - 段内出现 strong/link/code 等任何非纯文本 span 即不认（公式原文须逐字
//   保真，格式 span 会改字）；
// - 空公式（定界符间无内容）不认，回段落原文。
import type { MdSpan } from './types';

/** 段落 span 序列 → 展示公式原文；非整段公式返回 null */
export function extractDisplayMath(spans: readonly MdSpan[]): string | null {
  let text = '';
  for (const span of spans) {
    if (span.type === 'text') {
      text += span.text;
    } else if (span.type === 'break') {
      text += '\n';
    } else {
      return null;
    }
  }
  const trimmed = text.trim();
  const delimiters: ReadonlyArray<readonly [string, string]> = [
    ['$$', '$$'],
    ['\\[', '\\]'],
  ];
  for (const [open, close] of delimiters) {
    if (
      trimmed.length > open.length + close.length &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      const inner = trimmed
        .slice(open.length, trimmed.length - close.length)
        .trim();
      return inner === '' ? null : inner;
    }
  }
  return null;
}

/** 围栏语言标注是否为公式块（```math / ```latex / ```tex 直出公式原文） */
export function isMathFenceLang(lang: string | null): boolean {
  if (!lang) return false;
  const normalized = lang.trim().toLowerCase();
  return (
    normalized === 'math' ||
    normalized === 'latex' ||
    normalized === 'tex' ||
    normalized === 'katex'
  );
}

/** 围栏语言标注是否为 Mermaid 图块 */
export function isMermaidFenceLang(lang: string | null): boolean {
  return !!lang && lang.trim().toLowerCase() === 'mermaid';
}
