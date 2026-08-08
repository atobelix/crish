import { test, expect } from '@playwright/test';

test.describe('Selection Auto-Scroll Regression Suite (Native Drag Behavior)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
  });

  const generateContent = () => {
    let content = '';
    for (let i = 1; i <= 200; i++) {
      if (i % 5 === 0) {
        content += `# Large Heading ${i} with extra margins\n\n`;
      } else {
        content += `Line ${i}: Regular text to fill space.\n\n`;
      }
    }
    return content;
  };

  test('Shift+Up selection (simulating drag) does not bounce repeatedly', async ({ page }) => {
    // This test ensures that when the selection expands upward across the viewport edge,
    // the virtualizer and custom auto-scroll logic do not get stuck in a bouncing loop.
    await page.evaluate((docText) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(docText);
    }, generateContent());

    const container = page.locator('.editor-scroll-container');
    await expect(container).toBeVisible();

    // Scroll to bottom
    await container.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(100);

    // Click near the bottom
    const rows = page.locator('.virtual-row');
    const rowCount = await rows.count();
    const lastRow = rows.nth(rowCount - 2);
    const box = await lastRow.boundingBox();
    await page.mouse.click(box!.x + 10, box!.y + 10);
    
    let previousScrollTop = await container.evaluate((el) => el.scrollTop);
    let bounced = false;
    let progressed = false;

    // Simulate drag via Shift+ArrowUp (as Playwright cannot natively drag outside viewport)
    await page.keyboard.down('Shift');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(50);
      
      const currentScrollTop = await container.evaluate((el) => el.scrollTop) as number;
      if (currentScrollTop > previousScrollTop) bounced = true; 
      if (currentScrollTop < previousScrollTop) progressed = true; 
      
      previousScrollTop = currentScrollTop;
    }
    await page.keyboard.up('Shift');

    expect(bounced, 'Scroll position bounced downwards while selecting upwards!').toBe(false);
    expect(progressed, 'Scroll position did not progress upwards!').toBe(true);
  });
});
