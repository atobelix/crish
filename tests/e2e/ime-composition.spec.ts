import { test, expect } from '@playwright/test';

test.describe('IME Composition', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('.editor-container');
  });

  test('should prevent character insertion during IME composition', async ({
    page,
  }) => {
    await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().setText('');
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      window.__CRISH_SESSION_STORE__.getState().setCursorPos(0);
    });
    await page.locator('.editor-container').click({ force: true });

    const textarea = page.locator('textarea');
    await textarea.evaluate((node) => {
      if (node instanceof HTMLTextAreaElement) node.focus();
    });
    // Simulate typing "nihao" with IME
    await textarea.evaluate((node) => {
      node.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true, data: '' })
      );
      node.value = 'n';
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.value = 'ni';
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.value = 'nih';
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.value = 'niha';
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.value = 'nihao';
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The store text should be empty because it's composing!
    let text = await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      return window.__CRISH_SESSION_STORE__.getState().getText();
    });
    expect(text).toBe('');

    // End composition——真实浏览器在 compositionend 后把最终文本写入 value
    // 并补发 input（引擎 HiddenInput R4-C 状态机在组合缓冲期全部短路，
    // 只在 50ms 延迟 flush 窗口以 textarea.value 为准一次性提交）
    await textarea.evaluate((node) => {
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '你好' })
      );
      node.value = '你好';
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 等待 flush 延迟窗口（FLUSH_DELAY_MS = 50ms）到期提交落库
    await page.waitForTimeout(200);

    text = await page.evaluate(() => {
      // @ts-expect-error markdown-editor main.tsx 注入的测试全局
      return window.__CRISH_SESSION_STORE__.getState().getText();
    });
    expect(text).toBe('你好');
  });
});
