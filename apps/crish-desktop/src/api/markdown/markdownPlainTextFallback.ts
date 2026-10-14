/**
 * 编译失败兜底用的安全纯文本投影。
 *
 * 同时满足两条历史战役的硬约束，且二者缺一不可：
 *
 * 1. VS-03「零空白 DOM」（`docs/message-disappearance-audit/`）：
 *    封口块编译失败时必须有可读内容，绝不允许历史消息退化成空白气泡（消息消失）。
 * 2. 流式战役「渲染失败不回退显示原文」（`b08063b1a` 流式增量会话契约）：
 *    兜底内容不得携带 Markdown 控制符（`##`、`**`、`|`、\`\`\`、`>`、`-` 列表符等），
 *    只保留语义正文。
 *
 * 因此这里不是"原样输出源码"，也不是"输出空串"，而是把 Markdown 投影为
 * 去掉控制符的纯语义文本；组件仍以 React 文本子节点渲染，天然转义，零 XSS 面。
 */

const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;
const IMAGE_LINK = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s>]+)>/g;
const ATX_HEADING = /^\s{0,3}#{1,6}\s+/;
const BLOCKQUOTE = /^\s{0,3}>\s?/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const THEMATIC_OR_SETEXT = /^[ \t]*(?:={2,}|-{2,})[ \t]*$/;
/** 表格分隔行 / 空表格行：去掉管道后只剩对齐与分隔字符。 */
const SEPARATOR_ONLY = /^[ \t:|-]*$/;
const STRONG = /\*\*([^*]+)\*\*/g;
const EMPHASIS = /\*([^*\n]+)\*/g;
const UNDERLINE_STRONG = /__([^_]+)__/g;
const STRIKETHROUGH = /~~([^~]+)~~/g;
const INLINE_CODE = /`([^`]+)`/g;
const RESIDUAL_MARKER_RUN = /[ \t]*[`*~]{2,}[ \t]*/g;
const RESIDUAL_EDGE_MARKER = /^[ \t]*[`*~]+[ \t]*|[ \t]*[`*~]+[ \t]*$/g;
const HORIZONTAL_SPACE = /[ \t]+/g;

/**
 * 将 Markdown 投影为不含控制符的纯文本；语义正文完整保留。
 *
 * 行结构被保留（`white-space: pre-wrap` 下可见），空行与纯语法行被丢弃。
 */
export function toMarkdownPlainTextFallback(markdown: string): string {
  if (!markdown) return '';

  const normalized = markdown.replace(/\r\n?/g, '\n');
  // 图片 / 链接只保留可见语义（alt / 标签），URL 与语法括号不进入兜底文本
  const linked = normalized
    .replace(IMAGE_LINK, '$1')
    .replace(LINK, '$1')
    .replace(AUTOLINK, '$1');

  const kept: string[] = [];
  for (const rawLine of linked.split('\n')) {
    // 围栏开关行只是语法，代码正文原本就在独立行中，不会被丢掉
    if (FENCE_LINE.test(rawLine)) continue;

    let line = rawLine
      .replace(ATX_HEADING, '')
      .replace(BLOCKQUOTE, '')
      .replace(LIST_MARKER, '')
      .replace(/\|/g, ' ');
    // 表格分隔行、水平线与 setext 下划线都是纯语法，正文里没有对应内容
    if (THEMATIC_OR_SETEXT.test(line) || SEPARATOR_ONLY.test(line)) continue;

    line = line
      .replace(STRONG, '$1')
      .replace(EMPHASIS, '$1')
      .replace(UNDERLINE_STRONG, '$1')
      .replace(STRIKETHROUGH, '$1')
      .replace(INLINE_CODE, '$1')
      // 残留的不配对控制符同样不得泄漏到兜底文本
      .replace(RESIDUAL_MARKER_RUN, ' ')
      .replace(RESIDUAL_EDGE_MARKER, '')
      .replace(HORIZONTAL_SPACE, ' ')
      .trim();

    if (!line) continue;
    kept.push(line);
  }

  return kept.join('\n');
}
