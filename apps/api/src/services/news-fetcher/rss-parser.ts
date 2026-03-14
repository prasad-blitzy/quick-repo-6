/**
 * Generic RSS Feed Parser — Multi-Market Financial News
 *
 * Fetches and normalizes news articles from Indian market and US financial
 * news RSS/Atom feeds using the `rss-parser` npm package (v3.13.x).
 *
 * Configured feeds (5 total):
 * - **Indian Equity**: Economic Times, Financial Express, Business Standard
 * - **US Stock**: CNBC, MarketWatch
 *
 * Feed URLs are configurable via environment variables
 * (`RSS_ECONOMIC_TIMES`, `RSS_FINANCIAL_EXPRESS`, `RSS_BUSINESS_STANDARD`)
 * with fallback to constants defined in `config/constants.ts`.
 *
 * Key design decisions:
 * - Uses `Promise.allSettled()` for per-feed graceful degradation — a single
 *   feed failure does not halt fetching from other feeds (AAP Rule 0.7.4).
 * - No Bottleneck rate limiter — RSS feeds are public with no formal API
 *   rate limits. A 10-second timeout per feed guards against slow servers.
 * - Items without URLs are filtered out since URL is the deduplication key.
 * - All errors are caught and logged, never thrown — the orchestrator can
 *   always expect a resolved `NormalizedArticle[]` (possibly empty).
 *
 * @module services/news-fetcher/rss-parser
 * @see {@link https://github.com/rbren/rss-parser} rss-parser documentation
 */

