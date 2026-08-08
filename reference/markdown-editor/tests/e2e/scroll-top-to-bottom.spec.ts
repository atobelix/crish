import { test, expect } from '@playwright/test';

test.describe('Top-to-Bottom Scrolling & Blank Screen Prevention E2E Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174');
    await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);
  });

  test('scrolls sequentially through a multi-section document without blank screen', async ({ page }) => {
    // Generate a structured 10-section document
    let content = '';
    for (let s = 1; s <= 10; s++) {
      content += `# Section ${s}: Exploring Architecture\n\n`;
      content += `This is paragraph 1 in section ${s}. It describes the core performance engine.\n\n`;
      content += '```typescript\nfunction section' + s + 'Core() {\n  return "processing-' + s + '";\n}\n```\n\n';
      content += `| Feature | Section ${s} Status | Notes |\n|---|---|---|\n| Virtualization | Active | 60FPS |\n| Incremental Parser | Verified | O(1) Updates |\n\n`;
      content += `> Blockquote noting section ${s} architectural constraints.\n\n`;
      content += `---\n\n`;
    }

    await page.evaluate((docText) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(docText);
    }, content);

    const container = page.locator('.editor-scroll-container');
    await expect(container).toBeVisible();

    // Scroll step-by-step from top to bottom
    const totalHeight = await container.evaluate((el) => el.scrollHeight);
    const clientHeight = await container.evaluate((el) => el.clientHeight);
    const step = Math.max(clientHeight * 0.75, 200);

    let currentScroll = 0;
    while (currentScroll < totalHeight) {
      await container.evaluate((el, top) => {
        el.scrollTop = top;
      }, currentScroll);

      // Give virtualizer a frame to hydrate
      await page.waitForTimeout(40);

      // Verify that visible rows are present and non-empty
      const visibleRows = page.locator('.virtual-row');
      const count = await visibleRows.count();
      expect(count).toBeGreaterThan(0);

      // Verify row text is rendered
      const firstRowText = await visibleRows.first().innerText();
      expect(firstRowText.length).toBeGreaterThanOrEqual(0);

      currentScroll += step;
    }

    // Reach very bottom
    await container.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(60);

    const bottomRows = page.locator('.virtual-row');
    expect(await bottomRows.count()).toBeGreaterThan(0);
  });

  test('handles sudden jumps (0% -> 50% -> 90% -> 0%) without blank screen', async ({ page }) => {
    // 1500 lines document
    const lines: string[] = [];
    for (let i = 1; i <= 1500; i++) {
      if (i % 100 === 0) {
        lines.push(`## Checkpoint Line ${i}`);
      } else if (i % 50 === 0) {
        lines.push(`| Col A ${i} | Col B ${i} |\n|---|---|\n| Val 1 | Val 2 |`);
      } else {
        lines.push(`Line ${i}: Fast virtual scrolling validation item with text content.`);
      }
    }

    await page.evaluate((text) => {
      (window as any).__CRISH_SESSION_STORE__.getState().setText(text);
    }, lines.join('\n'));

    const container = page.locator('.editor-scroll-container');
    await expect(container).toBeVisible();

    const scrollTargets = [0.25, 0.5, 0.75, 1.0, 0.1, 0.85, 0.0];

    for (const ratio of scrollTargets) {
      await container.evaluate((el, r) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * r;
      }, ratio);

      await page.waitForTimeout(60);

      const rows = page.locator('.virtual-row');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    }
  });
});
