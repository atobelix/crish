import { test, expect } from '@playwright/test';

// 适配状态（维度7批次3，2026-08-13 核验）：本 spec 已适配当前 M3/M4 引擎交互模型。
// 关键契约对齐点：① window 全局 = __CRISH_SESSION_STORE__（main.tsx:24 暴露，
//   非 pre-M4 的 useEditorStore）；② App.tsx:531 MarkdownEngine 恒挂载（不再按
//   textLength > 0 条件卸载），setText('') 后 .editor-container 仍可点击——
//   F-005 登记的 pre-M3 空文本卸载问题已消除；③ 方向键/Home/End 导航经
//   HiddenInput handleKeyDown 接管（浏览器默认在隐藏 textarea 上无效）。
// 实测：npx playwright test tests/e2e/keyboard-navigation.spec.ts --reporter=line → 2 passed。
// 保留为保护名单对抗性测试（AGENTS.md §9），不 skip、不删除。

test.describe('Keyboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
  });

  test('Arrow Up and Down should move cursor between lines', async ({
    page,
  }) => {
    await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().setText('');
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().setCursorPos(0);
    });

    const editor = page.locator('.editor-container');
    await editor.click();

    await page.keyboard.type('Line 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line 3');

    // Now cursor is at the end of "Line 3" (pos 20)
    // Let's manually move the textarea cursor as the browser would
    await page.evaluate(() => {
      const el = document.querySelector('textarea');
      if (el) {
        el.selectionStart = 13;
        el.selectionEnd = 13;
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
        );
      }
    });
    await page.waitForTimeout(50);

    const cursorPos = await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      return window.__CRISH_SESSION_STORE__.getState().cursorPos;
    });

    // It should snap to "Line 2" which is between 7 and 13
    expect(cursorPos).toBeGreaterThanOrEqual(7);
    expect(cursorPos).toBeLessThanOrEqual(13);
  });

  test('Home and End should move cursor to line boundaries', async ({
    page,
  }) => {
    await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().setText('');
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().setCursorPos(0);
    });

    const editor = page.locator('.editor-container');
    await editor.click();

    await page.keyboard.type('Line 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line 3');

    // Move to middle of Line 2
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(50);

    await page.keyboard.press('Home');
    await page.waitForTimeout(50);
    let pos = await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      return window.__CRISH_SESSION_STORE__.getState().cursorPos;
    });
    // We are on Line 2 because of ArrowUp. Start of Line 2 is index 7.
    expect(pos).toBe(7);

    await page.evaluate(() => {
      const el = document.querySelector('textarea');
      if (el) {
        el.selectionStart = 13;
        el.selectionEnd = 13;
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'End', bubbles: true })
        );
      }
    });
    await page.waitForTimeout(50);

    pos = await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      return window.__CRISH_SESSION_STORE__.getState().cursorPos;
    });
    expect(pos).toBe(13); // End of "Line 2"
  });
});
