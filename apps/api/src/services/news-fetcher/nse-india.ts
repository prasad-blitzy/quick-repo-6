/**
 * NSE India Equity Data Wrapper — Trading Intelligence API
 *
 * Provides Indian equity real-time quotes from the National Stock Exchange
 * of India (NSE) via the `stock-nse-india` npm package, which scrapes the
 * NSE India website for live market data.
 *
 * Architecture:
 * - Uses the `NseIndia.getEquityStockIndices("NIFTY 50")` method to fetch
 *   constituent stock data for the benchmark Nifty 50 index.
 * - Filters for **significant movers** — stocks with > 2% daily price change —
 *   to generate `NormalizedArticle` entries representing noteworthy price
 *   movements suitable for the analysis pipeline.
 * - Rate limited via a dedicated Bottleneck instance (`getNseIndiaLimiter()`)
 *   with conservative pacing: maxConcurrent=1, minTime=3000ms to avoid IP
 *   blocking by the NSE India website (AAP Rule 0.7.4).
 * - Fully wrapped in try/catch — the scraper is inherently unreliable since
 *   it depends on NSE website availability and structure (AAP Rule 0.7.4).
 *
 * **IMPORTANT**: Like Binance, NSE India is primarily a **price data provider**,
 * not a news source. It provides Indian equity real-time quotes for price
 * validation. The returned `NormalizedArticle[]` represents price data summaries
 * for stocks with significant movements, supplementing RSS news feeds from
 * Economic Times, Financial Express, and Business Standard.
 *
 * Market hours: NSE India operates 9:15 AM – 3:30 PM IST, Monday–Friday.
 * Data may be stale outside these hours. The module handles this gracefully
 * by returning an empty array if no data is available.
 *
 * @module services/news-fetcher/nse-india
 * @see {@link https://github.com/hi-imcodeman/stock-nse-india} stock-nse-india docs
 */

