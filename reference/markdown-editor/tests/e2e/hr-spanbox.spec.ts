import { test, expect } from '@playwright/test';

test('measure hr-source spanBox', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.evaluate(() => {
    (window as any).__CRISH_SESSION_STORE__.getState().setText('hello\n---\nworld\n');
  });
  await page.waitForSelector('.line-hr .hr-rendered');
  
  // click once
  const hr1 = page.locator('.line-hr .hr-rendered').nth(0);
  const box1 = await hr1.boundingBox();
  await page.mouse.click(box1!.x + 10, box1!.y + box1!.height / 2);
  await page.waitForTimeout(100);

  const spanBox = await page.locator('.is-active-line .hr-source').boundingBox();
  console.log('spanBox:', spanBox);
});
