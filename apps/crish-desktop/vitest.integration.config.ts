import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 10000,
    setupFiles: ['./tests/integration/setup.ts'],
  },
});
