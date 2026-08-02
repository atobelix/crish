/**
 * Visual 回归门禁（PE-11 T11.2）—— 8 个首版 story。
 *
 * 稳定化：mock 引擎（禁动画）+ 固定 viewport（config 1280×800）+
 * `document.fonts.ready`（helpers.openVisualApp）。
 * 阈值：`toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`（1% 像素差）。
 * 基线：`tests/visual/__screenshots__/`（git 入库）；更新命令
 * `npm --workspace @crish/crish-desktop run test:visual:update`。
 * 负例验证：人为改坏主色 → 套件失败（阈值生效）。
 *
 * 与 F5 snapshot 层不重叠：渲染树快照归 `tests/snapshots`，本套件只做像素级。
 *
 * 8 story（T11.2-3）：
 *   01 初始布局（侧栏+主区空态）
 *   02 侧栏会话列表（3 会话 mock）
 *   03 设置面板（模型 tab）
 *   04 聊天消息（纯文本完成态）
 *   05 fence 代码块（含未闭合软渲染态 + 完成态）
 *   06 表格
 *   07 工具调用卡
 *   08 暗色主题（prefers-color-scheme + 主题设置）
 */

import { test, expect } from '@playwright/test';
import {
  openVisualApp,
  sendPrompt,
  waitStreamFinal,
  textOnlyEvents,
  toolCallEvents,
  sessionListSeed,
  fenceRunEvents,
  tableRunEvents,
  screenshotOptions,
} from './helpers';

test.describe('Visual Regression（8 story）', () => {
  test('01 初始布局：侧栏 + 主区空态', async ({ page }) => {
    await openVisualApp(page);
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
    await expect(page).toHaveScreenshot(
      'story-01-initial-layout.png',
      screenshotOptions()
    );
  });

  test('02 侧栏会话列表：3 会话 mock', async ({ page }) => {
    await openVisualApp(page, sessionListSeed().config);
    const items = page.locator('[data-testid="sidebar-session-item"]');
    await expect(items).toHaveCount(3, { timeout: 8000 });
    await expect(page).toHaveScreenshot(
      'story-02-session-list.png',
      screenshotOptions()
    );
  });

  test('03 设置面板：模型 tab', async ({ page }) => {
    await openVisualApp(page);
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('[data-testid="quick-settings-all"]').click();
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
    await page.locator('[data-testid="settings-tab-models"]').click();
    await expect(page).toHaveScreenshot(
      'story-03-settings-models.png',
      screenshotOptions()
    );
  });

  test('04 聊天消息：纯文本完成态', async ({ page }) => {
    await openVisualApp(page, {
      runStream: { events: textOnlyEvents(), delayMs: 60 },
    });
    await sendPrompt(page, '写一段说明');
    await waitStreamFinal(page);
    const finalBlock = page.locator('.md-rendered:not(.is-streaming)').first();
    await expect(finalBlock).toBeVisible();
    await expect(finalBlock).toContainText('这是一条纯文本回复');
    await expect(page).toHaveScreenshot(
      'story-04-chat-text.png',
      screenshotOptions()
    );
  });

  test('05 fence 代码块：未闭合软渲染态 + 完成态', async ({ page }) => {
    await openVisualApp(page, {
      runStream: { events: fenceRunEvents(), delayMs: 200 },
    });
    await sendPrompt(page, '给我一段代码');

    // 软渲染态：流式期截图（未闭合 fence 原样保留）
    const streamingText = page.locator('.md-rendered.is-streaming').first();
    await expect(streamingText).toBeVisible({ timeout: 5000 });
    await expect(streamingText).toContainText('const x = 1;');
    await expect(page).toHaveScreenshot(
      'story-05-fence-streaming.png',
      screenshotOptions()
    );

    // 完成态：收敛为代码块结构
    await waitStreamFinal(page);
    const finalBlock = page.locator('.md-rendered:not(.is-streaming)').first();
    await expect(finalBlock.locator('pre code')).toBeVisible({ timeout: 8000 });
    await expect(page).toHaveScreenshot(
      'story-05-fence-final.png',
      screenshotOptions()
    );
  });

  test('06 表格完成态', async ({ page }) => {
    await openVisualApp(page, {
      runStream: { events: tableRunEvents(), delayMs: 60 },
    });
    await sendPrompt(page, '做个表格');
    await waitStreamFinal(page);
    const finalBlock = page.locator('.md-rendered:not(.is-streaming)').first();
    await expect(finalBlock.locator('table')).toBeVisible();
    await expect(page).toHaveScreenshot(
      'story-06-table.png',
      screenshotOptions()
    );
  });

  test('07 工具调用卡', async ({ page }) => {
    await openVisualApp(page, {
      runStream: { events: toolCallEvents(), delayMs: 60 },
    });
    await sendPrompt(page, '执行构建');
    await waitStreamFinal(page);
    const toolRow = page.locator(
      '.tool-stack .tool-row[data-tool-id="tool-vis-1"]'
    );
    await expect(toolRow).toBeVisible({ timeout: 8000 });
    await expect(page).toHaveScreenshot(
      'story-07-tool-call.png',
      screenshotOptions()
    );
  });

  test('08 暗色主题', async ({ page }) => {
    // prefers-color-scheme 注入（T11.2-3）+ 主题设置 dark（应用真实路径）
    await page.emulateMedia({ colorScheme: 'dark' });
    await openVisualApp(page, {
      getSettings: {
        defaultModel: 'gpt-4o',
        defaultThinkingLevel: 'medium',
        theme: 'dark',
      },
      runStream: { events: textOnlyEvents(), delayMs: 60 },
    });
    await sendPrompt(page, '暗色主题下的回复');
    await waitStreamFinal(page);
    // 主题属性生效（themeStore 应用 settings.theme）
    const theme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(theme).toBe('dark');
    await expect(page).toHaveScreenshot(
      'story-08-dark-theme.png',
      screenshotOptions()
    );
  });
});
