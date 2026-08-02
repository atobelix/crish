/**
 * 根 Playwright 配置 —— 前端 e2e 唯一入口（PE-11 T11.1 双配置归一裁决）。
 *
 * - testDir `./tests/e2e`：全旅程 L2 mock 引擎 spec + 行为断言；
 * - projects `e2e-l2`（默认）：mock 引擎层（dev server + __TAURI_INTERNALS__
 *   注入），CI 中层默认全量；`e2e-l3`（真壳 tauri-driver）暂不接线，
 *   保留 project 占位（发布前/nightly 层，见 PE-11 T11.1-3）；
 * - `tauri-native-smoke.spec.ts` 为 vitest 进程级冒烟（`npm run
 *   test:e2e:native`，慢层），不属 Playwright 面 —— testIgnore 排除，
 *   避免 `npx playwright test` 误扫 vitest spec；
 * - visual 回归收敛到 `apps/crish-desktop/playwright.config.ts`（testDir
 *   限 `tests/visual`），本 config 不再扫描 app 目录，职责单一。
 *
 * CI 分层归属（PE-11 §1.3 / T11.7.4）：
 *   中层（PR）→ `npx playwright test tests/e2e`（本 config）
 *   慢层（nightly/发布前）→ visual + native-smoke
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // vitest spec（进程级冒烟）不归 Playwright 管
  testIgnore: /tauri-native-smoke\.spec\.ts$/,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'e2e-l2',
      testMatch: /.*\.spec\.ts$/,
    },
    // E2E-L3 真壳（tauri-driver）发布前层：当前以 tauri-native-smoke（vitest）
    // 进程级冒烟占位；tauri-driver 接线后在此增加 project（见 PE-11 T11.1-3）。
  ],
  webServer: {
    command: 'npm --workspace @crish/crish-desktop run dev',
    port: 5174,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
