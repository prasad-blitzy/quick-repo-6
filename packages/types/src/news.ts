/**
 * News Aggregation Domain Type Definitions
 *
 * Foundational types for the Trading Intelligence Application's news
 * aggregation system. The {@link Market} enum defined here is consumed
 * across the entire monorepo — by `trade.ts`, `user.ts`, `queue.ts`,
 * all database schema files, and both frontend and backend applications.
 *
 * Design constraints (AAP Rules):
 * - No runtime code beyond the Market enum (interfaces are erased at compile time)
 * - No `any` type — `unknown` is used for flexible JSON fields (Rule 0.7.1)
 * - String enums with uppercase values matching PostgreSQL enum definitions
 * - All date fields use ISO 8601 `string` type for JSON serialization, not `Date`
 * - No optional properties (`?:`) — nullable fields use `| null` union
 * - Compiles under TypeScript strict mode with `exactOptionalPropertyTypes`
 */

// ---------------------------------------------------------------------------
// Market Enum
// ---------------------------------------------------------------------------

/**
 * Market categories supported by the trading intelligence platform.
 *
 * String values MUST match the PostgreSQL enum values defined in
 * `apps/api/src/db/schema/enums.ts` to maintain database ↔ application parity.
 *
 * | Value    | Coverage                                                      |
 * |----------|---------------------------------------------------------------|
 * | `US`     | US stocks — Finnhub, CNBC/MarketWatch RSS                     |
 * | `INDIA`  | Indian equities — Economic Times, Financial Express, BSE RSS  |
 * | `CRYPTO` | Cryptocurrency — CoinGecko, CryptoCompare, Binance            |
 * | `SOCIAL` | Social media sentiment — Reddit RSS/API                       |
 */
export enum Market {
  US = 'US',
  INDIA = 'INDIA',
  CRYPTO = 'CRYPTO',
  SOCIAL = 'SOCIAL',
}

// ---------------------------------------------------------------------------
// NewsArticle Interface
// ---------------------------------------------------------------------------

/**
 * Represents a single news article ingested from any supported source.
 *
 * Maps directly to the `news_articles` database table. Fields are designed
 * for JSON-safe serialization (string dates, `Record<string, unknown>` metadata)
 * so they can be transmitted via REST API or queued in BullMQ jobs without
 * transformation.
 *
 * Key invariants:
 * - `url` is unique across the table — used for URL-based deduplication
 *   (AAP Rule 0.7.4) to prevent redundant analysis and notifications.
 * - `symbols` is a string array matching a PostgreSQL `text[]` column.
 * - `metadata` stores arbitrary JSONB data from the originating source API
 *   (e.g., Finnhub response fields, RSS feed attributes, CoinGecko metadata).
 * - `isAnalyzed` is indexed in the database for efficient queries that
 *   retrieve only unprocessed articles.
 */
export interface NewsArticle {
  /** UUID v4 primary key. */
  id: string;

  /** Article headline / title. */
  title: string;

  /** Full article body text or summary excerpt. */
  content: string;

  /**
   * Canonical source URL — **UNIQUE** across all articles.
   * Used for deduplication: duplicate URLs from different polling cycles
   * are silently skipped (AAP Rule 0.7.4).
   */
  url: string;

  /**
   * Lowercase identifier for the originating data source.
   * Examples: `'finnhub'`, `'economic-times-rss'`, `'coingecko'`, `'reddit'`.
   */
  source: string;

  /** Market category this article belongs to. */
  market: Market;

  /**
   * Detected stock / crypto ticker symbols mentioned in the article.
   * Examples: `['AAPL', 'TSLA']` for US stocks, `['BTC', 'ETH']` for crypto.
   * Maps to a PostgreSQL `text[]` column.
   */
  symbols: string[];

  /** ISO 8601 date-time string of when the article was originally published. */
  publishedAt: string;

  /**
   * Flexible key-value metadata bag from the originating source API.
   * Stored as PostgreSQL `jsonb`. Uses `unknown` (not `any`) per
   * AAP Rule 0.7.1 — callers must narrow the type before use.
   */
  metadata: Record<string, unknown>;

  /**
   * Whether this article has been processed by the LangGraph analysis
   * pipeline. Indexed in the database for efficient retrieval of
   * unanalyzed articles.
   */
  isAnalyzed: boolean;

  /** ISO 8601 timestamp of when the database row was created. */
  createdAt: string;

  /** ISO 8601 timestamp of the last database row update. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// NewsSource Interface
// ---------------------------------------------------------------------------

/**
 * Represents a registered external data source in the API source registry.
 *
 * Maps directly to the `api_sources` database table. Each record describes
 * one data feed (REST API, RSS feed, or scraper) together with its
 * operational metadata (rate limit budget, error count, last fetch time).
 *
 * Key behaviors:
 * - `errorCount` is incremented on every fetch failure for the source,
 *   enabling monitoring dashboards and automatic disabling (AAP Rule 0.7.4).
 * - `rateLimit` (requests per minute) is used to configure per-source
 *   Bottleneck rate limiter instances (AAP Rule 0.7.4).
 * - `lastFetchedAt` is nullable — `null` indicates the source has never
 *   been successfully fetched.
 */
export interface NewsSource {
  /** UUID v4 primary key. */
  id: string;

  /** Human-readable display name (e.g., `'Finnhub'`, `'CoinGecko'`). */
  name: string;

  /**
   * Source type classifier.
   * Expected values: `'api'` | `'rss'` | `'scraper'`.
   */
  type: string;

  /** Market category this source covers. */
  market: Market;

  /** Base URL for the API endpoint or RSS feed. */
  baseUrl: string;

  /** Whether this source is currently enabled for polling. */
  isActive: boolean;

  /**
   * Maximum number of requests per minute allowed for this source.
   * Used to configure a dedicated Bottleneck rate limiter instance.
   */
  rateLimit: number;

  /**
   * Running count of consecutive or cumulative fetch errors.
   * Incremented on failure; can be reset on successful fetch or manually.
   */
  errorCount: number;

  /**
   * ISO 8601 timestamp of the last successful fetch, or `null` if the
   * source has never been successfully fetched.
   */
  lastFetchedAt: string | null;

  /** ISO 8601 timestamp of when the source record was created. */
  createdAt: string;

  /** ISO 8601 timestamp of the last source record update. */
  updatedAt: string;
}
