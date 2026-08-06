import { test, expect } from '@playwright/test';

test.describe('IME Composition', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:5173/');
        await page.waitForSelector('.editor-container');
    });

    test('should prevent character insertion during IME composition', async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.useEditorStore.getState().setText('');
            // @ts-ignore
            window.useEditorStore.getState().setCursorPos(0); 
        });
        await page.locator('.editor-container').click({ force: true });

        const textarea = page.locator('textarea');
        await textarea.evaluate((node) => {
            if (node instanceof HTMLTextAreaElement) node.focus();
        });
        // Simulate typing "nihao" with IME
        await textarea.evaluate((node) => {
            node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
            node.value = 'n';
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.value = 'ni';
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.value = 'nih';
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.value = 'niha';
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.value = 'nihao';
            node.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // The store text should be empty because it's composing!
        let text = await page.evaluate(() => {
            // @ts-ignore
            return window.useEditorStore.getState().text;
        });
        expect(text).toBe('');

        // End composition
        await textarea.evaluate((node) => {
            node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
            // React onChange is synchronous, the value will be picked up from compositionend
        });

        text = await page.evaluate(() => {
            // @ts-ignore
            return window.useEditorStore.getState().text;
        });
        expect(text).toBe('你好');
    });
});
