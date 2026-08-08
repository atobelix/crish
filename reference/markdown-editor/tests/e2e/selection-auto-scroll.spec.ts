import { test, expect } from '@playwright/test';

test.describe('Selection Auto-Scroll Bouncing Prevention Suite', () => {
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

  test('Shift+Up selection auto-scrolls upwards smoothly without bouncing', async ({ page }) => {
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

    // Hold Shift and press Up repeatedly to trigger upward selection and custom auto-scroll
    await page.keyboard.down('Shift');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(50);
      
      const currentScrollTop = await container.evaluate((el) => el.scrollTop) as number;
      if (currentScrollTop > previousScrollTop) bounced = true; // Moved down instead of up!
      if (currentScrollTop < previousScrollTop) progressed = true; // Successfully scrolled up
      
      previousScrollTop = currentScrollTop;
    }
    await page.keyboard.up('Shift');

    expect(bounced, 'Scroll position bounced downwards while selecting upwards!').toBe(false);
    expect(progressed, 'Scroll position did not progress upwards!').toBe(true);
  });

  test('Shift+Down selection auto-scrolls downwards smoothly without bouncing', async ({ page }) => {
    await page.evaluate((docText) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(docText);
    }, generateContent());

    const container = page.locator('.editor-scroll-container');
    await expect(container).toBeVisible();

    // Scroll to top
    await container.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(100);

    // Click near the top
    const rows = page.locator('.virtual-row');
    const firstRow = rows.nth(1);
    const box = await firstRow.boundingBox();
    await page.mouse.click(box!.x + 10, box!.y + 10);
    
    let previousScrollTop = await container.evaluate((el) => el.scrollTop);
    let bounced = false;
    let progressed = false;

    // Hold Shift and press Down repeatedly to trigger downward selection and custom auto-scroll
    await page.keyboard.down('Shift');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(50);
      
      const currentScrollTop = await container.evaluate((el) => el.scrollTop) as number;
      if (currentScrollTop < previousScrollTop) bounced = true; // Moved up instead of down!
      if (currentScrollTop > previousScrollTop) progressed = true; // Successfully scrolled down
      
      previousScrollTop = currentScrollTop;
    }
    await page.keyboard.up('Shift');

    expect(bounced, 'Scroll position bounced upwards while selecting downwards!').toBe(false);
    expect(progressed, 'Scroll position did not progress downwards!').toBe(true);
  });
});
