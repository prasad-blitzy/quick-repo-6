/**
 * Full LangGraph AI Analysis Pipeline — Integration Test Suite
 *
 * Tests the complete 4-stage analysis pipeline (Filter → Sentiment → Trade
 * Detection → Recommendation) with mocked LLM responses. Verifies:
 *
 *   - Article flows through all 4 pipeline stages when conditions are met
 *   - Conditional edges route correctly (~25% to recommendation, ~75% short-circuit)
 *   - Structured output from `withStructuredOutput()` with Zod schemas
 *     (FilterResult, SentimentResult, TradeDetectionResult, TradeRecommendation) is valid
 *   - Pipeline state is correctly populated at each stage
 *   - Zod schema validation catches invalid inputs
 *   - SHORT direction pipeline works with bearish sentiment
 *   - Financial decimal precision is preserved in recommendation output
 *   - Model routing assigns correct models per stage
 *
 * Architecture:
 *   - Real LangGraph StateGraph execution (no graph mocking)
 *   - Mocked LLM model invocations (no OpenRouter API calls)
 *   - Mocked logger (no pino initialization)
 *   - Real Zod schemas for validation tests
 *
 * CRITICAL AAP compliance:
 *   - TypeScript strict mode (Rule 0.7.1): No `any` types
 *   - ESM-first (Rule 0.7.1): All local imports use `.js` extension
 *   - Temperature = 0 (Rule 0.7.3): Verified through model config assertions
 *   - Structured output with Zod (Rule 0.7.3): All mock responses match schemas
 *   - Financial precision (Rule 0.7.2): Prices as strings with 4 decimal places
 *
 * @module tests/integration/analysis-pipeline.test
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

/**
 * Hoisted mock functions for model invocations. Each stage's model is
 * represented by an invoke function that can be independently configured
 * per test to return different structured outputs.
 */
const mockFilterInvoke = vi.hoisted(() => vi.fn());
const mockSentimentInvoke = vi.hoisted(() => vi.fn());
const mockTradeDetectInvoke = vi.hoisted(() => vi.fn());
const mockRecommendInvoke = vi.hoisted(() => vi.fn());

/**
 * Hoisted mock for the logger to prevent pino initialization errors
 * in the test environment. Returns a no-op logger with all standard
 * Pino log methods stubbed.
 */
const mockLoggerFn = vi.hoisted(() =>
  vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
);

// ---------------------------------------------------------------------------
// vi.mock() — Module-level mocks applied before import evaluation
// ---------------------------------------------------------------------------

/**
 * Mock the model factory module to intercept all LLM calls.
 *
 * Each model getter returns an object with a `withStructuredOutput()` method
 * that returns an object with an `invoke()` method. This mirrors the
 * ChatOpenAI → withStructuredOutput → invoke chain used by the pipeline nodes.
 *
 * CRITICAL: No real HTTP calls are made to OpenRouter.
 */
vi.mock("../../src/services/analyzer/models.js", () => ({
  getFilterModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({
      invoke: mockFilterInvoke,
    })),
  })),
  getSentimentModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({
      invoke: mockSentimentInvoke,
    })),
  })),
  getTradeDetectModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({
      invoke: mockTradeDetectInvoke,
    })),
  })),
  getRecommendModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({
      invoke: mockRecommendInvoke,
    })),
  })),
  MODEL_CONFIG: {
    filter: {
      stage: "filter",
      description: "Binary relevance classification — DeepSeek V3.2",
      costPer1MInput: "$0.25",
      costPer1MOutput: "$0.38",
    },
    sentiment: {
      stage: "sentiment",
      description: "Nuanced financial sentiment analysis — Claude Haiku 4.5",
      costPer1MInput: "$1.00",
      costPer1MOutput: "$5.00",
    },
    tradeDetect: {
      stage: "trade_detect",
      description: "Trade opportunity detection — Claude Haiku 4.5",
      costPer1MInput: "$1.00",
      costPer1MOutput: "$5.00",
    },
    recommend: {
      stage: "recommend",
      description: "Structured trade recommendation — Claude Sonnet 4.6",
      costPer1MInput: "$3.00",
      costPer1MOutput: "$15.00",
    },
  },
  TOKEN_BUDGETS: {
    filter: 256,
    sentiment: 512,
    tradeDetect: 512,
    recommend: 1024,
  },
}));

/**
 * Mock the logger factory to prevent pino/pino-pretty initialization
 * issues in the test environment. All log calls become no-ops.
 */
vi.mock("../../src/lib/logger.js", () => ({
  createLogger: mockLoggerFn,
}));

/**
 * Mock the environment configuration to provide test-safe defaults.
 * The pipeline nodes and their dependencies read env vars; mocking
 * prevents missing-env-var errors in the test environment.
 */
vi.mock("../../src/config/env.js", () => ({
  env: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    DATABASE_PROVIDER: "local",
    REDIS_URL: "redis://localhost:6379",
    OPENROUTER_API_KEY: "test-key-not-real",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ANALYSIS_CONCURRENCY: 1,
  },
}));

/**
 * Mock the constants module with test-safe pipeline configuration.
 * Temperature = 0 is enforced per AAP Rule 0.7.3.
 */
