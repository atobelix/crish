/**
 * inlineParser — 行内 Markdown 语法解析器
 *
 * 这是 Token-in-Document 架构的核心：文档里保存的是**真实的 Markdown 源码字符**
 * （`**`、`` ` ``、`[](...)` 全部作为真字符存在），本解析器负责从一段纯文本中
 * 还原出「哪些区间该带什么 mark」以及「哪些区间是语法分隔符」。
 *
 * 与旧版 InlineDecorationPlugin 的本质区别：
 *   旧版 —— 文档里没有 `**`，靠 Decoration.widget 伪造出来给人看；
 *           用户按 Backspace 删到的是正文，语法无法用键盘编辑。
 *   本版 —— 文档里就是 `**`，隐藏与否只是 CSS 的事；
 *           删一个 `*` 就真的会让加粗降级，与 Obsidian 行为一致。
 *
 * 算法：CommonMark 的 delimiter-stack 简化版。
 *   1. 先扫「硬 token」——转义、代码段、链接。它们内部不参与强调符号配对（masked）。
 *   2. 再扫 delimiter run（连续的 * _ ~ =），记录每个 run 能否 open / close。
 *   3. 从左到右遍历 closer，向前找最近的可用 opener 配对；
 *      opener 从右端消耗、closer 从左端消耗，从而天然支持 `***x***` 这类嵌套。
 *
 * 复杂度 O(n)，n 为单个文本块的长度（通常几十到几百字符）。
 */

/* ────────────────────────────────────────────
 * 类型
 * ──────────────────────────────────────────── */

/** 本解析器支持的行内 mark */
export type InlineMarkName =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'highlight'
  | 'code'
  | 'link';

/** 一段 mark 的作用区间（**包含**两侧的语法分隔符） */
export interface MarkSpan {
  name: InlineMarkName;
  /** 块内相对偏移，闭区间起点 */
  from: number;
  /** 块内相对偏移，开区间终点 */
  to: number;
  /** link 的 href 等附加属性 */
  attrs?: Record<string, unknown>;
}

/**
 * 一段语法分隔符区间（`**`、`` ` ``、`[`、`](url)`、转义反斜杠）。
 *
 * `scopeFrom`/`scopeTo` 是它的「显形作用域」：当光标或选区与该作用域相交时，
 * 这段分隔符就显形；否则用 CSS 隐藏。对 mark 分隔符而言作用域就是整个 MarkSpan，
 * 对转义符而言是 `\` 加它转义的那个字符。
 */
export interface SyntaxSpan {
  from: number;
  to: number;
  scopeFrom: number;
  scopeTo: number;
}

export interface InlineParseResult {
  marks: MarkSpan[];
  syntax: SyntaxSpan[];
}

/* ────────────────────────────────────────────
 * 字符分类
 * ──────────────────────────────────────────── */

