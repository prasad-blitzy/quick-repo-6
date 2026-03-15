/**
 * Application Constants Module — Trading Intelligence API
 *
 * Defines ALL application-wide static constants for the backend.
 * This module contains ONLY literal constants with `as const` assertions.
 *
 * RULES:
 * - No environment variable references (use env.ts for configurable values)
 * - No runtime dependencies or imports
 * - All objects use `as const` for literal type inference
 * - Named exports only (no default export) for tree-shaking
 */

// ---------------------------------------------------------------------------
// External API Base URLs
// ---------------------------------------------------------------------------

/** Base URLs for all external API integrations */
export const API_BASE_URLS = {
  /** Finnhub REST API base — US stock news and quotes */
  FINNHUB: "https://finnhub.io/api/v1",
  /** CoinGecko API v3 base — crypto trending and market data */
  COINGECKO: "https://api.coingecko.com/api/v3",
  /** CryptoCompare API base — crypto news and historical data */
  CRYPTOCOMPARE: "https://min-api.cryptocompare.com",
  /** Binance public REST API v3 — real-time crypto klines and trades */
  BINANCE: "https://api.binance.com/api/v3",
  /** Alpha Vantage query endpoint — historical data and NEWS_SENTIMENT */
  ALPHA_VANTAGE: "https://www.alphavantage.co/query",
  /** OpenRouter unified LLM gateway — multi-model AI inference */
  OPENROUTER: "https://openrouter.ai/api/v1",
} as const;

// ---------------------------------------------------------------------------
// BullMQ Queue Names
// ---------------------------------------------------------------------------

/** BullMQ queue identifiers — must match across all queue/worker modules */
export const QUEUE_NAMES = {
  /** 5-minute cron interval news ingestion queue */
  NEWS_POLLING: "news-polling",
  /** LangGraph pipeline processing queue */
  ANALYSIS: "analysis",
  /** Telegram alert delivery queue */
  NOTIFICATIONS: "notifications",
} as const;

// ---------------------------------------------------------------------------
// RSS Feed URL Constants (default/fallback — env.ts can override some)
// ---------------------------------------------------------------------------

/** Default RSS feed URLs for Indian and US financial news sources */
export const RSS_FEED_URLS = {
  /** Economic Times Markets RSS feed */
  ECONOMIC_TIMES:
    "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  /** Financial Express Markets RSS feed */
  FINANCIAL_EXPRESS: "https://www.financialexpress.com/market/feed/",
  /** Business Standard Markets RSS feed */
  BUSINESS_STANDARD:
    "https://www.business-standard.com/rss/markets-106.rss",
  /** CNBC Markets RSS feed */
  CNBC: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
  /** MarketWatch Top Stories RSS feed */
  MARKETWATCH: "https://feeds.marketwatch.com/marketwatch/topstories/",
} as const;

// ---------------------------------------------------------------------------
// Reddit Subreddit RSS URLs
// ---------------------------------------------------------------------------

/** Reddit subreddit RSS feed URLs for social sentiment analysis */
export const REDDIT_URLS = {
  /** r/wallstreetbets RSS — US retail investor sentiment */
  WALLSTREETBETS: "https://www.reddit.com/r/wallstreetbets/.rss",
  /** r/IndianStreetBets RSS — Indian retail investor sentiment */
  INDIAN_STREET_BETS: "https://www.reddit.com/r/IndianStreetBets/.rss",
} as const;

// ---------------------------------------------------------------------------
// Per-API Rate Limiter Configurations (Bottleneck constructor options)
// ---------------------------------------------------------------------------

/**
 * Default Bottleneck rate limiter configurations per external API source.
 * Each entry is designed to respect the API's free-tier rate limits.
 * Per-API Bottleneck isolation ensures one API's rate limit does not
 * affect calls to another API.
 */
export const RATE_LIMITS = {
  /** Finnhub — 60 calls/min free tier */
  FINNHUB: {
    maxConcurrent: 1,
    minTime: 1000,
    reservoir: 60,
    reservoirRefreshAmount: 60,
    reservoirRefreshInterval: 60_000,
  },
  /** Alpha Vantage — 25 calls/day free tier */
  ALPHA_VANTAGE: {
    maxConcurrent: 1,
    minTime: 5000,
    reservoir: 25,
    reservoirRefreshAmount: 25,
    reservoirRefreshInterval: 86_400_000,
  },
  /** CoinGecko — 30 calls/min free tier */
  COINGECKO: {
    maxConcurrent: 1,
    minTime: 2000,
    reservoir: 30,
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 60_000,
  },
  /** CryptoCompare — 100K calls/month free tier */
  CRYPTOCOMPARE: {
    maxConcurrent: 2,
    minTime: 100,
    reservoir: 100_000,
    reservoirRefreshAmount: 100_000,
    reservoirRefreshInterval: 2_592_000_000,
  },
  /** Binance — 1200 weight/min (conservative; actual limit is 6000) */
  BINANCE: {
    maxConcurrent: 5,
    minTime: 100,
    reservoir: 1200,
    reservoirRefreshAmount: 1200,
    reservoirRefreshInterval: 60_000,
  },
  /** NSE India — self-managed scraper, conservative pacing */
  NSE_INDIA: {
    maxConcurrent: 1,
    minTime: 3000,
  },
  /** Reddit — 100 queries/min free tier */
  REDDIT: {
    maxConcurrent: 1,
    minTime: 600,
    reservoir: 100,
    reservoirRefreshAmount: 100,
    reservoirRefreshInterval: 60_000,
  },
  /** OpenRouter — conservative default; per-model limits apply upstream */
  OPENROUTER: {
    maxConcurrent: 3,
    minTime: 500,
  },
} as const;

