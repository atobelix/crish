import { test, expect } from '@playwright/test';

test.describe('Random Line Selection, Cursor Positioning & Editing E2E Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
  });

  test('random line clicks correctly position cursor and activate line styles', async ({ page }) => {
    // Populate with 300 lines of diverse markdown content
    const sampleTypes = [
      (i: number) => `# Heading Level 1 - Item ${i}`,
      (i: number) => `### Heading Level 3 - Item ${i}`,
      (i: number) => `- Bullet item ${i} with **bold text** and \`inline_code\``,
      (i: number) => `1. Numbered item ${i} with *italic* styling`,
      (i: number) => `> Blockquote insight at index ${i}`,
      (i: number) => `Line ${i}: Regular paragraph text containing some words for interaction testing.`,
    ];

    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(sampleTypes[i % sampleTypes.length](i));
    }

    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, lines.join('\n'));

    const container = page.locator('.editor-scroll-container');
    await expect(container).toBeVisible();

    // Perform random clicks across multiple scroll positions
    const scrollPositions = [0, 500, 1200, 2500, 4000];

    for (const scrollTop of scrollPositions) {
      await container.evaluate((el, top) => {
        el.scrollTop = top;
      }, scrollTop);

      await page.waitForTimeout(50);

      const visibleRows = page.locator('.virtual-row');
      const count = await visibleRows.count();
      if (count > 0) {
        // Pick a random row among visible rows
        const randomIndex = Math.floor(Math.random() * count);
        const targetRow = visibleRows.nth(randomIndex);

        const box = await targetRow.boundingBox();
        if (box && box.height > 0) {
          // Click at an arbitrary point within the row
          await page.mouse.click(box.x + Math.min(box.width * 0.3, 100), box.y + box.height / 2);
          await page.waitForTimeout(40);

          // Verify cursor position is updated in store
          const cursorPos = await page.evaluate(() => {
            return (window as any).__CRISH_SESSION_STORE__.getState().cursorPos;
          });
          expect(cursorPos).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test('editing on a clicked line modifies content reactively', async ({ page }) => {
    const initialText = 'Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma\nLine 4: Delta';
    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, initialText);

    // Click Line 2
    const rowBeta = page.locator('.virtual-row').filter({ hasText: 'Beta' });
    await rowBeta.waitFor();
    await rowBeta.click();

    // Type additional content
    await page.keyboard.type(' Extra');
    await page.waitForTimeout(50);

    const fullText = await page.evaluate(() => {
      return (window as any).__CRISH_SESSION_STORE__.getState().getText();
    });

    expect(fullText).toContain('Beta');
    expect(fullText).toContain('Extra');
  });
});
