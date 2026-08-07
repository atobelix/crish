import { create } from 'zustand';
import { type CodeState } from './parser';

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
  lineOffsets: number[];
  codeBlockState: CodeState[];
  textLength: number;

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
  deleteText: (backward: boolean) => void;
  deleteSelection: (start: number, end: number) => void;

  undo: () => void;
  redo: () => void;
}

function binarySearchLineIndex(offsets: number[], pos: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] === pos) return mid;
    if (offsets[mid] < pos) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

// Actually, mutating arrays in Zustand is okay if we copy the array first.
function updateLinesIncremental(
  lines: string[],
  lineOffsets: number[],
  codeBlockState: CodeState[],
  startLineIdx: number,
  deleteCount: number,
  newLines: string[]
) {
  const newLinesArr = [...lines];
  newLinesArr.splice(startLineIdx, deleteCount, ...newLines);

  const newOffsets = [...lineOffsets];
  const newCodeState = [...codeBlockState];

  let currentOffset =
    startLineIdx > 0
      ? newOffsets[startLineIdx - 1] + newLinesArr[startLineIdx - 1].length + 1
      : 0;

  let inCodeBlock = false;
  let inMathBlock = false;
  for (let i = 0; i < startLineIdx; i++) {
    const trimmed = newLinesArr[i].trim();
    if (!inMathBlock && trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    } else if (!inCodeBlock && trimmed === '$$') {
      inMathBlock = !inMathBlock;
    }
  }

  newOffsets.splice(
    startLineIdx,
    deleteCount,
    ...new Array(newLines.length).fill(0)
  );
  newCodeState.splice(
    startLineIdx,
    deleteCount,
    ...new Array<CodeState>(newLines.length).fill('none')
  );

  for (let i = startLineIdx; i < newLinesArr.length; i++) {
    newOffsets[i] = currentOffset;
    const trimmed = newLinesArr[i].trim();

    if (!inMathBlock && trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        newCodeState[i] = 'fence_start';
        inCodeBlock = true;
      } else {
        newCodeState[i] = 'fence_end';
        inCodeBlock = false;
      }
    } else if (!inCodeBlock && trimmed === '$$') {
      if (!inMathBlock) {
        newCodeState[i] = 'math_fence_start';
        inMathBlock = true;
      } else {
        newCodeState[i] = 'math_fence_end';
        inMathBlock = false;
      }
    } else {
      if (inCodeBlock) {
        newCodeState[i] = 'code';
      } else if (inMathBlock) {
        newCodeState[i] = 'math_block';
      } else {
        newCodeState[i] = 'none';
      }
    }
    currentOffset += newLinesArr[i].length + 1;
  }

  return {
    lines: newLinesArr,
    lineOffsets: newOffsets,
    codeBlockState: newCodeState,
    textLength: Math.max(0, currentOffset - 1),
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  lines: [''],
  lineOffsets: [0],
  codeBlockState: ['none'],
  textLength: 0,

  cursorPos: 0,
  selectionStart: 0,
  selectionEnd: 0,

  undoStack: [],
  redoStack: [],

  getText: () => get().lines.join('\n'),
  getLineIndex: (pos) => binarySearchLineIndex(get().lineOffsets, pos),

  setText: (text) =>
    set(() => {
      const lines = text.split('\n');

      if (lines.length <= 1000) {
        const res = updateLinesIncremental([], [], [], 0, 0, lines);
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
      const res = updateLinesIncremental([], [], [], 0, 0, firstChunk);

      let currentIdx = 1000;
      const chunkSize = 2000;

      const processNextChunk = () => {
        if (currentIdx >= lines.length) return;
        const endIdx = Math.min(currentIdx + chunkSize, lines.length);
        const chunk = lines.slice(currentIdx, endIdx);

        useEditorStore.setState((s) => {
          const updated = updateLinesIncremental(
            s.lines,
            s.lineOffsets,
            s.codeBlockState,
            s.lines.length,
            0,
            chunk
          );
          return { ...updated };
        });

        currentIdx = endIdx;
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
    }),

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
        cursorPos: max,
      };
    }),

  insertText: (inserted) =>
    set((state) => {
      const s = state.selectionStart;
      const e = state.selectionEnd;

      const startLineIdx = binarySearchLineIndex(state.lineOffsets, s);
      const endLineIdx = binarySearchLineIndex(state.lineOffsets, e);

      const startLineOffset = state.lineOffsets[startLineIdx];
      const endLineOffset = state.lineOffsets[endLineIdx];

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
        insertedLines
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

      const startLineIdx = binarySearchLineIndex(state.lineOffsets, s);
      const endLineIdx = binarySearchLineIndex(state.lineOffsets, e);

      const startLineOffset = state.lineOffsets[startLineIdx];
      const endLineOffset = state.lineOffsets[endLineIdx];

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
        insertedLines
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
      newUndoStack.push(newOp);

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

      const startLineIdx = binarySearchLineIndex(state.lineOffsets, s);
      const endLineIdx = binarySearchLineIndex(state.lineOffsets, e);

      const startLineOffset = state.lineOffsets[startLineIdx];
      const endLineOffset = state.lineOffsets[endLineIdx];

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
        insertedLines
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
        op.removedLines
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
        op.removedLines
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
    let isConsistent = true;
    for (let i = 0; i < lines.length; i++) {
      if (lineOffsets[i] !== runningOffset) {
        console.error(
          `Offset drift detected at line ${i}! Expected ${runningOffset}, got ${lineOffsets[i]}`
        );
        isConsistent = false;
        break;
      }
      runningOffset += lines[i].length + 1; // +1 for newline
    }
    return isConsistent;
  },
}));
