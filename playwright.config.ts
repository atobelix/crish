/**
 * 根 Playwright 配置 —— 前端 e2e 唯一入口（PE-11 T11.1 双配置归一裁决）。
 *
 * - testDir `./tests/e2e`：Agent 前端的 L2 mock 引擎 spec + 行为断言；
 * - projects `e2e-l2`（默认）：mock 引擎层（dev server + __TAURI_INTERNALS__
 *   注入），CI 中层默认全量；`e2e-l3`（真壳 tauri-driver）暂不接线，
 *   保留 project 占位（发布前/nightly 层，见 PE-11 T11.1-3）；
 * - `tauri-native-smoke.spec.ts` 为 vitest 进程级冒烟（`npm run
 *   test:e2e:native`，PS-02 T2.1 起归属 vitest.config.ts 独立 native-smoke
 *   项目），不属 Playwright 面 —— testIgnore 排除，
 *   避免 `npx playwright test` 误扫 vitest spec；
 * - `webview/` 子目录是既有的旧版 WebView 测试资产，由根 config 排除；
 *   桌面界面调试与验收按 AGENTS.md 使用 Tauri MCP 4000；
 * - 退役 Markdown 编辑器的旧 spec 保留在仓库中，但不属于 Agent 默认测试集；
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
 *
 * 端口隔离（CI 修复 C2/C3）：
 *   - 默认端口 5174（与 vite.config.ts server.port、tauri devUrl 一致），
 *     webServer 命令仍为 `npm --workspace @crish/crish-desktop run dev`；
 *   - `CRISH_E2E_PORT=<port>` 指定独占端口（本机多 worktree / 多 agent 并行时用，
 *     避免误测别人的 dev server）。此时直接以 `--port <port>` 拉起 vite
 *     （strictPort 已在 vite.config.ts 开启：端口被占即失败，不会漂移到别的端口），
 *     不经 predev 的 ensure-dev-ports.mjs —— 它固定清理 5174/4000，
 *     独占端口运行时不应杀掉其它工作区在默认端口上的进程；
 *   - CI（环境变量 CI 存在）下 reuseExistingServer 恒为 false：必须由本次运行
 *     自己拉起 dev server，端口已被占用时直接报错而不是静默复用。
 */
import { defineConfig } from '@playwright/test';

const DEFAULT_E2E_PORT = 5174;

function resolveE2ePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_E2E_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`CRISH_E2E_PORT 必须是 1-65535 的整数端口，收到: ${raw}`);
  }
  return port;
}

const E2E_PORT = resolveE2ePort(process.env.CRISH_E2E_PORT);
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
const IS_CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // 排除进程级冒烟、旧 WebView 资产与退役 Markdown 编辑器 spec。
  testIgnore: [
    /tauri-native-smoke\.spec\.ts$/,
    /[\\/]webview[\\/]/,
    /[\\/](?:active-token|ast-block-tables|bug-repro|console-errors|cursor-position|editor-fuzz-thrash|format-checker|ime-composition|keyboard-navigation|matrix-ime-selection|matrix-navigation|matrix-tables|syntax-render|wysiwyg-interaction)\.spec\.ts$/,
  ],
  fullyParallel: true,
  // 单 worker 串行（2026-10-28 冷启动回归）：应用模块图增长后，4 个页面并发首屏
  // 编译会让 composer 草稿桥接等待超时（cache-metrics 假红）。15 个冒烟用例
  // 串行实测 1.4 分钟，远低于 CI 预算；确定性优先于并发度。
  workers: 1,
  reporter: [['list']],
  expect: {
    // 断言层默认超时（spec 内显式 timeout 8s 为局部覆盖，语义一致）
    timeout: 8_000,
  },
  use: {
    baseURL: E2E_BASE_URL,
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
    command:
      E2E_PORT === DEFAULT_E2E_PORT
        ? 'npm --workspace @crish/crish-desktop run dev'
        : `node ../../node_modules/vite/bin/vite.js --force --port ${E2E_PORT}`,
    cwd: E2E_PORT === DEFAULT_E2E_PORT ? undefined : 'apps/crish-desktop',
    // url 提供 HTTP 级就绪健康检查；该服务运行 Agent Workbench 前端。
    url: E2E_BASE_URL,
    // CI 必须自起服务；本地默认允许复用（同一端口上自己预热的 dev server）。
    reuseExistingServer: !IS_CI,
    timeout: 180_000,
  },
});
