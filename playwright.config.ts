import { defineConfig, devices } from 'playwright/test';

// The Vite dev server owns the port. A clone that reserves its own port block
// exports VITE_PORT (the server's CORS allowlist follows the same origin); with
// VITE_PORT unset the run targets the fixed dev origin http://localhost:5173.
const baseURL = process.env.VITE_PORT
  ? `http://localhost:${process.env.VITE_PORT}`
  : 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // One API instance serves the whole run from a single temporary DATA_DIR, so the
  // specs share that store and must not race each other across workers.
  fullyParallel: false,
  workers: 1,
  // A retry could hide a lost provider call: the harness asserts on one run's log.
  retries: 0,
  // A left-behind test.only would shrink the end-to-end gate to one spec and still
  // report green, so a focused run fails here on every machine the suite runs on.
  forbidOnly: true,
  // One submission may spend the full 30 000 ms analysis budget before upload,
  // navigation and render are finished, so the spec timeout clears that budget
  // without being unbounded.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '.e2e/test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // No webServer block: scripts/run-e2e.mjs builds shared and server, starts the
  // API with STUB_PROVIDER=1 and a temporary DATA_DIR, starts Vite, waits for both
  // and tears them down. A webServer here would start a second, differently
  // configured API and hide the stub, which must never reach the real provider.
});
