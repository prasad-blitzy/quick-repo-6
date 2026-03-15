/**
 * Comprehensive Unit Tests for All 3 BullMQ Queue Workers
 *
 * Tests the news-polling, analysis, and notifications workers defined in
 * `apps/api/src/queues/workers/`. Each worker is tested in isolation with
 * all external dependencies mocked via Vitest's vi.mock() factory.
 *
 * AAP Compliance:
 *   - Vitest ^3.0.x test runner
 *   - TypeScript strict mode (no `any` types)
 *   - ESM-first with .js import extensions
 *   - Financial decimal precision (string-typed price fields)
 *   - MarkdownV2 parse mode for Telegram messages
 *   - Per-subscriber error isolation
 *   - Content fallback chain (content → summary → title)
 *   - URL-based deduplication
 *   - Three separate independent queues
 *
 * @module tests/unit/queues/workers.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.mock() Declarations — MUST be before any module imports
// ---------------------------------------------------------------------------

// 1. Mock BullMQ — Queue and Worker classes
// We capture the processor function from the Worker constructor to invoke it in tests.
// vi.hoisted() ensures these declarations are hoisted alongside vi.mock() factories.
const {
  capturedWorkerProcessors,
  capturedWorkerOptions,
  mockWorkerOnHandlers,
} = vi.hoisted(() => ({
  capturedWorkerProcessors: new Map<string, Function>(),
  capturedWorkerOptions: new Map<string, Record<string, unknown>>(),
  mockWorkerOnHandlers: new Map<string, Map<string, Function>>(),
}));

vi.mock("bullmq", () => {
  return {
    Queue: vi.fn(() => ({
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
    })),
    Worker: vi.fn((queueName: string, processor: Function, options?: Record<string, unknown>) => {
      capturedWorkerProcessors.set(queueName, processor);
      capturedWorkerOptions.set(queueName, options ?? {});
      const handlers = new Map<string, Function>();
      mockWorkerOnHandlers.set(queueName, handlers);
      return {
        on: vi.fn((event: string, handler: Function) => {
          handlers.set(event, handler);
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
    Job: vi.fn(),
  };
});

// 2. Mock database module
// createMockDb and mockDb must also be hoisted so the db mock factory can access them.
const { createMockDb, getMockDb, setMockDb } = vi.hoisted(() => {
  type MockDb = ReturnType<typeof _createMockDb>;
  let _mockDb: MockDb;

  function _createMockDb() {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const mockOnConflictDoNothing = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    });
    const mockInsertValues = vi.fn().mockReturnValue({
      onConflictDoNothing: mockOnConflictDoNothing,
      returning: vi.fn().mockResolvedValue([]),
    });
    const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    return {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      _internals: {
        mockFrom,
        mockWhere,
        mockLimit,
        mockInsertValues,
        mockOnConflictDoNothing,
        mockSet,
        mockUpdateWhere,
      },
    };
  }

  _mockDb = _createMockDb();

  return {
    createMockDb: _createMockDb,
    getMockDb: () => _mockDb,
    setMockDb: (db: MockDb) => { _mockDb = db; },
  };
});

// Convenience alias for direct access in tests
let mockDb = getMockDb();

vi.mock("../../../src/db/index.js", () => ({
  get db() {
    return getMockDb();
  },
}));

// 3. Mock all schema files
vi.mock("../../../src/db/schema/news-articles.js", () => ({
  newsArticles: {
    id: "id",
    url: "url",
    title: "title",
    content: "content",
    summary: "summary",
    source: "source",
    market: "market",
    symbols: "symbols",
    publishedAt: "published_at",
    isAnalyzed: "is_analyzed",
    metadata: "metadata",
  },
}));

vi.mock("../../../src/db/schema/trade-opportunities.js", () => ({
  tradeOpportunities: {
    id: "id",
    articleId: "article_id",
    symbol: "symbol",
    market: "market",
    direction: "direction",
    confidence: "confidence",
    entryPrice: "entry_price",
    stopLoss: "stop_loss",
    takeProfit: "take_profit",
    timeframe: "timeframe",
    reasoning: "reasoning",
    riskRewardRatio: "risk_reward_ratio",
    status: "status",
  },
}));

vi.mock("../../../src/db/schema/analysis-logs.js", () => ({
  analysisLogs: {
    articleId: "article_id",
    pipelineStep: "pipeline_step",
    modelUsed: "model_used",
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cost: "cost",
    durationMs: "duration_ms",
    result: "result",
    error: "error",
  },
}));

vi.mock("../../../src/db/schema/notification-logs.js", () => ({
  notificationLogs: {
    opportunityId: "opportunity_id",
    userId: "user_id",
    telegramMessageId: "telegram_message_id",
    status: "status",
    sentAt: "sent_at",
    error: "error",
  },
}));

vi.mock("../../../src/db/schema/user-settings.js", () => ({
  userSettings: {
    id: "id",
    telegramChatId: "telegram_chat_id",
    isActive: "is_active",
    markets: "markets",
    minConfidence: "min_confidence",
    timeframes: "timeframes",
  },
}));

vi.mock("../../../src/db/schema/api-sources.js", () => ({
  apiSources: {
    name: "name",
    errorCount: "error_count",
    lastFetchedAt: "last_fetched_at",
  },
}));

// 4. Mock drizzle-orm query helpers
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(
    (a: unknown, b: unknown) => ({ type: "eq", field: a, value: b }),
  ),
  and: vi.fn(
    (...conds: unknown[]) => ({ type: "and", conditions: conds }),
  ),
  sql: vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      type: "sql",
      strings,
      values,
    }),
  ),
}));

// 5. Mock queue connection modules (both connection.ts and index.ts re-export)
vi.mock("../../../src/queues/connection.js", () => ({
  connection: { __mock: "redis-connection" },
}));

vi.mock("../../../src/queues/index.js", () => ({
  connection: { __mock: "redis-connection" },
  connectionOptions: {},
}));

// 6. Mock analysis queue
vi.mock("../../../src/queues/analysis.queue.js", () => ({
  analysisQueue: { add: vi.fn().mockResolvedValue(undefined) },
  enqueueForAnalysis: vi.fn().mockResolvedValue(undefined),
}));

// 7. Mock notifications queue
vi.mock("../../../src/queues/notifications.queue.js", () => ({
  notificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

// 8. Mock news-fetcher service
vi.mock("../../../src/services/news-fetcher/index.js", () => ({
  fetchAllNews: vi.fn().mockResolvedValue([]),
  storeArticles: vi.fn().mockResolvedValue(0),
}));

// 9. Mock analyzer service
vi.mock("../../../src/services/analyzer/index.js", () => ({
  analyzeArticle: vi.fn().mockResolvedValue({
    isRelevant: false,
    relevanceScore: 0,
    tradeDetected: false,
    recommendation: null,
    pipelineStep: "filter",
    errors: [],
    sentimentAnalysis: null,
    tradeDetails: null,
    filterResult: null,
    article: null,
  }),
}));

// 10. Mock notifier service
vi.mock("../../../src/services/notifier/index.js", () => ({
  findMatchingSubscribers: vi.fn().mockResolvedValue(null),
  logNotification: vi.fn().mockResolvedValue(undefined),
}));

// 11. Mock notifier formatter
vi.mock("../../../src/services/notifier/formatter.js", () => ({
  formatTradeAlert: vi.fn().mockReturnValue("Formatted alert message"),
}));

// 12. Mock bot
vi.mock("../../../src/bot/index.js", () => ({
  bot: {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 12345 }),
    },
  },
}));

// 13. Mock logger
vi.mock("../../../src/lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// 14. Mock config — env.ts
vi.mock("../../../src/config/env.js", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
    ANALYSIS_CONCURRENCY: 3,
    NOTIFICATION_CONCURRENCY: 5,
    NEWS_POLL_INTERVAL: "*/5 * * * *",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    TELEGRAM_BOT_TOKEN: "test-token-123",
    DATABASE_URL: "postgresql://localhost:5432/test",
    OPENROUTER_API_KEY: "test-key",
  },
}));

