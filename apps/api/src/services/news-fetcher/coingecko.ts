/**
 * CoinGecko API Client — Trading Intelligence News Fetcher
 *
 * Fetches cryptocurrency trending coins and significant market movers from the
 * CoinGecko public API (v3). This module is one of 8 source-specific fetcher
 * modules orchestrated by the news-fetcher `index.ts` orchestrator.
 *
 * Two CoinGecko endpoints are consumed:
 *
 * 1. **`/search/trending`** — Returns the top-7 trending coins by search
 *    volume over the past 24 hours. These are coins experiencing viral
 *    attention and are often correlated with price movement.
 *
 * 2. **`/coins/markets`** — Returns the top-25 coins by market cap with
 *    24-hour and 7-day price change data. Only coins with >5% absolute
 *    24h change are included as "significant market movers."
 *
 * Authentication:
 * - Optional `x-cg-demo-key` header (free demo API key improves rate limits).
 * - Free tier works without any key at 30 calls/min.
 *
 * Rate Limiting:
 * - Dedicated Bottleneck instance via `getCoinGeckoLimiter()` — 30 calls/min,
 *   maxConcurrent=1, minTime=2000ms (AAP Rule 0.7.4: per-API isolation).
 *
 * Error Handling:
 * - Graceful degradation per AAP Rule 0.7.4 — any error is caught, logged,
 *   and an empty array is returned. Individual fetcher failures must never
 *   halt the polling cycle.
 *
 * @module services/news-fetcher/coingecko
 * @see {@link https://www.coingecko.com/en/api/documentation} CoinGecko API docs
 */

