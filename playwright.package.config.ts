import { defineConfig } from '@playwright/test';

// Runs only the portable-package E2E suite. Requires `npm run pack` output.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /package\.spec\.ts/,
  workers: 1,
  timeout: 300000,
  reporter: 'list',
  retries: 0,
  fullyParallel: false,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
