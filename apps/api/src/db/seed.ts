/**
 * Database Seed Script — `apps/api/src/db/seed.ts`
 *
 * Standalone seed script that inserts initial sample data into the PostgreSQL
 * database for development and testing. Populates the `api_sources` table with
 * all 8 external data source configurations and the `user_settings` table with
 * a default test Telegram subscriber.
 *
 * All inserts use Drizzle ORM's `onConflictDoNothing()` targeted at the
 * respective UNIQUE columns (`name` for api_sources, `telegram_chat_id` for
 * user_settings) to ensure the script is fully idempotent — executing it
 * multiple times will never produce duplicate key errors.
 *
 * Run manually from the `apps/api/` directory:
 * ```bash
 * npx tsx src/db/seed.ts
 * ```
 *
 * Or via the workspace script defined in `apps/api/package.json`:
 * ```bash
 * pnpm db:seed
 * ```
 *
 * Exit codes:
 *  - 0 — Seed completed successfully (or data already existed)
 *  - 1 — Seed failed due to a database connection or insert error
 *
 * @module seed
 */

import { db, closeDatabase } from "./index.js";
import { apiSources } from "./schema/api-sources.js";
import { userSettings } from "./schema/user-settings.js";

// ---------------------------------------------------------------------------
// Inferred insert types from the Drizzle table definitions
// ---------------------------------------------------------------------------

/** Insert type for the api_sources table, derived from the Drizzle schema. */
type NewApiSource = typeof apiSources.$inferInsert;

/** Insert type for the user_settings table, derived from the Drizzle schema. */
type NewUserSettings = typeof userSettings.$inferInsert;

// ---------------------------------------------------------------------------
// Seed Data — API Sources
// ---------------------------------------------------------------------------

/**
 * All 8 external data sources registered in the system.
 *
 * Each source is configured with:
 *  - `name`       : Unique human-readable identifier (UNIQUE constraint)
 *  - `type`       : Classification — "api", "rss", or "scraper"
 *  - `market`     : PostgreSQL enum value matching market segment
 *  - `baseUrl`    : Base endpoint URL for the data source
 *  - `isActive`   : Whether the source is enabled for polling (default: true)
 *  - `rateLimit`  : Requests per minute for the Bottleneck rate limiter
 *  - `errorCount` : Consecutive error counter for graceful degradation (init: 0)
 *
 * Sources are grouped by market segment:
 *  - US Stock:       Finnhub (60/min), Alpha Vantage (25/day)
 *  - Indian Equity:  NSE India (20/min), Indian Market RSS (60/min)
 *  - Crypto:         CoinGecko (30/min), CryptoCompare (100/min), Binance (1200/min)
 *  - Social:         Reddit RSS (100/min)
 *
 * @see AAP Section 0.1.2 — Recommended data source stack
 * @see AAP Rule 0.7.4 — Per-API Bottleneck isolation with specific rate limits
 */
const API_SOURCES_SEED: NewApiSource[] = [
  // ---- US Stock Market Sources ----
  {
    name: "Finnhub",
    type: "api",
    market: "us_stock",
    baseUrl: "https://finnhub.io/api/v1",
    isActive: true,
    rateLimit: 60,
    errorCount: 0,
  },
  {
    name: "Alpha Vantage",
    type: "api",
    market: "us_stock",
    baseUrl: "https://www.alphavantage.co/query",
    isActive: true,
    rateLimit: 25,
    errorCount: 0,
  },

  // ---- Indian Equity Market Sources ----
  {
    name: "NSE India",
    type: "scraper",
    market: "indian_equity",
    baseUrl: "https://www.nseindia.com",
    isActive: true,
    rateLimit: 20,
    errorCount: 0,
  },
  {
    name: "Indian Market RSS",
    type: "rss",
    market: "indian_equity",
    baseUrl:
      "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    isActive: true,
    rateLimit: 60,
    errorCount: 0,
  },

  // ---- Cryptocurrency Market Sources ----
  {
    name: "CoinGecko",
    type: "api",
    market: "crypto",
    baseUrl: "https://api.coingecko.com/api/v3",
    isActive: true,
    rateLimit: 30,
    errorCount: 0,
  },
  {
    name: "CryptoCompare",
    type: "api",
    market: "crypto",
    baseUrl: "https://min-api.cryptocompare.com",
    isActive: true,
    rateLimit: 100,
    errorCount: 0,
  },
  {
    name: "Binance",
    type: "api",
    market: "crypto",
    baseUrl: "https://api.binance.com/api/v3",
    isActive: true,
    rateLimit: 1200,
    errorCount: 0,
  },

  // ---- Social Sentiment Sources ----
  {
    name: "Reddit",
    type: "rss",
    market: "social",
    baseUrl: "https://www.reddit.com/r/wallstreetbets/.rss",
    isActive: true,
    rateLimit: 100,
    errorCount: 0,
  },
];

// ---------------------------------------------------------------------------
// Seed Data — Test User
// ---------------------------------------------------------------------------

/**
 * Default test user for development and smoke testing.
 *
 * Telegram chat ID "123456789" is a well-known test value that will not
 * conflict with real Telegram users. The user is configured with:
 *  - All major markets: US stocks, Indian equities, crypto
 *  - Default confidence threshold: 0.70 (70%)
 *  - All trade timeframes: intraday, swing, position
 *  - Notifications active
 *
 * The `minConfidence` value is stored as the string "0.70" to preserve
 * decimal precision when mapped to the PostgreSQL NUMERIC(3,2) column.
 *
 * @see AAP Rule 0.7.2 — Financial decimal precision for confidence scores
 */
const TEST_USER_SEED: NewUserSettings = {
  telegramChatId: "123456789",
  username: "test_trader",
  markets: ["us_stock", "indian_equity", "crypto"],
  minConfidence: "0.70",
  timeframes: ["intraday", "swing", "position"],
  isActive: true,
};

// ---------------------------------------------------------------------------
// Seed Execution
// ---------------------------------------------------------------------------

/**
 * Executes all seed operations in sequence.
 *
 * Each insert uses `onConflictDoNothing()` targeted at the respective UNIQUE
 * constraint column so the script is fully idempotent — running it multiple
 * times will not produce duplicate-key errors.
 *
 *  - API Sources: conflict target is the UNIQUE `name` column
 *  - User Settings: conflict target is the UNIQUE `telegram_chat_id` column
 *
 * @returns A promise that resolves when all seed operations complete.
 */
export async function seed(): Promise<void> {
  console.log("🌱 Starting database seed...");

  // -------------------------------------------------------------------------
  // 1. Seed API sources — 8 external data source configurations
  // -------------------------------------------------------------------------
  await db
    .insert(apiSources)
    .values(API_SOURCES_SEED)
    .onConflictDoNothing({ target: apiSources.name });

  console.log(
    "✅ API sources seeded (" + String(API_SOURCES_SEED.length) + " sources)",
  );

  // -------------------------------------------------------------------------
  // 2. Seed test user — default subscriber with all markets and timeframes
  // -------------------------------------------------------------------------
  await db
    .insert(userSettings)
    .values(TEST_USER_SEED)
    .onConflictDoNothing({ target: userSettings.telegramChatId });

  console.log("✅ Test user seeded");

  console.log("🌱 Database seed complete!");
}

// ---------------------------------------------------------------------------
// Script Entrypoint — Run when executed directly via `npx tsx src/db/seed.ts`
// ---------------------------------------------------------------------------

seed()
  .then(async () => {
    await closeDatabase();
    console.log("Seed completed successfully");
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error("Seed failed:", err);
    await closeDatabase();
    process.exit(1);
  });
