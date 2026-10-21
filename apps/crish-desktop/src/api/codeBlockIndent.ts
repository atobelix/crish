/**
 * markdown.codeBlockIndent 读面：白名单归一、tab-size、行首缩进重写、DOM 投影。
 * 写面仍在外观设置（useAppearanceSettings）；本模块只读、不改设置表。
 */

import { getAppSettings } from './store-access/settingsAccess';

export const CODE_INDENT_TWO = '  ';
export const CODE_INDENT_FOUR = '    ';
export const CODE_INDENT_TAB = '\t';

/** 仅 2 空格 / 4 空格 / Tab；非法值回落 2 空格（与外观写面白名单一致） */
export function normalizeCodeBlockIndent(raw: unknown): string {
  if (
    raw === CODE_INDENT_TWO ||
    raw === CODE_INDENT_FOUR ||
    raw === CODE_INDENT_TAB
  ) {
    return raw;
  }
  return CODE_INDENT_TWO;
}

/** Tab 按 4 列显示（编辑器惯例）；空格档 = 空格数 */
export function tabSizeFromCodeIndent(raw: unknown): 2 | 4 {
  const indent = normalizeCodeBlockIndent(raw);
  return indent === CODE_INDENT_TWO ? 2 : 4;
}

export function codeIndentAttr(raw: unknown): '2' | '4' | 'tab' {
  const indent = normalizeCodeBlockIndent(raw);
  if (indent === CODE_INDENT_TAB) return 'tab';
  return indent === CODE_INDENT_FOUR ? '4' : '2';
}

/** store 优先，未水合或未就绪时回退默认 2 空格 */
export function readCodeBlockIndent(): string {
  try {
    const fromStore = getAppSettings()?.markdown?.codeBlockIndent;
    if (fromStore !== undefined) return normalizeCodeBlockIndent(fromStore);
  } catch {
    /* store 未就绪 */
  }
  return CODE_INDENT_TWO;
}

/** 投影到 html：--user-md-code-tab-size + data-code-indent（tab-size 可继承）。
 * T-BLK-07b：A 类 token --md-code-tab-size 由 tokens.css 静态声明
 * var(--user-md-code-tab-size, 2) 派生，JS 只写 --user-* 运行期参数（B 类登记）。 */
export function applyCodeBlockIndentToDocument(raw?: unknown): void {
  if (typeof document === 'undefined') return;
  const indent =
    raw === undefined ? readCodeBlockIndent() : normalizeCodeBlockIndent(raw);
  const tabSize = tabSizeFromCodeIndent(indent);
  const html = document.documentElement;
  html.style.setProperty('--user-md-code-tab-size', String(tabSize));
  html.setAttribute('data-code-indent', codeIndentAttr(indent));
}

function visualColumns(ws: string, tabSize: number): number {
  let col = 0;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === '\t') {
      col = Math.floor(col / tabSize) * tabSize + tabSize;
    } else {
      col += 1;
    }
  }
  return col;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function detectIndentWidth(widths: number[]): number {
  if (widths.length === 0) return 0;
  let g = widths[0]!;
  for (let i = 1; i < widths.length; i++) g = gcd(g, widths[i]!);
  if (g < 2) return 0;
  if (widths.some((w) => w % 4 === 2)) return 2;
  if (g % 4 === 0) return 4;
  if (g % 2 === 0) return 2;
  return 0;
}

/**
 * 按探测到的缩进级把行首空白换成目标单位。
 * 探测宽度小于 2（1 空格 / 不对齐）原样返回，不碰行内空白。
 */
