/**
 * Database Seed Script — `apps/api/src/db/seed.ts`
 *
 * Populates the PostgreSQL database with essential reference data required
 * for the Trading Intelligence Application to function correctly on first
 * startup:
 *
 *   1. **API Sources** — Registers all external data sources (Finnhub,
 *      CoinGecko, CryptoCompare, Binance, Alpha Vantage, NSE India,
 *      Economic Times RSS, Financial Express RSS, Business Standard RSS,
 *      CNBC RSS, MarketWatch RSS, Reddit RSS) in the `api_sources` table
 *      with their rate limits and market categories.
 *
 *   2. **Test User** — Creates a sample Telegram subscriber with default
 *      notification preferences (all markets, 0.70 confidence threshold,
 *      all timeframes, notifications active) in the `user_settings` table.
 *
 *   3. **Sample News Articles** — Inserts a small set of sample articles
 *      across all four markets for dashboard development and smoke testing.
 *
 * All inserts use `onConflictDoNothing()` to ensure idempotent re-runs —
 * the seed script can be executed multiple times without duplicate errors.
 *
 * Run manually:
 * ```bash
 * npx tsx src/db/seed.ts
 * ```
 *
 * @module seed
 */

import { db, closeDatabase } from "./index.js";
import { apiSources, userSettings, newsArticles } from "./schema/index.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Seed Data — API Sources
// ---------------------------------------------------------------------------

/**
 * All external data sources registered in the system.
 *
 * Each source is configured with:
 * - `name`: Unique human-readable identifier (UNIQUE constraint in table)
 * - `type`: "api" | "rss" | "scraper"
 * - `market`: PostgreSQL enum value matching Market enum
 * - `baseUrl`: Base endpoint for the source
 * - `rateLimit`: Requests per minute for the dedicated Bottleneck limiter
 * - `isActive`: Whether the source is enabled for polling
 */
const API_SOURCES_SEED = [
  // US Stock market sources
  {
    name: "Finnhub",
    type: "api",
    market: "us_stock" as const,
    baseUrl: "https://finnhub.io/api/v1",
    rateLimit: 60,
    isActive: true,
  },
  {
    name: "Alpha Vantage",
    type: "api",
    market: "us_stock" as const,
    baseUrl: "https://www.alphavantage.co/query",
    rateLimit: 5,
    isActive: true,
  },
  {
    name: "CNBC RSS",
    type: "rss",
    market: "us_stock" as const,
    baseUrl: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    rateLimit: 10,
    isActive: true,
  },
  {
    name: "MarketWatch RSS",
    type: "rss",
    market: "us_stock" as const,
    baseUrl: "https://feeds.marketwatch.com/marketwatch/topstories/",
    rateLimit: 10,
    isActive: true,
  },

  // Indian Equity market sources
  {
    name: "Economic Times RSS",
    type: "rss",
    market: "indian_equity" as const,
    baseUrl: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    rateLimit: 10,
    isActive: true,
  },
  {
    name: "Financial Express RSS",
    type: "rss",
    market: "indian_equity" as const,
    baseUrl: "https://www.financialexpress.com/market/feed/",
    rateLimit: 10,
    isActive: true,
  },
  {
    name: "Business Standard RSS",
    type: "rss",
    market: "indian_equity" as const,
    baseUrl: "https://www.business-standard.com/rss/markets-106.rss",
    rateLimit: 10,
    isActive: true,
  },
  {
    name: "NSE India",
    type: "scraper",
    market: "indian_equity" as const,
    baseUrl: "https://www.nseindia.com",
    rateLimit: 5,
    isActive: true,
  },

  // Crypto market sources
  {
    name: "CoinGecko",
    type: "api",
    market: "crypto" as const,
    baseUrl: "https://api.coingecko.com/api/v3",
    rateLimit: 30,
    isActive: true,
  },
  {
    name: "CryptoCompare",
    type: "api",
    market: "crypto" as const,
    baseUrl: "https://min-api.cryptocompare.com",
    rateLimit: 50,
    isActive: true,
  },
  {
    name: "Binance",
    type: "api",
    market: "crypto" as const,
    baseUrl: "https://api.binance.com/api/v3",
    rateLimit: 1200,
    isActive: true,
  },

  // Social sentiment sources
  {
    name: "Reddit RSS",
    type: "rss",
    market: "social" as const,
    baseUrl: "https://www.reddit.com/r/wallstreetbets/.rss",
    rateLimit: 10,
    isActive: true,
  },
] as const;

// ---------------------------------------------------------------------------
// Seed Data — Test User
// ---------------------------------------------------------------------------

/**
 * Default test user for development and smoke testing.
 *
 * Telegram chat ID "123456789" is a well-known test value that will
 * not conflict with real Telegram users. The user is configured with
 * all markets, all timeframes, and the default 0.70 confidence threshold.
 */
const TEST_USER_SEED = {
  telegramChatId: "123456789",
  username: "test_trader",
  markets: ["us_stock", "indian_equity", "crypto"],
  minConfidence: "0.70",
  timeframes: ["intraday", "swing", "position"],
  isActive: true,
};

// ---------------------------------------------------------------------------
// Seed Data — Sample News Articles
// ---------------------------------------------------------------------------

/**
 * Sample articles for dashboard development and visual testing.
 * Covers all four market categories with realistic headlines and content.
 */
