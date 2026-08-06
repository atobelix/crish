import { test, expect } from '@playwright/test';

test('debug computed style', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.waitForSelector('.editor-container');
  
  const headingBlock = page.locator('.line-block').filter({ hasText: '测试区块' }).first();
  await headingBlock.click();
  await page.waitForTimeout(100);

  // Evaluate in browser to check classList and computed styles
  const debugInfo = await page.evaluate(() => {
    const el = document.querySelector('.line-block.line-h2');
    if (!el) return 'No heading found';
    const parent = el.closest('[data-index]');
    const prefix = el.querySelector('.syntax-hidden');
    
    return {
      parentClassList: parent?.className,
      prefixStyle: prefix ? window.getComputedStyle(prefix).display : 'no prefix',
      prefixText: prefix?.textContent
    };
  });

  console.log(debugInfo);
});
