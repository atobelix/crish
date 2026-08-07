import { describe, it, expect } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';

describe('Big File Async Loading', () => {
    it('loads large files in chunks', async () => {
        const store = useEditorStore.getState();
        const lines = Array(5000).fill('line');
        const text = lines.join('\n');
        
        store.setText(text);
        
        // Immediately after setText, we should have 1000 lines loaded
        expect(useEditorStore.getState().lines.length).toBe(1000);
        
        // Wait for the async chunks to process
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Assuming chunks of 2000, 200ms should be enough to hit 5000 lines
        expect(useEditorStore.getState().lines.length).toBe(5000);
        expect(useEditorStore.getState().lines[4999]).toBe('line');
    });
});
