/**
 * Vitest Configuration for @trading-intelligence/api
 *
 * Disables file parallelism because integration tests share a PostgreSQL
 * database and clean/re-seed tables in beforeAll/beforeEach hooks.
 * Parallel execution causes FK constraint violations and data races
 * between test files that operate on the same tables.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * CRITICAL: Integration tests share a single PostgreSQL database.
     * Running test files in parallel causes data races where one file's
     * cleanup deletes rows another file's seed depends on.
     *
     * Set to false to run test files sequentially.
     */
    fileParallelism: false,

    /**
     * Increase the default test timeout for integration tests that
     * perform real database I/O and HTTP round-trips via Supertest.
     */
    testTimeout: 30_000,
  },
});
