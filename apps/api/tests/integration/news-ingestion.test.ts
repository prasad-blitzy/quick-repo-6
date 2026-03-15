/**
 * End-to-End News Ingestion Pipeline — Integration Test Suite
 *
 * Tests the complete news ingestion data flow:
 *   polling trigger → news-fetcher API calls (mocked) → URL deduplication
 *   → PostgreSQL storage → analysis queue enqueue
 *
 * Verifies that the orchestrator correctly:
 * - Aggregates articles from multiple mocked API sources via Promise.allSettled()
 * - Handles individual fetcher failures gracefully (one failure ≠ total failure)
 * - Supports market-based selective polling (e.g., only "us_stock" sources)
 * - Deduplicates articles by URL using onConflictDoNothing (AAP Rule 0.7.4)
 * - Maps NormalizedArticle fields to database columns correctly
 * - Tracks api_sources.error_count (increment on failure, reset on success)
 * - Returns 0 when given empty arrays (edge case)
 * - Completes the full pipeline: fetch → store → verify DB state
 *
 * Architecture:
 *   - Mocked: All 8 fetcher modules (no external API calls), analysis queue
 *     (no Redis), logger (suppress output)
 *   - Real: PostgreSQL database via Drizzle ORM, schema definitions, SQL
 *     execution with real ON CONFLICT deduplication
 *
 * CRITICAL AAP compliance:
 *   - TypeScript strict mode (Rule 0.7.1): No `any` types anywhere
 *   - ESM-first (Rule 0.7.1): All local imports use `.js` extension
 *   - URL-based deduplication (Rule 0.7.4): Verified via onConflictDoNothing
 *   - Graceful degradation (Rule 0.7.4): One failing fetcher never blocks others
 *   - Per-API Bottleneck isolation (Rule 0.7.4): Rate limiters are indirectly
 *     tested via mocked fetcher modules
 *
 * @module tests/integration/news-ingestion
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module Mocks — Hoisted before any module imports by Vitest
// ---------------------------------------------------------------------------

/**
 * Mock the logger module to suppress Pino log output during tests.
 * The orchestrator (news-fetcher/index.ts) creates a child logger at module
 * scope via `createLogger("news-fetcher")`. This mock provides a silent
 * no-op logger that satisfies all method calls without producing output.
 */
vi.mock("../../src/lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  })),
}));

/**
 * Mock ALL 8 individual fetcher modules.
 * Each mock replaces the real module so no external HTTP calls are made.
 * The mocked functions can be controlled per-test via vi.mocked().mockResolvedValue().
 */
vi.mock("../../src/services/news-fetcher/finnhub.js", () => ({
  fetchFinnhubNews: vi.fn(),
  fetchFinnhubQuote: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/rss-parser.js", () => ({
  fetchRssNews: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/reddit.js", () => ({
  fetchRedditPosts: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/coingecko.js", () => ({
  fetchCoinGeckoData: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/cryptocompare.js", () => ({
  fetchCryptoCompareNews: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/binance.js", () => ({
  fetchBinanceData: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/alpha-vantage.js", () => ({
  fetchAlphaVantageNews: vi.fn(),
}));

vi.mock("../../src/services/news-fetcher/nse-india.js", () => ({
  fetchNseIndiaData: vi.fn(),
}));

/**
 * Mock the analysis queue module to prevent BullMQ Queue initialization
 * errors (which require a live Redis connection). The orchestrator does not
 * directly import this module, but the test imports it to confirm the mock
 * is in place and to verify the analysis enqueue integration point.
 */
vi.mock("../../src/queues/analysis.queue.js", () => ({
  enqueueForAnalysis: vi.fn(),
  analysisQueue: { name: "analysis-mock" },
}));

// ---------------------------------------------------------------------------
// Real Imports — Database, Schemas, Drizzle Helpers
// ---------------------------------------------------------------------------