import { createLogger } from "../../lib/logger.js";
import { getCoinGeckoLimiter } from "../../lib/rate-limiter.js";
import { env } from "../../config/env.js";
import { API_BASE_URLS, DEFAULTS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Module Logger & Rate Limiter
// ---------------------------------------------------------------------------

/**
 * Child Pino logger scoped to the CoinGecko fetcher module.
 * All log entries include `{ module: "coingecko" }` for structured filtering.
 */
const logger = createLogger("coingecko");

/**
 * Dedicated Bottleneck rate limiter for CoinGecko API calls.
 * Configured to 30 calls/min with maxConcurrent=1, minTime=2000ms.
 * Both `/search/trending` and `/coins/markets` calls go through this limiter.
 */
const limiter = getCoinGeckoLimiter();

// ---------------------------------------------------------------------------
// CoinGecko API Response Types
// ---------------------------------------------------------------------------

/**
 * Shape of the CoinGecko `/search/trending` API response.
 * Contains an array of trending coin items ordered by search volume score.
 */
interface CoinGeckoTrendingResponse {
  coins: Array<{
    item: {
      /** CoinGecko slug identifier (e.g., "bitcoin") */
      id: string;
      /** CoinGecko internal numeric coin ID */
      coin_id: number;
      /** Human-readable coin name (e.g., "Bitcoin") */
      name: string;
      /** Ticker symbol (e.g., "btc") — NOTE: lowercase from API */
      symbol: string;
      /** Market capitalization rank (1 = highest) */
      market_cap_rank: number;
      /** Thumbnail image URL (smallest) */
      thumb: string;
      /** Small image URL */
      small: string;
      /** Large image URL */
      large: string;
      /** URL-safe slug for CoinGecko coin page (e.g., "bitcoin") */
      slug: string;
      /** Price denominated in BTC */
      price_btc: number;
      /** Trending score (0 = most trending) */
      score: number;
      /** Additional pricing and market data */
      data: {
        /** Current price as formatted string (e.g., "$97,123.45") */
        price: string;
        /** 24h price change percentages keyed by currency code */
        price_change_percentage_24h: Record<string, number>;
        /** Market cap as formatted string */
        market_cap: string;
        /** Total 24h trading volume as formatted string */
        total_volume: string;
      };
    };
  }>;
}

/**
 * Shape of a single coin entry from the CoinGecko `/coins/markets` response.
 * Contains current pricing, volume, and change data for market analysis.
 */
interface CoinGeckoMarketCoin {
  /** CoinGecko slug identifier (e.g., "bitcoin") */
  id: string;
  /** Ticker symbol (e.g., "btc") — lowercase from API */
  symbol: string;
  /** Human-readable coin name (e.g., "Bitcoin") */
  name: string;
  /** Current price in USD */
  current_price: number;
  /** Total market capitalization in USD */
  market_cap: number;
  /** Market cap rank (1 = highest) */
  market_cap_rank: number;
  /** 24-hour price change as a percentage (-100 to +∞) */
  price_change_percentage_24h: number;
  /** 7-day price change percentage, null if unavailable */
  price_change_percentage_7d_in_currency: number | null;
  /** 24-hour total trading volume in USD */
  total_volume: number;
  /** 24-hour high price in USD */
  high_24h: number;
  /** 24-hour low price in USD */
  low_24h: number;
  /** ISO 8601 timestamp of last data update from CoinGecko */
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Minimum 24h Change Threshold for Market Movers
// ---------------------------------------------------------------------------

/**
 * Minimum absolute 24-hour price change percentage required for a coin to be
 * classified as a "significant market mover." Coins with less than this
 * threshold are filtered out from the market movers list because small price
 * movements are not actionable for trade recommendations.
 */
const MARKET_MOVER_THRESHOLD_PERCENT = 5;

// ---------------------------------------------------------------------------
// Helper — Build HTTP Headers
// ---------------------------------------------------------------------------

/**
 * Constructs the HTTP headers for CoinGecko API requests.
 *
 * - Always includes `Accept: application/json`.
 * - Conditionally includes the `x-cg-demo-key` header if
 *   `env.COINGECKO_API_KEY` is set (non-empty string). The demo key
 *   increases the free-tier rate limit and is the authentication method
 *   documented by CoinGecko for their demo/free plan.
 *
 * @returns Headers object suitable for the native `fetch()` API.
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (env.COINGECKO_API_KEY) {
    headers["x-cg-demo-key"] = env.COINGECKO_API_KEY;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Helper — Fetch Trending Coins
// ---------------------------------------------------------------------------

/**
 * Fetches the CoinGecko `/search/trending` endpoint and normalizes the
 * response into `NormalizedArticle[]`.
 *
 * Each trending coin becomes an article with:
 * - Title describing the coin's trending status and rank
 * - URL pointing to the CoinGecko coin page (used for deduplication)
 * - Metadata containing price data, market cap rank, and trending score
 *
 * @returns Array of normalized articles for trending coins, or empty array on failure.
 */
async function fetchTrendingCoins(): Promise<NormalizedArticle[]> {
  const url = `${API_BASE_URLS.COINGECKO}/search/trending`;

  logger.info({ url }, "Fetching CoinGecko trending coins");

  const response = await limiter.schedule(() =>
    fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS) }),
  );

  if (!response.ok) {
    throw new Error(
      `CoinGecko trending error: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as CoinGeckoTrendingResponse;

  if (!data.coins || !Array.isArray(data.coins)) {
    logger.warn("CoinGecko trending response missing coins array");
    return [];
  }

  const now = new Date();

  const articles: NormalizedArticle[] = data.coins.map((coin) => {
    const { item } = coin;
    const symbolUpper = item.symbol.toUpperCase();

    return {
      title: `${item.name} (${symbolUpper}) trending on CoinGecko — Rank #${String(item.score + 1)}`,
      url: `https://www.coingecko.com/en/coins/${item.slug}`,
      source: "CoinGecko",
      market: "crypto" as const,
      content: null,
      summary: `${item.name} is trending at rank #${String(item.score + 1)} on CoinGecko with a market cap rank of #${String(item.market_cap_rank)}.`,
      symbols: [symbolUpper],
      publishedAt: now,
      metadata: {
        coingeckoId: item.id,
        coinId: item.coin_id,
        slug: item.slug,
        marketCapRank: item.market_cap_rank,
        trendingScore: item.score,
        priceBtc: item.price_btc,
        priceUsd: item.data.price,
        priceChange24h: item.data.price_change_percentage_24h,
        marketCap: item.data.market_cap,
        totalVolume: item.data.total_volume,
        thumbnailUrl: item.thumb,
        type: "trending",
      },
    };
  });

  logger.info(
    { count: articles.length },
    "Normalized CoinGecko trending coins",
  );

  return articles;
}

// ---------------------------------------------------------------------------
// Helper — Fetch Market Movers
// ---------------------------------------------------------------------------

/**
 * Fetches the CoinGecko `/coins/markets` endpoint for the top 25 coins by
 * market cap, then filters to include only coins with >5% absolute 24-hour
 * price change (significant market movers).
 *
 * Each qualifying coin becomes an article with:
 * - Title describing the direction and magnitude of the price move
 * - URL pointing to the CoinGecko coin page (used for deduplication)
 * - Metadata containing current price, volume, and change data
 *
 * @returns Array of normalized articles for significant market movers, or empty array on failure.
 */
