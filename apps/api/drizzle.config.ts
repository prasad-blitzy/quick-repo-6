/**
 * Drizzle Kit Migration Configuration
 *
 * Configures the drizzle-kit CLI for generating SQL migrations, pushing schema
 * changes, and managing the database schema for the Trading Intelligence
 * application's PostgreSQL 16 database.
 *
 * This configuration is consumed by the following package.json scripts:
 *  - `db:generate` → `drizzle-kit generate`  — produces SQL migration files
 *  - `db:migrate`  → `drizzle-kit migrate`   — applies pending migrations
 *  - `db:push`     → `drizzle-kit push`      — applies schema directly (dev)
 *  - `db:studio`   → `drizzle-kit studio`    — opens visual schema browser
 *
 * The schema path points to the barrel export (`src/db/schema/index.ts`) that
 * re-exports all 7 table schemas, PostgreSQL enum definitions, and Drizzle ORM
 * relation definitions. drizzle-kit introspects this file at runtime to discover
 * every table, column, index, and foreign key for migration generation.
 *
 * Database credentials are resolved from the DATABASE_URL environment variable,
 * with a sensible local-development fallback matching the docker-compose.yml
 * PostgreSQL service configuration. This allows drizzle-kit to work seamlessly
 * with both local PostgreSQL (via Docker) and Supabase (via direct connection
 * string — drizzle-kit always connects directly, bypassing pgBouncer).
 *
 * @module drizzle.config
 */

// Load environment variables from .env file into process.env before accessing
// DATABASE_URL. This side-effect import executes dotenv's config() immediately
// upon module evaluation, ensuring process.env is populated.
import "dotenv/config";

import { defineConfig } from "drizzle-kit";

/**
 * Default local PostgreSQL connection string matching docker-compose.yml service
 * configuration. Used as a fallback when DATABASE_URL is not set, enabling
 * zero-configuration local development after running `docker compose up -d`.
 */
const DEFAULT_DATABASE_URL =
  "postgresql://trading:trading_password@localhost:5432/trading_intelligence";

export default defineConfig({
  /**
   * Path to the schema barrel export that re-exports all Drizzle ORM schema
   * definitions. drizzle-kit reads this file to discover:
   *  - 5 PostgreSQL enums (market, direction, status, timeframe, pipeline_step)
   *  - 7 table schemas (news_articles, trade_opportunities, trade_performance,
   *    user_settings, api_sources, analysis_logs, notification_logs)
   *  - All Drizzle ORM relation definitions for type-safe eager loading
   */
  schema: "./src/db/schema/index.ts",

  /**
   * Output directory for auto-generated SQL migration files. Each call to
   * `drizzle-kit generate` creates a new timestamped migration file here
   * containing the SQL DDL statements for schema changes.
   */
  out: "./src/db/migrations",

  /** PostgreSQL 16 dialect — matches docker-compose.yml and Supabase targets */
  dialect: "postgresql",

  /**
   * Database connection credentials resolved from environment variables.
   * Falls back to the local Docker PostgreSQL connection string when
   * DATABASE_URL is not explicitly set, enabling `pnpm db:generate` to work
   * immediately after `docker compose up -d` without manual .env setup.
   */
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL,
  },

  /** Show detailed output during migration generation and application */
  verbose: true,

  /** Enable strict mode for safer migrations — warns about destructive changes */
  strict: true,
});
