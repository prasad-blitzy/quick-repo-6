/**
 * Shared types for the News Fetcher module.
 *
 * This file defines the {@link NormalizedArticle} interface — the standardized
 * article format returned by ALL individual fetcher modules (finnhub, rss-parser,
 * reddit, coingecko, cryptocompare, binance, alpha-vantage, nse-india).
 *
 * Extracted into a separate types file to break the circular dependency between
 * `index.ts` (orchestrator) and individual fetcher modules:
 *   - `index.ts` imports functions from all 8 fetcher modules
 *   - All 8 fetcher modules need `NormalizedArticle` for their return types
 *   - Placing `NormalizedArticle` here (types.ts) breaks the cycle:
 *       types.ts → fetcher.ts, types.ts → index.ts (no cycle)
 *
 * @module news-fetcher/types
 */

/**
 * Normalized representation of a news article or market data point
 * returned by every source-specific fetcher module.
 *
 * All individual fetchers (Finnhub, RSS, Reddit, CoinGecko, CryptoCompare,
 * Binance, Alpha Vantage, NSE India) convert their API-specific response
 * formats into this common shape before returning to the orchestrator.
 *
 * The orchestrator (`index.ts`) aggregates `NormalizedArticle[]` from all
 * fetchers, deduplicates by URL, and stores them in the `news_articles`
 * PostgreSQL table via Drizzle ORM.
 */
export interface NormalizedArticle {
  /**
   * Headline or title of the article / market data summary.
   *
   * @example "Apple Reports Record Q1 Earnings"
   * @example "BTCUSDT up 5.2% in 24h"
   */
  title: string;

  /**
   * Unique URL of the article or data source page.
   * Used as the deduplication key — a UNIQUE constraint on the `news_articles`
   * table prevents duplicate URL inserts via `onConflictDoNothing`.
   *
   * @example "https://finnhub.io/api/v1/news/12345"
   * @example "https://www.coingecko.com/en/coins/bitcoin"
   */
  url: string;

  /**
   * Identifier of the data source that produced this article.
   * Matches the `name` column in the `api_sources` table for health tracking.
   *
   * @example "Finnhub"
   * @example "CoinGecko"
   * @example "EconomicTimes-RSS"
   * @example "Reddit"
   */
  source: string;

  /**
   * Market classification for the article, matching the PostgreSQL
   * `marketEnum` values defined in `db/schema/enums.ts`.
   *
   * - `"us_stock"` — US equity markets (Finnhub, Alpha Vantage, CNBC RSS, MarketWatch RSS)
   * - `"indian_equity"` — Indian equity markets (Economic Times, Financial Express, Business Standard RSS, NSE India)
   * - `"crypto"` — Cryptocurrency markets (CoinGecko, CryptoCompare, Binance)
   * - `"social"` — Social sentiment sources (Reddit: r/wallstreetbets, r/IndianStreetBets)
   */
  market: "us_stock" | "indian_equity" | "crypto" | "social";

  /**
   * Full article body content, if available from the source API.
   * Many APIs provide only headlines and summaries, so this is often `null`.
   *
   * @example null — Finnhub only provides headlines + summaries
   * @example "<p>Full article HTML content...</p>" — RSS feeds may include full content
   */
  content: string | null;

  /**
   * Brief text summary or snippet of the article.
   * Used for display in the dashboard news feed before full analysis.
   *
   * @example "Apple Inc. reported quarterly revenue of $124.3 billion..."
   */
  summary: string | null;

  /**
   * Array of financial ticker symbols related to this article.
   * Extracted from the source API response (e.g., Finnhub's `related` field,
   * Reddit `$SYMBOL` patterns, CoinGecko coin symbols).
   *
   * Empty array `[]` when the source does not provide structured symbol data
   * (e.g., RSS feeds); the analysis pipeline will extract symbols downstream.
   *
   * @example ["AAPL", "MSFT", "GOOGL"]
   * @example ["BTC", "ETH"]
   * @example [] — RSS feeds without symbol annotations
   */
  symbols: string[];

  /**
   * Publication timestamp of the article or data point.
   * Stored as a JavaScript `Date` object; converted to a PostgreSQL
   * `timestamp with time zone` on database insert via Drizzle ORM.
   *
   * For real-time price data sources (Binance, NSE India), this is
   * typically `new Date()` representing the fetch time.
   */
  publishedAt: Date;

  /**
   * Raw API-specific metadata preserved as JSONB in the database.
   * Each fetcher stores source-specific fields here for downstream
   * analysis and debugging.
   *
   * @example { finnhubId: 12345, category: "general", originalSource: "Reuters", imageUrl: "https://..." }
   * @example { subreddit: "wallstreetbets", author: "user123", categories: ["DD"] }
   * @example null — When no additional metadata is available
   */
  metadata: Record<string, unknown> | null;
}
