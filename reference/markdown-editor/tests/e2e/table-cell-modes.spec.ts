import { test, expect } from '@playwright/test';

test.describe('Table Cell Mode vs Cell Edit Mode Decoupling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);

    const tableMarkdown = `| Product | Price | Qty |
|---|---|---|
| Apple | $3 | 50 |
| Banana | $1 | 120 |
| Orange | $2 | 80 |`;

    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, tableMarkdown);

    await page.waitForSelector('.line-table-row');
  });

  test('1. Single click activates cell selection mode without blinking caret', async ({ page }) => {
    const appleCell = page.locator('.token-table-cell').filter({ hasText: /Apple/ }).first();
    await appleCell.waitFor();
    await appleCell.click();

    // Verify cell selection class is added and editing class is absent
    await expect(appleCell).toHaveClass(/is-cell-selected/);
    await expect(appleCell).not.toHaveClass(/is-cell-editing/);

    // Verify cursor caret is suppressed in cell selection mode
    const caret = page.locator('.cursor-caret');
    await expect(caret).toHaveCount(0);
  });

  test('2. Double click activates cell in-place edit mode with caret visible', async ({ page }) => {
    const appleCell = page.locator('.token-table-cell').filter({ hasText: /Apple/ }).first();
    await appleCell.waitFor();
    await appleCell.dblclick();

    // Verify cell edit class is added
    await expect(appleCell).toHaveClass(/is-cell-editing/);

    // Verify cursor caret is visible in editing mode
    const caret = page.locator('.cursor-caret');
    await expect(caret).toBeVisible();
  });

  test('3. Escape in edit mode exits to cell selection mode, second Escape clears selection', async ({ page }) => {
    const appleCell = page.locator('.token-table-cell').filter({ hasText: /Apple/ }).first();
    await appleCell.waitFor();
    await appleCell.dblclick();
    await expect(appleCell).toHaveClass(/is-cell-editing/);

    // First Escape -> reverts to cell selection mode
    await page.keyboard.press('Escape');
    await expect(appleCell).toHaveClass(/is-cell-selected/);
    await expect(appleCell).not.toHaveClass(/is-cell-editing/);
    await expect(page.locator('.cursor-caret')).toHaveCount(0);

    // Second Escape -> clears selection completely
    await page.keyboard.press('Escape');
    await expect(appleCell).not.toHaveClass(/is-cell-selected/);
  });

  test('4. Tab key navigates to next cell in Selection Mode', async ({ page }) => {
    const appleCell = page.locator('.token-table-cell').filter({ hasText: /Apple/ }).first();
    await appleCell.click();
    await expect(appleCell).toHaveClass(/is-cell-selected/);

    // Press Tab -> Moves to Price cell ($3)
    await page.keyboard.press('Tab');
    const priceCell = page.locator('.token-table-cell').filter({ hasText: /\$3/ }).first();
    await expect(priceCell).toHaveClass(/is-cell-selected/);
    await expect(priceCell).not.toHaveClass(/is-cell-editing/);
    await expect(appleCell).not.toHaveClass(/is-cell-selected/);
  });

  test('5. Typing character in Selection Mode replaces content and enters Edit Mode', async ({ page }) => {
    const appleCell = page.locator('.token-table-cell').filter({ hasText: /Apple/ }).first();
    await appleCell.click();
    await expect(appleCell).toHaveClass(/is-cell-selected/);

    // Type "K"
    await page.keyboard.type('K');
    await page.waitForTimeout(150);

    // The cell content should now have "K" and be in edit mode
    const kiwiCell = page.locator('.token-table-cell').filter({ hasText: /K/ }).first();
    await expect(kiwiCell).toHaveClass(/is-cell-editing/);
  });
});