export function rematerializeLeadingIndent(
  code: string,
  rawIndent?: unknown
): string {
  const unit = normalizeCodeBlockIndent(rawIndent);
  const tabSize = tabSizeFromCodeIndent(unit);
  const lines = code.split('\n');
  const widths: number[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = /^[ \t]*/.exec(line);
    const w = visualColumns(m?.[0] ?? '', tabSize);
    if (w > 0) widths.push(w);
  }
  const detected = detectIndentWidth(widths);
  if (detected < 2) return code;

  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const m = /^[ \t]*/.exec(line);
    const ws = m?.[0] ?? '';
    const cols = visualColumns(ws, tabSize);
    const levels = Math.floor(cols / detected);
    const rem = cols - levels * detected;
    const nextWs = unit.repeat(levels) + (rem > 0 ? ' '.repeat(rem) : '');
    out.push(nextWs + line.slice(ws.length));
  }
  return out.join('\n');
}

type AbsRepl = { start: number; end: number; insert: string };

function applyAbsRepl(nodes: Text[], repl: AbsRepl): void {
  let offset = 0;
  let first: { node: Text; localStart: number } | null = null;
  const slices: Array<{ node: Text; localStart: number; localEnd: number }> =
    [];
  for (const node of nodes) {
    const len = node.data.length;
    const ns = offset;
    const ne = offset + len;
    if (repl.end > ns && repl.start < ne) {
      const ls = Math.max(0, repl.start - ns);
      const le = Math.min(len, repl.end - ns);
      if (!first) first = { node, localStart: ls };
      slices.push({ node, localStart: ls, localEnd: le });
    }
    offset = ne;
  }
  if (!first) return;
  for (let i = slices.length - 1; i >= 0; i--) {
    const s = slices[i]!;
    s.node.data =
      s.node.data.slice(0, s.localStart) + s.node.data.slice(s.localEnd);
  }
  const n = first.node;
  n.data =
    n.data.slice(0, first.localStart) +
    repl.insert +
    n.data.slice(first.localStart);
}

function patchLeadingIndentInElement(el: Element, unit: string): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  if (nodes.length === 0) return;
  const full = nodes.map((n) => n.data).join('');
  const next = rematerializeLeadingIndent(full, unit);
  if (next === full) return;
  if (nodes.length === 1) {
    nodes[0]!.data = next;
    return;
  }

  const fullLines = full.split('\n');
  const nextLines = next.split('\n');
  if (fullLines.length !== nextLines.length) {
    nodes[0]!.data = next;
    for (let i = 1; i < nodes.length; i++) nodes[i]!.data = '';
    return;
  }

  const repls: AbsRepl[] = [];
  let abs = 0;
  for (let li = 0; li < fullLines.length; li++) {
    const fl = fullLines[li]!;
    const nl = nextLines[li]!;
    const fWs = (/^[ \t]*/.exec(fl) ?? [''])[0]!;
    const nWs = (/^[ \t]*/.exec(nl) ?? [''])[0]!;
    if (fWs !== nWs) {
      repls.push({ start: abs, end: abs + fWs.length, insert: nWs });
    }
    abs += fl.length + (li < fullLines.length - 1 ? 1 : 0);
  }
  for (let i = repls.length - 1; i >= 0; i--) applyAbsRepl(nodes, repls[i]!);
}

/** 高亮 span 保留：只改 .md-code-pre 行首空白 */
export function applyCodeIndentToRenderedRoot(
  root: ParentNode,
  rawIndent?: unknown
): void {
  if (typeof document === 'undefined') return;
  const unit =
    rawIndent === undefined
      ? readCodeBlockIndent()
      : normalizeCodeBlockIndent(rawIndent);
  const pres = root.querySelectorAll('.md-code-pre, .md-code-block pre');
  for (let i = 0; i < pres.length; i++) {
    const pre = pres[i]!;
    const code = pre.querySelector('code') ?? pre;
    patchLeadingIndentInElement(code, unit);
  }
}

/** 字符串 HTML → 行首缩进重写（技能预览 / 文件 markdown 渲染） */
export function rematerializeMarkdownHtml(
  html: string,
  rawIndent?: unknown
): string {
  if (!html || typeof document === 'undefined') return html;
  if (!html.includes('md-code-')) return html;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  applyCodeIndentToRenderedRoot(wrap, rawIndent);
  return wrap.innerHTML;
}
