import { test, expect } from '@playwright/test';

test('click on hr and measure cursor', async ({ page }) => {
  // Go to dev server
  await page.goto('http://localhost:5173');

  // Set markdown with HR
  await page.evaluate(() => {
    window.useEditorStore.setState({ rawText: 'abc\n---\ndef' });
  });

  // Wait for the HR to be rendered
  await page.waitForSelector('.line-hr .hr-rendered');

  // Get the HR bounding box
  const hr = page.locator('.line-hr .hr-rendered');
  const hrBox = await hr.boundingBox();
  console.log('HR box:', hrBox);

  // Click on the HR element
  await hr.click();

  // Wait for cursor to update
  await page.waitForTimeout(500); // Give it some time for React to render cursor

  const cursorBox = await page.locator('.cursor').boundingBox();
  console.log('Cursor box:', cursorBox);

  const storeState = await page.evaluate(() =>
    window.useEditorStore.getState()
  );
  console.log('cursorPos:', storeState.cursorPos);
});
