import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      enabled: true,
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 65,
        lines: 70,
      },
      exclude: [
        '**/*.test.ts', '**/*.test.tsx',
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/types.ts',
      ],
    },
  },
});
