/**
 * 行内格式化：code 占位保护、粗体/斜体、CJK wbr。
 *
 * 从 markdownPlugins.ts 拆出（T4-11 SR-06-R3）：仅处理标签外文本的
 * 行内格式，不处理 HTML 标签；由 applyInline 按标签外文本切分调用。
 */

import { wrapCjkTextSegment } from './markdownSanitizer';

/** 列表缩进视觉宽度：Tab → 对齐到 4 列，避免 \t 嵌套错位 */
export function visualIndent(ws: string): number {
  let n = 0;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === '\t') n += 4 - (n % 4);
    else n += 1;
  }
  return n;
}

/**
 * 纯文本段行内格式：code 占位保护后再 bold/italic，最后 CJK wbr。
 * 不处理 HTML 标签；由 applyInline 按标签外文本切分调用。
 */
function formatMarkdownTextSegment(text: string): string {
  if (!text) return '';
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const i = codes.length;
    codes.push(`<code class="md-inline-code">${code}</code>`);
    return `%%CODE${i}%%`;
  });
  // 粗体先于斜体；斜体仅同行、非空，避免未闭合 * 吞掉整段
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体：开口 * 后不能是空白（否则与「* 列表项」冲突，会吞掉列表标记并留下残片）
  s = s.replace(
    /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    (full, inner: string) => {
      const t = inner.trim();
      // 过长或像整句未闭合时不套 em（防止 * 与远处 * 配对）
      if (!t || t.length > 80) return full;
      if (/\s{2,}/.test(inner)) return full;
      return `<em>${inner}</em>`;
    }
  );
  s = s.replace(/%%CODE(\d+)%%/g, (_, i) => codes[Number(i)] || '');
  return wrapCjkTextSegment(s);
}

/**
 * 行内格式：仅处理标签外文本，避免
 * - 破坏已还原的 <a href> / <img src> 属性（* 被当成斜体）
 * - 把 code 内的 * 再套 <em>
 */
export function applyInline(html: string): string {
  if (!html) return '';
  // 无标签时仍走 CJK 快路径（format 内也会 wbr）
  return html.replace(
    /(^|>)([^<]*)/g,
    (_full, prefix: string, text: string) => {
      return prefix + formatMarkdownTextSegment(text);
    }
  );
}
