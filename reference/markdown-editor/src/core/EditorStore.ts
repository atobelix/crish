import { create } from 'zustand';

// Use Intl.Segmenter for grapheme cluster boundaries (surrogate pairs, emojis, combining chars)
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

export function findNextGraphemeBoundary(text: string, pos: number): number {
    if (pos >= text.length) return text.length;
    if (segmenter) {
        // Slice a small window to avoid O(N) iteration over large texts
        const windowStart = Math.max(0, pos - 50);
        const windowEnd = Math.min(text.length, pos + 50);
        const windowText = text.slice(windowStart, windowEnd);
        const segments = segmenter.segment(windowText);
        let currentPos = windowStart;
        for (const segment of segments) {
            currentPos += segment.segment.length;
            if (currentPos > pos) return currentPos;
        }
    }
    // Fallback if Segmenter is not available (e.g. some old browsers)
    const charCode = text.charCodeAt(pos);
    if (charCode >= 0xD800 && charCode <= 0xDBFF && pos + 1 < text.length) {
        return pos + 2; // Surrogate pair
    }
    return pos + 1;
}

export function findPrevGraphemeBoundary(text: string, pos: number): number {
    if (pos <= 0) return 0;
    if (segmenter) {
        // Slice a small window to avoid O(N) iteration over large texts
        const windowStart = Math.max(0, pos - 50);
        const windowEnd = Math.min(text.length, pos + 50);
        const windowText = text.slice(windowStart, windowEnd);
        const segments = segmenter.segment(windowText);
        let currentPos = windowStart;
        let lastBoundary = windowStart;
        for (const segment of segments) {
            currentPos += segment.segment.length;
            if (currentPos >= pos) return lastBoundary;
            lastBoundary = currentPos;
        }
    }
    // Fallback
    const charCode = text.charCodeAt(pos - 1);
    if (charCode >= 0xDC00 && charCode <= 0xDFFF && pos - 2 >= 0) {
        return pos - 2; // Surrogate pair
    }
    return pos - 1;
}

export interface EditorOperation {
    startLineIdx: number;
    removedLines: string[];
    insertedLineCount: number;
    cursorBefore: number;
    cursorAfter: number;
    timestamp: number;
}

