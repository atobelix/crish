/**
 * E2E-L2 工具流式协议专项（TOOLS-01 S1 §3.1.5；A4 第三波交付）。
 *
 * 覆盖（任务书 §3.1.8 集成验收的 e2e 层）：
 *   1. 严格契约形状（sessionId/batchId/timestamp 信封齐全）：
 *      tool-batch-start → tool-start → tool-update×N → tool-end →
 *      tool-batch-end → run-terminal 全链出站，前端逐事件消费不炸；
 *   2. ToolUpdate 展示面语义（§3.1.5）：update.text（进度文本）不混入
 *      消息历史，终值仅由 ToolEnd 承载（ToolEnd 是模型回投唯一来源）；
 *   3. 宽容形态（缺信封字段 / update 畸形）经 eventParser 归一器兜底，
 *      不登记 unknown-case（engine-unknown-event 可观测面为空）。
 *
 * UI 现状：tool-update 尚无 UI 消费面（toolHandlers.onToolUpdate 为显式
 * 空实现），本 spec 断言其被宽容解析且无 console error / unknown 登记
 * （可观测性面），不断言进度文本渲染。
 *
 * 断言基建：console 监听收集 error / engine-unknown-event（EventRouter
 * registerUnknownEvent → logInternalError → console.warn 前缀），
 * 全用例收口断言为空。
 */
import { test, expect, type Page } from '@playwright/test';
import { typeIntoComposer } from './helpers/boot';
import {
  installMockEngine,
  toolStreamingRunEvents,
  toolStreamingLenientRunEvents,
} from './mock-engine';

/** 收集页面 console error 与 unknown-case 登记（registerUnknownEvent 可观测面） */
function collectConsoleIssues(page: Page): string[] {
  const issues: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') issues.push(`console.error: ${msg.text()}`);
    else if (
      msg.type() === 'warn' &&
      msg.text().includes('engine-unknown-event')
    ) {
      issues.push(`console.warn: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => issues.push(`pageerror: ${err.message}`));
  return issues;
}

async function openApp(
  page: Page,
  config: Parameters<typeof installMockEngine>[1]
) {
  await installMockEngine(page, config);
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
    timeout: 20000,
  });
}

async function sendPrompt(page: Page, prompt: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await typeIntoComposer(page, prompt);
  await input.press('Enter');
  const assistantRow = page.locator('.msg-row-assistant').first();
  await expect(assistantRow).toBeVisible({ timeout: 10000 });
  return assistantRow;
}

test.describe('E2E-L2 工具流式协议（tool-streaming）', () => {
  test('严格契约：tool-start → tool-update×N → tool-end 全链出站，ToolUpdate 不进消息历史', async ({
    page,
  }) => {
    const issues = collectConsoleIssues(page);
    await openApp(page, {
      runStream: { events: toolStreamingRunEvents(), delayMs: 120 },
    });
    const assistantRow = await sendPrompt(page, '执行构建并报告进度');

    // ── ① tool-start/tool-end → 工具行渲染，终值由 ToolEnd 承载 ──
    const toolRow = assistantRow.locator(
      '.tool-stack .tool-row[data-tool-id="tool-s1"]'
    );
    await expect(toolRow).toBeVisible({ timeout: 8000 });
    // 无 explanation 时 label 从命令人类化（toolCardPresenter: npm run build → 构建项目）
    await expect(toolRow).toHaveAttribute('data-tool-label', '构建项目');
    await expect(toolRow).toContainText('build ok', { timeout: 8000 });

    // ── ② ToolUpdate 展示面语义：进度文本不混入消息历史 ──
    // update.text（构建进度 1/3…）只出现在工具事件流，不进 assistant 文本
    await expect(assistantRow).toContainText('构建完成。', { timeout: 8000 });
    for (const progress of ['构建进度 1/3', '构建进度 2/3', '构建进度 3/3']) {
      await expect(assistantRow).not.toContainText(progress);
    }
    // 终值输出是 ToolEnd 的 build ok，而非任一进度块
    await expect(toolRow).not.toContainText('构建进度');

    // ── ③ 收口：run-terminal → 无 pending 态 ──
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 8000,
    });

    // ── ④ 全链消费可观测面：无 console error / unknown-case 登记 ──
    expect(issues).toEqual([]);
  });

  test('宽容形态：缺信封字段 + text/json/metadata 三形态 + update 畸形兜底不炸', async ({
    page,
  }) => {
    const issues = collectConsoleIssues(page);
    await openApp(page, {
      runStream: { events: toolStreamingLenientRunEvents(), delayMs: 120 },
    });
    const assistantRow = await sendPrompt(page, '检查工作区');

    // 宽容 tool-start（平铺 id/name/args）→ 工具行仍渲染
    const toolRow = assistantRow.locator(
      '.tool-stack .tool-row[data-tool-id="tool-l1"]'
    );
    await expect(toolRow).toBeVisible({ timeout: 8000 });
    await expect(toolRow).toContainText('检查工作区');
    // 宽容 tool-end（toolCallId 别名 + output 字符串归一）→ 终值渲染
    await expect(toolRow).toContainText('clean', { timeout: 8000 });

    // 宽容 tool-update 三形态（text 缺 metadata / json / update 非对象）
    // 均被消费：assistant 文本不含 update.text，run 正常收口
    await expect(assistantRow).toContainText('工作区干净。', { timeout: 8000 });
    await expect(assistantRow).not.toContainText('检查中…');
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 8000,
    });

    expect(issues).toEqual([]);
  });

  test('多块 update 逐块到达：流式中间态 run 保持进行，终态收敛无 pending', async ({
    page,
  }) => {
    const issues = collectConsoleIssues(page);
    // delayMs 拉开到 300：断言中间态（run 未收口）期间工具行已渲染
    await openApp(page, {
      runStream: { events: toolStreamingRunEvents(), delayMs: 300 },
    });
    await sendPrompt(page, '再跑一次构建');

    const toolRow = page
      .locator('.tool-stack .tool-row[data-tool-id="tool-s1"]')
      .first();
    await expect(toolRow).toBeVisible({ timeout: 8000 });

    // 中间态：message-end 未到 → composer-stop（进行中）可见；
    // 若 tool-update 消费链路抛错，tool 行会先消失或 pageerror 被收集
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible({
      timeout: 8000,
    });

    // 终态收敛：无 pending、工具行终值渲染
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 10000,
    });
    await expect(toolRow).toContainText('build ok', { timeout: 8000 });

    expect(issues).toEqual([]);
  });
});
