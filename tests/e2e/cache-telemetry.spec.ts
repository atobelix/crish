/**
 * P5 e2e 收口（T-48，R6 轮）：缓存遥测展示链路（事件 → store → 组件）。
 *
 * 用例（P5 §5.3 主题 E ①-⑤）：
 *   ① 两次请求命中率上升：fixture1 {prompt:12000, cacheRead:0} → badge 隐藏；
 *      fixture2 {prompt:14000, cacheRead:10500} → badge 75%（10500/14000），
 *      面板 hitRatio 递增、数值累计正确
 *   ② 浪费审计预警：cache-waste-alert（zero-read，21000 tokens）→ 面板归因文案
 *   ③ 冷缓存预警：cache-stats-updated 的 warmUntilMs 设为过去时间 → 冷缓存提示
 *      「下次将重发 ~X tokens」，且每 run 只提示一次
 *   ④ 无 cache 字段（legacy）：badge 不出现、面板空态、无 0% 误导
 *   ⑤ 模型切换归因：cache-waste-alert（model-switch）→ 归因文案 + miss 仍计数
 *
 * fixture 说明：T-45（P6 fixture：cacheUsageRunEvents / legacyNoUsageRunEvents）
 * 与 T-48 同轮并行，若未就位则本 spec 使用最小内联 fixture（shape 与 P6 §3.5
 * 一致：metadata.usage = { promptTokens, completionTokens, cacheReadTokens,
 * cacheWriteTokens, cacheMissTokens }）；T-45 落地后应收敛到 mock-engine.ts 复用。
 */
import { test, expect, type Page } from '@playwright/test';
import { type MockEvent } from './mock-engine';
import { openApp as waitAppReady } from './helpers/boot';

const RUN_DELAY_MS = 30;

/** 消息终态 + run 收口 + 可选 cache 事件的最小 run fixture */
function runEvents(opts: {
  text: string;
  usage?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  alerts?: MockEvent[];
}): MockEvent[] {
  const events: MockEvent[] = [
    { type: 'message-start' },
    { type: 'message-delta', block: { type: 'text', text: opts.text } },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: opts.text,
        blocks: [{ type: 'text', text: opts.text }],
        ...(opts.usage ? { metadata: { usage: opts.usage } } : {}),
      },
    },
  ];
  for (const alert of opts.alerts ?? []) events.push(alert);
  if (opts.stats) {
    events.push({
      type: 'cache-stats-updated',
      stats: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheMissTokens: 0,
        sampleCount: 1,
        missedTokens: 0,
        ...opts.stats,
      },
    });
  }
  events.push({ type: 'run-terminal', terminal: 'completed' });
  return events;
}

/** 用例①：两次请求（命中率上升） */
const run1Events = (): MockEvent[] =>
  runEvents({
    text: '第一轮回复。',
    usage: { promptTokens: 12000, completionTokens: 400, cacheReadTokens: 0 },
    stats: {
      promptTokens: 12000,
      completionTokens: 400,
      totalTokens: 12400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 12000,
      hitRatio: 0,
      writeRatio: 0,
    },
  });

const run2Events = (): MockEvent[] =>
  runEvents({
    text: '第二轮回复。',
    usage: {
      promptTokens: 14000,
      completionTokens: 400,
      cacheReadTokens: 10500,
      cacheWriteTokens: 0,
      cacheMissTokens: 3500,
    },
    stats: {
      promptTokens: 14000,
      completionTokens: 400,
      totalTokens: 14400,
      cacheReadTokens: 10500,
      cacheWriteTokens: 0,
      cacheMissTokens: 3500,
      hitRatio: 0.75,
      writeRatio: 0,
    },
  });

/** 用例②：浪费审计预警（prev read=10000 → cur read=0 断裂，zero-read 归因） */
const wasteAlertEvents = (): MockEvent[] =>
  runEvents({
    text: '缓存断裂回复。',
    usage: { promptTokens: 14000, completionTokens: 300, cacheReadTokens: 0 },
    stats: {
      promptTokens: 14000,
      completionTokens: 300,
      totalTokens: 14300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 14000,
      hitRatio: 0,
      writeRatio: 0,
      missedTokens: 21000,
    },
    alerts: [
      {
        type: 'cache-waste-alert',
        attribution: 'zero-read',
        missedTokens: 21000,
        idleMs: 0,
        modelChanged: false,
        missedCostUsd: 0.0312,
      },
    ],
  });

