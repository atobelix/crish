import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5174',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm --workspace @crish/crish-desktop run dev',
    port: 5174,
    reuseExistingServer: true,
  },
});
