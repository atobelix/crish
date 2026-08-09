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
 * 从编辑点之前的旧行推断「上一非空白行形态」（增量起点上下文）：
 * 从 before-1 向前扫描，跳过空行（空行把非列表上下文重置为 blank——
 * 与 parser 空行分支 `if (prevBlockKind !== 'list') prevBlockKind = 'blank'`
 * 语义一致），首个非空行按旧状态归类（code 类状态 → 'code'，'none' →
 * guessBlockKind）。文档开头无前置行时按 'blank' 处理。
 */
function inferPrevBlockKind(
  lines: string[],
  codeBlockState: CodeState[],
  before: number
): BlockKind {
  let sawBlank = false;
  for (let j = before - 1; j >= 0; j--) {
    const content = stripBlockquoteContext(lines[j]);
    if (content.trim() === '') {
      sawBlank = true;
      continue;
    }
    let kind: BlockKind;
    if (codeBlockState[j] !== 'none') {
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
  lines: string[],
  codeBlockState: CodeState[],
  before: number
): boolean {
  for (let j = before - 1; j >= 0; j--) {
    const st = codeBlockState[j];
    if (st === 'indent_code') return true;
    if (st !== 'none') return false;
    if (stripBlockquoteContext(lines[j]).trim() !== '') return false;
  }
  return false;
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
  lines: string[];
  lineOffsets: LineOffsetTree;
  codeBlockState: CodeState[];
  textLength: number;
  fenceLines: number[]; // Ordered array of fence line numbers

  cursorPos: number;
  selectionStart: number;
  selectionEnd: number;

  undoStack: EditorOperation[];
  redoStack: EditorOperation[];

  getText: () => string;
  getLineIndex: (pos: number) => number;

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
    lines,
    codeBlockState,
    startLineIdx
  );
  // 上一非空白行形态记忆（段落打断 / 列表延续 / 表格优先判定所需）
  let prevBlockKind = inferPrevBlockKind(lines, codeBlockState, startLineIdx);

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

    if (!inMathBlock && trimmed.startsWith('```')) {
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
            newState = 'none';
            inIndentCode = false;
            prevBlockKind = guessBlockKind(content, prevBlockKind);
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
          newState = 'none';
          prevBlockKind = guessBlockKind(content, prevBlockKind);
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

  return {
    lines: newLinesArr,
    lineOffsets: newOffsets,
    codeBlockState: newCodeState,
    textLength: newTextLength,
    fenceLines: newFenceLines,
  };
}

let currentLoadGeneration = 0;

export const useEditorStore = create<EditorState>((set, get) => ({
  lines: [''],
  lineOffsets: new LineOffsetTree([1]),
  codeBlockState: ['none'],
  textLength: 0,
  fenceLines: [],

  cursorPos: 0,
  selectionStart: 0,
  selectionEnd: 0,
  isComposing: false,
  setIsComposing: (isComposing) => set({ isComposing }),

  undoStack: [],
  redoStack: [],

  getText: () => get().lines.join('\n'),
  getLineIndex: (pos) => get().lineOffsets.findLineIndex(pos),

  setText: (text) => {
    const generation = ++currentLoadGeneration;
    set(() => {
      const lines = text.split('\n');

      if (lines.length <= 1000) {
        const res = updateLinesIncremental([], new LineOffsetTree([]), [], 0, 0, lines, []);
        return {
          ...res,
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

        useEditorStore.setState((s) => {
          if (generation !== currentLoadGeneration) return s;
          const updated = updateLinesIncremental(
            s.lines,
            s.lineOffsets,
            s.codeBlockState,
            s.lines.length,
            0,
            chunk,
            s.fenceLines
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
        cursorPos: 0,
        selectionStart: 0,
        selectionEnd: 0,
        undoStack: [],
        redoStack: [],
      };
    });
  },

  setCursorPos: (pos) =>
    set((state) => {
      const bounded = Math.max(0, Math.min(pos, state.textLength));
      return {
        cursorPos: bounded,
        selectionStart: bounded,
        selectionEnd: bounded,
      };
    }),

  setSelection: (start, end) =>
    set((state) => {
      const min = Math.max(0, Math.min(start, state.textLength));
      const max = Math.max(0, Math.min(end, state.textLength));
      return {
        selectionStart: Math.min(min, max),
        selectionEnd: Math.max(min, max),
        cursorPos: Math.max(0, Math.min(end, state.textLength)),
      };
    }),

  insertText: (inserted) =>
    set((state) => {
      const s = state.selectionStart;
      const e = state.selectionEnd;

      const startLineIdx = state.lineOffsets.findLineIndex(s);
      const endLineIdx = state.lineOffsets.findLineIndex(e);

      const startLineOffset = state.lineOffsets.getOffset(startLineIdx);
      const endLineOffset = state.lineOffsets.getOffset(endLineIdx);

      const prefix = state.lines[startLineIdx].substring(
        0,
        s - startLineOffset
      );
      const suffix = state.lines[endLineIdx].substring(e - endLineOffset);

      const newSegment = prefix + inserted + suffix;
      const insertedLines = newSegment.split('\n');

      const deleteCount = endLineIdx - startLineIdx + 1;
      const removedLines = state.lines.slice(
        startLineIdx,
        startLineIdx + deleteCount
      );

      const res = updateLinesIncremental(
        state.lines,
        state.lineOffsets,
        state.codeBlockState,
        startLineIdx,
        deleteCount,
        insertedLines,
        state.fenceLines
      );

      const newPos = s + inserted.length;

      const newOp: EditorOperation = {
        startLineIdx,
        removedLines,
        insertedLineCount: insertedLines.length,
        cursorBefore: state.cursorPos,
        selectionStartBefore: state.selectionStart,
        selectionEndBefore: state.selectionEnd,
        cursorAfter: newPos,
        selectionStartAfter: newPos,
        selectionEndAfter: newPos,
        timestamp: Date.now(),
      };

      let newUndoStack = [...state.undoStack];
      // Basic debounce: if typing continuously in the same line without selections
      if (
        newUndoStack.length > 0 &&
        s === e &&
        inserted.length === 1 &&
        inserted !== '\n'
      ) {
        const last = newUndoStack[newUndoStack.length - 1];
        if (
          Date.now() - last.timestamp < 500 &&
          last.startLineIdx === startLineIdx &&
          last.cursorAfter === s &&
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

  // 流式尾部追加快速通道：不进 undo 栈，只计算新增行的 offset 和 codeBlockState
  appendText: (text: string) =>
    set((state) => {
      if (!text) return state;

      const lastLineIdx = state.lines.length - 1;
      const lastLine = state.lines[lastLineIdx];
      const combined = lastLine + text;
      const newSegmentLines = combined.split('\n');

      const newLinesArr = [...state.lines];
      newLinesArr.splice(lastLineIdx, 1, ...newSegmentLines);

      const newOffsets = state.lineOffsets.clone();
      newOffsets.updateLines(lastLineIdx, 1, newSegmentLines.map(l => l.length + 1));

      // codeBlockState：从当前最后一行状态推断，不从头扫描
      const newCodeState = [...state.codeBlockState];
      let inCodeBlock = false;
      let inMathBlock = false;
      // 缩进代码块状态：末行状态为 'indent_code' 时视为块内（块内空行保持）
      let inIndentCode = false;
      const currentState = state.codeBlockState[lastLineIdx];
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
        if (!inMathBlock && trimmed.startsWith('```')) {
          segmentCodeStates[i] = inCodeBlock ? 'fence_end' : 'fence_start';
          inCodeBlock = !inCodeBlock;
          inIndentCode = false;
        } else if (!inCodeBlock && trimmed === '$$') {
          segmentCodeStates[i] = inMathBlock
            ? 'math_fence_end'
            : 'math_fence_start';
          inMathBlock = !inMathBlock;
          inIndentCode = false;
        } else if (inCodeBlock) {
          segmentCodeStates[i] = 'code';
          inIndentCode = false;
        } else if (inMathBlock) {
          segmentCodeStates[i] = 'math_block';
          inIndentCode = false;
        } else {
          // —— 缩进代码块判定（与 updateLinesIncremental 同规则）——
          const indent = leadingIndentColumns(newSegmentLines[i]);
          if (inIndentCode) {
            // 块内：空行与 ≥4 列缩进行保持；非缩进行结束代码块
            if (trimmed === '' || indent >= 4) {
              segmentCodeStates[i] = 'indent_code';
            } else {
              segmentCodeStates[i] = 'none';
              inIndentCode = false;
            }
          } else if (trimmed !== '' && indent >= 4) {
            segmentCodeStates[i] = 'indent_code';
            inIndentCode = true;
          } else {
            segmentCodeStates[i] = 'none';
          }
        }
      }
      newCodeState.splice(lastLineIdx, 1, ...segmentCodeStates);

      // fenceLines：追加新的 fence 行号
      const newFenceLines = [...state.fenceLines];
      for (let i = 0; i < newSegmentLines.length; i++) {
        const st = segmentCodeStates[i];
        if (
          st === 'fence_start' ||
          st === 'fence_end' ||
          st === 'math_fence_start' ||
          st === 'math_fence_end'
        ) {
          newFenceLines.push(lastLineIdx + i);
        }
      }

      const textLength = Math.max(0, newOffsets.getOffset(newOffsets.lineCount - 1) + newSegmentLines[newSegmentLines.length - 1].length);

      // Automatically advance cursor if it was exactly at the end (Requirement 6)
      const wasAtEnd = state.cursorPos === state.textLength && state.selectionStart === state.selectionEnd;

      return {
        lines: newLinesArr,
        lineOffsets: newOffsets,
        codeBlockState: newCodeState,
        textLength,
        fenceLines: newFenceLines,
        cursorPos: wasAtEnd ? textLength : state.cursorPos,
        selectionStart: wasAtEnd ? textLength : state.selectionStart,
        selectionEnd: wasAtEnd ? textLength : state.selectionEnd,
      };
    }),

  deleteText: (backward) =>
    set((state) => {
      let s = state.selectionStart;
      let e = state.selectionEnd;

      if (s === e) {
        const text = state.lines.join('\n');
        if (backward && s > 0) {
          s = findPrevGraphemeBoundary(text, s);
        } else if (!backward && e < state.textLength) {
          e = findNextGraphemeBoundary(text, e);
        } else {
          return state;
        }
      }

      const startLineIdx = state.lineOffsets.findLineIndex(s);
      const endLineIdx = state.lineOffsets.findLineIndex(e);

      const startLineOffset = state.lineOffsets.getOffset(startLineIdx);
      const endLineOffset = state.lineOffsets.getOffset(endLineIdx);

      const prefix = state.lines[startLineIdx].substring(
        0,
        s - startLineOffset
      );
      const suffix = state.lines[endLineIdx].substring(e - endLineOffset);

      const newSegment = prefix + suffix;
      const insertedLines = newSegment.split('\n'); // usually length 1

      const deleteCount = endLineIdx - startLineIdx + 1;
      const removedLines = state.lines.slice(
        startLineIdx,
        startLineIdx + deleteCount
      );

      const res = updateLinesIncremental(
        state.lines,
        state.lineOffsets,
        state.codeBlockState,
        startLineIdx,
        deleteCount,
        insertedLines,
        state.fenceLines
      );

      const newOp: EditorOperation = {
        startLineIdx,
        removedLines,
        insertedLineCount: insertedLines.length,
        cursorBefore: state.cursorPos,
        selectionStartBefore: state.selectionStart,
        selectionEndBefore: state.selectionEnd,
        cursorAfter: s,
        selectionStartAfter: s,
        selectionEndAfter: s,
        timestamp: Date.now(),
      };

      let newUndoStack = [...state.undoStack];
      // 连续单字符删除的合并逻辑（与 insertText 对称）
      if (
        newUndoStack.length > 0 &&
        state.selectionStart === state.selectionEnd // 单字符删除（非选择范围）
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
    set((state) => {
      const s = Math.max(0, Math.min(start, end));
      const e = Math.min(state.textLength, Math.max(start, end));

      if (s === e) return state;

      const startLineIdx = state.lineOffsets.findLineIndex(s);
      const endLineIdx = state.lineOffsets.findLineIndex(e);

      const startLineOffset = state.lineOffsets.getOffset(startLineIdx);
      const endLineOffset = state.lineOffsets.getOffset(endLineIdx);

      const prefix = state.lines[startLineIdx].substring(
        0,
        s - startLineOffset
      );
      const suffix = state.lines[endLineIdx].substring(e - endLineOffset);

      const newSegment = prefix + suffix;
      const insertedLines = newSegment.split('\n'); // usually length 1

      const deleteCount = endLineIdx - startLineIdx + 1;
      const removedLines = state.lines.slice(
        startLineIdx,
        startLineIdx + deleteCount
      );

      const res = updateLinesIncremental(
        state.lines,
        state.lineOffsets,
        state.codeBlockState,
        startLineIdx,
        deleteCount,
        insertedLines,
        state.fenceLines
      );

      const newOp: EditorOperation = {
        startLineIdx,
        removedLines,
        insertedLineCount: insertedLines.length,
        cursorBefore: state.cursorPos,
        selectionStartBefore: state.selectionStart,
        selectionEndBefore: state.selectionEnd,
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
        undoStack: [...state.undoStack, newOp],
        redoStack: [],
      };
    }),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const op = state.undoStack[state.undoStack.length - 1];

      // Reverse splice: remove `insertedLineCount` lines at `startLineIdx` and insert `removedLines`
      const res = updateLinesIncremental(
        state.lines,
        state.lineOffsets,
        state.codeBlockState,
        op.startLineIdx,
        op.insertedLineCount,
        op.removedLines,
        state.fenceLines
      );

      // Forward op to redo stack
      const inverseOp: EditorOperation = {
        startLineIdx: op.startLineIdx,
        removedLines: state.lines.slice(
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
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, inverseOp],
      };
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return state;
      const op = state.redoStack[state.redoStack.length - 1];

      const res = updateLinesIncremental(
        state.lines,
        state.lineOffsets,
        state.codeBlockState,
        op.startLineIdx,
        op.insertedLineCount,
        op.removedLines,
        state.fenceLines
      );

      const inverseOp: EditorOperation = {
        startLineIdx: op.startLineIdx,
        removedLines: state.lines.slice(
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
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, inverseOp],
      };
    }),

  verifyConsistency: () => {
    const { lines, lineOffsets } = get();
    let runningOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lineOffsets.getOffset(i) !== runningOffset) {
        console.error(
          `Offset drift detected at line ${i}! Expected ${runningOffset}, got ${lineOffsets.getOffset(i)}`
        );
        return false;
      }
      runningOffset += lines[i].length + 1; // +1 for newline
    }
    return true;
  },
}));
