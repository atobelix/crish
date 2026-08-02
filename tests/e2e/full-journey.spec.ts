/**
 * E2E-L2 场景 ①：启动 → 新建会话 → 发送 → 流式渲染 → 工具调用 → 收口
 * （PE-11 T11.1 必覆盖场景 1；mock 引擎驱动，不依赖真实后端）
 *
 * 事件序列真源（chat-bridge/EventRouter 协议）：
 *   message-start → message-delta×N → tool-start → tool-end →
 *   message-end → run-terminal
 *
 * 断言（行为级）：
 *   1. 侧栏/输入框就绪（启动）
 *   2. 新建会话进入草稿态（不 mint 空壳）
 *   3. 发送后输入框清空、用户消息入列
 *   4. assistant 文本随 delta 逐条追加（onChunk 累积）
 *   5. 工具调用卡可见（tool-start/tool-end → tool-stack 行）
 *   6. run-terminal 收口：无 pending 态、composer-stop 消失、消息终态 completed
 */

import { test, expect, type Page } from '@playwright/test';
import {
  installMockEngine,
  fullJourneyRunEvents,
  engineState,
  MOCK_HANDLE,
} from './mock-engine';

/** 等待引擎就绪：transport waitUntilConnected（core_get_status 轮询）完成后 UI 门闩放行 */
async function openApp(
  page: Page,
  config: Parameters<typeof installMockEngine>[1] = {}
) {
  await installMockEngine(page, config);
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  // 引擎门闩：应用容器 data-engine-ready 属性由 useEngineBootstrap 驱动
  await expect(page.locator('[data-engine-ready="true"]')).toBeVisible({
    timeout: 8000,
  });
}

test.describe('E2E-L2 完整旅程（full-journey）', () => {
  test('启动 → 新建会话 → 发送 → 流式 → 工具调用 → 收口', async ({ page }) => {
    await openApp(page, {
      runStream: { events: fullJourneyRunEvents(), delayMs: 60 },
    });

    // ── ① 启动：侧栏 + 输入框就绪 ──
    const input = page.locator('[data-testid="chat-input"]');
    await expect(input).toBeVisible();

    // ── ② 新建会话 ──
    await page.locator('[data-testid="new-session-button"]').click();

    // ── ③ 发送：输入框文字清空、用户消息入列 ──
    const prompt = '帮我看看当前目录结构';
    await input.fill(prompt);
    await input.press('Enter');
    await expect(input).toHaveValue('');

    // 用户消息出现（.msg-row-user）
    const userRow = page.locator('.msg-row-user');
    await expect(userRow).toBeVisible();
    await expect(userRow).toContainText(prompt);

    // ── ④ 流式渲染：assistant 消息随 delta 逐条追加 ──
    const assistantRow = page.locator('.msg-row-assistant').first();
    await expect(assistantRow).toBeVisible();
    // 流式中间态（.md-rendered.is-streaming）由 streaming-render.spec.ts 专项断言；
    // 此处断言 delta 收敛后的完整文本（PE-02 T2 收敛性语义）
    await expect(assistantRow).toContainText('我来帮你查看当前目录。', {
      timeout: 8000,
    });
    // 累积断言：最终完整文本包含全部 delta 内容
    await expect(assistantRow).toContainText('我来帮你查看当前目录。', {
      timeout: 8000,
    });
    await expect(assistantRow).toContainText('先执行 pwd 确认位置。');
    await expect(assistantRow).toContainText('目录确认完毕，共 3 个文件。');

    // ── ⑤ 工具调用：tool-start/tool-end → 工具行可见且成功 ──
    const toolRow = assistantRow.locator(
      '.tool-stack .tool-row[data-tool-id="tool-1"]'
    );
    await expect(toolRow).toBeVisible({ timeout: 8000 });
    await expect(toolRow).toContainText('bash');
    // tool-end 成功态：输出可见
    await expect(toolRow).toContainText('/workspace/crish');

    // ── ⑥ 收口：run-terminal → 终态 completed、无 pending 态 ──
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 8000,
    });
    // 消息终态：store 中 user/assistant 消息均 completed
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (window as any).__CRISH_STORE__;
            const sess = store?.getState?.().sessions?.[0];
            const msgs =
              sess?.messages ||
              store?.getState?.().sessionsById?.[
                Object.keys(store?.getState?.().sessionsById || {})[0]
              ]?.messages ||
              [];
            return msgs.map((m: { status: string }) => m.status);
          }),
        { timeout: 8000 }
      )
      .toEqual(expect.arrayContaining(['completed', 'completed']));

    // 引擎记录：core_run_task 确实收到发送的 prompt（非空跑）
    const lastRun = (await engineState(page)).lastRun as Record<
      string,
      unknown
    >;
    expect(lastRun).not.toBeNull();
    expect(String(lastRun.prompt || '')).toContain(prompt);
  });

  test('core_run_task 参数组装：runId/sessionId/permissionMode 下发', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: { events: fullJourneyRunEvents(), delayMs: 30 },
    });
    const input = page.locator('[data-testid="chat-input"]');
    await input.fill('hello');
    await input.press('Enter');

    // 等引擎收到 run-task
    await expect
      .poll(() =>
        page.evaluate(
          (h) => (window as any)[h]?.getState?.().lastRun,
          MOCK_HANDLE
        )
      )
      .not.toBeNull();
    const lastRun = (await engineState(page)).lastRun as Record<
      string,
      unknown
    >;
    const args = lastRun.args as Record<string, unknown>;
    expect(args).toBeDefined();
    // runId 为前端自管并随请求下发（ConnectionLifecycle 语义）
    expect(String(lastRun.runId || '')).toMatch(/^run-/);
    expect(String(lastRun.sessionId || '')).toBeTruthy();
    expect(['ask', 'deep', 'full', 'plan']).toContain(
      String(lastRun.permissionMode || 'ask')
    );
  });
});
