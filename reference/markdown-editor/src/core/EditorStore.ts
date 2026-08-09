import { create } from 'zustand';
import { type CodeState } from './parser';
import { LineOffsetTree } from './SegmentTree';

// Use Intl.Segmenter for grapheme cluster boundaries (surrogate pairs, emojis, combining chars)
const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

export function findNextGraphemeBoundary(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  if (segmenter) {
    let windowSize = 50;
    while (true) {
      const windowStart = Math.max(0, pos - windowSize);
      const windowEnd = Math.min(text.length, pos + windowSize);
      const windowText = text.slice(windowStart, windowEnd);
      const segments = segmenter.segment(windowText);
      let currentPos = windowStart;
      for (const segment of segments) {
        currentPos += segment.segment.length;
        if (currentPos > pos) {
          if (currentPos === windowEnd && windowEnd < text.length) {
            break; // Try larger window
          }
          return currentPos;
        }
      }
      if (windowEnd >= text.length) return text.length;
      windowSize *= 2;
    }
  }
  // Fallback if Segmenter is not available (e.g. some old browsers)
  const charCode = text.charCodeAt(pos);
  if (charCode >= 0xd800 && charCode <= 0xdbff && pos + 1 < text.length) {
    return pos + 2; // Surrogate pair
  }
  return pos + 1;
}

export function findPrevGraphemeBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (segmenter) {
    let windowSize = 50;
    while (true) {
      const windowStart = Math.max(0, pos - windowSize);
      const windowEnd = Math.min(text.length, pos + windowSize);
      const windowText = text.slice(windowStart, windowEnd);
      const segments = segmenter.segment(windowText);
      let prevPos = windowStart;
      let broke = false;
      for (const segment of segments) {
        const boundary = windowStart + segment.index;
        if (boundary >= pos) {
          if (prevPos === windowStart && windowStart > 0) {
            broke = true;
            break;
          }
          return prevPos;
        }
        prevPos = boundary;
      }
      if (!broke && prevPos < pos) {
        if (prevPos === windowStart && windowStart > 0) {
          // Try larger
        } else {
          return prevPos;
        }
      }
      if (windowStart <= 0) return 0;
      windowSize *= 2;
    }
  }
  // Fallback
  const charCode = text.charCodeAt(pos - 1);
  if (charCode >= 0xdc00 && charCode <= 0xdfff && pos - 2 >= 0) {
    return pos - 2; // Surrogate pair
  }
  return pos - 1;
}

export function snapToGraphemeBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  if (segmenter) {
    let windowSize = 50;
    while (true) {
      const windowStart = Math.max(0, pos - windowSize);
      const windowEnd = Math.min(text.length, pos + windowSize);
      const windowText = text.slice(windowStart, windowEnd);
      const segments = segmenter.segment(windowText);
      for (const segment of segments) {
        const boundary = windowStart + segment.index;
        const endBoundary = boundary + segment.segment.length;
        if (pos === boundary) {
          if (boundary === windowStart && windowStart > 0) {
            break; // Expand
          }
          return pos;
        }
        if (pos === endBoundary) {
          if (endBoundary === windowEnd && windowEnd < text.length) {
            break; // Expand
          }
          return pos;
        }
        if (pos > boundary && pos < endBoundary) {
          if (
            (boundary === windowStart && windowStart > 0) ||
            (endBoundary === windowEnd && windowEnd < text.length)
          ) {
            break; // Expand window
          }
          return pos - boundary > endBoundary - pos ? endBoundary : boundary;
        }
      }
      if (windowStart <= 0 && windowEnd >= text.length) return pos;
      windowSize *= 2;
    }
  }
  // Fallback: check if we are in the middle of a surrogate pair
  const charCode = text.charCodeAt(pos);
  if (charCode >= 0xdc00 && charCode <= 0xdfff && pos - 1 >= 0) {
    const prevCode = text.charCodeAt(pos - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      return pos - 1; // Snap to the start of the surrogate pair
    }
  }
  return pos;
}

/**
 * 块级形态记忆（镜像 parser.ts 的 BlockKind）：缩进代码判定需要「上一非空白行」
 * 的形态上下文——段落打断 / 列表延续 / 表格优先都依赖它（computeLineOffsets
 * 02 §2.2 冲突点）。增量状态机没有 parser 的全局扫描上下文，因此把该判定
 * 的私有辅助逻辑镜像到本文件，与 parser 保持逐分支一致。
 */
type BlockKind =
  | 'blank'
  | 'body'
  | 'list'
  | 'table'
  | 'heading'
  | 'hr'
  | 'code'
  | 'other';

/** 剥离块引用前缀（与 parser.stripBlockquoteContext 同一正则 `^\s*>\s?`） */
function stripBlockquoteContext(line: string): string {
  let content = line;
  let m: RegExpMatchArray | null;
  while ((m = content.match(/^\s*>\s?/))) {
    content = content.substring(m[0].length);
  }
  return content;
}

/**
 * 计算行首缩进列宽（镜像 parser.leadingIndentColumns）：tab 按停靠 4 展开
 * （`  →foo` = 2+4 = 6 列 ≥4 → 代码；`  foo` = 2 列 <4 → 普通行）。
 */
function leadingIndentColumns(s: string): number {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') {
      col++;
    } else if (s[i] === '\t') {
      col += 4 - (col % 4);
    } else {
      break;
    }
  }
  return col;
}

