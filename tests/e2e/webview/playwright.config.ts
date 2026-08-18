/**
 * CONN-01 · 真 WebView e2e 独立配置（e2e-webview project）
 *
 * 与根 playwright.config.ts 的关系：
 * - 根 config 的 testDir 递归覆盖 tests/e2e → 已在根 config testIgnore
 *   排除本目录（/webview\//），避免 L2 中层（npx playwright test tests/e2e）
 *   误扫需真 Tauri 的 spec；
 * - 本 config 专跑真 WebView（载体重、需 dev:workbench），**不挂 webServer**
 *   （Tauri 应用自带 Vite dev server 与 Rust 引擎，由 npm run dev:workbench
 *   负责拉起）。
 * - webview-smoke：9222 不可达 → cdp.ts fail-fast 可读错误。
 * - mirror-detect（CONN-E2′-tauri）：9222 不可达或无 Host → skip=未交付；
 *   交付主面在 jsdom `Workspace.conn-e2-prime-tauri.test.tsx`。
 * - a-blk-02-slash / conn-b3-e2e / conn-g2-e2e（W6-A-02 等）：9222 不可达 → 同
 *   smoke fail-fast；勿用 jsdom DOM 测关片。
 *
 * CI 归属建议（主控定夺）：进慢层（nightly/发布前）或手动；
 * 不并入 PR 中层（中层无 Tauri 宿主，必红）。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  timeout: 30_000,
  fullyParallel: true,
  workers: 1,
  reporter: [['list']],
  expect: {
    timeout: 8_000,
  },
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'e2e-webview',
      testMatch:
        /(webview-smoke|mirror-detect|a-blk-02-slash|conn-b3-e2e|conn-g2-e2e|conn-h2-open-complete)\.spec\.ts$/,
    },
  ],
});
