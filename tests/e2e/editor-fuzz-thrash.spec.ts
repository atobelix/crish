import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Editor Fuzz thrash testing', () => {
  const fuzzDir = path.resolve(
    __dirname,
    '../../reference/markdown-editor/tests/e2e/fuzz-data'
  );
  if (!fs.existsSync(fuzzDir)) {
    console.warn(`Fuzz directory not found: ${fuzzDir}`);
    return;
  }
  const files = fs.readdirSync(fuzzDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    test(`fuzz test: ${file}`, async ({ page }) => {
      const content = fs.readFileSync(path.join(fuzzDir, file), 'utf-8');

      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(`[PageError] ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          errors.push(`[ConsoleError] ${msg.text()}`);
        }
      });

      // reference/markdown-editor dev server is on port 5174
      await page.goto('http://localhost:5174');
      await page.waitForSelector('.editor-container');

      // Inject the fuzz content
      await page.evaluate((text) => {
        // @ts-expect-error window.__CRISH_SESSION_STORE__ is injected in main.tsx
        window.__CRISH_SESSION_STORE__.setState({ rawText: text });
      }, content);

      // Wait for rendering to settle
      await page.waitForTimeout(500);

      // Perform some random clicks to trigger layout thrash
      const box = await page.locator('.editor-container').boundingBox();
      if (box) {
        for (let i = 0; i < 5; i++) {
          const x = box.x + Math.random() * box.width;
          const y = box.y + Math.random() * box.height;
          await page.mouse.click(x, y);
          await page.waitForTimeout(100);
        }
      }

      // Assert no runtime errors occurred
      expect(errors).toEqual([]);
    });
  }
});
