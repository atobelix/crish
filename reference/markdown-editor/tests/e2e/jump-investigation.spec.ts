import { test, expect } from '@playwright/test';

test('click on empty space in hr line', async ({ page }) => {
  await page.goto('http://localhost:5174');
  await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);

  await page.evaluate(() => {
    (window as any).__CRISH_SESSION_STORE__.getState().setText('hello\n---\nworld\n');
  });

  await page.waitForSelector('.line-hr');
  
  // click far right of the line
  await page.mouse.click(500, 42); // Top 28-56 is index 1 (the hr)
  await page.waitForTimeout(100);

  const storeState = await page.evaluate(() =>
    (window as any).__CRISH_SESSION_STORE__.getState()
  );
  console.log('Cursor pos after clicking far right of hr line:', storeState.cursorPos);
});
