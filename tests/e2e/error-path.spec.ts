/**
 * E2E-L2 场景 ④'：错误路径（mock 引擎错误 → 用户提示）
 * （任务书补充场景：core_run_task 拒绝时前端必须显式提示，非静默失败）
 *
 * 链路：core_run_task 抛 CoreError（{ kind, message }）→
 *   createStreamSession catch → onRunError → SessionRuntimeStatusStore → ComposerErrorBar
 *   （单轨收敛：错误展示唯一出口 = SessionRuntimeStatusStore，禁止写入 assistant 气泡）
 *
 * 断言（行为级）：
 *   1. composer-error-bar 可见且文案为引擎错误信息（非静默失败）
 *   2. 无 assistant 空气泡残留（错误不伪装成 AI 输出）
 *   3. 错误后输入框可继续输入（可重试）
 */

import { test, expect, type Page } from '@playwright/test';
import { installMockEngine, errorRunConfig } from './mock-engine';
import { typeIntoComposer, expectComposerText } from './helpers/boot';

async function openApp(page: Page) {
  await installMockEngine(page, { runStream: errorRunConfig() });
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20000 });
}

test.describe('E2E-L2 错误路径（error-path）', () => {
  test('引擎拒绝 run-task → 显式提示，无静默失败', async ({ page }) => {
    await openApp(page);

    const input = page.locator('[data-testid="chat-input"]');
    await typeIntoComposer(page, '请帮我执行一个任务');
    await input.press('Enter');

    // ── ① 运行错误条可见（ComposerErrorBar：data-testid="composer-error-bar"）──
    const notice = page.locator('[data-testid="composer-error-bar"]');
    await expect(notice).toBeVisible({ timeout: 8000 });
    // C3.4 产品语义：stream-start 拒绝统一走 networkUserMessage 通用文案
    // （createStreamSession catch → onRunError(networkUserMessage(), 'network')），
    // 不透出引擎错误原文，但必须显式提示而非静默失败。
    await expect(page.locator('[data-testid="composer-error-text"]')).toContainText(
      '服务暂时不可用',
      { timeout: 8000 }
    );

    // ── ② 错误不伪装成 AI 输出：assistant 空气泡被收回 ──
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (window as any).__CRISH_STORE__;
            const byId = store?.getState?.().sessionsById || {};
            const sess = byId[Object.keys(byId)[0]];
            if (!sess?.messages?.length) return [];
            return sess.messages
              .filter((m: { sender: string }) => m.sender === 'assistant')
              .map((m: { text: string; status: string }) => ({
                text: m.text || '',
                status: m.status,
              }));
          }),
        { timeout: 8000 }
      )
      .toEqual([]);

    // ── ③ 可重试：错误后输入框可用 ──
    await expect(input).toBeEditable();
    await typeIntoComposer(page, '重试一次');
    await expectComposerText(page, '重试一次');
  });

  test('引擎错误时 runCount 已记录且 runId 下发（非空跑证据）', async ({
    page,
  }) => {
    await openApp(page);

    const input = page.locator('[data-testid="chat-input"]');
    await typeIntoComposer(page, '触发错误');
    await input.press('Enter');

    await expect(page.locator('[data-testid="composer-error-bar"]')).toBeVisible({
      timeout: 8000,
    });
    const state = await page.evaluate(() => {
      const h = (window as any).__CRISH_E2E__;
      return {
        runCount: h?.getState?.().runCount,
        lastRun: h?.getState?.().lastRun,
      };
    });
    expect(state.runCount).toBeGreaterThan(0);
    expect(String(state.lastRun?.runId || '')).toMatch(/^run-/);
  });
});
