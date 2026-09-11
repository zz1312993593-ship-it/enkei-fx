import { defineConfig } from '@playwright/test';

// 批B：E2E 冒烟配置。本地运行：npx playwright install chromium && npm run e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 90_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
