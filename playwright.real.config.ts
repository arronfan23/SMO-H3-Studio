import { defineConfig } from '@playwright/test';

// Real-acceptance suites: real-comfy.spec.ts launches the real SelfLift
// ComfyUI backend (requires SMO_REAL_H3=1); real-llm.spec.ts validates the
// user's real LLM profile and polish path (requires SMO_REAL_LLM=1).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /real-.*\.spec\.ts/,
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
