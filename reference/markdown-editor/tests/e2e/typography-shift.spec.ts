import { test, expect } from '@playwright/test';

test.describe('Typography Shift & Mixed Rendering Matrix Suite', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the Vite dev server
    await page.goto('http://localhost:5173');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
  });

  const testMarkdown = `
# Heading Shift Test
> Blockquote Line 1
> > Nested Blockquote Line 2
1. Ordered List Item
  2. Nested Ordered List
- [ ] Task List Item
  - [x] Nested Task List
* Bullet List Item
  * Nested Bullet List
`.trim();

  const testCases = [
    { name: 'Heading', text: 'Heading Shift Test' },
    { name: 'Blockquote L1', text: 'Blockquote Line 1' },
    { name: 'Blockquote L2', text: 'Nested Blockquote Line 2' },
    { name: 'Ordered List L1', text: 'Ordered List Item' },
    { name: 'Ordered List L2', text: 'Nested Ordered List' },
    { name: 'Task List L1', text: 'Task List Item' },
    { name: 'Task List L2', text: 'Nested Task List' },
    { name: 'Bullet List L1', text: 'Bullet List Item' },
    { name: 'Bullet List L2', text: 'Nested Bullet List' },
  ];

  // Test matrix for different click positions
  const clickPositions = ['start', 'middle', 'end'];

  for (const tc of testCases) {
    for (const pos of clickPositions) {
      test(`Zero-Shift & Visibility: ${tc.name} clicked at ${pos}`, async ({ page }) => {
        // Inject the comprehensive markdown
        await page.evaluate((md) => { (window as any).__CRISH_SESSION_STORE__.getState().setText(md); }, testMarkdown);
        await page.waitForTimeout(100); // small delay to ensure DOM is settled

        const targetText = page.locator(`text="${tc.text}"`).first();
        await expect(targetText).toBeVisible();

        // 1. Measure initial state (Before click)
        const boxBefore = await targetText.boundingBox();
        expect(boxBefore).not.toBeNull();
        
        // Ensure no active line styles are artificially applied before we click
        await page.mouse.click(0, 0); 
        await page.waitForTimeout(50);

        // 2. Click the target line at the specified position
        const width = boxBefore!.width;
        let xOffset = 5; // start
        if (pos === 'middle') xOffset = width / 2;
        if (pos === 'end') xOffset = width - 5;
        
        await targetText.click({ position: { x: xOffset, y: boxBefore!.height / 2 } });

        // 3. Verify that the line became active
        const virtualRow = targetText.locator('xpath=./ancestor::div[contains(@class, "virtual-row")]').first();
        await expect(virtualRow).toHaveClass(/is-active-line/, { timeout: 1000 });

        // 4. Verify Zero-Shift of the Text
        const boxAfter = await targetText.boundingBox();
        expect(boxAfter).not.toBeNull();
        
        console.log(`[${tc.name} at ${pos}] BEFORE:`, boxBefore);
        // We expect zero vertical shift to prevent line bouncing, but horizontal shift is acceptable and expected!
        // When raw syntax (- [ ]) replaces the bullet, it naturally pushes text to the right. 
        const shiftY = Math.abs(boxAfter!.y - boxBefore!.y);
        expect(shiftY, `Y shift was ${shiftY}px`).toBeLessThanOrEqual(2);

        // 5. Verify Cursor Placement via Typing (Only for Start/Middle clicks, End clicks might be outside the prefix)
        // If we click on the prefix itself, typing a character should place it inside the prefix properly.
        if (pos === 'start') {
          // Click exactly in the middle of the prefix box (use syntax-content which is visible when inactive)
          let prefix = virtualRow.locator('.syntax-content').first();
          if (await prefix.count() === 0) {
             prefix = virtualRow.locator('.syntax-hidden').first();
          }
          const prefixBox = await prefix.boundingBox();
          
          if (prefixBox && prefixBox.width > 0) {
            await page.mouse.click(prefixBox.x + prefixBox.width / 2, prefixBox.y + prefixBox.height / 2);
            await page.keyboard.type('X');
            await page.waitForTimeout(50);
            
            // The typed character should appear in the DOM
            const typedChar = page.locator('text="X"').first();
            await expect(typedChar).toBeVisible({ timeout: 1000 });
            
            // Cleanup the typed character
            await page.keyboard.press('Backspace');
          }
        }
      });
    }
  }
});