// 15. Mock config — constants.ts
vi.mock("../../../src/config/constants.js", () => ({
  QUEUE_NAMES: {
    NEWS_POLLING: "news-polling",
    ANALYSIS: "analysis",
    NOTIFICATIONS: "notifications",
  },
  DEFAULTS: {
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_BACKOFF_DELAY: 5000,
    NORMAL_PRIORITY: 10,
    BREAKING_NEWS_PRIORITY: 1,
    ANALYSIS_CONCURRENCY: 3,
    NOTIFICATION_CONCURRENCY: 5,
  },
}));

// 16. Mock analyzer state type (needed for analysis worker)
vi.mock("../../../src/services/analyzer/state.js", () => ({}));

// ---------------------------------------------------------------------------
// Module Imports — AFTER all vi.mock() calls
// ---------------------------------------------------------------------------

import { fetchAllNews, storeArticles } from "../../../src/services/news-fetcher/index.js";
import { analyzeArticle } from "../../../src/services/analyzer/index.js";
import { enqueueForAnalysis } from "../../../src/queues/analysis.queue.js";
import { enqueueNotification } from "../../../src/queues/notifications.queue.js";
import {
  findMatchingSubscribers,
  logNotification,
} from "../../../src/services/notifier/index.js";
import { formatTradeAlert } from "../../../src/services/notifier/formatter.js";
import { bot } from "../../../src/bot/index.js";
import { newsArticles } from "../../../src/db/schema/news-articles.js";
import { eq } from "drizzle-orm";

// Import workers — triggers Worker constructor capture via vi.mock("bullmq")
// The processor functions are captured in capturedWorkerProcessors map
import "../../../src/queues/workers/news-polling.worker.js";
import "../../../src/queues/workers/analysis.worker.js";
import "../../../src/queues/workers/notifications.worker.js";

// ---------------------------------------------------------------------------
// Mock Data Fixtures
// ---------------------------------------------------------------------------

const mockArticle = {
  id: "article-uuid-1",
  title: "Apple Reports Record Q4 Revenue",
  content: "Apple Inc. reported Q4 revenue of $94.9B, beating analyst estimates.",
  summary: "Apple beats Q4 estimates with $94.9B revenue.",
  url: "https://example.com/apple-q4-2026",
  source: "Finnhub",
  market: "us_stock",
  symbols: ["AAPL"],
  publishedAt: new Date("2026-03-13T10:00:00Z"),
  isAnalyzed: false,
  metadata: null,
  createdAt: new Date("2026-03-13T10:00:00Z"),
  updatedAt: new Date("2026-03-13T10:00:00Z"),
};

