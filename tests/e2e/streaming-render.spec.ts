/**
 * E2E-L2 场景 ④：流式渲染专项（fence 软渲染 → 完成态收敛）
 * （PE-11 T11.1 必覆盖场景 4）
 *
 * 现状说明（E2.1 增量渲染接线前）：流式期 UI 为纯文本 div
 * （`.md-rendered.is-streaming`，AsyncMarkdownBlock.tsx:51-59），
 * 完成态经 Rust `md_render` 权威渲染（mock 引擎提供确定性 HTML）。
 * 本 spec 断言当前协议的等价行为：
 *   1. 流式期文本逐条累积（delta 拼接 = 全文，PE-02 T2 收敛性语义）
 *   2. 流式期未闭合 fence 以纯文本保留（软渲染前置态，无整篇闪烁）
 *   3. 完成态收敛为结构性渲染（pre/code 代码块，PE-02 T02.4 语义）
 *   4. 完成态移除 is-streaming 标记（无 pending 态）
 */

import { test, expect, type Page } from '@playwright/test';
import {
  installMockEngine,
  fenceRunEvents,
  tableRunEvents,
} from './mock-engine';

async function openApp(
  page: Page,
  runStream: Parameters<typeof installMockEngine>[1]
) {
  await installMockEngine(page, runStream);
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
}

async function sendAndGetAssistantRow(page: Page, prompt: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await input.fill(prompt);
  await input.press('Enter');
  const assistantRow = page.locator('.msg-row-assistant').first();
  await expect(assistantRow).toBeVisible();
  return assistantRow;
}

test.describe('E2E-L2 流式渲染（streaming-render）', () => {
  test('fence：流式期软渲染 → 完成态收敛为代码块结构', async ({ page }) => {
    await openApp(page, {
      runStream: { events: fenceRunEvents(), delayMs: 150 },
    });
    const assistantRow = await sendAndGetAssistantRow(page, '给我一段代码');

    // ── ① 流式期：纯文本软渲染，delta 逐条累积 ──
    // 前两条 delta（含未闭合 fence）先落地：流式容器出现且含 fence 原文
    // （AsyncMarkdownBlock 以 data-streaming="true" 标记流式块；is-streaming
    //   为 CSS Modules hashed 类名，不可按字面断言）
    const streamingText = assistantRow.locator(
      '.md-rendered[data-streaming="true"]'
    );
    await expect(streamingText.first()).toBeVisible({ timeout: 5000 });
    await expect(streamingText.first()).toContainText('示例代码：', {
      timeout: 5000,
    });
    // fence 未闭合期间：文本原样保留（软渲染态，无整篇替换闪烁）
    await expect(streamingText.first()).toContainText('const x = 1;', {
      timeout: 5000,
    });

    // ── ② 完成态收敛：md_render 权威渲染 → pre/code 结构 ──
    const finalBlock = assistantRow.locator(
      '.md-rendered[data-streaming="false"]'
    );
    await expect(finalBlock.first()).toBeVisible({ timeout: 8000 });
    await expect(finalBlock.first().locator('pre code')).toBeVisible({
      timeout: 8000,
    });
    // 代码内容收敛完整（未闭合 fence 完成闭合）
    await expect(finalBlock.first().locator('pre code')).toContainText(
      'const y = x + 1;'
    );

    // ── ③ 无 pending 态 ──
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 8000,
    });
    // 流式标记消失（流式块卸载 / data-streaming 移除）
    await expect(
      assistantRow.locator('.md-rendered[data-streaming="true"]')
    ).toHaveCount(0);
  });

  test('delta 收敛性：流式累积文本 == 完成态全文（PE-02 T2）', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: { events: fenceRunEvents(), delayMs: 120 },
    });
    const assistantRow = await sendAndGetAssistantRow(page, '再试一次');

    // 完成态：md_render HTML 的纯文本（去标签）应包含全部 delta 内容
    const finalBlock = assistantRow.locator(
      '.md-rendered[data-streaming="false"]'
    );
    await expect(finalBlock.first()).toBeVisible({ timeout: 8000 });
    const htmlText = await finalBlock.first().innerText();
    expect(htmlText).toContain('示例代码：');
    expect(htmlText).toContain('const x = 1;');
    expect(htmlText).toContain('const y = x + 1;');
  });

  test('表格：完成态渲染为 table 结构', async ({ page }) => {
    await openApp(page, {
      runStream: { events: tableRunEvents(), delayMs: 60 },
    });
    const assistantRow = await sendAndGetAssistantRow(page, '做个表格');

    const finalBlock = assistantRow.locator(
      '.md-rendered[data-streaming="false"]'
    );
    await expect(finalBlock.first()).toBeVisible({ timeout: 8000 });
    await expect(finalBlock.first().locator('table')).toBeVisible();
    await expect(finalBlock.first().locator('th')).toHaveCount(2);
    await expect(finalBlock.first().locator('td')).toHaveCount(4);
  });
});
