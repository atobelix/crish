/**
 * 剥离 ANSI 终端转义序列（含原始 ESC、字面 `\u001b` 文本与 `\x1b` 转义三种形态）。
 *
 * 集中唯一实现（boilerplate / toolOutput 共用）；有意匹配控制字符，遵循
 * utils/parseAnsi.ts 既有惯例以 eslint 注释申明理由。
 */
// eslint-disable-next-line no-control-regex -- 有意匹配 ANSI ESC 序列
const ANSI_ESCAPE_RE = /(?:\u001b|\\u001b|\x1b)?\[[0-9;]*[a-zA-Z]/g;

export function stripAnsiEscape(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}
