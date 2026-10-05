import { defineConfig } from '@playwright/test';

/** End-to-end tests; see test/e2e/harness.ts. Unit tests run with node:test. */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.test.ts',
  // xdotool sends key presses to whichever window has focus, so only one
  // browser may run at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 3_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
});
