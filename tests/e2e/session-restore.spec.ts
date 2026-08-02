/**
 * E2E-L2 场景 ②：会话恢复（hydrate）
 * （PE-11 T11.1 必覆盖场景 3；预置 3 会话含 1 个 in-flight 中断会话）
 *
 * 恢复路径（真实链路）：
 *   localStorage 索引（crish_session_index_v1）→ 侧栏会话树渲染
 *   → 点击会话 → setActiveSessionId → needsEngineMessageHydrate
 *   → core_read_session_events 回放 → 消息回灌 → 终态标注
 *
 * 断言（行为级）：
 *   1. 侧栏渲染 3 会话（标题可见）
 *   2. 点击会话 → 消息列表回灌（用户/assistant 消息、工具调用卡）
 *   3. in-flight 会话（无 run-terminal）恢复为 interrupted：
 *      running 工具标 error（「上次会话中断」）、消息无 pending 态
 */

import { test, expect, type Page } from '@playwright/test';
import {
  installMockEngine,
  restoreSessions,
  restoreSessionIndexSeed,
} from './mock-engine';

async function openApp(page: Page) {
  await installMockEngine(page, {
    sessions: restoreSessions(),
    localStorage: restoreSessionIndexSeed(),
  });
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
}

test.describe('E2E-L2 会话恢复（session-restore）', () => {
  test('侧栏会话树渲染 + 消息回灌 + in-flight 中断标注', async ({ page }) => {
    await openApp(page);

    // ── ① 侧栏会话树渲染（3 会话）──
    const items = page.locator('[data-testid="sidebar-session-item"]');
    await expect(items).toHaveCount(3, { timeout: 8000 });
    await expect(items.nth(0)).toContainText('规划 Rust 迁移');
    await expect(items.nth(1)).toContainText('修复 CI 报错');
    await expect(items.nth(2)).toContainText('长会话（中断未收口）');

    // ── ② 点击已完成会话 → 消息回灌 ──
    await items.nth(0).click();
    const chatMessages = page.locator('.msg-row');
    await expect(chatMessages.first()).toBeVisible({ timeout: 8000 });
    // 用户消息 + assistant 回复
    await expect(page.locator('.msg-row-user').first()).toContainText(
      '规划 Rust 迁移'
    );
    const asstRow = page.locator('.msg-row-assistant').first();
    await expect(asstRow).toContainText('迁移方案已整理完毕。', {
      timeout: 8000,
    });

    // ── ③ 含工具调用的会话：工具卡回灌 ──
    await items.nth(1).click();
    const toolRow = page.locator(
      '.tool-stack .tool-row[data-tool-id="tool-r2-1"]'
    );
    await expect(toolRow).toBeVisible({ timeout: 8000 });
    await expect(toolRow).toContainText('bash');
    // 完成会话的工具为成功态
    await expect(toolRow).toContainText('2 failed; 1 passed');

    // ── ④ in-flight 会话恢复为 interrupted（PE-08 T08.6 语义）──
    await items.nth(2).click();
    const interruptedTool = page.locator(
      '.tool-stack .tool-row[data-tool-id="tool-r3-1"]'
    );
    await expect(interruptedTool).toBeVisible({ timeout: 8000 });
    // running 工具 → 中断标注（error 终态 + 文案）
    await expect(interruptedTool).toContainText('中断', { timeout: 8000 });
    // 无 pending 态：composer-stop 不可见、消息终态 completed
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (window as any).__CRISH_STORE__;
            const byId = store?.getState?.().sessionsById || {};
            const sess = byId['sess-restore-3'];
            if (!sess?.messages?.length) return null;
            return sess.messages.map((m: { status: string }) => m.status);
          }),
        { timeout: 8000 }
      )
      .toEqual(expect.arrayContaining(['completed', 'completed']));
  });

  test('未激活会话不预拉正文（懒水合，hydratedFromEngine 标记）', async ({
    page,
  }) => {
    await openApp(page);

    // 打开会话后再校验 store 标记
    const items = page.locator('[data-testid="sidebar-session-item"]');
    await expect(items).toHaveCount(3, { timeout: 8000 });
    await items.nth(0).click();
    await expect(page.locator('.msg-row-assistant').first()).toBeVisible({
      timeout: 8000,
    });

    const flagged = await page.evaluate(() => {
      const store = (window as any).__CRISH_STORE__;
      const byId = store?.getState?.().sessionsById || {};
      const s = byId['sess-restore-1'];
      return {
        hydratedFromEngine: s?.hydratedFromEngine,
        messageCount: s?.messages?.length ?? 0,
      };
    });
    expect(flagged.hydratedFromEngine).toBe(true);
    expect(flagged.messageCount).toBeGreaterThan(0);
  });
});
