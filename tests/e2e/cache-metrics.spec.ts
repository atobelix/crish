/**
 * E2E-L2 缓存指标（P6 §3.5.1，T-45）：
 * mock 引擎 cache fixture 驱动 → 消息级徽标契约断言（testid 契约登记
 * `cache-metrics-badge` / `session-cache-stats`，以 90-final T-45 与
 * P6 §3.3.3 登记契约为准；CSS 稳定类 `.cache-metrics`）。
 *
 * 数据链路（T-47 数据流 + T-48 接线后的终态）：
 *   message-end（metadata.usage）→ parseUsageFromMetadata →
 *   computeCacheMetrics → SessionMessage.cacheMetrics → CacheMetricsBadge
 *
 * 命中率口径（C9）：hitRate = cacheReadTokens / inputTotal，
 * inputTotal = miss + read + write；fixture 为 Included 形态，
 * inputTotal = promptTokens = 12000 → 75%（9000/12000）。
 *
 * null 语义（P6 §3.6.1 / C15）：metrics === null（未上报/老数据）→ 隐藏
 * 而非显示 0%（0% 会误导）；上报确为 0 → 「未命中」态（用例④口径）。
 *
 * 用例（对齐 P6 §3.5.1 表）：
 *   ① 带 cache fixture 全流程：徽标可见，文本含 75% 与 read/write 数值
 *   ② legacy fixture：徽标不出现、页面无 0% 字样
 *   ③ run-task 缓存域参数：sessionId 存在；promptCacheKey/cacheAffinity 缺省
 *      （P3 裁决采纳该参数扩展前保持缺省断言，采纳后随契约更新）
 *   ④ 命中率边界：cacheRead=0（已上报未命中）→ 「未命中」态而非 0% 误导
 */

import { test, expect, type Page } from '@playwright/test';
import {
  cacheUsageRunEvents,
  legacyNoUsageRunEvents,
  zeroCacheReadRunEvents,
  engineState,
  MOCK_HANDLE,
} from './mock-engine';
import { openApp, typeIntoComposer } from './helpers/boot';

/** 发送一条消息并等待引擎收到 run-task（lastRun 就绪） */
async function sendAndWaitRun(page: Page): Promise<void> {
  const input = page.locator('[data-testid="chat-input"]');
  await expect(input).toBeVisible();
  await typeIntoComposer(page, '触发缓存统计');
  await input.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        (h) => (window as any)[h]?.getState?.().lastRun,
        MOCK_HANDLE
      )
    )
    .not.toBeNull();
}

test.describe('E2E-L2 缓存指标（cache-metrics）', () => {
  test('① 带 cache fixture 全流程：徽标可见，含 75% 与 read/write 数值', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: { events: cacheUsageRunEvents(), delayMs: 30 },
    });
    await sendAndWaitRun(page);

    // message-end 终态后徽标出现（数据路径：metadata.usage → 派生 metrics）
    const badge = page.locator('[data-testid="cache-metrics-badge"]');
    await expect(badge).toBeVisible({ timeout: 8000 });
    // 命中率 75%（9000/12000，Included 形态 inputTotal = promptTokens）
    await expect(badge).toContainText('75%');
    // read/write 数值（toLocaleString 千分位，Chromium 默认 en-US）
    await expect(badge).toContainText('9,000');
    await expect(badge).toContainText('500');
    // CSS 稳定类与 testid 契约并存（README §5 登记）
    await expect(badge).toHaveClass(/cache-metrics/);
  });

  test('② legacy fixture：无 cache 字段 → 徽标不出现、无 0% 误导', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: { events: legacyNoUsageRunEvents(), delayMs: 30 },
    });
    await sendAndWaitRun(page);

    // 消息已收口（legacy 老形态正常渲染正文）
    const assistantRow = page.locator('.msg-row-assistant').first();
    await expect(assistantRow).toBeVisible({ timeout: 8000 });
    await expect(assistantRow).toContainText('不携带缓存计量字段');

    // 徽标不出现（metrics === null → 渲染 null，C15）
    const badge = page.locator('[data-testid="cache-metrics-badge"]');
    await expect(badge).toHaveCount(0);
    // 页面（消息区）无 0% 字样——未上报不得伪装成 0% 命中
    await expect(assistantRow).not.toContainText('0%');
  });

  test('③ run-task 缓存域参数：sessionId 存在、promptCacheKey/cacheAffinity 缺省', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: { events: cacheUsageRunEvents(), delayMs: 30 },
    });
    await sendAndWaitRun(page);

    const lastRun = (await engineState(page)).lastRun as Record<
      string,
      unknown
    >;
    const args = (lastRun.args ?? {}) as Record<string, unknown>;
    // sessionId 必须随请求下发（缓存域标识，R3 键源）
    expect(String(args.sessionId || '')).toBeTruthy();
    // P6 §3.4 契约：P3 裁决前前端不注入缓存域参数 → 缺省（不发送）
    expect(args.promptCacheKey).toBeUndefined();
    expect(args.cacheAffinity).toBeUndefined();
  });

  test('④ 命中率边界：cacheRead=0（已上报未命中）→ 未命中态而非 0% 误导', async ({
    page,
  }) => {
    await openApp(page, {
      runStream: { events: zeroCacheReadRunEvents(), delayMs: 30 },
    });
    await sendAndWaitRun(page);

    // usage 存在且 cacheRead 确为 0 → metrics 非 null → 徽标出现但为未命中态
    const badge = page.locator('[data-testid="cache-metrics-badge"]');
    await expect(badge).toBeVisible({ timeout: 8000 });
    await expect(badge).toContainText('未命中');
    // 未命中态不得显示 0%（0 与 null 可区分，C15）
    await expect(badge).not.toContainText('0%');
  });
});