export interface EditorState {
    lines: string[];
    lineOffsets: number[];
    codeBlockState: boolean[];
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

function computeStateFrom(
    lines: string[], 
    startIndex: number, 
    startOffset: number, 
    startCodeState: boolean
) {
    const offsets = new Array(lines.length);
    const codeBlockState = new Array(lines.length);
    let currentOffset = startOffset;
    let inCodeBlock = startCodeState;
    
    // Copy prefix unchanged (this is very fast)
    for (let i = 0; i < startIndex; i++) {
        offsets[i] = 0; // We don't modify the prefix array, but we need to return it?
        // Wait, the caller will just splice the array. 
        // Let's just mutate the store arrays directly or return a new delta?
    }
}

// Actually, mutating arrays in Zustand is okay if we copy the array first.
function updateLinesIncremental(
    lines: string[],
    lineOffsets: number[],
    codeBlockState: boolean[],
    startLineIdx: number,
    deleteCount: number,
    newLines: string[]
) {
    const newLinesArr = [...lines];
    newLinesArr.splice(startLineIdx, deleteCount, ...newLines);
    
    const newOffsets = [...lineOffsets];
    const newCodeState = [...codeBlockState];
    
    // We only need to recompute from startLineIdx to the end!
    let currentOffset = startLineIdx > 0 ? newOffsets[startLineIdx - 1] + newLinesArr[startLineIdx - 1].length + 1 : 0;
    let inCodeBlock = startLineIdx > 0 ? newCodeState[startLineIdx - 1] : false;
    // Note: if startLineIdx-1 was ```, is it inCodeBlock? Yes, codeBlockState tracks the state AFTER the line is processed.
    
    // Actually we need to make sure `inCodeBlock` tracking is correct.
    // If line `i-1` starts with ```, its `codeBlockState` is true. The next line `i` will start with `inCodeBlock = true`.
    // Wait, the previous logic:
    /*
    if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        codeBlockState[i] = true; // The ``` line itself is code
    } else {
        codeBlockState[i] = inCodeBlock;
    }
    */
    // If line `i-1` is ```, `inCodeBlock` was toggled. But the stored state doesn't tell us what `inCodeBlock` was BEFORE line `i-1`.
    // To know the incoming state for line `i`, we can just look at `codeBlockState[i-1]` except if line `i-1` was a closing ```.
    // Wait, if line `i-1` was a closing ```, `codeBlockState[i-1]` is true, but `inCodeBlock` for line `i` should be false!
    // So `codeBlockState` is NOT enough to resume! We need to know the incoming state.
    // Let's just track `inCodeBlock` correctly.
    
    // It's much simpler: just look at codeBlockState[startLineIdx - 2]!
    inCodeBlock = false;
    if (startLineIdx > 0) {
        if (startLineIdx - 2 >= 0) {
            inCodeBlock = newCodeState[startLineIdx - 2];
        }
        if (newLinesArr[startLineIdx - 1].trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
        }
    }
    
    newOffsets.splice(startLineIdx, deleteCount, ...new Array(newLines.length).fill(0));
    newCodeState.splice(startLineIdx, deleteCount, ...new Array(newLines.length).fill(false));
    
    for (let i = startLineIdx; i < newLinesArr.length; i++) {
        newOffsets[i] = currentOffset;
        if (newLinesArr[i].trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            newCodeState[i] = true;
        } else {
            newCodeState[i] = inCodeBlock;
        }
        currentOffset += newLinesArr[i].length + 1;
    }
    
    return {
        lines: newLinesArr,
        lineOffsets: newOffsets,
        codeBlockState: newCodeState,
        textLength: Math.max(0, currentOffset - 1)
    };
}

export const useEditorStore = create<EditorState>((set, get) => ({
    lines: [''],
    lineOffsets: [0],
    codeBlockState: [false],
    textLength: 0,
    
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,

    undoStack: [],
    redoStack: [],

    getText: () => get().lines.join('\n'),
    getLineIndex: (pos) => binarySearchLineIndex(get().lineOffsets, pos),

    setText: (text) => set((state) => {
        const lines = text.split('\n');
        
        if (lines.length <= 1000) {
            const res = updateLinesIncremental([], [], [], 0, 0, lines);
            return { 
                ...res,
                cursorPos: 0,
                selectionStart: 0,
                selectionEnd: 0,
                undoStack: [],
                redoStack: []
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
                const updated = updateLinesIncremental(s.lines, s.lineOffsets, s.codeBlockState, s.lines.length, 0, chunk);
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
            redoStack: []
        };
    }),
    
    setCursorPos: (pos) => set((state) => {
        const bounded = Math.max(0, Math.min(pos, state.textLength));
        return { cursorPos: bounded, selectionStart: bounded, selectionEnd: bounded };
    }),

    setSelection: (start, end) => set((state) => {
        const min = Math.max(0, Math.min(start, state.textLength));
        const max = Math.max(0, Math.min(end, state.textLength));
        return { selectionStart: Math.min(min, max), selectionEnd: Math.max(min, max), cursorPos: max };
    }),

    insertText: (inserted) => set((state) => {
        const s = state.selectionStart;
        const e = state.selectionEnd;
        
        const startLineIdx = binarySearchLineIndex(state.lineOffsets, s);
        const endLineIdx = binarySearchLineIndex(state.lineOffsets, e);
        
        const startLineOffset = state.lineOffsets[startLineIdx];
        const endLineOffset = state.lineOffsets[endLineIdx];
        
        const prefix = state.lines[startLineIdx].substring(0, s - startLineOffset);
        const suffix = state.lines[endLineIdx].substring(e - endLineOffset);
        
        const newSegment = prefix + inserted + suffix;
        const insertedLines = newSegment.split('\n');
        
        const deleteCount = endLineIdx - startLineIdx + 1;
        const removedLines = state.lines.slice(startLineIdx, startLineIdx + deleteCount);

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
            cursorAfter: newPos,
            timestamp: Date.now()
        };
        
        let newUndoStack = [...state.undoStack];
        // Basic debounce: if typing continuously in the same line without selections
        if (newUndoStack.length > 0 && s === e && inserted.length === 1 && inserted !== '\n') {
            const last = newUndoStack[newUndoStack.length - 1];
            if (Date.now() - last.timestamp < 500 && last.startLineIdx === startLineIdx && last.cursorAfter === s && last.insertedLineCount === 1) {
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
            redoStack: []
        };
    }),

    deleteText: (backward) => set((state) => {
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
        
        const prefix = state.lines[startLineIdx].substring(0, s - startLineOffset);
        const suffix = state.lines[endLineIdx].substring(e - endLineOffset);
        
        const newSegment = prefix + suffix;
        const insertedLines = newSegment.split('\n'); // usually length 1
        
        const deleteCount = endLineIdx - startLineIdx + 1;
        const removedLines = state.lines.slice(startLineIdx, startLineIdx + deleteCount);
        
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
            cursorAfter: s,
            timestamp: Date.now()
        };
        
        let newUndoStack = [...state.undoStack];
        // Basic debounce for deletes:
        if (newUndoStack.length > 0 && state.selectionStart === state.selectionEnd) {
            const last = newUndoStack[newUndoStack.length - 1];
            if (Date.now() - last.timestamp < 500 && last.cursorAfter === (backward ? s + 1 : s) && last.startLineIdx === startLineIdx) {
                // Merge delete
                last.removedLines = [last.removedLines[0].substring(0, s - startLineOffset) + (backward ? removedLines[0].charAt(removedLines[0].length-1) : removedLines[0].charAt(0)) + last.removedLines[0].substring(s - startLineOffset)];
                // Wait, merging deletes accurately is complex and can be buggy if multi-line is involved. 
                // Let's keep it simple: don't merge deletes for now unless we are very careful, 
                // or just append as a new operation to be safe. It's O(1) space anyway per stroke.
                newUndoStack.push(newOp);
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
            redoStack: []
        };
    }),

    deleteSelection: (start, end) => set((state) => {
        const s = Math.max(0, Math.min(start, end));
        const e = Math.min(state.textLength, Math.max(start, end));
        
        if (s === e) return state;
        
        const startLineIdx = binarySearchLineIndex(state.lineOffsets, s);
        const endLineIdx = binarySearchLineIndex(state.lineOffsets, e);
        
        const startLineOffset = state.lineOffsets[startLineIdx];
        const endLineOffset = state.lineOffsets[endLineIdx];
        
        const prefix = state.lines[startLineIdx].substring(0, s - startLineOffset);
        const suffix = state.lines[endLineIdx].substring(e - endLineOffset);
        
        const newSegment = prefix + suffix;
        const insertedLines = newSegment.split('\n'); // usually length 1
        
        const deleteCount = endLineIdx - startLineIdx + 1;
        const removedLines = state.lines.slice(startLineIdx, startLineIdx + deleteCount);

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
            cursorAfter: s,
            timestamp: Date.now()
        };

        return {
            ...res,
            cursorPos: s,
            selectionStart: s,
            selectionEnd: s,
            undoStack: [...state.undoStack, newOp],
            redoStack: []
        };
    }),

    undo: () => set((state) => {
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
            removedLines: state.lines.slice(op.startLineIdx, op.startLineIdx + op.insertedLineCount),
            insertedLineCount: op.removedLines.length,
            cursorBefore: op.cursorAfter,
            cursorAfter: op.cursorBefore,
            timestamp: Date.now()
        };

        return {
            ...res,
            cursorPos: op.cursorBefore,
            selectionStart: op.cursorBefore,
            selectionEnd: op.cursorBefore,
            undoStack: state.undoStack.slice(0, -1),
            redoStack: [...state.redoStack, inverseOp]
        };
    }),

    redo: () => set((state) => {
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
            removedLines: state.lines.slice(op.startLineIdx, op.startLineIdx + op.insertedLineCount),
            insertedLineCount: op.removedLines.length,
            cursorBefore: op.cursorAfter,
            cursorAfter: op.cursorBefore,
            timestamp: Date.now()
        };

        return {
            ...res,
            cursorPos: op.cursorBefore,
            selectionStart: op.cursorBefore,
            selectionEnd: op.cursorBefore,
            redoStack: state.redoStack.slice(0, -1),
            undoStack: [...state.undoStack, inverseOp]
        };
    }),
    
    verifyConsistency: () => {
        const { lines, lineOffsets } = get();
        let runningOffset = 0;
        let isConsistent = true;
        for (let i = 0; i < lines.length; i++) {
            if (lineOffsets[i] !== runningOffset) {
                console.error(`Offset drift detected at line ${i}! Expected ${runningOffset}, got ${lineOffsets[i]}`);
                isConsistent = false;
                break;
            }
            runningOffset += lines[i].length + 1; // +1 for newline
        }
        return isConsistent;
    }
}));
