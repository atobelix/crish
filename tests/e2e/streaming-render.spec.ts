/**
 * E2E-L2 场景 ④：流式 Markdown HTML 渲染 → 完成态收敛
 * （PE-11 T11.1 必覆盖场景 4）
 *
 * 覆盖流式期间源码不泄漏、标题/列表/强调/未闭合代码围栏都输出结构化 HTML，
 * 最终内容完整收敛，且不遗留 active 块。
 */

import { test, expect, type Page } from '@playwright/test';
import {
  openApp as bootOpenApp,
  startNewSession,
  typeIntoComposer,
} from './helpers/boot';
import {
  fenceRunEvents,
  streamingTableRunEvents,
  tableRunEvents,
} from './mock-engine';

async function openApp(
  page: Page,
  runStream: Parameters<typeof bootOpenApp>[1]
) {
  await bootOpenApp(page, runStream);
}

async function sendAndGetAssistantRow(page: Page, prompt: string) {
  await startNewSession(page);
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toBeVisible({ timeout: 20000 });
  await typeIntoComposer(page, prompt);
  await input.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__CRISH_E2E__?.getState?.().lastRun)
    )
    .not.toBeNull();
  const assistantRow = page.locator('.msg-row-assistant').first();
  await expect(assistantRow).toBeVisible({ timeout: 10000 });
  return assistantRow;
}

async function waitForMockEvent(
  page: Page,
  expected: { type: string; textIncludes?: string }
) {
  await expect
    .poll(
      () =>
        page.evaluate((target) => {
          const history = (window as any).__CRISH_E2E__?.getState?.().eventHistory;
          return Array.isArray(history) && history.some((event: any) => {
            if (event.type !== target.type) return false;
            return target.textIncludes === undefined ||
              String(event.block?.text ?? '').includes(target.textIncludes);
          });
        }, expected),
      { timeout: 12000 }
    )
    .toBe(true);
}

