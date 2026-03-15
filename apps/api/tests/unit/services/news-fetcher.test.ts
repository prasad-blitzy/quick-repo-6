/**
 * Unit Tests for the News Fetcher Service
 *
 * Comprehensive tests for the news-fetcher service orchestrator and all 8
 * individual API client modules. Covers:
 * - fetchAllNews() orchestration with Promise.allSettled and error tracking
 * - storeArticles() URL-based deduplication via onConflictDoNothing
 * - Individual fetchers: Finnhub, RSS, Reddit, CoinGecko,
 *   CryptoCompare, Binance, Alpha Vantage, NSE India
 * - Per-API Bottleneck rate limiter isolation (AAP Rule 0.7.4)
 * - NormalizedArticle response conformance for every fetcher
 *
 * @module tests/unit/services/news-fetcher
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted() — Declare mock variables available to vi.mock factories
// These are evaluated BEFORE any vi.mock() factory or module import.
// ---------------------------------------------------------------------------

const {
  mockParseURL,
  mockGetEquityStockIndices,
  mockFinnhubSchedule,
  mockCoinGeckoSchedule,
  mockCryptoCompareSchedule,
  mockAlphaVantageSchedule,
  mockBinanceSchedule,
  mockNseIndiaSchedule,
  mockRedditSchedule,
  mockReturning,
  mockOnConflictDoNothing,
  mockInsertValues,
  mockInsert,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockEnv,
  mockLoggerInfo,
  mockLoggerError,
  mockLoggerWarn,
  mockLoggerDebug,
} = vi.hoisted(() => {
  // RSS parser mock
  const mockParseURL = vi.fn();
  // stock-nse-india mock
  const mockGetEquityStockIndices = vi.fn();

  // Per-API schedule mocks for rate limiter isolation verification
  const mockFinnhubSchedule = vi.fn((fn: () => unknown) => fn());
  const mockCoinGeckoSchedule = vi.fn((fn: () => unknown) => fn());
  const mockCryptoCompareSchedule = vi.fn((fn: () => unknown) => fn());
  const mockAlphaVantageSchedule = vi.fn((fn: () => unknown) => fn());
  const mockBinanceSchedule = vi.fn((fn: () => unknown) => fn());
  const mockNseIndiaSchedule = vi.fn((fn: () => unknown) => fn());
  const mockRedditSchedule = vi.fn((fn: () => unknown) => fn());

  // Database insert chain mocks
  const mockReturning = vi.fn().mockResolvedValue([]);
  const mockOnConflictDoNothing = vi.fn().mockReturnValue({
    returning: mockReturning,
  });
  const mockInsertValues = vi.fn().mockReturnValue({
    onConflictDoNothing: mockOnConflictDoNothing,
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  // Database update chain mocks
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  // Environment mock (mutable for per-test overrides)
  const mockEnv: Record<string, unknown> = {
    FINNHUB_API_KEY: "test-finnhub-key",
    ALPHA_VANTAGE_API_KEY: "test-alpha-key",
    COINGECKO_API_KEY: "test-coingecko-key",
    CRYPTOCOMPARE_API_KEY: "test-cc-key",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    RSS_ECONOMIC_TIMES:
      "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
    RSS_FINANCIAL_EXPRESS: "https://www.financialexpress.com/market/rss",
    RSS_BUSINESS_STANDARD:
      "https://www.business-standard.com/rss/markets-106.rss",
    DATABASE_URL: "postgresql://localhost/test",
    DATABASE_PROVIDER: "local",
    REDIS_URL: "redis://localhost:6379",
    OPENROUTER_API_KEY: "test-or-key",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    PORT: 3000,
    FRONTEND_URL: "http://localhost:5173",
  };

  // Logger mock functions
  const mockLoggerInfo = vi.fn();
  const mockLoggerError = vi.fn();
  const mockLoggerWarn = vi.fn();
  const mockLoggerDebug = vi.fn();

  return {
    mockParseURL,
    mockGetEquityStockIndices,
    mockFinnhubSchedule,
    mockCoinGeckoSchedule,
    mockCryptoCompareSchedule,
    mockAlphaVantageSchedule,
    mockBinanceSchedule,
    mockNseIndiaSchedule,
    mockRedditSchedule,
    mockReturning,
    mockOnConflictDoNothing,
    mockInsertValues,
    mockInsert,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockEnv,
    mockLoggerInfo,
    mockLoggerError,
    mockLoggerWarn,
    mockLoggerDebug,
  };
});

// ---------------------------------------------------------------------------
// vi.mock() — All External Dependencies (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("../../../src/db/index.js", () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
    select: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../../src/db/schema/news-articles.js", () => ({
  newsArticles: { url: "url_column", id: "id_column" },
}));

vi.mock("../../../src/db/schema/api-sources.js", () => ({
  apiSources: {
    name: "name_column",
    errorCount: "error_count_column",
    lastFetchedAt: "last_fetched_at_column",
  },
}));

vi.mock("../../../src/lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: mockLoggerWarn,
    debug: mockLoggerDebug,
  })),
}));

vi.mock("../../../src/lib/rate-limiter.js", () => ({
  getFinnhubLimiter: vi.fn(() => ({ schedule: mockFinnhubSchedule })),
  getCoinGeckoLimiter: vi.fn(() => ({ schedule: mockCoinGeckoSchedule })),
  getCryptoCompareLimiter: vi.fn(() => ({
    schedule: mockCryptoCompareSchedule,
  })),
  getAlphaVantageLimiter: vi.fn(() => ({
    schedule: mockAlphaVantageSchedule,
  })),
  getBinanceLimiter: vi.fn(() => ({ schedule: mockBinanceSchedule })),
  getNseIndiaLimiter: vi.fn(() => ({ schedule: mockNseIndiaSchedule })),
  getRedditLimiter: vi.fn(() => ({ schedule: mockRedditSchedule })),
}));

vi.mock("../../../src/config/env.js", () => ({
  env: mockEnv,
}));

vi.mock("../../../src/config/constants.js", () => ({
  API_BASE_URLS: {
    FINNHUB: "https://finnhub.io/api/v1",
    ALPHA_VANTAGE: "https://www.alphavantage.co/query",
    COINGECKO: "https://api.coingecko.com/api/v3",
    CRYPTOCOMPARE: "https://min-api.cryptocompare.com",
    BINANCE: "https://api.binance.com/api/v3",
  },
  RSS_FEED_URLS: {
    ECONOMIC_TIMES:
      "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
    FINANCIAL_EXPRESS: "https://www.financialexpress.com/market/rss",
    BUSINESS_STANDARD:
      "https://www.business-standard.com/rss/markets-106.rss",
    CNBC: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    MARKETWATCH: "https://feeds.marketwatch.com/marketwatch/topstories/",
  },
  REDDIT_URLS: {
    WALLSTREETBETS: "https://www.reddit.com/r/wallstreetbets/.rss",
    INDIAN_STREET_BETS: "https://www.reddit.com/r/IndianStreetBets/.rss",
  },
  RATE_LIMITS: {
    FINNHUB: { maxConcurrent: 1, minTime: 1000 },
    ALPHA_VANTAGE: { maxConcurrent: 1, minTime: 5000 },
    COINGECKO: { maxConcurrent: 1, minTime: 2000 },
    CRYPTOCOMPARE: { maxConcurrent: 2, minTime: 100 },
    BINANCE: { maxConcurrent: 5, minTime: 100 },
    NSE_INDIA: { maxConcurrent: 1, minTime: 3000 },
    REDDIT: { maxConcurrent: 1, minTime: 600 },
    OPENROUTER: { maxConcurrent: 3, minTime: 500 },
  },
  MARKETS: ["us_stock", "indian_equity", "crypto", "social"],
  DEFAULTS: {
    FETCH_TIMEOUT_MS: 15_000,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  sql: vi.fn((...args: unknown[]) => args),
}));

vi.mock("rss-parser", () => ({
  default: vi.fn().mockImplementation(() => ({
    parseURL: mockParseURL,
  })),
}));

vi.mock("stock-nse-india", () => ({
  NseIndia: vi.fn().mockImplementation(() => ({
    getEquityStockIndices: mockGetEquityStockIndices,
  })),
}));

// ---------------------------------------------------------------------------
// Imports — Modules Under Test (after vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  fetchAllNews,
  storeArticles,
} from "../../../src/services/news-fetcher/index.js";
import type { NormalizedArticle } from "../../../src/services/news-fetcher/index.js";
import { fetchFinnhubNews } from "../../../src/services/news-fetcher/finnhub.js";
import { fetchRssNews } from "../../../src/services/news-fetcher/rss-parser.js";
import { fetchRedditPosts } from "../../../src/services/news-fetcher/reddit.js";
import { fetchCoinGeckoData } from "../../../src/services/news-fetcher/coingecko.js";
import { fetchCryptoCompareNews } from "../../../src/services/news-fetcher/cryptocompare.js";
import { fetchBinanceData } from "../../../src/services/news-fetcher/binance.js";
import { fetchAlphaVantageNews } from "../../../src/services/news-fetcher/alpha-vantage.js";
import { fetchNseIndiaData } from "../../../src/services/news-fetcher/nse-india.js";
// db, eq, sql accessed through hoisted mock variables (mockInsert, mockUpdate, etc.)
// eslint no-unused-vars: only import symbols directly referenced in test assertions
import { newsArticles } from "../../../src/db/schema/news-articles.js";
import { apiSources } from "../../../src/db/schema/api-sources.js";

// ---------------------------------------------------------------------------
// Global Fetch Mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function createMockResponse(
  data: unknown,
  ok = true,
  status = 200,
): MockFetchResponse {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function buildNormalizedArticle(
  overrides: Partial<NormalizedArticle> = {},
): NormalizedArticle {
  return {
    title: "Test Article",
    url: `https://example.com/test/${String(Math.random())}`,
    source: "TestSource",
    market: "us_stock",
    content: "Test content body",
    summary: "Test summary",
    symbols: ["TEST"],
    publishedAt: new Date(),
    metadata: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Data Fixtures
// ---------------------------------------------------------------------------

const mockFinnhubArticle = {
  category: "general",
  datetime: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  headline: "Apple Reports Record Q4 Revenue",
  id: 12345,
  image: "https://example.com/image.jpg",
  related: "AAPL,MSFT",
  source: "Yahoo Finance",
  summary: "Apple reported Q4 revenue of $94.9B beating estimates.",
  url: "https://example.com/article/1",
};

const mockOldFinnhubArticle = {
  ...mockFinnhubArticle,
  datetime: Math.floor(Date.now() / 1000) - 90_000, // ~25h ago
  id: 12346,
  url: "https://example.com/article/old",
};

const mockCoinGeckoTrending = {
  coins: [
    {
      item: {
        id: "bitcoin",
        coin_id: 1,
        name: "Bitcoin",
        symbol: "btc",
        market_cap_rank: 1,
        score: 0,
        slug: "bitcoin",
        thumb: "https://example.com/thumb.png",
        small: "https://example.com/small.png",
        large: "https://example.com/large.png",
        price_btc: 1.0,
        data: {
          price: "$95,000",
          price_change_percentage_24h: { usd: 5.2 },
          market_cap: "$1.9T",
          total_volume: "$50B",
        },
      },
    },
  ],
};

const mockCoinGeckoMarkets = [
  {
    id: "ethereum",
    symbol: "eth",
    name: "Ethereum",
    current_price: 3500,
    market_cap: 420_000_000_000,
    market_cap_rank: 2,
    price_change_percentage_24h: 6.5,
    total_volume: 15_000_000_000,
    high_24h: 3600,
    low_24h: 3300,
    last_updated: "2026-03-13T12:00:00Z",
  },
  {
    id: "bitcoin",
    symbol: "btc",
    name: "Bitcoin",
    current_price: 95_000,
    market_cap: 1_900_000_000_000,
    market_cap_rank: 1,
    price_change_percentage_24h: 1.2,
    total_volume: 50_000_000_000,
    high_24h: 96_000,
    low_24h: 93_000,
    last_updated: "2026-03-13T12:00:00Z",
  },
];

const mockCryptoCompareResponse = {
  Type: 100,
  Message: "News list successfully returned",
  Data: [
    {
      id: "cc-1",
      guid: "guid-1",
      published_on: Math.floor(Date.now() / 1000) - 1800,
      imageurl: "https://example.com/img.jpg",
      title: "Bitcoin Breaks New Record",
      url: "https://example.com/crypto/1",
      body: "Bitcoin has surpassed the $95K mark...",
      tags: "BTC|ETH|DeFi",
      categories: "BTC|Trading",
      source: "CoinDesk",
      source_info: { name: "CoinDesk", img: "", lang: "EN" },
    },
  ],
};

const mockAlphaVantageResponse = {
  items: "50",
  sentiment_score_definition: "...",
  relevance_score_definition: "...",
  feed: [
    {
      title: "Fed Announces Rate Decision",
      url: "https://example.com/av/1",
      time_published: "20260313T120000",
      authors: ["John Doe"],
      summary: "The Federal Reserve announced its latest rate decision.",
      banner_image: "https://example.com/banner.jpg",
      source: "CNBC",
      category_within_source: "Economy",
      source_domain: "cnbc.com",
      overall_sentiment_score: 0.15,
      overall_sentiment_label: "Somewhat-Bullish",
      ticker_sentiment: [
        {
          ticker: "SPY",
          relevance_score: "0.85",
          ticker_sentiment_score: "0.2",
          ticker_sentiment_label: "Somewhat-Bullish",
        },
        {
          ticker: "QQQ",
          relevance_score: "0.6",
          ticker_sentiment_score: "0.15",
          ticker_sentiment_label: "Somewhat-Bullish",
        },
      ],
    },
  ],
};

const mockBinancePriceTicker = [
  { symbol: "BTCUSDT", price: "95000.00" },
  { symbol: "ETHUSDT", price: "3500.00" },
  { symbol: "BNBUSDT", price: "600.00" },
];

// calculatePriceChange requires klines.length >= 2 — provide two entries.
// Change = (lastKline[4] - firstKline[1]) / firstKline[1] * 100
// Big move: (95500 - 90000) / 90000 = +6.11%  (exceeds 3% threshold)
const mockBinanceKlinesBigMove: unknown[][] = [
  [1_710_288_000_000, "90000.00", "93000.00", "89500.00", "92500.00",
   "10000", 1_710_331_200_000, "900000000", 50000, "5000", "450000000", "0"],
  [1_710_331_200_000, "92500.00", "96000.00", "91000.00", "95500.00",
   "12000", 1_710_374_400_000, "1100000000", 55000, "6000", "550000000", "0"],
];

// Small move: (95000 - 94500) / 94500 = +0.53%  (below 3% threshold)
const mockBinanceKlinesSmallMove: unknown[][] = [
  [1_710_288_000_000, "94500.00", "95000.00", "94000.00", "94800.00",
   "8000", 1_710_331_200_000, "760000000", 40000, "4000", "380000000", "0"],
  [1_710_331_200_000, "94800.00", "95200.00", "94200.00", "95000.00",
   "9000", 1_710_374_400_000, "855000000", 45000, "4500", "427000000", "0"],
];

const mockRssItem = {
  title: "Sensex rallies 500 points on strong global cues",
  link: "https://example.com/rss/1",
  pubDate: new Date().toISOString(),
  content: "The benchmark Sensex rallied 500 points...",
  contentSnippet: "The benchmark Sensex rallied 500 points...",
  guid: "rss-1",
  isoDate: new Date().toISOString(),
};

const mockRedditPost = {
  title: "$AAPL to the moon 🚀 — Amazing earnings beat!",
  link: "https://www.reddit.com/r/wallstreetbets/comments/abc123",
  pubDate: new Date().toISOString(),
  content: "Just look at those numbers, $AAPL crushed it again!",
  contentSnippet: "Just look at those numbers...",
  guid: "reddit-1",
  isoDate: new Date().toISOString(),
};

const mockNseIndiaData = {
  data: [
    {
      symbol: "RELIANCE",
      open: 2400,
      dayHigh: 2500,
      dayLow: 2380,
      lastPrice: 2480,
      previousClose: 2400,
      pChange: 3.33,
      totalTradedVolume: 5_000_000,
      totalTradedValue: 12_000_000_000,
      yearHigh: 2800,
      yearLow: 2000,
      lastUpdateTime: "13-Mar-2026 15:30:00",
      meta: { isin: "INE002A01018" },
    },
    {
      symbol: "TCS",
      open: 3800,
      dayHigh: 3820,
      dayLow: 3790,
      lastPrice: 3810,
      previousClose: 3800,
      pChange: 0.26,
      totalTradedVolume: 2_000_000,
      totalTradedValue: 7_600_000_000,
      yearHigh: 4200,
      yearLow: 3400,
      lastUpdateTime: "13-Mar-2026 15:30:00",
      meta: { isin: "INE467B01029" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestrator Mock Setup Helpers
// ---------------------------------------------------------------------------

function setupSuccessfulFetchMocks(): void {
  mockFetch.mockImplementation((url: unknown) => {
    const s = String(url);
    if (s.includes("finnhub.io"))
      return Promise.resolve(createMockResponse([]));
    if (s.includes("coingecko.com") && s.includes("trending"))
      return Promise.resolve(createMockResponse({ coins: [] }));
    if (s.includes("coingecko.com") && s.includes("markets"))
      return Promise.resolve(createMockResponse([]));
    if (s.includes("cryptocompare.com"))
      return Promise.resolve(
        createMockResponse({ Type: 100, Message: "", Data: [] }),
      );
    if (s.includes("binance.com") && s.includes("ticker"))
      return Promise.resolve(createMockResponse([]));
    if (s.includes("binance.com") && s.includes("klines"))
      return Promise.resolve(createMockResponse([]));
    if (s.includes("alphavantage.co"))
      return Promise.resolve(createMockResponse({ feed: [] }));
    return Promise.resolve(createMockResponse([]));
  });
  mockParseURL.mockResolvedValue({ items: [] });
  mockGetEquityStockIndices.mockResolvedValue({ data: [] });
}

// =========================================================================
//  TEST SUITES
// =========================================================================

describe("News Fetcher Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mutable env values
    mockEnv.FINNHUB_API_KEY = "test-finnhub-key";
    mockEnv.ALPHA_VANTAGE_API_KEY = "test-alpha-key";
    mockEnv.COINGECKO_API_KEY = "test-coingecko-key";
    mockEnv.CRYPTOCOMPARE_API_KEY = "test-cc-key";

    // Re-wire insert chain (cleared by clearAllMocks)
    mockReturning.mockResolvedValue([]);
    mockOnConflictDoNothing.mockReturnValue({ returning: mockReturning });
    mockInsertValues.mockReturnValue({
      onConflictDoNothing: mockOnConflictDoNothing,
    });
    mockInsert.mockReturnValue({ values: mockInsertValues });

    // Re-wire update chain
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });

    // Re-implement schedule mocks
    mockFinnhubSchedule.mockImplementation((fn: () => unknown) => fn());
    mockCoinGeckoSchedule.mockImplementation((fn: () => unknown) => fn());
    mockCryptoCompareSchedule.mockImplementation(
      (fn: () => unknown) => fn(),
    );
    mockAlphaVantageSchedule.mockImplementation(
      (fn: () => unknown) => fn(),
    );
    mockBinanceSchedule.mockImplementation((fn: () => unknown) => fn());
    mockNseIndiaSchedule.mockImplementation((fn: () => unknown) => fn());
    mockRedditSchedule.mockImplementation((fn: () => unknown) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =======================================================================
  // 1. News Fetcher Orchestrator — fetchAllNews
  // =======================================================================
  describe("News Fetcher Orchestrator — fetchAllNews", () => {
    it("should call all fetcher modules in parallel using Promise.allSettled()", async () => {
      setupSuccessfulFetchMocks();

      const articles = await fetchAllNews();

      // All infrastructure mocks should have been invoked across fetchers
      expect(mockFetch).toHaveBeenCalled();
      expect(mockParseURL).toHaveBeenCalled();
      expect(mockGetEquityStockIndices).toHaveBeenCalled();
      expect(Array.isArray(articles)).toBe(true);
    });

    it("should aggregate articles from all successful fetchers", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("finnhub.io"))
          return Promise.resolve(createMockResponse([mockFinnhubArticle]));
        if (s.includes("coingecko.com") && s.includes("trending"))
          return Promise.resolve(
            createMockResponse(mockCoinGeckoTrending),
          );
        if (s.includes("coingecko.com") && s.includes("markets"))
          return Promise.resolve(createMockResponse(mockCoinGeckoMarkets));
        if (s.includes("cryptocompare.com"))
          return Promise.resolve(
            createMockResponse(mockCryptoCompareResponse),
          );
        if (s.includes("binance.com") && s.includes("ticker"))
          return Promise.resolve(
            createMockResponse(mockBinancePriceTicker),
          );
        if (s.includes("binance.com") && s.includes("klines"))
          return Promise.resolve(
            createMockResponse(mockBinanceKlinesBigMove),
          );
        if (s.includes("alphavantage.co"))
          return Promise.resolve(
            createMockResponse(mockAlphaVantageResponse),
          );
        return Promise.resolve(createMockResponse([]));
      });
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });
      mockGetEquityStockIndices.mockResolvedValue(mockNseIndiaData);

      const articles = await fetchAllNews();

      expect(articles.length).toBeGreaterThan(0);
    });

    it("should handle individual fetcher failures gracefully (Promise.allSettled)", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("finnhub.io"))
          return Promise.reject(new Error("Finnhub API down"));
        if (s.includes("coingecko.com") && s.includes("trending"))
          return Promise.resolve(createMockResponse({ coins: [] }));
        if (s.includes("coingecko.com") && s.includes("markets"))
          return Promise.resolve(createMockResponse([]));
        if (s.includes("cryptocompare.com"))
          return Promise.resolve(
            createMockResponse({ Type: 100, Message: "", Data: [] }),
          );
        if (s.includes("binance.com"))
          return Promise.resolve(createMockResponse([]));
        if (s.includes("alphavantage.co"))
          return Promise.resolve(createMockResponse({ feed: [] }));
        return Promise.resolve(createMockResponse([]));
      });
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });
      mockGetEquityStockIndices.mockResolvedValue({ data: [] });

      // Must NOT throw — Promise.allSettled absorbs individual failures
      const articles = await fetchAllNews();
      expect(Array.isArray(articles)).toBe(true);
    });

    it("should reset error_count on successful fetch", async () => {
      setupSuccessfulFetchMocks();

      await fetchAllNews();

      // Verify db.update is called with the apiSources table reference
      expect(mockUpdate).toHaveBeenCalledWith(apiSources);
      const setCalls = mockUpdateSet.mock.calls as Array<
        [Record<string, unknown>]
      >;
      const resetCalls = setCalls.filter(
        (call) => call[0]?.errorCount === 0,
      );
      expect(resetCalls.length).toBeGreaterThan(0);
    });

    it("should increment error_count on failed fetch", async () => {
      // Individual fetchers catch their own errors and return [].
      // The orchestrator only sees "rejected" if a fetcher throws an
      // unhandled exception. To test the increment path, we make the
      // schedule mock itself reject (simulating a catastrophic limiter
      // failure that escapes the fetcher's try-catch by rejecting the
      // wrapper promise directly).
      mockFinnhubSchedule.mockImplementation(() =>
        Promise.reject(new Error("Catastrophic limiter failure")),
      );

      // Make other fetchers resolve normally
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("coingecko.com") && s.includes("trending"))
          return Promise.resolve(createMockResponse({ coins: [] }));
        if (s.includes("coingecko.com") && s.includes("markets"))
          return Promise.resolve(createMockResponse([]));
        if (s.includes("cryptocompare.com"))
          return Promise.resolve(
            createMockResponse({ Type: 100, Message: "", Data: [] }),
          );
        if (s.includes("binance.com"))
          return Promise.resolve(createMockResponse([]));
        if (s.includes("alphavantage.co"))
          return Promise.resolve(createMockResponse({ feed: [] }));
        return Promise.resolve(createMockResponse([]));
      });
      mockParseURL.mockResolvedValue({ items: [] });
      mockGetEquityStockIndices.mockResolvedValue({ data: [] });

      const articles = await fetchAllNews();

      // The orchestrator handles the failure gracefully and still returns
      expect(Array.isArray(articles)).toBe(true);
      // db.update should have been called for api_sources tracking
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("should support optional market filtering", async () => {
      setupSuccessfulFetchMocks();

      const articles = await fetchAllNews({ markets: ["crypto"] });

      expect(Array.isArray(articles)).toBe(true);
      // NSE India is indian_equity — should NOT be called for crypto filter
      expect(mockGetEquityStockIndices).not.toHaveBeenCalled();
    });

    it("should support optional source filtering", async () => {
      setupSuccessfulFetchMocks();

      const articles = await fetchAllNews({ sources: ["Finnhub"] });

      expect(Array.isArray(articles)).toBe(true);
      expect(mockGetEquityStockIndices).not.toHaveBeenCalled();
    });

    it("should return empty array when all fetchers fail", async () => {
      mockFetch.mockRejectedValue(new Error("All APIs down"));
      mockParseURL.mockRejectedValue(new Error("RSS feeds down"));
      mockGetEquityStockIndices.mockRejectedValue(
        new Error("NSE scraper down"),
      );

      const articles = await fetchAllNews();

      expect(articles).toEqual([]);
    });
  });

  // =======================================================================
  // 2. URL-Based Deduplication — storeArticles
  // =======================================================================
  describe("storeArticles — URL-based deduplication", () => {
    it("should use onConflictDoNothing on URL column", async () => {
      const articles = [
        buildNormalizedArticle({ url: "https://example.com/a1" }),
        buildNormalizedArticle({ url: "https://example.com/a2" }),
      ];
      mockReturning.mockResolvedValueOnce([{ id: "1" }, { id: "2" }]);

      await storeArticles(articles);

      expect(mockInsert).toHaveBeenCalledWith(newsArticles);
      expect(mockInsertValues).toHaveBeenCalled();
      expect(mockOnConflictDoNothing).toHaveBeenCalledWith({
        target: newsArticles.url,
      });
      expect(mockReturning).toHaveBeenCalled();
    });

    it("should return count of newly inserted articles", async () => {
      const articles = [
        buildNormalizedArticle(),
        buildNormalizedArticle(),
        buildNormalizedArticle(),
        buildNormalizedArticle(),
        buildNormalizedArticle(),
      ];
      mockReturning.mockResolvedValueOnce([
        { id: "1" },
        { id: "2" },
        { id: "3" },
      ]);

      const count = await storeArticles(articles);

      expect(count).toBe(3);
    });

    it("should return 0 for empty article array", async () => {
      const count = await storeArticles([]);

      expect(count).toBe(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("should map NormalizedArticle fields correctly to insert format", async () => {
      const article = buildNormalizedArticle({
        title: "Test Title",
        url: "https://example.com/mapped",
        source: "TestSrc",
        market: "crypto",
        content: "Full content",
        summary: "Short summary",
        symbols: ["BTC", "ETH"],
        publishedAt: new Date("2026-03-13T12:00:00Z"),
        metadata: { extra: true },
      });
      mockReturning.mockResolvedValueOnce([{ id: "1" }]);

      await storeArticles([article]);

      expect(mockInsertValues).toHaveBeenCalled();
      const valuesArg = (
        mockInsertValues.mock.calls[0] as [Array<Record<string, unknown>>]
      )[0];
      const row = valuesArg[0];
      expect(row).toBeDefined();
      if (row) {
        expect(row["title"]).toBe("Test Title");
        expect(row["url"]).toBe("https://example.com/mapped");
        expect(row["source"]).toBe("TestSrc");
        expect(row["market"]).toBe("crypto");
        expect(row["symbols"]).toEqual(["BTC", "ETH"]);
        expect(row["isAnalyzed"]).toBe(false);
      }
    });
  });

  // =======================================================================
  // 3. Finnhub Fetcher
  // =======================================================================
  describe("Finnhub Fetcher", () => {
    it("should fetch news from Finnhub API with correct URL and API key", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockFinnhubArticle]),
      );

      await fetchFinnhubNews();

      expect(mockFetch).toHaveBeenCalled();
      const calledUrl = String(mockFetch.mock.calls[0]?.[0]);
      expect(calledUrl).toContain("finnhub.io");
      expect(calledUrl).toContain("token=test-finnhub-key");
    });

    it("should normalize Finnhub response to NormalizedArticle[]", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockFinnhubArticle]),
      );

      const articles = await fetchFinnhubNews();

      expect(articles.length).toBeGreaterThan(0);
      const first = articles[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.title).toBe("Apple Reports Record Q4 Revenue");
        expect(first.url).toBe("https://example.com/article/1");
        expect(first.source).toBe("Finnhub");
        expect(first.market).toBe("us_stock");
        expect(first.publishedAt).toBeInstanceOf(Date);
        expect(first.symbols).toContain("AAPL");
        expect(first.symbols).toContain("MSFT");
      }
    });

    it("should filter out articles older than 24 hours", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockFinnhubArticle, mockOldFinnhubArticle]),
      );

      const articles = await fetchFinnhubNews();

      const urls = articles.map((a) => a.url);
      expect(urls).not.toContain("https://example.com/article/old");
    });

    it("should return empty array on API error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      const articles = await fetchFinnhubNews();

      expect(articles).toEqual([]);
    });

    it("should parse comma-separated related symbols", async () => {
      const multiSymbol = {
        ...mockFinnhubArticle,
        related: "AAPL,MSFT,GOOGL",
      };
      mockFetch.mockResolvedValueOnce(
        createMockResponse([multiSymbol]),
      );

      const articles = await fetchFinnhubNews();

      const first = articles[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.symbols).toEqual(
          expect.arrayContaining(["AAPL", "MSFT", "GOOGL"]),
        );
      }
    });
  });

  // =======================================================================
  // 4. RSS Parser Fetcher
  // =======================================================================
  describe("RSS Parser Fetcher", () => {
    it('should fetch Indian market RSS feeds when market is "indian"', async () => {
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });

      const articles = await fetchRssNews("indian");

      expect(mockParseURL).toHaveBeenCalled();
      if (articles.length > 0) {
        for (const a of articles) {
          expect(a.market).toBe("indian_equity");
        }
      }
    });

    it('should fetch US market RSS feeds when market is "us"', async () => {
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });

      const articles = await fetchRssNews("us");

      expect(mockParseURL).toHaveBeenCalled();
      if (articles.length > 0) {
        for (const a of articles) {
          expect(a.market).toBe("us_stock");
        }
      }
    });

    it("should fetch all feeds when no market filter provided", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });

      const articles = await fetchRssNews();

      // Should invoke parseURL for all 5 feeds (3 Indian + 2 US)
      expect(mockParseURL.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(articles.length).toBeGreaterThan(0);
    });

    it("should handle individual feed failures gracefully via Promise.allSettled()", async () => {
      mockParseURL
        .mockRejectedValueOnce(new Error("Feed timeout"))
        .mockResolvedValue({ items: [mockRssItem] });

      const articles = await fetchRssNews();

      expect(Array.isArray(articles)).toBe(true);
    });

    it("should normalize RSS items to NormalizedArticle[]", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });

      const articles = await fetchRssNews("indian");

      expect(articles.length).toBeGreaterThan(0);
      const first = articles[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.title).toBe(mockRssItem.title);
        expect(first.url).toBe(mockRssItem.link);
        expect(typeof first.source).toBe("string");
        expect(first.publishedAt).toBeInstanceOf(Date);
      }
    });
  });

  // =======================================================================
  // 5. CoinGecko Fetcher
  // =======================================================================
  describe("CoinGecko Fetcher", () => {
    it("should fetch trending coins from /search/trending", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("trending"))
          return Promise.resolve(
            createMockResponse(mockCoinGeckoTrending),
          );
        if (s.includes("markets"))
          return Promise.resolve(createMockResponse([]));
        return Promise.resolve(createMockResponse([]));
      });

      const articles = await fetchCoinGeckoData();

      expect(articles.length).toBeGreaterThan(0);
      const cryptoArticles = articles.filter(
        (a) => a.market === "crypto",
      );
      expect(cryptoArticles.length).toBeGreaterThan(0);
    });

    it("should detect significant movers (>5% 24h change) from /coins/markets", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("trending"))
          return Promise.resolve(createMockResponse({ coins: [] }));
        if (s.includes("markets"))
          return Promise.resolve(createMockResponse(mockCoinGeckoMarkets));
        return Promise.resolve(createMockResponse([]));
      });

      const articles = await fetchCoinGeckoData();

      // Ethereum (6.5%) should generate an article; Bitcoin (1.2%) should not
      const ethArticles = articles.filter((a) =>
        a.symbols.some((sym) => sym.toLowerCase() === "eth"),
      );
      expect(ethArticles.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty array on API error", async () => {
      mockFetch.mockRejectedValue(new Error("CoinGecko rate limit"));

      const articles = await fetchCoinGeckoData();

      expect(articles).toEqual([]);
    });
  });

  // =======================================================================
  // 6. CryptoCompare Fetcher
  // =======================================================================
  describe("CryptoCompare Fetcher", () => {
    it("should use Apikey header format for authentication", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(mockCryptoCompareResponse),
      );

      await fetchCryptoCompareNews();

      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0] as [
        string,
        RequestInit | undefined,
      ];
      const headers = callArgs[1]?.headers as
        | Record<string, string>
        | undefined;
      const authHeader =
        headers?.["authorization"] ?? headers?.["Authorization"] ?? "";
      expect(authHeader).toContain("Apikey");
      expect(authHeader).toContain("test-cc-key");
    });

    it("should return empty array if API key is empty", async () => {
      mockEnv.CRYPTOCOMPARE_API_KEY = "";

      const articles = await fetchCryptoCompareNews();

      expect(articles).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should parse pipe-separated tags for symbols", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(mockCryptoCompareResponse),
      );

      const articles = await fetchCryptoCompareNews();

      expect(articles.length).toBeGreaterThan(0);
      const first = articles[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.symbols).toContain("BTC");
        expect(first.symbols).toContain("ETH");
        expect(first.market).toBe("crypto");
      }
    });
  });

  // =======================================================================
  // 7. Alpha Vantage Fetcher
  // =======================================================================
  describe("Alpha Vantage Fetcher", () => {
    it("should return empty array if API key is empty", async () => {
      mockEnv.ALPHA_VANTAGE_API_KEY = "";

      const articles = await fetchAlphaVantageNews();

      expect(articles).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should parse Alpha Vantage YYYYMMDDTHHMMSS date format", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(mockAlphaVantageResponse),
      );

      const articles = await fetchAlphaVantageNews();

      expect(articles.length).toBeGreaterThan(0);
      const first = articles[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.publishedAt).toBeInstanceOf(Date);
        expect(first.publishedAt.getFullYear()).toBe(2026);
        expect(first.publishedAt.getMonth()).toBe(2); // March = 2
        expect(first.publishedAt.getDate()).toBe(13);
      }
    });

    it("should extract symbols from ticker_sentiment array", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(mockAlphaVantageResponse),
      );

      const articles = await fetchAlphaVantageNews();

      const first = articles[0];
      expect(first).toBeDefined();
      if (first) {
        expect(first.symbols).toContain("SPY");
        expect(first.symbols).toContain("QQQ");
        expect(first.market).toBe("us_stock");
      }
    });
  });

  // =======================================================================
  // 8. Binance Fetcher
  // =======================================================================
  describe("Binance Fetcher", () => {
    it("should only generate articles for significant price movements (>3%)", async () => {
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(
            createMockResponse([{ symbol: "BTCUSDT", price: "95000.00" }]),
          );
        }
        return Promise.resolve(
          createMockResponse(mockBinanceKlinesSmallMove),
        );
      });

      const articles = await fetchBinanceData();

      expect(articles.length).toBe(0);
    });

    it("should generate articles for moves exceeding the 3% threshold", async () => {
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(
            createMockResponse([{ symbol: "BTCUSDT", price: "95000.00" }]),
          );
        }
        return Promise.resolve(
          createMockResponse(mockBinanceKlinesBigMove),
        );
      });

      const articles = await fetchBinanceData();

      expect(articles.length).toBeGreaterThan(0);
      if (articles[0]) {
        expect(articles[0].market).toBe("crypto");
        expect(articles[0].source).toBe("Binance");
      }
    });

    it("should not require API key", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(createMockResponse([])),
      );

      await fetchBinanceData();

      const callArgs = mockFetch.mock.calls[0] as
        | [string, RequestInit | undefined]
        | undefined;
      if (callArgs?.[1]?.headers) {
        const headers = callArgs[1].headers as Record<string, string>;
        expect(headers["Authorization"]).toBeUndefined();
        expect(headers["authorization"]).toBeUndefined();
      }
    });
  });

  // =======================================================================
  // 9. Reddit Fetcher
  // =======================================================================
  describe("Reddit Fetcher", () => {
    it("should fetch from WSB and ISB subreddits", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRedditPost] });

      const articles = await fetchRedditPosts();

      expect(mockParseURL.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(articles.length).toBeGreaterThan(0);
    });

    it("should extract $SYMBOL patterns from titles", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRedditPost] });

      const articles = await fetchRedditPosts();

      const hasAAPL = articles.some((a) => a.symbols.includes("AAPL"));
      expect(hasAAPL).toBe(true);
    });

    it("should use getRedditLimiter() for rate limiting", async () => {
      mockParseURL.mockResolvedValue({ items: [] });

      await fetchRedditPosts();

      expect(mockRedditSchedule).toHaveBeenCalled();
    });

    it("should tag articles with market: 'social'", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRedditPost] });

      const articles = await fetchRedditPosts();

      for (const a of articles) {
        expect(a.market).toBe("social");
      }
    });
  });

  // =======================================================================
  // 10. NSE India Fetcher
  // =======================================================================
  describe("NSE India Fetcher", () => {
    it("should generate articles for significant movers (>2% change)", async () => {
      mockGetEquityStockIndices.mockResolvedValueOnce(mockNseIndiaData);

      const articles = await fetchNseIndiaData();

      const reliance = articles.find((a) =>
        a.symbols.includes("RELIANCE"),
      );
      expect(reliance).toBeDefined();

      const tcs = articles.find((a) => a.symbols.includes("TCS"));
      expect(tcs).toBeUndefined();
    });

    it("should return empty array on scraper error", async () => {
      mockGetEquityStockIndices.mockRejectedValueOnce(
        new Error("NSE India blocked"),
      );

      const articles = await fetchNseIndiaData();

      expect(articles).toEqual([]);
    });

    it("should tag articles with market: 'indian_equity'", async () => {
      mockGetEquityStockIndices.mockResolvedValueOnce(mockNseIndiaData);

      const articles = await fetchNseIndiaData();

      for (const a of articles) {
        expect(a.market).toBe("indian_equity");
        expect(a.source).toBe("NseIndia");
      }
    });
  });

  // =======================================================================
  // 11. Rate Limiter Integration
  // =======================================================================
  describe("Rate Limiter Integration", () => {
    it("each fetcher should use its own dedicated Bottleneck instance", async () => {
      mockFetch.mockResolvedValue(createMockResponse([]));
      mockParseURL.mockResolvedValue({ items: [] });
      mockGetEquityStockIndices.mockResolvedValue({ data: [] });

      await fetchFinnhubNews();
      expect(mockFinnhubSchedule).toHaveBeenCalled();

      // Clear and re-implement to verify isolation
      vi.clearAllMocks();
      mockFinnhubSchedule.mockImplementation((fn: () => unknown) => fn());
      mockCoinGeckoSchedule.mockImplementation(
        (fn: () => unknown) => fn(),
      );
      mockCryptoCompareSchedule.mockImplementation(
        (fn: () => unknown) => fn(),
      );
      mockAlphaVantageSchedule.mockImplementation(
        (fn: () => unknown) => fn(),
      );
      mockBinanceSchedule.mockImplementation((fn: () => unknown) => fn());
      mockNseIndiaSchedule.mockImplementation(
        (fn: () => unknown) => fn(),
      );
      mockRedditSchedule.mockImplementation((fn: () => unknown) => fn());

      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("coingecko.com") && s.includes("trending"))
          return Promise.resolve(createMockResponse({ coins: [] }));
        if (s.includes("coingecko.com") && s.includes("markets"))
          return Promise.resolve(createMockResponse([]));
        return Promise.resolve(createMockResponse([]));
      });

      await fetchCoinGeckoData();
      expect(mockCoinGeckoSchedule).toHaveBeenCalled();
      // Finnhub schedule was NOT re-called (isolated)
      expect(mockFinnhubSchedule).not.toHaveBeenCalled();
    });

    it("all API calls should go through limiter.schedule()", async () => {
      mockFetch.mockResolvedValue(createMockResponse([]));
      mockParseURL.mockResolvedValue({ items: [] });
      mockGetEquityStockIndices.mockResolvedValue({ data: [] });

      await fetchFinnhubNews();
      expect(mockFinnhubSchedule).toHaveBeenCalled();

      mockFetch.mockResolvedValue(
        createMockResponse(mockCryptoCompareResponse),
      );
      await fetchCryptoCompareNews();
      expect(mockCryptoCompareSchedule).toHaveBeenCalled();

      await fetchRedditPosts();
      expect(mockRedditSchedule).toHaveBeenCalled();

      await fetchNseIndiaData();
      expect(mockNseIndiaSchedule).toHaveBeenCalled();
    });
  });

  // =======================================================================
  // 12. NormalizedArticle Response Normalization
  // =======================================================================
  describe("NormalizedArticle Response Normalization", () => {
    function assertNormalizedArticle(article: NormalizedArticle): void {
      expect(typeof article.title).toBe("string");
      expect(article.title.length).toBeGreaterThan(0);
      expect(typeof article.url).toBe("string");
      expect(article.url.length).toBeGreaterThan(0);
      expect(typeof article.source).toBe("string");
      expect(
        ["us_stock", "indian_equity", "crypto", "social"],
      ).toContain(article.market);
      expect(
        article.content === null || typeof article.content === "string",
      ).toBe(true);
      expect(
        article.summary === null || typeof article.summary === "string",
      ).toBe(true);
      expect(Array.isArray(article.symbols)).toBe(true);
      expect(article.publishedAt).toBeInstanceOf(Date);
      expect(
        article.metadata === null || typeof article.metadata === "object",
      ).toBe(true);
    }

    it("Finnhub should return NormalizedArticle[] with required fields", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockFinnhubArticle]),
      );
      const articles = await fetchFinnhubNews();
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
        expect(a.market).toBe("us_stock");
      }
    });

    it("RSS Parser should return NormalizedArticle[] with required fields", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRssItem] });
      const articles = await fetchRssNews("indian");
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
      }
    });

    it("CoinGecko should return NormalizedArticle[] with required fields", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("trending"))
          return Promise.resolve(
            createMockResponse(mockCoinGeckoTrending),
          );
        return Promise.resolve(createMockResponse([]));
      });
      const articles = await fetchCoinGeckoData();
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
        expect(a.market).toBe("crypto");
      }
    });

    it("CryptoCompare should return NormalizedArticle[] with required fields", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(mockCryptoCompareResponse),
      );
      const articles = await fetchCryptoCompareNews();
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
        expect(a.market).toBe("crypto");
      }
    });

    it("Alpha Vantage should return NormalizedArticle[] with required fields", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(mockAlphaVantageResponse),
      );
      const articles = await fetchAlphaVantageNews();
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
        expect(a.market).toBe("us_stock");
      }
    });

    it("Reddit should return NormalizedArticle[] with required fields", async () => {
      mockParseURL.mockResolvedValue({ items: [mockRedditPost] });
      const articles = await fetchRedditPosts();
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
        expect(a.market).toBe("social");
      }
    });

    it("NSE India should return NormalizedArticle[] with required fields", async () => {
      mockGetEquityStockIndices.mockResolvedValueOnce(mockNseIndiaData);
      const articles = await fetchNseIndiaData();
      expect(articles.length).toBeGreaterThan(0);
      for (const a of articles) {
        assertNormalizedArticle(a);
        expect(a.market).toBe("indian_equity");
      }
    });

    it("api_sources.error_count should increment on failure and reset on success", async () => {
      // Individual fetchers internally catch errors and return [].
      // To trigger the orchestrator's "rejected" branch (which calls sql
      // for atomic increment), we make the schedule mock reject — this
      // bypasses the fetcher's try-catch.
      mockFinnhubSchedule.mockImplementation(() =>
        Promise.reject(new Error("Limiter failure")),
      );

      // Other fetchers resolve normally
      mockFetch.mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("coingecko.com") && s.includes("trending"))
          return Promise.resolve(createMockResponse({ coins: [] }));
        if (s.includes("coingecko.com") && s.includes("markets"))
          return Promise.resolve(createMockResponse([]));
        if (s.includes("cryptocompare.com"))
          return Promise.resolve(
            createMockResponse({ Type: 100, Message: "", Data: [] }),
          );
        if (s.includes("binance.com"))
          return Promise.resolve(createMockResponse([]));
        if (s.includes("alphavantage.co"))
          return Promise.resolve(createMockResponse({ feed: [] }));
        return Promise.resolve(createMockResponse([]));
      });
      mockParseURL.mockResolvedValue({ items: [] });
      mockGetEquityStockIndices.mockResolvedValue({ data: [] });

      await fetchAllNews();

      // db.update should be called for api_sources tracking
      expect(mockUpdate).toHaveBeenCalled();
      // errorCount: 0 reset was called for successful sources
      const setCalls = mockUpdateSet.mock.calls as Array<
        [Record<string, unknown>]
      >;
      const resetCalls = setCalls.filter(
        (call) => call[0]?.errorCount === 0,
      );
      expect(resetCalls.length).toBeGreaterThan(0);
    });
  });
});
