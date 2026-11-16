import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  // `restoreMocks`/`clearMocks` in `client/vitest.config.ts` restore only `vi.spyOn` spies, so the
  // global and environment stubs the suites install — `fetch` above all — are cleared here, or a
  // test would pass against the previous test's double.
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
