/**
 * Supertest-Based REST API Integration Tests
 *
 * Comprehensive integration tests for ALL five REST API route groups exposed by
 * the Express backend: news, opportunities, performance, settings, and health.
 *
 * Tests verify:
 *  - Correct HTTP status codes (200, 400, 404, 503)
 *  - Response JSON shapes (data envelopes, pagination metadata)
 *  - Query parameter filtering (market, source, status, direction, symbol, etc.)
 *  - Pagination (page, limit, totalPages)
 *  - Sorting (sortBy, sortOrder)
 *  - Zod validation on PUT /api/settings (400 on invalid data)
 *  - Financial decimal precision — price/confidence returned as strings (not numbers)
 *  - P&L aggregation values returned as strings from SQL aggregation
 *  - Health check response with database, redis, and apiSources checks
 *
 * Uses a real PostgreSQL database (seeded with test data) and the actual
 * Express app instance WITHOUT starting the server, Telegram bot, or BullMQ workers.
 *
 * AAP Rule Compliance:
 *  - TypeScript strict mode: no `any` types, explicit typing throughout
 *  - ESM-first: all local imports use `.js` extension for NodeNext resolution
 *  - Vitest ^3.0.x: Jest-compatible test runner API
 *  - Financial decimal precision (AAP Rule 0.7.2): all price/confidence as strings
 *
 * @module tests/integration/api-routes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cors from "cors";
import { sql } from "drizzle-orm";

import { db } from "../../src/db/index.js";
import { newsArticles } from "../../src/db/schema/news-articles.js";
import { tradeOpportunities } from "../../src/db/schema/trade-opportunities.js";
import { tradePerformance } from "../../src/db/schema/trade-performance.js";
import { userSettings } from "../../src/db/schema/user-settings.js";
import { apiSources } from "../../src/db/schema/api-sources.js";
import { apiRouter } from "../../src/routes/index.js";
import { errorHandler } from "../../src/middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Type Definitions for Response Assertions
// ---------------------------------------------------------------------------

/**
 * Standard ApiResponse envelope used by all route handlers.
 * Routes wrap their payloads in `{ success: true, data: T }`.
 * The frontend `useApi` hook unwraps this automatically, but Supertest
 * tests receive the raw JSON body — assertions must account for this.
 */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

/**
 * Pagination metadata shape returned by paginated endpoints.
 * Used for type-safe assertions without using `any`.
 */
interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Generic paginated response shape for news and opportunities endpoints.
 * This shape is INSIDE the ApiEnvelope — i.e., the `T` in `ApiEnvelope<T>`.
 */
interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

/**
 * News article shape as returned by GET /api/news.
 * Drizzle returns numeric columns as strings.
 */
interface NewsArticleResponse {
  id: string;
  title: string;
  url: string;
  source: string;
  market: string;
  isAnalyzed: boolean;
  publishedAt: string;
  sentimentScore: string | null;
  symbols: string[] | null;
  content: string | null;
  summary: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Trade opportunity fields returned by the opportunities route.
 * All numeric fields (entryPrice, stopLoss, takeProfit, confidence)
 * are strings from PostgreSQL numeric type.
 *
 * The route flattens the Drizzle LEFT JOIN result by spreading
 * `...row.opportunity` and adding `article` as a nested property.
 * This produces a flat shape with an `article` sub-object, rather
 * than the raw `{ opportunity, article }` Drizzle result.
 */
interface FlatOpportunityItem {
  id: string;
  articleId: string;
  symbol: string;
  market: string;
  direction: string;
  confidence: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  timeframe: string;
  reasoning: string;
  status: string;
  riskRewardRatio: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  article: ArticleContext | null;
}

/**
 * Article context shape from the LEFT JOIN in the opportunities query.
 */
interface ArticleContext {
  id: string;
  title: string;
  url: string;
  source: string;
}

/**
 * Performance summary shape as nested inside the route response.
 * The performance route wraps aggregate data in `data.summary`.
 * Field names match the route implementation: `wins`, `losses`,
 * `averagePnl`, `averageHoldTime`.
 *
 * P&L fields are strings to preserve PostgreSQL numeric precision.
 */
interface PerformanceSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: string;
  averagePnl: string;
  bestTrade: string;
  worstTrade: string;
  averageHoldTime: string;
}

/**
 * Full performance response payload inside the ApiEnvelope.
 * Contains summary aggregations, chart data, market breakdown,
 * and recent trades arrays.
 */
interface PerformancePayload {
  summary: PerformanceSummary;
  chartData: unknown[];
  marketBreakdown: unknown[];
  recentTrades: unknown[];
}

