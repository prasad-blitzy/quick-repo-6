/**
 * Binance Public REST API Client — Trading Intelligence API
 *
 * Fetches real-time cryptocurrency price data from the Binance public REST API
 * using the `/api/v3/ticker/price` (current prices) and `/api/v3/klines`
 * (candlestick data) endpoints. No authentication is required — Binance
 * public market data endpoints are free to use.
 *
 * **IMPORTANT**: Binance is primarily a **price data provider**, not a news
 * source. It provides real-time crypto price data used for:
 * 1. Anti-hallucination validation (AAP Rule 0.7.2: "All LLM-generated price
 *    targets must be cross-validated against actual market data from API
 *    sources before storage or notification delivery")
 * 2. Significant price movement detection — only pairs with >3% 24h movement
 *    are surfaced as NormalizedArticle entries to reduce noise
 *
 * The `fetchBinanceData()` function returns `NormalizedArticle[]` where each
 * article represents a significant price movement summary rather than a
 * traditional news article.
 *
 * Rate limiting: 1200 weight/min (conservative; actual Binance limit is 6000
 * weight/min). Each `/ticker/price` request costs 1 weight, each `/klines`
 * request costs 1 weight. Rate limiting is enforced via a dedicated Bottleneck
 * instance from `getBinanceLimiter()` per AAP Rule 0.7.4 (per-API isolation).
 *
 * @module services/news-fetcher/binance
 * @see {@link https://binance-docs.github.io/apidocs/spot/en/} Binance API docs
 */

