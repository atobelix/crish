import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('Undo/Redo Model', () => {
    beforeEach(() => {
        useEditorStore.getState().setText('');
    });

    it('records and undoes basic typing', () => {
        const store = useEditorStore.getState();
        store.insertText('hello');
        expect(useEditorStore.getState().getText()).toBe('hello');
        expect(useEditorStore.getState().undoStack.length).toBe(1);

        useEditorStore.getState().undo();
        expect(useEditorStore.getState().getText()).toBe('');
        expect(useEditorStore.getState().redoStack.length).toBe(1);

        useEditorStore.getState().redo();
        expect(useEditorStore.getState().getText()).toBe('hello');
    });

    it('merges rapid consecutive typing', async () => {
        const store = useEditorStore.getState();
        store.insertText('a');
        store.insertText('b');
        store.insertText('c');
        
        const state = useEditorStore.getState();
        expect(state.getText()).toBe('abc');
        // Because they were typed rapidly without cursor jumps, they should merge into 1 operation
        expect(state.undoStack.length).toBe(1);

        state.undo();
        expect(useEditorStore.getState().getText()).toBe('');
    });

    it('records multiline deletions', () => {
        const store = useEditorStore.getState();
        store.setText('line1\nline2\nline3');
        store.setSelection(2, 14); // Select "ne1\nline2\nli"
        store.deleteSelection(2, 14);
        
        expect(useEditorStore.getState().getText()).toBe('line3');
        expect(useEditorStore.getState().undoStack.length).toBe(1);

        useEditorStore.getState().undo();
        expect(useEditorStore.getState().getText()).toBe('line1\nline2\nline3');
        
        useEditorStore.getState().redo();
        expect(useEditorStore.getState().getText()).toBe('line3');
    });

    it('clears redo stack upon new edits', () => {
        const store = useEditorStore.getState();
        store.insertText('hello');
        store.undo();
        expect(useEditorStore.getState().redoStack.length).toBe(1);
        
        useEditorStore.getState().insertText('world');
        expect(useEditorStore.getState().redoStack.length).toBe(0);
    });
});
