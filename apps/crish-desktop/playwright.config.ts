/**
 * crish-desktop Playwright 配置 —— visual 回归专用（PE-11 T11.2）。
 *
 * 双配置归一裁决（T11.1-2）：根 `playwright.config.ts` 为 e2e 唯一入口；
 * 本 config 收敛为 visual 专用（testDir 限 `tests/visual`），
 * 避免 `playwright test` 在 app 目录误扫 F3 层（integration/fuzz/race）。
 *
 * - 固定 viewport 1280×800（基线稳定化三件套之一，T11.2-1）；
 * - 截图阈值由各 spec 内 `toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`
 *   声明（1% 像素差，容忍抗锯齿抖动）；
 * - 基线入库 `tests/visual/__screenshots__/`（提交到 git）；
 * - 更新基线：`npm --workspace @crish/crish-desktop run test:visual:update`。
 *
 * 运行：`npm --workspace @crish/crish-desktop run test:visual`
 * CI 归属：慢层（nightly + 发布前）；PE-05 每个迁移单元提交前必跑（T11.2-4）。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    port: 5174,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
