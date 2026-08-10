import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { isFenceClose, type CodeState } from './parser';
import { LineOffsetTree } from './SegmentTree';
import { metrics } from './metrics';

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
 * 光标方向性 assoc（R4-B，04 编辑深度扩展 §1.2 B2 / §3.3 方案 1）：
 * 位置 p（位于字符 p-1 与 p 之间）落在行尾时，光标既可视作「行末字符之后」，
 * 也可视作「下一行行首之前」——Bidi / 行边界导航需要该方向信息区分左右
 * （对齐 CM6 SelectionRange.assoc 语义，简化为二值）。
 * 规则：p 位于非空行的行尾（p 之后是换行或文末，且 p 之前非换行）→ 'after'
 * （光标关联上一字符，渲染在行尾字符的视觉外侧）；否则 → 'before'
 * （默认关联下一字符）。
 */
export function computeAssoc(text: string, pos: number): 'before' | 'after' {
  const p = Math.max(0, Math.min(pos, text.length));
  if (
    p > 0 &&
    text[p - 1] !== '\n' &&
    (p === text.length || text[p] === '\n')
  ) {
    return 'after';
  }
  return 'before';
}

/**
 * 行尾 assoc 判定（store 内部版，O(log n)）：基于行偏移树 + 行访问器定位
 * 「pos 是否落在非空行的行尾」，避免整文本 join——applyChange / appendText
 * 等热路径调用（每次落点变更都需刷新 assoc）。行尾 → 'after'，否则 'before'。
 */
function computeAssocForLines(
  lineOffsets: LineOffsetTree,
  getLine: (i: number) => string,
  pos: number
): 'before' | 'after' {
  const p = Math.max(0, pos);
  if (p <= 0) return 'before';
  const lineIdx = lineOffsets.findLineIndex(p);
  const lineStart = lineOffsets.getOffset(lineIdx);
  const lineEnd = lineStart + getLine(lineIdx).length;
  // 行尾且该行非空（p 非行首）→ 光标位于行末字符之后，关联上一字符
  return p === lineEnd && p !== lineStart ? 'after' : 'before';
}

/**
 * 从历史 op 的 before 快照（兼容层三元组）推断 anchor/head（R4-B）：
 * 历史 EditorOperation 未记录方向层字段，按「cursorPos 恒等于 head」的
 * 主语义恢复——光标恰在选区一端时另一端即 anchor（反向选区：光标在 min
 * 端 → anchor 是 max 端）；无选区时 anchor=head=cursor；中间态（光标不在
 * 任一选区端）按 anchor=选区起点兜底。兼容层字段恢复行为不变（336 门禁），
 * 方向层尽力恢复。
 */
function inferAnchorHead(
  cursor: number,
  selStart: number,
  selEnd: number
): { anchorPos: number; headPos: number } {
  if (selStart === selEnd) return { anchorPos: cursor, headPos: cursor };
  if (cursor === selEnd) return { anchorPos: selStart, headPos: selEnd };
  if (cursor === selStart) return { anchorPos: selEnd, headPos: selStart };
  return { anchorPos: selStart, headPos: cursor };
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

// —— 围栏形态判定（P2-A1 fence 单源化：镜像 parser.computeLineOffsets）——
// 开栏正则与 parser.ts 的 fenceOpen 同源（trim 后行）：反引号 run ≥3
// （info 串不允许含反引号——` ``` aa `` ` 整行不是围栏，退化为段落）或
// 波浪线 run ≥3（info 串无限制）。关闭判定经 parser 导出的 isFenceClose
// 共享函数（同字符 + run ≥ 开栏长度 + 仅尾随空白），增量状态机与全量
// 重扫共用同一判定，不再各自维护（旧 `trimmed.startsWith('```')` 布尔
// 翻转在 fence_end 行尾插入 / 波浪线围栏场景与重扫分歧——KNOWN-DEFECT，
// P2 现状盘点项 2；startsWith 只认反引号且不校验关闭条件，已废弃）。
const FENCE_OPEN_RE = /^(```+)([^`]*)$|^(~~~+).*$/;

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
  /**
   * 操作类型标记（R3-A 流式合并 undo / R4 顺序语义）：
   * - 'stream'：流式会话结束（stop-flush）时合并生成的单步 op——
   *   append 本身不进 undo 栈（09 归一表），流式内容由该 op 一次性撤销/重做；
   * - 缺省：普通用户编辑 op。
   * R4 顺序语义（R3 遗留 2）：meta 是「独立一步」的契约——流式 op 与
   * 用户 op 同栈交替 undo 均精确。insert/delete 的 500ms 合并条件必须
   * 排除 meta:'stream' 的栈顶 op（否则用户击键会并进流式 op，undo 时
   * removedLines 不含击键内容 → 丢字），合并只允许发生在无 meta 的
   * 用户 op 之间（undo/redo 逆 op 重建已按当前状态为基准，见 undo/redo）。
   */
  meta?: 'stream';
  /**
   * 位置级字段（B6 协作 op 预留，04 §7 近期项 / status-P3 N8）：
   * 字符级 [from, to) 区间替换为 insert 的完整位置描述——OT/CRDT 可映射
   * 形状（06 §4 近期项），供变更日志与同步消费端使用：
   * - applyChange 事务点记录：from/to = 变更前文档坐标、insert = 入参、
   *   removedText = 区间原文本（从行级快照推导，精确到字符）；
   * - undo/redo 逆 op：以「逆操作执行时文档」为坐标的整行区间
   *   （整行替换语义，from = 区间起始行行首、to = 区间末行行尾、
   *   insert = 逆操作插入内容、removedText = 逆操作删除内容）；
   * - meta:'stream' 合并 op：stop-flush 时文档坐标的追加区间。
   * **只增不改**：行级字段语义与 undo/redo 兼容层完全不变（818 门禁），
   * 既有分支不读新字段；位置字段仅供日志/同步消费端附加消费。
   */
  from?: number;
  to?: number;
  insert?: string;
  removedText?: string;
}

/**
 * 变更日志条目（B6 协作 op 预留，04 §7 近期项 / N8）：
 * append-only：seq 单调递增（= 记录时的文档 version），op 为完整事务
 * op（含位置级字段）。日志与 undo 栈解耦——500ms 合并击键在 undo 栈
 * 折叠为一步，但每次实际变更都是一条日志条目（同步消费端按事件粒度
 * 消费，seq 提供无冲突增量拉取顺序）。
 */
export interface ChangeLogEntry {
  /** 条目序号（单调递增，与记录时文档 version 同值） */
  seq: number;
  /** 事务 op（含位置级字段） */
  op: EditorOperation;
}

/**
 * 变更日志容量上界（有界环形，防长会话内存无界增长）：
 * 超过上界丢弃最旧条目（语义 = 环形缓冲；物理实现为整数组裁剪，
 * 仅在满员时每事务一次 O(上界) 拷贝，常规编辑 O(1) 追加）。
 */
export const CHANGE_LOG_LIMIT = 10_000;

/**
 * 流式会话合并记账（R3-A 流式合并 undo）：
 * append 期间逐 chunk 累计「追加区间」，stop-flush 时据此生成单个
 * meta:'stream' op。记账起点 = 会话首次 append 时的文档末尾行：
 * - startLineIdx：追加区间起始行号（= 会话开始时主数组末行索引）；
 * - removedLines：[追加前末行内容]（undo 时恢复该行，即回到流式前文档）；
 * - insertedLineCount：追加区间总行数（= 1 + 各 chunk 行增量累计；
 *   undo 时从 startLineIdx 起删除该数量的行——追加点前移场景同样适用，
 *   因为该数恒等于「追加后文档在 startLineIdx 之后的行数」）；
 * - cursorBefore/selection*Before：会话开始时的光标/选区快照
 *   （undo 流式 op 后光标回退到该位置）。
 * - shiftedLen：前移路径（追加点前移至光标处）累计插入的流内容字符数。
 *   追加点 = 光标位置 + shiftedLen——用户击键使光标右移后，后续 append
 *   仍接在「已插入流内容段」末尾，保证流内容按到达顺序连续有序，且
 *   用户击键始终落在流内容之前（不落入流内容中段）。
 */
export interface StreamOp {
  startLineIdx: number;
  removedLines: string[];
  insertedLineCount: number;
  cursorBefore: number;
  selectionStartBefore: number;
  selectionEndBefore: number;
  timestamp: number;
  shiftedLen: number;
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
  // 兼容视图（R6-P1 惰性化）：lines/codeBlockState/fenceLines 已从「set 时
  // 物化的数据字段」改为「原型链惰性 getter」（见 lazyViewProto）——set 热
  // 路径零物化（append@1M 移除 3.6ms concat）；未切换访问器的消费方
  // （measure.ts 视口外导航 / 既有测试 / 调试指标）读取时按需物化：
  // 尾段为空时零拷贝返回主数组引用，尾段非空时一次性 concat。
  lines: string[];
  codeBlockState: CodeState[];
  fenceLines: number[];

  textLength: number;

  cursorPos: number;
  selectionStart: number;
  selectionEnd: number;

  // —— R4-B 选区方向性（04 编辑深度扩展 §3.3 方案 1，对齐 CM6 SelectionRange）——
  // anchorPos：选区锚点——Shift+方向键按下时固定的一端；纯移动（无选区）后
  //   与 head 重合。外部 setSelection(start, end) 兼容路径下「无 anchor 时
  //   start 即 anchor」（start 参数即锚点，end 参数即活动端）。
  // headPos：活动端——光标所在端，恒等于 cursorPos（setSelection/moveHead/
  //   applyChange 等所有落点路径均维持该不变量）。
  // assoc：光标方向性（'before' 关联下一字符 / 'after' 关联上一字符）——
  //   光标落在行尾时区分「行末字符之后」与「下一行行首之前」，
  //   供 Bidi / 行边界导航使用（04 §1.2 B2）。
  anchorPos: number;
  headPos: number;
  assoc: 'before' | 'after';

  undoStack: EditorOperation[];
  redoStack: EditorOperation[];

  /**
   * —— B6 协作 op 预留（04 §7 近期项 / status-P3 N8）——
   * changeLog：append-only 变更日志（{seq, op} 条目，有界环形，
   * 超过 CHANGE_LOG_LIMIT 丢弃最旧）；version：文档版本号（每次变更
   * 事务 +1，setText / 整档重置归零）。写入口 = applyChange 事务 +
   * stop-flush 流式合并 op；undo/redo 不写日志不递增（撤销/重做既有
   * op，非新编辑事务——「undo/redo 逻辑不变」契约）。
   */
  changeLog: ChangeLogEntry[];
  version: number;

  /**
   * 流式会话合并记账（R3-A）：append 期间非 null，stop-flush 时置 null
   * 并生成单个 meta:'stream' op 入 undo 栈。
   */
  streamOp: StreamOp | null;
  /** 最近一次用户编辑时间戳（insertText/deleteText 等更新）；0 = 从未编辑。
   *  appendText 用它判定「用户活跃编辑末尾行」→ 追加点前移（01 问题 5）。 */
  lastUserEditTime: number;

  getText: () => string;
  getLine: (i: number) => string;
  getLineCount: () => number;
  getLineIndex: (pos: number) => number;
  flushStreamTail: () => void;

