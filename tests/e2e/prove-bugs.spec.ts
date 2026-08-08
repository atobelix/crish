import { test, expect } from '@playwright/test';

test.describe('Bug Evidence Tests (Anti-Regression)', () => {

  test('Evidence 1 & 2: Textarea should be visible and not cause IME jumping (width > 1px)', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
    
    // Click to focus
    await page.locator('.editor-container').click();
    
    // Get the textarea
    const textarea = page.locator('textarea');
    
    // Check Evidence 1: Opacity should not be 0
    const opacity = await textarea.evaluate((el) => window.getComputedStyle(el).opacity);
    console.log('EVIDENCE 1 - Current Opacity:', opacity);
    
    // Check Evidence 2: Width should not be 1px
    const width = await textarea.evaluate((el) => window.getComputedStyle(el).width);
    console.log('EVIDENCE 2 - Current Width:', width);
    
    // Simulate typing long pinyin to check for jumping/wrapping
    await textarea.evaluate((el: HTMLTextAreaElement) => {
        el.value = 'pinyin';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    
    const { scrollHeight, clientHeight } = await textarea.evaluate((el: HTMLTextAreaElement) => {
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    console.log('EVIDENCE 2 - ScrollHeight vs ClientHeight:', scrollHeight, clientHeight);
    
    // The test expects these to be fixed (so it will fail currently, which is our evidence!)
    expect(opacity).not.toBe('0');
    expect(width).not.toBe('1px');
    expect(Math.abs(scrollHeight - clientHeight)).toBeLessThan(5); // Shouldn't wrap vertically
  });

  test('Evidence 3: Arrow Up and Down should work', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
    
    // Click to focus
    await page.locator('.editor-container').click();
    
    // Type two lines of text
    await page.keyboard.type('Line 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line 2');
    
    // Get cursor pos before up arrow
    const cursorBefore = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    console.log('EVIDENCE 3 - Cursor before ArrowUp:', cursorBefore);
    
    // Press Arrow Up
    await page.keyboard.press('ArrowUp');
    
    // Get cursor pos after up arrow
    const cursorAfter = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    console.log('EVIDENCE 3 - Cursor after ArrowUp:', cursorAfter);
    
    // The test expects cursor to move (it will fail currently, proving the bug!)
    expect(cursorAfter).toBeLessThan(cursorBefore);
  });
});
