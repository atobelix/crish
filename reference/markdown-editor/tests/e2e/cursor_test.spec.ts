import { test, expect } from '@playwright/test';

test('Cursor placement on absolute prefix', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);

  const md = `- [ ] Task List Item`;
  await page.evaluate((md) => { (window as any).__CRISH_SESSION_STORE__.getState().setText(md); }, md);
  await page.waitForTimeout(100);

  // 1. Click the middle of the text to make the line active
  const targetText = page.locator('text="Task List Item"');
  const boxBefore = await targetText.boundingBox();
  await targetText.click();
  
  const virtualRow = targetText.locator('xpath=./ancestor::div[contains(@class, "virtual-row")]').first();
  await expect(virtualRow).toHaveClass(/is-active-line/, { timeout: 1000 });

  // 2. Now the syntax "- [ ] " is visible. Let's find its bounding box.
  const prefix = virtualRow.locator('.syntax-hidden').first();
  const prefixBox = await prefix.boundingBox();
  console.log("Prefix Box:", prefixBox);
  
  // 3. Click exactly in the middle of the prefix (e.g. on the '[')
  await page.mouse.click(prefixBox!.x + prefixBox!.width / 2, prefixBox!.y + prefixBox!.height / 2);
  await page.waitForTimeout(100);
  
  // 4. Check where the cursor landed in the store!
  await page.keyboard.type('A');
  await page.waitForTimeout(100);
  
  const text = await page.evaluate(() => {
    return (window as any).__CRISH_SESSION_STORE__.getState().text;
  });
  console.log("Text after typing A:", text);
  
  // A should be inside the "- [ ]"
  expect(text.indexOf('A')).toBeGreaterThan(0);
  expect(text.indexOf('A')).toBeLessThan(6);
});
