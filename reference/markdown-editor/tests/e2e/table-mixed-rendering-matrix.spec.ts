import { test, expect } from '@playwright/test';

test.describe('Table Mixed Rendering & Keyboard Matrix Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
  });

  test('renders rich mixed formatting within table cells (bold, code, math, italic)', async ({ page }) => {
    const tableMarkdown = `| Syntax | Formatted Output | Note |
|---|---|---|
| Bold | **Strong Text** | Rendered bold |
| Code | \`inline_func()\` | Monospace snippet |
| Math | $x^2 + y^2 = z^2$ | KaTeX formula |
| Combined | **\`code_bold\`** | Mixed inline |`;

    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, tableMarkdown);

    await page.waitForSelector('.line-table-row');

    // 1. Verify Bold token rendered in table cell
    const boldEl = page.locator('.token-table-cell .style-bold').first();
    await expect(boldEl).toBeVisible();
    expect(await boldEl.innerText()).toContain('Strong Text');

    // 2. Verify Code token rendered in table cell
    const codeEl = page.locator('.token-table-cell .style-inline-code').first();
    await expect(codeEl).toBeVisible();
    expect(await codeEl.innerText()).toContain('inline_func()');

    // 3. Verify Math KaTeX token rendered in table cell
    const mathEl = page.locator('.token-table-cell .katex').first();
    await expect(mathEl).toBeVisible();
  });

  test('cell selection vs 2-click edit state machine across table rows', async ({ page }) => {
    const tableMarkdown = `| Col A | Col B |
|---|---|
| Alpha | Beta |
| Gamma | Delta |`;

    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, tableMarkdown);

    await page.waitForSelector('.line-table-row');

    const cellAlpha = page.locator('.token-table-cell').filter({ hasText: /^\s*Alpha\s*$/ });
    await cellAlpha.waitFor();

    // 1-Click: Cell selection mode (not editing)
    await cellAlpha.click();
    await expect(cellAlpha).toHaveClass(/is-cell-selected/);
    await expect(cellAlpha).not.toHaveClass(/is-cell-editing/);

    // Double-Click: Cell editing mode
    await cellAlpha.dblclick();
    await expect(cellAlpha).toHaveClass(/is-cell-editing/);

    // Press Escape to exit editing back to non-editing
    await page.keyboard.press('Escape');
    await expect(cellAlpha).not.toHaveClass(/is-cell-editing/);
  });

  test('navigates seamlessly across cells using Tab and Shift+Tab', async ({ page }) => {
    const tableMarkdown = `| Item 1 | Item 2 | Item 3 |
|---|---|---|
| R1C1 | R1C2 | R1C3 |
| R2C1 | R2C2 | R2C3 |`;

    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, tableMarkdown);

    await page.waitForSelector('.line-table-row');

    const c11 = page.locator('.token-table-cell').filter({ hasText: /^\s*R1C1\s*$/ });
    await c11.waitFor();
    await c11.click();
    await expect(c11).toHaveClass(/is-cell-selected/);

    // Tab -> R1C2
    await page.keyboard.press('Tab');
    const c12 = page.locator('.token-table-cell').filter({ hasText: /^\s*R1C2\s*$/ });
    await expect(c12).toHaveClass(/is-cell-selected/);

    // Tab -> R1C3
    await page.keyboard.press('Tab');
    const c13 = page.locator('.token-table-cell').filter({ hasText: /^\s*R1C3\s*$/ });
    await expect(c13).toHaveClass(/is-cell-selected/);

    // Tab -> Wrap to R2C1
    await page.keyboard.press('Tab');
    const c21 = page.locator('.token-table-cell').filter({ hasText: /^\s*R2C1\s*$/ });
    await expect(c21).toHaveClass(/is-cell-selected/);

    // Shift+Tab -> Back to R1C3
    await page.keyboard.press('Shift+Tab');
    await expect(c13).toHaveClass(/is-cell-selected/);
  });
});
