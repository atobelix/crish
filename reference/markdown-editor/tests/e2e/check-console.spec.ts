import { test, expect } from '@playwright/test';

test('check console logs', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.text()));
  page.on('pageerror', err => logs.push(err.message));
  
  await page.goto('http://localhost:5174');
  await page.waitForTimeout(2000);
  console.log('Logs:', logs);
});
