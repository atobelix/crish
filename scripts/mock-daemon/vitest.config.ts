import { defineConfig } from 'vitest/config';

// mock-daemon 独立测试配置：必须自带 vitest.config（vitest 会向上查找根配置，
// 而根配置的 projects 各自限定 include，不会包含本目录测试——显式配置保证
// `npm test`（本目录）只跑 mock 夹具测试，且不影响根仓库门禁）。
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 20000,
    hookTimeout: 20000,
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
