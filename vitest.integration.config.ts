import { defineConfig } from 'vitest/config';

// F3 层四目录独立配置（PS-02 T2.1 修正）：
// 从 vitest.workspace.ts 时代迁出——vitest 3.2.7 下 workspace 文件已 deprecated，
// 且旧 stub（`export {}` 非 default array）触发 Startup Error（R3 实跑 EXIT=1，
// 0 用例执行）；改用 test.projects（对齐 vitest.config.ts 模式）。
// include 对齐 ci-mid.yml test:integration job 注释声称的 F3 层四目录：
// integration / fuzz / race / recovery（扩前已确认四目录用例在根 integration
// 项目下全绿，且修复了 store-boundary.test.ts 的 `s`→`_s` 引用缺陷）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'f3',
          environment: 'node',
          include: [
            'apps/crish-desktop/tests/integration/**/*.test.ts',
            'apps/crish-desktop/tests/fuzz/**/*.test.ts',
            'apps/crish-desktop/tests/race/**/*.test.ts',
            'apps/crish-desktop/tests/recovery/**/*.test.ts',
          ],
          testTimeout: 30000,
          // 根 vitest.setup.ts 补齐 node 环境浏览器全局（rAF/存储 mock 等，
          // fuzz 层 StreamRenderBuffer 用例依赖 rAF stub）；
          // integration/setup.ts 安装 @crish/test-utils 存储 mock（原配置行为保留）。
          setupFiles: [
            './vitest.setup.ts',
            'apps/crish-desktop/tests/integration/setup.ts',
          ],
        },
      },
    ],
  },
});
