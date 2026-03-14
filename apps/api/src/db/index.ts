/**
 * Drizzle ORM Connection Factory
 *
 * This is the SINGLE POINT OF DATABASE ACCESS for the entire Trading
 * Intelligence Application backend. Every service, worker, route handler,
 * and bot command imports the `db` constant exported from this module.
 *
 * The module supports two connection modes controlled by the
 * `DATABASE_PROVIDER` environment variable:
 *
 *  1. **`"local"`** (default) — Uses the `pg` package (node-postgres) with a
 *     `Pool` for automatic connection lifecycle management. Suitable for
 *     direct PostgreSQL 16 connections (e.g., Docker Compose local dev).
 *
 *  2. **`"supabase"`** — Uses the `postgres` package (postgres.js) with
 *     `prepare: false` to disable prepared statements. This is a HARD
 *     REQUIREMENT for Supabase's pgBouncer transaction pooler, which does
 *     not support prepared statements across pooled connections.
 *     @see AAP Rule 0.7.4 — Supabase transaction pooler compatibility
 *
 * Both modes inject the full schema namespace into the Drizzle constructor
 * to enable the relational query API:
 * ```ts
 * db.query.newsArticles.findMany({ with: { tradeOpportunities: true } });
 * ```
 *
 * Consumers:
 *  - `apps/api/src/services/news-fetcher/`  — Insert news articles
 *  - `apps/api/src/queues/workers/`         — Query and update rows
 *  - `apps/api/src/routes/`                 — REST API data queries
 *  - `apps/api/src/bot/commands/`           — Read/write user settings
 *  - `apps/api/src/db/seed.ts`              — Insert seed data
 *
 * @module db
 */

import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";

import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

// ---------------------------------------------------------------------------
// Connection client references for graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Holds a reference to the underlying `pg.Pool` when using the local
 * provider, or `null` when using Supabase (postgres.js manages its own
 * connection lifecycle via `.end()`).
 *
 * Exported so that `apps/api/src/index.ts` can call `pool.end()` or
 * `sqlClient.end()` during SIGTERM / SIGINT shutdown sequences.
 */
let pgPool: pg.Pool | null = null;

/**
 * Holds a reference to the underlying postgres.js `Sql` client when using
 * the Supabase provider, or `null` when using local PostgreSQL.
 *
 * Exported so that `apps/api/src/index.ts` can call `sqlClient.end()` for
 * graceful connection teardown during shutdown.
 */
let sqlClient: postgres.Sql | null = null;

// ---------------------------------------------------------------------------
// Database factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a configured Drizzle ORM database instance.
 *
 * The provider branch is selected at startup based on `env.DATABASE_PROVIDER`:
 *
 * - `"supabase"` → `postgres(url, { prepare: false })` + `drizzlePostgres`
 * - `"local"` (default) → `new pg.Pool(...)` + `drizzlePg`
 *
 * Both branches pass the full `schema` namespace to enable Drizzle's
 * relational query builder (e.g., `db.query.newsArticles.findMany()`).
 *
 * @returns A fully typed Drizzle ORM database instance with relational
 *          query support for all 7 application tables.
 */
function createDatabase() {
  if (env.DATABASE_PROVIDER === "supabase") {
    // -----------------------------------------------------------------------
    // Supabase provider: postgres.js driver with prepared statements disabled
    // -----------------------------------------------------------------------
    // CRITICAL: `prepare: false` is mandatory for Supabase's pgBouncer
    // transaction pooler. Without this flag, prepared statements are cached
    // per-connection but pgBouncer recycles connections between clients,
    // causing "prepared statement already exists" or "unknown prepared
    // statement" errors.
    const sql = postgres(env.DATABASE_URL, { prepare: false });
    sqlClient = sql;

    return drizzlePostgres(sql, { schema });
  }

  // -------------------------------------------------------------------------
  // Local PostgreSQL provider: pg (node-postgres) Pool driver
  // -------------------------------------------------------------------------
  // `pg.Pool` manages a pool of connections with automatic checkout/checkin
  // and idle timeout. The pool is configured with the DATABASE_URL connection
  // string which encodes host, port, database, user, and password.
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  pgPool = pool;

  return drizzlePg(pool, { schema });
}

// ---------------------------------------------------------------------------
// Singleton database instance
// ---------------------------------------------------------------------------

/**
 * The singleton Drizzle ORM database instance used throughout the backend.
 *
 * Supports the full Drizzle query API:
 *  - `db.select().from(table)` — Type-safe SELECT queries
 *  - `db.insert(table).values(...)` — Type-safe INSERT operations
 *  - `db.update(table).set(...)` — Type-safe UPDATE operations
 *  - `db.delete(table).where(...)` — Type-safe DELETE operations
 *  - `db.query.tableName.findMany(...)` — Relational query builder
 *  - `db.transaction(async (tx) => { ... })` — ACID transactions
 */
export const db = createDatabase();

// ---------------------------------------------------------------------------
// Type export
// ---------------------------------------------------------------------------

/**
 * TypeScript type representing the configured Drizzle database instance.
 *
 * Use this type for function signatures that accept the database as a
 * parameter, enabling dependency injection and testability:
 *
 * ```ts
 * import type { Database } from "../db/index.js";
 *
 * async function fetchArticles(database: Database): Promise<NewsArticle[]> {
 *   return database.select().from(newsArticles);
 * }
 * ```
 */
export type Database = ReturnType<typeof createDatabase>;

// ---------------------------------------------------------------------------
// Shutdown helpers
// ---------------------------------------------------------------------------

/**
 * Returns the underlying `pg.Pool` instance if the local provider is active,
 * or `null` if using Supabase. Used by the application entry point for
 * graceful connection pool shutdown.
 *
 * @returns The `pg.Pool` instance or `null`.
 */
export function getPool(): pg.Pool | null {
  return pgPool;
}

/**
 * Returns the underlying postgres.js `Sql` client if the Supabase provider
 * is active, or `null` if using local PostgreSQL. Used by the application
 * entry point for graceful connection teardown.
 *
 * @returns The postgres.js `Sql` client or `null`.
 */
export function getSqlClient(): postgres.Sql | null {
  return sqlClient;
}

/**
 * Gracefully closes all database connections. Should be called during
 * application shutdown (SIGTERM / SIGINT handlers) to ensure clean
 * resource release.
 *
 * - For the local provider: drains and closes the `pg.Pool`.
 * - For the Supabase provider: closes the postgres.js connection.
 *
 * @returns A promise that resolves when all connections are closed.
 */
export async function closeDatabase(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }

  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
  }
}
