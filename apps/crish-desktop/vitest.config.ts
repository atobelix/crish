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
      // 统一口径（PS-02 T2.4 / R6）：coverage 门禁唯一口径 = 根 vitest.config.ts
      // + CI（ci.yml vitest-fast，阈值 45/70/65/45）。app-dir 配置保留仅为
      // IDE 隐式行为显式化（防编辑器在该目录回退根配置后行为漂移），
      // enabled:false 使任何 scoped run 不再必红（原 0.16% < 70% 假红）。
      enabled: false,
      thresholds: {
        statements: 45,
        branches: 70,
        functions: 65,
        lines: 45,
      },
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/types.ts',
      ],
    },
  },
});
