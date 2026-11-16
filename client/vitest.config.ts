import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Test-only configuration for the client package.
 *
 * `vite build` and `vite dev` load `vite.config.ts` and never this file, so the dev-server
 * proxy and the suite's DOM environment stay independent: the unit and component suites on
 * this side stub `fetch` themselves and reach no network.
 */
export default defineConfig({
  plugins: [react()],
  // Test-runner half of the `@trade-read/shared` mapping that `client/vite.config.ts` and
  // `client/tsconfig.json` also declare. It aims at the shared sources, so `npm test`
  // resolves the contract types, vocabulary, limits, error codes and DISCLAIMER from the one
  // copy of the package without needing a prior `tsc -b shared`.
  resolve: {
    alias: {
      '@trade-read/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // jsdom supplies the document, File, DataTransfer and keyboard-event APIs the Testing
    // Library suites drive; the pure unit suite runs unchanged under the same environment.
    environment: 'jsdom',
    // Vitest globals stay off. `client/tsconfig.json` declares `types: ["vite/client"]` and
    // deliberately omits `vitest/globals`, so every suite imports its test API from 'vitest';
    // enabling globals would force `vitest/globals` into that types array and widen every
    // file's global scope to keep the type-check green.
    globals: false,
    // The single setup module: registers the jest-dom matchers and unmounts Testing Library
    // trees between tests so one suite's DOM cannot satisfy the next one's query.
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // The suites stub `fetch` and assert on one fixed message per error code; a double left
    // standing between tests would make a passing assertion meaningless.
    restoreMocks: true,
    clearMocks: true,
    // No test asserts computed style, and the only stylesheet import sits in `src/main.tsx`,
    // which no suite renders, so CSS processing would only cost time.
    css: false,
    // Room for the longest `user-event` keyboard sequence while still failing a hung test.
    testTimeout: 15000,
  },
});
