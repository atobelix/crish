/**
 * Visual 回归稳定化 helper（PE-11 T11.2-1 稳定化三件套）。
 *
 * - mock Tauri invoke：复用 T11.1 L2 mock 引擎（tests/e2e/mock-engine.ts）；
 * - 固定 viewport：由 `apps/crish-desktop/playwright.config.ts` 统一声明
 *   （1280×800 / deviceScaleFactor 1）；
 * - 稳定化：`document.fonts.ready` 等待 + 全局禁动画 CSS
 *   （mock 引擎 disableAnimations 注入 `*{animation:none!important}`）。
 *
 * 基线：`toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`（1% 阈值，
 * 容忍抗锯齿抖动）；基线入库 `tests/visual/__screenshots__/`（git 提交）。
 */

import { expect, type Page } from '@playwright/test';
import {
  installMockEngine,
  fullJourneyRunEvents,
  fenceRunEvents,
  tableRunEvents,
  restoreSessions,
  restoreSessionIndexSeed,
  type MockEngineConfig,
  type MockEvent,
} from '../../../../tests/e2e/mock-engine';

/** 纯文本旅程（无工具调用，story-04 用） */
export function textOnlyEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '这是一条纯文本回复，用于视觉基线。' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '第二行追加内容。' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '这是一条纯文本回复，用于视觉基线。第二行追加内容。',
        blocks: [
          {
            type: 'text',
            text: '这是一条纯文本回复，用于视觉基线。第二行追加内容。',
          },
        ],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/** 工具调用旅程（story-07 用） */
export function toolCallEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '开始执行构建验证。' },
    },
    {
      type: 'tool-start',
      id: 'tool-vis-1',
      name: 'bash',
      args: 'npm run build',
      explanation: '构建验证',
    },
    {
      type: 'tool-end',
      result: { id: 'tool-vis-1', output: 'build OK (12.4s)', isError: false },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '构建通过，产物已就绪。' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '开始执行构建验证。构建通过，产物已就绪。',
        blocks: [
          { type: 'text', text: '开始执行构建验证。构建通过，产物已就绪。' },
        ],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/** 会话列表种子（story-02 用；含 3 会话） */
export function sessionListSeed(): { config: MockEngineConfig } {
  return {
    config: {
      sessions: restoreSessions(),
      localStorage: restoreSessionIndexSeed(),
    },
  };
}

/**
 * 安装 visual fixture：mock 引擎（禁动画）+ 打开应用 + 字体就绪。
 * 必须在每个 story 内调用（不可放 beforeEach 之外的共享态）。
 */
export async function openVisualApp(
  page: Page,
  config: MockEngineConfig = {}
): Promise<void> {
  await installMockEngine(page, { disableAnimations: true, ...config });
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  await page.evaluate(() => document.fonts?.ready?.catch(() => undefined));
}

/** 发送一条消息（输入框回车）并返回 assistant 行 */
export async function sendPrompt(page: Page, prompt: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toBeVisible();
  await input.fill(prompt);
  await input.press('Enter');
  const assistantRow = page.locator('.msg-row-assistant').first();
  await expect(assistantRow).toBeVisible();
  return assistantRow;
}

/** 等待流收口（composer-stop 消失 = run 终态） */
export async function waitStreamFinal(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
    timeout: 15_000,
  });
}

/** 阈值统一封装：1% 像素差（T11.2-2）；返回截图调用体 */
export function screenshotOptions() {
  return { maxDiffPixelRatio: 0.01 } as const;
}
