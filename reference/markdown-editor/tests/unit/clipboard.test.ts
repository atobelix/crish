import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('Clipboard (Paste) Logic', () => {
    beforeEach(() => {
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

    it('pastes multi-line text cleanly', () => {
        const store = useEditorStore.getState();
        store.insertText('Line 1');
        store.insertText('\nLine 2\nLine 3');
        
        let state = useEditorStore.getState();
        expect(state.lines).toEqual(['Line 1', 'Line 2', 'Line 3']);
        expect(state.lineOffsets.length).toBe(3);
    });

    it('pastes multi-line text over a selection', () => {
        const store = useEditorStore.getState();
        store.insertText('Hello World');
        
        // Select "World"
        useEditorStore.getState().setSelection(6, 11);
        
        // Paste multi-line
        useEditorStore.getState().insertText('Multi\nLine\nPaste');
        
        let state = useEditorStore.getState();
        expect(state.getText()).toBe('Hello Multi\nLine\nPaste');
        expect(state.lines).toEqual(['Hello Multi', 'Line', 'Paste']);
    });
});