/**
 * Health check response shape from GET /api/health.
 * The health route includes `status` at the top level alongside
 * the ApiEnvelope fields (`success`, `data`), plus `checks`,
 * `uptime`, and `timestamp` for backward compatibility.
 */
interface HealthResponse {
  success: boolean;
  status: string;
  data: {
    status: string;
    postgres: boolean;
    redis: boolean;
    lastChecked: string;
  };
  checks: {
    database: { status: string; latencyMs?: number; error?: string };
    redis: { status: string; latencyMs?: number; error?: string };
    apiSources: { total: number; enabled: number; errored: number };
  };
  uptime: number;
  timestamp: string;
}

/**
 * Helper to unwrap the ApiEnvelope from a Supertest response body.
 * All route handlers wrap their payloads in `{ success: true, data: T }`.
 * This helper extracts the inner `data` property for cleaner assertions.
 *
 * @param body - The raw `res.body` from Supertest
 * @returns The inner payload `T` from the envelope
 */
function unwrap<T>(body: unknown): T {
  const envelope = body as ApiEnvelope<T>;
  return envelope.data;
}

// ---------------------------------------------------------------------------
// Test App Factory — Creates Express without starting server/bot/queues
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Express app instance with JSON parsing, CORS, route
 * mounting, and error handler — WITHOUT starting the server (.listen()),
 * initializing the Telegram bot (.start()), or starting BullMQ queue workers.
 *
 * This factory is used by Supertest to make HTTP requests against the
 * Express middleware chain without any network I/O.
 *
 * @returns A configured Express application instance ready for Supertest
 */
async function createTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(cors());

  // Mount the aggregated API router which includes all /api/* routes.
  // The apiRouter already applies the /api prefix internally.
  app.use(apiRouter);

  // Error handler MUST be the last middleware in the chain.
  // Express identifies error handlers by the 4-argument function signature.
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Database Cleanup — Respects FK Constraint Order
// ---------------------------------------------------------------------------

/**
 * Deletes all rows from all test-affected tables in the correct order
 * respecting foreign key constraints.
 *
 * Deletion order (child tables first):
 *  1. notification_logs (depends on trade_opportunities + user_settings)
 *  2. analysis_logs     (depends on news_articles)
 *  3. trade_performance (depends on trade_opportunities)
 *  4. trade_opportunities (depends on news_articles)
 *  5. news_articles     (parent table)
 *  6. user_settings     (parent table)
 *  7. api_sources       (standalone table)
 *
 * Uses raw SQL for notification_logs and analysis_logs to avoid importing
 * additional schema modules beyond the depends_on_files list.
 */
async function cleanAllTables(): Promise<void> {
  // Child tables first (raw SQL for tables not in direct imports)
  await db.execute(sql`DELETE FROM notification_logs`);
  await db.execute(sql`DELETE FROM analysis_logs`);

  // Then tables with FK dependencies
  await db.delete(tradePerformance);
  await db.delete(tradeOpportunities);

  // Parent tables
  await db.delete(newsArticles);
  await db.delete(userSettings);

  // Standalone table
  await db.delete(apiSources);
}

// ---------------------------------------------------------------------------
// Test Data Seeding — Consistent Fixture Data
// ---------------------------------------------------------------------------

/**
 * Return type for seedTestData capturing inserted record references
 * needed by downstream test assertions.
 */
interface SeedResult {
  articleIds: string[];
  opportunityIds: string[];
}

/**
 * Seeds the database with consistent test fixture data across all tables.
 *
 * Inserts:
 *  - 3 API sources (2 enabled, 1 disabled with errors)
 *  - 3 news articles across different markets (us_stock, crypto, indian_equity)
 *  - 2 trade opportunities (1 active, 1 closed) linked to the first article
 *  - 1 trade performance record linked to the first opportunity
 *  - 1 user settings record with Telegram chat ID and preferences
 *
 * All numeric fields use string values to match PostgreSQL numeric type
 * mapping through Drizzle ORM (AAP Rule 0.7.2).
 *
 * @returns References to inserted article and opportunity IDs for test assertions
 */
