import { defineConfig } from 'vitest/config';

// vitest 3.2.7 覆盖率门禁配置（2026-08-03 审计修复）。
//
// 关键发现：本版本中根配置的 `test.coverage` 块会整体覆盖项目级
// （test.projects 实测项目级 coverage.thresholds 解析为 undefined），
// 因此阈值必须放在根 coverage 块才生效。
//
// 阈值校准依据（实测基线，unit 全量通过语料 4461 用例 + retry=2）：
//   statements 47.03% / branches 77.38% / functions 69.72% / lines 47.03%
// 原 70/60/65/70 从未被执行（CI 未带 --coverage，且项目级阈值被根配置覆盖），
// 实际覆盖率远低于原值；按实测基线下调并保留安全余量（CI 上多 25 个本机
// 环境性失败文件通过后会追加覆盖率，余量只增不减）。
// 由 ci.yml vitest-fast 带 --coverage 强制执行；低于阈值即失败。
export default defineConfig({
  test: {
    globals: true,
    globalSetup: ['./vitest.globalSetup.ts'],
    retry: 2,
    testTimeout: 10000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/reference/**',
      '**/target/**',
      '**/*.e2e.test.ts',
      '**/__tests__/e2e/**',
    ],
    coverage: {
      enabled: false,
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'apps/crish-desktop/src/**/*.{ts,tsx}',
        'packages/*/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/reference/**',
        '**/target/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        '**/__tests__/**',
      ],
      // 门禁阈值（对全部项目生效；见文件头注释）
      // 注意：integration 项目实测仅 3.75% / 61.16% / 33.5% / 3.75%，本地
      // `npm run test:coverage`（全部项目）会因 integration 不达标而失败；
      // ci-mid 未带 --coverage 不受影响。待 integration 用例扩增后再启用。
      thresholds: {
        statements: 45,
        branches: 70,
        functions: 65,
        lines: 45,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // globals 必须开启：test-setup.ts 通过 vi.mock + beforeEach 注入 Tauri invoke
          // mock 基础设施，@testing-library/jest-dom 也依赖全局 expect。
          globals: true,
          // 顺序：先加载根 vitest.setup.ts（localStorage/RAF 等环境补齐），
          // 再加载 crish-desktop test-setup.ts（Tauri invoke mock + jest-dom + ResizeObserver）。
          setupFiles: [
            './vitest.setup.ts',
            './apps/crish-desktop/src/test-setup.ts',
          ],
          retry: 2,
          testTimeout: 10000,
          include: [
            'packages/*/src/**/*.test.{ts,tsx}',
            'apps/crish-desktop/src/**/*.test.{ts,tsx}',
            'apps/crish-desktop/src/__tests__/**/*.{ts,tsx}',
            'apps/crish-desktop/tests/snapshots/**/*.test.{ts,tsx}',
            'apps/agent-workbench/src/**/*.test.{ts,tsx}',
          ],
          exclude: [
            '**/__tests__/e2e/**',
            '**/__tests__/integrations/**',
            '**/node_modules/**',
            '**/dist/**',
            '**/*.spec.ts',
            '**/tests/visual/**',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          setupFiles: ['./vitest.setup.ts'],
          retry: 2,
          testTimeout: 10000,
          // include 收敛（维度 1 步骤 1b）：删除 4 个根 tests/ 下空/不存在目录
          // （tests/integration｜fuzz｜race｜recovery —— 实测 0 文件或目录不存在），
          // 保留 tests/stress（7 文件）+ apps/crish-desktop/tests/{integration,race,
          // recovery,fuzz}（12 文件，与 vitest.integration.config.ts F3 四目录对齐）。
          include: [
            'tests/stress/**/*.test.ts',
            'apps/crish-desktop/tests/integration/**/*.test.ts',
            'apps/crish-desktop/tests/race/**/*.test.ts',
            'apps/crish-desktop/tests/recovery/**/*.test.ts',
            'apps/crish-desktop/tests/fuzz/**/*.test.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/tests/visual/**',
            '**/tests/snapshots/**',
            '**/*.spec.ts',
          ],
        },
      },
      {
        test: {
          name: 'native-smoke',
          environment: 'node',
          setupFiles: ['./vitest.setup.ts'],
          retry: 2,
          testTimeout: 30000,
          // L3 进程级原生冒烟（PS-02 T2.1 重归属）：tauri-native-smoke.spec.ts
          // 是 vitest API 的进程冒烟（`npm run test:e2e:native`），不归 Playwright
          // 面（playwright.config.ts testIgnore 已排除）。原 e2e 项目块已删除——
          // 其 include 唯一匹配面就是 tests/e2e 的 Playwright spec（test.describe
          // 与 vitest 运行器冲突，21/21 必红），删除后项目必空（空项目假绿不可
          // 接受）；Playwright spec 一律归 Playwright（tests/e2e 全旅程）。
          include: ['tests/e2e/tauri-native-smoke.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
