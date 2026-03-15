/**
 * Finnhub REST API Client — Primary US Stock News Source
 *
 * Fetches general financial news via the Finnhub `/api/v1/news` endpoint and
 * real-time stock quotes via `/api/v1/quote`. This is the highest-quality free
 * API for US stock market news in the Trading Intelligence application.
 *
 * Architecture:
 * - **Auth**: API key passed as `token` query parameter (`env.FINNHUB_API_KEY`)
 * - **Rate Limit**: 60 calls/min via dedicated Bottleneck instance (per AAP 0.7.4)
 * - **Normalization**: All news items are mapped to the `NormalizedArticle` interface
 * - **Freshness Filter**: Articles older than 24 hours are excluded
 * - **Graceful Degradation**: All errors are caught, logged, and never thrown
 *
 * Endpoints used:
 * - `GET /news?category=general&token=...` — General financial news headlines
 * - `GET /quote?symbol=...&token=...` — Real-time stock price quotes
 *
 * @module services/news-fetcher/finnhub
 * @see {@link https://finnhub.io/docs/api} Finnhub API documentation
 */

import { createLogger } from "../../lib/logger.js";
import { getFinnhubLimiter } from "../../lib/rate-limiter.js";
import { env } from "../../config/env.js";
import { API_BASE_URLS, DEFAULTS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Logger and Rate Limiter — Module-Level Singletons
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "finnhub" }` context binding.
 * Used for structured logging of news fetch operations, quote requests,
 * error handling, and article count reporting.
 */
const logger = createLogger("finnhub");

/**
 * Dedicated Bottleneck rate limiter for Finnhub API calls.
 * Configured for 60 calls/min (maxConcurrent: 1, minTime: 1000ms,
 * reservoir: 60, refresh every 60s). Per AAP Rule 0.7.4, each external
 * API source must have its own isolated Bottleneck instance.
 */
const limiter = getFinnhubLimiter();

// ---------------------------------------------------------------------------
// Finnhub API Response Type Definitions
// ---------------------------------------------------------------------------

/**
 * Raw Finnhub news article response item as returned by the
 * `GET /news?category=general` endpoint.
 *
 * @see {@link https://finnhub.io/docs/api/general-news}
 */
interface FinnhubNewsItem {
  /** News category: "general", "forex", "crypto", or "merger" */
  category: string;
  /** Publication timestamp in Unix seconds */
  datetime: number;
  /** Article headline / title */
  headline: string;
  /** Finnhub internal article identifier */
  id: number;
  /** URL to the article's thumbnail image */
  image: string;
  /** Comma-separated related stock symbols (e.g., "AAPL,MSFT,GOOGL") */
  related: string;
  /** Original news source name (e.g., "Yahoo", "Reuters", "MarketWatch") */
  source: string;
  /** Brief article summary text */
  summary: string;
  /** Full URL to the original article */
  url: string;
}

/**
 * Finnhub real-time stock quote response from `GET /quote?symbol=...`.
 * Used for anti-hallucination validation of LLM-generated price targets
 * (AAP Rule 0.7.2).
 *
 * All numeric fields represent USD values or percentages.
 */
export interface FinnhubQuote {
  /** Current price */
  c: number;
  /** Change (absolute dollar change from previous close) */
  d: number;
  /** Percent change from previous close */
  dp: number;
  /** High price of the current trading day */
  h: number;
  /** Low price of the current trading day */
  l: number;
  /** Open price of the current trading day */
  o: number;
  /** Previous close price */
  pc: number;
  /** Timestamp of the quote (Unix seconds) */
  t: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age of articles to include in results.
 * Articles older than 24 hours are filtered out to keep the news feed fresh
 * and prevent the analysis pipeline from processing stale content.
 */
const MAX_ARTICLE_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// fetchFinnhubNews — Primary News Fetch Function
// ---------------------------------------------------------------------------

/**
 * Fetches general financial news from the Finnhub REST API.
 *
 * Workflow:
 * 1. Constructs the `/news?category=general` URL with API key authentication
 * 2. Schedules the HTTP request through the Bottleneck rate limiter
 * 3. Maps the Finnhub-specific response format to `NormalizedArticle[]`
 * 4. Filters out articles older than 24 hours
 * 5. Returns normalized articles (empty array on any error)
 *
 * @returns Promise resolving to an array of normalized news articles.
 *          Returns `[]` on any error (graceful degradation per AAP 0.7.4).
 *
 * @example
 * ```typescript
 * const articles = await fetchFinnhubNews();
 * console.log(`Fetched ${articles.length} US stock news articles`);
 * ```
 */
export async function fetchFinnhubNews(): Promise<NormalizedArticle[]> {
  try {
    const url = `${API_BASE_URLS.FINNHUB}/news?category=general&token=${env.FINNHUB_API_KEY}`;

    logger.info("Fetching general news from Finnhub API");

    // Schedule the HTTP request through the Bottleneck rate limiter to
    // respect the 60 calls/min free-tier limit. The limiter queues
    // requests automatically when the reservoir is depleted.
    // AbortSignal.timeout prevents indefinite hangs on unresponsive API servers.
    const items = await limiter.schedule(async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(`Finnhub API error: ${String(res.status)}`);
      }
      return res.json() as Promise<FinnhubNewsItem[]>;
    });

    // Validate that the response is an array (Finnhub returns [] when
    // the API key is valid but no results match the query).
    if (!Array.isArray(items)) {
      logger.warn("Finnhub API returned non-array response");
      return [];
    }

    // Calculate the 24-hour freshness cutoff timestamp. Articles published
    // before this threshold are excluded to keep the feed current.
    const cutoff = Date.now() - MAX_ARTICLE_AGE_MS;

    // Map Finnhub news items to the standardized NormalizedArticle format
    // and filter out stale articles in a single pass.
    const articles: NormalizedArticle[] = [];

    for (const item of items) {
      // Convert Unix seconds to milliseconds for Date comparison
      const publishedMs = item.datetime * 1000;

      // Skip articles older than 24 hours
      if (publishedMs < cutoff) {
        continue;
      }

      // Parse comma-separated stock symbols from the `related` field.
      // Finnhub may provide an empty string, so filter(Boolean) removes
      // empty entries after splitting.
      const symbols: string[] = item.related
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      articles.push({
        title: item.headline,
        url: item.url,
        source: "Finnhub",
        market: "us_stock",
        content: null,
        summary: item.summary || null,
        symbols,
        publishedAt: new Date(publishedMs),
        metadata: {
          finnhubId: item.id,
          category: item.category,
          originalSource: item.source,
          imageUrl: item.image,
        },
      });
    }

    logger.info(
      { total: items.length, fresh: articles.length },
      "Finnhub news fetch complete",
    );

    return articles;
  } catch (error: unknown) {
    logger.error(
      { error },
      "Failed to fetch news from Finnhub API",
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// fetchFinnhubQuote — Stock Quote Fetch Function
// ---------------------------------------------------------------------------

/**
 * Fetches a real-time stock quote from the Finnhub REST API.
 *
 * This function is primarily used by the recommendation pipeline node for
 * **anti-hallucination validation** (AAP Rule 0.7.2): all LLM-generated
 * price targets must be cross-validated against actual market data. Any price
 * more than 10% away from the current market price is flagged as potentially
 * fabricated.
 *
 * @param symbol — US stock ticker symbol (e.g., "AAPL", "MSFT", "GOOGL").
 * @returns Promise resolving to a `FinnhubQuote` object, or `null` on error.
 *
 * @example
 * ```typescript
 * const quote = await fetchFinnhubQuote("AAPL");
 * if (quote) {
 *   console.log(`AAPL current price: $${quote.c}`);
 *   console.log(`Change: ${quote.dp}%`);
 * }
 * ```
 */
export async function fetchFinnhubQuote(
  symbol: string,
): Promise<FinnhubQuote | null> {
  try {
    const url = `${API_BASE_URLS.FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_API_KEY}`;

    logger.debug({ symbol }, "Fetching stock quote from Finnhub API");

    // Schedule the HTTP request through the shared Finnhub Bottleneck
    // rate limiter. Both news and quote requests share the same 60/min
    // rate limit on the Finnhub free tier.
    // AbortSignal.timeout prevents indefinite hangs on unresponsive API servers.
    const quote = await limiter.schedule(async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(
          `Finnhub quote API error: ${String(res.status)}`,
        );
      }
      return res.json() as Promise<FinnhubQuote>;
    });

    // Finnhub returns an object with all zeros when the symbol is
    // not found or the market is closed with no data. Detect this
    // edge case by checking if the current price is zero.
    if (quote.c === 0 && quote.pc === 0) {
      logger.warn(
        { symbol },
        "Finnhub returned empty quote (symbol not found or market closed)",
      );
      return null;
    }

    logger.debug(
      { symbol, price: quote.c, change: quote.dp },
      "Finnhub quote fetch complete",
    );

    return quote;
  } catch (error: unknown) {
    logger.error(
      { error, symbol },
      "Failed to fetch quote from Finnhub API",
    );
    return null;
  }
}
