import { test } from '@playwright/test';

test('Dump Heading HTML', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);

  const md = `# Heading Shift Test`;
  await page.evaluate((md) => { (window as any).__CRISH_SESSION_STORE__.getState().setText(md); }, md);
  await page.waitForTimeout(100);

  const virtualRow = page.locator('.virtual-row').first();
  console.log("INACTIVE HTML:\n", await virtualRow.innerHTML());

  await page.locator('text="Heading Shift Test"').click();
  await page.waitForTimeout(100);
  
  console.log("ACTIVE HTML:\n", await virtualRow.innerHTML());
});
