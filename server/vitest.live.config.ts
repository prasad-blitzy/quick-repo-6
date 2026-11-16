/**
 * The one configuration that reaches the real model provider, and the live check's only entry point.
 *
 * The root `test:live` script delegates to this package's `test:live`, which loads this file.
 * Neither the offline `test`/`test:server` scripts nor `vitest.config.ts` may reference it, so the
 * suites that must pass with no credential and no network never collect the live suite: the `test`
 * block below collects the `test/live` directory and nothing else.
 *
 * No value the application fixes as a constant is restated here. The 30 000 ms analysis budget and
 * the completion ceilings are constants in the shared package, and the credential, the slug and the
 * stub selector are parsed by `src/config/env.ts`; a copy of any of them in this harness could
 * drift from the value the suite asserts. `DATA_DIR` is likewise left alone, so an operator can
 * point a live run at a scratch directory without editing this file.
 */
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The shared package's source entry, because this package is ESM and the live suite must run
 * without a prior build of `shared`. The alias mirrors the one `vitest.config.ts` applies, so the
 * live suite imports the same contract, limits and vocabulary as every offline suite.
 */
const sharedEntry = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

/** The one `STUB_PROVIDER` value that selects the replay adapter, as `src/config/env.ts` reads it. */
const STUB_PROVIDER_SELECTOR = '1';

/**
 * Refuse to load when a live run would prove nothing.
 *
 * Both conditions are silent failures if allowed to proceed. Without a credential every provider
 * call is rejected, and the suite would report a red criterion for the wrong reason; with the
 * replay adapter selected the suite would pass green without ever reaching OpenRouter. Throwing at
 * config load fails the run at once with an instruction, rather than skipping the suite, which
 * would let a criterion only the live run covers go unnoticed.
 *
 * Only presence is inspected. The credential is never read into a message, a test name or a log
 * line, and no other variable is required here: `OPENROUTER_MODEL`, the base URL and `DATA_DIR`
 * all have defaults.
 */
function assertLiveRunPossible(): void {
  if ((process.env.OPENROUTER_API_KEY ?? '').trim().length === 0) {
    throw new Error(
      'The live provider check needs a real credential: set OPENROUTER_API_KEY, and point ' +
        'OPENROUTER_MODEL at a vision-capable slug that accepts image input. See the live-check ' +
        'section of README.md and the variable list in .env.example.',
    );
  }

  // A blank or unrelated value leaves the real adapter in place in `src/config/env.ts`, so only the
  // selector that actually turns the replay provider on is refused — an inherited `STUB_PROVIDER=`
  // copied from `.env.example` must not fail a correct live run.
  if ((process.env.STUB_PROVIDER ?? '').trim() === STUB_PROVIDER_SELECTOR) {
    throw new Error(
      'The live provider check must run against the real OpenRouter adapter: unset STUB_PROVIDER, ' +
        'which is set to 1 and selects the replay provider, so the run would prove nothing.',
    );
  }
}

assertLiveRunPossible();

export default defineConfig({
  resolve: {
    alias: {
      '@trade-read/shared': sharedEntry,
    },
  },
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    // Three submissions of three images, each allowed the whole analysis budget.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // The suite measures latency against one provider while drawing on one rate-limited budget, so
    // files run one at a time; in parallel they would distort the measurement and split the budget.
    fileParallelism: false,
  },
});
