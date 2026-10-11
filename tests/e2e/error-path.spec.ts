/**
 * E2E-L2 场景 ④'：错误路径（mock 引擎错误 → 用户提示）
 * （任务书补充场景：core_run_task 拒绝时前端必须显式提示，非静默失败）
 *
 * 链路：core_run_task 抛 CoreError（{ kind, message }）→
 *   createStreamSession catch → onRunError → SessionRuntimeStatusStore → ComposerErrorBar
 *   （单轨收敛：错误展示唯一出口 = SessionRuntimeStatusStore，禁止写入 assistant 气泡）
 *
 * 断言（行为级）：
 *   1. composer-error-bar 显示当前产品错误提示（非静默失败）
 *   2. 无 assistant 空气泡残留（错误不伪装成 AI 输出）
 *   3. 错误后输入框可继续输入（可重试）
 */

import { test, expect, type Page } from '@playwright/test';
import { errorRunConfig } from './mock-engine';
import {
  openApp as bootOpenApp,
  startNewSession,
  typeIntoComposer,
  expectComposerText,
} from './helpers/boot';

async function openApp(page: Page) {
  await bootOpenApp(page, { runStream: errorRunConfig() });
  await startNewSession(page);
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toBeVisible();
  await expect(input).toBeEditable();
}

/** 首条消息提交时才 mint 真会话；等待引擎确认收到完整 run 参数。 */
async function submitPromptAndReadRun(page: Page, prompt: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await typeIntoComposer(page, prompt);
  await expectComposerText(page, prompt);
  await page.locator('[data-composer-send] [data-send-active="1"]').click();

  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).__CRISH_E2E__?.getState?.().runCount ?? 0
        ),
      { timeout: 8000 }
    )
    // TauriTransport 对 invoke error 会重试一次；这里锁定请求确实到达，
    // 不把可配置的传输重试次数写成该错误路径的验收条件。
    .toBeGreaterThan(0);

  const run = await page.evaluate(
    () => (window as any).__CRISH_E2E__?.getState?.().lastRun ?? null
  );
  expect(run).not.toBeNull();
  expect(run.prompt).toBe(prompt);
  expect(String(run.runId ?? '')).toMatch(/^run-/);
  expect(String(run.sessionId ?? '')).toMatch(/^sess-/);
  return run as { runId: string; sessionId: string; prompt: string };
}

test.describe('E2E-L2 错误路径（error-path）', () => {
  test('引擎拒绝 run-task → 显式提示，无静默失败', async ({ page }) => {
    await openApp(page);

    const input = page.locator('[data-testid="chat-input"]');
    const prompt = '请帮我执行一个任务';
    const run = await submitPromptAndReadRun(page, prompt);

    // ── ① 运行错误条可见（ComposerErrorBar：data-testid="composer-error-bar"）──
    const notice = page.locator('[data-testid="composer-error-bar"]');
    await expect(notice).toBeVisible({ timeout: 8000 });
    // 未分类的启动拒绝按当前 userFacingErrors 契约回退到 S4；不透出引擎原文。
    const errorText = page.locator('[data-testid="composer-error-text"]');
    await expect(errorText).toContainText('模型服务商暂时无法连接', {
      timeout: 8000,
    });
    await expect(errorText).not.toContainText('mock 注入错误');

    // ── ② 错误不伪装成 AI 输出：assistant 空气泡被收回 ──
    const sessionState = await page.evaluate((sessionId) => {
      const store = (window as any).__CRISH_STORE__;
      const session = store?.getState?.().sessionsById?.[sessionId];
      const messages = session?.messages ?? [];
      return {
        exists: Boolean(session),
        userMessages: messages
          .filter((message: { sender: string }) => message.sender === 'user')
          .map((message: { text: string; status: string }) => ({
            text: message.text || '',
            status: message.status,
          })),
        assistantMessages: messages
          .filter((message: { sender: string }) => message.sender === 'assistant')
          .map((message: { text: string; status: string }) => ({
            text: message.text || '',
            status: message.status,
          })),
      };
    }, run.sessionId);
    expect(sessionState.exists).toBe(true);
    expect(sessionState.userMessages).toContainEqual({
      text: prompt,
      status: 'completed',
    });
    expect(sessionState.assistantMessages).toEqual([]);

    // ── ③ 可重试：错误后输入框可用 ──
    await expect(input).toBeEditable();
    await typeIntoComposer(page, '重试一次');
    await expectComposerText(page, '重试一次');
  });

  test('引擎错误时 runCount 已记录且 runId 下发（非空跑证据）', async ({
    page,
  }) => {
    await openApp(page);

    const run = await submitPromptAndReadRun(page, '触发错误');

    await expect(page.locator('[data-testid="composer-error-bar"]')).toBeVisible({
      timeout: 8000,
    });
    expect(run.runId).toMatch(/^run-/);
    expect(run.sessionId).toMatch(/^sess-/);
  });
});
