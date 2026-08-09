import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Fuzz thrash testing', () => {
<<<<<<< Updated upstream
  const fuzzDir = path.join(import.meta.dirname, 'fuzz-data');
=======
  const fuzzDir = path.join(__dirname, 'fuzz-data');
>>>>>>> Stashed changes
  const files = fs.readdirSync(fuzzDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    test(`fuzz test: ${file}`, async ({ page }) => {
      const content = fs.readFileSync(path.join(fuzzDir, file), 'utf-8');

      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(`[PageError] ${err.message}`));
      page.on('console', (msg) => {
<<<<<<< Updated upstream
        if (msg.type() === 'error' && !msg.text().includes('[CRISH METRICS]')) {
=======
        if (msg.type() === 'error') {
>>>>>>> Stashed changes
          errors.push(`[ConsoleError] ${msg.text()}`);
        }
      });

<<<<<<< Updated upstream
      await page.goto('http://localhost:5174');
      await page.waitForFunction(() => !!(window as any).__CRISH_SESSION_STORE__);

      // Inject the fuzz content
      await page.evaluate((content) => {
        (window as any).__CRISH_SESSION_STORE__.getState().setText(content);
=======
      await page.goto('http://localhost:5173');

      // Inject the fuzz content
      await page.evaluate((text) => {
        window.useEditorStore.setState({ rawText: text });
>>>>>>> Stashed changes
      }, content);

      // Wait for rendering to settle
      await page.waitForTimeout(500);

      // Perform some random clicks to trigger layout thrash
<<<<<<< Updated upstream
      const box = await page.locator('.editor-container').boundingBox();
=======
      const box = await page.locator('.crish-editor-container').boundingBox();
>>>>>>> Stashed changes
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