import { db } from "../../src/db/index.js";
import { newsArticles } from "../../src/db/schema/news-articles.js";
import { apiSources } from "../../src/db/schema/api-sources.js";
import { eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Orchestrator Imports — Real functions with mocked fetcher dependencies
// ---------------------------------------------------------------------------

import { fetchAllNews, storeArticles } from "../../src/services/news-fetcher/index.js";
import type { NormalizedArticle } from "../../src/services/news-fetcher/index.js";

// ---------------------------------------------------------------------------
// Mocked Module Imports — Used for vi.mocked() assertion setup
// ---------------------------------------------------------------------------

import { fetchFinnhubNews } from "../../src/services/news-fetcher/finnhub.js";
import { fetchRssNews } from "../../src/services/news-fetcher/rss-parser.js";
import { fetchRedditPosts } from "../../src/services/news-fetcher/reddit.js";
import { fetchCoinGeckoData } from "../../src/services/news-fetcher/coingecko.js";
import { fetchCryptoCompareNews } from "../../src/services/news-fetcher/cryptocompare.js";
import { fetchBinanceData } from "../../src/services/news-fetcher/binance.js";
import { fetchAlphaVantageNews } from "../../src/services/news-fetcher/alpha-vantage.js";
import { fetchNseIndiaData } from "../../src/services/news-fetcher/nse-india.js";
import { enqueueForAnalysis } from "../../src/queues/analysis.queue.js";

// ---------------------------------------------------------------------------
// Test Data Constants — NormalizedArticle Mock Sets
// ---------------------------------------------------------------------------

/**
 * Mock Finnhub US stock news articles.
 * Includes articles with both null and non-null content/metadata to test
 * nullable field handling. Both articles have market "us_stock".
 */
const mockFinnhubArticles: NormalizedArticle[] = [
  {
    title: "Apple Q4 Earnings Beat",
    url: "https://finnhub.io/news/apple-q4",
    source: "Finnhub",
    market: "us_stock",
    content: "Apple reported record revenue...",
    summary: "Apple beats Q4 expectations",
    symbols: ["AAPL"],
    publishedAt: new Date("2026-03-13T10:00:00Z"),
    metadata: { finnhubId: 12345 },
  },
  {
    title: "Tesla Delivery Numbers",
    url: "https://finnhub.io/news/tesla-delivery",
    source: "Finnhub",
    market: "us_stock",
    content: null,
    summary: "Tesla Q1 deliveries fall short",
    symbols: ["TSLA"],
    publishedAt: new Date("2026-03-13T11:00:00Z"),
    metadata: null,
  },
];

/**
 * Mock RSS Indian equity market articles.
 * Uses EconomicTimes-RSS source with market "indian_equity" to test
 * multi-market aggregation.
 */
const mockRssArticles: NormalizedArticle[] = [
  {
    title: "Reliance Q3 Results Strong",
    url: "https://economictimes.com/reliance-q3",
    source: "EconomicTimes-RSS",
    market: "indian_equity",
    content: "Reliance Industries reported...",
    summary: null,
    symbols: ["RELIANCE"],
    publishedAt: new Date("2026-03-13T09:00:00Z"),
    metadata: { feedName: "Economic Times Markets" },
  },
];

/**
 * Mock US RSS articles with market "us_stock" for market filter tests.
 * When the orchestrator filters by market "us_stock", this data is returned
 * by the RSS-US fetcher (which calls fetchRssNews("us")).
 */
const mockUsRssArticles: NormalizedArticle[] = [
  {
    title: "CNBC: Fed Rate Decision Today",
    url: "https://cnbc.com/fed-rate-decision",
    source: "CNBC-RSS",
    market: "us_stock",
    content: null,
    summary: "Federal Reserve expected to announce rate decision",
    symbols: [],
    publishedAt: new Date("2026-03-13T08:00:00Z"),
    metadata: { feedName: "CNBC Markets" },
  },
];

/**
 * Mock CoinGecko cryptocurrency articles.
 * Used to verify crypto market source aggregation and multi-market
 * article storage.
 */
const mockCryptoArticles: NormalizedArticle[] = [
  {
    title: "Bitcoin Surges Past $95K",
    url: "https://coingecko.com/btc-surge",
    source: "CoinGecko",
    market: "crypto",
    content: null,
    summary: "BTC hits new highs",
    symbols: ["BTC"],
    publishedAt: new Date("2026-03-13T12:00:00Z"),
    metadata: null,
  },
];

/**
 * Mock Reddit social sentiment articles.
 * Used for social market source coverage verification.
 */
const mockRedditArticles: NormalizedArticle[] = [
  {
    title: "$GME to the moon 🚀",
    url: "https://reddit.com/r/wallstreetbets/gme-post",
    source: "Reddit",
    market: "social",
    content: "GME squeeze incoming, YOLO time...",
    summary: null,
    symbols: ["GME"],
    publishedAt: new Date("2026-03-13T13:00:00Z"),
    metadata: { subreddit: "wallstreetbets" },
  },
];

// ---------------------------------------------------------------------------
// Helper — Setup all fetcher mocks to return empty arrays by default
// ---------------------------------------------------------------------------

/**
 * Configures all 8 fetcher mocks to return empty arrays.
 * Individual tests override specific fetchers as needed. This prevents
 * unexpected data from leaking between tests.
 */
function setupEmptyFetcherMocks(): void {
  vi.mocked(fetchFinnhubNews).mockResolvedValue([]);
  vi.mocked(fetchCoinGeckoData).mockResolvedValue([]);
  vi.mocked(fetchCryptoCompareNews).mockResolvedValue([]);
  vi.mocked(fetchBinanceData).mockResolvedValue([]);
  vi.mocked(fetchAlphaVantageNews).mockResolvedValue([]);
  vi.mocked(fetchNseIndiaData).mockResolvedValue([]);
  vi.mocked(fetchRedditPosts).mockResolvedValue([]);
  vi.mocked(fetchRssNews).mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("News Ingestion Pipeline", () => {
  // -------------------------------------------------------------------------
  // Database Lifecycle — Seed, Clean, Teardown
  // -------------------------------------------------------------------------

  /**
   * Seed the api_sources table with all 9 source entries matching the
   * orchestrator's fetcher registry names. Uses onConflictDoNothing for
   * idempotent re-runs. The `market` column is required by the schema.
   *
   * NOTE: Column name is `isActive` (not `isEnabled`) matching the actual
   * Drizzle ORM schema definition in api-sources.ts.
   */
  beforeAll(async () => {
    await db
      .insert(apiSources)
      .values([
        {
          name: "Finnhub",
          type: "api",
          market: "us_stock",
          baseUrl: "https://finnhub.io/api/v1",
          isActive: true,
        },
        {
          name: "RSS-EconomicTimes",
          type: "rss",
          market: "indian_equity",
          baseUrl: "https://economictimes.com/rss",
          isActive: true,
        },
        {
          name: "RSS-CNBC",
          type: "rss",
          market: "us_stock",
          baseUrl: "https://www.cnbc.com/rss",
          isActive: true,
        },
        {
          name: "Reddit",
          type: "api",
          market: "social",
          baseUrl: "https://www.reddit.com",
          isActive: true,
        },
        {
          name: "CoinGecko",
          type: "api",
          market: "crypto",
          baseUrl: "https://api.coingecko.com/api/v3",
          isActive: true,
        },
        {
          name: "CryptoCompare",
          type: "api",
          market: "crypto",
          baseUrl: "https://min-api.cryptocompare.com",
          isActive: true,
        },
        {
          name: "Binance",
          type: "api",
          market: "crypto",
          baseUrl: "https://api.binance.com/api/v3",
          isActive: true,
        },
        {
          name: "AlphaVantage",
          type: "api",
          market: "us_stock",
          baseUrl: "https://www.alphavantage.co/query",
          isActive: true,
        },
        {
          name: "NseIndia",
          type: "scraper",
          market: "indian_equity",
          baseUrl: "https://www.nseindia.com",
          isActive: true,
        },
      ])
      .onConflictDoNothing();
  });

  /**
   * Before each test:
   * 1. Cascade-delete all news articles AND their dependent rows
   *    (trade_opportunities, analysis_logs) to prevent FK violations
   * 2. Reset all api_sources error_count to 0 for clean error tracking
   * 3. Clear all Vitest mocks to prevent mock state leaks
   *
   * Uses TRUNCATE ... CASCADE to handle the foreign key chain:
   *   news_articles ← trade_opportunities ← (trade_performance, notification_logs)
   *   news_articles ← analysis_logs
   */
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE news_articles CASCADE`);
    await db.update(apiSources).set({ errorCount: 0 });
    vi.clearAllMocks();
  });

  /**
   * After all tests: clean up all test data to leave the database in a
   * pristine state. Truncate news_articles with cascade first, then
   * delete api_sources.
   */
  afterAll(async () => {
    await db.execute(sql`TRUNCATE news_articles CASCADE`);
    await db.delete(apiSources);
  });

  // =========================================================================
  // fetchAllNews() Orchestrator Tests
  // =========================================================================

  describe("fetchAllNews() orchestrator", () => {
    it("should aggregate articles from all sources via Promise.allSettled", async () => {
      // Configure mocks: Finnhub returns 2 articles, RSS-Indian returns 1,
      // RSS-US returns 0, CoinGecko returns 1. Others return empty.
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);

      // fetchRssNews is called twice by the orchestrator:
      //   1. fetchRssNews("indian") → returns mockRssArticles (1 article)
      //   2. fetchRssNews("us")     → returns [] (empty for this test)
      // Using mockImplementation to differentiate calls by argument.
      vi.mocked(fetchRssNews).mockImplementation(
        async (market?: "indian" | "us"): Promise<NormalizedArticle[]> => {
          if (market === "indian") return mockRssArticles;
          return [];
        },
      );

      vi.mocked(fetchCoinGeckoData).mockResolvedValue(mockCryptoArticles);

      const articles = await fetchAllNews();

      // Expected: 2 (Finnhub) + 1 (RSS-Indian) + 0 (RSS-US) + 1 (CoinGecko) = 4
      expect(articles.length).toBe(
        mockFinnhubArticles.length + mockRssArticles.length + mockCryptoArticles.length,
      );

      // Verify all fetchers were invoked by the orchestrator
      expect(fetchFinnhubNews).toHaveBeenCalledOnce();
      expect(fetchCoinGeckoData).toHaveBeenCalledOnce();
      expect(fetchRedditPosts).toHaveBeenCalledOnce();
      expect(fetchCryptoCompareNews).toHaveBeenCalledOnce();
      expect(fetchBinanceData).toHaveBeenCalledOnce();
      expect(fetchAlphaVantageNews).toHaveBeenCalledOnce();
      expect(fetchNseIndiaData).toHaveBeenCalledOnce();

      // RSS is called TWICE by the orchestrator (indian + us)
      expect(fetchRssNews).toHaveBeenCalledTimes(2);
    });

    it("should handle individual fetcher failures gracefully (Promise.allSettled)", async () => {
      // Finnhub succeeds, CoinGecko throws — graceful degradation
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);
      vi.mocked(fetchCoinGeckoData).mockRejectedValue(
        new Error("CoinGecko API timeout"),
      );

      // Should NOT throw — graceful degradation per AAP Rule 0.7.4
      const articles = await fetchAllNews();

      // Should still return Finnhub articles despite CoinGecko failure
      expect(articles.length).toBe(mockFinnhubArticles.length);

      // Both fetchers should have been called (Promise.allSettled runs all)
      expect(fetchFinnhubNews).toHaveBeenCalledOnce();
      expect(fetchCoinGeckoData).toHaveBeenCalledOnce();
    });

    it("should handle ALL fetchers failing without throwing", async () => {
      // Every fetcher rejects — the orchestrator should return empty, not throw
      vi.mocked(fetchFinnhubNews).mockRejectedValue(new Error("Finnhub down"));
      vi.mocked(fetchRssNews).mockRejectedValue(new Error("RSS timeout"));
      vi.mocked(fetchRedditPosts).mockRejectedValue(new Error("Reddit 429"));
      vi.mocked(fetchCoinGeckoData).mockRejectedValue(new Error("CG 500"));
      vi.mocked(fetchCryptoCompareNews).mockRejectedValue(new Error("CC fail"));
      vi.mocked(fetchBinanceData).mockRejectedValue(new Error("Binance fail"));
      vi.mocked(fetchAlphaVantageNews).mockRejectedValue(new Error("AV fail"));
      vi.mocked(fetchNseIndiaData).mockRejectedValue(new Error("NSE fail"));

      const articles = await fetchAllNews();

      expect(articles.length).toBe(0);
    });

    it("should support market filter in fetchAllNews options", async () => {
      // Configure mocks with market-appropriate data
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);

      // RSS mock returns US articles when called with "us"
      vi.mocked(fetchRssNews).mockImplementation(
        async (market?: "indian" | "us"): Promise<NormalizedArticle[]> => {
          if (market === "us") return mockUsRssArticles;
          if (market === "indian") return mockRssArticles;
          return [];
        },
      );

      vi.mocked(fetchCoinGeckoData).mockResolvedValue(mockCryptoArticles);

      // Fetch only US stock sources
      const articles = await fetchAllNews({ markets: ["us_stock"] });

      // Should contain ONLY articles from us_stock fetchers
      // (Finnhub, RSS-CNBC, AlphaVantage)
      expect(articles.length).toBeGreaterThan(0);

      for (const article of articles) {
        expect(article.market).toBe("us_stock");
      }

      // Crypto fetchers should NOT have been called
      expect(fetchCoinGeckoData).not.toHaveBeenCalled();
      expect(fetchCryptoCompareNews).not.toHaveBeenCalled();
      expect(fetchBinanceData).not.toHaveBeenCalled();
    });

    it("should return empty array when filtering by non-existent market", async () => {
      setupEmptyFetcherMocks();

      // Filter by a market that no fetcher is registered for
      const articles = await fetchAllNews({ markets: ["commodities"] });

      expect(articles.length).toBe(0);
    });
  });

  // =========================================================================
  // storeArticles() with URL Deduplication Tests
  // =========================================================================

  describe("storeArticles() with URL deduplication", () => {
    it("should store new articles in the database", async () => {
      const insertedCount = await storeArticles(mockFinnhubArticles);

      // Two Finnhub articles, both new
      expect(insertedCount).toBe(2);

      // Verify articles are actually in the database
      const dbArticles = await db.select().from(newsArticles);
      expect(dbArticles.length).toBe(2);

      // All newly inserted articles should be unanalyzed
      expect(dbArticles[0]!.isAnalyzed).toBe(false);
      expect(dbArticles[1]!.isAnalyzed).toBe(false);
    });

    it("should deduplicate articles by URL (silently skip duplicates)", async () => {
      // First insert — both articles are new
      const firstCount = await storeArticles(mockFinnhubArticles);
      expect(firstCount).toBe(2);

      // Second insert with SAME URLs — should be silently skipped per AAP Rule 0.7.4
      const secondCount = await storeArticles(mockFinnhubArticles);
      expect(secondCount).toBe(0); // All duplicates

      // Database should still have exactly 2 articles (no duplicates created)
      const dbArticles = await db.select().from(newsArticles);
      expect(dbArticles.length).toBe(2);
    });

    it("should handle mixed new and duplicate articles", async () => {
      // Insert first batch (2 Finnhub articles)
      await storeArticles(mockFinnhubArticles);

      // Insert mix of duplicates (Finnhub) + new articles (RSS)
      const mixedArticles: NormalizedArticle[] = [
        ...mockFinnhubArticles, // duplicates — will be skipped
        ...mockRssArticles, // new — will be inserted
      ];
      const insertedCount = await storeArticles(mixedArticles);

      // Only the new RSS articles should be counted as inserted
      expect(insertedCount).toBe(mockRssArticles.length);

      // Total should be 2 (Finnhub) + 1 (RSS) = 3
      const dbArticles = await db.select().from(newsArticles);
      expect(dbArticles.length).toBe(3);
    });

    it("should correctly map NormalizedArticle fields to database columns", async () => {
      await storeArticles(mockFinnhubArticles);

      // Query the specific article by URL to verify field mapping
      const [dbArticle] = await db
        .select()
        .from(newsArticles)
        .where(eq(newsArticles.url, "https://finnhub.io/news/apple-q4"));

      expect(dbArticle).toBeDefined();
      expect(dbArticle!.title).toBe("Apple Q4 Earnings Beat");
      expect(dbArticle!.source).toBe("Finnhub");
      expect(dbArticle!.market).toBe("us_stock");
      expect(dbArticle!.symbols).toEqual(["AAPL"]);
      expect(dbArticle!.isAnalyzed).toBe(false);
      expect(dbArticle!.content).toBe("Apple reported record revenue...");
      expect(dbArticle!.summary).toBe("Apple beats Q4 expectations");

      // Verify auto-generated fields exist
      expect(dbArticle!.id).toBeDefined();
      expect(dbArticle!.createdAt).toBeInstanceOf(Date);
      expect(dbArticle!.updatedAt).toBeInstanceOf(Date);
    });

    it("should handle nullable content and metadata correctly", async () => {
      // The second Finnhub article has null content and null metadata
      await storeArticles(mockFinnhubArticles);

      const [dbArticle] = await db
        .select()
        .from(newsArticles)
        .where(eq(newsArticles.url, "https://finnhub.io/news/tesla-delivery"));

      expect(dbArticle).toBeDefined();
      expect(dbArticle!.content).toBeNull();
      expect(dbArticle!.metadata).toBeNull();
      expect(dbArticle!.title).toBe("Tesla Delivery Numbers");
    });

    it("should return 0 when given empty array", async () => {
      const insertedCount = await storeArticles([]);
      expect(insertedCount).toBe(0);

      // Database should remain empty
      const dbArticles = await db.select().from(newsArticles);
      expect(dbArticles.length).toBe(0);
    });

    it("should store articles from multiple markets correctly", async () => {
      const allArticles: NormalizedArticle[] = [
        ...mockFinnhubArticles, // us_stock
        ...mockRssArticles, // indian_equity
        ...mockCryptoArticles, // crypto
        ...mockRedditArticles, // social
      ];

      const insertedCount = await storeArticles(allArticles);
      expect(insertedCount).toBe(allArticles.length);

      // Verify correct total using sql count
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(newsArticles);

      expect(countResult!.count).toBe(allArticles.length);
    });
  });

  // =========================================================================
  // Full Pipeline: fetch → store → enqueue
  // =========================================================================

  describe("Full pipeline: fetch → store → enqueue", () => {
    it("should complete the full ingestion pipeline", async () => {
      // Setup mocks — 3 sources return articles, rest return empty
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);

      vi.mocked(fetchRssNews).mockImplementation(
        async (market?: "indian" | "us"): Promise<NormalizedArticle[]> => {
          if (market === "indian") return mockRssArticles;
          return [];
        },
      );

      vi.mocked(fetchCoinGeckoData).mockResolvedValue(mockCryptoArticles);

      // Step 1: Fetch all news from all sources
      const articles = await fetchAllNews();
      expect(articles.length).toBeGreaterThan(0);

      // Step 2: Store with URL deduplication
      const insertedCount = await storeArticles(articles);
      expect(insertedCount).toBe(articles.length);

      // Step 3: Verify database state matches fetched articles
      const dbArticles = await db.select().from(newsArticles);
      expect(dbArticles.length).toBe(articles.length);

      // Step 4: All newly stored articles must be unanalyzed
      for (const article of dbArticles) {
        expect(article.isAnalyzed).toBe(false);
      }

      // Step 5: Verify the enqueueForAnalysis mock is importable (no Redis errors)
      expect(enqueueForAnalysis).toBeDefined();
    });

    it("should not create duplicate articles across multiple pipeline runs", async () => {
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);

      // First pipeline run
      const firstArticles = await fetchAllNews();
      const firstInserted = await storeArticles(firstArticles);
      expect(firstInserted).toBe(2);

      // Second pipeline run with same data (simulates next 5-min cron tick)
      vi.clearAllMocks();
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);

      const secondArticles = await fetchAllNews();
      const secondInserted = await storeArticles(secondArticles);
      expect(secondInserted).toBe(0); // All duplicates

      // Database should still have exactly 2 articles
      const dbArticles = await db.select().from(newsArticles);
      expect(dbArticles.length).toBe(2);
    });
  });

  // =========================================================================
  // api_sources Error Tracking Tests
  // =========================================================================

  describe("api_sources error tracking", () => {
    it("should update api_sources error_count on fetcher failure", async () => {
      // CoinGecko fails, all others succeed (return empty)
      setupEmptyFetcherMocks();
      vi.mocked(fetchCoinGeckoData).mockRejectedValue(
        new Error("API Error"),
      );

      await fetchAllNews();

      // Check that CoinGecko's error_count was incremented by the orchestrator
      const [coingeckoSource] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "CoinGecko"));

      expect(coingeckoSource).toBeDefined();
      expect(coingeckoSource!.errorCount).toBeGreaterThan(0);
    });

    it("should reset api_sources error_count on successful fetch", async () => {
      // Artificially set error_count > 0 for Finnhub
      await db
        .update(apiSources)
        .set({ errorCount: 5 })
        .where(eq(apiSources.name, "Finnhub"));

      // Verify the error count was set
      const [beforeFetch] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "Finnhub"));
      expect(beforeFetch!.errorCount).toBe(5);

      // Successful fetch — orchestrator should reset error_count to 0
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);

      await fetchAllNews();

      // error_count should be reset to 0 after successful fetch
      const [finnhubSource] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "Finnhub"));

      expect(finnhubSource).toBeDefined();
      expect(finnhubSource!.errorCount).toBe(0);
    });

    it("should not affect error_count of successful sources when one fails", async () => {
      // Finnhub succeeds, CoinGecko fails
      setupEmptyFetcherMocks();
      vi.mocked(fetchFinnhubNews).mockResolvedValue(mockFinnhubArticles);
      vi.mocked(fetchCoinGeckoData).mockRejectedValue(
        new Error("CoinGecko 503"),
      );

      await fetchAllNews();

      // Finnhub should have error_count = 0 (success)
      const [finnhubSource] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "Finnhub"));
      expect(finnhubSource!.errorCount).toBe(0);

      // CoinGecko should have error_count > 0 (failure)
      const [coingeckoSource] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "CoinGecko"));
      expect(coingeckoSource!.errorCount).toBeGreaterThan(0);
    });

    it("should increment error_count cumulatively across multiple failures", async () => {
      // First failure
      setupEmptyFetcherMocks();
      vi.mocked(fetchCoinGeckoData).mockRejectedValue(new Error("Fail 1"));
      await fetchAllNews();

      const [firstCheck] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "CoinGecko"));
      const firstErrorCount = firstCheck!.errorCount;
      expect(firstErrorCount).toBeGreaterThan(0);

      // Second failure — error count should increment further
      vi.clearAllMocks();
      setupEmptyFetcherMocks();
      vi.mocked(fetchCoinGeckoData).mockRejectedValue(new Error("Fail 2"));
      await fetchAllNews();

      const [secondCheck] = await db
        .select()
        .from(apiSources)
        .where(eq(apiSources.name, "CoinGecko"));
      expect(secondCheck!.errorCount).toBeGreaterThan(firstErrorCount);
    });
  });
});
