import { test, expect } from '@playwright/test';

test.describe('Editor Bug Reproduction Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
  });

  test('Issue 1: Cannot delete natively selected text', async ({ page }) => {
    // 1. Double click to select a word (e.g. "高性能")
    // 1. Manually select the text "高性能" to avoid double-click center aiming at empty spaces
    const titleElement = page.locator('.editor-container').filter({ hasText: '高性能' }).first();
    await titleElement.waitFor();
    await page.evaluate(() => {
        const el = document.querySelector('.editor-container');
        if (el) {
            // Find the span containing "高性能"
            const spans = Array.from(el.querySelectorAll('span'));
            const targetSpan = spans.find(s => s.textContent?.includes('高性能'));
            if (targetSpan && targetSpan.firstChild) {
                const range = document.createRange();
                range.setStart(targetSpan.firstChild, 0);
                range.setEnd(targetSpan.firstChild, 3); // "高性能" is 3 chars
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
            }
        }
    });

    // 2. Verify that there is a native text selection in the browser
    const selectionText = await page.evaluate(() => window.getSelection()?.toString());
    console.log(`Native selection text: "${selectionText}"`);
    expect(selectionText?.trim()).toBe('高性能');

    // 3. Press Backspace
    await page.keyboard.press('Backspace');

    // Wait a moment for any potential state updates
    await page.waitForTimeout(100);

    // 4. Check if the text was actually deleted from the EditorStore
    // We can evaluate the text from the DOM to see if "高性能" is still there
    const editorElement = page.locator('.editor-container').first();
    const titleTextAfter = await editorElement.textContent();
    console.log(`Title text after Backspace: "${titleTextAfter}"`);

    // The bug is fixed, so the selected text should NOT be there.
    expect(titleTextAfter).not.toContain(selectionText?.trim());
  });

  test('Issue 2: Nested styles escape parsing (Regex limitation)', async ({ page }) => {
    // Find the text block containing our extreme nested combinations
    const testBlock = page.locator('.line-block').filter({ hasText: '加粗内的' }).first();
    await expect(testBlock).toBeVisible();

    const fullText = await testBlock.textContent();
    console.log(`\nRaw DOM text content of the nested styles line:\n${fullText}`);

    // If it was parsed correctly, the AST would generate elements with class "style-bold" etc.
    // Let's check if there is ANY bold styling applied to the nested bold text
    const boldNodes = testBlock.locator('.style-bold');
    const boldCount = await boldNodes.count();
    
    console.log(`Number of parsed bold nodes in this line: ${boldCount}`);

    // The bug is fixed, so nested styling works properly now.
    expect(boldCount).toBeGreaterThan(0);
  });
});
