import { test, expect } from '@playwright/test';

test.describe('Excel-like Table Matrix Testing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
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
    await expect(cells).toHaveCount(8); // 2 header + 2 separator + 4 data cells

    // Verify cell contents
    const text1 = await cells.nth(0).innerText();
    expect(text1.trim()).toBe('Col1');
    const text2 = await cells.nth(1).innerText();
    expect(text2.trim()).toBe('Col2');
  });

  test('cell selection and 2-click editing mode', async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as any).__CRISH_SESSION_STORE__.getState();
      store.setText('| Col1 | Col2 |\n|---|---|\n| A | B |\n| C | D |');
    });

    await page.waitForSelector('.line-table-row');
    const cellA = page.locator('.token-table-cell').filter({ hasText: /^\s*A\s*$/ });
    await cellA.waitFor();

    // 1-click: Select cell
    await cellA.click();
    await expect(cellA).toHaveClass(/is-cell-selected/);

    // 2-click: Edit cell
    await cellA.dblclick();
    await expect(cellA).toHaveClass(/is-cell-editing/);
  });

  test('tab navigation inside table', async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as any).__CRISH_SESSION_STORE__.getState();
      store.setText('| Col1 | Col2 |\n|---|---|\n| A | B |\n| C | D |');
    });

    await page.waitForSelector('.line-table-row');
    const cellA = page.locator('.token-table-cell').filter({ hasText: /^\s*A\s*$/ });
    await cellA.waitFor();
    await cellA.click();

    // Simulate Tab keypress
    await page.keyboard.press('Tab');

    // Cell B should be selected
    const cellB = page.locator('.token-table-cell').filter({ hasText: /^\s*B\s*$/ });
    await expect(cellB).toHaveClass(/is-cell-selected/);
  });
});
