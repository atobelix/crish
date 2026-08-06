import { test, expect } from '@playwright/test';

test.describe('Cursor Position Debug Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForSelector('.editor-container');
  });

  test('Log cursor positions for all 7 interactive zones', async ({ page }) => {
    const locations = [
      { name: '1. 测试区块 1 (Heading)', locator: page.locator('.line-block').filter({ hasText: '测试区块' }).first() },
      { name: '2. Empty space (Left margin below line 1)', locator: page.locator('.line-block').filter({ hasText: '数学公式' }).first(), offsetX: -50, offsetY: -14 },
      { name: '3. 加粗 (Bold)', locator: page.locator('span[data-sub-offset]').filter({ hasText: '加粗' }).first() },
      { name: '4. 斜体 (Italic)', locator: page.locator('span[data-sub-offset]').filter({ hasText: '斜体' }).first() },
      { name: '5. 删除线 (Strike)', locator: page.locator('span[data-sub-offset]').filter({ hasText: '删除线' }).first() },
      { name: '6. 高亮 (Mark)', locator: page.locator('span[data-sub-offset]').filter({ hasText: '高亮' }).first() },
      { name: '7. 代码 (Inline Code)', locator: page.locator('.style-inline-code').first() },
    ];

    console.log('\n--- Cursor Position Debug Results ---');

    for (const loc of locations) {
      const el = loc.locator;
      await expect(el).toBeVisible();
      
      const box = await el.boundingBox();
      if (!box) {
        console.log(`${loc.name}: Could not find bounding box`);
        continue;
      }

      // Calculate click coordinates
      let clickX = box.x + box.width / 2;
      let clickY = box.y + box.height / 2;

      // Apply manual offsets for edge cases like "empty space"
      if (loc.offsetX) clickX = box.x + loc.offsetX;
      if (loc.offsetY) clickY = box.y + loc.offsetY;

      // Ensure we click within the viewport
      if (clickX < 0) clickX = 5;

      // Perform click
      await page.mouse.click(clickX, clickY);

      // Wait a tiny bit for React state update
      await page.waitForTimeout(50);

      // Get cursor position
      const cursor = page.locator('.cursor-caret');
      if (await cursor.isVisible()) {
        const cursorBox = await cursor.boundingBox();
        if (cursorBox) {
          console.log(`\nLocation: ${loc.name}`);
          console.log(`  Clicked at:   X=${clickX.toFixed(2)}, Y=${clickY.toFixed(2)}`);
          console.log(`  Cursor at:    X=${cursorBox.x.toFixed(2)}, Y=${cursorBox.y.toFixed(2)}`);
          console.log(`  Delta:        dX=${(cursorBox.x - clickX).toFixed(2)}, dY=${(cursorBox.y - clickY).toFixed(2)}`);
        } else {
          console.log(`\nLocation: ${loc.name} -> Cursor visible but no bounding box`);
        }
      } else {
        console.log(`\nLocation: ${loc.name} -> Cursor NOT VISIBLE`);
      }
    }
    console.log('-----------------------------------\n');
  });
});
