import { defineConfig } from '@playwright/test';

// Real-hardware acceptance suite: launches the real SelfLift ComfyUI backend
// through the app and verifies node availability. Requires SMO_REAL_H3=1.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /real-comfy\.spec\.ts/,
  workers: 1,
  timeout: 420000,
  reporter: 'list',
  retries: 0,
  fullyParallel: false,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
