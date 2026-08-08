import { LineOffsetTree } from '../../src/core/SegmentTree';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('Devil Cross-Test Matrix', () => {
    beforeEach(() => {
        useEditorStore.setState({
            lines: [''],
            lineOffsets: new LineOffsetTree([0]),
            codeBlockState: [],
            textLength: 0,
            cursorPos: 0,
            selectionStart: 0,
            selectionEnd: 0,
            undoStack: [],
            redoStack: []
        });
    });

    it('Cross Test 1: Multi-line Insert -> Selection Delete -> Undo -> Redo', () => {
        const store = useEditorStore.getState();
        
        // 1. Initial Insert
        store.insertText('Line 1\nLine 2\nLine 3');
        expect(useEditorStore.getState().getText()).toBe('Line 1\nLine 2\nLine 3');
        
        // 2. Select across lines
        // "Line 1" (6) + "\n" (1) + "Line 2" (6) + "\n" (1) + "Line 3" (6)
        // Select from "1" in Line 1 (pos 5) to "3" in Line 3 (pos 19)
        useEditorStore.getState().setSelection(5, 19);
        
        // 3. Delete Selection
        useEditorStore.getState().deleteSelection(5, 19);
        expect(useEditorStore.getState().getText()).toBe('Line 3');
        
        // 4. Undo
        useEditorStore.getState().undo();
        // Should perfectly restore
        expect(useEditorStore.getState().getText()).toBe('Line 1\nLine 2\nLine 3');
        
        // 5. Redo
        useEditorStore.getState().redo();
        expect(useEditorStore.getState().getText()).toBe('Line 3');
    });

    it('Cross Test 2: Multi-line Insert -> Selection Overwrite Paste -> Undo', () => {
        const store = useEditorStore.getState();
        store.insertText('Hello World\nHow are you?');
        
        // Select "World\nHow" (pos 6 to 15)
        useEditorStore.getState().setSelection(6, 15);
        
        // Paste over it
        useEditorStore.getState().insertText('Devilish\nPaste');
        
        expect(useEditorStore.getState().getText()).toBe('Hello Devilish\nPaste are you?');
        
        // Undo
        useEditorStore.getState().undo();
        
        expect(useEditorStore.getState().getText()).toBe('Hello World\nHow are you?');
    });

    it('Cross Test 3: Selection Directionality & Restoration on Undo', () => {
        const store = useEditorStore.getState();
        store.insertText('1234567890');
        
        // Set selection
        useEditorStore.getState().setSelection(2, 8);
        expect(useEditorStore.getState().selectionStart).toBe(2);
        expect(useEditorStore.getState().selectionEnd).toBe(8);
        
        // Delete
        useEditorStore.getState().deleteText(true); // Backspace
        expect(useEditorStore.getState().getText()).toBe('1290');
        
        // Undo
        useEditorStore.getState().undo();
        expect(useEditorStore.getState().getText()).toBe('1234567890');
        
        // DEVILISH: Did the undo restore the exact selection range so the user can re-delete?
        // In most editors, Undo restores the highlighted state!
        expect(useEditorStore.getState().selectionStart).toBe(2);
        expect(useEditorStore.getState().selectionEnd).toBe(8);
    });
});
