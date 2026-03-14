/**
 * News Fetcher Orchestrator Service
 *
 * This is the **single entry point** for the multi-market news aggregation
 * layer. It invokes ALL source-specific fetcher modules in parallel using
 * `Promise.allSettled()`, aggregates their results into a normalized
 * `NormalizedArticle[]` array, and handles per-source failures gracefully.
 *
 * Architecture:
 * - **Parallel execution**: All fetchers run concurrently via `Promise.allSettled()`
 *   so one failing source never blocks others (AAP Rule 0.7.4).
 * - **Graceful degradation**: Each fetcher failure is logged and the corresponding
 *   `api_sources.error_count` is atomically incremented. Successful fetches reset
 *   `error_count` to 0 and update `last_fetched_at`.
 * - **Selective polling**: The `fetchAllNews()` function accepts optional `markets`
 *   and `sources` filters to invoke only a subset of fetchers.
 * - **URL-based deduplication**: The `storeArticles()` function uses PostgreSQL's
 *   `ON CONFLICT (url) DO NOTHING` to silently skip duplicate articles.
 *
 * Fetcher Registry (9 entries covering 4 markets):
 * | Source          | Market         | Module           |
 * |-----------------|----------------|------------------|
 * | Finnhub         | us_stock       | finnhub.ts       |
 * | RSS-Indian      | indian_equity  | rss-parser.ts    |
 * | RSS-US          | us_stock       | rss-parser.ts    |
 * | Reddit          | social         | reddit.ts        |
 * | CoinGecko       | crypto         | coingecko.ts     |
 * | CryptoCompare   | crypto         | cryptocompare.ts |
 * | Binance         | crypto         | binance.ts       |
 * | AlphaVantage    | us_stock       | alpha-vantage.ts |
 * | NseIndia        | indian_equity  | nse-india.ts     |
 *
 * Consumers:
 * - `apps/api/src/queues/workers/news-polling.worker.ts` — calls `fetchAllNews()`
 *   then `storeArticles()` on every 5-minute cron tick.
 *
 * @module services/news-fetcher
 */

// ---------------------------------------------------------------------------
// External Dependencies
// ---------------------------------------------------------------------------

import { eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Internal Dependencies — Infrastructure
// ---------------------------------------------------------------------------

import { createLogger } from "../../lib/logger.js";
import { db } from "../../db/index.js";
import { newsArticles } from "../../db/schema/news-articles.js";
import { apiSources } from "../../db/schema/api-sources.js";

// ---------------------------------------------------------------------------
// Internal Dependencies — Types (re-exported for backward compatibility)
// ---------------------------------------------------------------------------

import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Internal Dependencies — Source-Specific Fetcher Modules
// ---------------------------------------------------------------------------

import { fetchFinnhubNews } from "./finnhub.js";
import { fetchRssNews } from "./rss-parser.js";
import { fetchRedditPosts } from "./reddit.js";
import { fetchCoinGeckoData } from "./coingecko.js";
import { fetchCryptoCompareNews } from "./cryptocompare.js";
import { fetchBinanceData } from "./binance.js";
import { fetchAlphaVantageNews } from "./alpha-vantage.js";
import { fetchNseIndiaData } from "./nse-india.js";

// ---------------------------------------------------------------------------
// Re-export NormalizedArticle for consumers that import from this index
// ---------------------------------------------------------------------------

export type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Logger — Module-Level Singleton
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "news-fetcher" }` context binding.
 * Used for structured logging of fetcher orchestration events, per-source
 * success/failure counts, article aggregation totals, and deduplication
 * storage results.
 */
const logger = createLogger("news-fetcher");

// ---------------------------------------------------------------------------
// FetcherDefinition — Internal Registry Type
// ---------------------------------------------------------------------------

/**
 * Defines a single entry in the fetcher registry.
 *
 * Each entry maps a human-readable source name (matching the `api_sources.name`
 * column in the database) to a market category and an async function that
 * returns normalized articles.
 */
interface FetcherDefinition {
  /** Source name matching `api_sources.name` (e.g., "Finnhub", "CoinGecko") */
  readonly name: string;

  /** Market category: "us_stock", "indian_equity", "crypto", "social" */
  readonly market: string;

  /** Async function that fetches and normalizes articles from this source */
  readonly fn: () => Promise<NormalizedArticle[]>;
}

// ---------------------------------------------------------------------------
// Fetcher Registry — All 9 Source Entries
// ---------------------------------------------------------------------------

/**
 * Static registry of all fetcher definitions. Each entry ties a source name
 * and market category to the corresponding fetcher function.
 *
 * The `fetchRssNews` function is registered twice with different market
 * parameters — once for Indian equity feeds (Economic Times, Financial
 * Express, Business Standard) and once for US stock feeds (CNBC, MarketWatch).
 *
 * The order of entries determines parallel execution order but does NOT affect
 * results since all fetchers run concurrently via `Promise.allSettled()`.
 */
const fetchers: readonly FetcherDefinition[] = [
  { name: "Finnhub", market: "us_stock", fn: fetchFinnhubNews },
  { name: "RSS-EconomicTimes", market: "indian_equity", fn: () => fetchRssNews("indian") },
  { name: "RSS-CNBC", market: "us_stock", fn: () => fetchRssNews("us") },
  { name: "Reddit", market: "social", fn: fetchRedditPosts },
  { name: "CoinGecko", market: "crypto", fn: fetchCoinGeckoData },
  { name: "CryptoCompare", market: "crypto", fn: fetchCryptoCompareNews },
  { name: "Binance", market: "crypto", fn: fetchBinanceData },
  { name: "AlphaVantage", market: "us_stock", fn: fetchAlphaVantageNews },
  { name: "NseIndia", market: "indian_equity", fn: fetchNseIndiaData },
] as const;

// ---------------------------------------------------------------------------
// fetchAllNews() — Main Orchestrator Function
// ---------------------------------------------------------------------------

/**
 * Fetches news from all registered sources (or a filtered subset) in parallel,
 * aggregating results into a single `NormalizedArticle[]` array.
 *
 * **Parallel execution with graceful degradation:**
 * All fetchers execute concurrently via `Promise.allSettled()`. A single failing
 * source never blocks or cancels the others. For each result:
 * - **Fulfilled**: articles are aggregated; `api_sources.error_count` is reset
 *   to 0 and `last_fetched_at` is updated to the current timestamp.
 * - **Rejected**: the error is logged with source context; `api_sources.error_count`
 *   is atomically incremented via SQL expression `error_count + 1`.
 *
 * **Selective polling:**
 * The optional `options` parameter allows filtering by market category or
 * specific source names. When omitted, all 9 sources are polled.
 *
 * @param options - Optional filters to select a subset of fetchers.
 * @param options.markets - Array of market categories to include (e.g., `["us_stock", "crypto"]`).
 * @param options.sources - Array of source names to include (e.g., `["Finnhub", "CoinGecko"]`).
 * @returns Aggregated array of normalized articles from all successful fetchers.
 *
 * @example
 * ```typescript
 * // Fetch from all sources
 * const allArticles = await fetchAllNews();
 *
 * // Fetch only crypto sources
 * const cryptoArticles = await fetchAllNews({ markets: ["crypto"] });
 *
 * // Fetch from specific sources
 * const targeted = await fetchAllNews({ sources: ["Finnhub", "Reddit"] });
 * ```
 */
export async function fetchAllNews(options?: {
  markets?: string[] | undefined;
  sources?: string[] | undefined;
}): Promise<NormalizedArticle[]> {
  // -------------------------------------------------------------------------
  // Step 1: Filter the fetcher registry based on optional criteria
  // -------------------------------------------------------------------------
  let activeFetchers: readonly FetcherDefinition[] = fetchers;

  if (options?.markets && options.markets.length > 0) {
    const marketSet = new Set(options.markets);
    activeFetchers = activeFetchers.filter((f) => marketSet.has(f.market));
  }

  if (options?.sources && options.sources.length > 0) {
    const sourceSet = new Set(options.sources);
    activeFetchers = activeFetchers.filter((f) => sourceSet.has(f.name));
  }

  if (activeFetchers.length === 0) {
    logger.warn(
      { markets: options?.markets, sources: options?.sources },
      "No active fetchers after filtering — returning empty result",
    );
    return [];
  }

  logger.info(
    {
      totalRegistered: fetchers.length,
      activeCount: activeFetchers.length,
      activeNames: activeFetchers.map((f) => f.name),
    },
    "Starting parallel news fetch",
  );

  // -------------------------------------------------------------------------
  // Step 2: Execute ALL fetchers in parallel using Promise.allSettled()
  // -------------------------------------------------------------------------
  // CRITICAL: Promise.allSettled() ensures one failing fetcher does NOT block
  // others. Promise.all() would reject on the first failure — DO NOT use it.
  const results = await Promise.allSettled(
    activeFetchers.map(async (fetcher) => {
      const articles = await fetcher.fn();
      return { name: fetcher.name, articles };
    }),
  );

  // -------------------------------------------------------------------------
  // Step 3: Process results — aggregate successes, log and track failures
  // -------------------------------------------------------------------------
  const allArticles: NormalizedArticle[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (const [idx, result] of results.entries()) {
    const fetcher = activeFetchers[idx];
    if (!fetcher) {
      // Guard for noUncheckedIndexedAccess — should never happen since
      // results and activeFetchers have the same length
      continue;
    }

    if (result.status === "fulfilled") {
      // -------------------------------------------------------------------
      // Fulfilled: Aggregate articles and update api_sources health
      // -------------------------------------------------------------------
      allArticles.push(...result.value.articles);
      successCount++;

      logger.info(
        { source: fetcher.name, count: result.value.articles.length },
        "Fetched articles successfully",
      );

      // Update api_sources: reset error_count to 0, set last_fetched_at
      // Non-critical — catch DB errors to prevent disrupting aggregation
      await db
        .update(apiSources)
        .set({ errorCount: 0, lastFetchedAt: new Date() })
        .where(eq(apiSources.name, fetcher.name))
        .catch((err: unknown) => {
          logger.error(
            { err, source: fetcher.name },
            "Failed to update api_sources on success",
          );
        });
    } else {
      // -------------------------------------------------------------------
      // Rejected: Log error and atomically increment api_sources.error_count
      // -------------------------------------------------------------------
      failureCount++;

      logger.error(
        { source: fetcher.name, error: result.reason },
        "Fetcher failed — graceful degradation applied",
      );

      // Atomically increment error_count via SQL expression:
      // SET error_count = error_count + 1
      // Non-critical — catch DB errors to prevent disrupting aggregation
      await db
        .update(apiSources)
        .set({ errorCount: sql`${apiSources.errorCount} + 1` })
        .where(eq(apiSources.name, fetcher.name))
        .catch((err: unknown) => {
          logger.error(
            { err, source: fetcher.name },
            "Failed to update api_sources error count",
          );
        });
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Log summary and return aggregated articles
  // -------------------------------------------------------------------------
  logger.info(
    {
      totalArticles: allArticles.length,
      successfulSources: successCount,
      failedSources: failureCount,
    },
    "News fetch cycle complete",
  );

  return allArticles;
}

// ---------------------------------------------------------------------------
// storeArticles() — URL-Based Deduplication Storage
// ---------------------------------------------------------------------------

/**
 * Stores an array of normalized articles into the `news_articles` PostgreSQL
 * table with URL-based deduplication.
 *
 * Uses Drizzle ORM's `onConflictDoNothing({ target: newsArticles.url })` to
 * silently skip articles whose URL already exists in the database. This
 * implements the AAP Rule 0.7.4 requirement for URL-based deduplication:
 * "Duplicate URLs from different polling cycles must be silently skipped,
 * not error."
 *
 * The function returns the count of **newly inserted** articles (not counting
 * duplicates that were silently skipped).
 *
 * @param articles - Array of normalized articles to store.
 * @returns Number of newly inserted articles (excluding duplicates).
 *
 * @example
 * ```typescript
 * const articles = await fetchAllNews();
 * const insertedCount = await storeArticles(articles);
 * console.log(`Inserted ${insertedCount} new articles out of ${articles.length} total`);
 * ```
 */
export async function storeArticles(
  articles: NormalizedArticle[],
): Promise<number> {
  // Early return for empty input — avoids unnecessary DB operations
  if (articles.length === 0) {
    logger.debug("No articles to store — skipping database insert");
    return 0;
  }

  // -------------------------------------------------------------------------
  // Map NormalizedArticle[] to the Drizzle insert format
  // -------------------------------------------------------------------------
  // The insert data must match the news_articles schema columns:
  // - title, url, source, market, content, summary, symbols, publishedAt, metadata
  // - isAnalyzed defaults to false for newly ingested articles
  // - id, createdAt, updatedAt are auto-generated by the database
  const insertData = articles.map((article) => ({
    title: article.title,
    url: article.url,
    source: article.source,
    market: article.market,
    content: article.content,
    summary: article.summary,
    symbols: article.symbols,
    publishedAt: article.publishedAt,
    metadata: article.metadata,
    isAnalyzed: false,
  }));

  // -------------------------------------------------------------------------
  // Insert with ON CONFLICT (url) DO NOTHING for deduplication
  // -------------------------------------------------------------------------
  // The UNIQUE index on newsArticles.url ensures that duplicate articles from
  // different polling cycles are silently rejected. The .returning() clause
  // gives us back only the IDs of successfully inserted rows — the count of
  // returned rows equals the number of NEW (non-duplicate) articles.
  // NOTE: After .onConflictDoNothing(), Drizzle ORM's type system only
  // permits .returning() without field selection arguments. We call
  // .returning() to get the full row objects and use .length for the count.
  const result = await db
    .insert(newsArticles)
    .values(insertData)
    .onConflictDoNothing({ target: newsArticles.url })
    .returning();

  const insertedCount = result.length;

  logger.info(
    {
      total: articles.length,
      inserted: insertedCount,
      duplicates: articles.length - insertedCount,
    },
    "Stored articles with deduplication",
  );

  return insertedCount;
}