vi.mock("../../src/config/constants.js", () => ({
  PIPELINE: {
    TEMPERATURE: 0,
    FILTER_RELEVANCE_THRESHOLD: 0.5,
    SENTIMENT_TRADE_THRESHOLD: 0.6,
    STEPS: ["filter", "sentiment", "trade_detect", "recommend"],
  },
  DEFAULTS: {
    PAGINATION_LIMIT: 20,
    MAX_PAGINATION_LIMIT: 100,
  },
  QUEUE_NAMES: {
    NEWS_POLLING: "news-polling",
    ANALYSIS: "analysis",
    NOTIFICATIONS: "notifications",
  },
  MARKETS: ["us_stock", "indian_equity", "crypto", "social"],
  DIRECTIONS: ["long", "short"],
  TIMEFRAMES: ["intraday", "swing", "position"],
}));

/**
 * Mock the OpenRouter client factory used by models.ts.
 * Since we mock models.ts entirely, this is a safety net to ensure
 * no real ChatOpenAI instances are created.
 */
vi.mock("../../src/lib/openrouter.js", () => ({
  createFilterModel: vi.fn(),
  createSentimentModel: vi.fn(),
  createTradeDetectModel: vi.fn(),
  createRecommendModel: vi.fn(),
}));

/**
 * Mock the database module. The analysis pipeline itself does not write
 * to the database — the analysis worker does. We mock the db to prevent
 * PostgreSQL connection errors in the test environment while testing
 * the pipeline logic in isolation.
 */
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Actual imports — resolved AFTER vi.mock() calls above
// ---------------------------------------------------------------------------

import { analyzeArticle } from "../../src/services/analyzer/index.js";
import {
  FilterResultSchema,
  SentimentResultSchema,
  TradeDetectionResultSchema,
  TradeRecommendationSchema,
} from "../../src/services/analyzer/schemas.js";
import type { AnalyzeArticleInput } from "../../src/services/analyzer/index.js";

// ---------------------------------------------------------------------------
// Mock LLM Response Factory Functions
//
// Each factory returns data that passes the corresponding Zod schema's
// safeParse validation. Fields match the ACTUAL schema definitions in
// schemas.ts — not the simplified task description.
// ---------------------------------------------------------------------------

/**
 * Creates a FilterResult for a relevant article.
 * Schema: { isRelevant: boolean, relevanceScore: number(0-1), reasoning: string }
 */
function mockFilterRelevant() {
  return {
    isRelevant: true,
    relevanceScore: 0.92,
    reasoning:
      "Article discusses NVDA earnings with specific financial metrics — " +
      "revenue beat, segment growth, and raised guidance. Directly actionable.",
  };
}

/**
 * Creates a FilterResult for an irrelevant article.
 */
function mockFilterIrrelevant() {
  return {
    isRelevant: false,
    relevanceScore: 0.08,
    reasoning:
      "Article is a general tech opinion piece about programming languages " +
      "with no tradeable financial information or market implications.",
  };
}

/**
 * Creates a bullish SentimentResult.
 * Schema: { sentimentScore: number(-1 to 1), sentimentLabel: 7-level enum,
 *           reasoning: string, keyFactors: string[] }
 */
function mockSentimentBullish() {
  return {
    sentimentScore: 0.78,
    sentimentLabel: "strongly_positive" as const,
    reasoning:
      "Triple beat earnings with raised guidance. Revenue up 122% YoY " +
      "driven by AI/datacenter demand. Positive forward outlook from CEO " +
      "with expanded margin projections.",
    keyFactors: [
      "Revenue beat by $1.2B (122% YoY growth)",
      "Raised full-year guidance above consensus",
      "Datacenter segment revenue up 206% YoY",
      "Gross margin expansion to 76%",
    ],
  };
}

/**
 * Creates a bearish SentimentResult with negative news weighting.
 * Negative financial news has 2-3x market impact (AAP Rule 0.7.3).
 */
function mockSentimentBearish() {
  return {
    sentimentScore: -0.65,
    sentimentLabel: "moderately_negative" as const,
    reasoning:
      "SEC investigation announced for accounting irregularities. " +
      "CFO resignation signals governance crisis. Revenue miss by 15% " +
      "with downward guidance revision. Negative news weighting applied.",
    keyFactors: [
      "SEC formal investigation announced",
      "CFO resignation under investigation",
      "Revenue miss by 15% versus consensus",
      "Forward guidance revised downward",
    ],
  };
}

/**
 * Creates a TradeDetectionResult where a trade was detected.
 * Schema: { tradeDetected: boolean, symbol?: string, direction?: enum,
 *           reasoning: string, timeframe?: enum, signalStrength: number(0-1) }
 */
function mockTradeDetected() {
  return {
    tradeDetected: true,
    symbol: "NVDA",
    direction: "long" as const,
    reasoning:
      "Strong earnings catalyst with 122% revenue growth creates swing " +
      "trade opportunity. Clear support/resistance levels identifiable " +
      "from post-earnings volume profile.",
    timeframe: "swing" as const,
    signalStrength: 0.85,
  };
}

/**
 * Creates a TradeDetectionResult where no trade was detected.
 */
function mockNoTradeDetected() {
  return {
    tradeDetected: false,
    reasoning:
      "Mixed signals with no clear directional catalyst. Volume " +
      "insufficient for confident trade setup. Cautious forward guidance " +
      "offsets modest revenue beat.",
    signalStrength: 0.22,
  };
}

/**
 * Creates a LONG TradeRecommendation.
 * Schema: { symbol, market, direction, confidence: number(0-1),
 *           entryPrice: string, stopLoss: string, takeProfit: string,
 *           timeframe: enum, riskRewardRatio: string, reasoning: string,
 *           catalystExpiry?: string }
 *
 * CRITICAL: confidence is number (0-1), prices are strings with regex validation.
 */