const PUNCT_RE = /[!-#%-*,-/:;?@[-\]_{}¡§«¶·»¿‐-‧‰-⁞]/;
const DELIM_CHARS = new Set(['*', '_', '~', '=']);
/** 可被反斜杠转义的字符（CommonMark 规定为全部 ASCII 标点） */
const ESCAPABLE_RE = /[!-/:-@[-`{-~]/;

function isWhitespace(ch: string): boolean {
  return ch === '' || ch === ' ' || ch === '\t' || ch === '\n' || ch === ' ';
}

function isPunct(ch: string): boolean {
  return ch !== '' && PUNCT_RE.test(ch);
}

function isAlnum(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/* ────────────────────────────────────────────
 * delimiter run
 * ──────────────────────────────────────────── */

interface DelimRun {
  char: string;
  from: number;
  to: number;
  canOpen: boolean;
  canClose: boolean;
  /** opener 从右端消耗掉的字符数 */
  usedRight: number;
  /** closer 从左端消耗掉的字符数 */
  usedLeft: number;
}

function availableAsOpener(r: DelimRun): number {
  return r.to - r.from - r.usedRight - r.usedLeft;
}

function availableAsCloser(r: DelimRun): number {
  return r.to - r.from - r.usedRight - r.usedLeft;
}

/* ────────────────────────────────────────────
 * 主解析入口
 * ──────────────────────────────────────────── */

/**
 * 解析一个文本块的行内 Markdown 语法。
 *
 * @param text 块的纯文本内容（即 ProseMirror textblock 的 textContent）
 * @returns 该块应有的 mark 区间与语法分隔符区间
 */
export function parseInline(text: string): InlineParseResult {
  const n = text.length;
  const marks: MarkSpan[] = [];
  const syntax: SyntaxSpan[] = [];

  if (n === 0) return { marks, syntax };

  /** masked[i] === true 表示该位置已被硬 token 占用，不参与强调符号配对 */
  const masked = new Uint8Array(n);

  scanEscapes(text, masked, syntax);
  scanCodeSpans(text, masked, marks, syntax);
  scanLinks(text, masked, marks, syntax);
  scanEmphasis(text, masked, marks, syntax);

  marks.sort((a, b) => a.from - b.from || b.to - a.to);
  syntax.sort((a, b) => a.from - b.from);

  return { marks, syntax };
}

/* ────────────────────────────────────────────
 * 阶段 1：反斜杠转义
 * ──────────────────────────────────────────── */

function scanEscapes(text: string, masked: Uint8Array, syntax: SyntaxSpan[]): void {
  const n = text.length;
  for (let i = 0; i < n - 1; i++) {
    if (masked[i]) continue;
    if (text[i] !== '\\') continue;
    if (!ESCAPABLE_RE.test(text[i + 1])) continue;
    // `\` 本身是语法（隐藏），被转义的字符是普通文本但不可参与配对
    syntax.push({ from: i, to: i + 1, scopeFrom: i, scopeTo: i + 2 });
    masked[i] = 1;
    masked[i + 1] = 1;
    i++; // 跳过被转义的字符，避免 `\\*` 被误判
  }
}

/* ────────────────────────────────────────────
 * 阶段 2：行内代码段 `code`
 * ──────────────────────────────────────────── */

function scanCodeSpans(
  text: string,
  masked: Uint8Array,
  marks: MarkSpan[],
  syntax: SyntaxSpan[],
): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (masked[i] || text[i] !== '`') {
      i++;
      continue;
    }
    // 读开栏 backtick run
    let openEnd = i;
    while (openEnd < n && text[openEnd] === '`') openEnd++;
    const runLen = openEnd - i;

    // 找长度完全相同的闭栏 run
    let j = openEnd;
    let closeStart = -1;
    while (j < n) {
      if (text[j] !== '`') {
        j++;
        continue;
      }
      let k = j;
      while (k < n && text[k] === '`') k++;
      if (k - j === runLen) {
        closeStart = j;
        break;
      }
      j = k;
    }

    if (closeStart === -1) {
      // 没有配对的闭栏，整个 run 当普通文本
      i = openEnd;
      continue;
    }

    const closeEnd = closeStart + runLen;
    const span: MarkSpan = { name: 'code', from: i, to: closeEnd };
    marks.push(span);
    syntax.push({ from: i, to: openEnd, scopeFrom: i, scopeTo: closeEnd });
    syntax.push({ from: closeStart, to: closeEnd, scopeFrom: i, scopeTo: closeEnd });
    for (let p = i; p < closeEnd; p++) masked[p] = 1;
    i = closeEnd;
  }
}

/* ────────────────────────────────────────────
 * 阶段 3：链接 [text](url)
 * ──────────────────────────────────────────── */

