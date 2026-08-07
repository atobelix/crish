import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('Selection & Clipboard Core Logic', () => {
    beforeEach(() => {
        // Reset the store before each test
        useEditorStore.setState({
            lines: [''],
            lineOffsets: [0],
            codeBlockState: [],
            textLength: 0,
            cursorPos: 0,
            selectionStart: 0,
            selectionEnd: 0,
            undoStack: [],
            redoStack: []
        });
    });

    it('handles basic text insertion and bounds', () => {
        const store = useEditorStore.getState();
        
        // Initial insert
        store.insertText('Hello World');
        
        let state = useEditorStore.getState();
        expect(state.getText()).toBe('Hello World');
        expect(state.cursorPos).toBe(11);
        expect(state.selectionStart).toBe(11);
        expect(state.selectionEnd).toBe(11);
    });

    it('handles selection bounds securely', () => {
        const store = useEditorStore.getState();
        store.insertText('Hello World');
        
        // Select beyond boundaries (negative or > textLength)
        useEditorStore.getState().setSelection(-5, 100);
        
        let state = useEditorStore.getState();
        expect(state.selectionStart).toBe(0); // Clamped
        expect(state.selectionEnd).toBe(11);  // Clamped to textLength
        expect(state.cursorPos).toBe(11);     // Cursor usually moves to the 'end' of the selection drag
    });

    it('handles cross-line selection deletion securely', () => {
        const store = useEditorStore.getState();
        store.insertText('Line 1\nLine 2\nLine 3');
        
        let state = useEditorStore.getState();
        expect(state.lines.length).toBe(3);
        
        // Select from "e 1" (pos 3) to "Li" of line 3 (pos 16)
        // L1: 0..6
        // L2: 7..13
        // L3: 14..20
        useEditorStore.getState().setSelection(3, 16);
        useEditorStore.getState().deleteSelection(3, 16);
        
        state = useEditorStore.getState();
        // Remaining: "Lin" + "ne 3"
        expect(state.getText()).toBe('Linne 3');
        expect(state.lines.length).toBe(1);
    });

    it('inserts text over a selected range', () => {
        const store = useEditorStore.getState();
        store.insertText('Hello World');
        
        useEditorStore.getState().setSelection(0, 5); // Select "Hello"
        useEditorStore.getState().insertText('Goodbye');
        
        let state = useEditorStore.getState();
        expect(state.getText()).toBe('Goodbye World');
        expect(state.cursorPos).toBe(7); // "Goodbye".length
    });
});
