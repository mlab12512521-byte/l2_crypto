import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running TeXCollab instance (see docs/development.md).
 *   E2E_BASE_URL        default http://localhost:3001 (must equal the instance's PUBLIC_URL)
 *   E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD   an administrator account on that instance
 *   E2E_SKIP_COMPILE=1  skip checks that need a compile worker
 *   E2E_CHROMIUM        optional path to a Chromium binary
 *   E2E_IGNORE_HTTPS_ERRORS=1  accept an untrusted certificate (e.g. Caddy's internal CA)
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
    screenshot: 'only-on-failure',
    viewport: { width: 1400, height: 850 },
    ...(process.env.E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 850 } } }],
});
