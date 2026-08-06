import { test, expect } from '@playwright/test';

test.describe('Active Token Effect Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
  });

  test('heading prefix should become visible when clicked', async ({ page }) => {
    // 1. Locate the heading
    const headingBlock = page.locator('.line-block').filter({ hasText: '测试区块' }).first();
    await expect(headingBlock).toBeVisible();

    // The syntax prefix (e.g. "## ") should be hidden initially
    const prefix = headingBlock.locator('.token-heading-prefix .syntax-hidden');
    
    // Check initial state (should be hidden)
    // We can't use toBeHidden() if it's display:none but attached to DOM, wait, toBeHidden() checks visibility!
    await expect(prefix).toBeHidden();

    // 2. Click the heading
    await headingBlock.click();

    // 3. The heading block should now have the .is-active-token class
    // Wait for react to update
    await page.waitForTimeout(100);

    // Let's dump the classes on the active row to debug
    const lineIndex = await headingBlock.getAttribute('data-index');
    console.log(`Heading data-index: ${lineIndex}`);
    
    // Wait, the data-index is on the WRAPPER div in MarkdownEngine!
    // BlockRenderer's div is INSIDE the wrapper div!
    // Let's check the DOM structure:
    // <div data-index="0" class="is-active-token">
    //   <div class="line-block line-h1">...</div>
    // </div>
    
    // 4. Assert that the prefix is now visible
    await expect(prefix).toBeVisible();
  });
});
