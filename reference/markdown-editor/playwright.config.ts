import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
<<<<<<< Updated upstream
  use: { baseURL: 'http://localhost:5174' },
=======
  use: { baseURL: 'http://localhost:5173' },
>>>>>>> Stashed changes
});
