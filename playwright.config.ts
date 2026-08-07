/**
 * 根 Playwright 配置 —— 前端 e2e 唯一入口（PE-11 T11.1 双配置归一裁决）。
 *
 * - testDir `./tests/e2e`：全旅程 L2 mock 引擎 spec + 行为断言；
 * - projects `e2e-l2`（默认）：mock 引擎层（dev server + __TAURI_INTERNALS__
 *   注入），CI 中层默认全量；`e2e-l3`（真壳 tauri-driver）暂不接线，
 *   保留 project 占位（发布前/nightly 层，见 PE-11 T11.1-3）；
 * - `tauri-native-smoke.spec.ts` 为 vitest 进程级冒烟（`npm run
 *   test:e2e:native`，PS-02 T2.1 起归属 vitest.config.ts 独立 native-smoke
 *   项目），不属 Playwright 面 —— testIgnore 排除，
 *   避免 `npx playwright test` 误扫 vitest spec；
 * - visual 回归收敛到 `apps/crish-desktop/playwright.config.ts`（testDir
 *   限 `tests/visual`），本 config 不再扫描 app 目录，职责单一。
 *
 * CI 分层归属（PE-11 §1.3 / T11.7.4）：
 *   中层（PR）→ `npx playwright test tests/e2e`（本 config）
 *   慢层（nightly/发布前）→ visual + native-smoke
 *
 * 超时分层（G15c，冷启动基建）：
 *   webServer 启动就绪 180s > 用例超时 30s > 断言超时 8s
 *   （webServer 侧双保险：port TCP 探测 + url HTTP 健康检查轮询，
 *    就绪判定 = 端口可连 且 dev server 返回 2xx/3xx）
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // vitest spec（进程级冒烟）不归 Playwright 管
  testIgnore: /tauri-native-smoke\.spec\.ts$/,
  fullyParallel: true,
  // 并发收敛（tiptap 接线后冷编译回归记录 2026-08-07）：fullyParallel 下 26 用例
  // 同时触发 vite 首屏编译，早期页面 bundle 未就绪 → 白屏（sidebar/chat-input 缺失）。
  // 限制 worker（= 同时页面数）为 4，编译压力骤降；用例预算 26/4≈7 轮，无感。
  workers: 4,
  reporter: [['list']],
  expect: {
    // 断言层默认超时（spec 内显式 timeout 8s 为局部覆盖，语义一致）
    timeout: 8_000,
  },
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
    // G15c 修正（T-48 轮内协调）：Playwright 校验 port 与 url 互斥
    // （`Either 'port' or 'url' should be specified`），url 已含端口且
    // 提供 HTTP 级就绪健康检查（2xx/3xx 轮询），保留 url 即覆盖原意图
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    // 冷启动余量：120s → 180s（CI 慢层 60min 预算内可容忍，本地体验差）
    timeout: 180_000,
  },
});