  setText: (text: string) => void;
  setCursorPos: (pos: number) => void;
  setSelection: (start: number, end: number) => void;
  /** R4-B：只移动选区活动端（head），锚点（anchor）保持不动——Shift+方向键
   *  扩展语义的存储侧实现：选区区间 = [min(anchor,head), max(anchor,head)]，
   *  方向由 anchor/head 相对位置判定，反向移动天然正确（不再依赖旧启发式
   *  「selectionStart === cursorPos」）。 */
  moveHead: (newHead: number) => void;
  /** R6-P1：行文本模式 grapheme 移动——方向键根治（ArrowLeft 14.5ms → <1ms）。
   *  不再对全文 getText() join（O(全文)），而是定位光标所在行（getLine +
   *  LineOffsetTree O(log n)）+ 行内偏移 → 行内 grapheme 边界 → 换算全局
   *  位置；行边界显式跨行（行首向左 = 上一行行尾、行尾向右 = 下一行行首，
   *  与全文模式「\n 是普通字符」的语义等价）。返回新位置（文档边界处
   *  原地不动）。 */
  moveGrapheme: (pos: number, dir: 'left' | 'right') => number;
  /** R4-B：Shift+方向键扩展——按 grapheme 边界计算新 head 并 moveHead
   *  （anchor 不动）；已到边界时为空操作。dir 为视觉方向（'left' 向左/
   *  'right' 向右），grapheme 粒度与 findPrev/NextGraphemeBoundary 一致。 */
  extendSelectionByDirection: (dir: 'left' | 'right') => void;
  insertText: (inserted: string) => void;
  appendText: (text: string) => void;
  isComposing: boolean;
  setIsComposing: (isComposing: boolean) => void;
  deleteText: (backward: boolean) => void;
  deleteSelection: (start: number, end: number) => void;

  /**
   * 位置级变更统一入口（R4 事务层，04 §4.3 方案 1 / 09 归一表）：
   * 把 [from, to) 字符区间替换为 insert 的变更收敛为单步事务——内部复用
   * updateLinesIncremental 行区间语义 + EditorOperation 记录 + 光标平移，
   * 保证 lineOffsets/textLength/codeBlockState/undo 全链路一致。
   * insertText/deleteText/deleteSelection 均为此入口的薄封装（行为零变化，
   * 289 门禁验证）；表格操作经「纯内容替换声明」（setState({lines}) diff
   * 分支）与 applyTableChange 统一走本入口。
   */
  applyChange: (
    from: number,
    to: number,
    insert: string,
    opts?: ApplyChangeOptions
  ) => void;
  /** 表格专用事务入口：替换 [from, to) 并精确落点光标（表格 API 结果），
   *  单步进 undo（R4：表格操作恢复 undo/redo/lineOffsets/textLength 一致性）。 */
  applyTableChange: (
    from: number,
    to: number,
    insert: string,
    cursorAfter: number
  ) => void;

  undo: () => void;
  redo: () => void;

  /** 逻辑视图一致性校验（测试资产使用）：树偏移 vs 逻辑行逐行对齐 */
  verifyConsistency: () => boolean;
}

/**
 * applyChange 事务选项（R4）：
 * - meta：与 EditorOperation.meta 对齐——'stream' 标记流式合并 op；
 * - cursorAfter：光标/选区落点（默认 from + insert.length，与旧
 *   insertText 的光标平移语义一致；表格操作传精确落点）；
 * - merge：500ms 合并模式——'typing'（insertText 旧合并条件）、'delete'
 *   （deleteText 旧合并条件）、'none'（事务一步一记，applyChange 公开
 *   入口与表格操作默认，不做猜测性合并）。合并均排除 meta:'stream' 栈顶。
 */
export interface ApplyChangeOptions {
  meta?: 'stream';
  cursorAfter?: number;
  merge?: 'typing' | 'delete' | 'none';
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
  const lineDelta = newLines.length - deleteCount;
  // newFenceLines 惰性构建（R2-E）：快速路径（编辑未触及任何 fence 行）
  // 零拷贝复用旧引用，见收敛段注释；非快速路径在函数尾部一次性组装
  // （原生 slice 拷贝前缀 + 扫描区新 fence + 收敛段平移后缀）。
  let newFenceLines: number[];
  // 扫描区（编辑点起至收敛/文档尾）内新 fence 行收集器：同样惰性分配，
  // 量级 = 扫描区长度（常规击键为 0~1 行），永不触碰前缀 fence。
  let scannedFences: number[] | null = null;
  let scannedFencePushed = false;

  newCodeState.splice(
    startLineIdx,
    deleteCount,
    ...new Array<CodeState>(newLines.length).fill('none')
  );

  // —— 二分定位编辑点前最后一个 fence（fenceLines 升序）——
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