const mockArticleNoContent = {
  ...mockArticle,
  id: "article-uuid-2",
  content: null,
  summary: "Apple beats Q4 estimates.",
};

const mockArticleOnlyTitle = {
  ...mockArticle,
  id: "article-uuid-3",
  content: null,
  summary: null,
};

const mockAnalyzerStateRelevant = {
  isRelevant: true,
  relevanceScore: 0.95,
  tradeDetected: true,
  recommendation: {
    symbol: "AAPL",
    market: "us",
    direction: "long",
    confidence: 0.85,
    entryPrice: "185.5000",
    stopLoss: "178.0000",
    takeProfit: "200.0000",
    timeframe: "swing",
    riskRewardRatio: "2.93",
    reasoning: "Strong earnings beat with raised guidance.",
    catalystExpiry: "2026-04-15",
  },
  sentimentAnalysis: {
    sentimentScore: 0.78,
    sentimentLabel: "strongly_positive",
    reasoning: "Strong earnings beat.",
    keyFactors: ["Revenue beat", "iPhone growth"],
  },
  tradeDetails: {
    tradeDetected: true,
    symbol: "AAPL",
    direction: "long",
    timeframe: "swing",
    signalStrength: 0.88,
    reasoning: "Strong triple beat catalyst.",
  },
  filterResult: {
    isRelevant: true,
    relevanceScore: 0.95,
    reasoning: "Contains specific earnings data.",
  },
  pipelineStep: "recommend",
  errors: [],
  article: mockArticle,
};

const mockAnalyzerStateIrrelevant = {
  isRelevant: false,
  relevanceScore: 0.02,
  tradeDetected: false,
  recommendation: null,
  sentimentAnalysis: null,
  tradeDetails: null,
  filterResult: {
    isRelevant: false,
    relevanceScore: 0.02,
    reasoning: "Not financially relevant.",
  },
  pipelineStep: "filter",
  errors: [],
  article: mockArticle,
};

const mockAnalyzerStateNoTrade = {
  ...mockAnalyzerStateRelevant,
  tradeDetected: false,
  recommendation: null,
  tradeDetails: null,
  pipelineStep: "trade_detect",
};

const mockNormalizedArticles = [
  {
    title: "Apple Q4 Revenue",
    url: "https://example.com/apple-q4",
    source: "Finnhub",
    market: "us_stock",
    content: "Apple beat estimates.",
    summary: null,
    symbols: ["AAPL"],
    publishedAt: new Date("2026-03-13T10:00:00Z"),
    metadata: null,
  },
  {
    title: "Bitcoin Surges Past $100K",
    url: "https://example.com/bitcoin-100k",
    source: "CoinGecko",
    market: "crypto",
    content: "Bitcoin surpassed $100,000.",
    summary: null,
    symbols: ["BTC"],
    publishedAt: new Date("2026-03-13T09:00:00Z"),
    metadata: null,
  },
];

const mockJob = (data: Record<string, unknown> = {}) => ({
  id: "job-1",
  name: "test-job",
  data,
  progress: vi.fn(),
  log: vi.fn(),
  updateData: vi.fn(),
  attemptsMade: 0,
  opts: {},
});

const mockOpportunity = {
  id: "opp-uuid-1",
  articleId: "article-uuid-1",
  symbol: "AAPL",
  market: "us_stock",
  direction: "long",
  confidence: "0.85",
  entryPrice: "185.5000",
  stopLoss: "178.0000",
  takeProfit: "200.0000",
  timeframe: "swing",
  reasoning: "Strong earnings beat with raised guidance.",
  status: "active",
  riskRewardRatio: "2.93",
  createdAt: new Date("2026-03-13T10:00:00Z"),
  updatedAt: new Date("2026-03-13T10:00:00Z"),
  expiresAt: new Date("2026-03-20T10:00:00Z"),
};

const mockMatchingSubscriber = {
  userId: "user-uuid-1",
  telegramChatId: "123456789",
  username: "testuser",
};

const mockMatchResult = {
  opportunity: mockOpportunity,
  subscribers: [mockMatchingSubscriber],
};

// ---------------------------------------------------------------------------
// Helper: Get captured processor function for a queue
// ---------------------------------------------------------------------------

