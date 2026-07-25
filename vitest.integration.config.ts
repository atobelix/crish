import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/crish-desktop/tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    setupFiles: ['apps/crish-desktop/tests/integration/setup.ts'],
  },
});
