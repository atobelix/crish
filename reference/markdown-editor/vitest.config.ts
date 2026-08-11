import { defineConfig } from 'vitest/config';

// W3-3 测试基建（docs/streaming-render/00 流式渲染极致化总方案 S-EL-11）：
// 统一 vitest 配置——仅固化 include/exclude 等非环境项。
//
// 口径（保守方案，06-测试与基准.md §0）：
// - 环境保持 vitest 默认 node，jsdom 按文件级 pragma
//   （`@vitest-environment jsdom`，既有 16 个测试文件依赖）启用，
//   不设全局 environment，避免改变既有按文件 pragma 的行为；
// - include 显式限定 tests/unit + tests/gate 域：根目录裸跑
//   `npx vitest run`（无 CLI 过滤）时不会误收 tests/e2e 的
//   Playwright spec（spec.ts 由 playwright.config.ts 管）、
//   tests/perf 的 .mjs 数据层脚本与 commonmark/cmspec 合规运行器；
// - vitest.probe.config.ts（临时探针配置）保留不动，两者互不干扰。
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/gate/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/e2e/**',
      'tests/perf/**',
      'tests/commonmark/**',
      'tests/cmspec/**',
      'tests/experimental/**',
      'tests/legacy/**',
    ],
  },
});