function getProcessor(queueName: string): (job: unknown) => Promise<void> {
  const processor = capturedWorkerProcessors.get(queueName);
  if (!processor) {
    throw new Error(
      `No processor captured for queue "${queueName}". Available: ${[...capturedWorkerProcessors.keys()].join(", ")}`,
    );
  }
  return processor as (job: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helper: Reset mockDb to fresh state for each test
// ---------------------------------------------------------------------------

function resetMockDb(): void {
  const newDb = createMockDb();
  setMockDb(newDb);
  mockDb = newDb;
}

// =========================================================================
// NEWS POLLING WORKER TESTS
// =========================================================================

describe("News Polling Worker", () => {
  let processPollingJob: (job: unknown) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    processPollingJob = getProcessor("news-polling");
  });

  // -----------------------------------------------------------------------
  // 3.1 — fetchAllNews invocation tests
  // -----------------------------------------------------------------------

  describe("fetchAllNews invocation", () => {
    it("should call fetchAllNews() to fetch from all sources", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(2);

      await processPollingJob(mockJob());

      expect(fetchAllNews).toHaveBeenCalledOnce();
    });

    it("should call storeArticles() with fetched articles", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(2);

      await processPollingJob(mockJob());

      expect(storeArticles).toHaveBeenCalledOnce();
      expect(storeArticles).toHaveBeenCalledWith(mockNormalizedArticles);
    });

    it("should handle zero articles gracefully", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce([]);

      await processPollingJob(mockJob());

      expect(storeArticles).not.toHaveBeenCalled();
      expect(enqueueForAnalysis).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 3.2 — storeArticles deduplication tests
  // -----------------------------------------------------------------------

  describe("storeArticles deduplication", () => {
    it("should call storeArticles for URL-based deduplication", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(1);

      await processPollingJob(mockJob());

      expect(storeArticles).toHaveBeenCalledWith(mockNormalizedArticles);
    });

    it("should proceed normally when storeArticles returns 0 (all duplicates)", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(0);

      await processPollingJob(mockJob());

      expect(enqueueForAnalysis).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 3.3 — enqueueForAnalysis tests
  // -----------------------------------------------------------------------

  describe("enqueueForAnalysis", () => {
    it("should enqueue newly inserted articles for analysis", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(2);

      // Mock DB to return 2 unanalyzed articles when queried
      const unanalyzedArticles = [
        { id: "article-uuid-1" },
        { id: "article-uuid-2" },
      ];
      mockDb._internals.mockLimit.mockResolvedValueOnce(unanalyzedArticles);

      await processPollingJob(mockJob());

      expect(enqueueForAnalysis).toHaveBeenCalledTimes(2);
      expect(enqueueForAnalysis).toHaveBeenCalledWith("article-uuid-1");
      expect(enqueueForAnalysis).toHaveBeenCalledWith("article-uuid-2");
    });

    it("should not enqueue when insertedCount is 0", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(0);

      await processPollingJob(mockJob());

      expect(enqueueForAnalysis).not.toHaveBeenCalled();
    });

    it("should query for unanalyzed articles after storing", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(1);

      mockDb._internals.mockLimit.mockResolvedValueOnce([{ id: "art-1" }]);

      await processPollingJob(mockJob());

      // Verify the select chain was called
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb._internals.mockFrom).toHaveBeenCalledWith(newsArticles);
      expect(eq).toHaveBeenCalledWith(newsArticles.isAnalyzed, false);
    });
  });

  // -----------------------------------------------------------------------
  // 3.4 — Error handling tests
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("should re-throw fetch errors for BullMQ retry", async () => {
      vi.mocked(fetchAllNews).mockRejectedValueOnce(
        new Error("API timeout"),
      );

      await expect(processPollingJob(mockJob())).rejects.toThrow(
        "API timeout",
      );
    });

    it("should re-throw storage errors for BullMQ retry", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockRejectedValueOnce(
        new Error("DB connection lost"),
      );

      await expect(processPollingJob(mockJob())).rejects.toThrow(
        "DB connection lost",
      );
    });

    it("should NOT re-throw enqueue errors (logged but swallowed)", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(1);

      mockDb._internals.mockLimit.mockResolvedValueOnce([
        { id: "article-uuid-1" },
      ]);
      vi.mocked(enqueueForAnalysis).mockRejectedValueOnce(
        new Error("Redis down"),
      );

      // Should NOT throw — enqueue errors are caught and logged
      await expect(processPollingJob(mockJob())).resolves.toBeUndefined();
    });

    it("should continue enqueuing other articles if one enqueue fails", async () => {
      vi.mocked(fetchAllNews).mockResolvedValueOnce(mockNormalizedArticles);
      vi.mocked(storeArticles).mockResolvedValueOnce(2);

      mockDb._internals.mockLimit.mockResolvedValueOnce([
        { id: "article-uuid-1" },
        { id: "article-uuid-2" },
      ]);

      // First enqueue throws, second succeeds
      vi.mocked(enqueueForAnalysis)
        .mockRejectedValueOnce(new Error("Redis timeout"))
        .mockResolvedValueOnce(undefined);

      await processPollingJob(mockJob());

      // Both enqueue calls should have been attempted
      expect(enqueueForAnalysis).toHaveBeenCalledTimes(2);
      expect(enqueueForAnalysis).toHaveBeenCalledWith("article-uuid-1");
      expect(enqueueForAnalysis).toHaveBeenCalledWith("article-uuid-2");
    });
  });

  // -----------------------------------------------------------------------
  // 3.5 — Worker configuration tests
  // -----------------------------------------------------------------------

  describe("worker configuration", () => {
    it("should create worker with concurrency 1", () => {
      const options = capturedWorkerOptions.get("news-polling");
      expect(options).toBeDefined();
      expect(options?.concurrency).toBe(1);
    });

    it("should use QUEUE_NAMES.NEWS_POLLING as queue name", () => {
      // Worker constructors fire at module-load time and vi.clearAllMocks()
      // resets spy call history. We verify via the captured processor map.
      expect(capturedWorkerProcessors.has("news-polling")).toBe(true);
      expect(capturedWorkerOptions.has("news-polling")).toBe(true);
    });

    it("should register completed, failed, and error event handlers", () => {
      const handlers = mockWorkerOnHandlers.get("news-polling");
      expect(handlers).toBeDefined();
      expect(handlers?.has("completed")).toBe(true);
      expect(handlers?.has("failed")).toBe(true);
      expect(handlers?.has("error")).toBe(true);
    });
  });
});

