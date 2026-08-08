import { test, expect } from '@playwright/test';

test('click on hr and measure cursor', async ({ page }) => {
  // Go to dev server
  await page.goto('http://localhost:5174');
  await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);

  // Set markdown with HR
  await page.evaluate(() => {
    (window as any).__CRISH_SESSION_STORE__.getState().setText('hello\n---\nworld');
  });

  // Wait for the HR to be rendered
  await page.waitForSelector('.line-hr .hr-rendered');

  // Get the HR bounding box
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  const hr = page.locator('.line-hr .hr-rendered');
  const hrBox = await hr.boundingBox();
  console.log('HR box:', hrBox);

  // Click on the HR element
  await hr.click();

  // Wait for cursor to update
  await page.waitForTimeout(500); // Give it some time for React to render cursor

  const html = await page.evaluate(() => document.querySelector('.editor-container')?.innerHTML);
  console.log('BROWSER HTML:', typeof html === 'string' ? html.substring(0, 1000) + '...' : html);

  const cursorBox = await page.locator('.cursor-caret').boundingBox();
  console.log('Cursor box:', cursorBox);

  const storeState = await page.evaluate(() =>
    (window as any).__CRISH_SESSION_STORE__.getState()
  );
  
  // The cursor should be within the hr line range [6, 9]
  expect(storeState.cursorPos).toBeGreaterThanOrEqual(6);
  expect(storeState.cursorPos).toBeLessThanOrEqual(9);
});