const SAMPLE_ARTICLES_SEED = [
  {
    title: "Apple Reports Record Q1 Revenue Beating Wall Street Estimates",
    url: "https://example.com/seed/apple-q1-record-revenue",
    source: "finnhub",
    market: "us_stock" as const,
    content:
      "Apple Inc. reported record first-quarter revenue of $124.3 billion, " +
      "surpassing analyst expectations of $118.2 billion. iPhone sales drove " +
      "the strong performance, with the company seeing particular growth in " +
      "emerging markets. Services revenue also hit an all-time high of $23.1 " +
      "billion, up 14% year-over-year.",
    symbols: ["AAPL"],
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    isAnalyzed: false,
    metadata: { category: "earnings", sentiment: "positive" },
  },
  {
    title: "Reliance Industries Announces Major Green Energy Investment",
    url: "https://example.com/seed/reliance-green-energy",
    source: "economic-times-rss",
    market: "indian_equity" as const,
    content:
      "Reliance Industries Limited has announced a ₹75,000 crore investment " +
      "in green energy initiatives over the next three years. The company " +
      "plans to build a massive solar manufacturing facility in Gujarat and " +
      "expand its hydrogen fuel capabilities.",
    symbols: ["RELIANCE"],
    publishedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    isAnalyzed: false,
    metadata: { category: "business", region: "india" },
  },
  {
    title: "Bitcoin Surges Past $100K on Institutional Demand",
    url: "https://example.com/seed/bitcoin-100k-surge",
    source: "coingecko",
    market: "crypto" as const,
    content:
      "Bitcoin has surged past the $100,000 mark for the first time, driven " +
      "by institutional demand and ETF inflows. The leading cryptocurrency " +
      "reached an all-time high of $102,450 during Asian trading hours before " +
      "settling around $101,200.",
    symbols: ["BTC"],
    publishedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    isAnalyzed: false,
    metadata: { category: "markets", trending: true },
  },
  {
    title: "WallStreetBets Community Rallies Behind AI Semiconductor Stocks",
    url: "https://example.com/seed/wsb-ai-semiconductors",
    source: "reddit",
    market: "social" as const,
    content:
      "The r/wallstreetbets subreddit is buzzing with discussion about AI " +
      "semiconductor stocks, with NVDA and AMD receiving significant " +
      "attention. Multiple high-engagement posts are highlighting upcoming " +
      "earnings catalysts and data center demand projections.",
    symbols: ["NVDA", "AMD"],
    publishedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    isAnalyzed: false,
    metadata: { subreddit: "wallstreetbets", upvotes: 5200 },
  },
];

// ---------------------------------------------------------------------------
// Seed Execution
// ---------------------------------------------------------------------------

/**
 * Executes all seed operations in sequence.
 *
 * Each insert uses `onConflictDoNothing()` so the script is idempotent —
 * running it multiple times will not produce duplicate-key errors.
 *
 * - API Sources: conflict target is the UNIQUE `name` column
 * - User Settings: conflict target is the UNIQUE `telegram_chat_id` column
 * - News Articles: conflict target is the UNIQUE `url` column
 */
async function seed(): Promise<void> {
  const log = logger.child({ module: "seed" });

  log.info("Starting database seed...");

  // 1. Seed API sources
  log.info({ count: API_SOURCES_SEED.length }, "Seeding API sources...");
  const apiSourceResult = await db
    .insert(apiSources)
    .values(
      API_SOURCES_SEED.map((source) => ({
        name: source.name,
        type: source.type,
        market: source.market,
        baseUrl: source.baseUrl,
        rateLimit: source.rateLimit,
        isActive: source.isActive,
        errorCount: 0,
      })),
    )
    .onConflictDoNothing({ target: apiSources.name });
  const apiSourceRows =
    "rowCount" in apiSourceResult
      ? (apiSourceResult as { rowCount?: number }).rowCount ?? 0
      : 0;
  log.info({ rowCount: apiSourceRows }, "API sources seeded");

  // 2. Seed test user
  log.info("Seeding test user...");
  const userResult = await db
    .insert(userSettings)
    .values({
      telegramChatId: TEST_USER_SEED.telegramChatId,
      username: TEST_USER_SEED.username,
      markets: TEST_USER_SEED.markets,
      minConfidence: TEST_USER_SEED.minConfidence,
      timeframes: TEST_USER_SEED.timeframes,
      isActive: TEST_USER_SEED.isActive,
    })
    .onConflictDoNothing({ target: userSettings.telegramChatId });
  const userRows =
    "rowCount" in userResult
      ? (userResult as { rowCount?: number }).rowCount ?? 0
      : 0;
  log.info({ rowCount: userRows }, "Test user seeded");

  // 3. Seed sample news articles
  log.info(
    { count: SAMPLE_ARTICLES_SEED.length },
    "Seeding sample news articles...",
  );
  const articlesResult = await db
    .insert(newsArticles)
    .values(
      SAMPLE_ARTICLES_SEED.map((article) => ({
        title: article.title,
        url: article.url,
        source: article.source,
        market: article.market,
        content: article.content,
        symbols: article.symbols,
        publishedAt: new Date(article.publishedAt),
        isAnalyzed: article.isAnalyzed,
        metadata: article.metadata,
      })),
    )
    .onConflictDoNothing({ target: newsArticles.url });
  const articlesRows =
    "rowCount" in articlesResult
      ? (articlesResult as { rowCount?: number }).rowCount ?? 0
      : 0;
  log.info({ rowCount: articlesRows }, "Sample news articles seeded");

  log.info("Database seed completed successfully.");
}

// ---------------------------------------------------------------------------
// Script entrypoint — Run when executed directly via `npx tsx src/db/seed.ts`
// ---------------------------------------------------------------------------

seed()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    const log = logger.child({ module: "seed" });
    log.error({ err }, "Seed script failed");
    await closeDatabase();
    process.exit(1);
  });