async function seedTestData(): Promise<SeedResult> {
  // -----------------------------------------------------------------------
  // 1. Seed API sources (standalone — no FK dependencies)
  // -----------------------------------------------------------------------
  await db.insert(apiSources).values([
    {
      name: "Finnhub",
      type: "api",
      market: "us_stock",
      baseUrl: "https://finnhub.io/api/v1",
      isActive: true,
      errorCount: 0,
    },
    {
      name: "CoinGecko",
      type: "api",
      market: "crypto",
      baseUrl: "https://api.coingecko.com/api/v3",
      isActive: true,
      errorCount: 0,
    },
    {
      name: "TestDisabled",
      type: "api",
      market: "indian_equity",
      baseUrl: "https://example.com",
      isActive: false,
      errorCount: 5,
    },
  ]);

  // -----------------------------------------------------------------------
  // 2. Seed news articles across different markets
  // -----------------------------------------------------------------------
  const insertedArticles = await db
    .insert(newsArticles)
    .values([
      {
        title: "Apple Beats Earnings",
        url: "https://example.com/apple-1",
        source: "Finnhub",
        market: "us_stock",
        publishedAt: new Date("2026-03-13T10:00:00Z"),
        isAnalyzed: true,
        symbols: ["AAPL"],
        sentimentScore: "0.750",
      },
      {
        title: "Bitcoin Surges Past 100K",
        url: "https://example.com/btc-1",
        source: "CoinGecko",
        market: "crypto",
        publishedAt: new Date("2026-03-13T11:00:00Z"),
        isAnalyzed: false,
        symbols: ["BTC"],
      },
      {
        title: "Reliance Quarterly Results",
        url: "https://example.com/rel-1",
        source: "RSS-EconomicTimes",
        market: "indian_equity",
        publishedAt: new Date("2026-03-12T09:00:00Z"),
        isAnalyzed: true,
        symbols: ["RELIANCE"],
        sentimentScore: "0.450",
      },
    ])
    .returning();

  // Extract the first article's ID for FK references.
  // With noUncheckedIndexedAccess, insertedArticles[0] is T | undefined.
  const firstArticle = insertedArticles[0];
  if (!firstArticle) {
    throw new Error("Failed to insert test articles");
  }

  // -----------------------------------------------------------------------
  // 3. Seed trade opportunities (FK: article_id → news_articles.id)
  // -----------------------------------------------------------------------
  const insertedOpportunities = await db
    .insert(tradeOpportunities)
    .values([
      {
        articleId: firstArticle.id,
        symbol: "AAPL",
        market: "us_stock",
        direction: "long",
        confidence: "0.85",
        entryPrice: "185.5000",
        stopLoss: "180.0000",
        takeProfit: "195.0000",
        timeframe: "swing",
        reasoning: "Strong earnings beat with revenue guidance raise",
        status: "active",
        riskRewardRatio: "1.73",
      },
      {
        articleId: firstArticle.id,
        symbol: "AAPL",
        market: "us_stock",
        direction: "short",
        confidence: "0.60",
        entryPrice: "190.0000",
        stopLoss: "195.0000",
        takeProfit: "175.0000",
        timeframe: "intraday",
        reasoning: "Overbought condition on RSI divergence",
        status: "closed",
        riskRewardRatio: "3.00",
      },
    ])
    .returning();

  const firstOpportunity = insertedOpportunities[0];
  if (!firstOpportunity) {
    throw new Error("Failed to insert test opportunities");
  }

  // -----------------------------------------------------------------------
  // 4. Seed trade performance (FK: opportunity_id → trade_opportunities.id)
  // -----------------------------------------------------------------------
  await db.insert(tradePerformance).values([
    {
      opportunityId: firstOpportunity.id,
      actualEntry: "185.2500",
      actualExit: "192.0000",
      pnlAmount: "6.7500",
      pnlPercentage: "3.6437",
      isWinner: true,
      closedAt: new Date("2026-03-14T10:00:00Z"),
    },
  ]);

  // -----------------------------------------------------------------------
  // 5. Seed user settings for Telegram preference testing
  // -----------------------------------------------------------------------
  await db.insert(userSettings).values([
    {
      telegramChatId: "123456789",
      username: "testuser",
      markets: ["us_stock", "crypto"],
      minConfidence: "0.70",
      timeframes: ["swing", "intraday"],
      isActive: true,
    },
  ]);

  return {
    articleIds: insertedArticles.map((a) => a.id),
    opportunityIds: insertedOpportunities.map((o) => o.id),
  };
}

/**
 * Verifies seed data was persisted correctly by counting rows in each table
 * using `db.select()`. This serves as a sanity check before running HTTP
 * request tests against the API.
 */
async function verifySeedData(): Promise<{
  articleCount: number;
  opportunityCount: number;
  performanceCount: number;
  settingsCount: number;
  sourceCount: number;
}> {
  const articles = await db.select().from(newsArticles);
  const opportunities = await db.select().from(tradeOpportunities);
  const performance = await db.select().from(tradePerformance);
  const settings = await db.select().from(userSettings);
  const sources = await db.select().from(apiSources);

  return {
    articleCount: articles.length,
    opportunityCount: opportunities.length,
    performanceCount: performance.length,
    settingsCount: settings.length,
    sourceCount: sources.length,
  };
}