async function fetchMarketMovers(): Promise<NormalizedArticle[]> {
  const url = `${API_BASE_URLS.COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=false&price_change_percentage=24h,7d`;

  logger.info({ url }, "Fetching CoinGecko market data");

  const response = await limiter.schedule(() =>
    fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS) }),
  );

  if (!response.ok) {
    throw new Error(
      `CoinGecko markets error: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as CoinGeckoMarketCoin[];

  if (!Array.isArray(data)) {
    logger.warn("CoinGecko markets response is not an array");
    return [];
  }

  const now = new Date();

  // Filter to only significant movers (>5% absolute 24h change)
  const significantMovers = data.filter((coin) => {
    const changePercent = coin.price_change_percentage_24h;
    // Guard against null/undefined/NaN values from the API
    if (changePercent == null || Number.isNaN(changePercent)) {
      return false;
    }
    return Math.abs(changePercent) > MARKET_MOVER_THRESHOLD_PERCENT;
  });

  const articles: NormalizedArticle[] = significantMovers.map((coin) => {
    const symbolUpper = coin.symbol.toUpperCase();
    const changePercent = coin.price_change_percentage_24h;
    const direction = changePercent >= 0 ? "up" : "down";
    const absChange = Math.abs(changePercent).toFixed(1);

    return {
      title: `${coin.name} (${symbolUpper}) ${direction} ${absChange}% in 24h`,
      url: `https://www.coingecko.com/en/coins/${coin.id}`,
      source: "CoinGecko",
      market: "crypto" as const,
      content: null,
      summary: `${coin.name} moved ${direction} ${absChange}% in the last 24 hours. Current price: $${String(coin.current_price)}. 24h volume: $${String(coin.total_volume)}.`,
      symbols: [symbolUpper],
      publishedAt: now,
      metadata: {
        coingeckoId: coin.id,
        currentPrice: coin.current_price,
        marketCap: coin.market_cap,
        marketCapRank: coin.market_cap_rank,
        priceChange24hPercent: changePercent,
        priceChange7dPercent: coin.price_change_percentage_7d_in_currency,
        totalVolume: coin.total_volume,
        high24h: coin.high_24h,
        low24h: coin.low_24h,
        lastUpdated: coin.last_updated,
        type: "market_mover",
      },
    };
  });

  logger.info(
    {
      totalCoins: data.length,
      significantMovers: articles.length,
      threshold: MARKET_MOVER_THRESHOLD_PERCENT,
    },
    "Normalized CoinGecko market movers",
  );

  return articles;
}

// ---------------------------------------------------------------------------
// Main Export — fetchCoinGeckoData
// ---------------------------------------------------------------------------

/**
 * Fetches cryptocurrency data from CoinGecko's trending and market endpoints,
 * normalizes the responses into `NormalizedArticle[]`, and returns the combined
 * list.
 *
 * This function makes two rate-limited API calls:
 * 1. `/search/trending` — Top trending coins by search volume
 * 2. `/coins/markets` — Top 25 coins by market cap, filtered to >5% movers
 *
 * Both calls go through the dedicated CoinGecko Bottleneck limiter to respect
 * the 30 calls/min free-tier rate limit.
 *
 * **Graceful degradation** (AAP Rule 0.7.4): Any error during fetching or
 * normalization is caught, logged with full error context, and an empty array
 * is returned. This ensures individual fetcher failures do not halt the entire
 * news polling cycle.
 *
 * @returns Promise resolving to an array of normalized articles from CoinGecko.
 *          Returns `[]` on any error.
 *
 * @example
 * ```typescript
 * import { fetchCoinGeckoData } from "./coingecko.js";
 *
 * const articles = await fetchCoinGeckoData();
 * console.log(`Fetched ${articles.length} CoinGecko articles`);
 * ```
 */
export async function fetchCoinGeckoData(): Promise<NormalizedArticle[]> {
  try {
    // Execute both API calls sequentially (Bottleneck serializes them anyway
    // with maxConcurrent=1, so parallel would just queue the second call)
    const trendingArticles = await fetchTrendingCoins();
    const moverArticles = await fetchMarketMovers();

    const combined = [...trendingArticles, ...moverArticles];

    logger.info(
      {
        trending: trendingArticles.length,
        movers: moverArticles.length,
        total: combined.length,
      },
      "CoinGecko fetch complete",
    );

    return combined;
  } catch (error: unknown) {
    // Graceful degradation — log the error and return empty array.
    // AAP Rule 0.7.4: "Individual API source failures must not halt the
    // entire polling cycle."
    logger.error(
      { error },
      "Failed to fetch CoinGecko data — returning empty array",
    );
    return [];
  }
}
