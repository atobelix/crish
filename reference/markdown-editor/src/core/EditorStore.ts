import { create } from 'zustand';

export interface EditorState {
    text: string;
    cursorPos: number; // 绝对文本索引
    selectionStart: number;
    selectionEnd: number;
    
    // Actions
    setText: (text: string) => void;
    setCursorPos: (pos: number) => void;
    setSelection: (start: number, end: number) => void;
    insertText: (inserted: string) => void;
    deleteText: (backward: boolean) => void;
    deleteSelection: (start: number, end: number) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
    text: '',
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,

    setText: (text) => set({ text }),
    
    setCursorPos: (pos) => set((state) => {
        const bounded = Math.max(0, Math.min(pos, state.text.length));
        return { cursorPos: bounded, selectionStart: bounded, selectionEnd: bounded };
    }),

    setSelection: (start, end) => set((state) => {
        const min = Math.max(0, Math.min(start, state.text.length));
        const max = Math.max(0, Math.min(end, state.text.length));
        return { selectionStart: Math.min(min, max), selectionEnd: Math.max(min, max), cursorPos: max };
    }),

    insertText: (inserted) => set((state) => {
        const { text, selectionStart, selectionEnd } = state;
        const before = text.substring(0, selectionStart);
        const after = text.substring(selectionEnd);
        const newText = before + inserted + after;
        const newPos = selectionStart + inserted.length;
        
        return {
            text: newText,
            cursorPos: newPos,
            selectionStart: newPos,
            selectionEnd: newPos
        };
    }),

    deleteText: (backward) => set((state) => {
        const { text, selectionStart, selectionEnd } = state;
        if (selectionStart !== selectionEnd) {
            // Delete selection
            const before = text.substring(0, selectionStart);
            const after = text.substring(selectionEnd);
            return {
                text: before + after,
                cursorPos: selectionStart,
                selectionStart: selectionStart,
                selectionEnd: selectionStart
            };
        }
        
        if (backward) {
            // Backspace
            if (selectionStart > 0) {
                const before = text.substring(0, selectionStart - 1);
                const after = text.substring(selectionStart);
                return {
                    text: before + after,
                    cursorPos: selectionStart - 1,
                    selectionStart: selectionStart - 1,
                    selectionEnd: selectionStart - 1
                };
            }
        } else {
            // Delete
            if (selectionStart < text.length) {
                const before = text.substring(0, selectionStart);
                const after = text.substring(selectionStart + 1);
                return {
                    text: before + after
                };
            }
        }
        return state;
    }),

    deleteSelection: (start, end) => set((state) => {
        const { text } = state;
        const s = Math.max(0, Math.min(start, end));
        const e = Math.min(text.length, Math.max(start, end));
        
        if (s === e) return state;
        
        const before = text.substring(0, s);
        const after = text.substring(e);
        return {
            text: before + after,
            cursorPos: s,
            selectionStart: s,
            selectionEnd: s
        };
    })
}));