function scanLinks(
  text: string,
  masked: Uint8Array,
  marks: MarkSpan[],
  syntax: SyntaxSpan[],
): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (masked[i] || text[i] !== '[') {
      i++;
      continue;
    }

    // 找配对的 `]`（允许嵌套方括号）
    let depth = 0;
    let close = -1;
    for (let j = i; j < n; j++) {
      if (masked[j]) continue;
      if (text[j] === '[') depth++;
      else if (text[j] === ']') {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1 || close + 1 >= n || text[close + 1] !== '(') {
      i++;
      continue;
    }

    // 找配对的 `)`
    let paren = 0;
    let end = -1;
    for (let j = close + 1; j < n; j++) {
      if (text[j] === '(') paren++;
      else if (text[j] === ')') {
        paren--;
        if (paren === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) {
      i++;
      continue;
    }

    const href = text.slice(close + 2, end - 1).trim();
    marks.push({ name: 'link', from: i, to: end, attrs: { href } });
    // `[` 与 `](url)` 是语法；中间的链接文字保持可编辑、可继续解析强调
    syntax.push({ from: i, to: i + 1, scopeFrom: i, scopeTo: end });
    syntax.push({ from: close, to: end, scopeFrom: i, scopeTo: end });
    masked[i] = 1;
    for (let p = close; p < end; p++) masked[p] = 1;
    i = end;
  }
}

/* ────────────────────────────────────────────
 * 阶段 4：强调符号 ** * ~~ ==
 * ──────────────────────────────────────────── */

function scanEmphasis(
  text: string,
  masked: Uint8Array,
  marks: MarkSpan[],
  syntax: SyntaxSpan[],
): void {
  const runs = collectRuns(text, masked);

  for (let ci = 0; ci < runs.length; ci++) {
    const closer = runs[ci];
    if (!closer.canClose) continue;

    while (availableAsCloser(closer) > 0) {
      // 向前找最近的可用 opener
      let opener: DelimRun | null = null;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const cand = runs[oi];
        if (cand.char !== closer.char) continue;
        if (!cand.canOpen) continue;
        if (availableAsOpener(cand) <= 0) continue;
        opener = cand;
        break;
      }
      if (!opener) break;

      const bothTwo =
        availableAsOpener(opener) >= 2 && availableAsCloser(closer) >= 2;

      let name: InlineMarkName;
      let count: number;
      if (closer.char === '~' || closer.char === '=') {
        // ~~删除线~~ 与 ==高亮== 必须成对出现两个字符
        if (!bothTwo) break;
        name = closer.char === '~' ? 'strike' : 'highlight';
        count = 2;
      } else {
        name = bothTwo ? 'bold' : 'italic';
        count = bothTwo ? 2 : 1;
      }

      const openTo = opener.to - opener.usedRight;
      const openFrom = openTo - count;
      const closeFrom = closer.from + closer.usedLeft;
      const closeTo = closeFrom + count;

      // 保护：opener 必须整体位于 closer 之前
      if (openFrom < 0 || openTo > closeFrom) break;

      marks.push({ name, from: openFrom, to: closeTo });
      syntax.push({ from: openFrom, to: openTo, scopeFrom: openFrom, scopeTo: closeTo });
      syntax.push({ from: closeFrom, to: closeTo, scopeFrom: openFrom, scopeTo: closeTo });

      opener.usedRight += count;
      closer.usedLeft += count;
    }
  }
}

function collectRuns(text: string, masked: Uint8Array): DelimRun[] {
  const n = text.length;
  const runs: DelimRun[] = [];
  let i = 0;
  while (i < n) {
    if (masked[i] || !DELIM_CHARS.has(text[i])) {
      i++;
      continue;
    }
    const ch = text[i];
    let j = i;
    while (j < n && !masked[j] && text[j] === ch) j++;

    const before = i > 0 ? text[i - 1] : '';
    const after = j < n ? text[j] : '';

    const afterIsWs = isWhitespace(after);
    const beforeIsWs = isWhitespace(before);
    const afterIsPunct = isPunct(after);
    const beforeIsPunct = isPunct(before);

    // CommonMark 的 left/right-flanking 判定
    const leftFlanking =
      !afterIsWs && (!afterIsPunct || beforeIsWs || beforeIsPunct);
    const rightFlanking =
      !beforeIsWs && (!beforeIsPunct || afterIsWs || afterIsPunct);

    let canOpen = leftFlanking;
    let canClose = rightFlanking;

    // `_` 不参与词内强调，保证 snake_case_name 原样保留
    if (ch === '_') {
      if (isAlnum(before) && isAlnum(after)) {
        canOpen = false;
        canClose = false;
      } else {
        canOpen = leftFlanking && (!rightFlanking || beforeIsPunct);
        canClose = rightFlanking && (!leftFlanking || afterIsPunct);
      }
    }

    runs.push({ char: ch, from: i, to: j, canOpen, canClose, usedRight: 0, usedLeft: 0 });
    i = j;
  }
  return runs;
}

/* ────────────────────────────────────────────
 * 工具：显形判定
 * ──────────────────────────────────────────── */

/**
 * 判断一段语法分隔符在给定选区下是否应当显形。
 *
 * 规则与 Obsidian 一致：光标（或选区）只要碰到该分隔符所属的整个语法作用域，
 * 该作用域的所有分隔符一起显形——这样 `**粗体**` 的左右 `**` 永远同进同出。
 *
 * @param span  语法分隔符
 * @param from  选区起点（块内相对偏移）
 * @param to    选区终点（块内相对偏移）
 */
export function isSyntaxRevealed(span: SyntaxSpan, from: number, to: number): boolean {
  return from <= span.scopeTo && to >= span.scopeFrom;
}
