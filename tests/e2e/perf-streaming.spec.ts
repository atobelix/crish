/**
 * E2E-L2 性能断言 spec（08-detail 6.3，T5.2，R-14 浏览器端缺口）。
 *
 * 场景（挂根 playwright.config.ts e2e-l2 project，CI 中层）：
 * 1. 流式期 rAF 采样：100KB + 20 工具 mock SSE（delayMs=0 压榨管线），
 *    断言流式期间无 >200ms 长停顿（dev server 余量；06 P1-1 落地后
 *    切 preview 重采基线——07 方案风险 3 登记依赖）；
 * 2. complete 过渡：message-end → 完成态行出现耗时上界；
 * 3. 搜索态 + 流式：侧栏搜索框激活命中扫描后，流式期间无长任务。
 *
 * 基线：本 spec 每次运行将采样值写入 tests/perf/baselines/desktop-l3.json
 * （同机同环境对比口径；CI 断言阈值按该基线比例，07 方案 4.2）。
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { typeIntoComposer } from './helpers/boot';
import { installMockEngine, bigRunEvents } from './mock-engine';

const BASELINE_PATH = resolve('tests/perf/baselines/desktop-l3.json');

interface L3Sample {
  rafIntervalsMs: number[];
  longtasksMs: number[];
  completeMs: number;
}

/** 在页面内安装 rAF 采样 + longtask observer（自包含 IIFE） */
async function installPerfSampler(page: Page, windowMs: number): Promise<void> {
  await page.evaluate(
    ({ ms }) => {
      const w = window as unknown as {
        __perfSample?: { raf: number[]; longtasks: number[]; stop: () => void };
      };
      const raf: number[] = [];
      const longtasks: number[] = [];
      let last = performance.now();
      let alive = true;
      const tick = () => {
        if (!alive) return;
        const now = performance.now();
        raf.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longtasks.push(entry.duration);
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
      const timer = setTimeout(() => {
        alive = false;
        obs.disconnect();
      }, ms);
      w.__perfSample = {
        raf,
        longtasks,
        stop: () => {
          clearTimeout(timer);
          alive = false;
          obs.disconnect();
        },
      };
    },
    { ms: windowMs }
  );
}

async function readSample(page: Page): Promise<{
  raf: number[];
  longtasks: number[];
}> {
  return page.evaluate(() => {
    const s = (window as unknown as { __perfSample?: { raf: number[]; longtasks: number[] } })
      .__perfSample;
    return { raf: s?.raf ?? [], longtasks: s?.longtasks ?? [] };
  });
}

async function openApp(
  page: Page,
  delayMs: number
): Promise<ReturnType<typeof installMockEngine>> {
  const engine = await installMockEngine(page, {
    runStream: { events: bigRunEvents(), delayMs },
  });
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
    timeout: 20000,
  });
  return engine;
}

function saveBaseline(sample: L3Sample): void {
  try {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(sample, null, 2), 'utf8');
  } catch {
    /* 基线落盘尽力而为（CI 只读场景不阻塞断言） */
  }
}

function loadBaseline(): L3Sample | null {
  try {
    if (!existsSync(BASELINE_PATH)) return null;
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as L3Sample;
  } catch {
    return null;
  }
}

test.describe('E2E-L2 性能断言（perf-streaming）', () => {
  test('100KB + 20 工具：流式期无长停顿，complete 收敛，增量文本累积', async ({
    page,
  }) => {
    await openApp(page, 0);
    await installPerfSampler(page, 1500);

    const input = page.locator('[data-testid="chat-input"]');
    await typeIntoComposer(page, '跑一遍性能压测');
    await input.press('Enter');

    // 流式期：增量文本出现（锚点词在首批块内）
    const streamingText = page.locator(
      '.msg-row-assistant .md-rendered[data-streaming="true"]'
    );
    await expect(streamingText.first()).toBeVisible({ timeout: 10000 });
    await expect(streamingText.first()).toContainText('性能压测流式输出', {
      timeout: 5000,
    });

    // 完成态：流式节点卸载、最终块出现
    await expect(
      page.locator('.msg-row-assistant .md-rendered[data-streaming="false"]').first()
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('.msg-row-assistant .md-rendered[data-streaming="true"]')
    ).toHaveCount(0, { timeout: 15000 });
    // 增量累积完整（完成态 HTML 文本包含末段锚点）
    const finalText = await page
      .locator('.msg-row-assistant .md-rendered[data-streaming="false"]')
      .first()
      .innerText();
    expect(finalText).toContain('性能压测流式输出');
    expect(finalText).toContain('marker-119');
    expect(finalText).not.toContain('## 本轮总结');

    // 采样：流式期 + complete 过渡
    const sample = await readSample(page);
    const baseline = loadBaseline();
    const p95Raf =
      [...sample.raf].sort((a, b) => a - b)[
        Math.floor(sample.raf.length * 0.95)
      ] ?? 0;
    const maxLongtask = sample.longtasks.length
      ? Math.max(...sample.longtasks)
      : 0;
    // dev server 余量：>200ms 长任务 = 明显卡顿（06 P1-1 后切 preview 收紧）
    expect(maxLongtask).toBeLessThan(200);
    // rAF p95 帧间隔 < 100ms（≈10fps 下限，远超 60fps 目标余量）
    expect(p95Raf).toBeLessThan(100);
    // 基线对照（同机重跑时相对基线：长任务数 ≤ 基线 ×1.5 + 1）
    if (baseline) {
      expect(sample.longtasks.length).toBeLessThanOrEqual(
        Math.max(1, Math.ceil(baseline.longtasksMs.length * 1.5))
      );
    }
    // 基线落盘（首次运行建立；阈值宽松为 CI 并发降级留量）
    saveBaseline({
      rafIntervalsMs: sample.raf.slice(0, 200),
      longtasksMs: sample.longtasks,
      completeMs: 0,
    });
  });

  test('搜索态 + 流式：命中扫描激活期间无长任务', async ({ page }) => {
    await openApp(page, 0);
    // 经侧栏搜索框激活会话搜索（行为真实注入面，08-detail 风险 ⑧-8 定案）
    const searchInput = page.locator('input[placeholder*="搜索会话与消息"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill('吞吐基线');
    await expect(searchInput).toHaveValue('吞吐基线');

    await installPerfSampler(page, 1500);
    const input = page.locator('[data-testid="chat-input"]');
    await typeIntoComposer(page, '搜索态下跑流式');
    await input.press('Enter');

    await expect(
      page.locator('.msg-row-assistant .md-rendered[data-streaming="true"]').first()
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator('.msg-row-assistant .md-rendered[data-streaming="false"]').first()
    ).toBeVisible({ timeout: 15000 });

    const sample = await readSample(page);
    const maxLongtask = sample.longtasks.length
      ? Math.max(...sample.longtasks)
      : 0;
    expect(maxLongtask).toBeLessThan(200);
  });
});