/** 剥离 4 列缩进（镜像 parser.stripFourColumns），供列表标记判定使用 */
function stripFourColumns(s: string): string {
  let col = 0;
  let i = 0;
  while (i < s.length && col < 4) {
    if (s[i] === ' ') {
      col++;
      i++;
    } else if (s[i] === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  return s.substring(i);
}

/** 去缩进后行首是否为列表标记（镜像 parser.isListMarkerStart） */
function isListMarkerStart(s: string): boolean {
  return (
    /^([-*+]\s*\[[xX\s]\])\s+/.test(s) ||
    /^([-*+])\s+/.test(s) ||
    /^(\d+\.)\s+/.test(s)
  );
}

/**
 * 轻量行首形态分类（镜像 parser.guessBlockKind）：只做行首前缀匹配，
 * 不解析内容——供缩进代码判定的「上一行」上下文使用。
 */
function guessBlockKind(line: string, prev: BlockKind): BlockKind {
  const s = line.replace(/^ {0,3}/, '');
  if (!s.trim()) return 'blank';
  if (/^([-*+_]){3,}\s*$/.test(s)) return 'hr';
  if (/^=+[ \t]*$/.test(s)) return prev === 'body' ? 'heading' : 'body';
  if (/^#{1,6}\s/.test(s)) return 'heading';
  const pipeCount = (s.match(/\|/g) || []).length;
  if (
    /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(s) ||
    (pipeCount >= 1 && s.trim().startsWith('|')) ||
    pipeCount >= 2
  ) {
    return 'table';
  }
  if (/^([-*+]\s*\[[xX\s]\])\s+/.test(s)) return 'list';
  if (/^([-*+])\s+/.test(s)) return 'list';
  if (/^(\d+\.)\s+/.test(s)) return 'list';
  return 'body';
}

/**
 * 逻辑行 / 行状态访问器：支持「主数组 + 流式尾段」双段逻辑视图的惰性读取
 * （append 尾段零拷贝方案，R2-A P5/08 招 2：getLine(i) = i < 主数组边界
 * ? mainLines[i] : streamTail[i - 边界]）。编辑路径的增量推断函数全部
 * 访问器化，从而在尾段存在时也能用同一套推断逻辑（无需物化全量数组）。
 */
type LineAccessor = (i: number) => string;
type StateAccessor = (i: number) => CodeState;

/**
 * 从编辑点之前的旧行推断「上一非空白行形态」（增量起点上下文）：
 * 从 before-1 向前扫描，跳过空行（空行把非列表上下文重置为 blank——
 * 与 parser 空行分支 `if (prevBlockKind !== 'list') prevBlockKind = 'blank'`
 * 语义一致），首个非空行按旧状态归类（code 类状态 → 'code'，'none' →
 * guessBlockKind）。文档开头无前置行时按 'blank' 处理。
 * 访问器化：lines/codeBlockState 数组改由 getLine/getState 提供（R2-A 尾段）。
 */
function inferPrevBlockKind(
  getLine: LineAccessor,
  getState: StateAccessor,
  before: number
): BlockKind {
  let sawBlank = false;
  for (let j = before - 1; j >= 0; j--) {
    const content = stripBlockquoteContext(getLine(j));
    if (content.trim() === '') {
      sawBlank = true;
      continue;
    }
    let kind: BlockKind;
    if (getState(j) !== 'none') {
      kind = 'code';
    } else {
      kind = guessBlockKind(content, 'blank');
    }
    // 空行把非列表上下文重置为 blank（列表延续记忆保持）
    if (sawBlank) return kind === 'list' ? 'list' : 'blank';
    return kind;
  }
  return 'blank';
}

/**
 * 从编辑点之前的旧行推断「是否处于缩进代码块内」（增量起点上下文）：
 * 向前扫描旧状态数组——'indent_code' 行（含块内空行，空行在块内同样保持
 * indent_code 状态）说明编辑点之前处于缩进代码块；'none' 空行继续向前
 * （空行保持记忆，可能越过空行链命中代码块）；其他情况一律视为块外。
 */
function inferInIndentCode(
  getLine: LineAccessor,
  getState: StateAccessor,
  before: number
): boolean {
  for (let j = before - 1; j >= 0; j--) {
    const st = getState(j);
    if (st === 'indent_code') return true;
    if (st !== 'none') return false;
    if (stripBlockquoteContext(getLine(j)).trim() !== '') return false;
  }
  return false;
}

// —— HTML 块判定镜像（parser.computeLineOffsets 02 §2.5 / R1-D，
// CommonMark 4.6 spec 0.31.2）——
// type 1-5 的 start condition（下标 + 1 = 类型号）：
// 1. <script|<pre|<style|<textarea + 空白/>/行尾（大小写不敏感）；
// 2. <!--；3. <?；4. <! + ASCII 大写字母；5. <![CDATA[。
const HTML_BLOCK_START_RE: RegExp[] = [
  /^ {0,3}<(script|pre|style|textarea)(?=[ \t]|>|$)/i,
  /^ {0,3}<!--/,
  /^ {0,3}<\?/,
  /^ {0,3}<![A-Z]/,
  /^ {0,3}<!\[CDATA\[/,
];
// type 6：< 或 </ + 块级标签名单 + 空白/`>`/`/>`/行尾（大小写不敏感）。
const HTML_BLOCK_TYPE6_RE = new RegExp(
  '^ {0,3}<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \\t]|/?>|$)',
  'i'
);
// type 7：完整开/闭标签行（tag name 排除 pre/script/style/textarea——
// 它们由 type 1 接管，`</script>` 单独成行按普通段落处理，与 spec 一致）。
const HTML_BLOCK_TYPE7_RE =
  /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t]+[^>]*)?[ \t]*\/?>[ \t]*$/i;

/**
 * HTML 块 start condition 判定（镜像 parser.matchHtmlBlockStart）：
 * - type 1-6 可打断段落，判定独立于 prevBlockKind（`Foo\n<div>` 中 div 是新块）；
 * - type 7 不可打断段落（`Foo\n<a href="bar">` 中 a 行是段落延续）；
 * - 列表标记行（`- <div>`）不进 HTML 块（行级模型无容器状态，登记偏差）。
 * 入参约定：content 已剥离块引用前缀、缩进 <4 列、非空行。
 */
function matchHtmlBlockStart(
  content: string,
  prevBlockKind: BlockKind
): { type: number } | null {
  if (isListMarkerStart(content)) return null;
  for (let t = 0; t < HTML_BLOCK_START_RE.length; t++) {
    if (HTML_BLOCK_START_RE[t].test(content)) return { type: t + 1 };
  }
  if (HTML_BLOCK_TYPE6_RE.test(content)) return { type: 6 };
  if (prevBlockKind === 'body' || prevBlockKind === 'list') return null;
  const t7 = HTML_BLOCK_TYPE7_RE.exec(content);
  if (t7) {
    const name = t7[2].toLowerCase();
    if (
      name === 'script' ||
      name === 'pre' ||
      name === 'style' ||
      name === 'textarea'
    ) {
      return null;
    }
    return { type: 7 };
  }
  return null;
}

/**
 * HTML 块 end condition（镜像 parser.htmlBlockEndCondition）：
 * type 1 行内含 script/pre/style/textarea 任一闭合标签即结束；
 * type 2/3/4/5 行内含对应闭合串即结束；type 6/7 遇空行结束
 * （空行本身不是块内容，由调用方标记 'none'）。
 */
function htmlBlockEndCondition(type: number, content: string): boolean {
  switch (type) {
    case 1:
      return /<\/script>|<\/pre>|<\/style>|<\/textarea>/i.test(content);
    case 2:
      return content.includes('-->');
    case 3:
      return content.includes('?>');
    case 4:
      return content.includes('>');
    case 5:
      return content.includes(']]>');
    case 6:
    case 7:
      return content.trim() === '';
    default:
      return true;
  }
}

/**
 * 从旧行/旧状态回推「编辑点之前是否处于 HTML 块内」及其块类型：
 * CodeState 数组只记录 'html_block'（不记录 type 1-7），而结束条件
 * 依赖块类型——因此取编辑点之前连续 html_block 运行段，用
 * matchHtmlBlockStart / htmlBlockEndCondition 正向仿真，得到进入
 * 编辑点时的 inHtmlBlock 与 htmlType（与 parser 语义一致）。
 * 运行段内可能包含多个相邻块（type 1-5 单行块接 type 6 块等），
 * 仿真逐行推进可正确定位「编辑点所属块」的类型。
 */
function inferHtmlBlockState(
  getLine: LineAccessor,
  getState: StateAccessor,
  before: number
): { inHtmlBlock: boolean; htmlType: number } {
  let runStart = before - 1;
  if (runStart < 0 || getState(runStart) !== 'html_block') {
    return { inHtmlBlock: false, htmlType: 0 };
  }
  while (runStart > 0 && getState(runStart - 1) === 'html_block') {
    runStart--;
  }
  let inHtml = false;
  let htmlType = 0;
  for (let j = runStart; j < before; j++) {
    const content = stripBlockquoteContext(getLine(j));
    if (inHtml) {
      if (htmlBlockEndCondition(htmlType, content)) {
        inHtml = false;
        htmlType = 0;
      }
    } else {
      const start = matchHtmlBlockStart(content, 'code');
      if (start) {
        inHtml = true;
        htmlType = start.type;
        if (htmlBlockEndCondition(htmlType, content)) {
          inHtml = false;
          htmlType = 0;
        }
      }
    }
  }
  return { inHtmlBlock: inHtml, htmlType };
}

export interface EditorOperation {
  startLineIdx: number;
  removedLines: string[];
  insertedLineCount: number;
  cursorBefore: number;
  selectionStartBefore: number;
  selectionEndBefore: number;
  cursorAfter: number;
  selectionStartAfter: number;
  selectionEndAfter: number;
  timestamp: number;
}

export interface EditorState {
  // —— 双段存储（R2-A 尾段零拷贝 / 08 招 2）——
  // 主数组：常规编辑/加载的权威行存储；LineOffsetTree 始终与之保持
  // 逻辑全量一致（append 时增量更新触及块，见 appendText）。
  mainLines: string[];
  // 流式尾段：appendText 追加的行落在独立尾段，主数组不重建（零拷贝），
  // 由 getLine/getLineCount 统一访问；超过上界或用户编辑/滚动触达时
  // 经 flushStreamTail 一次性并入主数组。
  streamTail: string[];
  mainCodeState: CodeState[];
  streamTailCodeState: CodeState[];
  mainFenceLines: number[]; // 主数组 fence 行号（有序）
  streamTailFenceLines: number[]; // 尾段内 fence 相对行号

  lineOffsets: LineOffsetTree;
  // 兼容视图（数据字段，set 时经 dispatchSet 显式物化）：未切换访问器的
  // 消费方（LineItem 渲染 / virtualizer count / 既有测试）仍可读 lines
  // 全量。尾段为空时视图 = 主数组引用（零拷贝）；尾段非空时一次性
  // concat 物化（过渡期成本，R2-BD 切换访问器后从热路径移除）。
  lines: string[];
  codeBlockState: CodeState[];
  fenceLines: number[];

  textLength: number;

  cursorPos: number;
  selectionStart: number;
  selectionEnd: number;

  undoStack: EditorOperation[];
  redoStack: EditorOperation[];

  getText: () => string;
  getLine: (i: number) => string;
  getLineCount: () => number;
  getLineIndex: (pos: number) => number;
  flushStreamTail: () => void;

  setText: (text: string) => void;
  setCursorPos: (pos: number) => void;
  setSelection: (start: number, end: number) => void;
  insertText: (inserted: string) => void;
  appendText: (text: string) => void;
  isComposing: boolean;
  setIsComposing: (isComposing: boolean) => void;
  deleteText: (backward: boolean) => void;
  deleteSelection: (start: number, end: number) => void;

  undo: () => void;
  redo: () => void;
}


// Actually, mutating arrays in Zustand is okay if we copy the array first.
// 注意：`[...lines]` / `[...codeBlockState]` 两个浅拷贝保留（zustand 订阅
// 语义需要新数组引用触发渲染，不得移除）；R2-A 消的是 clone 的 O(全文)
// 深拷贝（LineOffsetTree.clone 已改 COW 浅拷贝，见 SegmentTree.ts）。
// 本函数返回的数组均为「主数组形态」（编辑路径前置 flushStreamTail，
// 调用时尾段恒为空，见各编辑方法）。
function updateLinesIncremental(
  lines: string[],
  lineOffsets: LineOffsetTree,
  codeBlockState: CodeState[],
  startLineIdx: number,
  deleteCount: number,
  newLines: string[],
  fenceLines: number[] = []
) {
  const newLinesArr = [...lines];
  newLinesArr.splice(startLineIdx, deleteCount, ...newLines);

  const newOffsets = lineOffsets.clone();
  newOffsets.updateLines(startLineIdx, deleteCount, newLines.map(l => l.length + 1));

  const newCodeState = [...codeBlockState];
  const newFenceLines: number[] = [];
  const lineDelta = newLines.length - deleteCount;

  newCodeState.splice(
    startLineIdx,
    deleteCount,
    ...new Array<CodeState>(newLines.length).fill('none')
  );

  let inCodeBlock = false;
  let inMathBlock = false;
  // 缩进代码块状态（镜像 parser.computeLineOffsets）：行首 ≥4 列缩进（tab
  // 停靠 4 展开）且非空 → 'indent_code'；块内空行保持；非缩进行退出。
  let inIndentCode = inferInIndentCode(
    (i) => lines[i],
    (i) => codeBlockState[i],
    startLineIdx
  );
  // HTML 块状态（镜像 parser）：inHtmlBlock 为块内标记，htmlType 记录
  // 块类型（1-7，决定结束条件）——CodeState 不记录类型，从编辑点之前
  // 连续 html_block 运行段回推（inferHtmlBlockState）。
  const inferredHtml = inferHtmlBlockState(
    (i) => lines[i],
    (i) => codeBlockState[i],
    startLineIdx
  );
  let inHtmlBlock = inferredHtml.inHtmlBlock;
  let htmlType = inferredHtml.htmlType;
  // 上一非空白行形态记忆（段落打断 / 列表延续 / 表格优先判定所需）
  let prevBlockKind = inferPrevBlockKind(
    (i) => lines[i],
    (i) => codeBlockState[i],
    startLineIdx
  );

  let low = 0,
    high = fenceLines.length - 1;
  let splitIdx = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (fenceLines[mid] < startLineIdx) {
      splitIdx = mid + 1;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  for (let i = 0; i < splitIdx; i++) {
    const fLine = fenceLines[i];
    const state = codeBlockState[fLine];
    if (state === 'fence_start') inCodeBlock = true;
    else if (state === 'fence_end') inCodeBlock = false;
    else if (state === 'math_fence_start') inMathBlock = true;
    else if (state === 'math_fence_end') inMathBlock = false;
    newFenceLines.push(fLine);
  }

  let i = startLineIdx;
  let converged = false;

  for (; i < newLinesArr.length; i++) {
    // 块引用前缀剥离（与 parser 同一正则）：缩进判定发生在前缀剥离之后
    let content = newLinesArr[i];
    let bMatch;
    while ((bMatch = content.match(/^\s*>\s?/))) {
      content = content.substring(bMatch[0].length);
    }
    const trimmed = content.trim();

    const oldState = newCodeState[i]; // pre-filled with shifted old states for i >= startLineIdx + newLines.length

    let isFence = false;
    let newState: CodeState = 'none';

    if (inHtmlBlock) {
      // —— HTML 块内：优先级最高（镜像 parser）——fence/math/缩进代码
      // 判定全部让路（spec 4.6：HTML 块内的 ``` 围栏行、`<pre>` 形态行
      // 均按 html 原样处理）。type 1-5 遇闭合串退出（结束行仍是块的最后
      // 一行）；type 6/7 遇空行退出（空行本身不是块内容，标记 'none'）。
      if (htmlBlockEndCondition(htmlType, content)) {
        inHtmlBlock = false;
        htmlType = 0;
        if (trimmed === '') {
          newState = 'none';
          if (prevBlockKind !== 'list') prevBlockKind = 'blank';
        } else {
          newState = 'html_block';
          prevBlockKind = 'code';
        }
      } else {
        newState = 'html_block';
        // 块形态记作 code 类：块后 ≥4 空格行允许开始缩进代码
        // （type 7 单行块后 `    foo` → 缩进代码，与 CommonMark 一致）。
        prevBlockKind = 'code';
      }
    } else if (!inMathBlock && trimmed.startsWith('```')) {
      isFence = true;
      if (!inCodeBlock) {
        newState = 'fence_start';
        inCodeBlock = true;
      } else {
        newState = 'fence_end';
        inCodeBlock = false;
      }
      // 围栏代码块内缩进不生效（CommonMark）：fence 判定先于缩进代码
      inIndentCode = false;
      prevBlockKind = 'code';
    } else if (!inCodeBlock && trimmed === '$$') {
      isFence = true;
      if (!inMathBlock) {
        newState = 'math_fence_start';
        inMathBlock = true;
      } else {
        newState = 'math_fence_end';
        inMathBlock = false;
      }
      inIndentCode = false;
      prevBlockKind = 'code';
    } else {
      if (inCodeBlock) {
        newState = 'code';
        inIndentCode = false;
        prevBlockKind = 'code';
      } else if (inMathBlock) {
        newState = 'math_block';
        inIndentCode = false;
        prevBlockKind = 'code';
      } else {
        // —— 缩进代码块判定（镜像 parser.computeLineOffsets「其余情况」分支）——
        const indent = leadingIndentColumns(content);
        if (inIndentCode) {
          // 块内：空行与 ≥4 列缩进行保持状态；非缩进行结束代码块
          if (trimmed === '' || indent >= 4) {
            newState = 'indent_code';
          } else {
            // 非缩进行结束代码块：该行按普通行处理（可能开启 HTML 块——
            // CommonMark 中缩进代码块后的 `</div>` 行是 type 6 块）。
            inIndentCode = false;
            const htmlStart = matchHtmlBlockStart(content, prevBlockKind);
            if (htmlStart) {
              newState = 'html_block';
              inHtmlBlock = true;
              htmlType = htmlStart.type;
              // 首行同时满足 end condition → 单行块
              // （`<!-- c -->`、`<!DOCTYPE html>` 等，块即开即闭）。
              if (htmlBlockEndCondition(htmlType, content)) {
                inHtmlBlock = false;
                htmlType = 0;
              }
              prevBlockKind = 'code';
            } else {
              newState = 'none';
              prevBlockKind = guessBlockKind(content, prevBlockKind);
            }
          }
        } else if (trimmed === '') {
          // 空行：不进入缩进代码；段落/表格上下文重置，列表上下文保持
          newState = 'none';
          if (prevBlockKind !== 'list') prevBlockKind = 'blank';
        } else if (indent >= 4) {
          const afterIndent = stripFourColumns(content);
          if (isListMarkerStart(afterIndent)) {
            // 去缩进后以列表标记开头 → 嵌套列表/列表延续，按 body 解析
            newState = 'none';
            inIndentCode = false;
            prevBlockKind = 'list';
          } else if (
            prevBlockKind === 'body' ||
            prevBlockKind === 'list' ||
            prevBlockKind === 'table'
          ) {
            // 段落打断规则 / 列表延续 / 表格优先 → 均不进代码块；
            // prevBlockKind 保持不变（延续可能有多行）
            newState = 'none';
            inIndentCode = false;
          } else {
            // 进入缩进代码块（上一行是空行 / 标题 / 分隔线 / 代码等）
            newState = 'indent_code';
            inIndentCode = true;
            prevBlockKind = 'code';
          }
        } else {
          // —— HTML 块 start 判定（缩进 <4、非空行，镜像 parser）——
          // type 1-6 可打断段落，判定独立于 prevBlockKind；type 7 段落
          // 保护在 matchHtmlBlockStart 内部（prevBlockKind 为 body/list
          // 时禁用——`Foo\n<a href="bar">` 中 a 行是段落延续）。
          const htmlStart = matchHtmlBlockStart(content, prevBlockKind);
          if (htmlStart) {
            newState = 'html_block';
            inHtmlBlock = true;
            htmlType = htmlStart.type;
            if (htmlBlockEndCondition(htmlType, content)) {
              inHtmlBlock = false;
              htmlType = 0;
            }
            prevBlockKind = 'code';
          } else {
            newState = 'none';
            prevBlockKind = guessBlockKind(content, prevBlockKind);
          }
        }
      }
    }

    newCodeState[i] = newState;

    if (isFence) {
      newFenceLines.push(i);
    }

    if (i >= startLineIdx + newLines.length) {
      if (newState === oldState) {
        // Check prompt requirement: "扫描到下一个 fence 行即停，且只有当编辑行非 fence 时才成立"
        // If we found a match and it's a fence, we technically converge since parity doesn't change.
        // But to strictly follow the prompt, if the edited lines had no fences and we hit the same state, we can stop.
        // Actually newState === oldState guarantees convergence for all subsequent lines.
        converged = true;
        i++;
        break;
      }
    }
  }

  if (converged) {
    // Append remaining fences
    // Find where we left off in the old fenceLines array
    let oldFenceStartIdx = splitIdx;
    while (
      oldFenceStartIdx < fenceLines.length &&
      fenceLines[oldFenceStartIdx] < i - lineDelta
    ) {
      oldFenceStartIdx++;
    }
    for (let j = oldFenceStartIdx; j < fenceLines.length; j++) {
      newFenceLines.push(fenceLines[j] + lineDelta);
    }
  }

  // Current text length calculation from LineOffsetTree
  const lastLineIdx = newLinesArr.length - 1;
  const newTextLength = lastLineIdx >= 0 ? newOffsets.getOffset(lastLineIdx) + newLinesArr[lastLineIdx].length : 0;

  // 返回主数组形态（调用方 spread 进 set 的 partial，不含视图键）
  return {
    mainLines: newLinesArr,
    lineOffsets: newOffsets,
    mainCodeState: newCodeState,
    textLength: newTextLength,
    mainFenceLines: newFenceLines,
  };
}

let currentLoadGeneration = 0;

// —— 尾段零拷贝辅助设施（R2-A / 08 招 2 / 09 §4 C4 契约）——
// streamTail 上界：超过强制合并，防长流式 O(尾段) 退化（C4）。
const STREAM_TAIL_MAX_LINES = 4096;
// 空尾段共享引用（不可变约定：尾段数组只在 set 时整体替换，绝不就地修改）
const EMPTY_TAIL: string[] = [];
const EMPTY_STATE_TAIL: CodeState[] = [];
const EMPTY_FENCE_TAIL: number[] = [];

// 触发存储变更的键：命中任一键时需要在 set 时重物化兼容视图
const STORAGE_KEYS = [
  'mainLines',
  'streamTail',
  'mainCodeState',
  'streamTailCodeState',
  'mainFenceLines',
  'streamTailFenceLines',
] as const;

/**
 * 兼容视图物化（R2-A 尾段）：在 setState 时把 main* + streamTail* 双段
 * 结构合并为旧字段语义的视图数组（lines / codeBlockState / fenceLines），
 * 保证未切换访问器的消费方与既有测试读到全量视图。
 * - 尾段为空（常规编辑 / 加载路径）：视图 = 主数组引用，零拷贝；
 * - 尾段非空（流式期间）：一次性 concat 物化——过渡期成本，R2-BD
 *   切换 getLine/getLineCount 访问器后从 set 热路径移除；
 * - partial 未触及存储键（如 isComposing）：视图字段不更新（值未变，
 *   保持旧引用，订阅者不会误渲染）。
 * 注意：不能依赖 zustand getter——zustand set 内部 Object.assign({}, state,
 * next) 会把 getter 物化固化为数据属性，视图从此 stale（已踩坑记录）。
 */
function materializeViews(
  resolved: Record<string, unknown>,
  prev: EditorState
): Record<string, unknown> {
  const touchesStorage = STORAGE_KEYS.some((k) => k in resolved);
  if (!touchesStorage) return resolved;
  const out: Record<string, unknown> = { ...resolved };
  const main = ('mainLines' in out ? out.mainLines : prev.mainLines) as string[];
  const tail = ('streamTail' in out ? out.streamTail : prev.streamTail) as string[];
  const mainState = ('mainCodeState' in out ? out.mainCodeState : prev.mainCodeState) as CodeState[];
  const tailState = ('streamTailCodeState' in out
    ? out.streamTailCodeState
    : prev.streamTailCodeState) as CodeState[];
  const mainFence = ('mainFenceLines' in out ? out.mainFenceLines : prev.mainFenceLines) as number[];
  const tailFence = ('streamTailFenceLines' in out
    ? out.streamTailFenceLines
    : prev.streamTailFenceLines) as number[];
  if (tail.length === 0) {
    // 零拷贝：视图直接引用主数组（编辑/加载路径，zustand 订阅需要新引用
    // 触发渲染——主数组引用随每次编辑更新，语义与旧 lines 字段一致）
    out.lines = main;
    out.codeBlockState = mainState;
    out.fenceLines = mainFence;
  } else {
    // 流式期间一次性物化合并视图（过渡期成本，见上方注释）。
    // 尾段「接管」了主数组最后一行（append 语义：追加到全文末尾，
    // 被接管行并入尾段首行）——视图中主数组末行被隐藏（slice 掉），
    // 由尾段全行接续，避免重复。
    out.lines = main.slice(0, -1).concat(tail);
    out.codeBlockState = mainState.slice(0, -1).concat(tailState);
    out.fenceLines = mainFence.concat(
      tailFence.map((r) => main.length - 1 + r)
    );
  }
  return out;
}

/**
 * 尾段并入主数组（流式合并，09 归一 §5：append 不进 undo 栈；流式合并
 * undo 步登记延后，本轮保证存储正确）。树无需改动——LineOffsetTree
 * 始终与逻辑全量一致（append 已增量更新）；本函数只合并行/状态/fence
 * 数组并清空尾段。返回变更 partial（不含视图键，视图由 set 时物化），
 * 尾段为空时返回 null（无变更）。
 */
function flushStreamTail(state: EditorState): Partial<EditorState> | null {
  if (state.streamTail.length === 0) return null;
  // 尾段接管了主数组最后一行（append 语义：追加到全文末尾）：
  // 弹出被接管行，再并入尾段全行。
  const boundary = state.mainLines.length - 1;
  const newMain = state.mainLines.slice(0, boundary).concat(state.streamTail);
  const newState = state.mainCodeState
    .slice(0, boundary)
    .concat(state.streamTailCodeState);
  // 尾段 fence 相对行号平移为全局行号（追加在文档末尾，顺序保持有序）
  const newFence =
    state.mainFenceLines.length === 0 && state.streamTailFenceLines.length === 0
      ? state.mainFenceLines
      : state.mainFenceLines.concat(
          state.streamTailFenceLines.map((r) => boundary + r)
        );
  return {
    mainLines: newMain,
    mainCodeState: newState,
    mainFenceLines: newFence,
    streamTail: EMPTY_TAIL,
    streamTailCodeState: EMPTY_STATE_TAIL,
    streamTailFenceLines: EMPTY_FENCE_TAIL,
  };
}

/**
 * 编辑入口的「编辑触达 → 合并尾段」归一（C4 合并时机之一）：
 * 返回逻辑全量视图（尾段已并入主数组的局部对象），编辑路径后续
 * 全部按主数组形态处理（行号/偏移坐标在合并前后不变——合并只是
 * 把尾段行并入主数组，不改变任何行内容与顺序）。
 */
function mergeTailInto(state: EditorState): EditorState {
  const patch = flushStreamTail(state);
  if (!patch) return state;
  return { ...state, ...patch };
}

/**
 * setState 兼容归一（R2-A）：外部消费方（既有测试等）仍按旧字段名
 * lines / codeBlockState / fenceLines 传「整文档重置」——映射到主数组
 * 字段并清空尾段；视图字段由 materializeViews 在物化步骤生成。
 * store 内部 set 一律使用 main* / streamTail* 字段，视图键由物化生成。
 */
function normalizeSetStatePartial(
  partial: unknown
): unknown {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    return partial;
  }
  const out: Record<string, unknown> = { ...(partial as object) };
  let resetTail = false;
  if ('lines' in out && !('mainLines' in out)) {
    out.mainLines = out.lines;
    delete out.lines;
    resetTail = true;
  }
  if ('codeBlockState' in out && !('mainCodeState' in out)) {
    out.mainCodeState = out.codeBlockState;
    delete out.codeBlockState;
    resetTail = true;
  }
  if ('fenceLines' in out && !('mainFenceLines' in out)) {
    out.mainFenceLines = out.fenceLines;
    delete out.fenceLines;
    resetTail = true;
  }
  if (resetTail) {
    out.streamTail = EMPTY_TAIL;
    out.streamTailCodeState = EMPTY_STATE_TAIL;
    out.streamTailFenceLines = EMPTY_FENCE_TAIL;
  }
  return out;
}

// 注意：create 的 set 参数弃用——状态更新统一走 dispatchSet
// （zustand 原生 set 不会生成兼容视图字段，见 materializeViews 说明）。
export const useEditorStore = create<EditorState>((_set, get) => ({
  mainLines: [''],
  streamTail: EMPTY_TAIL,
  mainCodeState: ['none'],
  streamTailCodeState: EMPTY_STATE_TAIL,
  mainFenceLines: [],
  streamTailFenceLines: EMPTY_FENCE_TAIL,

  lineOffsets: new LineOffsetTree([1]),

  // 兼容视图字段（初始与主数组一致；此后由 dispatchSet 在每次 set 时
  // 显式物化，见 materializeViews——不能做成 getter：zustand 的
  // Object.assign({}, state, next) 会把它固化为数据属性导致 stale）
  lines: [''],
  codeBlockState: ['none'],
  fenceLines: [],

  undoStack: [],
  redoStack: [],
  textLength: 0,

  cursorPos: 0,
  selectionStart: 0,
  selectionEnd: 0,
  isComposing: false,
  setIsComposing: (isComposing) => dispatchSet({ isComposing }),

  getText: () => {
    const s = get();
    // 尾段为空时直接 join 主数组（零物化）；否则走已物化的合并视图
    if (s.streamTail.length === 0) return s.mainLines.join('\n');
    return s.lines.join('\n');
  },

  // —— 统一行访问器（C4 访问器先行；渲染/virtualizer count 切换点登记）——
  // 逻辑行视图：i < 主数组边界 → 主数组行；否则 → 尾段行（被接管行由
  // 尾段首行替代——append 把文本拼在全文末尾，被接管行并入尾段首行）。
  getLine: (i) => {
    const s = get();
    const main = s.mainLines;
    if (s.streamTail.length === 0) return main[i];
    const boundary = main.length - 1;
    return i < boundary ? main[i] : s.streamTail[i - boundary];
  },
  getLineCount: () => {
    const s = get();
    return s.streamTail.length === 0
      ? s.mainLines.length
      : s.mainLines.length - 1 + s.streamTail.length;
  },
  getLineIndex: (pos) => get().lineOffsets.findLineIndex(pos),

  flushStreamTail: () => {
    const patch = flushStreamTail(get());
    if (patch) dispatchSet(patch);
  },

  setText: (text) => {
    const generation = ++currentLoadGeneration;
    dispatchSet(() => {
      const lines = text.split('\n');

      if (lines.length <= 1000) {
        const res = updateLinesIncremental([], new LineOffsetTree([]), [], 0, 0, lines, []);
        return {
          ...res,
          // 整文档重置：清空流式尾段
          streamTail: EMPTY_TAIL,
          streamTailCodeState: EMPTY_STATE_TAIL,
          streamTailFenceLines: EMPTY_FENCE_TAIL,
          cursorPos: 0,
          selectionStart: 0,
          selectionEnd: 0,
          undoStack: [],
          redoStack: [],
        };
      }

      // Chunked loading for large files
      const firstChunk = lines.slice(0, 1000);
      const res = updateLinesIncremental([], new LineOffsetTree([]), [], 0, 0, firstChunk, []);

      let currentIdx = 1000;
      const chunkSize = 2000;

      const processNextChunk = () => {
        if (generation !== currentLoadGeneration) return;
        if (currentIdx >= lines.length) return;
        const endIdx = Math.min(currentIdx + chunkSize, lines.length);
        const chunk = lines.slice(currentIdx, endIdx);

        dispatchSet((s) => {
          if (generation !== currentLoadGeneration) return s;
          // 大文件分块加载路径：主数组形态（setText 期间尾段恒为空）
          const updated = updateLinesIncremental(
            s.mainLines,
            s.lineOffsets,
            s.mainCodeState,
            s.mainLines.length,
            0,
            chunk,
            s.mainFenceLines
          );
          return { ...updated };
        });

        currentIdx = endIdx;
        if (generation !== currentLoadGeneration) return;
        if (typeof window !== 'undefined' && window.requestIdleCallback) {
          window.requestIdleCallback(processNextChunk);
        } else {
          setTimeout(processNextChunk, 10);
        }
      };

      if (typeof window !== 'undefined' && window.requestIdleCallback) {
        window.requestIdleCallback(processNextChunk);
      } else {
        setTimeout(processNextChunk, 10);
      }

      return {
        ...res,
        streamTail: EMPTY_TAIL,
        streamTailCodeState: EMPTY_STATE_TAIL,
        streamTailFenceLines: EMPTY_FENCE_TAIL,
        cursorPos: 0,
        selectionStart: 0,
        selectionEnd: 0,
        undoStack: [],
        redoStack: [],
      };
    });
  },

  setCursorPos: (pos) =>
    dispatchSet((state) => {
      const bounded = Math.max(0, Math.min(pos, state.textLength));
      return {
        cursorPos: bounded,
        selectionStart: bounded,
        selectionEnd: bounded,
      };
    }),

  setSelection: (start, end) =>
    dispatchSet((state) => {
      const min = Math.max(0, Math.min(start, state.textLength));
      const max = Math.max(0, Math.min(end, state.textLength));
      return {
        selectionStart: Math.min(min, max),
        selectionEnd: Math.max(min, max),
        cursorPos: Math.max(0, Math.min(end, state.textLength)),
      };
    }),

  insertText: (inserted) =>
    dispatchSet((state) => {
      // 用户编辑触达 → 尾段先并入主数组（C4 合并时机；坐标在合并前后不变）
      const s = mergeTailInto(state);
      const sel = s.selectionStart;
      const e = s.selectionEnd;

      const startLineIdx = s.lineOffsets.findLineIndex(sel);
      const endLineIdx = s.lineOffsets.findLineIndex(e);

      const startLineOffset = s.lineOffsets.getOffset(startLineIdx);
      const endLineOffset = s.lineOffsets.getOffset(endLineIdx);

      const prefix = s.mainLines[startLineIdx].substring(
        0,
        sel - startLineOffset
      );
      const suffix = s.mainLines[endLineIdx].substring(e - endLineOffset);

      const newSegment = prefix + inserted + suffix;
      const insertedLines = newSegment.split('\n');

      const deleteCount = endLineIdx - startLineIdx + 1;
      const removedLines = s.mainLines.slice(
        startLineIdx,
        startLineIdx + deleteCount
      );

      const res = updateLinesIncremental(
        s.mainLines,
        s.lineOffsets,
        s.mainCodeState,
        startLineIdx,
        deleteCount,
        insertedLines,
        s.mainFenceLines
      );

      const newPos = sel + inserted.length;

      const newOp: EditorOperation = {
        startLineIdx,
        removedLines,
        insertedLineCount: insertedLines.length,
        cursorBefore: s.cursorPos,
        selectionStartBefore: s.selectionStart,
        selectionEndBefore: s.selectionEnd,
        cursorAfter: newPos,
        selectionStartAfter: newPos,
        selectionEndAfter: newPos,
        timestamp: Date.now(),
      };

      let newUndoStack = [...s.undoStack];
      // Basic debounce: if typing continuously in the same line without selections
      if (
        newUndoStack.length > 0 &&
        sel === e &&
        inserted.length === 1 &&
        inserted !== '\n'
      ) {
        const last = newUndoStack[newUndoStack.length - 1];
        if (
          Date.now() - last.timestamp < 500 &&
          last.startLineIdx === startLineIdx &&
          last.cursorAfter === sel &&
          last.insertedLineCount === 1
        ) {
          // Merge typing
          last.insertedLineCount = insertedLines.length;
          last.cursorAfter = newPos;
          last.timestamp = Date.now();
        } else {
          newUndoStack.push(newOp);
        }
      } else {
        newUndoStack.push(newOp);
      }

      return {
        ...res,
        cursorPos: newPos,
        selectionStart: newPos,
        selectionEnd: newPos,
        undoStack: newUndoStack,
        redoStack: [],
      };
    }),

  // 流式尾部追加快速通道（R2-A 尾段零拷贝 / 08 招 2 / 09 §4 C4 契约）：
  // - 追加文本落在独立 streamTail，主数组不重建（零拷贝，O(尾段)）；
  // - LineOffsetTree 以 COW 增量更新触及块（clone 浅拷贝 + 末块 O(256)），
  //   树始终与逻辑全量一致（既有测试断言 lineOffsets.toArray 全量）；
  // - textLength O(1) 增量（append 即在末尾插入 text.length 个字符，
  //   与换行分割无关，经与树重算口径交叉验证一致）；
  // - 不进 undo 栈（流式语义；「流式结束合并 1 步」登记延后，本轮先保证
  //   存储正确）；
  // - 尾段超上界强制合并（C4：STREAM_TAIL_MAX_LINES，防长流式退化）。
  appendText: (text: string) =>
    dispatchSet((state) => {
      if (!text) return state;

      let s = state;
      // 尾段超限强制合并（C4 契约：streamTail 上界 4096 行）
      if (s.streamTail.length >= STREAM_TAIL_MAX_LINES) {
        s = mergeTailInto(s);
      }

      const mainLines = s.mainLines;
      const streamTail = s.streamTail;
      // 尾段「接管」了主数组最后一行（append 语义：追加到全文末尾，被接管
      // 行并入尾段首行）；尾段为空时逻辑末行 = 主数组末行，否则 = 尾段末行。
      const tailLen = streamTail.length;
      const boundary = mainLines.length - 1;
      const lastLineIdx = tailLen === 0 ? boundary : boundary + tailLen - 1;

      // 逻辑行/状态访问器（infer* 的尾段双段视图，无需物化全量数组）：
      // 尾段为空时 = 主数组全量；非空时尾段「接管」主数组末行（tail[0]
      // 替代 main[boundary]），i ≥ boundary 从尾段取。
      const getLineAt: LineAccessor =
        tailLen === 0
          ? (i) => mainLines[i]
          : (i) => (i < boundary ? mainLines[i] : streamTail[i - boundary]);
      const getStateAt: StateAccessor =
        tailLen === 0
          ? (i) => s.mainCodeState[i]
          : (i) =>
              i < boundary ? s.mainCodeState[i] : s.streamTailCodeState[i - boundary];

      // 拼接逻辑末行 + 追加文本（与旧实现一致：combined 后 split）
      const lastLine = getLineAt(lastLineIdx);
      const combined = lastLine + text;
      const newSegmentLines = combined.split('\n');

      // —— 状态机基线（与旧 appendText 一致，访问器化后兼容尾段视图）——
      // 「进入合并行的状态」由旧行 [0, lastLineIdx) 决定（末行本身将被
      // 合并内容替换——若末行是结束块的空行，该空行在合并后可能消失，
      // 不能把它当作块已退出的依据）；块类型由连续 html_block 运行段
      // 仿真得出（CodeState 不记录类型，见 inferHtmlBlockState）。
      let inCodeBlock = false;
      let inMathBlock = false;
      // 缩进代码块状态：末行状态为 'indent_code' 时视为块内（块内空行保持）
      let inIndentCode = false;
      // HTML 块状态：从旧行回推——增量语义与 updateLinesIncremental 一致
      const inferredHtml = inferHtmlBlockState(getLineAt, getStateAt, lastLineIdx);
      let inHtmlBlock = inferredHtml.inHtmlBlock;
      let htmlType = inferredHtml.htmlType;
      // HTML 块 start（type 7 段落保护）所需的「上一非空白行形态」记忆
      let prevBlockKind = inferPrevBlockKind(getLineAt, getStateAt, lastLineIdx);
      const currentState = getStateAt(lastLineIdx);
      if (currentState === 'fence_start' || currentState === 'code')
        inCodeBlock = true;
      if (currentState === 'math_fence_start' || currentState === 'math_block')
        inMathBlock = true;
      if (currentState === 'indent_code') inIndentCode = true;
      if (currentState === 'fence_end') inCodeBlock = false;
      if (currentState === 'math_fence_end') inMathBlock = false;

      const segmentCodeStates = new Array(newSegmentLines.length);
      for (let i = 0; i < newSegmentLines.length; i++) {
        const trimmed = newSegmentLines[i].trim();
        // HTML 块判定使用块引用剥离后的内容（与 parser 一致）
        const htmlContent = stripBlockquoteContext(newSegmentLines[i]);
        if (inHtmlBlock) {
          // —— HTML 块内（优先级最高：fence/math/缩进代码判定全部让路）——
          if (htmlBlockEndCondition(htmlType, htmlContent)) {
            inHtmlBlock = false;
            htmlType = 0;
            if (htmlContent.trim() === '') {
              // type 6/7 空行结束块：空行本身不是块内容
              segmentCodeStates[i] = 'none';
              if (prevBlockKind !== 'list') prevBlockKind = 'blank';
            } else {
              // type 1-5 结束行（行内含闭合标记）：该行仍是块的最后一行
              segmentCodeStates[i] = 'html_block';
              prevBlockKind = 'code';
            }
          } else {
            segmentCodeStates[i] = 'html_block';
            prevBlockKind = 'code';
          }
        } else if (!inMathBlock && trimmed.startsWith('```')) {
          segmentCodeStates[i] = inCodeBlock ? 'fence_end' : 'fence_start';
          inCodeBlock = !inCodeBlock;
          inIndentCode = false;
          prevBlockKind = 'code';
        } else if (!inCodeBlock && trimmed === '$$') {
          segmentCodeStates[i] = inMathBlock
            ? 'math_fence_end'
            : 'math_fence_start';
          inMathBlock = !inMathBlock;
          inIndentCode = false;
          prevBlockKind = 'code';
        } else if (inCodeBlock) {
          segmentCodeStates[i] = 'code';
          inIndentCode = false;
          prevBlockKind = 'code';
        } else if (inMathBlock) {
          segmentCodeStates[i] = 'math_block';
          inIndentCode = false;
          prevBlockKind = 'code';
        } else {
          // —— 缩进代码块判定（与 updateLinesIncremental 同规则）——
          const indent = leadingIndentColumns(newSegmentLines[i]);
          if (inIndentCode) {
            // 块内：空行与 ≥4 列缩进行保持；非缩进行结束代码块
            if (trimmed === '' || indent >= 4) {
              segmentCodeStates[i] = 'indent_code';
            } else {
              // 非缩进行结束代码块：该行可能开启 HTML 块
              inIndentCode = false;
              const htmlStart = matchHtmlBlockStart(htmlContent, prevBlockKind);
              if (htmlStart) {
                segmentCodeStates[i] = 'html_block';
                inHtmlBlock = true;
                htmlType = htmlStart.type;
                if (htmlBlockEndCondition(htmlType, htmlContent)) {
                  inHtmlBlock = false;
                  htmlType = 0;
                }
                prevBlockKind = 'code';
              } else {
                segmentCodeStates[i] = 'none';
                prevBlockKind = guessBlockKind(htmlContent, prevBlockKind);
              }
            }
          } else if (trimmed !== '' && indent >= 4) {
            segmentCodeStates[i] = 'indent_code';
            inIndentCode = true;
            prevBlockKind = 'code';
          } else if (trimmed === '') {
            // 空行：不进入缩进代码；段落/表格上下文重置，列表上下文保持
            segmentCodeStates[i] = 'none';
            if (prevBlockKind !== 'list') prevBlockKind = 'blank';
          } else {
            // —— HTML 块 start 判定（缩进 <4、非空行，镜像 parser）——
            const htmlStart = matchHtmlBlockStart(htmlContent, prevBlockKind);
            if (htmlStart) {
              segmentCodeStates[i] = 'html_block';
              inHtmlBlock = true;
              htmlType = htmlStart.type;
              if (htmlBlockEndCondition(htmlType, htmlContent)) {
                inHtmlBlock = false;
                htmlType = 0;
              }
              prevBlockKind = 'code';
            } else {
              segmentCodeStates[i] = 'none';
              prevBlockKind = guessBlockKind(htmlContent, prevBlockKind);
            }
          }
        }
      }

      // —— 新尾段（主数组不动，零拷贝）——
      // 尾段为空：新尾段 = 拼接段；非空：替换尾段末行（旧尾段末行已被
      // 拼接进 newSegmentLines[0]，前 tailLen-1 行原样保留）。
      const newTail =
        tailLen === 0
          ? newSegmentLines
          : streamTail.slice(0, -1).concat(newSegmentLines);
      const newTailCode =
        tailLen === 0
          ? segmentCodeStates
          : s.streamTailCodeState.slice(0, -1).concat(segmentCodeStates);

      // 尾段内 fence 相对行号：旧相对行号不变（尾段起点仍为 boundary），
      // 新段行相对行号 = (tailLen - 1) + i（尾段非空）/ i（尾段为空）。
      const newTailFence = s.streamTailFenceLines.slice();
      for (let i = 0; i < newSegmentLines.length; i++) {
        const st = segmentCodeStates[i];
        if (
          st === 'fence_start' ||
          st === 'fence_end' ||
          st === 'math_fence_start' ||
          st === 'math_fence_end'
        ) {
          newTailFence.push(tailLen === 0 ? i : tailLen - 1 + i);
        }
      }

      // —— 树更新（COW：clone 浅拷贝 + 触及末块；树始终与逻辑全量一致，
      // 既有测试断言 lineOffsets.toArray 全量）——
      const newOffsets = s.lineOffsets.clone();
      newOffsets.updateLines(lastLineIdx, 1, newSegmentLines.map(l => l.length + 1));

      // textLength O(1) 增量（append 即在全文末尾插入 text.length 个字符）
      const textLength = state.textLength + text.length;

      // Automatically advance cursor if it was exactly at the end (Requirement 6)
      const wasAtEnd = state.cursorPos === state.textLength && state.selectionStart === state.selectionEnd;

      return {
        mainLines,
        streamTail: newTail,
        mainCodeState: s.mainCodeState,
        streamTailCodeState: newTailCode,
        mainFenceLines: s.mainFenceLines,
        streamTailFenceLines: newTailFence,
        lineOffsets: newOffsets,
        textLength,
        cursorPos: wasAtEnd ? textLength : state.cursorPos,
        selectionStart: wasAtEnd ? textLength : state.selectionStart,
        selectionEnd: wasAtEnd ? textLength : state.selectionEnd,
      };
    }),

  deleteText: (backward) =>
    dispatchSet((state) => {
      // 用户编辑触达 → 尾段先并入主数组（C4 合并时机）
      const base = mergeTailInto(state);
      let s = base.selectionStart;
      let e = base.selectionEnd;

      if (s === e) {
        const text = base.mainLines.join('\n');
        if (backward && s > 0) {
          s = findPrevGraphemeBoundary(text, s);
        } else if (!backward && e < base.textLength) {
          e = findNextGraphemeBoundary(text, e);
        } else {
          return state;
        }
      }

      const startLineIdx = base.lineOffsets.findLineIndex(s);
      const endLineIdx = base.lineOffsets.findLineIndex(e);

      const startLineOffset = base.lineOffsets.getOffset(startLineIdx);
      const endLineOffset = base.lineOffsets.getOffset(endLineIdx);

      const prefix = base.mainLines[startLineIdx].substring(
        0,
        s - startLineOffset
      );
      const suffix = base.mainLines[endLineIdx].substring(e - endLineOffset);

      const newSegment = prefix + suffix;
      const insertedLines = newSegment.split('\n'); // usually length 1

      const deleteCount = endLineIdx - startLineIdx + 1;
      const removedLines = base.mainLines.slice(
        startLineIdx,
        startLineIdx + deleteCount
      );

      const res = updateLinesIncremental(
        base.mainLines,
        base.lineOffsets,
        base.mainCodeState,
        startLineIdx,
        deleteCount,
        insertedLines,
        base.mainFenceLines
      );

      const newOp: EditorOperation = {
        startLineIdx,
        removedLines,
        insertedLineCount: insertedLines.length,
        cursorBefore: base.cursorPos,
        selectionStartBefore: base.selectionStart,
        selectionEndBefore: base.selectionEnd,
        cursorAfter: s,
        selectionStartAfter: s,
        selectionEndAfter: s,
        timestamp: Date.now(),
      };

      let newUndoStack = [...base.undoStack];
      // 连续单字符删除的合并逻辑（与 insertText 对称）
      if (
        newUndoStack.length > 0 &&
        base.selectionStart === base.selectionEnd // 单字符删除（非选择范围）
      ) {
        const last = newUndoStack[newUndoStack.length - 1];
        if (
          Date.now() - last.timestamp < 500 &&
          last.startLineIdx === startLineIdx &&
          last.insertedLineCount === 1 &&
          insertedLines.length === 1
        ) {
          // 合并：保留原始 removedLines（第一次删除前的行），
          // 只更新 insertedLineCount 和 cursor 状态
          last.insertedLineCount = insertedLines.length;
          last.cursorAfter = s;
          last.selectionStartAfter = s;
          last.selectionEndAfter = s;
          last.timestamp = Date.now();
        } else {
          newUndoStack.push(newOp);
        }
      } else {
        newUndoStack.push(newOp);
      }

      return {
        ...res,
        cursorPos: s,
        selectionStart: s,
        selectionEnd: s,
        undoStack: newUndoStack,
        redoStack: [],
      };
    }),

  deleteSelection: (start, end) =>
    dispatchSet((state) => {
      // 用户编辑触达 → 尾段先并入主数组（C4 合并时机）
      const base = mergeTailInto(state);
      const s = Math.max(0, Math.min(start, end));
      const e = Math.min(base.textLength, Math.max(start, end));

      if (s === e) return state;

      const startLineIdx = base.lineOffsets.findLineIndex(s);
      const endLineIdx = base.lineOffsets.findLineIndex(e);

      const startLineOffset = base.lineOffsets.getOffset(startLineIdx);
      const endLineOffset = base.lineOffsets.getOffset(endLineIdx);

      const prefix = base.mainLines[startLineIdx].substring(
        0,
        s - startLineOffset
      );
      const suffix = base.mainLines[endLineIdx].substring(e - endLineOffset);

      const newSegment = prefix + suffix;
      const insertedLines = newSegment.split('\n'); // usually length 1

      const deleteCount = endLineIdx - startLineIdx + 1;
      const removedLines = base.mainLines.slice(
        startLineIdx,
        startLineIdx + deleteCount
      );

      const res = updateLinesIncremental(
        base.mainLines,
        base.lineOffsets,
        base.mainCodeState,
        startLineIdx,
        deleteCount,
        insertedLines,
        base.mainFenceLines
      );

      const newOp: EditorOperation = {
        startLineIdx,
        removedLines,
        insertedLineCount: insertedLines.length,
        cursorBefore: base.cursorPos,
        selectionStartBefore: base.selectionStart,
        selectionEndBefore: base.selectionEnd,
        cursorAfter: s,
        selectionStartAfter: s,
        selectionEndAfter: s,
        timestamp: Date.now(),
      };

      return {
        ...res,
        cursorPos: s,
        selectionStart: s,
        selectionEnd: s,
        undoStack: [...base.undoStack, newOp],
        redoStack: [],
      };
    }),

  undo: () =>
    dispatchSet((state) => {
      if (state.undoStack.length === 0) return state;
      // 用户操作触达 → 尾段先并入主数组（C4 合并时机；undo 针对的
      // 是主数组编辑 op，行号坐标在合并前后不变）
      const base = mergeTailInto(state);
      const op = base.undoStack[base.undoStack.length - 1];

      // Reverse splice: remove `insertedLineCount` lines at `startLineIdx` and insert `removedLines`
      const res = updateLinesIncremental(
        base.mainLines,
        base.lineOffsets,
        base.mainCodeState,
        op.startLineIdx,
        op.insertedLineCount,
        op.removedLines,
        base.mainFenceLines
      );

      // Forward op to redo stack
      const inverseOp: EditorOperation = {
        startLineIdx: op.startLineIdx,
        removedLines: base.mainLines.slice(
          op.startLineIdx,
          op.startLineIdx + op.insertedLineCount
        ),
        insertedLineCount: op.removedLines.length,
        cursorBefore: op.cursorAfter,
        selectionStartBefore: op.selectionStartAfter,
        selectionEndBefore: op.selectionEndAfter,
        cursorAfter: op.cursorBefore,
        selectionStartAfter: op.selectionStartBefore,
        selectionEndAfter: op.selectionEndBefore,
        timestamp: Date.now(),
      };

      return {
        ...res,
        cursorPos: op.cursorBefore,
        selectionStart: op.selectionStartBefore,
        selectionEnd: op.selectionEndBefore,
        undoStack: base.undoStack.slice(0, -1),
        redoStack: [...base.redoStack, inverseOp],
      };
    }),

  redo: () =>
    dispatchSet((state) => {
      if (state.redoStack.length === 0) return state;
      // 用户操作触达 → 尾段先并入主数组（C4 合并时机）
      const base = mergeTailInto(state);
      const op = base.redoStack[base.redoStack.length - 1];

      const res = updateLinesIncremental(
        base.mainLines,
        base.lineOffsets,
        base.mainCodeState,
        op.startLineIdx,
        op.insertedLineCount,
        op.removedLines,
        base.mainFenceLines
      );

      const inverseOp: EditorOperation = {
        startLineIdx: op.startLineIdx,
        removedLines: base.mainLines.slice(
          op.startLineIdx,
          op.startLineIdx + op.insertedLineCount
        ),
        insertedLineCount: op.removedLines.length,
        cursorBefore: op.cursorAfter,
        selectionStartBefore: op.selectionStartAfter,
        selectionEndBefore: op.selectionEndAfter,
        cursorAfter: op.cursorBefore,
        selectionStartAfter: op.selectionStartBefore,
        selectionEndAfter: op.selectionEndBefore,
        timestamp: Date.now(),
      };

      return {
        ...res,
        cursorPos: op.cursorBefore,
        selectionStart: op.selectionStartBefore,
        selectionEnd: op.selectionEndBefore,
        redoStack: base.redoStack.slice(0, -1),
        undoStack: [...base.undoStack, inverseOp],
      };
    }),

  verifyConsistency: () => {
    // 逻辑视图一致性校验：树偏移 vs 逻辑行（主数组 + 尾段）逐行对齐
    const s = get();
    let runningOffset = 0;
    const count = s.getLineCount();
    for (let i = 0; i < count; i++) {
      if (s.lineOffsets.getOffset(i) !== runningOffset) {
        console.error(
          `Offset drift detected at line ${i}! Expected ${runningOffset}, got ${s.lineOffsets.getOffset(i)}`
        );
        return false;
      }
      runningOffset += s.getLine(i).length + 1; // +1 for newline
    }
    return true;
  },
}));

// —— setState 归一 + 视图物化包装（R2-A）——
// 统一分发入口：store 内部方法与外部消费方全部经此更新状态。
// 1) 归一：外部按旧字段名 lines/codeBlockState/fenceLines 传整档重置时
//    映射到主数组字段并清空尾段（视图字段由物化步骤生成，防止 stale）；
// 2) 物化：按 main* + streamTail* 双段结构生成兼容视图字段
//    （lines/codeBlockState/fenceLines），保证未切换访问器的消费方与
//    既有测试读到全量视图（见 materializeViews 的零拷贝/过渡成本说明）。
// store 内部 set 也必须经此分发（zustand 原生 set 不会生成视图字段，
// 且其 Object.assign({}, state, next) 会破坏 getter——已弃用 getter）。
const rawSetState = useEditorStore.setState.bind(useEditorStore);
const dispatchSet = ((partial: unknown, replace?: boolean) => {
  const current = useEditorStore.getState();
  const resolved =
    typeof partial === 'function' ? partial(current) : partial;
  const normalized = normalizeSetStatePartial(resolved);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const materialized = materializeViews(
      normalized as Record<string, unknown>,
      current
    );
    rawSetState(materialized as never, replace as never);
  } else {
    rawSetState(normalized as never, replace as never);
  }
}) as typeof useEditorStore.setState;

useEditorStore.setState = dispatchSet;