test.describe('E2E-L2 流式渲染（streaming-render）', () => {
  test('Markdown：流式期结构化渲染且不显示源码 → 完成态收敛', async ({ page }) => {
    await openApp(page, {
      // 每个事件间留出可观测窗口；断言必须在未闭合 fence 的 active 块中
      // 看到第二行代码，再由后续 message-end 验证完成态收敛。
      runStream: { events: fenceRunEvents(), delayMs: 1000 },
    });
    const assistantRow = await sendAndGetAssistantRow(page, '给我一段代码');

    // ── ① 流式期：标题、列表、强调均为结构化 HTML ──
    await expect(assistantRow.locator('h1').first()).toContainText(
      '流式 Markdown',
      { timeout: 8000 }
    );
    await expect(assistantRow.locator('h1').first()).toBeVisible();
    await expect(assistantRow.locator('li strong').first()).toHaveText(
      '列表项',
      { timeout: 8000 }
    );
    await expect(assistantRow.locator('li strong').first()).toBeVisible();

    const streamingText = assistantRow.locator(
      '.md-rendered[data-streaming="true"]'
    );
    const liveCode = streamingText.locator('pre code');
    await expect(liveCode).toBeVisible({ timeout: 8000 });
    await expect(liveCode).toContainText('const x = 1;', { timeout: 8000 });
    await expect(liveCode).not.toContainText('```');
    await expect(streamingText).not.toContainText('## 流式 Markdown');
    await expect(liveCode).toContainText('const y = x + 1;', {
      timeout: 8000,
    });
    const renderedMarkup = await assistantRow
      .locator('.md-rendered')
      .evaluateAll((blocks) => blocks.map((block) => block.innerHTML).join('\n'));
    expect(renderedMarkup).not.toContain('## 流式 Markdown');
    expect(renderedMarkup).not.toContain('- **列表项**');
    expect(renderedMarkup).not.toContain('**列表项**');
    expect(renderedMarkup).not.toContain('```');

    // ── ② 完成态收敛：md_render 权威渲染 → pre/code 结构 ──
    const finalBlocks = assistantRow.locator(
      '.md-rendered[data-streaming="false"]'
    );
    const finalCode = finalBlocks
      .locator('pre code')
      .filter({ hasText: 'const y = x + 1;' });
    await expect(finalCode).toHaveCount(1, { timeout: 8000 });
    await expect(finalCode).toBeVisible({ timeout: 8000 });
    // 代码内容收敛完整（未闭合 fence 完成闭合）
    await expect(finalCode).toContainText('const x = 1;');
    await expect(finalCode).toContainText('const y = x + 1;');

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
    const finalBlocks = assistantRow.locator(
      '.md-rendered[data-streaming="false"]'
    );
    const renderedProse = finalBlocks.filter({ hasText: '示例代码：' });
    await expect(renderedProse).toHaveCount(1, { timeout: 8000 });
    await expect(renderedProse).toBeVisible();
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
      timeout: 8000,
    });
    await expect(renderedProse).toContainText('示例代码：');
    const renderedCode = finalBlocks
      .locator('pre code')
      .filter({ hasText: 'const x = 1;' });
    await expect(renderedCode).toHaveCount(1);
    await expect(renderedCode).toBeVisible();
    await expect(renderedCode).toContainText('const x = 1;');
    await expect(renderedCode).toContainText('const y = x + 1;');
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
    const finalTables = finalBlock.locator('table');
    await expect(finalTables).toHaveCount(1);
    await expect(finalTables).toBeVisible();
    await expect(finalTables.locator('th')).toHaveCount(2);
    await expect(finalTables.locator('td')).toHaveCount(4);
  });

  test('表格：数据行到达时立即增量渲染为原生 HTML，源码不进入 DOM', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: {
        events: streamingTableRunEvents(),
        eventDelaysMs: [100, 100, 200, 1200, 1800, 400, 5000, 100],
      },
    });
    const assistantRow = await sendAndGetAssistantRow(page, '逐行生成任务表格');
    const liveBlock = assistantRow.locator(
      '.md-rendered[data-streaming="true"]'
    );
    const liveTable = liveBlock.locator('table.md-table');

    await expect(liveTable).toBeVisible({ timeout: 8000 });
    await expect(liveTable.locator('thead th')).toHaveText([
      '任务编号',
      '任务名称',
    ]);
    await expect(liveTable.locator('tbody tr')).toHaveCount(1, {
      timeout: 8000,
    });
    await expect(liveTable.locator('tbody tr').first().locator('td')).toHaveText([
      'TASK-001',
      '需求调研',
    ]);
    const firstRowLocator = liveTable.locator('tbody tr').first();
    const firstRowHandle = await firstRowLocator.elementHandle();
    expect(firstRowHandle).not.toBeNull();
    await firstRowHandle!.evaluate((row) => {
      (window as any).__CRISH_E2E__.streamingTableFirstRow = row;
    });
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible();

    // 第二条数据仍在流中时追加到现有表格；第一行保持为独立已渲染 DOM 行。
    await waitForMockEvent(page, { type: 'message-delta', textIncludes: 'TASK-002' });
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible();
    await expect(liveTable.locator('tbody tr')).toHaveCount(2, {
      timeout: 8000,
    });
    await expect(liveTable.locator('tbody tr').nth(1).locator('td')).toHaveText([
      'TASK-002',
      '原型设计',
    ]);
    const appendedFirstRowIdentity = await firstRowLocator.evaluate((row) => ({
      sameNode:
        row === (window as any).__CRISH_E2E__?.streamingTableFirstRow,
      connected: row.isConnected,
    }));
    expect(appendedFirstRowIdentity).toEqual({
      sameNode: true,
      connected: true,
    });
    await waitForMockEvent(page, { type: 'message-delta', textIncludes: '表格后说明：' });
    await expect(
      liveBlock.locator('[data-streaming-table-trailing] strong')
    ).toHaveText('实时生成文字');
    await expect(liveBlock).toContainText('表格后说明：');

    const readTable = (table: HTMLTableElement) => {
      const cell = (node: HTMLTableCellElement) => ({
        text: node.textContent?.trim() ?? '',
        align: node.style.textAlign || 'left',
      });
      return {
        headers: Array.from(table.querySelectorAll('thead th'), (node) =>
          cell(node as HTMLTableCellElement)
        ),
        rows: Array.from(table.querySelectorAll('tbody tr'), (row) =>
          Array.from(row.querySelectorAll('td'), (node) =>
            cell(node as HTMLTableCellElement)
          )
        ),
      };
    };
    const liveTableState = await liveTable.evaluate(readTable);

    const liveMarkup = await liveBlock.evaluate((block) => block.innerHTML);
    expect(liveMarkup).not.toContain('| 任务编号 | 任务名称 |');
    expect(liveMarkup).not.toContain('| --- | :---: |');
    expect(liveMarkup).not.toContain('| TASK-001 |');
    expect(liveMarkup).not.toContain('| TASK-002 |');
    expect(liveMarkup).not.toContain('**需求调研**');
    expect(liveMarkup).not.toContain('**实时生成文字**');
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible();

    await liveBlock.evaluate((block) => {
      const assistant = block.closest('.msg-row-assistant');
      if (!assistant) throw new Error('assistant row missing during table handoff');
      const handle = (window as any).__CRISH_E2E__;
      handle.state.streamingTableHandoffHadGap = false;
      handle.streamingTableObserver = new MutationObserver(() => {
        if (!assistant.querySelector('.md-rendered table')) {
          handle.state.streamingTableHandoffHadGap = true;
        }
      });
      handle.streamingTableObserver.observe(assistant, {
        childList: true,
        subtree: true,
      });
    });

    const messageEndArrivedBeforeObservation = await page.evaluate(() => {
      const history = (window as any).__CRISH_E2E__?.getState?.().eventHistory ?? [];
      return history.some((event: any) => event.type === 'message-end');
    });
    expect(messageEndArrivedBeforeObservation).toBe(false);
    await waitForMockEvent(page, { type: 'message-end' });

    const finalBlock = assistantRow.locator(
      '.md-rendered[data-streaming="false"]'
    );
    await expect(finalBlock.locator('table')).toBeVisible({
      timeout: 8000,
    });
    await expect(finalBlock.locator('tbody tr')).toHaveCount(2);
    const sealedFirstRowIdentity = await finalBlock
      .locator('tbody tr')
      .first()
      .evaluate((row) => ({
        sameNode:
          row === (window as any).__CRISH_E2E__?.streamingTableFirstRow,
        connected: row.isConnected,
      }));
    expect(sealedFirstRowIdentity).toEqual({
      sameNode: true,
      connected: true,
    });
    const finalTableState = await finalBlock.locator('table').evaluate(readTable);
    expect(finalTableState).toEqual(liveTableState);
    await expect(finalBlock).toContainText('表格后说明：');
    await expect(
      assistantRow.locator('.md-rendered[data-streaming="true"]')
    ).toHaveCount(0);
    const handoffHadGap = await page.evaluate(() => {
      const handle = (window as any).__CRISH_E2E__;
      handle.streamingTableObserver?.disconnect();
      return handle.state.streamingTableHandoffHadGap;
    });
    expect(handoffHadGap).toBe(false);
  });
});
