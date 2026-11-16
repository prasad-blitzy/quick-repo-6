import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// The alias names the shared sources rather than `shared/dist`, so the server suites run on a clean
// checkout with no build step in front of them.
const sharedEntry = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

// Vitest resolves the project root against `process.cwd()`, so `include` below would be read as
// `<cwd>/test/**/*.test.ts` and a run started from the repository root would collect nothing.
// Pinning the root to this file's directory makes the globs mean the same thing from any directory.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@trade-read/shared': sharedEntry,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    // The live suite is the only one allowed to reach the real provider, and it belongs to
    // `vitest.live.config.ts` alone: this offline run must never collect it.
    exclude: [...configDefaults.exclude, 'test/live/**'],
    env: {
      STUB_PROVIDER: '1',
    },
    // Headroom above the 30 000 ms analysis budget, so the one suite that observes the budget expire
    // can do so for real instead of tripping the default timeout.
    testTimeout: 45_000,
    hookTimeout: 30_000,
  },
});
