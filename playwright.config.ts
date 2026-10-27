import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // Package tests need the portable build; run them via test:e2e:package.
  testIgnore: /package\.spec\.ts/,
  workers: 1,
  timeout: 120000,
  reporter: 'list',
  retries: 0,
  fullyParallel: false,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