/** 用例③：冷缓存（warmUntilMs 已过期 → tick 提示，每 run 一次） */
const coldCacheEvents = (): MockEvent[] =>
  runEvents({
    text: '冷缓存回复。',
    usage: {
      promptTokens: 14000,
      completionTokens: 300,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      cacheMissTokens: 9000,
    },
    stats: {
      promptTokens: 14000,
      completionTokens: 300,
      totalTokens: 14300,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      cacheMissTokens: 9000,
      hitRatio: 5000 / 14000,
      writeRatio: 0,
      // 过去时间 → 冷缓存 tick 立即触发
      warmUntilMs: 1000,
    },
  });

/** 用例④：legacy（无 cache 字段） */
const legacyNoUsageEvents = (): MockEvent[] =>
  runEvents({ text: '老形态回复，无 usage。' });

/** 用例⑤：模型切换归因（model-switch 预警 + miss 仍计数） */
const modelSwitchEvents = (): MockEvent[] =>
  runEvents({
    text: '模型切换回复。',
    usage: { promptTokens: 14000, completionTokens: 300, cacheReadTokens: 0 },
    stats: {
      promptTokens: 14000,
      completionTokens: 300,
      totalTokens: 14300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 14000,
      hitRatio: 0,
      writeRatio: 0,
      missedTokens: 14000,
    },
    alerts: [
      {
        type: 'cache-waste-alert',
        attribution: 'model-switch',
        missedTokens: 14000,
        idleMs: 0,
        modelChanged: true,
        missedCostUsd: 0.021,
      },
    ],
  });

async function openApp(
  page: Page,
  events: MockEvent[],
  extra: { runStream?: Record<string, unknown> } = {}
) {
  await waitAppReady(page, {
    runStream: { events, delayMs: RUN_DELAY_MS, ...extra.runStream },
  });
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
  // 新建会话进入草稿态（与 full-journey 同路径）
  await page.locator('[data-testid="new-session-button"]').click();
}

/**
 * 打开运行状态面板（当前壳 UI 路径）：
 * 工具入口 openToolInSession('terminal') 在会话 leaf 打开工具标签 →
 * LeafToolTabStrip 出现「添加功能面板」加号 → 菜单选「运行时」→
 * RuntimePanel 挂载（T-46 挂载点）。
 */
async function openRuntimePanel(page: Page) {
  const terminalBtn = page
    .locator('[data-testid="chat-open-terminal"]')
    .first();
  await expect(terminalBtn).toBeVisible();
  await terminalBtn.click();
  const addBtn = page.locator('[aria-label="添加功能面板"]').first();
  await expect(addBtn).toBeVisible();
  await addBtn.click();
  await page.locator('[role="menuitem"]', { hasText: '运行时' }).click();
  await expect(
    page.locator('[data-testid="session-cache-stats"]')
  ).toBeVisible();
}

async function sendPrompt(page: Page, text: string) {
  const input = page.locator('[data-testid="chat-input"]');
  await input.fill(text);
  await input.press('Enter');
}

/** 等待第 n 条 assistant 消息终态（run-terminal 已处理） */
async function waitForAssistantCount(page: Page, n: number) {
  await expect(page.locator('.msg-row-assistant')).toHaveCount(n, {
    timeout: 15000,
  });
  await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({
    timeout: 15000,
  });
}

async function setNextRunEvents(page: Page, events: MockEvent[]) {
  await page.evaluate(
    ([handle, evs]) => {
      (window as any)[handle].setConfig({
        runStream: { events: evs, delayMs: 30 },
      });
    },
    ['__CRISH_E2E__', events]
  );
}

