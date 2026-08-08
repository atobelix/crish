import { test, expect } from '@playwright/test';

test('measure cursor click positions on hr', async ({ page }) => {
  await page.goto('http://localhost:5174');

  await page.waitForFunction(() => (window as any).__CRISH_SESSION_STORE__);
  await page.evaluate(() => {
    (window as any).__CRISH_SESSION_STORE__.getState().setText('hello\n---\nworld\n***\ntest');
  });

  await page.waitForSelector('.line-hr .hr-rendered');

  const hrs = page.locator('.line-hr .hr-rendered');
  expect(await hrs.count()).toBe(2);

  const hr1 = hrs.nth(0); // ---
  const hr2 = hrs.nth(1); // ***

  // Click once to activate the line
  const box1 = await hr1.boundingBox();
  if (!box1) throw new Error('no box1');
  await page.mouse.click(box1.x + 10, box1.y + box1.height / 2);
  await page.waitForTimeout(100);

  const positions = [0, 0.25, 0.5, 0.75, 1.0];

  for (let i = 0; i < positions.length; i++) {
    const fraction = positions[i];
    const spanBox = await page.locator('.is-active-line .hr-source').boundingBox();
    if (!spanBox) throw new Error('no spanBox');
    const x = spanBox.x + spanBox.width * fraction;
    const y = spanBox.y + spanBox.height / 2;

    await page.mouse.click(x, y);
    await page.waitForTimeout(100);

    const storeState = await page.evaluate(() =>
      (window as any).__CRISH_SESSION_STORE__.getState()
    );

    const cursorBox = await page.evaluate(() => {
      const el = document.querySelector('.cursor-caret');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    
    console.log(`Clicking exact span at ${fraction*100}% -> cursorPos: ${storeState.cursorPos}`);
  }

  // Same for ***
  const box2 = await hr2.boundingBox();
  if (!box2) throw new Error('no box2');

  for (let i = 0; i < positions.length; i++) {
    const fraction = positions[i];
    const x = box2.x + box2.width * fraction;
    const y = box2.y + box2.height / 2;

    await page.mouse.click(x, y);
    await page.waitForTimeout(100);

    const storeState = await page.evaluate(() =>
      (window as any).__CRISH_SESSION_STORE__.getState()
    );

    const hitTag = await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.tagName, {x, y});

    const cursorBox = await page.evaluate(() => {
      const el = document.querySelector('.cursor-caret');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    console.log(`Clicking *** at ${fraction*100}% -> hitTag: ${hitTag}, cursorPos: ${storeState.cursorPos}, cursorBox:`, cursorBox);
  }
});