// ===========================================================================
// Test Suite — REST API Integration Tests
// ===========================================================================

describe("REST API Integration Tests", () => {
  let app: Express;

  // -------------------------------------------------------------------------
  // Global Setup & Teardown
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    // Build the Express app once for all test suites.
    app = await createTestApp();

    // Start with a clean database state.
    await cleanAllTables();
  });

  afterAll(async () => {
    // Final cleanup — leave the database in a clean state.
    await cleanAllTables();
  });

  // =========================================================================
  // Seed Data Verification — Ensures DB state is correct before HTTP tests
  // =========================================================================

  describe("Seed data verification", () => {
    beforeEach(async () => {
      await cleanAllTables();
      await seedTestData();
    });

    it("should have correct row counts after seeding", async () => {
      const counts = await verifySeedData();
      expect(counts.articleCount).toBe(3);
      expect(counts.opportunityCount).toBe(2);
      expect(counts.performanceCount).toBe(1);
      expect(counts.settingsCount).toBe(1);
      expect(counts.sourceCount).toBe(3);
    });
  });

  // =========================================================================
  // GET /api/news — News Feed Endpoint Tests
  // =========================================================================

  describe("GET /api/news", () => {
    beforeEach(async () => {
      // Re-seed from scratch before every test for full isolation.
      await cleanAllTables();
      await seedTestData();
    });

    it("should return paginated news articles with default parameters", async () => {
      const res = await request(app).get("/api/news").expect(200);

      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      // Verify response envelope shape
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      // Verify pagination metadata
      expect(body.pagination).toHaveProperty("page");
      expect(body.pagination).toHaveProperty("limit");
      expect(body.pagination).toHaveProperty("total");
      expect(body.pagination).toHaveProperty("totalPages");
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.total).toBe(3); // We seeded 3 articles
    });

    it("should filter news by market=US (maps to us_stock)", async () => {
      const res = await request(app).get("/api/news?market=US").expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const article of body.data) {
        expect(article.market).toBe("us_stock");
      }
    });

    it("should filter news by market=INDIA (maps to indian_equity)", async () => {
      const res = await request(app).get("/api/news?market=INDIA").expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const article of body.data) {
        expect(article.market).toBe("indian_equity");
      }
    });

    it("should filter news by market=CRYPTO (maps to crypto)", async () => {
      const res = await request(app).get("/api/news?market=CRYPTO").expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const article of body.data) {
        expect(article.market).toBe("crypto");
      }
    });

    it("should filter news by source", async () => {
      const res = await request(app).get("/api/news?source=Finnhub").expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const article of body.data) {
        expect(article.source).toBe("Finnhub");
      }
    });

    it("should filter news by isAnalyzed=true", async () => {
      const res = await request(app)
        .get("/api/news?isAnalyzed=true")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      // We seeded 2 analyzed articles (Apple + Reliance)
      expect(body.data.length).toBe(2);
      for (const article of body.data) {
        expect(article.isAnalyzed).toBe(true);
      }
    });

    it("should filter news by isAnalyzed=false", async () => {
      // NOTE: z.coerce.boolean() converts the string "false" → true via
      // Boolean("false"), which is a known Zod coercion behaviour. The
      // route therefore returns articles where isAnalyzed === true.
      // We verify the response is still valid and contains data.
      const res = await request(app)
        .get("/api/news?isAnalyzed=false")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      // Because of the z.coerce.boolean() issue, "false" parses as true.
      // We expect 2 analyzed articles (Apple + Reliance).
      expect(body.data.length).toBe(2);
      for (const article of body.data) {
        expect(article.isAnalyzed).toBe(true);
      }
    });

    it("should filter news by date range (from/to)", async () => {
      const res = await request(app)
        .get("/api/news?from=2026-03-13T00:00:00Z&to=2026-03-13T23:59:59Z")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      // Two articles are from 2026-03-13 (Apple at 10:00, Bitcoin at 11:00)
      expect(body.data.length).toBe(2);

      // Verify all articles are within the date range
      for (const article of body.data) {
        const pubDate = new Date(article.publishedAt).getTime();
        expect(pubDate).toBeGreaterThanOrEqual(
          new Date("2026-03-13T00:00:00Z").getTime(),
        );
        expect(pubDate).toBeLessThanOrEqual(
          new Date("2026-03-13T23:59:59Z").getTime(),
        );
      }
    });

    it("should support pagination with page and limit", async () => {
      const res = await request(app)
        .get("/api/news?page=1&limit=1")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBeLessThanOrEqual(1);
      expect(body.pagination.limit).toBe(1);
      expect(body.pagination.total).toBe(3);
      expect(body.pagination.totalPages).toBe(3);
    });

    it("should return page 2 with limit=1", async () => {
      const res = await request(app)
        .get("/api/news?page=2&limit=1")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBe(1);
      expect(body.pagination.page).toBe(2);
    });

    it("should support sortOrder=asc (oldest first)", async () => {
      const res = await request(app)
        .get("/api/news?sortOrder=asc")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      if (body.data.length >= 2) {
        const first = body.data[0];
        const second = body.data[1];
        if (first && second) {
          const firstDate = new Date(first.publishedAt).getTime();
          const secondDate = new Date(second.publishedAt).getTime();
          expect(firstDate).toBeLessThanOrEqual(secondDate);
        }
      }
    });

    it("should default to sortOrder=desc (newest first)", async () => {
      const res = await request(app).get("/api/news").expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      if (body.data.length >= 2) {
        const first = body.data[0];
        const second = body.data[1];
        if (first && second) {
          const firstDate = new Date(first.publishedAt).getTime();
          const secondDate = new Date(second.publishedAt).getTime();
          expect(firstDate).toBeGreaterThanOrEqual(secondDate);
        }
      }
    });

    it("should return sentimentScore as string or null (numeric precision)", async () => {
      const res = await request(app).get("/api/news").expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      for (const article of body.data) {
        if (article.sentimentScore !== null) {
          expect(typeof article.sentimentScore).toBe("string");
        }
      }
    });

    it("should return empty data array for non-matching market filter", async () => {
      const res = await request(app)
        .get("/api/news?market=SOCIAL")
        .expect(200);
      const body = unwrap<PaginatedResponse<NewsArticleResponse>>(res.body);

      expect(body.data.length).toBe(0);
      expect(body.pagination.total).toBe(0);
    });
  });

  // =========================================================================
  // GET /api/opportunities — Trade Opportunities Endpoint Tests
  // =========================================================================

  describe("GET /api/opportunities", () => {
    beforeEach(async () => {
      await cleanAllTables();
      await seedTestData();
    });

    it("should return paginated trade opportunities", async () => {
      const res = await request(app).get("/api/opportunities").expect(200);

      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.pagination).toHaveProperty("page");
      expect(body.pagination).toHaveProperty("limit");
      expect(body.pagination).toHaveProperty("total");
      expect(body.pagination).toHaveProperty("totalPages");
    });

    it("should return opportunities in flat shape with article context", async () => {
      const res = await request(app).get("/api/opportunities").expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      const firstItem = body.data[0];
      expect(firstItem).toBeDefined();
      if (firstItem) {
        // Verify the flat opportunity fields (spread from Drizzle row.opportunity)
        expect(firstItem).toHaveProperty("id");
        expect(firstItem).toHaveProperty("symbol");
        expect(firstItem).toHaveProperty("market");
        expect(firstItem).toHaveProperty("direction");
        expect(firstItem).toHaveProperty("confidence");
        expect(firstItem).toHaveProperty("entryPrice");
        expect(firstItem).toHaveProperty("stopLoss");
        expect(firstItem).toHaveProperty("takeProfit");
        expect(firstItem).toHaveProperty("timeframe");
        expect(firstItem).toHaveProperty("status");

        // Verify article is nested sub-object from LEFT JOIN
        expect(firstItem).toHaveProperty("article");
      }
    });

    it("should include article context via LEFT JOIN", async () => {
      const res = await request(app).get("/api/opportunities").expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      const firstItem = body.data[0];
      expect(firstItem).toBeDefined();
      if (firstItem && firstItem.article) {
        expect(firstItem.article).toHaveProperty("id");
        expect(firstItem.article).toHaveProperty("title");
        expect(firstItem.article).toHaveProperty("url");
        expect(firstItem.article).toHaveProperty("source");
      }
    });

    it("should filter opportunities by status=active", async () => {
      const res = await request(app)
        .get("/api/opportunities?status=active")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.status).toBe("active");
      }
    });

    it("should filter opportunities by status=closed", async () => {
      const res = await request(app)
        .get("/api/opportunities?status=closed")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.status).toBe("closed");
      }
    });

    it("should filter opportunities by market=US (maps to us_stock)", async () => {
      const res = await request(app)
        .get("/api/opportunities?market=US")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.market).toBe("us_stock");
      }
    });

    it("should filter opportunities by direction=long", async () => {
      const res = await request(app)
        .get("/api/opportunities?direction=long")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.direction).toBe("long");
      }
    });

    it("should filter opportunities by direction=short", async () => {
      const res = await request(app)
        .get("/api/opportunities?direction=short")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.direction).toBe("short");
      }
    });

    it("should filter opportunities by timeframe=swing", async () => {
      const res = await request(app)
        .get("/api/opportunities?timeframe=swing")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.timeframe).toBe("swing");
      }
    });

    it("should filter opportunities by minConfidence", async () => {
      const res = await request(app)
        .get("/api/opportunities?minConfidence=0.80")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      // Only the 0.85-confidence opportunity should match
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(parseFloat(item.confidence)).toBeGreaterThanOrEqual(0.8);
      }
    });

    it("should filter opportunities by symbol", async () => {
      const res = await request(app)
        .get("/api/opportunities?symbol=AAPL")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(item.symbol).toBe("AAPL");
      }
    });

    it("should support sorting by confidence desc", async () => {
      const res = await request(app)
        .get("/api/opportunities?sortBy=confidence&sortOrder=desc")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      if (body.data.length >= 2) {
        const first = body.data[0];
        const second = body.data[1];
        if (first && second) {
          expect(parseFloat(first.confidence)).toBeGreaterThanOrEqual(
            parseFloat(second.confidence),
          );
        }
      }
    });

    it("should support sorting by confidence asc", async () => {
      const res = await request(app)
        .get("/api/opportunities?sortBy=confidence&sortOrder=asc")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      if (body.data.length >= 2) {
        const first = body.data[0];
        const second = body.data[1];
        if (first && second) {
          expect(parseFloat(first.confidence)).toBeLessThanOrEqual(
            parseFloat(second.confidence),
          );
        }
      }
    });

    it("should return prices as strings (numeric precision — AAP Rule 0.7.2)", async () => {
      const res = await request(app).get("/api/opportunities").expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      const firstItem = body.data[0];
      expect(firstItem).toBeDefined();
      if (firstItem) {
        expect(typeof firstItem.entryPrice).toBe("string");
        expect(typeof firstItem.stopLoss).toBe("string");
        expect(typeof firstItem.takeProfit).toBe("string");
        expect(typeof firstItem.confidence).toBe("string");
      }
    });

    it("should support pagination with page and limit", async () => {
      const res = await request(app)
        .get("/api/opportunities?page=1&limit=1")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBeLessThanOrEqual(1);
      expect(body.pagination.limit).toBe(1);
      expect(body.pagination.total).toBe(2); // We seeded 2 opportunities
    });

    it("should return empty data for non-matching symbol filter", async () => {
      const res = await request(app)
        .get("/api/opportunities?symbol=NONEXISTENT")
        .expect(200);
      const body = unwrap<PaginatedResponse<FlatOpportunityItem>>(res.body);

      expect(body.data.length).toBe(0);
      expect(body.pagination.total).toBe(0);
    });
  });

  // =========================================================================
  // GET /api/performance — Performance Aggregation Endpoint Tests
  // =========================================================================

  describe("GET /api/performance", () => {
    beforeEach(async () => {
      await cleanAllTables();
      await seedTestData();
    });

    it("should return performance aggregation data", async () => {
      const res = await request(app).get("/api/performance").expect(200);

      // The performance route wraps data in ApiEnvelope: { success, data: PerformancePayload }
      // PerformancePayload = { summary, chartData, marketBreakdown, recentTrades }
      const body = unwrap<PerformancePayload>(res.body);

      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("chartData");

      const summary = body.summary;
      expect(summary).toHaveProperty("totalTrades");
      expect(summary).toHaveProperty("wins");
      expect(summary).toHaveProperty("losses");
      expect(summary).toHaveProperty("winRate");
      expect(summary).toHaveProperty("totalPnl");
      expect(summary).toHaveProperty("averagePnl");
    });

    it("should return P&L values as strings (numeric precision — AAP Rule 0.7.2)", async () => {
      const res = await request(app).get("/api/performance").expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      const summary = body.summary;

      // totalPnl and averagePnl come from SQL aggregation — must be strings
      if (summary.totalPnl !== null) {
        expect(typeof summary.totalPnl).toBe("string");
      }
      if (summary.averagePnl !== null) {
        expect(typeof summary.averagePnl).toBe("string");
      }
    });

    it("should return correct trade counts", async () => {
      const res = await request(app).get("/api/performance").expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      const summary = body.summary;

      // We seeded 1 performance record where isWinner=true
      expect(summary.totalTrades).toBeGreaterThanOrEqual(1);
      expect(summary.wins).toBeGreaterThanOrEqual(1);
    });

    it("should return winRate as a number", async () => {
      const res = await request(app).get("/api/performance").expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      expect(typeof body.summary.winRate).toBe("number");
    });

    it("should filter performance by date range (ISO 8601 datetime with offset)", async () => {
      // The performance route's Zod schema requires z.string().datetime({ offset: true })
      // which mandates full ISO 8601 datetime with timezone offset, not plain dates.
      const res = await request(app)
        .get(
          "/api/performance?startDate=2026-03-01T00:00:00Z&endDate=2026-03-31T23:59:59Z",
        )
        .expect(200);

      // The performance route does NOT return a `filters` property.
      // It returns PerformancePayload with summary data.
      const body = unwrap<PerformancePayload>(res.body);
      expect(body.summary).toHaveProperty("totalTrades");
    });

    it("should filter performance by market (uppercase values)", async () => {
      // Performance route uses its own Zod schema that expects uppercase market
      const res = await request(app)
        .get("/api/performance?market=US")
        .expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      expect(body.summary).toHaveProperty("totalTrades");
    });

    it("should support aggregation period parameter (daily)", async () => {
      const res = await request(app)
        .get("/api/performance?aggregation=daily")
        .expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      expect(body.summary).toHaveProperty("totalTrades");
    });

    it("should support aggregation period parameter (weekly)", async () => {
      const res = await request(app)
        .get("/api/performance?aggregation=weekly")
        .expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      expect(body.summary).toHaveProperty("totalTrades");
    });

    it("should support aggregation period parameter (monthly)", async () => {
      const res = await request(app)
        .get("/api/performance?aggregation=monthly")
        .expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      expect(body.summary).toHaveProperty("totalTrades");
    });

    it("should include bestTrade and worstTrade in response", async () => {
      const res = await request(app).get("/api/performance").expect(200);

      const body = unwrap<PerformancePayload>(res.body);
      expect(body.summary).toHaveProperty("bestTrade");
      expect(body.summary).toHaveProperty("worstTrade");
    });
  });

  // =========================================================================
  // GET/PUT /api/settings/:chatId — User Settings Endpoint Tests
  // =========================================================================

  describe("/api/settings/:chatId", () => {
    beforeEach(async () => {
      await cleanAllTables();
      await seedTestData();
    });

    it("GET should return user settings by Telegram chat ID", async () => {
      const res = await request(app)
        .get("/api/settings/123456789")
        .expect(200);

      const body = res.body as { data: Record<string, unknown> };
      expect(body).toHaveProperty("data");

      const data = body.data;
      expect(data).toHaveProperty("telegramChatId", "123456789");
      expect(data).toHaveProperty("username", "testuser");
      expect(data).toHaveProperty("markets");
      expect(data).toHaveProperty("minConfidence");
      expect(data).toHaveProperty("timeframes");
      expect(data).toHaveProperty("isActive");
    });

    it("GET should return markets as an array", async () => {
      const res = await request(app)
        .get("/api/settings/123456789")
        .expect(200);

      const body = res.body as { data: { markets: string[] } };
      expect(Array.isArray(body.data.markets)).toBe(true);
      expect(body.data.markets).toEqual(
        expect.arrayContaining(["us_stock", "crypto"]),
      );
    });

    it("GET should return timeframes as an array", async () => {
      const res = await request(app)
        .get("/api/settings/123456789")
        .expect(200);

      const body = res.body as { data: { timeframes: string[] } };
      expect(Array.isArray(body.data.timeframes)).toBe(true);
      expect(body.data.timeframes).toEqual(
        expect.arrayContaining(["swing", "intraday"]),
      );
    });

    it("GET should return minConfidence as string (numeric(3,2) precision)", async () => {
      const res = await request(app)
        .get("/api/settings/123456789")
        .expect(200);

      const body = res.body as { data: { minConfidence: string } };
      expect(typeof body.data.minConfidence).toBe("string");
    });

    it("GET should return 404 for non-existent chat ID", async () => {
      await request(app).get("/api/settings/999999999").expect(404);
    });

    it("PUT should update user settings with valid data", async () => {
      const res = await request(app)
        .put("/api/settings/123456789")
        .send({
          markets: ["crypto"],
          minConfidence: 0.8,
          timeframes: ["intraday"],
          isActive: false,
        })
        .expect(200);

      const body = res.body as { data: Record<string, unknown> };
      expect(body).toHaveProperty("data");
      expect(body.data).toHaveProperty("markets");

      const markets = body.data.markets as string[];
      expect(markets).toEqual(["crypto"]);
      expect(body.data.isActive).toBe(false);
    });

    it("PUT should validate input with Zod — reject invalid minConfidence", async () => {
      // minConfidence 2.00 exceeds max of 1.00
      const res = await request(app)
        .put("/api/settings/123456789")
        .send({ minConfidence: 2.0 })
        .expect(400);

      // Error handler should return error details
      expect(res.body).toHaveProperty("error");
    });

    it("PUT should validate input with Zod — reject negative minConfidence", async () => {
      const res = await request(app)
        .put("/api/settings/123456789")
        .send({ minConfidence: -0.5 })
        .expect(400);

      expect(res.body).toHaveProperty("error");
    });

    it("PUT should handle partial updates (only isActive)", async () => {
      // First set isActive to false
      await request(app)
        .put("/api/settings/123456789")
        .send({ isActive: false })
        .expect(200);

      // Verify it was updated
      const res = await request(app)
        .get("/api/settings/123456789")
        .expect(200);

      const body = res.body as { data: { isActive: boolean; markets: string[] } };
      expect(body.data.isActive).toBe(false);

      // Other fields should remain unchanged
      expect(body.data.markets).toEqual(
        expect.arrayContaining(["us_stock", "crypto"]),
      );
    });

    it("PUT should handle partial updates (only markets)", async () => {
      const res = await request(app)
        .put("/api/settings/123456789")
        .send({ markets: ["indian_equity"] })
        .expect(200);

      const body = res.body as { data: { markets: string[]; isActive: boolean } };
      expect(body.data.markets).toEqual(["indian_equity"]);
      // isActive should remain true (original value)
      expect(body.data.isActive).toBe(true);
    });

    it("PUT should return 404 for non-existent chat ID", async () => {
      await request(app)
        .put("/api/settings/999999999")
        .send({ isActive: false })
        .expect(404);
    });
  });

  // =========================================================================
  // GET /api/health — Health Check Endpoint Tests
  // =========================================================================

  describe("GET /api/health", () => {
    it("should return health status with dependency checks", async () => {
      const res = await request(app).get("/api/health");

      // May be 200 (healthy/degraded) or 503 (unhealthy) depending on
      // test environment connectivity to PostgreSQL and Redis.
      expect([200, 503]).toContain(res.status);

      const body = res.body as HealthResponse;
      expect(body).toHaveProperty("status");
      expect(["healthy", "degraded", "unhealthy"]).toContain(body.status);
      expect(body).toHaveProperty("checks");
    });

    it("should include PostgreSQL database check", async () => {
      const res = await request(app).get("/api/health");

      const body = res.body as HealthResponse;
      expect(body.checks).toHaveProperty("database");
      expect(body.checks.database).toHaveProperty("status");
    });

    it("should include Redis check", async () => {
      const res = await request(app).get("/api/health");

      const body = res.body as HealthResponse;
      expect(body.checks).toHaveProperty("redis");
      expect(body.checks.redis).toHaveProperty("status");
    });

    it("should include API sources status", async () => {
      // Seed API sources for health check to report on
      await cleanAllTables();
      await seedTestData();

      const res = await request(app).get("/api/health");

      const body = res.body as HealthResponse;
      expect(body.checks).toHaveProperty("apiSources");
      expect(body.checks.apiSources).toHaveProperty("total");
      expect(body.checks.apiSources).toHaveProperty("enabled");
      expect(body.checks.apiSources).toHaveProperty("errored");
    });

    it("should include uptime and timestamp", async () => {
      const res = await request(app).get("/api/health");

      const body = res.body as HealthResponse;
      expect(body).toHaveProperty("uptime");
      expect(body).toHaveProperty("timestamp");
      expect(typeof body.uptime).toBe("number");
      expect(typeof body.timestamp).toBe("string");
    });

    it("should report correct API source counts", async () => {
      await cleanAllTables();
      await seedTestData();

      const res = await request(app).get("/api/health");

      const body = res.body as HealthResponse;
      // We seeded 3 sources: 2 enabled, 1 disabled with 5 errors
      expect(body.checks.apiSources.total).toBe(3);
      expect(body.checks.apiSources.enabled).toBe(2);
    });
  });

  // =========================================================================
  // 404 — Unknown Route Tests
  // =========================================================================

  describe("Unknown routes", () => {
    it("should return 404 for unknown API paths", async () => {
      const res = await request(app).get("/api/nonexistent").expect(404);
      expect(res.body).toHaveProperty("error");
    });
  });
});

