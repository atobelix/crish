import { test, expect } from '@playwright/test';

test.describe('Matrix: Table & Edge Layouts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.locator('.editor-container').click();
  });

  test('M-TAB-01: Render and navigate complex tables', async ({ page }) => {
    // Navigate to the bottom of the document where tables are
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(100); // Wait for virtual list to render bottom items

    const endPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(endPos).toBeGreaterThan(3000);

    // ArrowUp 20 times to enter the table section
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press('ArrowUp');
    }

    // Verify cursor moved up successfully
    const posInTable = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(posInTable).toBeLessThan(endPos);
    expect(posInTable).toBeGreaterThan(endPos - 5000); // Rough estimation for 20 lines of complex tables

    // ArrowLeft and ArrowRight should smoothly cross table boundaries
    const beforeMove = posInTable;
    await page.keyboard.press('ArrowLeft');
    const afterLeft = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(afterLeft).toBeLessThan(beforeMove);

    await page.keyboard.press('ArrowRight');
    const afterRight = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    expect(afterRight).toBe(beforeMove);
  });

  test('M-TAB-02: Shift Selection over nested tables in lists', async ({ page }) => {
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(100); // Wait for virtual list to render bottom items
    
    // Up 5 times to hit "Tables in lists are evil."
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowUp');
    }

    const startPos = await page.evaluate(() => window.__CRISH_SESSION_STORE__.getState().cursorPos);
    
    // Shift + Up 15 times to select across the list and nested table
    await page.keyboard.down('Shift');
    for (let i = 0; i < 15; i++) {
        await page.keyboard.press('ArrowUp');
    }
    await page.keyboard.up('Shift');

    const state = await page.evaluate(() => {
        const s = window.__CRISH_SESSION_STORE__.getState();
        return { start: s.selectionStart, end: s.selectionEnd, cursor: s.cursorPos };
    });

    expect(state.start).not.toBe(state.end);
    expect(state.end).toBe(startPos);
    expect(state.cursor).toBe(state.start); // Cursor should be at the moving edge
  });
});
