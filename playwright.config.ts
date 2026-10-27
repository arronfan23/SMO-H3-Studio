import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // Package tests need the portable build (test:e2e:package); real-hardware
  // tests need the SelfLift backend (test:e2e:real with SMO_REAL_H3=1).
  testIgnore: /package\.spec\.ts|real-comfy\.spec\.ts/,
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