import { createLogger } from "../../lib/logger.js";
import { getBinanceLimiter } from "../../lib/rate-limiter.js";
import { API_BASE_URLS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Module-Level Logger and Rate Limiter
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "binance" }` context binding.
 * Used for structured logging of price data fetches, movement detection,
 * kline processing, and graceful error handling.
 */
const logger = createLogger("binance");

/**
 * Dedicated Bottleneck rate limiter instance for Binance public REST API.
 * Configured to 1200 weight/min (conservative of actual 6000 weight/min limit)
 * with maxConcurrent=5, minTime=100ms, reservoir=1200, refresh every 60s.
 *
 * Per AAP Rule 0.7.4: Each external API source MUST have its own dedicated
 * Bottleneck instance. This limiter is NOT shared with any other API.
 */
const limiter = getBinanceLimiter();

// ---------------------------------------------------------------------------
// Binance API Response Types
// ---------------------------------------------------------------------------

/**
 * Response shape for a single entry from `GET /api/v3/ticker/price`.
 * When called without a `symbol` query parameter, Binance returns an
 * array of these objects for all trading pairs (~2000+ pairs).
 */
interface BinanceTickerPrice {
  /** Trading pair symbol (e.g., "BTCUSDT", "ETHUSDT") */
  symbol: string;
  /** Current price as a decimal string (e.g., "67543.21000000") */
  price: string;
}

/**
 * Kline/candlestick data array returned by `GET /api/v3/klines`.
 * Each kline is a fixed-length tuple of 12 elements:
 *
 * | Index | Field                      | Type   |
 * |-------|----------------------------|--------|
 * |   0   | Open time (ms epoch)       | number |
 * |   1   | Open price                 | string |
 * |   2   | High price                 | string |
 * |   3   | Low price                  | string |
 * |   4   | Close price                | string |
 * |   5   | Volume (base asset)        | string |
 * |   6   | Close time (ms epoch)      | number |
 * |   7   | Quote asset volume         | string |
 * |   8   | Number of trades           | number |
 * |   9   | Taker buy base asset vol   | string |
 * |  10   | Taker buy quote asset vol  | string |
 * |  11   | Ignore                     | string |
 */
type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

// ---------------------------------------------------------------------------
// Tracked Crypto Pairs
// ---------------------------------------------------------------------------

/**
 * Top cryptocurrency trading pairs monitored for significant price movements.
 * These represent the highest-liquidity USDT pairs on Binance, covering
 * the major market cap segments (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX).
 *
 * The pair list is intentionally kept small (~8 pairs) to minimize API weight
 * consumption per polling cycle (1 weight for ticker/price + 8 weights for
 * klines = 9 total weight per cycle, well within the 1200/min budget).
 */
const TOP_CRYPTO_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
] as const;

/**
 * Minimum 24-hour price change percentage (absolute value) required to
 * generate a NormalizedArticle. Movements below this threshold are considered
 * normal volatility and are silently ignored to reduce noise in the analysis
 * pipeline. Only significant movements (>3%) are surfaced as actionable data.
 */
const MOVEMENT_THRESHOLD_PERCENT = 3;

// ---------------------------------------------------------------------------
// Price Change Calculation Helper
// ---------------------------------------------------------------------------

/**
 * Result of computing the 24h price change from kline data.
 * All string fields use high-precision decimal representation to preserve
 * financial data accuracy (AAP Rule 0.7.2).
 */
interface PriceChangeResult {
  /** Percentage change from first open to last close (can be negative) */
  changePercent: number;
  /** Human-readable direction: "up" for non-negative, "down" for negative */
  direction: string;
  /** Total 24h base asset volume as a decimal string */
  volume: string;
  /** 24h high price as a decimal string */
  high: string;
  /** 24h low price as a decimal string */
  low: string;
}

/**
 * Calculates the 24-hour price change statistics from an array of hourly
 * kline (candlestick) data. Computes the percentage change between the
 * first kline's open price and the last kline's close price, and
 * aggregates the high, low, and total volume across all klines.
 *
 * Returns `null` for invalid or insufficient data to enable safe filtering
 * by the caller. Edge cases handled:
 * - Fewer than 2 klines (insufficient data)
 * - First open price of zero (division by zero protection)
 * - NaN values from malformed price strings
 *
 * @param klines — Array of BinanceKline tuples from the /klines endpoint.
 * @returns Price change statistics, or `null` if data is insufficient/invalid.
 */
function calculatePriceChange(
  klines: BinanceKline[],
): PriceChangeResult | null {
  if (klines.length < 2) {
    return null;
  }

  // Access first and last klines with explicit undefined checks for
  // TypeScript strict mode with noUncheckedIndexedAccess
  const firstKline = klines[0];
  const lastKline = klines[klines.length - 1];

  if (!firstKline || !lastKline) {
    return null;
  }

  const firstOpen = parseFloat(firstKline[1]);
  const lastClose = parseFloat(lastKline[4]);

  // Guard against division by zero and NaN from malformed data
  if (firstOpen === 0 || Number.isNaN(firstOpen) || Number.isNaN(lastClose)) {
    return null;
  }

  const changePercent = ((lastClose - firstOpen) / firstOpen) * 100;
  const direction = changePercent >= 0 ? "up" : "down";

  // Aggregate 24h high, low, and total volume across all kline intervals
  let high = 0;
  let low = Number.POSITIVE_INFINITY;
  let totalVolume = 0;

  for (const kline of klines) {
    const klineHigh = parseFloat(kline[2]);
    const klineLow = parseFloat(kline[3]);
    const klineVolume = parseFloat(kline[5]);

    if (!Number.isNaN(klineHigh) && klineHigh > high) {
      high = klineHigh;
    }
    if (!Number.isNaN(klineLow) && klineLow < low) {
      low = klineLow;
    }
    if (!Number.isNaN(klineVolume)) {
      totalVolume += klineVolume;
    }
  }

  // If no valid low was found across all klines, reset to 0
  if (low === Number.POSITIVE_INFINITY) {
    low = 0;
  }

  return {
    changePercent,
    direction,
    volume: totalVolume.toFixed(2),
    high: high.toFixed(8),
    low: low.toFixed(8),
  };
}

// ---------------------------------------------------------------------------
// Main Export — fetchBinanceData
// ---------------------------------------------------------------------------

/**
 * Fetches real-time cryptocurrency price data from Binance and returns
 * `NormalizedArticle[]` entries for pairs with significant price movements
 * (>3% change in 24 hours).
 *
 * Execution flow:
 * 1. Fetch current spot prices for all Binance pairs via `/ticker/price`
 * 2. Filter to only the tracked pairs defined in `TOP_CRYPTO_PAIRS`
 * 3. For each tracked pair, fetch 24 hourly klines via `/klines`
 * 4. Calculate 24h price change from kline open/close data
 * 5. Generate NormalizedArticle entries only for significant movements
 *
 * All API calls are rate-limited via the dedicated Binance Bottleneck
 * instance. Individual kline fetch failures are handled gracefully via
 * `Promise.allSettled()` — a failure for one pair does not affect others.
 *
 * Per AAP Rule 0.7.4: On any unrecoverable error, the function logs the
 * error and returns an empty array to prevent the entire polling cycle
 * from being halted by a single API source failure.
 *
 * @returns Array of NormalizedArticle entries for significant crypto movements.
 *          Returns `[]` on error or when no significant movements are detected.
 */
export async function fetchBinanceData(): Promise<NormalizedArticle[]> {
  try {
    logger.info("Fetching Binance price data for tracked crypto pairs");

    // -----------------------------------------------------------------------
    // Step 1: Fetch current spot prices for ALL trading pairs
    // -----------------------------------------------------------------------
    // The /ticker/price endpoint without a symbol parameter returns prices
    // for all ~2000+ Binance pairs in a single request (1 API weight).
    const priceUrl = `${API_BASE_URLS.BINANCE}/ticker/price`;

    const priceResponse = await limiter.schedule(async () => {
      const response = await fetch(priceUrl);
      if (!response.ok) {
        throw new Error(
          `Binance ticker/price API error: HTTP ${response.status.toString()} ${response.statusText}`,
        );
      }
      return response.json() as Promise<BinanceTickerPrice[]>;
    });

    // -----------------------------------------------------------------------
    // Step 2: Filter to only tracked cryptocurrency pairs
    // -----------------------------------------------------------------------
    const trackedSet = new Set<string>(TOP_CRYPTO_PAIRS);
    const relevantPairs = priceResponse.filter((p) => trackedSet.has(p.symbol));

    logger.debug(
      { pairsFound: relevantPairs.length, tracked: TOP_CRYPTO_PAIRS.length },
      "Filtered to tracked crypto pairs",
    );

    if (relevantPairs.length === 0) {
      logger.warn("No tracked pairs found in Binance ticker/price response");
      return [];
    }

    // -----------------------------------------------------------------------
    // Step 3: Fetch 24h hourly klines for each tracked pair
    // -----------------------------------------------------------------------
    // Each klines request is 1 API weight. With 8 tracked pairs, this adds
    // 8 weight to the cycle (total 9 weight including the ticker/price call).
    // Promise.allSettled ensures individual failures don't block other pairs.
    const klinePromises = relevantPairs.map((pair) =>
      limiter.schedule(async () => {
        const klineUrl = `${API_BASE_URLS.BINANCE}/klines?symbol=${pair.symbol}&interval=1h&limit=24`;
        const klineResponse = await fetch(klineUrl);

        if (!klineResponse.ok) {
          throw new Error(
            `Binance klines API error for ${pair.symbol}: HTTP ${klineResponse.status.toString()}`,
          );
        }

        return klineResponse.json() as Promise<BinanceKline[]>;
      }),
    );

    const klineResults = await Promise.allSettled(klinePromises);

    // -----------------------------------------------------------------------
    // Step 4: Detect significant movements and create NormalizedArticles
    // -----------------------------------------------------------------------
    const articles: NormalizedArticle[] = [];

    for (let i = 0; i < relevantPairs.length; i++) {
      const pair = relevantPairs[i];
      const klineResult = klineResults[i];

      // TypeScript strict mode: array index access may be undefined
      if (!pair || !klineResult) {
        continue;
      }

      // Handle individual kline fetch failures gracefully
      if (klineResult.status === "rejected") {
        logger.warn(
          { symbol: pair.symbol, error: String(klineResult.reason) },
          "Failed to fetch klines for pair — skipping",
        );
        continue;
      }

      const klines = klineResult.value;
      const priceChange = calculatePriceChange(klines);

      if (!priceChange) {
        logger.debug(
          { symbol: pair.symbol },
          "Insufficient kline data for price change calculation",
        );
        continue;
      }

      // Only generate articles for movements exceeding the threshold
      const absChange = Math.abs(priceChange.changePercent);
      if (absChange < MOVEMENT_THRESHOLD_PERCENT) {
        continue;
      }

      // Extract the base symbol by removing the "USDT" quote currency suffix
      // e.g., "BTCUSDT" → "BTC", "ETHUSDT" → "ETH"
      const baseSymbol = pair.symbol.replace("USDT", "");
      const changeStr = absChange.toFixed(1);

      const article: NormalizedArticle = {
        title: `${pair.symbol} ${priceChange.direction} ${changeStr}% in 24h`,
        url: `https://www.binance.com/en/trade/${baseSymbol}_USDT`,
        source: "Binance",
        market: "crypto",
        content: null,
        summary: `${pair.symbol} has moved ${priceChange.direction} ${changeStr}% over the last 24 hours. Current price: $${pair.price}`,
        symbols: [baseSymbol],
        publishedAt: new Date(),
        metadata: {
          currentPrice: pair.price,
          priceChange24h: priceChange.changePercent.toFixed(2),
          volume24h: priceChange.volume,
          high24h: priceChange.high,
          low24h: priceChange.low,
        },
      };

      articles.push(article);

      logger.debug(
        {
          symbol: pair.symbol,
          change: `${priceChange.direction} ${changeStr}%`,
          price: pair.price,
        },
        "Significant price movement detected",
      );
    }

    logger.info(
      {
        totalPairs: relevantPairs.length,
        significantMovements: articles.length,
        threshold: `${MOVEMENT_THRESHOLD_PERCENT.toString()}%`,
      },
      "Binance price data fetch complete",
    );

    return articles;
  } catch (error: unknown) {
    // Per AAP Rule 0.7.4: Individual API source failures must not halt the
    // entire polling cycle. Log the error and return an empty array so the
    // orchestrator can continue with other data sources.
    logger.error(
      { error },
      "Failed to fetch Binance data — returning empty array",
    );
    return [];
  }
}