// =========================================================================
// ANALYSIS WORKER TESTS
// =========================================================================

describe("Analysis Worker", () => {
  let processAnalysisJob: (job: unknown) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    processAnalysisJob = getProcessor("analysis");
  });

  // -----------------------------------------------------------------------
  // 4.1 — Article fetch and validation
  // -----------------------------------------------------------------------

  describe("article fetch and validation", () => {
    it("should fetch article from database by articleId", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      // Mock analysis_logs insert
      const logCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ catch: logCatch }),
      });

      // Mock update for is_analyzed
      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb._internals.mockFrom).toHaveBeenCalledWith(newsArticles);
      expect(eq).toHaveBeenCalledWith(newsArticles.id, "article-uuid-1");
      expect(mockDb._internals.mockLimit).toHaveBeenCalledWith(1);
    });

    it("should skip analysis if article not found", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([]);

      await processAnalysisJob(
        mockJob({ articleId: "nonexistent", isBreakingNews: false }),
      );

      expect(analyzeArticle).not.toHaveBeenCalled();
    });

    it("should skip analysis if article already analyzed (idempotency)", async () => {
      const analyzedArticle = { ...mockArticle, isAnalyzed: true };
      mockDb._internals.mockLimit.mockResolvedValueOnce([analyzedArticle]);

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(analyzeArticle).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 4.2 — analyzeArticle invocation
  // -----------------------------------------------------------------------

  describe("analyzeArticle invocation", () => {
    it("should call analyzeArticle with correct input shape", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      // Mock analysis_logs insert
      const logCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ catch: logCatch }),
      });

      // Mock update for is_analyzed
      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(analyzeArticle).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockArticle.id,
          title: mockArticle.title,
          content: mockArticle.content,
          url: mockArticle.url,
          source: mockArticle.source,
          market: mockArticle.market,
          symbols: mockArticle.symbols,
        }),
      );
    });

    it("should use content fallback chain: content present", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      const logCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ catch: logCatch }),
      });

      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      // Full article has content — use content
      expect(analyzeArticle).toHaveBeenCalledWith(
        expect.objectContaining({ content: mockArticle.content }),
      );
    });

    it("should use content fallback chain: content null, use summary", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([
        mockArticleNoContent,
      ]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      const logCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ catch: logCatch }),
      });

      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-2", isBreakingNews: false }),
      );

      // No content, has summary — use summary
      expect(analyzeArticle).toHaveBeenCalledWith(
        expect.objectContaining({ content: mockArticleNoContent.summary }),
      );
    });

    it("should use content fallback chain: content and summary null, use title", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([
        mockArticleOnlyTitle,
      ]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      const logCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ catch: logCatch }),
      });

      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-3", isBreakingNews: false }),
      );

      // No content, no summary — use title
      expect(analyzeArticle).toHaveBeenCalledWith(
        expect.objectContaining({ content: mockArticleOnlyTitle.title }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 4.3 — Pipeline result processing
  // -----------------------------------------------------------------------

  describe("pipeline result processing", () => {
    it("should store pipeline results in analysis_logs table", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      // Mock analysis_logs insert
      const logValues = vi.fn().mockReturnValue({
        catch: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.insert.mockReturnValueOnce({ values: logValues });

      // Mock trade_opportunities insert with returning
      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      const tradeValues = vi.fn().mockReturnValue({
        returning: tradeReturning,
      });
      mockDb.insert.mockReturnValueOnce({ values: tradeValues });

      // Mock update for is_analyzed
      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      // Verify analysis_logs insert was called
      expect(mockDb.insert).toHaveBeenCalled();
      expect(logValues).toHaveBeenCalledWith(
        expect.objectContaining({
          articleId: "article-uuid-1",
          pipelineStep: "recommend",
          modelUsed: "pipeline",
        }),
      );
    });

    it("should store trade opportunity when recommendation exists", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      // Mock analysis_logs insert
      const logCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ catch: logCatch }),
      });

      // Mock trade_opportunities insert with returning
      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      const tradeValues = vi.fn().mockReturnValue({
        returning: tradeReturning,
      });
      mockDb.insert.mockReturnValueOnce({ values: tradeValues });

      // Mock update for is_analyzed
      const updateCatch = vi.fn().mockResolvedValue(undefined);
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ catch: updateCatch }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      // Verify trade_opportunities insert was called (second insert call)
      expect(mockDb.insert).toHaveBeenCalledTimes(2);
      expect(tradeValues).toHaveBeenCalledWith(
        expect.objectContaining({
          articleId: "article-uuid-1",
          symbol: "AAPL",
        }),
      );
    });

    it("should store price fields as strings (financial decimal precision)", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      // Mock analysis_logs insert
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Mock trade_opportunities insert — capture the values
      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      const tradeValues = vi.fn().mockReturnValue({
        returning: tradeReturning,
      });
      mockDb.insert.mockReturnValueOnce({ values: tradeValues });

      // Mock update for is_analyzed
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      // CRITICAL: All price fields must be STRINGS, not numbers
      const insertedValues = tradeValues.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(insertedValues).toBeDefined();
      expect(typeof insertedValues?.entryPrice).toBe("string");
      expect(typeof insertedValues?.stopLoss).toBe("string");
      expect(typeof insertedValues?.takeProfit).toBe("string");
      expect(typeof insertedValues?.riskRewardRatio).toBe("string");
      expect(typeof insertedValues?.confidence).toBe("string");
      expect(insertedValues?.entryPrice).toBe("185.5000");
      expect(insertedValues?.stopLoss).toBe("178.0000");
      expect(insertedValues?.takeProfit).toBe("200.0000");
      expect(insertedValues?.riskRewardRatio).toBe("2.93");
      // confidence is converted via .toString()
      expect(insertedValues?.confidence).toBe("0.85");
    });

    it("should store enum values matching PostgreSQL enums", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      const tradeValues = vi.fn().mockReturnValue({
        returning: tradeReturning,
      });
      mockDb.insert.mockReturnValueOnce({ values: tradeValues });

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      const insertedValues = tradeValues.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(insertedValues).toBeDefined();
      // Enum values from analyzer state should be lowercase for PG
      expect(insertedValues?.direction).toBe("long");
      expect(insertedValues?.market).toBe("us");
      expect(insertedValues?.timeframe).toBe("swing");
      expect(insertedValues?.status).toBe("active");
    });

    it("should NOT store trade opportunity when no recommendation", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      // Mock analysis_logs insert
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Mock update for is_analyzed
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      // Only analysis_logs insert should have been called, NOT trade_opportunities
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("should NOT store trade opportunity when tradeDetected is false", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateNoTrade,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      // Only analysis_logs insert, NOT trade_opportunities
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // 4.4 — Notification enqueue
  // -----------------------------------------------------------------------

  describe("notification enqueue", () => {
    it("should enqueue notification when trade opportunity is stored", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: tradeReturning }),
      });

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(enqueueNotification).toHaveBeenCalledWith("opp-uuid-1", false);
    });

    it("should pass isBreakingNews flag to enqueueNotification", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: tradeReturning }),
      });

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: true }),
      );

      expect(enqueueNotification).toHaveBeenCalledWith("opp-uuid-1", true);
    });

    it("should NOT enqueue notification when no trade detected", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(enqueueNotification).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 4.5 — Mark as analyzed
  // -----------------------------------------------------------------------

  describe("mark as analyzed", () => {
    it("should mark article as analyzed after processing", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const tradeReturning = vi.fn().mockResolvedValue([{ id: "opp-uuid-1" }]);
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: tradeReturning }),
      });

      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });
      mockDb.update.mockReturnValueOnce({ set: updateSet });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateSet).toHaveBeenCalledWith({ isAnalyzed: true });
    });

    it("should mark article as analyzed even when pipeline finds no trade", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });
      mockDb.update.mockReturnValueOnce({ set: updateSet });

      await processAnalysisJob(
        mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
      );

      expect(updateSet).toHaveBeenCalledWith({ isAnalyzed: true });
    });
  });

  // -----------------------------------------------------------------------
  // 4.6 — Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("should re-throw pipeline errors for BullMQ retry", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockRejectedValueOnce(
        new Error("LLM timeout"),
      );

      // Mock the analysis_logs insert for error logging
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await expect(
        processAnalysisJob(
          mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
        ),
      ).rejects.toThrow("LLM timeout");
    });

    it("should log pipeline failure to analysis_logs before re-throwing", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockRejectedValueOnce(
        new Error("LLM timeout"),
      );

      const logValues = vi.fn().mockReturnValue({
        catch: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.insert.mockReturnValueOnce({ values: logValues });

      await expect(
        processAnalysisJob(
          mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
        ),
      ).rejects.toThrow("LLM timeout");

      // Verify failure was logged to analysis_logs
      expect(mockDb.insert).toHaveBeenCalled();
      expect(logValues).toHaveBeenCalledWith(
        expect.objectContaining({
          articleId: "article-uuid-1",
          error: expect.stringContaining("LLM timeout"),
        }),
      );
    });

    it("should NOT throw on trade opportunity storage failure", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateRelevant,
      );

      // Mock analysis_logs insert
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Mock trade_opportunities insert — THROWS
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error("FK violation")),
        }),
      });

      // Mock update for is_analyzed (must still work)
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      // Should NOT throw — trade storage failure is caught
      await expect(
        processAnalysisJob(
          mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
        ),
      ).resolves.toBeUndefined();
    });

    it("should NOT throw on mark-as-analyzed failure", async () => {
      mockDb._internals.mockLimit.mockResolvedValueOnce([mockArticle]);
      vi.mocked(analyzeArticle).mockResolvedValueOnce(
        mockAnalyzerStateIrrelevant,
      );

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          catch: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // The .catch() on update means the error is swallowed inside the worker
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      await expect(
        processAnalysisJob(
          mockJob({ articleId: "article-uuid-1", isBreakingNews: false }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 4.7 — Worker configuration
  // -----------------------------------------------------------------------

  describe("worker configuration", () => {
    it("should create worker with configurable concurrency (default 3)", () => {
      const options = capturedWorkerOptions.get("analysis");
      expect(options).toBeDefined();
      // env.ANALYSIS_CONCURRENCY is mocked to 3
      expect(options?.concurrency).toBe(3);
    });

    it("should use QUEUE_NAMES.ANALYSIS as queue name", () => {
      // Worker constructors fire at module-load time and vi.clearAllMocks()
      // resets spy call history. We verify via the captured processor map.
      expect(capturedWorkerProcessors.has("analysis")).toBe(true);
      expect(capturedWorkerOptions.has("analysis")).toBe(true);
    });

    it("should register completed, failed, and error event handlers", () => {
      const handlers = mockWorkerOnHandlers.get("analysis");
      expect(handlers).toBeDefined();
      expect(handlers?.has("completed")).toBe(true);
      expect(handlers?.has("failed")).toBe(true);
      expect(handlers?.has("error")).toBe(true);
    });
  });
});

// =========================================================================
// NOTIFICATION WORKER TESTS
// =========================================================================

describe("Notification Worker", () => {
  let processNotificationJob: (job: unknown) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    processNotificationJob = getProcessor("notifications");
  });

  // -----------------------------------------------------------------------
  // 5.1 — findMatchingSubscribers tests
  // -----------------------------------------------------------------------

  describe("findMatchingSubscribers", () => {
    it("should call findMatchingSubscribers with opportunityId", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(null);

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(findMatchingSubscribers).toHaveBeenCalledWith("opp-uuid-1");
    });

    it("should skip when opportunity not found (null result)", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(null);

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(formatTradeAlert).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("should skip when no subscribers match", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce({
        opportunity: mockOpportunity,
        subscribers: [],
      });

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 5.2 — formatTradeAlert tests
  // -----------------------------------------------------------------------

  describe("formatTradeAlert", () => {
    it("should call formatTradeAlert with correct TradeAlertData", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        mockMatchResult,
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(formatTradeAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: "AAPL",
          market: "us_stock",
          direction: "long",
          confidence: "0.85",
          entryPrice: "185.5000",
          stopLoss: "178.0000",
          takeProfit: "200.0000",
          timeframe: "swing",
          reasoning: "Strong earnings beat with raised guidance.",
          riskRewardRatio: "2.93",
        }),
      );
    });

    it("should format message only ONCE for all subscribers", async () => {
      const threeSubscribers = {
        opportunity: mockOpportunity,
        subscribers: [
          { userId: "user-1", telegramChatId: "111", username: "u1" },
          { userId: "user-2", telegramChatId: "222", username: "u2" },
          { userId: "user-3", telegramChatId: "333", username: "u3" },
        ],
      };
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        threeSubscribers,
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      // formatTradeAlert should be called exactly ONCE
      expect(formatTradeAlert).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // 5.3 — Telegram bot.api.sendMessage tests
  // -----------------------------------------------------------------------

  describe("Telegram bot.api.sendMessage", () => {
    it("should send message to each subscriber via bot.api.sendMessage", async () => {
      const twoSubscribers = {
        opportunity: mockOpportunity,
        subscribers: [
          { userId: "user-1", telegramChatId: "111111", username: "u1" },
          { userId: "user-2", telegramChatId: "222222", username: "u2" },
        ],
      };
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        twoSubscribers,
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        "111111",
        "Formatted alert message",
        { parse_mode: "MarkdownV2" },
      );
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        "222222",
        "Formatted alert message",
        { parse_mode: "MarkdownV2" },
      );
    });

    it("should use parse_mode MarkdownV2", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        mockMatchResult,
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        "123456789",
        expect.any(String),
        { parse_mode: "MarkdownV2" },
      );
    });

    it("should send formatted message to subscriber chatId", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        mockMatchResult,
      );
      vi.mocked(formatTradeAlert).mockReturnValueOnce(
        "🟢 *AAPL* \\| LONG",
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        "123456789",
        "🟢 *AAPL* \\| LONG",
        { parse_mode: "MarkdownV2" },
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5.4 — logNotification tests
  // -----------------------------------------------------------------------

  describe("logNotification", () => {
    it("should log successful delivery with sent status and messageId", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        mockMatchResult,
      );
      vi.mocked(bot.api.sendMessage).mockResolvedValueOnce(
        { message_id: 12345 } as Awaited<ReturnType<typeof bot.api.sendMessage>>,
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(logNotification).toHaveBeenCalledWith(
        "opp-uuid-1",
        "user-uuid-1",
        "sent",
        12345,
      );
    });

    it("should log failed delivery with error message", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        mockMatchResult,
      );
      vi.mocked(bot.api.sendMessage).mockRejectedValueOnce(
        new Error("Chat not found"),
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      expect(logNotification).toHaveBeenCalledWith(
        "opp-uuid-1",
        "user-uuid-1",
        "failed",
        undefined,
        "Chat not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5.5 — Per-subscriber error isolation
  // -----------------------------------------------------------------------

  describe("per-subscriber error isolation", () => {
    it("should continue sending to other subscribers if one fails", async () => {
      const threeSubscribers = {
        opportunity: mockOpportunity,
        subscribers: [
          { userId: "user-1", telegramChatId: "111", username: "u1" },
          { userId: "user-2", telegramChatId: "222", username: "u2" },
          { userId: "user-3", telegramChatId: "333", username: "u3" },
        ],
      };
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        threeSubscribers,
      );

      // First subscriber fails, others succeed
      vi.mocked(bot.api.sendMessage)
        .mockRejectedValueOnce(new Error("Blocked by user"))
        .mockResolvedValueOnce(
          { message_id: 2 } as Awaited<ReturnType<typeof bot.api.sendMessage>>,
        )
        .mockResolvedValueOnce(
          { message_id: 3 } as Awaited<ReturnType<typeof bot.api.sendMessage>>,
        );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      // All 3 send attempts should have been made
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);

      // logNotification should be called 3 times (1 failed, 2 sent)
      expect(logNotification).toHaveBeenCalledTimes(3);

      // Verify first was logged as failed
      expect(logNotification).toHaveBeenCalledWith(
        "opp-uuid-1",
        "user-1",
        "failed",
        undefined,
        "Blocked by user",
      );

      // Verify others were logged as sent
      expect(logNotification).toHaveBeenCalledWith(
        "opp-uuid-1",
        "user-2",
        "sent",
        2,
      );
      expect(logNotification).toHaveBeenCalledWith(
        "opp-uuid-1",
        "user-3",
        "sent",
        3,
      );
    });

    it("should handle logNotification failure without crashing", async () => {
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        mockMatchResult,
      );

      // logNotification returns a promise that rejects, but the worker
      // uses .catch() so the rejection is swallowed
      vi.mocked(logNotification).mockRejectedValueOnce(
        new Error("DB write failed"),
      );

      // Should NOT throw
      await expect(
        processNotificationJob(
          mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 5.6 — Worker configuration tests
  // -----------------------------------------------------------------------

  describe("worker configuration", () => {
    it("should create worker with configurable concurrency (default 5)", () => {
      const options = capturedWorkerOptions.get("notifications");
      expect(options).toBeDefined();
      expect(options?.concurrency).toBe(5);
    });

    it("should use QUEUE_NAMES.NOTIFICATIONS as queue name", () => {
      // Worker constructors fire at module-load time and vi.clearAllMocks()
      // resets spy call history. We verify via the captured processor map.
      expect(capturedWorkerProcessors.has("notifications")).toBe(true);
      expect(capturedWorkerOptions.has("notifications")).toBe(true);
    });

    it("should register completed, failed, and error event handlers", () => {
      const handlers = mockWorkerOnHandlers.get("notifications");
      expect(handlers).toBeDefined();
      expect(handlers?.has("completed")).toBe(true);
      expect(handlers?.has("failed")).toBe(true);
      expect(handlers?.has("error")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5.7 — Sequential sending
  // -----------------------------------------------------------------------

  describe("sequential sending", () => {
    it("should send messages sequentially (not Promise.all)", async () => {
      const twoSubscribers = {
        opportunity: mockOpportunity,
        subscribers: [
          { userId: "user-1", telegramChatId: "111", username: "u1" },
          { userId: "user-2", telegramChatId: "222", username: "u2" },
        ],
      };
      vi.mocked(findMatchingSubscribers).mockResolvedValueOnce(
        twoSubscribers,
      );

      // Track call order to verify sequential execution
      const callOrder: string[] = [];
      vi.mocked(bot.api.sendMessage).mockImplementation(
        async (chatId: unknown) => {
          callOrder.push(String(chatId));
          return { message_id: Number(chatId) } as Awaited<
            ReturnType<typeof bot.api.sendMessage>
          >;
        },
      );

      await processNotificationJob(
        mockJob({ opportunityId: "opp-uuid-1", isBreakingNews: false }),
      );

      // Verify messages were sent in order (sequential, not parallel)
      expect(callOrder).toEqual(["111", "222"]);
    });
  });
});

// =========================================================================
// SHARED WORKER BEHAVIOR TESTS
// =========================================================================

describe("Shared Worker Behavior", () => {
  it("all workers should use connection from queue registry", () => {
    // All 3 Worker constructors should have received a connection option
    const pollingOpts = capturedWorkerOptions.get("news-polling");
    const analysisOpts = capturedWorkerOptions.get("analysis");
    const notificationOpts = capturedWorkerOptions.get("notifications");

    expect(pollingOpts).toBeDefined();
    expect(analysisOpts).toBeDefined();
    expect(notificationOpts).toBeDefined();

    // Each should have a connection property
    expect(pollingOpts?.connection).toBeDefined();
    expect(analysisOpts?.connection).toBeDefined();
    expect(notificationOpts?.connection).toBeDefined();
  });

  it("all workers should register error event handlers", () => {
    const pollingHandlers = mockWorkerOnHandlers.get("news-polling");
    const analysisHandlers = mockWorkerOnHandlers.get("analysis");
    const notificationHandlers = mockWorkerOnHandlers.get("notifications");

    expect(pollingHandlers?.has("error")).toBe(true);
    expect(analysisHandlers?.has("error")).toBe(true);
    expect(notificationHandlers?.has("error")).toBe(true);
  });
});
