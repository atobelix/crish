import { test, expect } from '@playwright/test';

test('check console errors on load and interact', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    errors.push(err.message);
  });

  await page.goto('http://localhost:5173');
  
  // Wait for editor to load
  await page.waitForSelector('.editor-container');
  
  // Click around
  await page.click('text="一级标题 H1"');
  await page.waitForTimeout(100);
  
  await page.mouse.click(100, 100); // random click
  await page.waitForTimeout(100);

  if (errors.length > 0) {
    console.error('RUNTIME ERRORS DETECTED:', errors);
    expect(errors.length).toBe(0);
  } else {
    console.log('NO RUNTIME ERRORS DETECTED!');
  }
});
