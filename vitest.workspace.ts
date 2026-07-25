import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      setupFiles: ['./vitest.setup.ts'],
      retry: 2,
      testTimeout: 10000,
      include: [
        'packages/*/src/**/*.test.ts',
        'apps/crish-desktop/src/**/*.test.ts',
        'apps/agent-workbench/src/**/*.test.ts',
      ],
      exclude: [
        '**/__tests__/e2e/**',
        '**/__tests__/integrations/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        thresholds: {
          statements: 70,
          branches: 60,
          functions: 65,
          lines: 70,
        },
      },
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      setupFiles: ['./vitest.setup.ts'],
      retry: 2,
      testTimeout: 10000,
      include: [
        'tests/integration/**/*.test.ts',
        'tests/fuzz/**/*.test.ts',
        'tests/race/**/*.test.ts',
        'tests/recovery/**/*.test.ts',
        'apps/crish-desktop/tests/**/*.test.ts',
      ],
      exclude: ['**/node_modules/**', '**/dist/**'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        thresholds: {
          statements: 70,
          branches: 60,
          functions: 65,
          lines: 70,
        },
      },
    },
  },
  {
    test: {
      name: 'e2e',
      environment: 'node',
      setupFiles: ['./vitest.setup.ts'],
      retry: 2,
      testTimeout: 30000,
      include: ['**/__tests__/e2e/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        thresholds: {
          statements: 70,
          branches: 60,
          functions: 65,
          lines: 70,
        },
      },
    },
  },
]);
