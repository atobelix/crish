import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    environment: 'node',
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/crish-desktop/src/**/*.test.ts',
      'apps/agent-workbench/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