test.describe('P5 缓存遥测展示链路（cache-telemetry）', () => {
  test('① 两次请求命中率上升：badge 75% + 面板 hitRatio 递增/累计正确', async ({
    page,
  }) => {
    await openApp(page, run1Events());
    // run1：usage 存在但 cacheRead=0（已上报确为 0）→ badge「未命中」态（0 与 null 可区分，C15）
    await sendPrompt(page, '第一轮');
    await waitForAssistantCount(page, 1);
    const firstBadge = page
      .locator('.msg-row-assistant')
      .first()
      .locator('[data-testid="cache-metrics-badge"]');
    await expect(firstBadge).toBeVisible({ timeout: 8000 });
    await expect(firstBadge).toContainText('未命中');
    await expect(firstBadge).not.toContainText('0%');

    // run2：cacheRead=10500 → 第二条 assistant 消息 badge 75%（10500/14000）
    await setNextRunEvents(page, run2Events());
    await sendPrompt(page, '第二轮');
    await waitForAssistantCount(page, 2);
    const secondRow = page.locator('.msg-row-assistant').nth(1);
    await expect(
      secondRow.locator('[data-testid="cache-metrics-badge"]')
    ).toBeVisible({
      timeout: 8000,
    });
    await expect(
      secondRow.locator('[data-testid="cache-metrics-badge"]')
    ).toContainText('缓存命中 75%');
    await expect(
      secondRow.locator('[data-testid="cache-metrics-badge"]')
    ).toContainText('10,500');

    // 面板：cache-stats-updated 累计（read 10500 / inputTotal 26000 → 命中率 40%）
    await openRuntimePanel(page);
    const panel = page.locator('[data-testid="session-cache-stats"]');
    await expect(panel).toContainText('命中率 40%');
    await expect(panel).toContainText('读 10,500');
  });

  test('② 浪费审计预警：cache-waste-alert 归因 + 阈值文案', async ({
    page,
  }) => {
    await openApp(page, wasteAlertEvents());
    await sendPrompt(page, '缓存断裂');
    await waitForAssistantCount(page, 1);
    await openRuntimePanel(page);
    const panel = page.locator('[data-testid="session-cache-stats"]');
    await expect(
      page.locator('[data-testid="cache-waste-alerts"]')
    ).toBeVisible({
      timeout: 8000,
    });
    await expect(panel).toContainText('缓存失效：zero-read');
    await expect(panel).toContainText('浪费 ~21,000 tokens');
    await expect(panel).toContainText('$0.0312');
  });

  test('③ 冷缓存预警：warmUntilMs 过期 → 提示一次「下次将重发 ~X tokens」', async ({
    page,
  }) => {
    await openApp(page, coldCacheEvents());
    await sendPrompt(page, '冷缓存');
    await waitForAssistantCount(page, 1);
    await openRuntimePanel(page);
    const panel = page.locator('[data-testid="session-cache-stats"]');
    // tick 路径：warmUntilMs(1000) < now → 冷缓存提示（inputTotal 14000）
    const hint = page.locator('[data-testid="cold-cache-hint"]');
    await expect(hint).toBeVisible({ timeout: 8000 });
    await expect(hint).toContainText('下次将重发 ~14,000 tokens');
    // 每 run 只提示一次：等待两个 tick 周期（2.5s）观测不重复。
    // 理由：这是「窗口期内不复发」的时长断言，固定等待语义必需，
    // 非冷启动类空等（G15c 豁免：带理由的 waitForTimeout 允许保留）
    await page.waitForTimeout(2500);
    await expect(hint).toHaveCount(1);
    await expect(panel).toContainText('下次将重发 ~14,000 tokens');
  });

  test('④ legacy（无 cache 字段）：badge 不出现、面板空态、无 0% 误导', async ({
    page,
  }) => {
    await openApp(page, legacyNoUsageEvents());
    await sendPrompt(page, '老会话');
    await waitForAssistantCount(page, 1);
    await openRuntimePanel(page);
    const panel = page.locator('[data-testid="session-cache-stats"]');
    await expect(
      page.locator('[data-testid="cache-metrics-badge"]')
    ).toHaveCount(0);
    await expect(panel).toContainText('暂无缓存统计数据');
    // 无 0% 误导：面板区不出现命中率行
    await expect(panel).not.toContainText('命中率');
  });

  test('⑤ 模型切换归因：model-switch 预警 + miss 仍计数', async ({ page }) => {
    await openApp(page, modelSwitchEvents());
    await sendPrompt(page, '切换模型');
    await waitForAssistantCount(page, 1);
    await openRuntimePanel(page);
    const panel = page.locator('[data-testid="session-cache-stats"]');
    await expect(
      page.locator('[data-testid="cache-waste-alerts"]')
    ).toBeVisible({
      timeout: 8000,
    });
    await expect(panel).toContainText('缓存失效：model-switch');
    await expect(panel).toContainText('浪费 ~14,000 tokens');
    // miss 仍计数：read=0 + miss=14000 → inputTotal 计入 → 命中率 0% 显示而非隐藏
    await expect(panel).toContainText('命中率 0%');
  });
});
