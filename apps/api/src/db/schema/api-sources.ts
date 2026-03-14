import { pgTable, uuid, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * API Sources Table Schema
 *
 * Standalone configuration/registry table for managing external data source
 * configurations used by the news fetcher service. Each source (Finnhub,
 * CoinGecko, CryptoCompare, Binance, Alpha Vantage, NSE India, RSS feeds,
 * Reddit) is registered here with its rate limit, enable/disable toggle,
 * and error tracking for graceful degradation.
 *
 * Key design decisions:
 * - UNIQUE constraint on `name` enables idempotent seeding via onConflictDoNothing()
 * - `error_count` supports per-source graceful degradation (AAP Rule 0.7.4):
 *   incremented on each failure, reset to 0 on success
 * - `is_enabled` toggle allows disabling a source without removing its config
 * - `type` uses plain text (not a PostgreSQL enum) for extensibility without migrations
 * - No foreign key relations — this is a standalone lookup/config table
 */
export const apiSources = pgTable("api_sources", {
  /** Unique source identifier (UUID v4, auto-generated) */
  id: uuid("id").defaultRandom().primaryKey(),

  /** Human-readable source name (e.g., "Finnhub", "CoinGecko"). Must be unique. */
  name: text("name").notNull().unique(),

  /** Source type classification: "api", "rss", or "scraper" */
  type: text("type").notNull(),

  /** Base URL for the data source (e.g., "https://finnhub.io/api/v1") */
  baseUrl: text("base_url").notNull(),

  /** Whether this source is actively polled. Defaults to true. */
  isEnabled: boolean("is_enabled").notNull().default(true),

  /** Rate limit in requests per minute (or per period). Nullable for unlimited sources. */
  rateLimit: integer("rate_limit"),

  /**
   * Consecutive error count for graceful degradation.
   * Per AAP Rule 0.7.4: "Individual API source failures must not halt the
   * entire polling cycle. Each fetcher must catch its own errors, log them,
   * and increment the error_count on the corresponding api_sources record."
   * Incremented on each failure; reset to 0 on successful fetch.
   */
  errorCount: integer("error_count").notNull().default(0),

  /** Timestamp of the last successful data fetch. Nullable until first fetch. */
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),

  /** Record creation timestamp. Automatically set on insert. */
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** TypeScript type for SELECT results from the api_sources table */
export type ApiSource = typeof apiSources.$inferSelect;

/** TypeScript type for INSERT values into the api_sources table */
export type NewApiSource = typeof apiSources.$inferInsert;