  // —— O(1) 前缀状态恢复（R2-E：替代原 O(splitIdx) 线性重放）——
  // fenceLines 严格交替（证明：inCodeBlock/inMathBlock 只会在 fence 行
  // 翻转；code 围栏与 math 围栏互斥识别——parser 语义「code 块内 $$ 按
  // code 处理、math 块内 ``` 按 math_block 处理」，且 html 块内 fence
  // 判定让路，故 fenceLines 内相邻 fence 必然分属一开一闭）。因此
  // 「处理完 fenceLines[splitIdx-1] 后的累计状态」= 该行类型隐含状态
  // （fence_start→code、fence_end→none、math_fence_start→math、
  // math_fence_end→none），编辑点入状态 = 处理完最后一个前缀 fence 的
  // 状态——读最后一个前缀 fence 的类型即得，无需 parity 数组。
  // splitIdx = 0（编辑点前无 fence）时入状态恒为双 false。
  let inCodeBlock = false;
  let inMathBlock = false;
  // 开栏状态镜像（P2-A1 fence 单源化）：CodeState 不记录开栏的标记字符与
  // run 长度，而关闭判定需要它们——从「编辑点前最后一个前缀 fence 行」
  // 的原文提取（该行在编辑点之前、未被编辑触及，内容权威）。前缀 fence
  // 为 fence_start 时其行必匹配 FENCE_OPEN_RE（该行当初就是这样被判定
  // 为开栏的），提取失败仅为防御（代码块保持 in，关闭判定退化为永不
  // 匹配——与 parser 的「inCodeBlock 但无状态」防御分支同向，见下）。
  let fenceState: { marker: string; length: number } | null = null;
  if (splitIdx > 0) {
    const lastPrefixFenceIdx = fenceLines[splitIdx - 1];
    const lastPrefixFenceState = codeBlockState[lastPrefixFenceIdx];
    if (lastPrefixFenceState === 'fence_start') {
      inCodeBlock = true;
      const fenceContent = stripBlockquoteContext(lines[lastPrefixFenceIdx]);
      const fenceOpen = FENCE_OPEN_RE.exec(fenceContent.trim());
      if (fenceOpen) {
        fenceState = {
          marker: fenceOpen[1] !== undefined ? '`' : '~',
          length: (fenceOpen[1] ?? fenceOpen[3]).length,
        };
      }
    } else if (lastPrefixFenceState === 'math_fence_start') inMathBlock = true;
    // fence_end / math_fence_end → 围栏已闭合，两状态保持 false
  }
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
    } else if (!inMathBlock && FENCE_OPEN_RE.test(trimmed)) {
      // P2-A1 fence 单源化：开/关判定镜像 parser.computeLineOffsets——
      // 开栏行记录 marker/length（fenceState），块内 fence 形态行仅当
      // isFenceClose（同字符 + run ≥ 开栏长度 + 仅尾随空白）才关闭；
      // ` ```INS`（fence_end 行尾插入）与 ` ``` js`（info 串）均保持
      // code——根治 KNOWN-DEFECT（旧 startsWith('```') 布尔翻转在这些
      // 场景把行误判为 fence_end，增量与重扫两套状态机分歧）。
      if (!inCodeBlock) {
        newState = 'fence_start';
        inCodeBlock = true;
        const fenceOpen = FENCE_OPEN_RE.exec(trimmed);
        fenceState = {
          marker: fenceOpen![1] !== undefined ? '`' : '~',
          length: (fenceOpen![1] ?? fenceOpen![3]).length,
        };
      } else if (fenceState && isFenceClose(trimmed, fenceState.marker, fenceState.length)) {
        newState = 'fence_end';
        inCodeBlock = false;
        fenceState = null;
      } else {
        newState = 'code';
      }
      // 围栏代码块内缩进不生效（CommonMark）：fence 判定先于缩进代码
      inIndentCode = false;
      prevBlockKind = 'code';
    } else if (!inCodeBlock && trimmed === '$$') {
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

    // 仅四态行记入 fenceLines（P2-A1 fence 单源化修正）：fence 形态行
    // 判为 code 时（如 ` ```INS` 带 info 串不闭合）**不**记录——fenceLines
    // 的「严格交替」不变量（前缀状态恢复与 BlockRenderer 软渲染判定依赖）
    // 只对围栏边界行成立，形态行计入会破坏交替性（前缀恢复会把状态为
    // code 的形态行误当作围栏边界，恢复出错误的 inCodeBlock）。
    if (
      newState === 'fence_start' ||
      newState === 'fence_end' ||
      newState === 'math_fence_start' ||
      newState === 'math_fence_end'
    ) {
      scannedFencePushed = true;
      // 惰性创建：常规击键（无 fence 行被触及）不分配
      if (!scannedFences) scannedFences = [];
      scannedFences.push(i);
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

  // —— newFenceLines 组装（R2-E：前缀 O(log) / 快速路径 O(1)）——
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
    if (lineDelta === 0 && !scannedFencePushed && oldFenceStartIdx === splitIdx) {
      // —— 零拷贝快速路径（R2-E，每击键主路径）——
      // 三个条件逐项对应「fence 内容不变」的证明：
      // 1) lineDelta === 0：行数未变，新旧行号一一对齐；
      // 2) !scannedFencePushed：扫描区（编辑点至收敛点）无任何 fence 行
      //    （新行 fence 或旧行 fence 被重放均会置位）；
      // 3) oldFenceStartIdx === splitIdx：收敛点之前无旧 fence（若有，
      //    无论被重放（类型未变）还是被丢弃（类型已变，如编辑点开启
      //    html 块吞掉其后 fence），都不能共享引用）。
      // 三者齐备时新旧数组逐项一致（前缀原样 + 后缀 +0 平移原样），
      // 直接复用旧引用零拷贝——fenceLines 全链路只整体替换、绝不就地
      // 变更（appendText/flushStreamTail/本函数均遵守），共享引用安全；
      // zustand 订阅语义：引用未变即视为无变更，fence 确实未变，正确。
      newFenceLines = fenceLines;
    } else {
      // 常规路径：原生 slice 一次拷贝前缀（O(splitIdx) 单次内存拷贝，
      // 仅在 fence 行被编辑触及时发生，量级 = 受影响 fence 数）+ 扫描区
      // 新 fence + 收敛段剩余 fence +lineDelta 平移（保持原收敛处理不变）
      const nfl = fenceLines.slice(0, splitIdx);
      if (scannedFences) nfl.push(...scannedFences);
      for (let j = oldFenceStartIdx; j < fenceLines.length; j++) {
        nfl.push(fenceLines[j] + lineDelta);
      }
      newFenceLines = nfl;
    }
  } else {
    // 未收敛（扫描到文档尾）：前缀 + 扫描区全部 fence（无平移段）
    const nfl = fenceLines.slice(0, splitIdx);
    if (scannedFences) nfl.push(...scannedFences);
    newFenceLines = nfl;
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

// —— 尾段零拷贝辅助设施（R2-A / 08 招 2 / 09 §4 C4 契约）——
// streamTail 上界：超过强制合并，防长流式 O(尾段) 退化（C4）。
const STREAM_TAIL_MAX_LINES = 4096;
// 用户活跃编辑窗口（01 问题 5 方案 5.2）：该窗口内光标落在末尾行
// 视为「用户正在编辑末尾行」，append 追加点前移至光标处，不打断输入。
const STREAM_USER_EDIT_WINDOW_MS = 1000;
// —— 分块加载参数（P2 项 1 参数化，导出租给 TTI 基准测试断言）——
// 首块行数：setText 同步帧一次性载入（首屏可交互（TTI）的保障——首帧
// 内容就绪即可击键/滚动，续载在空闲分片里完成，见 setText 分块注释）；
// 续块行数：每块 requestIdleCallback 分片续载的行数上限（单块解析
// O(块长)，分片粒度 = 单帧空闲预算的粗控）；
// 续载回退节流：requestIdleCallback 不可用（SSR / 无 window 环境）时的
// setTimeout 回退间隔（ms）。
export const FIRST_CHUNK_LINES = 1000;
export const CHUNK_SIZE = 2000;
export const CHUNK_FALLBACK_DELAY_MS = 10;
// 空尾段共享引用（不可变约定：尾段数组只在 set 时整体替换，绝不就地修改）
const EMPTY_TAIL: string[] = [];
const EMPTY_STATE_TAIL: CodeState[] = [];
const EMPTY_FENCE_TAIL: number[] = [];

// —— 双段合并共享原语（P2-A1 回修 2：7 处重复实现收敛为单一抽象）——
// 双段结构不变量：尾段非空时「接管」主数组末行（append 语义：追加到全文
// 末尾，被接管行并入尾段首行），逻辑全量视图 = 主数组 [0, boundary) +
// 尾段全行（boundary = 主数组长度 - 1）。此前该语义散布于 7 处独立实现
// （materializeViews / getText / flushStreamTail / getLine / getLineCount /
// appendText 内联访问器 / BlockRenderer isInUnclosedFenceParts），语义靠
// 测试维系、易漂移（review-P1 回修 2）——现收敛为下方共享原语；BlockRenderer
// 为组件层禁碰文件，其实现保持与 lineAt/countOf 逐点一致（登记：后续轮次
// 切换）。后续再增双段消费点一律经此组函数。
/** 逻辑行总数：尾段空 = 主数组长度；非空 = 主数组 − 1（被接管行）+ 尾段 */
export function lineCountOf(mainLen: number, tailLen: number): number {
  return tailLen === 0 ? mainLen : mainLen - 1 + tailLen;
}

/**
 * 逻辑行 i 的元素（行文本 / 块状态 / fence 号通用）：
 * i < boundary → 主数组行；否则 → 尾段行（被接管行由尾段首行替代）。
 * 越界返回 undefined（由调用方语义兜底，与旧 getLine 行为一致）。
 */
export function lineAt<T>(
  main: readonly T[],
  tail: readonly T[],
  index: number
): T {
  if (tail.length === 0) return main[index];
  const boundary = main.length - 1;
  return index < boundary ? main[index] : tail[index - boundary];
}

/** 双段合并为逻辑全量数组：尾段空 → 零拷贝返回主数组引用；非空 → 拼接 */
export function concatDual<T>(main: readonly T[], tail: readonly T[]): T[] {
  if (tail.length === 0) return main as T[];
  return main.slice(0, -1).concat(tail);
}

/** 双段 fence 行合并：尾段相对行号平移 boundary（两段各自升序、拼接升序） */
export function concatDualFences(
  main: readonly number[],
  tail: readonly number[],
  boundary: number
): number[] {
  if (tail.length === 0) return main as number[];
  return main.concat(tail.map((r) => boundary + r));
}

/**
 * 兼容视图物化（R2-A 尾段）：把 main* + streamTail* 双段结构合并为旧字段
 * 语义的视图数组（lines / codeBlockState / fenceLines），供未切换访问器的
 * 消费方与既有测试读取全量视图。
 * - 尾段为空（常规编辑 / 加载路径）：视图 = 主数组引用，零拷贝；
 * - 尾段非空（流式期间）：一次性 concat 物化。
 * R6-P1 惰性化：本函数不再由 dispatchSet 在 set 时调用（append@1M 热路径
 * 移除 3.6ms concat），改为 lazyViewProto 原型 getter 在**真正被读取时**
 * 惰性求值——组件层消费方已全部切换访问器（HiddenInput/BlockRenderer/
 * MarkdownEngine），运行期零读者 → 热路径零物化。
 */
interface MaterializedViews {
  lines: string[];
  codeBlockState: CodeState[];
  fenceLines: number[];
}

function materializeViews(state: EditorState): MaterializedViews {
  // 物化计数（B6 指标接线）：每次物化都是「兼容视图被消费方真实读取」
  // 的性能信号（R6-P1 惰性化后运行期零读者时热路径零物化）——经全局
  // metrics 实例累计，宿主可据此观测每消息实例化场景的物化成本（N10）。
  metrics.incrementMaterializations();
  const { mainLines, streamTail } = state;
  // 双段合并经共享原语（P2-A1 回修 2）：尾段空 → 零拷贝主数组引用；
  // 非空 → 主数组 [0, boundary) + 尾段全行（接管语义见 concatDual 注释）。
  return {
    lines: concatDual(mainLines, streamTail),
    codeBlockState: concatDual(state.mainCodeState, state.streamTailCodeState),
    fenceLines: concatDualFences(
      state.mainFenceLines,
      state.streamTailFenceLines,
      mainLines.length - 1
    ),
  };
}

// —— 惰性视图原型（R6-P1 物化惰性化，取代「set 时显式物化」）——
// lines/codeBlockState/fenceLines 作为 getter 挂在原型链上（而非 state 的
// 自有数据属性）：
// - set 热路径零物化：zustand 的 Object.assign({}, state, next) 只复制
//   自有可枚举属性，原型链 getter 不被触碰（也不会像旧 getter 方案那样被
//   Object.assign 固化造成 stale——数据字段方案的历史坑见旧注释）；
// - 读取时惰性物化：组件订阅选择器 / tests getState / 未切换访问器的
//   消费方经原型链命中 getter → materializeViews 按需求值。
// dispatchSet 在每次 set 后经 setPrototypeOf 恢复原型（zustand 合并产生的
// 新 state 是普通对象，原型链会丢失）——详见 dispatchSet 注释。
const lazyViewProto: Record<string, unknown> = {};
// 订阅同步窗口登记（review-P1 回修 7）：rawSetState 内部同步触发 zustand
// listeners 时，setPrototypeOf 尚未执行——非 React 订阅者若在监听回调内
// 同步读 state.lines 会得到 undefined。项目内 subscribe 仅测试使用
// （store-factory/readonly，均不读 lines）；React 订阅者的 getSnapshot 在
// 渲染期执行（批处理后），无实际风险。另：getter 为可枚举属性，
// for-in/Object.keys(state) 会触发惰性物化并多出 3 个键——当前无此消费方，
// 未来引入前需复查。
Object.defineProperty(lazyViewProto, 'lines', {
  configurable: true,
  enumerable: true,
  get(this: EditorState): string[] {
    return materializeViews(this).lines;
  },
});
Object.defineProperty(lazyViewProto, 'codeBlockState', {
  configurable: true,
  enumerable: true,
  get(this: EditorState): CodeState[] {
    return materializeViews(this).codeBlockState;
  },
});
Object.defineProperty(lazyViewProto, 'fenceLines', {
  configurable: true,
  enumerable: true,
  get(this: EditorState): number[] {
    return materializeViews(this).fenceLines;
  },
});

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
  // 弹出被接管行，再并入尾段全行——双段合并经共享原语（P2-A1 回修 2）。
  const boundary = state.mainLines.length - 1;
  const newMain = concatDual(state.mainLines, state.streamTail);
  const newState = concatDual(state.mainCodeState, state.streamTailCodeState);
  // 尾段 fence 相对行号平移为全局行号（追加在文档末尾，顺序保持有序）
  const newFence = concatDualFences(
    state.mainFenceLines,
    state.streamTailFenceLines,
    boundary
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
 * —— 事务核心：位置级变更计划（R4，04 §4.3 方案 1）——
 * 把 [from, to) 字符区间的替换推导为行区间 splice 计划：行区间语义与
 * 旧 insertText/deleteText/deleteSelection 逐分支一致（prefix/suffix 拼接
 * → split('\n') → deleteCount = endLineIdx - startLineIdx + 1），使三个
 * 旧入口重构为 applyChange 薄封装后行为零变化（289 门禁验证）。
 * newCursor：默认光标落点（from + insert.length，与旧 insertText 一致）。
 */
interface ChangePlan {
  startLineIdx: number;
  deleteCount: number;
  insertedLines: string[];
  removedLines: string[];
  newCursor: number;
}

function planChange(
  state: EditorState,
  from: number,
  to: number,
  insert: string
): ChangePlan {
  const startLineIdx = state.lineOffsets.findLineIndex(from);
  const endLineIdx = state.lineOffsets.findLineIndex(to);

  const startLineOffset = state.lineOffsets.getOffset(startLineIdx);
  const endLineOffset = state.lineOffsets.getOffset(endLineIdx);

  const prefix = state.mainLines[startLineIdx].substring(
    0,
    from - startLineOffset
  );
  const suffix = state.mainLines[endLineIdx].substring(to - endLineOffset);

  const insertedLines = (prefix + insert + suffix).split('\n');

  const deleteCount = endLineIdx - startLineIdx + 1;
  const removedLines = state.mainLines.slice(
    startLineIdx,
    startLineIdx + deleteCount
  );

  return {
    startLineIdx,
    deleteCount,
    insertedLines,
    removedLines,
    newCursor: from + insert.length,
  };
}

/**
 * —— 两级最小变更区间定位（R4：setState({lines}) 纯内容替换 → diff 事务）——
 * 行级公共前缀/后缀（表格区域外的行零扫描、引用比较）框定差异区，再按
 * 差异形态做字符级细分：
 * - 行级前缀：逐行全同；行级后缀：逐行全同且**后缀起点行不得侵入前缀区**
 *   （比较行索引 ≥ 前缀终点索引——插入/删除会把「平移行」与旧行对齐，
 *   若允许后缀侵入前缀区，字符细分会落在相似表格行上错位）；
 * - 字符级细分仅限「行数相同 + 单行差异」（编辑行 = 行 linePrefix）——
 *   此时旧行/新行是同一逻辑行的局部修改，公共前缀/后缀精确；
 * - 行数变化（插入/删除行）→ 整行替换（表格行共享 '| ' 前缀，字符细分
 *   会把相似前缀算进去导致区间错位，禁止）。
 * 无法界定局部区间（区间交叉/全文重写）时返回 null，调用方回落权威
 * 整档重置路径。
 */
function findContentDiffRange(
  getOldLine: (i: number) => string,
  oldCount: number,
  newLines: string[]
): { from: number; to: number; insert: string } | null {
  const common = Math.min(oldCount, newLines.length);

  // —— 行级公共前缀（表格区域外行零扫描）——
  let linePrefix = 0;
  while (
    linePrefix < common &&
    getOldLine(linePrefix) === newLines[linePrefix]
  ) {
    linePrefix++;
  }
  // —— 行级公共后缀（比较行索引 ≥ 前缀终点，后缀不侵入前缀区）——
  let lineSuffix = 0;
  while (
    lineSuffix < common - linePrefix &&
    oldCount - 1 - lineSuffix >= linePrefix &&
    getOldLine(oldCount - 1 - lineSuffix) ===
      newLines[newLines.length - 1 - lineSuffix]
  ) {
    lineSuffix++;
  }
  // 后缀起点行索引（length - lineSuffix：后缀行 = [起点, 末尾) 共 lineSuffix 行）
  const lastOld = oldCount - lineSuffix;
  const lastNew = newLines.length - lineSuffix;

  // —— 前缀偏移（前缀行新旧完全相同 → 新旧偏移一致）——
  let prefixOffset = 0;
  for (let i = 0; i < linePrefix; i++) prefixOffset += getOldLine(i).length + 1;
  // —— 差异区终点 = 后缀起点行行首（旧/新）——
  let oldDiffEnd = prefixOffset;
  for (let i = linePrefix; i < lastOld; i++) oldDiffEnd += getOldLine(i).length + 1;
  let newDiffEnd = prefixOffset;
  for (let i = linePrefix; i < lastNew; i++) newDiffEnd += newLines[i].length + 1;

  // —— 差异形态细分：行数相同 + 单行差异 → 行内字符级公共前缀/后缀 ——
  let from = prefixOffset;
  let to = oldDiffEnd;
  let insertEnd = newDiffEnd;
  if (
    oldCount === newLines.length &&
    lastOld === linePrefix + 1 &&
    lastNew === linePrefix + 1
  ) {
    const oldLine = getOldLine(linePrefix);
    const newLine = newLines[linePrefix];
    let charPrefix = 0;
    const charPreMax = Math.min(oldLine.length, newLine.length);
    while (
      charPrefix < charPreMax &&
      oldLine[charPrefix] === newLine[charPrefix]
    ) {
      charPrefix++;
    }
    let charSuffix = 0;
    const charSufMax = Math.min(oldLine.length, newLine.length);
    while (
      charSuffix < charSufMax &&
      oldLine[oldLine.length - 1 - charSuffix] ===
        newLine[newLine.length - 1 - charSuffix]
    ) {
      charSuffix++;
    }
    from += charPrefix;
    to -= charSuffix;
    insertEnd -= charSuffix;
  }

  const insert = newLines.join('\n').slice(from, insertEnd);
  // 防御：区间交叉（前缀/后缀无法框定局部差异 = 全文重写）→ 回落整档重置
  if (from > to) return null;
  return { from, to, insert };
}

/**
 * —— 纯内容替换声明判定（R4 diff 事务前置条件）——
 * partial 含 lines 且不含 mainLines/codeBlockState/fenceLines/
 * undoStack/redoStack：调用方只声明「内容替换」（表格操作等），未显式
 * 控制存储/栈键 → 收敛为 applyChange 事务。显式携带存储或栈键的调用
 * （测试 resetStore、加载路径等）仍走权威整档重置路径（语义不变）。
 */
function isPlainContentReplace(
  partial: unknown
): partial is { lines: string[] } {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    return false;
  }
  const p = partial as Record<string, unknown>;
  return (
    'lines' in p &&
    Array.isArray(p.lines) &&
    !('mainLines' in p) &&
    !('codeBlockState' in p) &&
    !('fenceLines' in p) &&
    !('undoStack' in p) &&
    !('redoStack' in p)
  );
}

/**
 * 编辑路径对流式合并记账的修正（R3-A 流式合并 undo）：
 * 用户编辑（insertText/deleteText/undo/redo）会改变主数组行号布局，
 * 若发生在流式追加区间之前/边界行内，追加区间整体平移 lineDelta，
 * startLineIdx 同步修正，stop-flush 生成的合并 op 仍能精确删除追加区间；
 * 若编辑点深入追加区间内部（用户把光标移入流内容编辑），单步撤销已
 * 无法干净界定区间 → 记账作废（返回 null），下次 append 重新记账，
 * 「流式 op 作为独立一步」的登记约定不变（09 归一表 §5）。
 * lineDelta：本次编辑造成的行数净变化（inserted - removed）。
 */
function adjustStreamOpForEdit(
  streamOp: StreamOp | null,
  editStartLineIdx: number,
  lineDelta: number
): StreamOp | null {
  if (!streamOp) return null;
  if (editStartLineIdx <= streamOp.startLineIdx) {
    const next = streamOp.startLineIdx + lineDelta;
    return next >= 0 ? { ...streamOp, startLineIdx: next } : null;
  }
  // 编辑点位于追加区间内部：作废重记账（被编辑切开的流内容绑定用户 op）
  return null;
}

/**
 * setState 兼容归一（R2-A）：外部消费方（既有测试等）仍按旧字段名
 * lines / codeBlockState / fenceLines 传「整文档重置」——映射到主数组
 * 字段并清空尾段；视图字段由 lazyViewProto 惰性 getter 生成（R6-P1）。
 * store 内部 set 一律使用 main* / streamTail* 字段，视图键由惰性物化生成。
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
    // 整文档重置（R3-A）：流式会话记账与用户活跃标记一并清零，
    // 防止 setState({lines}) 重置后的残留状态影响后续 append 语义
    // （append-cursor 测试与既有测试的 resetStore 均走此路径）。
    out.streamOp = null;
    out.lastUserEditTime = 0;
    // 整文档重置（B6）：变更日志清空 + 版本号归零——整档重置与
    // setText 同语义（新文档版本序列），日志条目不再对应当前文档。
    out.changeLog = [];
    out.version = 0;
  }
  // —— R4-B：方向层默认补齐（外部直改兼容字段时同步 anchor/head/assoc）——
  // 外部消费方 / 既有测试按旧三元组 setState（selectionchange 回写、
  // 测试 resetStore 等）时方向层无信息 → 按「无 anchor 时 start 即 anchor、
  // cursorPos 恒等于 head」的约定补默认：anchor = selectionStart、
  // head = cursorPos。assoc 保守置 'before'（外部路径无文本上下文，精确
  // 行尾判定由 store 方法负责——方法路径显式携带方向层字段，不落本分支）。
  if (
    ('selectionStart' in out || 'cursorPos' in out) &&
    !('anchorPos' in out) &&
    !('headPos' in out)
  ) {
    const selStart = 'selectionStart' in out
      ? (out.selectionStart as number)
      : (out.cursorPos as number);
    out.anchorPos = selStart;
    out.headPos = 'cursorPos' in out
      ? (out.cursorPos as number)
      : selStart;
    if (!('assoc' in out)) out.assoc = 'before';
  }
  return out;
}

// 注意：create 的 set 参数弃用——状态更新统一走 dispatchSet
// （zustand 原生 set 不会生成兼容视图字段；视图经 lazyViewProto 惰性化，
// 见 lazyViewProto 说明）。
/**
 * 构建一个独立的编辑器 store 实例（R5 实例工厂内部实现，06 §8 宿主集成接口）：
 * - 每次调用创建全新的 zustand store（独立 state / 独立订阅 / 独立 dispatchSet
 *   闭包），多实例并行互不干扰——setText/appendText/光标/undo 等全链隔离；
 * - 分块加载代际计数（currentLoadGeneration）为实例内局部：setText 的竞态
 *   保护只对同实例的加载序列生效，跨实例互不取消；
 * - store body 内的方法经闭包捕获本实例的 dispatchSet 与 get()，绝不引用
 *   全局单例（旧代码 applyTableChange/insertText 等薄封装引用全局
 *   useEditorStore.getState() 的缺陷在实例化重构中一并根除）。
 * - R6-P1：初始 state 以完整字面量对象构造（含视图字段占位，满足
 *   create 的类型推断），随后 delete 视图字段并经 Object.setPrototypeOf
 *   挂 lazyViewProto 惰性视图原型（非 Object.create——zustand create
 *   的 state 须在构造后改原型，见本函数尾部的 delete + setPrototypeOf），
 *   lines/codeBlockState/fenceLines 不作为自有数据字段（读取经原型链
 *   命中 getter 按需物化——若作为数据字段会被 zustand Object.assign
 *   固化 stale，旧 getter 方案的历史坑已由原型链方案规避）。
 * 全局单例 useEditorStore = buildEditorStore() 的一次实例化（向后兼容）。
 */
function buildEditorStore(): UseBoundStore<StoreApi<EditorState>> {
  // 分块加载代际计数（实例内局部，见上方注释）
  let currentLoadGeneration = 0;

  const store = create<EditorState>((_set, get) => {
    // R6-P1 惰性视图：初始 state 先以完整数据对象构造（含视图字段占位，
    // 满足 create 的 EditorState 上下文类型与方法参数推断），随即删除
    // 视图数据字段并挂惰性视图原型——视图经原型链 getter 惰性物化
    // （数据字段会遮蔽原型 getter，且会被 zustand Object.assign 固化
    // 成 stale 数据属性，见 lazyViewProto 注释）
    const state: EditorState = {
  mainLines: [''],
  streamTail: EMPTY_TAIL,
  mainCodeState: ['none'],
  streamTailCodeState: EMPTY_STATE_TAIL,
  mainFenceLines: [],
  streamTailFenceLines: EMPTY_FENCE_TAIL,

  lineOffsets: new LineOffsetTree([1]),

  // 视图字段占位（初始与主数组一致；随后删除，改由 lazyViewProto
  // 惰性 getter 提供——见本函数尾部的 delete + setPrototypeOf）
  lines: [''],
  codeBlockState: ['none'],
  fenceLines: [],

  undoStack: [],
  redoStack: [],
  changeLog: [],
  version: 0,
  streamOp: null,
  lastUserEditTime: 0,
  textLength: 0,

  cursorPos: 0,
  selectionStart: 0,
  selectionEnd: 0,
  // R4-B 方向层初始值：锚点 = 活动端 = 0（无选区），assoc 默认 'before'
  anchorPos: 0,
  headPos: 0,
  assoc: 'before',
  isComposing: false,
  setIsComposing: (isComposing) => dispatchSet({ isComposing }),

  getText: () => {
    const s = get();
    // 双段合并经共享原语（P2-A1 回修 2）：尾段空时零拷贝主数组引用、
    // join 零物化；非空时一次性拼接——本方法本就是全文序列化 O(n) 语义，
    // 方向键热路径已改行文本模式不调用它（R6-P1）
    return concatDual(s.mainLines, s.streamTail).join('\n');
  },

  // —— 统一行访问器（C4 访问器先行；渲染/virtualizer count 切换点登记）——
  // 逻辑行视图：i < 主数组边界 → 主数组行；否则 → 尾段行（被接管行由
  // 尾段首行替代——append 把文本拼在全文末尾，被接管行并入尾段首行）。
  // 双段换算经共享原语 lineAt/lineCountOf（P2-A1 回修 2 去重）。
  getLine: (i) => {
    const s = get();
    return lineAt(s.mainLines, s.streamTail, i);
  },
  getLineCount: () => {
    const s = get();
    return lineCountOf(s.mainLines.length, s.streamTail.length);
  },
  getLineIndex: (pos) => get().lineOffsets.findLineIndex(pos),

  flushStreamTail: () => {
    // stop-flush（R3-A）：宿主在流式结束时调用——强制合并尾段，并把本次
    // 流式会话合并为单个 meta:'stream' op 入 undo 栈（09 归一表 §5：
    // append 不进 undo 栈；流式结束后合并为单 undo 步）。
    // 无尾段且无流式会话记账时为空操作（幂等）。
    const s = get();
    if (s.streamTail.length === 0 && !s.streamOp) return;
    dispatchSet((state) => {
      const patch = flushStreamTail(state);
      const base = patch ? { ...state, ...patch } : state;
      // 无记账（异常残留尾段）：仅合并，不登记 op、不动 undo/redo 栈
      if (!base.streamOp) return patch ? { ...patch, streamOp: null } : state;
      // 合并 op 独立一步入栈（若栈中已有流式期间的用户编辑 op，流式 op
      // 直接追加、不折叠不排序——「流式 op 作为独立一步」登记约定）；
      // redo 栈清空（新一步产生后不可重做）。
      // —— B6 位置级字段（追加区间，stop-flush 后文档坐标）——
      // 追加区间 = [startLineIdx, +insertedLineCount) 行（流式内容行）；
      // from = 区间起始行行首、to = 区间末行行尾、insert = 流式前末行
      // （undo 恢复内容）、removedText = 流式内容（undo 删除内容）。
      const streamStartLineIdx = base.streamOp.startLineIdx;
      const streamStartOff = base.lineOffsets.getOffset(streamStartLineIdx);
      const streamRemovedText = base.mainLines
        .slice(streamStartLineIdx, streamStartLineIdx + base.streamOp.insertedLineCount)
        .join('\n');
      const op: EditorOperation = {
        startLineIdx: streamStartLineIdx,
        removedLines: base.streamOp.removedLines,
        insertedLineCount: base.streamOp.insertedLineCount,
        cursorBefore: base.streamOp.cursorBefore,
        selectionStartBefore: base.streamOp.selectionStartBefore,
        selectionEndBefore: base.streamOp.selectionEndBefore,
        // 合并前后光标/选区不变（合并只并入尾段行，不改变任何内容与顺序）
        cursorAfter: base.cursorPos,
        selectionStartAfter: base.selectionStart,
        selectionEndAfter: base.selectionEnd,
        timestamp: Date.now(),
        meta: 'stream',
        from: streamStartOff,
        to: streamStartOff + streamRemovedText.length,
        insert: base.streamOp.removedLines.join('\n'),
        removedText: streamRemovedText,
      };
      // —— B6 变更日志 + 版本号（meta:'stream' op 也在日志中，N8 口径）——
      const streamVersion = state.version + 1;
      const streamLog = [...state.changeLog, { seq: streamVersion, op }];
      if (streamLog.length > CHANGE_LOG_LIMIT) {
        streamLog.splice(0, streamLog.length - CHANGE_LOG_LIMIT);
      }
      return {
        ...(patch ?? {}),
        streamOp: null,
        undoStack: [...base.undoStack, op],
        redoStack: [],
        changeLog: streamLog,
        version: streamVersion,
      };
    });
  },

  setText: (text) => {
    const generation = ++currentLoadGeneration;
    dispatchSet(() => {
      const lines = text.split('\n');

      if (lines.length <= FIRST_CHUNK_LINES) {
        const res = updateLinesIncremental([], new LineOffsetTree([]), [], 0, 0, lines, []);
        return {
          ...res,
          // 整文档重置：清空流式尾段
          streamTail: EMPTY_TAIL,
          streamTailCodeState: EMPTY_STATE_TAIL,
          streamTailFenceLines: EMPTY_FENCE_TAIL,
          // 整文档重置（R3-A）：流式会话记账与用户活跃标记清零
          streamOp: null,
          lastUserEditTime: 0,
          cursorPos: 0,
          selectionStart: 0,
          selectionEnd: 0,
          // 整文档重置：方向层一并复位（锚点 = 活动端 = 0，assoc 默认）
          anchorPos: 0,
          headPos: 0,
          assoc: 'before',
          undoStack: [],
          redoStack: [],
          // 整文档重置（B6）：变更日志清空 + 版本号归零（新文档版本序列）
          changeLog: [],
          version: 0,
        };
      }

      // Chunked loading for large files
      const firstChunk = lines.slice(0, FIRST_CHUNK_LINES);
      const res = updateLinesIncremental([], new LineOffsetTree([]), [], 0, 0, firstChunk, []);

      let currentIdx = FIRST_CHUNK_LINES;
      const chunkSize = CHUNK_SIZE;

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
          setTimeout(processNextChunk, CHUNK_FALLBACK_DELAY_MS);
        }
      };

      if (typeof window !== 'undefined' && window.requestIdleCallback) {
        window.requestIdleCallback(processNextChunk);
      } else {
        setTimeout(processNextChunk, CHUNK_FALLBACK_DELAY_MS);
      }

      return {
        ...res,
        streamTail: EMPTY_TAIL,
        streamTailCodeState: EMPTY_STATE_TAIL,
        streamTailFenceLines: EMPTY_FENCE_TAIL,
        // 整文档重置（R3-A）：流式会话记账与用户活跃标记清零
        streamOp: null,
        lastUserEditTime: 0,
        cursorPos: 0,
        selectionStart: 0,
        selectionEnd: 0,
        // 整文档重置：方向层一并复位（锚点 = 活动端 = 0，assoc 默认）
        anchorPos: 0,
        headPos: 0,
        assoc: 'before',
        undoStack: [],
        redoStack: [],
        // 整文档重置（B6）：变更日志清空 + 版本号归零（新文档版本序列）
        changeLog: [],
        version: 0,
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
        // 纯移动：锚点 = 活动端 = 新位置（无选区；assoc 按行尾判定刷新）
        anchorPos: bounded,
        headPos: bounded,
        assoc: computeAssocForLines(
          state.lineOffsets,
          (i) => state.getLine(i),
          bounded
        ),
      };
    }),

  setSelection: (start, end) =>
    dispatchSet((state) => {
      const min = Math.max(0, Math.min(start, state.textLength));
      const max = Math.max(0, Math.min(end, state.textLength));
      const cursorPos = Math.max(0, Math.min(end, state.textLength));
      return {
        // —— 兼容层（336 门禁零回归）：归一化 min/max、cursorPos 恒等于 end ——
        selectionStart: Math.min(min, max),
        selectionEnd: Math.max(min, max),
        cursorPos,
        // —— R4-B 方向层：无 anchor 时 start 即 anchor、head = end ——
        // 与兼容层解耦存储：start > end（反向选区）时 anchor 保留在 start，
        // 归一化字段仍为 [end, start]，Shift 扩展方向性不再丢失。
        anchorPos: Math.max(0, Math.min(start, state.textLength)),
        headPos: cursorPos,
        assoc: computeAssocForLines(
          state.lineOffsets,
          (i) => state.getLine(i),
          cursorPos
        ),
      };
    }),

  // —— R6-P1 行文本模式 grapheme 移动（方向键根治）——
  // ArrowLeft/Right 14.5ms/键根因：HiddenInput 方向键分支对全文调
  // getText()（O(全文) join）+ 全文 grapheme 边界。本方法改为行文本模式：
  // 定位光标所在行（LineOffsetTree O(log n) + getLine O(1)）→ 行内偏移 →
  // 行内 grapheme 边界（O(行)）→ 换算全局位置。行边界显式跨行：
  // - 行首向左 → 上一行行尾（跨过换行符）；文档首行行首 → 0（不动）；
  // - 行尾向右 → 下一行行首（跨过换行符）；文档末尾 → 自身（不动）。
  // 与全文模式语义等价：全文模式下 \n 是普通字符，行首向左跨过 \n 落在
  // 上一行行尾（行尾 = 换行符前一格），行尾向右落在下一行行首。空行
  // （行首 = 行尾）同样覆盖。返回新全局位置（恒为 grapheme 边界）。
  moveGrapheme: (pos, dir) => {
    const s = get();
    const p = Math.max(0, Math.min(pos, s.textLength));
    const lineIdx = s.lineOffsets.findLineIndex(p);
    const lineStart = s.lineOffsets.getOffset(lineIdx);
    const lineText = s.getLine(lineIdx) ?? '';
    const inLine = p - lineStart;
    if (dir === 'left') {
      // 行内向左：行内 grapheme 边界（不跨 \n——行文本不含换行符）
      if (inLine > 0) return lineStart + findPrevGraphemeBoundary(lineText, inLine);
      // 行首向左：跨到上一行行尾（= 本行行首 - 1，即换行符前一格）；
      // 文档首行行首 = 文档开头（原地不动）
      return lineIdx > 0 ? lineStart - 1 : 0;
    }
    // 行内向右：行内 grapheme 边界
    if (inLine < lineText.length) {
      return lineStart + findNextGraphemeBoundary(lineText, inLine);
    }
    // 行尾向右：跨到下一行行首（= 本行行尾 + 1，即跨过换行符）；
    // 文档末尾行尾 = 文档末尾（原地不动）
    if (p >= s.textLength) return p;
    return lineStart + lineText.length + 1;
  },

  // —— R4-B 选区方向性核心（04 §3.3 方案 1）——
  // Shift+方向键扩展 = 只动 head 不动 anchor；反向移动时 head 越过 anchor，
  // 选区区间翻转但方向保持——「Shift+Left 后 Shift+Right 第二次方向正确」。
  // 纯方向键（无 Shift）移动 = setSelection(newPos, newPos)（anchor=head=新位置），
  // 由调用方（HiddenInput R4-E 接线）走 setCursorPos / setSelection 即可。
  moveHead: (newHead) =>
    dispatchSet((state) => {
      const head = Math.max(0, Math.min(newHead, state.textLength));
      const anchor = Math.max(0, Math.min(state.anchorPos, state.textLength));
      return {
        anchorPos: anchor,
        headPos: head,
        // 兼容层视图：选区区间恒为 [min(anchor,head), max(anchor,head)]
        selectionStart: Math.min(anchor, head),
        selectionEnd: Math.max(anchor, head),
        cursorPos: head,
        assoc: computeAssocForLines(
          state.lineOffsets,
          (i) => state.getLine(i),
          head
        ),
      };
    }),

  extendSelectionByDirection: (dir) =>
    dispatchSet((state) => {
      // 以当前 head 为基点按 grapheme 边界移动（与既有方向键粒度一致）；
      // 已到文档边界时 next === head，返回原状态（幂等空操作）。
      // R6-P1：改用行文本模式 moveGrapheme（不再全文 getText() join——
      // Shift+方向键与普通方向键同根因的 O(全文) 热路径一并根治）。
      const head = Math.max(0, Math.min(state.headPos, state.textLength));
      const next = state.moveGrapheme(head, dir);
      if (next === head) return state;
      const anchor = Math.max(0, Math.min(state.anchorPos, state.textLength));
      return {
        anchorPos: anchor,
        headPos: next,
        selectionStart: Math.min(anchor, next),
        selectionEnd: Math.max(anchor, next),
        cursorPos: next,
        assoc: computeAssocForLines(
          state.lineOffsets,
          (i) => state.getLine(i),
          next
        ),
      };
    }),

  // —— 事务统一入口（R4，04 §4.3 方案 1 / 09 归一表）——
  // 位置级变更唯一入口：mergeTailInto（编辑触达合并尾段）→ planChange
  // 行区间计划 → updateLinesIncremental → EditorOperation 记录（含 meta
  // 与光标落点）→ undo/redo 互推 → 用户编辑标记 + 流式记账修正。
  // insertText/deleteText/deleteSelection 均为本入口的薄封装（行为零
  // 变化，289 门禁验证）；表格操作（diff 事务分支 / applyTableChange）
  // 同样收敛于此。空操作（from===to 且 insert===''）不记录事务。
  applyChange: (from, to, insert, opts) =>
    dispatchSet((state) => {
      const fromB = Math.max(0, Math.min(from, state.textLength));
      const toB = Math.max(0, Math.min(to, state.textLength));
      if (fromB === toB && insert === '') return state;

      // 用户编辑触达 → 尾段先并入主数组（C4 合并时机；坐标在合并前后不变）
      const s = mergeTailInto(state);

      const plan = planChange(s, fromB, toB, insert);

      // —— B6 位置级字段推导（从行级计划还原字符级区间）——
      // removedText = [fromB, toB) 区间原文本：removedLines.join('\n')
      // 即「startLineIdx 行首 → endLineIdx 行尾」全文（行间换行符在
      // join 分隔符中），截取 fromB/toB 对应子区间（行内偏移换算）。
      // 行级 splice 区间 [startLineIdx, +deleteCount) 与字符级区间
      // [fromB, toB) 严格对应（planChange 由 findLineIndex 定位端点
      // 行），推导 O(deleteCount)，与事务本身同量级。
      const posStartLineOff = s.lineOffsets.getOffset(plan.startLineIdx);
      const posEndLineOff = s.lineOffsets.getOffset(
        plan.startLineIdx + plan.deleteCount - 1
      );
      const posJoinedRemoved = plan.removedLines.join('\n');
      const removedText = posJoinedRemoved.slice(
        fromB - posStartLineOff,
        posJoinedRemoved.length -
          (posEndLineOff + plan.removedLines[plan.removedLines.length - 1].length - toB)
      );

      const res = updateLinesIncremental(
        s.mainLines,
        s.lineOffsets,
        s.mainCodeState,
        plan.startLineIdx,
        plan.deleteCount,
        plan.insertedLines,
        s.mainFenceLines
      );

      const newPos = opts?.cursorAfter ?? plan.newCursor;

      const newOp: EditorOperation = {
        startLineIdx: plan.startLineIdx,
        removedLines: plan.removedLines,
        insertedLineCount: plan.insertedLines.length,
        cursorBefore: s.cursorPos,
        selectionStartBefore: s.selectionStart,
        selectionEndBefore: s.selectionEnd,
        cursorAfter: newPos,
        selectionStartAfter: newPos,
        selectionEndAfter: newPos,
        timestamp: Date.now(),
        meta: opts?.meta,
        // B6 位置级字段（只增不改：undo/redo 兼容层不读，供日志/同步）
        from: fromB,
        to: toB,
        insert,
        removedText,
      };

      let newUndoStack = [...s.undoStack];
      const mergeMode = opts?.merge ?? 'none';
      if (mergeMode === 'typing') {
        // 连续打字合并（原 insertText 合并条件，行为零变化）：
        // 500ms + 同行 + cursorAfter === from + 单字符 + 非换行。
        // R4 顺序语义：!last.meta——流式合并 op 是独立一步，不与用户
        // 击键合并（否则用户击键并进流式 op，undo 时 removedLines 不含
        // 击键内容 → 丢字；R3 遗留 2）。
        if (
          newUndoStack.length > 0 &&
          fromB === toB &&
          insert.length === 1 &&
          insert !== '\n'
        ) {
          const last = newUndoStack[newUndoStack.length - 1];
          if (
            !last.meta &&
            Date.now() - last.timestamp < 500 &&
            last.startLineIdx === plan.startLineIdx &&
            last.cursorAfter === fromB &&
            last.insertedLineCount === 1
          ) {
            last.insertedLineCount = plan.insertedLines.length;
            last.cursorAfter = newPos;
            last.timestamp = Date.now();
          } else {
            newUndoStack.push(newOp);
          }
        } else {
          newUndoStack.push(newOp);
        }
      } else if (mergeMode === 'delete') {
        // 连续单字符删除合并（原 deleteText 合并条件，行为零变化）；
        // 同样排除 meta:'stream' 栈顶（R3 遗留 2）。
        if (
          newUndoStack.length > 0 &&
          s.selectionStart === s.selectionEnd // 单字符删除（非选择范围）
        ) {
          const last = newUndoStack[newUndoStack.length - 1];
          if (
            !last.meta &&
            Date.now() - last.timestamp < 500 &&
            last.startLineIdx === plan.startLineIdx &&
            last.insertedLineCount === 1 &&
            plan.insertedLines.length === 1
          ) {
            last.insertedLineCount = plan.insertedLines.length;
            last.cursorAfter = newPos;
            last.selectionStartAfter = newPos;
            last.selectionEndAfter = newPos;
            last.timestamp = Date.now();
          } else {
            newUndoStack.push(newOp);
          }
        } else {
          newUndoStack.push(newOp);
        }
      } else {
        newUndoStack.push(newOp);
      }

      // —— B6 变更日志 + 版本号（append-only，有界环形）——
      // 每次实际变更（非空事务）追加 {seq, op}；seq = 递增后的 version
      // （版本号每事务 +1，与日志条目一一对应）。500ms 合并击键同样记
      // 条目（每次击键是一次独立变更事件，与 undo 栈折叠解耦——同步
      // 消费端按事件粒度拉取）；超限丢弃最旧条目（环形语义）。
      const nextVersion = state.version + 1;
      const nextLog = [...state.changeLog, { seq: nextVersion, op: newOp }];
      if (nextLog.length > CHANGE_LOG_LIMIT) {
        nextLog.splice(0, nextLog.length - CHANGE_LOG_LIMIT);
      }

      return {
        ...res,
        // 编辑触达 → 尾段已并入主数组（mergeTailInto），返回 partial 必须
        // 显式清空三个尾段键：zustand 合并语义只覆盖 partial 中出现的键，
        // 缺失时旧 streamTail 残留 → 物化视图把已并入主数组的尾段再拼一遍，
        // 视图与主数组分叉（R2-G KNOWN-DEFECT：appendText + insertText 丢字）。
        streamTail: EMPTY_TAIL,
        streamTailCodeState: EMPTY_STATE_TAIL,
        streamTailFenceLines: EMPTY_FENCE_TAIL,
        // 用户编辑标记 + 流式合并记账修正（编辑点 ≤ 追加区间起点 → 区间
        // 行号整体平移；深入区间内 → 作废重记账）
        lastUserEditTime: Date.now(),
        streamOp: adjustStreamOpForEdit(
          s.streamOp,
          plan.startLineIdx,
          plan.insertedLines.length - plan.deleteCount
        ),
        cursorPos: newPos,
        selectionStart: newPos,
        selectionEnd: newPos,
        // R4-B：事务后选区收敛——锚点 = 活动端 = 落点。覆盖输入 / 删除选区
        // 后光标落点语义统一：head/anchor 任意顺序的选区（反向选区同样）在
        // 编辑后坍缩为单点，后续 Shift 扩展从落点重新建立方向。
        anchorPos: newPos,
        headPos: newPos,
        assoc: computeAssocForLines(
          res.lineOffsets,
          (i) => res.mainLines[i],
          newPos
        ),
        undoStack: newUndoStack,
        redoStack: [],
        changeLog: nextLog,
        version: nextVersion,
      };
    }),

  // 表格专用事务入口（R4：表格操作收敛）：替换 [from, to) 并精确落点
  // 光标（表格 API 计算的结果位置，而非默认的 from + insert.length），
  // 单步进 undo——恢复 undo/redo/lineOffsets/textLength 一致性。
  // R5 实例化：改经本实例 get() 委托（旧实现引用全局单例，多实例会串台）。
  applyTableChange: (from, to, insert, cursorAfter) => {
    get().applyChange(from, to, insert, { cursorAfter });
  },

  insertText: (inserted) => {
    // 薄封装：以当前选区为区间，委托 applyChange（合并模式 = 连续打字）
    const s = get();
    s.applyChange(s.selectionStart, s.selectionEnd, inserted, {
      merge: 'typing',
    });
  },

  // 流式尾部追加快速通道（R2-A 尾段零拷贝 / 08 招 2 / 09 §4 C4 契约）：
  // - 追加文本落在独立 streamTail，主数组不重建（零拷贝，O(尾段)）；
  // - LineOffsetTree 以 COW 增量更新触及块（clone 浅拷贝 + 末块 O(256)），
  //   树始终与逻辑全量一致（既有测试断言 lineOffsets.toArray 全量）；
  // - textLength O(1) 增量（append 即在末尾插入 text.length 个字符，
  //   与换行分割无关，经与树重算口径交叉验证一致）；
  // - 不进 undo 栈（流式语义）；stop-flush（flushStreamTail）时生成单个
  //   合并 op（meta:'stream'），undo 一次回退整段流式（R3-A / 09 归一表）；
  // - 尾段超上界强制合并（C4：STREAM_TAIL_MAX_LINES，防长流式退化）。
  //
  // append 光标冲突语义（R3-A / 01 问题 5 / 09 归一表）：
  // - 追加点锚定：默认全文末尾（anchor = textLength）；用户「活跃编辑末尾
  //   行」（光标在逻辑末行内、且最近一次用户编辑在 1s 窗口内）时追加点
  //   前移至光标处——流内容插入到光标前，用户打字区不被流「塞字符」；
  // - 光标平移：光标/选区位于追加点之后（≥ anchor）则整体 +text.length
  //   （wasAtEnd 语义保留：光标恰在全文末尾时随追加推进；追加点前移时
  //   光标恰在锚点处 → 不移动，后续击键仍插在流内容之前）；
  // - 流式合并记账（streamOp）：会话首次 append 快照追加前末行与光标，
  //   逐 chunk 累计追加区间行数，stop-flush 据此生成单步合并 op。
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
      // 双段换算经共享原语 lineAt（P2-A1 回修 2 去重）。
      const getLineAt: LineAccessor = (i) =>
        lineAt(mainLines, streamTail, i);
      const getStateAt: StateAccessor = (i) =>
        lineAt(s.mainCodeState, s.streamTailCodeState, i);

      // —— 追加点锚定（01 问题 5 方案 5.2 / R3-A）——
      // userEditingTail：光标落在逻辑末行内（非全文末尾）+ 用户有活跃编辑。
      // 满足时追加点前移至光标处；否则锚定全文末尾（保持现状语义）。
      // 追加点 = 光标 + 会话内前移累计流长（shiftedLen）：用户击键后光标
      // 右移，追加点同步右移，流内容始终按到达顺序接在已插入流段末尾。
      const userActive =
        s.lastUserEditTime > 0 &&
        Date.now() - s.lastUserEditTime < STREAM_USER_EDIT_WINDOW_MS;
      const cursorInLastLine =
        s.cursorPos < s.textLength &&
        s.lineOffsets.findLineIndex(s.cursorPos) === lastLineIdx;
      const shiftAnchorToCursor = cursorInLastLine && userActive;
      const anchor = shiftAnchorToCursor
        ? s.cursorPos + (s.streamOp?.shiftedLen ?? 0)
        : s.textLength;

      // 拼接逻辑末行 + 追加文本：追加点前移时在光标处拆行插入
      // （prefix + text + suffix；插入到光标前，光标位置不变）；
      // 追加点平移后的整行拆分与旧路径一致（combined 后 split）。
      const lastLine = getLineAt(lastLineIdx);
      let combined: string;
      if (shiftAnchorToCursor) {
        const lineOffset = s.lineOffsets.getOffset(lastLineIdx);
        const inLine = Math.max(0, Math.min(anchor - lineOffset, lastLine.length));
        combined = lastLine.slice(0, inLine) + text + lastLine.slice(inLine);
      } else {
        combined = lastLine + text;
      }
      const newSegmentLines = combined.split('\n');

      // —— 状态机基线（与旧 appendText 一致，访问器化后兼容尾段视图）——
      // 「进入合并行的状态」由旧行 [0, lastLineIdx) 决定（末行本身将被
      // 合并内容替换——若末行是结束块的空行，该空行在合并后可能消失，
      // 不能把它当作块已退出的依据）；块类型由连续 html_block 运行段
      // 仿真得出（CodeState 不记录类型，见 inferHtmlBlockState）。
      // P2-A1 fence 单源化：fence/math 基线改为经 fence 行集合二分回推
      // （旧实现按 lastLineIdx 自身状态推断：若旧行是 fence_start/math 开栏
      // 行，合并后行仍为开栏形态时应由段循环重新判定开栏，而非沿用旧行
      // 的块内状态——旧推断在该场景把合并行误判为 code/fence_end，与全量
      // 重扫分歧；本次与 updateLinesIncremental 同源修正）。
      let inCodeBlock = false;
      let inMathBlock = false;
      // 开栏状态（marker/length）：从最近 fence_start 行原文提取（该行未
      // 被本次追加触及，内容权威）；块内行（fenceIdx 为 fence_start 且
      // lastLineIdx 其后）无法从单行回推时保持 null——仅影响「块内 fence
      // 形态行」的关闭判定，与 parser 的防御分支同向（fenceState 为 null
      // 时块内 fence 形态行按 code 处理，见段循环）。
      let fenceState: { marker: string; length: number } | null = null;
      {
        // 双段 fence 行集合（mainFenceLines + 尾段相对行号平移 boundary，
        // 各自升序、拼接后整体升序）二分定位 < lastLineIdx 的最近 fence 行。
        let lo = 0;
        let hi = s.mainFenceLines.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (s.mainFenceLines[mid] < lastLineIdx) lo = mid + 1;
          else hi = mid;
        }
        let fenceIdx = lo > 0 ? s.mainFenceLines[lo - 1] : -1;
        for (let k = s.streamTailFenceLines.length - 1; k >= 0; k--) {
          const abs = boundary + s.streamTailFenceLines[k];
          if (abs < lastLineIdx) {
            if (abs > fenceIdx) fenceIdx = abs;
            break;
          }
        }
        if (fenceIdx >= 0) {
          const st = getStateAt(fenceIdx);
          if (st === 'fence_start') {
            inCodeBlock = true;
            const fenceOpen = FENCE_OPEN_RE.exec(
              stripBlockquoteContext(getLineAt(fenceIdx)).trim()
            );
            if (fenceOpen) {
              fenceState = {
                marker: fenceOpen[1] !== undefined ? '`' : '~',
                length: (fenceOpen[1] ?? fenceOpen[3]).length,
              };
            }
          } else if (st === 'fence_end') {
            inCodeBlock = false;
          } else if (st === 'math_fence_start') {
            inMathBlock = true;
          } else if (st === 'math_fence_end') {
            inMathBlock = false;
          }
        }
      }
      // 缩进代码块状态：末行状态为 'indent_code' 时视为块内（块内空行保持）
      let inIndentCode = false;
      // HTML 块状态：从旧行回推——增量语义与 updateLinesIncremental 一致
      const inferredHtml = inferHtmlBlockState(getLineAt, getStateAt, lastLineIdx);
      let inHtmlBlock = inferredHtml.inHtmlBlock;
      let htmlType = inferredHtml.htmlType;
      // HTML 块 start（type 7 段落保护）所需的「上一非空白行形态」记忆
      let prevBlockKind = inferPrevBlockKind(getLineAt, getStateAt, lastLineIdx);
      const currentState = getStateAt(lastLineIdx);
      if (currentState === 'indent_code') inIndentCode = true;

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
        } else if (!inMathBlock && FENCE_OPEN_RE.test(htmlContent.trim())) {
          // P2-A1 fence 单源化（镜像 parser / updateLinesIncremental）：
          // 判定输入 = 块引用剥离后 trim（htmlContent 与 parser 的
          // bqContent 同源；旧实现用未剥离的 trimmed，`> ``` ` 块引用
          // 围栏行在段状态机内不被识别，与重扫分歧——一并修正）。
          // 开栏记录 marker/length；块内 fence 形态行仅当 isFenceClose
          // 才关闭（` ```INS` / ` ``` js` 保持 code）——根治 appendText
          // 路径的 KNOWN-DEFECT（旧布尔翻转在 fence_end 行尾追加时把
          // 合并行误判为 fence_end，与全量重扫分歧）。
          if (!inCodeBlock) {
            segmentCodeStates[i] = 'fence_start';
            inCodeBlock = true;
            const fenceOpen = FENCE_OPEN_RE.exec(htmlContent.trim());
            fenceState = {
              marker: fenceOpen![1] !== undefined ? '`' : '~',
              length: (fenceOpen![1] ?? fenceOpen![3]).length,
            };
          } else if (
            fenceState &&
            isFenceClose(trimmed, fenceState.marker, fenceState.length)
          ) {
            segmentCodeStates[i] = 'fence_end';
            inCodeBlock = false;
            fenceState = null;
          } else {
            segmentCodeStates[i] = 'code';
          }
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

      // textLength O(1) 增量（append 即在末尾插入 text.length 个字符；
      // 追加点前移同样 +delta——插入发生在光标处，全文长度增量不变）
      const textLength = state.textLength + text.length;

      // —— 光标/选区平移（01 问题 5 方案 5.2：位于追加点之后 → +delta）——
      // 普通路径（追加点 = 全文末尾）：光标/选区 ≥ 锚点 → +delta——光标恰在
      // 末尾（wasAtEnd）随追加推进（Requirement 6 保留），选区尾跨末尾平移；
      // 前移路径（追加点 = 光标 + 累计流长）：光标恒不动（光标在追加点
      // 之前），选区 > 锚点 → +delta（选区尾跨流段末尾平移）；选区 == 锚点
      // 不动——插入发生在锚点处，锚点左边界的内容与选区不受影响，
      // 光标与选区不产生无谓分叉（后续击键仍落在流内容之前）。
      const delta = text.length;
      const shiftGE = (p: number) => (p >= anchor ? p + delta : p);
      const shiftGT = (p: number) => (p > anchor ? p + delta : p);

      // —— 流式合并记账（R3-A：append 不进 undo 栈；stop-flush 合并单步）——
      // 会话首次 append（streamOp 为空）时快照追加前状态；此时尾段必为空
      // （stop-flush 已清空记账），lastLineIdx = 主数组末行、lastLine 即
      // 追加前末行全文。insertedLineCount 记账 = 追加区间总行数：
      // 会话起始 1（末行本身）+ 各 chunk 行增量累计（替换 1 行 → 净增 len-1），
      // undo 时从 startLineIdx 起删除该数量的行即恢复流式前文档。
      const streamOp = s.streamOp ?? {
        startLineIdx: lastLineIdx,
        removedLines: [lastLine],
        insertedLineCount: 1,
        cursorBefore: state.cursorPos,
        selectionStartBefore: state.selectionStart,
        selectionEndBefore: state.selectionEnd,
        timestamp: Date.now(),
        shiftedLen: 0,
      };
      const nextStreamOp: StreamOp = {
        ...streamOp,
        insertedLineCount: streamOp.insertedLineCount + newSegmentLines.length - 1,
        // 前移路径插入的流内容字符数累计（追加点随之前移的里程）；
        // 普通路径（追加点 = 全文末尾）不累计
        shiftedLen: shiftAnchorToCursor
          ? streamOp.shiftedLen + text.length
          : streamOp.shiftedLen,
      };

      // —— R4-B：方向层平移 + assoc 刷新 ——
      // 追加后光标最终位置（普通路径随追加推进 / 前移路径不动）；
      // anchor/head 与兼容层选区同规则平移（≥ 追加点 +delta）。
      const finalCursorPos = shiftAnchorToCursor ? s.cursorPos : shiftGE(s.cursorPos);
      // 追加后的逻辑行访问器（主数组 + 新尾段，boundary 见上：主数组末行索引）
      const appendLineAt: LineAccessor = (i) =>
        i < boundary ? mainLines[i] : newTail[i - boundary];

      return {
        mainLines,
        streamTail: newTail,
        mainCodeState: s.mainCodeState,
        streamTailCodeState: newTailCode,
        mainFenceLines: s.mainFenceLines,
        streamTailFenceLines: newTailFence,
        lineOffsets: newOffsets,
        textLength,
        streamOp: nextStreamOp,
        cursorPos: finalCursorPos,
        selectionStart: shiftAnchorToCursor ? shiftGT(s.selectionStart) : shiftGE(s.selectionStart),
        selectionEnd: shiftAnchorToCursor ? shiftGT(s.selectionEnd) : shiftGE(s.selectionEnd),
        // 方向层与兼容层选区同步平移；assoc 按新行布局判定（光标通常在
        // 行尾/全文末尾 → 'after'，关联上一字符）
        anchorPos: shiftAnchorToCursor ? shiftGT(s.anchorPos) : shiftGE(s.anchorPos),
        headPos: shiftAnchorToCursor ? shiftGT(s.headPos) : shiftGE(s.headPos),
        assoc: computeAssocForLines(newOffsets, appendLineAt, finalCursorPos),
      };
    }),

  deleteText: (backward) => {
    // 薄封装：先按 grapheme 边界扩展删除区间（原逻辑），再委托
    // applyChange——无选区（单字符删除）走 'delete' 合并模式（原合并
    // 条件），有选区（整选区删除）不合并（与旧行为一致）。
    // R5 实例化：改经本实例 get()（旧实现引用全局单例）。
    const base = mergeTailInto(get());
    let s = base.selectionStart;
    let e = base.selectionEnd;
    const hadSelection = s !== e;

    if (!hadSelection) {
      const text = base.mainLines.join('\n');
      if (backward && s > 0) {
        s = findPrevGraphemeBoundary(text, s);
      } else if (!backward && e < base.textLength) {
        e = findNextGraphemeBoundary(text, e);
      } else {
        return;
      }
    }

    get().applyChange(s, e, '', {
      merge: hadSelection ? 'none' : 'delete',
    });
  },

  deleteSelection: (start, end) => {
    // 薄封装：归一化区间后委托 applyChange（单步事务，不参与 500ms 合并）
    const base = get();
    const s = Math.max(0, Math.min(start, end));
    const e = Math.min(base.textLength, Math.max(start, end));
    if (s === e) return;
    base.applyChange(s, e, '', { merge: 'none' });
  },

  undo: () =>
    dispatchSet((state) => {
      if (state.undoStack.length === 0) return state;
      // 用户操作触达 → 尾段先并入主数组（C4 合并时机；undo 针对的
      // 是主数组编辑 op，行号坐标在合并前后不变）
      const base = mergeTailInto(state);
      const stack = base.undoStack;
      const top = stack[stack.length - 1];

      // —— 撤销组收集（R4 / R3 遗留 2：流式 op + 用户 op 同栈交替 undo 精确）——
      // 行级 splice 模型下，meta:'stream' 合并 op 的快照取自流式会话开始
      // （早于其后入栈的同区间用户 op）。若独立撤销流式 op，整行恢复会
      // 吞掉区间内的用户击键内容，用户 op 快照随即失效（undo 流式后再
      // undo 用户 → 恢复到含流式内容行的错误状态）。修复：撤销流式 op
      // 时，把「区间与之重叠」的更早 op 一并组成撤销组，按生效序（最早
      // 先撤）逐 op 撤销——链条每步都精确恢复到该 op 生效前，最终回到
      // 组前状态（3d/3f 场景：一次 undo 精确回到流式会话开始）。普通 op
      // （组内无流式 op）保持单步撤销（行为零变化）。
      let groupStart = stack.length - 1;
      if (top.meta === 'stream') {
        const topStart = top.startLineIdx;
        const topEnd = top.startLineIdx + top.insertedLineCount;
        let i = stack.length - 2;
        while (i >= 0) {
          const op = stack[i];
          const opStart = op.startLineIdx;
          const opEnd = op.startLineIdx + op.insertedLineCount;
          if (opStart >= topEnd || opEnd <= topStart) break;
          groupStart = i;
          i--;
        }
      }

      // —— 撤销组执行（生效序：最早先撤，链式精确）——
      // 逐 op：Reverse splice——remove `insertedLineCount` lines at
      // `startLineIdx` and insert `removedLines`；逆 op 推入 redo 栈。
      let cur = base;
      const newRedo: EditorOperation[] = [...base.redoStack];
      for (let gi = groupStart; gi < stack.length; gi++) {
        const op = stack[gi];
        const res = updateLinesIncremental(
          cur.mainLines,
          cur.lineOffsets,
          cur.mainCodeState,
          op.startLineIdx,
          op.insertedLineCount,
          op.removedLines,
          cur.mainFenceLines
        );

        // Forward op to redo stack（以「撤销时刻的当前状态」为基准重建
        // 逆 op，不依赖快照——组撤销下每步当前状态就是链式精确的中间态）
        const invRemovedLines = cur.mainLines.slice(
          op.startLineIdx,
          op.startLineIdx + op.insertedLineCount
        );
        // —— B6 位置级字段（整行区间，undo 后 = cur 文档坐标）——
        // 逆操作（redo）删除 = undo 恢复的 op.removedLines 行（行数 =
        // op.removedLines.length，与 op.insertedLineCount 不同时按
        // 「逆操作删除的行」定区间）；insert = redo 插入内容（undo 前
        // 区间行）；removedText = redo 删除内容（undo 恢复行）。
        const invFrom = cur.lineOffsets.getOffset(op.startLineIdx);
        const invRemovedText = op.removedLines.join('\n');
        const inverseOp: EditorOperation = {
          startLineIdx: op.startLineIdx,
          removedLines: invRemovedLines,
          insertedLineCount: op.removedLines.length,
          cursorBefore: op.cursorAfter,
          selectionStartBefore: op.selectionStartAfter,
          selectionEndBefore: op.selectionEndAfter,
          cursorAfter: op.cursorBefore,
          selectionStartAfter: op.selectionStartBefore,
          selectionEndAfter: op.selectionEndBefore,
          timestamp: Date.now(),
          // 流式合并 op 的类型标记随逆 op 传递（redo 后仍为 meta:'stream'）
          meta: op.meta,
          from: invFrom,
          to: invFrom + invRemovedText.length,
          insert: invRemovedLines.join('\n'),
          removedText: invRemovedText,
        };

        newRedo.push(inverseOp);
        cur = { ...cur, ...res };
      }

      // 光标/选区回退到组内最早 op 的 before（组前状态的光标快照）
      const firstOp = stack[groupStart];
      // R4-B：从 before 快照（兼容层三元组）推断方向层 anchor/head——
      // 光标恰在选区一端时另一端即 anchor（反向选区方向随撤销精确恢复）；
      // assoc 按撤销后文本（cur 已链式重建）的行布局判定。
      const undoSel = inferAnchorHead(
        firstOp.cursorBefore,
        firstOp.selectionStartBefore,
        firstOp.selectionEndBefore
      );

      return {
        mainLines: cur.mainLines,
        lineOffsets: cur.lineOffsets,
        mainCodeState: cur.mainCodeState,
        mainFenceLines: cur.mainFenceLines,
        textLength: cur.textLength,
        // 操作触达 → 尾段已并入主数组，显式清空三个尾段键（同 insertText）。
        streamTail: EMPTY_TAIL,
        streamTailCodeState: EMPTY_STATE_TAIL,
        streamTailFenceLines: EMPTY_FENCE_TAIL,
        // 用户操作标记 + 流式合并记账修正（同 insertText；undo 的编辑点
        // = 组内最早 op 的 startLineIdx，行数净变化 = 组撤销总行差）
        lastUserEditTime: Date.now(),
        streamOp: adjustStreamOpForEdit(
          base.streamOp,
          firstOp.startLineIdx,
          cur.mainLines.length - base.mainLines.length
        ),
        cursorPos: firstOp.cursorBefore,
        selectionStart: firstOp.selectionStartBefore,
        selectionEnd: firstOp.selectionEndBefore,
        anchorPos: undoSel.anchorPos,
        headPos: undoSel.headPos,
        assoc: computeAssocForLines(
          cur.lineOffsets,
          (i) => cur.mainLines[i],
          undoSel.headPos
        ),
        undoStack: stack.slice(0, groupStart),
        redoStack: newRedo,
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

      // —— B6 位置级字段（整行区间，redo 后文档坐标）——
      // 逆操作（undo）删除 = redo 插入的 op.removedLines 行（行数 =
      // op.removedLines.length）；insert = undo 恢复内容（redo 前区间
      // 行）；removedText = undo 删除内容（redo 插入行）。redo 前后
      // startLineIdx 行首偏移不变（行级 splice 不动前缀行）。
      const redoInvFrom = base.lineOffsets.getOffset(op.startLineIdx);
      const redoInvRemovedText = op.removedLines.join('\n');
      const redoInvRemovedLines = base.mainLines.slice(
        op.startLineIdx,
        op.startLineIdx + op.insertedLineCount
      );
      const inverseOp: EditorOperation = {
        startLineIdx: op.startLineIdx,
        removedLines: redoInvRemovedLines,
        insertedLineCount: op.removedLines.length,
        cursorBefore: op.cursorAfter,
        selectionStartBefore: op.selectionStartAfter,
        selectionEndBefore: op.selectionEndAfter,
        cursorAfter: op.cursorBefore,
        selectionStartAfter: op.selectionStartBefore,
        selectionEndAfter: op.selectionEndBefore,
        timestamp: Date.now(),
        // 流式合并 op 的类型标记随逆 op 传递（redo 后仍为 meta:'stream'）
        meta: op.meta,
        from: redoInvFrom,
        to: redoInvFrom + redoInvRemovedText.length,
        insert: redoInvRemovedLines.join('\n'),
        removedText: redoInvRemovedText,
      };

      // R4-B：从被重做 op 的 before 快照推断方向层（anchor/head），
      // assoc 按重做后文本（base + res）的行布局判定。
      const redoSel = inferAnchorHead(
        op.cursorBefore,
        op.selectionStartBefore,
        op.selectionEndBefore
      );

      return {
        ...res,
        // 操作触达 → 尾段已并入主数组，显式清空三个尾段键（同 insertText）。
        streamTail: EMPTY_TAIL,
        streamTailCodeState: EMPTY_STATE_TAIL,
        streamTailFenceLines: EMPTY_FENCE_TAIL,
        // 用户操作标记 + 流式合并记账修正（同 insertText；redo 的编辑点
        // = 被重做 op 的 startLineIdx，行数净变化 = inserted - removed）
        lastUserEditTime: Date.now(),
        streamOp: adjustStreamOpForEdit(
          base.streamOp,
          op.startLineIdx,
          op.insertedLineCount - op.removedLines.length
        ),
        cursorPos: op.cursorBefore,
        selectionStart: op.selectionStartBefore,
        selectionEnd: op.selectionEndBefore,
        anchorPos: redoSel.anchorPos,
        headPos: redoSel.headPos,
        assoc: computeAssocForLines(
          res.lineOffsets,
          (i) => res.mainLines[i],
          redoSel.headPos
        ),
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
};
    // 删除视图数据字段（防遮蔽原型 getter；删除后视图读取经原型链
    // 命中 lazyViewProto 的惰性 getter，语义 = 物化视图）
    delete (state as unknown as Record<string, unknown>).lines;
    delete (state as unknown as Record<string, unknown>).codeBlockState;
    delete (state as unknown as Record<string, unknown>).fenceLines;
    // 挂惰性视图原型（此后每次 set 由 dispatchSet 的 setPrototypeOf 恢复）
    Object.setPrototypeOf(state, lazyViewProto);
    return state;
  });

  // —— setState 归一 + 惰性视图原型恢复（R2-A 归一 / R6-P1 惰性化）——
  // 统一分发入口：store 内部方法与外部消费方全部经此更新状态。
  // 1) 归一：外部按旧字段名 lines/codeBlockState/fenceLines 传整档重置时
  //    映射到主数组字段并清空尾段（视图字段由 lazyViewProto 惰性生成）；
  // 2) 惰性视图：不再在 set 时物化兼容视图（R6-P1 热路径移除——
  //    append@1M 场景 3.6ms concat 消失）——lines/codeBlockState/
  //    fenceLines 是原型链 getter（lazyViewProto），只在真正被读取时
  //    按需物化。zustand 合并产生的新 state 是普通对象（原型链丢失），
  //    这里经 setPrototypeOf 恢复；空操作（Object.is 相同，zustand 不
  //    替换）时 state 未变、原型未丢，判断后自然跳过（幂等零成本）。
  // store 内部 set 也必须经此分发（zustand 原生 set 不经过归一/原型恢复）。
  // R5 实例化：dispatchSet 闭包绑定本实例（store.getState / store.setState），
  // 实例之间天然隔离；纯内容替换 → diff 事务分支委托本实例的 applyChange。
  const rawSetState = store.setState.bind(store);
  const dispatchSet = ((partial: unknown, replace?: boolean) => {
    const current = store.getState();
    const resolved =
      typeof partial === 'function' ? partial(current) : partial;
    // —— 纯内容替换声明 → diff 事务（R4：表格操作收敛，04 §4.3 方案 1）——
    // 外部消费方只传 { lines } 整行数组（表格操作旧路径直改 setState 的点）
    // 时，旧路径整档重置会绕过 updateLinesIncremental：不进 undo、不更新
    // lineOffsets/textLength/codeBlockState——一致性漂移（04 §4.1 U1）。
    // 本分支把该声明收敛为 applyChange 事务：公共前缀/后缀定位最小变更
    // 区间 → 单步事务（undo 一步回退、树/行长/textLength/块状态全量一致）。
    // 仅当文本实际变化时才生成事务；无法定位局部区间（全文重写）或文本
    // 未变时回落权威整档重置路径（语义与旧路径一致）。
    if (!replace && isPlainContentReplace(resolved)) {
      const newLines = resolved.lines;
      const currentCount = current.getLineCount();
      const oldText = current.getText();
      const newText = newLines.join('\n');
      if (oldText !== newText) {
        const range = findContentDiffRange(
          (i) => current.getLine(i),
          currentCount,
          newLines
        );
        if (range) {
          // 委托事务核心（其内部 dispatchSet 携带 main* 键，不会再命中本分支，
          // 无递归）；光标落点由调用方后续 setCursorPos 精确设置（表格操作
          // 的既有调用模式：setState 后紧跟 setCursorPos）。
          current.applyChange(range.from, range.to, range.insert);
          return;
        }
      }
    }
    const normalized = normalizeSetStatePartial(resolved);
    // P2-A1 回修 3：旧 if/else 两分支完全相同（历史遗留——前身 if 分支
    // 为 materializeViews 产物，移除后未合并），合并为单语句
    rawSetState(normalized as never, replace as never);
    // R6-P1：恢复惰性视图原型（zustand 合并产物是普通对象——若使用
    // replace 路径同理；空操作时 state 未替换，原型未变，判断后跳过）
    const s = store.getState();
    if (s !== null && typeof s === 'object' && Object.getPrototypeOf(s) !== lazyViewProto) {
      Object.setPrototypeOf(s, lazyViewProto);
    }
  }) as typeof store.setState;

  store.setState = dispatchSet;
  return store;
}

/**
 * —— R5 实例工厂（06 §8 宿主集成接口 / 05 场景四文档工作区前置）——
 * 全局单例保留为默认导出（向后兼容：组件缺省 store prop / 既有测试 /
 * main.tsx 的 __CRISH_SESSION_STORE__ 均继续使用默认实例）；
 * 宿主多实例场景（文档工作区/多面板/会话历史多块渲染）经
 * createEditorStore() 创建独立实例——state、订阅、dispatchSet 全链隔离，
 * 实例可并行（R5 验收：两个实例互不干扰）。
 */
export const useEditorStore = buildEditorStore();

/**
 * 创建独立编辑器 store 实例（R5 实例工厂）：
 * 与全局单例完全同构（同一套方法/访问器/增量状态机），但 state 独立——
 * setText/appendText/光标/选区/undo 等全链互不干扰，可多实例并行。
 * 典型用法：`const store = createEditorStore(); <MarkdownEngine store={store} />`。
 */
export function createEditorStore(): UseBoundStore<StoreApi<EditorState>> {
  return buildEditorStore();
}

/** 编辑器 store 实例类型（MarkdownEngine 的 store prop / 工厂返回值的类型面） */
export type EditorStore = UseBoundStore<StoreApi<EditorState>>;
