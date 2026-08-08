import { test, expect } from '@playwright/test';

test('dump DOM tokens', async ({ page }) => {
  await page.goto('http://localhost:5174');
  await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
  await page.waitForSelector('.editor-container');

  const html = await page.evaluate(() => {
    const line = document.querySelector('.line-block');
    return line ? line.outerHTML : '';
  });

  console.log(html);
});
