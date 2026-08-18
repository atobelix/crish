import { test, expect } from '@playwright/test';

// 适配状态（维度7批次3，2026-08-13 核验）：本 spec 已适配当前 M3/M4 引擎交互模型。
// 关键契约对齐点：① window 全局 = __CRISH_SESSION_STORE__（main.tsx:24 暴露，
//   非 pre-M4 的 useEditorStore）；② App.tsx:531 MarkdownEngine 恒挂载（不再按
//   textLength > 0 条件卸载），setText('') 后 .editor-container 与隐藏 textarea
//   仍可点击/聚焦——F-005 登记的 pre-M3 空文本卸载问题已消除；③ IME 组合缓冲
//   经 HiddenInput R4-C 状态机（compositionstart/end + 50ms flush 延迟窗口）。
// 实测：npx playwright test tests/e2e/ime-composition.spec.ts --reporter=line → 1 passed。
// 保留为保护名单对抗性测试（AGENTS.md §9），不 skip、不删除。

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
