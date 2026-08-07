import { test, expect } from '@playwright/test';

test.describe('Cursor Position Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the markdown editor reference implementation
    await page.goto('http://localhost:5173');
    // Wait for the editor to render
    await page.waitForSelector('.editor-container');
  });

  test('cursor should be placed correctly inside bold text', async ({ page }) => {
    // 1. Locate the text element containing '加粗'
    const boldTextEl = page.locator('span[data-sub-offset]').filter({ hasText: '加粗' }).first();
    await expect(boldTextEl).toBeVisible();

    // 2. Get the bounding box of the text element
    const box = await boldTextEl.boundingBox();
    if (!box) throw new Error('Could not find bounding box for bold text');

    // 3. Click exactly in the middle of the '加粗' text
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // 4. Locate the custom cursor
    const cursor = page.locator('.cursor-caret');
    await expect(cursor).toBeVisible();

    // 5. Get the bounding box of the cursor
    const cursorBox = await cursor.boundingBox();
    if (!cursorBox) throw new Error('Could not find bounding box for cursor');

    // 6. Assert that the cursor is horizontally inside the text bounding box (or very close to it)
    // The cursor should be between the left and right edges of the bold text
    const isHorizontallyAligned = cursorBox.x >= box.x - 5 && cursorBox.x <= box.x + box.width + 5;

    // 7. Assert that the cursor is vertically aligned with the text
    // The cursor's top should be roughly the same as the text's top
    const isVerticallyAligned = Math.abs(cursorBox.y - box.y) < 10;

    // Log the coordinates for debugging
    console.log(`Bold text box: x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height}`);
    console.log(`Cursor box: x=${cursorBox.x}, y=${cursorBox.y}`);

    // If it fails, this will throw and fail the test, giving us a reproduction of the bug!
    expect(isHorizontallyAligned, `Cursor X (${cursorBox.x}) is not aligned with text X (${box.x} to ${box.x + box.width})`).toBe(true);
    expect(isVerticallyAligned, `Cursor Y (${cursorBox.y}) is not aligned with text Y (${box.y})`).toBe(true);
  });
});
