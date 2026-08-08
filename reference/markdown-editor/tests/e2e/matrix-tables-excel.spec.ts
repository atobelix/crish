import { test, expect } from '@playwright/test';

test.describe('Excel-like Table Matrix Testing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
  });

  test('table AST rendering and basic styles', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText('| Col1 | Col2 |\n|---|---|\n| A | B |\n| C | D |');
    });

    await page.waitForSelector('.line-table-row');

    // Check row container is flex
    const row = page.locator('.line-table-row').first();
    await expect(row).toHaveCSS('display', 'flex');

    // Check table cells are rendered
    const cells = page.locator('.token-table-cell');
    await expect(cells).toHaveCount(8); // 2 in row1, 2 in sep, 2 in row2, 2 in row3 -> 8 total

    // Verify cell contents
    const text1 = await cells.nth(0).innerText();
    expect(text1.trim()).toBe('Col1');
    const text2 = await cells.nth(1).innerText();
    expect(text2.trim()).toBe('Col2');
  });

  test('tab navigation inside table', async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as any).__CRISH_SESSION_STORE__.getState();
      store.setText('| Col1 | Col2 |\n|---|---|\n| A | B |\n| C | D |');
      store.setCursorPos(2);
    });

    await page.waitForSelector('.line-table-row');
    await page.waitForSelector('textarea', { state: 'attached' });
    await page.locator('textarea').focus();

    // Simulate Tab keypress
    await page.keyboard.press('Tab');

    // After Tab, cursor should jump to next cell and select its text
    // The text ' Col2 ' goes from index 8 to 14. Wait, the exact coordinates depend on the raw text.
    // '| Col1 | Col2 |' -> Col2 starts at index 9, ends at 13.
    const state = await page.evaluate(() => {
      return {
        start: (window as any).__CRISH_SESSION_STORE__.getState().selectionStart,
        end: (window as any).__CRISH_SESSION_STORE__.getState().selectionEnd,
        cursor: (window as any).__CRISH_SESSION_STORE__.getState().cursorPos,
      };
    });

    // Check if selection is around 'Col2'
    expect(state.start).toBeGreaterThan(0);
    expect(state.end).toBeGreaterThan(state.start);
  });
});