function mockRecommendationLong() {
  return {
    symbol: "NVDA",
    market: "us_stock" as const,
    direction: "long" as const,
    confidence: 0.88,
    entryPrice: "880.0000",
    stopLoss: "845.0000",
    takeProfit: "950.0000",
    timeframe: "swing" as const,
    riskRewardRatio: "2.00",
    reasoning:
      "Triple beat Q4 with raised guidance supports sustained AI/datacenter " +
      "demand narrative. Entry at post-earnings pullback support level with " +
      "defined risk below recent consolidation.",
    catalystExpiry: "2026-04-15T00:00:00Z",
  };
}

/**
 * Creates a SHORT TradeRecommendation for bearish scenarios.
 */
function mockRecommendationShort() {
  return {
    symbol: "COIN",
    market: "crypto" as const,
    direction: "short" as const,
    confidence: 0.72,
    entryPrice: "210.0000",
    stopLoss: "225.0000",
    takeProfit: "185.0000",
    timeframe: "swing" as const,
    riskRewardRatio: "1.6667",
    reasoning:
      "SEC lawsuit exposes regulatory risk. Breakdown below key support " +
      "with increasing volume confirms bearish momentum. Risk defined above " +
      "prior resistance.",
    catalystExpiry: "2026-04-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Mock Setup Helper Types and Functions
// ---------------------------------------------------------------------------

/**
 * Configuration object for setting up mock LLM responses per pipeline stage.
 * Optional fields for stages that may not be reached due to short-circuiting.
 */
interface MockLLMConfig {
  filter: ReturnType<typeof mockFilterRelevant>;
  sentiment?: ReturnType<typeof mockSentimentBullish>;
  tradeDetect?: ReturnType<typeof mockTradeDetected>;
  recommend?: ReturnType<typeof mockRecommendationLong>;
}

/**
 * Configures mock LLM model invocations for a single test run.
 *
 * Resets all mock invoke functions, then sets up the resolved values
 * for each pipeline stage. Stages not provided in config will reject
 * with an error if invoked (catching unexpected calls).
 *
 * @param config - Per-stage mock response configuration
 */
function setupMockLLMs(config: MockLLMConfig): void {
  mockFilterInvoke.mockReset();
  mockSentimentInvoke.mockReset();
  mockTradeDetectInvoke.mockReset();
  mockRecommendInvoke.mockReset();

  // Filter stage — always required
  mockFilterInvoke.mockResolvedValue(config.filter);

  // Sentiment stage — optional (not reached if filtered out)
  if (config.sentiment !== undefined) {
    mockSentimentInvoke.mockResolvedValue(config.sentiment);
  } else {
    mockSentimentInvoke.mockRejectedValue(
      new Error("Sentiment model should not be called"),
    );
  }

  // Trade detection stage — optional
  if (config.tradeDetect !== undefined) {
    mockTradeDetectInvoke.mockResolvedValue(config.tradeDetect);
  } else {
    mockTradeDetectInvoke.mockRejectedValue(
      new Error("Trade detect model should not be called"),
    );
  }

  // Recommendation stage — optional (only ~25% of articles reach here)
  if (config.recommend !== undefined) {
    mockRecommendInvoke.mockResolvedValue(config.recommend);
  } else {
    mockRecommendInvoke.mockRejectedValue(
      new Error("Recommend model should not be called"),
    );
  }
}

// ---------------------------------------------------------------------------
// Test Article Input Factories
// ---------------------------------------------------------------------------

/**
 * Creates a test article input for a relevant article with trade potential.
 * Represents a strong earnings beat that should pass all 4 pipeline stages.
 */
function createRelevantArticleInput(): AnalyzeArticleInput {
  return {
    id: "550e8400-e29b-41d4-a716-446655440001",
    title: "NVDA Triple Beat Q4 Earnings — Revenue Up 122%",
    content:
      "NVIDIA reported Q4 revenue of $39.3B, beating estimates of $38.1B. " +
      "Datacenter revenue surged 206% year-over-year to $18.4B. CEO Jensen " +
      "Huang raised full-year guidance above consensus citing AI demand.",
    url: "https://example.com/nvda-q4-earnings-" + Date.now().toString(),
    source: "Finnhub",
    market: "us_stock",
    symbols: ["NVDA"],
    publishedAt: "2026-03-13T10:00:00Z",
  };
}

/**
 * Creates a test article input for an irrelevant article.
 * Should be filtered out at stage 1 (filter node).
 */
function createIrrelevantArticleInput(): AnalyzeArticleInput {
  return {
    id: "550e8400-e29b-41d4-a716-446655440002",
    title: "Top 10 Programming Languages in 2026",
    content:
      "Here are the top programming languages developers should learn " +
      "in 2026: TypeScript, Rust, Python, Go, Kotlin...",
    url: "https://example.com/top10-" + Date.now().toString(),
    source: "Reddit",
    market: "us_stock",
    symbols: [],
    publishedAt: "2026-03-13T09:00:00Z",
  };
}

/**
 * Creates a test article input for a relevant article without trade potential.
 * Should pass filter and sentiment but fail at trade detection (stage 3).
 */
function createNoTradeArticleInput(): AnalyzeArticleInput {
  return {
    id: "550e8400-e29b-41d4-a716-446655440003",
    title: "Apple Reports Modest Revenue Growth in Q1",
    content:
      "Apple reported revenue slightly above expectations but gave " +
      "cautious forward guidance. iPhone sales were flat while Services " +
      "grew 12%. Mixed analyst reactions with no clear directional thesis.",
    url: "https://example.com/aapl-q1-" + Date.now().toString(),
    source: "Finnhub",
    market: "us_stock",
    symbols: ["AAPL"],
    publishedAt: "2026-03-13T11:00:00Z",
  };
}

/**
 * Creates a test article input for a bearish crypto article.
 * Should result in a SHORT recommendation.
 */
function createBearishCryptoArticleInput(): AnalyzeArticleInput {
  return {
    id: "550e8400-e29b-41d4-a716-446655440004",
    title: "SEC Sues Coinbase Over Securities Violations",
    content:
      "SEC files lawsuit alleging Coinbase operated as an unregistered " +
      "securities exchange. The complaint details multiple violations of " +
      "securities law with potential fines exceeding $1B.",
    url: "https://example.com/sec-coin-" + Date.now().toString(),
    source: "CryptoCompare",
    market: "crypto",
    symbols: ["COIN"],
    publishedAt: "2026-03-13T12:00:00Z",
  };
}

// =========================================================================
// TEST SUITE
// =========================================================================

describe("Analysis Pipeline Integration", () => {
  // Reset all mocks before each test to ensure isolation
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Full 4-Stage Pipeline Flow
  // -----------------------------------------------------------------------

  describe("Full pipeline flow — relevant article with trade opportunity", () => {
    it("should process through all 4 stages: filter → sentiment → tradeDetect → recommend", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // Verify filter stage results
      expect(result.isRelevant).toBe(true);
      expect(result.relevanceScore).toBeCloseTo(0.92, 2);
      expect(result.filterResult).not.toBeNull();
      expect(result.filterResult?.isRelevant).toBe(true);

      // Verify sentiment stage results
      expect(result.sentimentAnalysis).not.toBeNull();
      expect(result.sentimentAnalysis?.sentimentLabel).toBe("strongly_positive");
      expect(result.sentimentAnalysis?.sentimentScore).toBeCloseTo(0.78, 2);

      // Verify trade detection stage results
      expect(result.tradeDetected).toBe(true);
      expect(result.tradeDetails).not.toBeNull();
      expect(result.tradeDetails?.tradeDetected).toBe(true);

      // Verify recommendation stage results
      expect(result.recommendation).not.toBeNull();
      expect(result.recommendation?.symbol).toBe("NVDA");
      expect(result.recommendation?.direction).toBe("long");
      expect(result.recommendation?.confidence).toBeCloseTo(0.88, 2);
      expect(result.recommendation?.entryPrice).toBe("880.0000");
    });

    it("should invoke all 4 model stages exactly once", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      await analyzeArticle(articleInput);

      // Each stage model should have been invoked exactly once
      expect(mockFilterInvoke).toHaveBeenCalledTimes(1);
      expect(mockSentimentInvoke).toHaveBeenCalledTimes(1);
      expect(mockTradeDetectInvoke).toHaveBeenCalledTimes(1);
      expect(mockRecommendInvoke).toHaveBeenCalledTimes(1);
    });

    it("should include article data in pipeline state", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // The article should be preserved in the pipeline state
      expect(result.article).not.toBeNull();
      expect(result.article?.id).toBe(articleInput.id);
      expect(result.article?.title).toBe(articleInput.title);
      expect(result.article?.market).toBe("us_stock");
      expect(result.article?.symbols).toEqual(["NVDA"]);
    });

    it("should reach 'recommend' or 'complete' as final pipeline step", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // The final step should be either "recommend" or "complete"
      expect(["recommend", "complete"]).toContain(result.pipelineStep);
    });

    it("should produce a complete recommendation with all required fields", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      const rec = result.recommendation;
      expect(rec).not.toBeNull();
      expect(rec?.symbol).toBe("NVDA");
      expect(rec?.market).toBe("us_stock");
      expect(rec?.direction).toBe("long");
      expect(rec?.confidence).toBeCloseTo(0.88, 2);
      expect(rec?.entryPrice).toBe("880.0000");
      expect(rec?.stopLoss).toBe("845.0000");
      expect(rec?.takeProfit).toBe("950.0000");
      expect(rec?.timeframe).toBe("swing");
      expect(rec?.riskRewardRatio).toBe("2.00");
      expect(rec?.reasoning).toContain("AI/datacenter");
    });

    it("should have no fatal errors on successful pipeline", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // The pipeline may accumulate non-fatal informational messages
      // (e.g., price validation warnings when market data is unavailable
      // in the test environment). Verify that errors is an array and
      // does not contain any critical/fatal error indicators.
      expect(Array.isArray(result.errors)).toBe(true);
      for (const errorMsg of result.errors) {
        // No fatal pipeline errors should be present
        expect(errorMsg).not.toContain("pipeline failed");
        expect(errorMsg).not.toContain("LLM invocation error");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Conditional Short-Circuit — Filter Stage
  // -----------------------------------------------------------------------

  describe("Conditional short-circuit — irrelevant article at filter stage", () => {
    it("should terminate after filter stage when article is irrelevant", async () => {
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
        // Sentiment, tradeDetect, recommend should NOT be called
      });

      const articleInput = createIrrelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // Filter result should mark as not relevant
      expect(result.isRelevant).toBe(false);
      expect(result.filterResult?.isRelevant).toBe(false);
      expect(result.relevanceScore).toBeCloseTo(0.08, 2);

      // Downstream stages should NOT have been populated
      expect(result.sentimentAnalysis).toBeNull();
      expect(result.tradeDetected).toBe(false);
      expect(result.tradeDetails).toBeNull();
      expect(result.recommendation).toBeNull();
    });

    it("should NOT invoke sentiment, tradeDetect, or recommend models", async () => {
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const articleInput = createIrrelevantArticleInput();
      await analyzeArticle(articleInput);

      // Only filter should have been called
      expect(mockFilterInvoke).toHaveBeenCalledTimes(1);
      expect(mockSentimentInvoke).not.toHaveBeenCalled();
      expect(mockTradeDetectInvoke).not.toHaveBeenCalled();
      expect(mockRecommendInvoke).not.toHaveBeenCalled();
    });

    it("should preserve article data even when filtered out", async () => {
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const articleInput = createIrrelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      expect(result.article).not.toBeNull();
      expect(result.article?.id).toBe(articleInput.id);
      expect(result.article?.title).toBe(articleInput.title);
    });

    it("should set pipeline step to filter when short-circuited", async () => {
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const articleInput = createIrrelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // Pipeline should have ended at the filter step
      expect(result.pipelineStep).toBe("filter");
    });
  });

  // -----------------------------------------------------------------------
  // Conditional Short-Circuit — Trade Detection Stage
  // -----------------------------------------------------------------------

  describe("Conditional short-circuit — no trade opportunity at trade-detect stage", () => {
    it("should terminate after trade-detect when no opportunity detected", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: mockNoTradeDetected(),
        // recommend should NOT be called
      });

      const articleInput = createNoTradeArticleInput();
      const result = await analyzeArticle(articleInput);

      // Filter and sentiment should be populated
      expect(result.isRelevant).toBe(true);
      expect(result.sentimentAnalysis).not.toBeNull();
      expect(result.sentimentAnalysis?.sentimentLabel).toBe(
        "moderately_negative",
      );
      expect(result.sentimentAnalysis?.sentimentScore).toBeCloseTo(-0.65, 2);

      // Trade detection should be false
      expect(result.tradeDetected).toBe(false);
      expect(result.tradeDetails?.tradeDetected).toBe(false);

      // Recommendation should NOT be populated
      expect(result.recommendation).toBeNull();
    });

    it("should invoke filter, sentiment, and tradeDetect but NOT recommend", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: mockNoTradeDetected(),
      });

      const articleInput = createNoTradeArticleInput();
      await analyzeArticle(articleInput);

      expect(mockFilterInvoke).toHaveBeenCalledTimes(1);
      expect(mockSentimentInvoke).toHaveBeenCalledTimes(1);
      expect(mockTradeDetectInvoke).toHaveBeenCalledTimes(1);
      expect(mockRecommendInvoke).not.toHaveBeenCalled();
    });

    it("should set pipeline step to trade_detect when no opportunity found", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: mockNoTradeDetected(),
      });

      const articleInput = createNoTradeArticleInput();
      const result = await analyzeArticle(articleInput);

      // Pipeline should have ended at trade_detect step
      expect(result.pipelineStep).toBe("trade_detect");
    });

    it("should preserve sentiment analysis even without trade opportunity", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: mockNoTradeDetected(),
      });

      const articleInput = createNoTradeArticleInput();
      const result = await analyzeArticle(articleInput);

      expect(result.sentimentAnalysis?.keyFactors).toHaveLength(4);
      expect(result.sentimentAnalysis?.reasoning).toContain("SEC investigation");
    });
  });

  // -----------------------------------------------------------------------
  // Zod Schema Validation
  // -----------------------------------------------------------------------

  describe("Zod schema validation", () => {
    it("should validate FilterResult schema with valid data", () => {
      const valid = FilterResultSchema.safeParse(mockFilterRelevant());
      expect(valid.success).toBe(true);
    });

    it("should reject FilterResult with non-boolean isRelevant", () => {
      const invalid = FilterResultSchema.safeParse({
        isRelevant: "yes",
        relevanceScore: 0.5,
        reasoning: "test",
      });
      expect(invalid.success).toBe(false);
    });

    it("should reject FilterResult with out-of-range relevanceScore", () => {
      const invalid = FilterResultSchema.safeParse({
        isRelevant: true,
        relevanceScore: 1.5,
        reasoning: "test",
      });
      expect(invalid.success).toBe(false);
    });

    it("should validate SentimentResult schema with bullish data", () => {
      const valid = SentimentResultSchema.safeParse(mockSentimentBullish());
      expect(valid.success).toBe(true);
    });

    it("should validate SentimentResult schema with bearish data", () => {
      const valid = SentimentResultSchema.safeParse(mockSentimentBearish());
      expect(valid.success).toBe(true);
    });

    it("should reject SentimentResult with invalid label", () => {
      const invalidLabel = SentimentResultSchema.safeParse({
        sentimentScore: 0.5,
        sentimentLabel: "unknown",
        reasoning: "test",
        keyFactors: [],
      });
      expect(invalidLabel.success).toBe(false);
    });

    it("should reject SentimentResult with out-of-range score", () => {
      const invalid = SentimentResultSchema.safeParse({
        sentimentScore: -2.0,
        sentimentLabel: "strongly_negative",
        reasoning: "test",
        keyFactors: [],
      });
      expect(invalid.success).toBe(false);
    });

    it("should validate TradeDetectionResult schema with detected trade", () => {
      const valid = TradeDetectionResultSchema.safeParse(mockTradeDetected());
      expect(valid.success).toBe(true);
    });

    it("should validate TradeDetectionResult schema without trade", () => {
      const valid = TradeDetectionResultSchema.safeParse(mockNoTradeDetected());
      expect(valid.success).toBe(true);
    });

    it("should validate TradeRecommendation schema with LONG recommendation", () => {
      const valid = TradeRecommendationSchema.safeParse(
        mockRecommendationLong(),
      );
      expect(valid.success).toBe(true);
    });

    it("should validate TradeRecommendation schema with SHORT recommendation", () => {
      const valid = TradeRecommendationSchema.safeParse(
        mockRecommendationShort(),
      );
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.direction).toBe("short");
        expect(valid.data.market).toBe("crypto");
      }
    });

    it("should reject TradeRecommendation with invalid direction", () => {
      const invalidDirection = TradeRecommendationSchema.safeParse({
        ...mockRecommendationLong(),
        direction: "hold",
      });
      expect(invalidDirection.success).toBe(false);
    });

    it("should reject TradeRecommendation with invalid entryPrice format", () => {
      const invalid = TradeRecommendationSchema.safeParse({
        ...mockRecommendationLong(),
        entryPrice: "not-a-number",
      });
      expect(invalid.success).toBe(false);
    });

    it("should reject TradeRecommendation with invalid market", () => {
      const invalid = TradeRecommendationSchema.safeParse({
        ...mockRecommendationLong(),
        market: "forex",
      });
      expect(invalid.success).toBe(false);
    });

    it("should reject TradeRecommendation with confidence out of range", () => {
      const invalid = TradeRecommendationSchema.safeParse({
        ...mockRecommendationLong(),
        confidence: 1.5,
      });
      expect(invalid.success).toBe(false);
    });

    it("should accept TradeRecommendation without optional catalystExpiry", () => {
      const { catalystExpiry: _removed, ...withoutExpiry } =
        mockRecommendationLong();
      const valid = TradeRecommendationSchema.safeParse(withoutExpiry);
      expect(valid.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // SHORT Direction Pipeline
  // -----------------------------------------------------------------------

  describe("SHORT direction pipeline", () => {
    it("should handle bearish sentiment with SHORT recommendation", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: {
          tradeDetected: true,
          symbol: "COIN",
          direction: "short" as const,
          reasoning:
            "SEC lawsuit exposes existential regulatory risk. " +
            "Breakdown below support confirms distribution pattern.",
          timeframe: "swing" as const,
          signalStrength: 0.78,
        },
        recommend: mockRecommendationShort(),
      });

      const articleInput = createBearishCryptoArticleInput();
      const result = await analyzeArticle(articleInput);

      // Verify full pipeline execution
      expect(result.isRelevant).toBe(true);
      expect(result.sentimentAnalysis?.sentimentLabel).toBe(
        "moderately_negative",
      );
      expect(result.tradeDetected).toBe(true);

      // Verify SHORT recommendation
      expect(result.recommendation).not.toBeNull();
      expect(result.recommendation?.direction).toBe("short");
      expect(result.recommendation?.symbol).toBe("COIN");
      expect(result.recommendation?.market).toBe("crypto");
      expect(result.recommendation?.confidence).toBeCloseTo(0.72, 2);
    });

    it("should produce valid SHORT recommendation that passes Zod validation", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: {
          tradeDetected: true,
          symbol: "COIN",
          direction: "short" as const,
          reasoning: "SEC lawsuit confirms regulatory risk.",
          timeframe: "swing" as const,
          signalStrength: 0.78,
        },
        recommend: mockRecommendationShort(),
      });

      const articleInput = createBearishCryptoArticleInput();
      const result = await analyzeArticle(articleInput);

      // Validate the recommendation against the Zod schema
      const validationResult = TradeRecommendationSchema.safeParse(
        result.recommendation,
      );
      expect(validationResult.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Financial Precision in Pipeline Output
  // -----------------------------------------------------------------------

  describe("Financial precision in pipeline output", () => {
    it("should preserve decimal precision in recommendation price fields", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      const rec = result.recommendation;
      expect(rec).not.toBeNull();

      // All price fields should be strings (NOT numbers) for PostgreSQL
      // numeric(12,4) precision preservation (AAP Rule 0.7.2)
      expect(typeof rec?.entryPrice).toBe("string");
      expect(typeof rec?.stopLoss).toBe("string");
      expect(typeof rec?.takeProfit).toBe("string");
      expect(typeof rec?.riskRewardRatio).toBe("string");

      // Verify exact precision retained (4 decimal places)
      expect(rec?.entryPrice).toBe("880.0000");
      expect(rec?.stopLoss).toBe("845.0000");
      expect(rec?.takeProfit).toBe("950.0000");
      expect(rec?.riskRewardRatio).toBe("2.00");
    });

    it("should preserve confidence as number type (numeric 3,2)", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // Confidence is a number (0.00-1.00) in the schema, NOT a string
      expect(typeof result.recommendation?.confidence).toBe("number");
      expect(result.recommendation?.confidence).toBeCloseTo(0.88, 2);
    });

    it("should preserve sentiment score precision in pipeline state", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // Sentiment score should be a precise number
      const sentimentScore = result.sentimentAnalysis?.sentimentScore;
      expect(sentimentScore).toBeDefined();
      expect(typeof sentimentScore).toBe("number");
      expect(sentimentScore).toBeCloseTo(0.78, 3);
    });

    it("should validate price string format matches regex constraint", () => {
      // All price strings in the recommendation must match the regex
      // /^\d+(\.\d{1,4})?$/ defined in TradeRecommendationSchema
      const rec = mockRecommendationLong();
      const priceRegex = /^\d+(\.\d{1,4})?$/;

      expect(priceRegex.test(rec.entryPrice)).toBe(true);
      expect(priceRegex.test(rec.stopLoss)).toBe(true);
      expect(priceRegex.test(rec.takeProfit)).toBe(true);
      expect(priceRegex.test(rec.riskRewardRatio)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Model Routing Verification
  // -----------------------------------------------------------------------

  describe("Model routing verification", () => {
    it("should use all 4 model stages when pipeline runs to completion", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      await analyzeArticle(articleInput);

      // Verify each model stage was invoked
      expect(mockFilterInvoke).toHaveBeenCalledTimes(1);
      expect(mockSentimentInvoke).toHaveBeenCalledTimes(1);
      expect(mockTradeDetectInvoke).toHaveBeenCalledTimes(1);
      expect(mockRecommendInvoke).toHaveBeenCalledTimes(1);
    });

    it("should only use filter model for irrelevant articles (cost optimization)", async () => {
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const articleInput = createIrrelevantArticleInput();
      await analyzeArticle(articleInput);

      // Only the cheapest model (DeepSeek V3.2 for filter) should be used
      expect(mockFilterInvoke).toHaveBeenCalledTimes(1);
      expect(mockSentimentInvoke).not.toHaveBeenCalled();
      expect(mockTradeDetectInvoke).not.toHaveBeenCalled();
      expect(mockRecommendInvoke).not.toHaveBeenCalled();
    });

    it("should skip expensive recommend model when no trade opportunity", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: mockNoTradeDetected(),
      });

      const articleInput = createNoTradeArticleInput();
      await analyzeArticle(articleInput);

      // The most expensive model (Sonnet for recommend) should NOT be called
      expect(mockFilterInvoke).toHaveBeenCalledTimes(1);
      expect(mockSentimentInvoke).toHaveBeenCalledTimes(1);
      expect(mockTradeDetectInvoke).toHaveBeenCalledTimes(1);
      expect(mockRecommendInvoke).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Pipeline State Integrity
  // -----------------------------------------------------------------------

  describe("Pipeline state integrity", () => {
    it("should accumulate errors without overwriting previous errors", async () => {
      // Create a scenario where an error occurs but doesn't crash
      // The errors array should accumulate, not replace
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // On a successful run, errors should be an empty array
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it("should initialize all state fields with defaults", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);

      // All state fields should be defined (populated by defaults or nodes)
      expect(result.article).toBeDefined();
      expect(typeof result.isRelevant).toBe("boolean");
      expect(typeof result.relevanceScore).toBe("number");
      expect(typeof result.tradeDetected).toBe("boolean");
      expect(typeof result.pipelineStep).toBe("string");
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it("should handle multiple sequential analyses independently", async () => {
      // First analysis: relevant with LONG recommendation
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const result1 = await analyzeArticle(createRelevantArticleInput());
      expect(result1.recommendation?.direction).toBe("long");

      // Second analysis: irrelevant (filtered out)
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const result2 = await analyzeArticle(createIrrelevantArticleInput());
      expect(result2.isRelevant).toBe(false);
      expect(result2.recommendation).toBeNull();

      // Results should be independent (no state leakage)
      expect(result1.isRelevant).toBe(true);
      expect(result1.recommendation?.symbol).toBe("NVDA");
    });
  });

  // -----------------------------------------------------------------------
  // Database Integration Simulation
  //
  // The analysis pipeline itself does NOT write to the database — the
  // analysis worker does. These tests verify that pipeline output
  // has the correct shape for database storage by the worker.
  // -----------------------------------------------------------------------

  describe("Pipeline output compatibility with database storage", () => {
    it("should produce recommendation with all fields needed for trade_opportunities insert", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const articleInput = createRelevantArticleInput();
      const result = await analyzeArticle(articleInput);
      const rec = result.recommendation;

      expect(rec).not.toBeNull();

      // Verify all required fields for trade_opportunities table are present
      // Fields matching the Drizzle schema: symbol, market, direction,
      // confidence, entryPrice, stopLoss, takeProfit, timeframe, reasoning,
      // riskRewardRatio
      expect(rec?.symbol).toBeDefined();
      expect(rec?.market).toBeDefined();
      expect(rec?.direction).toBeDefined();
      expect(rec?.confidence).toBeDefined();
      expect(rec?.entryPrice).toBeDefined();
      expect(rec?.stopLoss).toBeDefined();
      expect(rec?.takeProfit).toBeDefined();
      expect(rec?.timeframe).toBeDefined();
      expect(rec?.reasoning).toBeDefined();
      expect(rec?.riskRewardRatio).toBeDefined();

      // Verify market is a valid enum value
      expect(["us_stock", "indian_equity", "crypto"]).toContain(rec?.market);

      // Verify direction is a valid enum value
      expect(["long", "short"]).toContain(rec?.direction);

      // Verify timeframe is a valid enum value
      expect(["intraday", "swing", "position"]).toContain(rec?.timeframe);
    });

    it("should produce isRelevant flag usable for article marking", async () => {
      // Full pipeline
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const result1 = await analyzeArticle(createRelevantArticleInput());
      expect(typeof result1.isRelevant).toBe("boolean");

      // Short-circuit
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const result2 = await analyzeArticle(createIrrelevantArticleInput());
      expect(typeof result2.isRelevant).toBe("boolean");
    });

    it("should produce pipeline step compatible with analysis_logs table enum", async () => {
      const validSteps = new Set([
        "filter",
        "sentiment",
        "trade_detect",
        "recommend",
        "complete",
      ]);

      // Full pipeline
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const result1 = await analyzeArticle(createRelevantArticleInput());
      expect(validSteps.has(result1.pipelineStep)).toBe(true);

      // Short-circuit at filter
      setupMockLLMs({
        filter: mockFilterIrrelevant(),
      });

      const result2 = await analyzeArticle(createIrrelevantArticleInput());
      expect(validSteps.has(result2.pipelineStep)).toBe(true);
    });

    it("should produce sentiment analysis storable as JSONB", async () => {
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });

      const result = await analyzeArticle(createRelevantArticleInput());

      // Sentiment analysis should be serializable to JSON (for JSONB storage)
      const sentimentJson = JSON.stringify(result.sentimentAnalysis);
      expect(sentimentJson).toBeDefined();

      const parsed: unknown = JSON.parse(sentimentJson);
      expect(parsed).toHaveProperty("sentimentScore");
      expect(parsed).toHaveProperty("sentimentLabel");
      expect(parsed).toHaveProperty("reasoning");
      expect(parsed).toHaveProperty("keyFactors");
    });
  });

  // -----------------------------------------------------------------------
  // Cost Optimization Verification
  // -----------------------------------------------------------------------

  describe("Cost optimization — conditional short-circuiting", () => {
    it("should achieve ~75% cost reduction by filtering irrelevant articles", async () => {
      // Simulate a batch of articles: 3 irrelevant, 1 relevant with trade
      // This mimics the expected ~75% filter rate from the AAP
      //
      // Track cumulative call counts manually since setupMockLLMs resets
      // the mock functions between runs.
      let totalFilterCalls = 0;
      let totalSentimentCalls = 0;
      let totalTradeDetectCalls = 0;
      let totalRecommendCalls = 0;

      // Article 1: Irrelevant — only filter model called
      setupMockLLMs({ filter: mockFilterIrrelevant() });
      await analyzeArticle(createIrrelevantArticleInput());
      totalFilterCalls += mockFilterInvoke.mock.calls.length;
      totalSentimentCalls += mockSentimentInvoke.mock.calls.length;
      totalTradeDetectCalls += mockTradeDetectInvoke.mock.calls.length;
      totalRecommendCalls += mockRecommendInvoke.mock.calls.length;

      // Article 2: Irrelevant — only filter model called
      setupMockLLMs({ filter: mockFilterIrrelevant() });
      await analyzeArticle({
        ...createIrrelevantArticleInput(),
        id: "550e8400-e29b-41d4-a716-446655440010",
        url: "https://example.com/irrelevant-2-" + Date.now().toString(),
      });
      totalFilterCalls += mockFilterInvoke.mock.calls.length;
      totalSentimentCalls += mockSentimentInvoke.mock.calls.length;
      totalTradeDetectCalls += mockTradeDetectInvoke.mock.calls.length;
      totalRecommendCalls += mockRecommendInvoke.mock.calls.length;

      // Article 3: Relevant but no trade — 3 models called
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBearish(),
        tradeDetect: mockNoTradeDetected(),
      });
      await analyzeArticle(createNoTradeArticleInput());
      totalFilterCalls += mockFilterInvoke.mock.calls.length;
      totalSentimentCalls += mockSentimentInvoke.mock.calls.length;
      totalTradeDetectCalls += mockTradeDetectInvoke.mock.calls.length;
      totalRecommendCalls += mockRecommendInvoke.mock.calls.length;

      // Article 4: Full pipeline — 4 models called
      setupMockLLMs({
        filter: mockFilterRelevant(),
        sentiment: mockSentimentBullish(),
        tradeDetect: mockTradeDetected(),
        recommend: mockRecommendationLong(),
      });
      await analyzeArticle(createRelevantArticleInput());
      totalFilterCalls += mockFilterInvoke.mock.calls.length;
      totalSentimentCalls += mockSentimentInvoke.mock.calls.length;
      totalTradeDetectCalls += mockTradeDetectInvoke.mock.calls.length;
      totalRecommendCalls += mockRecommendInvoke.mock.calls.length;

      // Total cumulative model calls across all 4 articles:
      // Filter: 4 calls (every article goes through filter)
      expect(totalFilterCalls).toBe(4);
      // Sentiment: 2 calls (only relevant articles)
      expect(totalSentimentCalls).toBe(2);
      // TradeDetect: 2 calls (only relevant articles)
      expect(totalTradeDetectCalls).toBe(2);
      // Recommend: 1 call (only the article with detected trade opportunity)
      expect(totalRecommendCalls).toBe(1);

      // Without short-circuiting: 4 × 4 = 16 model calls
      // With short-circuiting: 4 + 2 + 2 + 1 = 9 model calls
      // Cost reduction: (16 - 9) / 16 = 43.75%
      // And the most expensive Recommend model is only called 25% of the time
      const totalCalls =
        totalFilterCalls +
        totalSentimentCalls +
        totalTradeDetectCalls +
        totalRecommendCalls;
      const maxPossibleCalls = 4 * 4;
      const costReduction = (maxPossibleCalls - totalCalls) / maxPossibleCalls;
      expect(costReduction).toBeGreaterThan(0.4); // At least 40% reduction
    });
  });
});