import RssParser from "rss-parser";
import { createLogger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { RSS_FEED_URLS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Logger and Parser Initialization
// ---------------------------------------------------------------------------

/**
 * Child logger with `{ module: "rss-parser" }` context.
 * All log entries from this module are automatically tagged for filtering
 * in log aggregation tools.
 */
const logger = createLogger("rss-parser");

/**
 * Singleton RSS parser instance with a 10-second per-feed timeout and
 * a custom `User-Agent` header to identify the bot to feed servers.
 *
 * The timeout prevents the entire fetch operation from hanging when a
 * feed server is unresponsive. Each feed is fetched independently via
 * `Promise.allSettled()`, so one slow feed does not delay others.
 */
const parser = new RssParser({
  timeout: 10_000,
  headers: {
    "User-Agent": "TradingIntelligenceBot/1.0",
  },
});

// ---------------------------------------------------------------------------
// Feed Configuration Registry
// ---------------------------------------------------------------------------

/**
 * Configuration for a single RSS feed source.
 *
 * @property name   — Human-readable feed name (used in logs and metadata)
 * @property url    — RSS/Atom feed URL to fetch
 * @property market — Market classification matching PostgreSQL `marketEnum`
 * @property source — Source identifier matching `api_sources.name` column
 */
interface FeedConfig {
  name: string;
  url: string;
  market: "us_stock" | "indian_equity";
  source: string;
}

/**
 * Indian equity market RSS feeds.
 *
 * Feed URLs are resolved from environment variables first, falling back
 * to the static constants in `config/constants.ts`. This allows operators
 * to switch feed URLs without code changes (AAP Rule 0.7.4).
 *
 * Note: `env.RSS_*` always has a value because the Zod schema in `env.ts`
 * defines defaults. The `??` fallback to `RSS_FEED_URLS.*` is a defensive
 * safeguard in case the env schema changes to make these fields optional.
 */
const INDIAN_FEEDS: FeedConfig[] = [
  {
    name: "Economic Times Markets",
    url: env.RSS_ECONOMIC_TIMES ?? RSS_FEED_URLS.ECONOMIC_TIMES,
    market: "indian_equity",
    source: "EconomicTimes-RSS",
  },
  {
    name: "Financial Express Markets",
    url: env.RSS_FINANCIAL_EXPRESS ?? RSS_FEED_URLS.FINANCIAL_EXPRESS,
    market: "indian_equity",
    source: "FinancialExpress-RSS",
  },
  {
    name: "Business Standard Markets",
    url: env.RSS_BUSINESS_STANDARD ?? RSS_FEED_URLS.BUSINESS_STANDARD,
    market: "indian_equity",
    source: "BusinessStandard-RSS",
  },
];

/**
 * US stock market RSS feeds.
 *
 * These supplement Finnhub API coverage for US market news.
 * No environment variable overrides — CNBC and MarketWatch RSS endpoints
 * are stable public URLs.
 */
const US_FEEDS: FeedConfig[] = [
  {
    name: "CNBC Markets",
    url: RSS_FEED_URLS.CNBC,
    market: "us_stock",
    source: "CNBC-RSS",
  },
  {
    name: "MarketWatch Top Stories",
    url: RSS_FEED_URLS.MARKETWATCH,
    market: "us_stock",
    source: "MarketWatch-RSS",
  },
];

/**
 * Combined list of all configured RSS feeds.
 * Used when no market filter is specified in `fetchRssNews()`.
 */
const ALL_FEEDS: FeedConfig[] = [...INDIAN_FEEDS, ...US_FEEDS];

// ---------------------------------------------------------------------------
// Helper — Map RSS Item to NormalizedArticle
// ---------------------------------------------------------------------------

/**
 * Maps a single RSS feed item to the {@link NormalizedArticle} format.
 *
 * RSS feeds rarely include structured symbol data (unlike Finnhub's
 * `related` field or CoinGecko's `symbol` property), so `symbols` is
 * always `[]`. The downstream LangGraph analysis pipeline will extract
 * relevant ticker symbols during the filter/sentiment stages.
 *
 * @param item — Parsed RSS item from `rss-parser`
 * @param feed — Feed configuration that produced this item
 * @returns NormalizedArticle representation of the RSS item
 */
function mapItemToArticle(
  item: RssParser.Item,
  feed: FeedConfig,
): NormalizedArticle {
  return {
    title: item.title ?? "Untitled",
    url: item.link ?? "",
    source: feed.source,
    market: feed.market,
    content: item.content ?? null,
    summary: item.contentSnippet ?? null,
    symbols: [],
    publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
    metadata: {
      feedName: feed.name,
      creator: item.creator ?? null,
      categories: item.categories ?? [],
      guid: item.guid ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Main Fetch Function
// ---------------------------------------------------------------------------

/**
 * Fetches and normalizes news articles from configured RSS feeds.
 *
 * Supports selective market fetching via the `market` parameter:
 * - `"indian"` — Fetches only Indian equity feeds (Economic Times, Financial Express, Business Standard)
 * - `"us"` — Fetches only US stock feeds (CNBC, MarketWatch)
 * - `undefined` — Fetches all 5 feeds across both markets
 *
 * Individual feed failures are handled gracefully — a single feed timing
 * out or returning an error does not prevent other feeds from being
 * processed (AAP Rule 0.7.4: graceful degradation).
 *
 * Items without URLs are filtered out because the URL serves as the
 * deduplication key in the `news_articles` database table.
 *
 * @param market — Optional market filter to restrict which feeds are fetched
 * @returns Normalized articles from all successfully fetched feeds. Returns
 *          an empty array if all feeds fail or an unexpected error occurs.
 *
 * @example
 * ```typescript
 * // Fetch all feeds
 * const allArticles = await fetchRssNews();
 *
 * // Fetch only Indian market feeds
 * const indianArticles = await fetchRssNews("indian");
 *
 * // Fetch only US market feeds
 * const usArticles = await fetchRssNews("us");
 * ```
 */
export async function fetchRssNews(
  market?: "indian" | "us",
): Promise<NormalizedArticle[]> {
  try {
    // Select feeds based on market filter
    let feeds: FeedConfig[];
    if (market === "indian") {
      feeds = INDIAN_FEEDS;
    } else if (market === "us") {
      feeds = US_FEEDS;
    } else {
      feeds = ALL_FEEDS;
    }

    logger.info(
      { market: market ?? "all", feedCount: feeds.length },
      "Starting RSS feed fetch",
    );

    // Fetch all selected feeds in parallel with graceful degradation.
    // Promise.allSettled ensures one feed's failure doesn't block others.
    const results = await Promise.allSettled(
      feeds.map(async (feed) => {
        const parsed = await parser.parseURL(feed.url);
        return { feed, items: parsed.items };
      }),
    );

    const articles: NormalizedArticle[] = [];

    // Process each feed result independently
    for (const [idx, result] of results.entries()) {
      const feed = feeds[idx];
      // Guard for noUncheckedIndexedAccess — feeds[idx] may be undefined
      if (!feed) {
        continue;
      }

      if (result.status === "fulfilled") {
        // Map RSS items to NormalizedArticle, filter out items without URLs
        const feedArticles = result.value.items
          .map((item) => mapItemToArticle(item, feed))
          .filter((article) => article.url.length > 0);

        articles.push(...feedArticles);

        logger.info(
          {
            feed: feed.name,
            source: feed.source,
            rawItems: result.value.items.length,
            validArticles: feedArticles.length,
          },
          "RSS feed fetched successfully",
        );
      } else {
        // Log the error but continue processing other feeds
        logger.error(
          {
            feed: feed.name,
            url: feed.url,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          },
          "Failed to fetch RSS feed",
        );
      }
    }

    logger.info(
      { totalArticles: articles.length, market: market ?? "all" },
      "RSS feed fetch complete",
    );

    return articles;
  } catch (error: unknown) {
    // Catch-all for unexpected errors (e.g., feed array construction issues).
    // Return empty array so the orchestrator always receives a valid response.
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        market: market ?? "all",
      },
      "Unexpected error in RSS feed fetch",
    );
    return [];
  }
}
