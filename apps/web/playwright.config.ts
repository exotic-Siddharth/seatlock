import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the dev servers (API on 4200 with the seeded dev database, web on
 * 5175). If they are already running they are reused; otherwise `npm run dev` starts both.
 * Run `npm run seed` once before the first run.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    cwd: '../..',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
