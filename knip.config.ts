import type { KnipConfig } from 'knip';

/**
 * knip 死代码门禁配置（R2-T2）。
 *
 * - workspaces 自动取自根 package.json 的 workspaces 字段（当前 8 项），
 *   此处只按目录为两个应用配置 entry，不枚举 workspace 列表。
 * - entry 覆盖 apps/crish-desktop 与 apps/agent-workbench 的构建/测试入口；
 *   vite/vitest/playwright 配置文件与 src/main.tsx 由 knip 插件自动识别，
 *   根 workspace 的脚本（bench/stress/startup/check/test 等）由 knip 从
 *   package.json scripts 自动解析为入口。
 * - ignore 只保留 .gitignore 未覆盖的分析区：
 *   docs/（含归档区 docs/archive 的历史原型源码）、reference/（git 保留跟踪的
 *   vendored 参考项目）；analysis/、assets/（iconLib 等 vendored 资产）、
 *   dist、target、node_modules、.agent-runtime/、implementer/、
 *   test-results/、perf-report/、scripts/*.mjs 等已由 .gitignore 覆盖
 *   （knip 默认尊重 .gitignore），无需重复登记。
 * - ignoreFiles：被非 import 方式消费的文件（门禁脚本按路径字符串读取，knip
 *   无法跟踪）与跨轮次预留资产——"看似未用"是 knip 盲区，不属于死代码。
 * - rules：unused files / unused dependencies / unused devDependencies 为 error
 *   （门禁）；unused exports / unused exported types / unlisted / binaries /
 *   duplicates 为 warn（记录不阻塞；unlisted/binaries 属 package.json 声明域 =
 *   T1 冻结域，待 T1 落盘；exports/types/duplicates 待 T8 清理后收紧）。
 */
const config: KnipConfig = {
  workspaces: {
    // --- apps/crish-desktop ---
    'apps/crish-desktop': {
      entry: [
        // 构建入口锚点（index.html → main.tsx 链路由 vite 插件解析）
        'index.html',
        // 测试入口（对齐 vitest.config.ts 项目 include 面）
        'src/**/*.test.{ts,tsx}',
        'src/__tests__/**/*.{ts,tsx}',
        'tests/**/*.{test,spec}.{ts,tsx}',
      ],
    },
    // --- apps/agent-workbench（TS 侧为共享库 + 测试，无 html/main）---
    'apps/agent-workbench': {
      entry: ['src/**/*.test.ts'],
    },
  },
  ignore: [
    // 文档与归档区（docs/archive 含历史原型源码）
    'docs/**',
    // vendored 参考项目（reference/ui-replica、reference/newui 等被 .gitignore 保留跟踪）
    'reference/**',
  ],
  ignoreFiles: [
    // 被 lint:all / lint:css 脚本经 stylelint 自动发现使用（stylelint 未本地安装，
    // knip 插件未激活而误报为 unused file）
    '.stylelintrc.cjs',
    // 门禁脚本按路径字符串消费的活文件（非 import，knip 无法跟踪）：
    // - store/index.ts：scripts/check-no-as-any-store.mjs BARREL_REQUIRED 校验目标
    // - store/rustCoreStore.ts：store/index.ts 桶文件 re-export 下游，随桶被门禁覆盖
    'apps/crish-desktop/src/store/index.ts',
    'apps/crish-desktop/src/store/rustCoreStore.ts',
    // R7 plugin-sdk 迁移预留资产（方案 01 §3 定义；R7 落地后移出本清单）
    'packages/shared-types/src/hooks.ts',
    'packages/shared-types/src/plugin.ts',
    'packages/shared-types/src/subagent.ts',
    'packages/shared-types/src/thinking-intensity.ts',
  ],
  ignoreDependencies: [
    // 被 .husky/pre-commit（npx lint-staged）与 .lintstagedrc.json 使用
    'lint-staged',
  ],
  rules: {
    files: 'error',
    dependencies: 'error',
    devDependencies: 'error',
    exports: 'warn',
    types: 'warn',
    unlisted: 'warn',
    binaries: 'warn',
    duplicates: 'warn',
    unresolved: 'error',
  },
};

export default config;
