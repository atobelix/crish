/**
 * e2e 公共 boot 就绪 helper（G15c 冷启动基建）。
 *
 * 统一「应用首屏就绪」等待语义（原 full-journey.spec.ts openApp 模式）：
 *   transport waitUntilConnected（core_get_status 轮询）完成后 UI 门闩放行
 *   （应用容器 data-engine-ready 属性由 useEngineBootstrap 驱动）。
 *
 * 超时分层：webServer 启动 180s > 用例超时 30s > 本 helper 就绪断言 8s。
 * 各 spec 首屏等待一律走 openApp，禁止散落硬编码 sleep。
 */
import { expect, type Page } from '@playwright/test';
import { installMockEngine } from '../mock-engine';

export type MockEngineConfig = Parameters<typeof installMockEngine>[1];

/** 安装 mock 引擎并等待应用首屏 + 引擎门闩就绪 */
export async function openApp(page: Page, config: MockEngineConfig = {}) {
  await installMockEngine(page, config);
  await page.goto('/');
  // 首屏与侧栏等待放宽至 15s：冷启动时 vite 首屏编译可能远超默认 5s
  // （系统性收口 2026-08-04：cache-metrics/cache-telemetry 冷启动 boot 超时修复）
  await expect(page.locator('#root')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({
    timeout: 15000,
  });
  // 引擎门闩：应用容器 data-engine-ready 属性由 useEngineBootstrap 驱动
  await expect(page.locator('[data-engine-ready="true"]')).toBeVisible({
    timeout: 8000,
  });
}

/**
 * 条件等待 store 更新循环收敛（替代固定 sleep）：
 * 连续两次读数一致即视为响应式更新稳定；若更新循环持续（死循环回归），
 * 轮询超时失败 —— 保持 ui-store-invariants 的频次断言语义。
 */
export async function waitForStoreSettled(page: Page, timeoutMs = 4000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const read = () => (window as any).__storeUpdateCount || 0;
          const first = read();
          // 两次读数间隔 80ms，用于区分「稳定」与「仍在更新」
          await new Promise((resolve) => setTimeout(resolve, 80));
          const second = read();
          return first === second ? second : -1;
        }),
      { timeout: timeoutMs }
    )
    .not.toBe(-1);
}
