import { create } from 'zustand';

export interface EditorState {
    lines: string[];
    lineOffsets: number[];
    codeBlockState: boolean[];
    textLength: number;
    
    cursorPos: number;
    selectionStart: number;
    selectionEnd: number;
    
    getText: () => string;
    getLineIndex: (pos: number) => number;

    initText: (initialText: string) => void;
    updateLinesIncremental: (startLineIdx: number, newLines: string[], removedLinesCount: number) => void;
    verifyConsistency: () => boolean;

    setText: (text: string) => void;
    setCursorPos: (pos: number) => void;
    setSelection: (start: number, end: number) => void;
    insertText: (inserted: string) => void;
    deleteText: (backward: boolean) => void;
    deleteSelection: (start: number, end: number) => void;
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

    getText: () => get().lines.join('\n'),
    getLineIndex: (pos) => binarySearchLineIndex(get().lineOffsets, pos),

    setText: (text) => set((state) => {
        const lines = text.split('\n');
        const res = updateLinesIncremental([], [], [], 0, 0, lines);
        return { 
            ...res,
            cursorPos: 0,
            selectionStart: 0,
            selectionEnd: 0
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
        
        const res = updateLinesIncremental(
            state.lines,
            state.lineOffsets,
            state.codeBlockState,
            startLineIdx,
            endLineIdx - startLineIdx + 1,
            insertedLines
        );

        const newPos = s + inserted.length;

        return {
            ...res,
            cursorPos: newPos,
            selectionStart: newPos,
            selectionEnd: newPos
        };
    }),

    deleteText: (backward) => set((state) => {
        let s = state.selectionStart;
        let e = state.selectionEnd;
        
        if (s === e) {
            if (backward && s > 0) {
                s = s - 1;
            } else if (!backward && e < state.textLength) {
                e = e + 1;
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
        
        const res = updateLinesIncremental(
            state.lines,
            state.lineOffsets,
            state.codeBlockState,
            startLineIdx,
            endLineIdx - startLineIdx + 1,
            insertedLines
        );

        return {
            ...res,
            cursorPos: s,
            selectionStart: s,
            selectionEnd: s
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
        const insertedLines = newSegment.split('\n');
        
        const res = updateLinesIncremental(
            state.lines,
            state.lineOffsets,
            state.codeBlockState,
            startLineIdx,
            endLineIdx - startLineIdx + 1,
            insertedLines
        );

        return {
            ...res,
            cursorPos: s,
            selectionStart: s,
            selectionEnd: s
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