import { NseIndia } from "stock-nse-india";
import type { IndexEquityInfo } from "stock-nse-india";
import { createLogger } from "../../lib/logger.js";
import { getNseIndiaLimiter } from "../../lib/rate-limiter.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Module-Scoped Singletons — Logger, Rate Limiter, Client
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "nse-india" }` context binding.
 * Used for structured logging of NSE India data fetch operations,
 * significant mover detection, error handling, and article count reporting.
 */
const logger = createLogger("nse-india");

/**
 * Dedicated Bottleneck rate limiter for NSE India scraper.
 * Configured with conservative self-managed pacing:
 *   maxConcurrent: 1, minTime: 3000ms
 * to avoid IP blocking by the NSE India website.
 *
 * Per AAP Rule 0.7.4: Each external API source MUST have its own
 * dedicated Bottleneck instance. No shared limiter across different APIs.
 */
const limiter = getNseIndiaLimiter();

/**
 * NseIndia scraper client instance.
 * Manages cookies and session state internally for NSE website access.
 */
const nse = new NseIndia();

// ---------------------------------------------------------------------------
// Constants — Tracked Nifty 50 Constituents
// ---------------------------------------------------------------------------

/**
 * Top 20 Nifty 50 constituents tracked for significant price movements.
 * These represent the highest-weighted stocks in India's benchmark index,
 * covering financials, IT, energy, consumer, and industrial sectors.
 *
 * The full Nifty 50 index has 50 stocks, but we focus on the top 20 by
 * market capitalization for signal-to-noise optimization.
 */
const TRACKED_SYMBOLS = [
  "RELIANCE",
  "TCS",
  "HDFCBANK",
  "INFY",
  "ICICIBANK",
  "HINDUNILVR",
  "SBIN",
  "BAJFINANCE",
  "BHARTIARTL",
  "ITC",
  "KOTAKBANK",
  "LT",
  "HCLTECH",
  "AXISBANK",
  "ASIANPAINT",
  "MARUTI",
  "SUNPHARMA",
  "TITAN",
  "WIPRO",
  "ULTRACEMCO",
] as const;

/**
 * Minimum absolute percentage change threshold for a stock to be
 * considered a "significant mover". Only stocks with daily price
 * changes exceeding this threshold generate NormalizedArticle entries.
 *
 * Set to 2% based on typical Nifty 50 daily volatility ranges —
 * movements beyond 2% are noteworthy for trading intelligence.
 */
const SIGNIFICANT_MOVE_THRESHOLD = 2;

/**
 * Set of tracked symbols for O(1) lookup during filtering.
 * Constructed from the TRACKED_SYMBOLS readonly array.
 */
const trackedSymbolSet = new Set<string>(TRACKED_SYMBOLS);

// ---------------------------------------------------------------------------
// Helper — Build Summary String
// ---------------------------------------------------------------------------

/**
 * Constructs a concise price summary string for a stock's daily performance.
 *
 * @param symbol - Stock ticker symbol (e.g., "RELIANCE")
 * @param equity - IndexEquityInfo record from NSE India API
 * @returns Formatted summary describing the stock's key price metrics
 */
function buildSummary(symbol: string, equity: IndexEquityInfo): string {
  const direction = equity.pChange >= 0 ? "gained" : "lost";
  return (
    `${symbol} ${direction} ${Math.abs(equity.pChange).toFixed(2)}% on NSE India. ` +
    `Open: ₹${equity.open.toFixed(2)}, ` +
    `High: ₹${equity.dayHigh.toFixed(2)}, ` +
    `Low: ₹${equity.dayLow.toFixed(2)}, ` +
    `Last: ₹${equity.lastPrice.toFixed(2)}, ` +
    `Prev Close: ₹${equity.previousClose.toFixed(2)}, ` +
    `Volume: ${equity.totalTradedVolume.toLocaleString("en-IN")}`
  );
}

// ---------------------------------------------------------------------------
// Exported Function — fetchNseIndiaData
// ---------------------------------------------------------------------------

/**
 * Fetches NIFTY 50 equity data from NSE India and returns normalized
 * articles for stocks with significant daily price movements (> 2%).
 *
 * Workflow:
 * 1. Calls `nse.getEquityStockIndices("NIFTY 50")` via the Bottleneck
 *    rate limiter to retrieve constituent stock data.
 * 2. Extracts the `data` array from the `IndexDetails` response.
 * 3. Filters for tracked symbols (top 20 by market cap).
 * 4. Identifies significant movers — stocks with |pChange| > 2%.
 * 5. Maps each significant mover to a `NormalizedArticle` with:
 *    - Title describing the movement direction and magnitude
 *    - URL linking to the NSE India quote page
 *    - Metadata containing full OHLCV price data
 * 6. Returns the normalized articles, or `[]` on any error.
 *
 * The function is designed for graceful degradation per AAP Rule 0.7.4:
 * all errors are caught, logged, and result in an empty array return
 * rather than thrown exceptions. The scraper can fail for many reasons:
 * - NSE website down or changed structure
 * - Called outside Indian market hours (9:15 AM – 3:30 PM IST)
 * - IP temporarily blocked by NSE anti-scraping measures
 * - Network timeouts or DNS resolution failures
 *
 * @returns Array of NormalizedArticle entries for significant movers,
 *          or empty array on any error.
 */
export async function fetchNseIndiaData(): Promise<NormalizedArticle[]> {
  try {
    logger.info("Fetching NIFTY 50 equity data from NSE India");

    // Fetch NIFTY 50 index constituent data via rate-limited schedule.
    // The Bottleneck limiter ensures conservative pacing (3s between requests)
    // to avoid IP blocking by the NSE India website.
    const indexDetails = await limiter.schedule(() =>
      nse.getEquityStockIndices("NIFTY 50"),
    );

    // Extract the constituent stocks array from the response.
    // The IndexDetails.data property contains IndexEquityInfo[] for each stock.
    const equityData: IndexEquityInfo[] = indexDetails.data;

    if (!equityData || equityData.length === 0) {
      logger.warn("No equity data returned from NSE India — market may be closed");
      return [];
    }

    logger.debug(
      { totalStocks: equityData.length },
      "Received NIFTY 50 constituent data",
    );

    // Filter for tracked symbols and significant movers (> 2% daily change).
    // We first filter to our tracked symbols set, then identify those with
    // absolute percentage change exceeding the threshold.
    const significantMovers: IndexEquityInfo[] = [];

    for (const equity of equityData) {
      // Only process tracked symbols from our curated top-20 list
      if (!trackedSymbolSet.has(equity.symbol)) {
        continue;
      }

      // Check for significant price movement (> 2% absolute change)
      if (Math.abs(equity.pChange) > SIGNIFICANT_MOVE_THRESHOLD) {
        significantMovers.push(equity);
      }
    }

    if (significantMovers.length === 0) {
      logger.info(
        "No significant movers (>2% change) found among tracked NIFTY 50 stocks",
      );
      return [];
    }

    logger.info(
      { count: significantMovers.length },
      "Detected significant movers on NSE India",
    );

    // Map significant movers to NormalizedArticle format.
    // Each article represents a notable price movement with full OHLCV data.
    const now = new Date();
    const articles: NormalizedArticle[] = [];

    for (const equity of significantMovers) {
      const direction = equity.pChange >= 0 ? "up" : "down";
      const absChange = Math.abs(equity.pChange).toFixed(1);

      const article: NormalizedArticle = {
        title: `${equity.symbol} ${direction} ${absChange}% on NSE`,
        url: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(equity.symbol)}`,
        source: "NseIndia",
        market: "indian_equity",
        content: null,
        summary: buildSummary(equity.symbol, equity),
        symbols: [equity.symbol],
        publishedAt: now,
        metadata: {
          open: equity.open,
          high: equity.dayHigh,
          low: equity.dayLow,
          close: equity.lastPrice,
          previousClose: equity.previousClose,
          change: equity.change,
          percentChange: equity.pChange,
          volume: equity.totalTradedVolume,
          series: equity.series,
          identifier: equity.identifier,
        },
      };

      articles.push(article);
    }

    logger.info(
      { articleCount: articles.length },
      "Generated NSE India price movement articles",
    );

    return articles;
  } catch (error: unknown) {
    // Graceful degradation — the stock-nse-india scraper can fail for many
    // reasons (website down, structure changed, IP blocked, market closed).
    // Log the error and return an empty array per AAP Rule 0.7.4.
    logger.error(
      { error },
      "Failed to fetch NSE India data — scraper may be unavailable",
    );
    return [];
  }
}