// ---------------------------------------------------------------------------
// Default Application Configuration
// ---------------------------------------------------------------------------

/** Application-wide default configuration values */
export const DEFAULTS = {
  /** Minimum confidence score (0.00–1.00) for trade recommendations */
  MIN_CONFIDENCE_THRESHOLD: 0.65,
  /** Default page size for paginated API responses */
  PAGINATION_LIMIT: 20,
  /** Maximum allowed page size to prevent excessive queries */
  MAX_PAGINATION_LIMIT: 100,
  /** Default cron expression — poll news sources every 5 minutes */
  NEWS_POLL_CRON: "*/5 * * * *",
  /** Default concurrent analysis worker jobs */
  ANALYSIS_CONCURRENCY: 3,
  /** Default concurrent notification worker sends */
  NOTIFICATION_CONCURRENCY: 5,
  /** Highest BullMQ priority for breaking news alerts (1 = highest) */
  BREAKING_NEWS_PRIORITY: 1,
  /** Normal BullMQ priority for standard notifications */
  NORMAL_PRIORITY: 10,
  /** Maximum number of retry attempts for failed queue jobs */
  MAX_RETRY_ATTEMPTS: 3,
  /** Initial backoff delay in ms for exponential retry strategy */
  RETRY_BACKOFF_DELAY: 5000,
  /**
   * Maximum allowable deviation (10%) between LLM-generated price targets
   * and actual market data. Prices exceeding this threshold are flagged
   * as potential hallucinations.
   */
  PRICE_DEVIATION_THRESHOLD: 0.10,
  /**
   * Multiplier for negative financial news impact weighting.
   * Empirical research shows negative news has 2–3x the market impact
   * of positive news; 2.5x is the midpoint of that range.
   */
  NEGATIVE_NEWS_WEIGHT_MULTIPLIER: 2.5,
  /**
   * Default HTTP fetch timeout in milliseconds for all external API requests.
   * Prevents network calls from hanging indefinitely when an external API
   * becomes unresponsive. Used as `AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS)`
   * on all `fetch()` calls in the news-fetcher modules.
   */
  FETCH_TIMEOUT_MS: 15_000,
} as const;

// ---------------------------------------------------------------------------
// LLM Analysis Pipeline Constants
// ---------------------------------------------------------------------------

/**
 * Configuration constants for the four-stage LangGraph AI analysis pipeline.
 * Temperature is ALWAYS 0 for deterministic, reproducible financial reasoning.
 */
export const PIPELINE = {
  /** Temperature = 0 for ALL financial analysis — deterministic output */
  TEMPERATURE: 0,
  /** Minimum relevance score to pass the filter stage (0.0–1.0) */
  FILTER_RELEVANCE_THRESHOLD: 0.5,
  /** Minimum sentiment magnitude to trigger trade detection (0.0–1.0) */
  SENTIMENT_TRADE_THRESHOLD: 0.6,
  /** Ordered pipeline step names for logging and analysis_logs table */
  STEPS: ["filter", "sentiment", "trade_detect", "recommend"] as const,
} as const;

// ---------------------------------------------------------------------------
// Market, Direction, and Timeframe Enum Value Arrays
// ---------------------------------------------------------------------------

/** Supported financial market types — values match PG enum in enums.ts */
export const MARKETS = ["us_stock", "indian_equity", "crypto", "social"] as const;

/** Trade direction values */
export const DIRECTIONS = ["long", "short"] as const;

/** Supported trading timeframe categories — values match PG enum in enums.ts */
export const TIMEFRAMES = ["intraday", "swing", "position"] as const;

// ---------------------------------------------------------------------------
// Derived Type Exports
// ---------------------------------------------------------------------------

/** Union type of all valid BullMQ queue name strings */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Union type of supported market identifiers */
export type Market = (typeof MARKETS)[number];

/** Union type of trade direction values */
export type Direction = (typeof DIRECTIONS)[number];

/** Union type of supported trading timeframes */
export type Timeframe = (typeof TIMEFRAMES)[number];
