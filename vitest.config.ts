import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    environment: 'node',
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/crish-desktop/src/**/*.test.ts',
    ],
  },
});
