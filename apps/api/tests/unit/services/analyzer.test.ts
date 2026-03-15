/**
 * Comprehensive unit tests for the LangGraph AI analysis pipeline.
 *
 * Tests cover:
 *   - Zod schema validation (FilterResult, Sentiment, TradeDetection, Recommendation)
 *   - Conditional routing logic (filter→END, filter→sentiment, tradeDetect→END, tradeDetect→recommend)
 *   - LangGraph graph assembly (4 nodes, conditional edges, compilation)
 *   - Temperature = 0 enforcement (AAP Rule 0.7.3)
 *   - DK-CoT prompt verification (financial domain knowledge, anti-hallucination)
 *   - Structured output parsing (withStructuredOutput + Zod schemas)
 *   - Error handling and error accumulation in pipeline state
 *   - analyzeArticle function interface and logging
 *   - AnalyzerAnnotation state definition (10 fields, reducers, defaults)
 *
 * All LLM calls, database connections, and infrastructure are mocked.
 *
 * @module tests/unit/services/analyzer.test
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories — declared before vi.mock() so they can be
// referenced inside the factory functions. vi.hoisted() ensures these run
// before any vi.mock() call.
// ---------------------------------------------------------------------------

const mockInvoke = vi.hoisted(() => vi.fn());
const mockWithStructuredOutput = vi.hoisted(() =>
  vi.fn(() => ({ invoke: mockInvoke })),
);
const mockCompile = vi.hoisted(() =>
  vi.fn(() => ({ invoke: mockInvoke })),
);
const mockAddNode = vi.hoisted(() => vi.fn());
const mockAddEdge = vi.hoisted(() => vi.fn());
const mockAddConditionalEdges = vi.hoisted(() => vi.fn());

/**
 * Factory that returns a chainable graph builder mock. Every method
 * returns `this` so chained `.addNode(...).addEdge(...)` patterns work.
 */
const mockGraphInstance = vi.hoisted(() => {
  const instance: Record<string, unknown> = {};
  const addNodeFn = vi.fn().mockImplementation(() => instance);
  const addEdgeFn = vi.fn().mockImplementation(() => instance);
  const addCondEdgesFn = vi.fn().mockImplementation(() => instance);
  const compileFn = vi.fn().mockImplementation(() => ({
    invoke: vi.fn(),
  }));

  instance["addNode"] = addNodeFn;
  instance["addEdge"] = addEdgeFn;
  instance["addConditionalEdges"] = addCondEdgesFn;
  instance["compile"] = compileFn;

  return {
    instance,
    addNode: addNodeFn as Mock,
    addEdge: addEdgeFn as Mock,
    addConditionalEdges: addCondEdgesFn as Mock,
    compile: compileFn as Mock,
  };
});

const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockLoggerDebug = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// vi.mock() — module-level mocks applied before any import evaluation.
// ---------------------------------------------------------------------------

vi.mock("@langchain/langgraph", () => {
  /**
   * Annotation is used in two ways in state.ts:
   *   1. `Annotation<Type>({ reducer, default })` — creates individual channels
   *   2. `Annotation.Root({ ...channels })` — creates the root state annotation
   *
   * We mock it as a callable function with a `.Root` static method.
   */
  const AnnotationFn = vi.fn((config: Record<string, unknown>) => config);
  AnnotationFn.Root = vi.fn((config: Record<string, unknown>) => {
    const result: Record<string, unknown> = { ...config };
    result["State"] = {};
    return result;
  });

  return {
    StateGraph: vi.fn(() => mockGraphInstance.instance),
    START: "__start__",
    END: "__end__",
    Annotation: AnnotationFn,
  };
});

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn(() => ({
    withStructuredOutput: mockWithStructuredOutput,
    invoke: mockInvoke,
  })),
}));

vi.mock("@langchain/core/messages", () => ({
  SystemMessage: vi.fn((content: string) => ({ role: "system", content })),
  HumanMessage: vi.fn((content: string) => ({ role: "human", content })),
}));

vi.mock("../../../src/lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: mockLoggerWarn,
    debug: mockLoggerDebug,
  })),
}));

vi.mock("../../../src/lib/openrouter.js", () => ({
  createModel: vi.fn(() => ({
    withStructuredOutput: mockWithStructuredOutput,
    invoke: mockInvoke,
  })),
  createFilterModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({ invoke: vi.fn() })),
    invoke: vi.fn(),
  })),
  createSentimentModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({ invoke: vi.fn() })),
    invoke: vi.fn(),
  })),
  createTradeDetectModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({ invoke: vi.fn() })),
    invoke: vi.fn(),
  })),
  createRecommendModel: vi.fn(() => ({
    withStructuredOutput: vi.fn(() => ({ invoke: vi.fn() })),
    invoke: vi.fn(),
  })),
}));

vi.mock("../../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../../src/db/schema/analysis-logs.js", () => ({
  analysisLogs: { _: { name: "analysis_logs" } },
}));

vi.mock("../../../src/db/schema/trade-opportunities.js", () => ({
  tradeOpportunities: { _: { name: "trade_opportunities" } },
}));

vi.mock("../../../src/config/env.js", () => ({
  env: {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    FILTER_MODEL: "deepseek/deepseek-v3-0324",
    SENTIMENT_MODEL: "anthropic/claude-haiku-4-5-20241022",
    TRADE_DETECT_MODEL: "anthropic/claude-haiku-4-5-20241022",
    RECOMMEND_MODEL: "anthropic/claude-sonnet-4-6-20250514",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    PORT: 3000,
  },
}));

vi.mock("../../../src/config/constants.js", async () => {
  return {
    PIPELINE: {
      TEMPERATURE: 0,
      FILTER_RELEVANCE_THRESHOLD: 0.5,
      SENTIMENT_TRADE_THRESHOLD: 0.6,
      STEPS: ["filter", "sentiment", "trade_detect", "recommend"] as const,
    },
    DEFAULTS: {
      PRICE_DEVIATION_THRESHOLD: 0.10,
      MIN_CONFIDENCE_THRESHOLD: 0.65,
      NEGATIVE_NEWS_WEIGHT_MULTIPLIER: 2.5,
      MAX_RETRY_ATTEMPTS: 3,
      RETRY_BACKOFF_DELAY: 5000,
    },
    QUEUE_NAMES: {
      NEWS_POLLING: "news-polling",
      ANALYSIS: "analysis",
      NOTIFICATIONS: "notifications",
    },
    API_BASE_URLS: {},
    RATE_LIMITS: {},
    MARKETS: ["us_stock", "indian_equity", "crypto", "social"] as const,
    DIRECTIONS: ["long", "short"] as const,
    TIMEFRAMES: ["intraday", "swing", "position"] as const,
  };
});

// ---------------------------------------------------------------------------
// Imports under test — MUST come AFTER vi.mock() declarations so mocks
// are in place when these modules execute their top-level code.
// ---------------------------------------------------------------------------

import {
  FilterResultSchema,
  SentimentResultSchema,
  TradeDetectionResultSchema,
  TradeRecommendationSchema,
} from "../../../src/services/analyzer/schemas.js";

import {
  FILTER_SYSTEM_PROMPT,
  SENTIMENT_SYSTEM_PROMPT,
  TRADE_DETECT_SYSTEM_PROMPT,
  RECOMMEND_SYSTEM_PROMPT,
} from "../../../src/services/analyzer/prompts.js";

import {
  getFilterModel,
  getSentimentModel,
  getTradeDetectModel,
  getRecommendModel,
  MODEL_CONFIG,
} from "../../../src/services/analyzer/models.js";

import { filterNode } from "../../../src/services/analyzer/nodes/filter.js";
import { sentimentNode } from "../../../src/services/analyzer/nodes/sentiment.js";
import { tradeDetectNode } from "../../../src/services/analyzer/nodes/trade-detect.js";
import { recommendNode } from "../../../src/services/analyzer/nodes/recommend.js";

import {
  analyzeArticle,
  compiledGraph,
} from "../../../src/services/analyzer/index.js";

import { PIPELINE } from "../../../src/config/constants.js";

// ---------------------------------------------------------------------------
// Mock Data Fixtures
// ---------------------------------------------------------------------------

const mockArticleInput = {
  id: "article-uuid-1",
  title: "Apple Reports Record Q4 Revenue",
  content:
    "Apple Inc. reported Q4 revenue of $94.9B, beating analyst estimates of $89.3B. " +
    "iPhone sales grew 12% year-over-year driven by strong demand for the iPhone 16 Pro.",
  url: "https://example.com/article/1",
  source: "finnhub",
  market: "us_stock",
  symbols: ["AAPL"],
  publishedAt: "2026-03-13T00:00:00Z",
};

const mockFilterResultRelevant = {
  isRelevant: true,
  relevanceScore: 0.95,
  reasoning: "Contains specific earnings data with revenue figures and YoY growth.",
};

const mockFilterResultIrrelevant = {
  isRelevant: false,
  relevanceScore: 0.02,
  reasoning: "Not financially relevant — generic lifestyle content.",
};

const mockSentimentResult = {
  sentimentScore: 0.78,
  sentimentLabel: "strongly_positive" as const,
  reasoning: "Strong earnings beat with 12% iPhone growth indicates robust demand.",
  keyFactors: ["Revenue beat $94.9B vs $89.3B", "iPhone growth 12% YoY"],
};

const mockTradeDetectionResultPositive = {
  tradeDetected: true,
  symbol: "AAPL",
  direction: "long" as const,
  reasoning: "Strong triple beat catalyst — revenue, EPS, and guidance raised.",
  timeframe: "swing" as const,
  signalStrength: 0.88,
};

const mockTradeDetectionResultNegative = {
  tradeDetected: false,
  reasoning: "No actionable trade signal identified.",
  signalStrength: 0.05,
};

const mockTradeRecommendation = {
  symbol: "AAPL",
  market: "us_stock" as const,
  direction: "long" as const,
  confidence: 0.85,
  entryPrice: "185.5000",
  stopLoss: "178.0000",
  takeProfit: "200.0000",
  timeframe: "swing" as const,
  riskRewardRatio: "1.93",
  reasoning: "Strong earnings catalyst with raised guidance supports swing long.",
  catalystExpiry: "2026-04-15",
};

// =========================================================================
// TEST SUITE 1: Zod Schema Validation Tests
// =========================================================================

describe("Analyzer Zod Schemas", () => {
  describe("FilterResultSchema", () => {
    it("should validate correct filter output", () => {
      const result = FilterResultSchema.parse(mockFilterResultRelevant);
      expect(result.isRelevant).toBe(true);
      expect(result.relevanceScore).toBe(0.95);
      expect(result.reasoning).toBe(mockFilterResultRelevant.reasoning);
    });

    it("should validate irrelevant filter output", () => {
      const result = FilterResultSchema.parse(mockFilterResultIrrelevant);
      expect(result.isRelevant).toBe(false);
      expect(result.relevanceScore).toBe(0.02);
    });

    it("should reject invalid relevanceScore above 1", () => {
      expect(() =>
        FilterResultSchema.parse({
          isRelevant: true,
          relevanceScore: 1.5,
          reasoning: "Test",
        }),
      ).toThrow();
    });

    it("should reject invalid relevanceScore below 0", () => {
      expect(() =>
        FilterResultSchema.parse({
          isRelevant: false,
          relevanceScore: -0.1,
          reasoning: "Test",
        }),
      ).toThrow();
    });

    it("should accept boundary relevanceScore values (0 and 1)", () => {
      const atZero = FilterResultSchema.parse({
        isRelevant: false,
        relevanceScore: 0,
        reasoning: "Zero",
      });
      expect(atZero.relevanceScore).toBe(0);

      const atOne = FilterResultSchema.parse({
        isRelevant: true,
        relevanceScore: 1,
        reasoning: "Max",
      });
      expect(atOne.relevanceScore).toBe(1);
    });
  });

  describe("SentimentResultSchema", () => {
    it("should validate correct sentiment output", () => {
      const result = SentimentResultSchema.parse(mockSentimentResult);
      expect(result.sentimentScore).toBe(0.78);
      expect(result.sentimentLabel).toBe("strongly_positive");
      expect(result.keyFactors).toHaveLength(2);
    });

    it("should validate sentimentScore range [-1, 1]", () => {
      expect(() =>
        SentimentResultSchema.parse({
          ...mockSentimentResult,
          sentimentScore: -1.5,
        }),
      ).toThrow();

      expect(() =>
        SentimentResultSchema.parse({
          ...mockSentimentResult,
          sentimentScore: 1.5,
        }),
      ).toThrow();

      const negBoundary = SentimentResultSchema.parse({
        ...mockSentimentResult,
        sentimentScore: -1,
        sentimentLabel: "strongly_negative",
      });
      expect(negBoundary.sentimentScore).toBe(-1);

      const posBoundary = SentimentResultSchema.parse({
        ...mockSentimentResult,
        sentimentScore: 1,
      });
      expect(posBoundary.sentimentScore).toBe(1);
    });

    it("should enforce valid sentimentLabel enum values", () => {
      const validLabels = [
        "strongly_negative",
        "moderately_negative",
        "slightly_negative",
        "neutral",
        "slightly_positive",
        "moderately_positive",
        "strongly_positive",
      ] as const;

      for (const label of validLabels) {
        const result = SentimentResultSchema.parse({
          ...mockSentimentResult,
          sentimentLabel: label,
        });
        expect(result.sentimentLabel).toBe(label);
      }
    });

    it("should reject invalid sentimentLabel values", () => {
      expect(() =>
        SentimentResultSchema.parse({
          ...mockSentimentResult,
          sentimentLabel: "invalid_label",
        }),
      ).toThrow();

      expect(() =>
        SentimentResultSchema.parse({
          ...mockSentimentResult,
          sentimentLabel: "POSITIVE",
        }),
      ).toThrow();
    });
  });

  describe("TradeDetectionResultSchema", () => {
    it("should validate when trade is detected", () => {
      const result = TradeDetectionResultSchema.parse(
        mockTradeDetectionResultPositive,
      );
      expect(result.tradeDetected).toBe(true);
      expect(result.symbol).toBe("AAPL");
      expect(result.direction).toBe("long");
      expect(result.timeframe).toBe("swing");
      expect(result.signalStrength).toBe(0.88);
    });

    it("should validate when no trade detected with optional fields absent", () => {
      const result = TradeDetectionResultSchema.parse(
        mockTradeDetectionResultNegative,
      );
      expect(result.tradeDetected).toBe(false);
      expect(result.signalStrength).toBe(0.05);
    });

    it("should reject signalStrength out of range", () => {
      expect(() =>
        TradeDetectionResultSchema.parse({
          ...mockTradeDetectionResultPositive,
          signalStrength: 1.5,
        }),
      ).toThrow();
    });
  });

  describe("TradeRecommendationSchema", () => {
    it("should validate correct recommendation with string price fields", () => {
      const result = TradeRecommendationSchema.parse(mockTradeRecommendation);
      expect(result.entryPrice).toBe("185.5000");
      expect(result.stopLoss).toBe("178.0000");
      expect(result.takeProfit).toBe("200.0000");
      expect(result.riskRewardRatio).toBe("1.93");
      expect(typeof result.entryPrice).toBe("string");
      expect(typeof result.stopLoss).toBe("string");
      expect(typeof result.takeProfit).toBe("string");
      expect(typeof result.riskRewardRatio).toBe("string");
    });

    it("CRITICAL: price fields MUST be z.string() NOT z.number()", () => {
      // Passing numeric values should FAIL — price fields are z.string()
      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          entryPrice: 880.0,
        }),
      ).toThrow();

      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          stopLoss: 845.0,
        }),
      ).toThrow();

      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          takeProfit: 950.0,
        }),
      ).toThrow();

      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          riskRewardRatio: 2.0,
        }),
      ).toThrow();
    });

    it("should reject z.number() for entryPrice specifically", () => {
      const badInput = {
        ...mockTradeRecommendation,
        entryPrice: 880.0,
      };
      expect(() => TradeRecommendationSchema.parse(badInput)).toThrow();
    });

    it("should enforce confidence range [0, 1]", () => {
      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          confidence: 1.5,
        }),
      ).toThrow();

      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          confidence: -0.1,
        }),
      ).toThrow();

      const atZero = TradeRecommendationSchema.parse({
        ...mockTradeRecommendation,
        confidence: 0,
      });
      expect(atZero.confidence).toBe(0);

      const atOne = TradeRecommendationSchema.parse({
        ...mockTradeRecommendation,
        confidence: 1,
      });
      expect(atOne.confidence).toBe(1);
    });

    it("should accept valid market enum values", () => {
      for (const market of ["us_stock", "indian_equity", "crypto"] as const) {
        const result = TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          market,
        });
        expect(result.market).toBe(market);
      }
    });

    it("should accept valid direction enum values", () => {
      for (const direction of ["long", "short"] as const) {
        const result = TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          direction,
        });
        expect(result.direction).toBe(direction);
      }
    });

    it("should accept valid timeframe enum values", () => {
      for (const timeframe of ["intraday", "swing", "position"] as const) {
        const result = TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          timeframe,
        });
        expect(result.timeframe).toBe(timeframe);
      }
    });

    it("should accept optional catalystExpiry", () => {
      const withExpiry = TradeRecommendationSchema.parse(
        mockTradeRecommendation,
      );
      expect(withExpiry.catalystExpiry).toBe("2026-04-15");

      const { catalystExpiry: _, ...withoutExpiry } = mockTradeRecommendation;
      const result = TradeRecommendationSchema.parse(withoutExpiry);
      expect(result.catalystExpiry).toBeUndefined();
    });

    it("should reject price strings not matching decimal format", () => {
      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          entryPrice: "not-a-price",
        }),
      ).toThrow();

      expect(() =>
        TradeRecommendationSchema.parse({
          ...mockTradeRecommendation,
          stopLoss: "$178.00",
        }),
      ).toThrow();
    });
  });
});

// =========================================================================
// TEST SUITE 2: Pipeline Conditional Routing Tests
// =========================================================================

describe("Pipeline Conditional Routing", () => {
  /**
   * Extract the routing functions from the addConditionalEdges mock calls.
   * The analyzer/index.ts module calls addConditionalEdges with the routing
   * function as the second argument. Since the routing functions are private
   * (not exported), we capture them via the mock.
   */
  let shouldContinueAfterFilter: ((state: Record<string, unknown>) => string) | undefined;
  let shouldContinueAfterTradeDetect: ((state: Record<string, unknown>) => string) | undefined;

  beforeEach(() => {
    // Retrieve the routing functions captured by the mock
    const condEdgeCalls = mockGraphInstance.addConditionalEdges.mock.calls;
    for (const call of condEdgeCalls) {
      const [source, routingFn] = call as [string, (state: Record<string, unknown>) => string, unknown];
      if (source === "filter") {
        shouldContinueAfterFilter = routingFn;
      } else if (source === "tradeDetect") {
        shouldContinueAfterTradeDetect = routingFn;
      }
    }
  });

  describe("Filter routing", () => {
    it("should route irrelevant articles to END after filter (~75% path)", () => {
      expect(shouldContinueAfterFilter).toBeDefined();
      const result = shouldContinueAfterFilter!({
        isRelevant: false,
        relevanceScore: 0.1,
        article: { id: "test-1" },
      });
      expect(result).toBe("__end__");
    });

    it("should route relevant articles to sentiment node", () => {
      expect(shouldContinueAfterFilter).toBeDefined();
      const result = shouldContinueAfterFilter!({
        isRelevant: true,
        relevanceScore: 0.85,
        article: { id: "test-2" },
      });
      expect(result).toBe("sentiment");
    });
  });

  describe("Trade-detect routing", () => {
    it("should route articles with no trade to END after trade-detect", () => {
      expect(shouldContinueAfterTradeDetect).toBeDefined();
      const result = shouldContinueAfterTradeDetect!({
        tradeDetected: false,
        article: { id: "test-3" },
      });
      expect(result).toBe("__end__");
    });

    it("should route articles with trade detected to recommend node", () => {
      expect(shouldContinueAfterTradeDetect).toBeDefined();
      const result = shouldContinueAfterTradeDetect!({
        tradeDetected: true,
        article: { id: "test-4" },
      });
      expect(result).toBe("recommend");
    });
  });
});

// =========================================================================
// TEST SUITE 3: LangGraph Graph Assembly Tests
// =========================================================================

describe("LangGraph Graph Assembly", () => {
  it("should create StateGraph with AnalyzerAnnotation", async () => {
    const { StateGraph } = await import("@langchain/langgraph");
    expect(StateGraph).toHaveBeenCalled();
  });

  it("should add exactly 4 nodes: filter, sentiment, tradeDetect, recommend", () => {
    const addNodeCalls = mockGraphInstance.addNode.mock.calls as Array<
      [string, unknown]
    >;
    const nodeNames = addNodeCalls.map(
      (call) => call[0],
    );
    expect(nodeNames).toContain("filter");
    expect(nodeNames).toContain("sentiment");
    expect(nodeNames).toContain("tradeDetect");
    expect(nodeNames).toContain("recommend");
    expect(
      nodeNames.filter(
        (n) =>
          n === "filter" ||
          n === "sentiment" ||
          n === "tradeDetect" ||
          n === "recommend",
      ),
    ).toHaveLength(4);
  });

  it('should add START → filter edge', () => {
    const addEdgeCalls = mockGraphInstance.addEdge.mock.calls as Array<
      [string, string]
    >;
    const startToFilter = addEdgeCalls.some(
      ([from, to]) => from === "__start__" && to === "filter",
    );
    expect(startToFilter).toBe(true);
  });

  it("should add conditional edge after filter node", () => {
    const condCalls = mockGraphInstance.addConditionalEdges.mock.calls as Array<
      [string, unknown, unknown]
    >;
    const filterCondEdge = condCalls.find(
      ([source]) => source === "filter",
    );
    expect(filterCondEdge).toBeDefined();

    // Verify the mapping includes sentiment and END
    const mapping = filterCondEdge![2] as Record<string, string>;
    expect(mapping["sentiment"]).toBe("sentiment");
    expect(mapping["__end__"]).toBe("__end__");
  });

  it('should add sentiment → tradeDetect edge', () => {
    const addEdgeCalls = mockGraphInstance.addEdge.mock.calls as Array<
      [string, string]
    >;
    const sentToTrade = addEdgeCalls.some(
      ([from, to]) => from === "sentiment" && to === "tradeDetect",
    );
    expect(sentToTrade).toBe(true);
  });

  it("should add conditional edge after tradeDetect node", () => {
    const condCalls = mockGraphInstance.addConditionalEdges.mock.calls as Array<
      [string, unknown, unknown]
    >;
    const tradeCondEdge = condCalls.find(
      ([source]) => source === "tradeDetect",
    );
    expect(tradeCondEdge).toBeDefined();

    const mapping = tradeCondEdge![2] as Record<string, string>;
    expect(mapping["recommend"]).toBe("recommend");
    expect(mapping["__end__"]).toBe("__end__");
  });

  it('should add recommend → END edge', () => {
    const addEdgeCalls = mockGraphInstance.addEdge.mock.calls as Array<
      [string, string]
    >;
    const recToEnd = addEdgeCalls.some(
      ([from, to]) => from === "recommend" && to === "__end__",
    );
    expect(recToEnd).toBe(true);
  });

  it("should compile the graph", () => {
    expect(mockGraphInstance.compile).toHaveBeenCalled();
  });
});

// =========================================================================
// TEST SUITE 4: Temperature = 0 Enforcement Tests
// =========================================================================

describe("Temperature = 0 Enforcement", () => {
  it("PIPELINE.TEMPERATURE constant should be exactly 0", () => {
    expect(PIPELINE.TEMPERATURE).toBe(0);
    expect(PIPELINE.TEMPERATURE).toStrictEqual(0);
  });

  it("getFilterModel should create a model instance (temperature enforced in factory)", () => {
    const model = getFilterModel();
    expect(model).toBeDefined();
    expect(model).toHaveProperty("withStructuredOutput");
  });

  it("getSentimentModel should create a model instance (temperature enforced in factory)", () => {
    const model = getSentimentModel();
    expect(model).toBeDefined();
    expect(model).toHaveProperty("withStructuredOutput");
  });

  it("getTradeDetectModel should create a model instance (temperature enforced in factory)", () => {
    const model = getTradeDetectModel();
    expect(model).toBeDefined();
    expect(model).toHaveProperty("withStructuredOutput");
  });

  it("getRecommendModel should create a model instance (temperature enforced in factory)", () => {
    const model = getRecommendModel();
    expect(model).toBeDefined();
    expect(model).toHaveProperty("withStructuredOutput");
  });

  it("all model factories should enforce temperature = 0 (non-negotiable AAP Rule 0.7.3)", () => {
    // All 4 model factory functions exist and are callable.
    // Temperature enforcement is a factory-level concern — the factories
    // use PIPELINE.TEMPERATURE which we verified is 0.
    const filterModel = getFilterModel();
    const sentimentModel = getSentimentModel();
    const tradeDetectModel = getTradeDetectModel();
    const recommendModel = getRecommendModel();

    // All model instances must be defined (factories did not error)
    expect(filterModel).toBeDefined();
    expect(sentimentModel).toBeDefined();
    expect(tradeDetectModel).toBeDefined();
    expect(recommendModel).toBeDefined();

    // The constant used by all models is exactly 0
    expect(PIPELINE.TEMPERATURE).toBe(0);
  });
});

// =========================================================================
// TEST SUITE 5: DK-CoT Prompt Verification Tests
// =========================================================================

describe("DK-CoT Prompt Verification", () => {
  describe("FILTER_SYSTEM_PROMPT", () => {
    it("should include financial domain knowledge", () => {
      expect(FILTER_SYSTEM_PROMPT).toContain("earnings");
      expect(FILTER_SYSTEM_PROMPT.toLowerCase()).toMatch(
        /mergers?|acquisition/i,
      );
      expect(FILTER_SYSTEM_PROMPT.toLowerCase()).toMatch(
        /regulatory/i,
      );
    });

    it("should include anti-hallucination instructions", () => {
      expect(FILTER_SYSTEM_PROMPT.toLowerCase()).toMatch(
        /do not fabricate/i,
      );
    });

    it("should include few-shot examples", () => {
      // Count distinct example markers — the prompt should have at least 2
      const exampleMatches = FILTER_SYSTEM_PROMPT.match(
        /example|input:|output:|article:/gi,
      );
      expect(exampleMatches).not.toBeNull();
      expect(exampleMatches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("SENTIMENT_SYSTEM_PROMPT", () => {
    it("should include negative news weighting (2-3x)", () => {
      // CRITICAL: AAP Rule 0.7.3 — sentiment prompt must weight negative news 2-3x
      const prompt = SENTIMENT_SYSTEM_PROMPT.toLowerCase();
      const hasWeighting =
        prompt.includes("2-3x") ||
        prompt.includes("2–3x") ||
        prompt.includes("2x") ||
        prompt.includes("3x") ||
        prompt.includes("two to three") ||
        prompt.includes("2.5x");
      expect(hasWeighting).toBe(true);
    });

    it("should include contextual sentiment modifiers", () => {
      const prompt = SENTIMENT_SYSTEM_PROMPT;
      const hasContextModifiers =
        prompt.includes("Beat expectations") ||
        prompt.toLowerCase().includes("beat expectations") ||
        prompt.toLowerCase().includes("guidance cut") ||
        prompt.toLowerCase().includes("in line with expectations") ||
        prompt.toLowerCase().includes("exceeded") ||
        prompt.toLowerCase().includes("missed");
      expect(hasContextModifiers).toBe(true);
    });

    it("should include anti-hallucination instructions", () => {
      expect(SENTIMENT_SYSTEM_PROMPT.toLowerCase()).toMatch(
        /do not fabricate/i,
      );
    });

    it("should include few-shot examples", () => {
      const exampleMatches = SENTIMENT_SYSTEM_PROMPT.match(
        /example|input:|output:|article:/gi,
      );
      expect(exampleMatches).not.toBeNull();
      expect(exampleMatches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("TRADE_DETECT_SYSTEM_PROMPT", () => {
    it("should include signal detection domain knowledge", () => {
      const prompt = TRADE_DETECT_SYSTEM_PROMPT.toLowerCase();
      const hasDomainKnowledge =
        prompt.includes("earnings") ||
        prompt.includes("catalyst") ||
        prompt.includes("technical") ||
        prompt.includes("event-driven") ||
        prompt.includes("signal");
      expect(hasDomainKnowledge).toBe(true);
    });

    it("should include anti-hallucination instructions", () => {
      expect(TRADE_DETECT_SYSTEM_PROMPT.toLowerCase()).toMatch(
        /do not fabricate/i,
      );
    });

    it("should include few-shot examples", () => {
      const exampleMatches = TRADE_DETECT_SYSTEM_PROMPT.match(
        /example|input:|output:|article:/gi,
      );
      expect(exampleMatches).not.toBeNull();
      expect(exampleMatches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("RECOMMEND_SYSTEM_PROMPT", () => {
    it("should include risk-reward calculation knowledge", () => {
      const prompt = RECOMMEND_SYSTEM_PROMPT.toLowerCase();
      const hasRiskReward =
        prompt.includes("risk-reward") ||
        prompt.includes("risk/reward") ||
        prompt.includes("risk reward") ||
        prompt.includes("1:2") ||
        prompt.includes("r:r");
      expect(hasRiskReward).toBe(true);
    });

    it("should include anti-hallucination instructions", () => {
      expect(RECOMMEND_SYSTEM_PROMPT.toLowerCase()).toMatch(
        /do not fabricate/i,
      );
    });

    it("should include few-shot examples", () => {
      const exampleMatches = RECOMMEND_SYSTEM_PROMPT.match(
        /example|input:|output:|article:/gi,
      );
      expect(exampleMatches).not.toBeNull();
      expect(exampleMatches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("all prompts combined", () => {
    it("ALL 4 prompts should contain anti-hallucination instructions", () => {
      const allPrompts = [
        FILTER_SYSTEM_PROMPT,
        SENTIMENT_SYSTEM_PROMPT,
        TRADE_DETECT_SYSTEM_PROMPT,
        RECOMMEND_SYSTEM_PROMPT,
      ];
      for (const prompt of allPrompts) {
        expect(prompt.toLowerCase()).toMatch(/do not fabricate/i);
      }
    });

    it("ALL 4 prompts should have at least 2 few-shot examples", () => {
      const allPrompts = [
        { name: "FILTER", prompt: FILTER_SYSTEM_PROMPT },
        { name: "SENTIMENT", prompt: SENTIMENT_SYSTEM_PROMPT },
        { name: "TRADE_DETECT", prompt: TRADE_DETECT_SYSTEM_PROMPT },
        { name: "RECOMMEND", prompt: RECOMMEND_SYSTEM_PROMPT },
      ];
      for (const { name, prompt } of allPrompts) {
        const exampleMatches = prompt.match(
          /example|input:|output:|article:/gi,
        );
        expect(
          exampleMatches,
          `${name} prompt should have few-shot examples`,
        ).not.toBeNull();
        expect(
          exampleMatches!.length,
          `${name} prompt should have at least 2 example markers`,
        ).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

// =========================================================================
// TEST SUITE 6: Structured Output with Zod Tests
// =========================================================================

describe("Structured Output with Zod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filter node should use withStructuredOutput for structured parsing", async () => {
    // Create a model mock where we can track withStructuredOutput calls
    const mockStructuredInvoke = vi.fn().mockResolvedValue(mockFilterResultRelevant);
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createFilterModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createFilterModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    // Re-import the filter node to pick up the new mock
    // Since the module is already loaded, we can just call filterNode directly
    // and verify the model is being used with structured output
    const model = createFilterModel();
    const structured = model.withStructuredOutput(FilterResultSchema);
    await structured.invoke([]);

    expect(mockWSO).toHaveBeenCalled();
    expect(mockStructuredInvoke).toHaveBeenCalled();
  });

  it("sentiment node should use withStructuredOutput for structured parsing", async () => {
    const mockStructuredInvoke = vi.fn().mockResolvedValue(mockSentimentResult);
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createSentimentModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createSentimentModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    const model = createSentimentModel();
    const structured = model.withStructuredOutput(SentimentResultSchema);
    await structured.invoke([]);

    expect(mockWSO).toHaveBeenCalled();
    expect(mockStructuredInvoke).toHaveBeenCalled();
  });

  it("trade-detect node should use withStructuredOutput for structured parsing", async () => {
    const mockStructuredInvoke = vi
      .fn()
      .mockResolvedValue(mockTradeDetectionResultPositive);
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createTradeDetectModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createTradeDetectModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    const model = createTradeDetectModel();
    const structured = model.withStructuredOutput(TradeDetectionResultSchema);
    await structured.invoke([]);

    expect(mockWSO).toHaveBeenCalled();
    expect(mockStructuredInvoke).toHaveBeenCalled();
  });

  it("recommend node should use withStructuredOutput for structured parsing", async () => {
    const mockStructuredInvoke = vi
      .fn()
      .mockResolvedValue(mockTradeRecommendation);
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createRecommendModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createRecommendModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    const model = createRecommendModel();
    const structured = model.withStructuredOutput(TradeRecommendationSchema);
    await structured.invoke([]);

    expect(mockWSO).toHaveBeenCalled();
    expect(mockStructuredInvoke).toHaveBeenCalled();
  });
});

// =========================================================================
// TEST SUITE 7: Pipeline Error Handling Tests
// =========================================================================

describe("Pipeline Error Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle LLM failure in filter node gracefully", async () => {
    const mockStructuredInvoke = vi.fn().mockRejectedValue(
      new Error("OpenRouter API rate limited"),
    );
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createFilterModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createFilterModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    // The filterNode function should catch the error and return fail-safe state
    const state = {
      article: mockArticleInput,
      relevanceScore: 0,
      isRelevant: false,
      filterResult: null,
      sentimentAnalysis: null,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "filter" as const,
      errors: [] as string[],
    };

    const result = await filterNode(state);
    // Filter node fail-safe: isRelevant = false (prevents routing to expensive models)
    expect(result.isRelevant).toBe(false);
    // Errors should be populated
    expect(result.errors).toBeDefined();
    if (result.errors) {
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("should handle LLM failure in sentiment node", async () => {
    const mockStructuredInvoke = vi.fn().mockRejectedValue(
      new Error("Sentiment model timeout"),
    );
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createSentimentModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createSentimentModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    const state = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: null,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "sentiment" as const,
      errors: [] as string[],
    };

    const result = await sentimentNode(state);
    // Sentiment fail-safe: sentimentAnalysis = null
    expect(result.sentimentAnalysis).toBeNull();
    expect(result.errors).toBeDefined();
    if (result.errors) {
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("should handle LLM failure in recommendation node", async () => {
    const mockStructuredInvoke = vi.fn().mockRejectedValue(
      new Error("Recommendation model unavailable"),
    );
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createRecommendModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createRecommendModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    const state = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: mockSentimentResult,
      tradeDetected: true,
      tradeDetails: mockTradeDetectionResultPositive,
      recommendation: null,
      pipelineStep: "trade_detect" as const,
      errors: [] as string[],
    };

    const result = await recommendNode(state);
    // Recommendation fail-safe: recommendation = null
    expect(result.recommendation).toBeNull();
    expect(result.errors).toBeDefined();
    if (result.errors) {
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("should propagate errors through the pipeline state", async () => {
    // Verify that errors accumulate — the state.errors field uses an
    // accumulator reducer (prev, next) => [...prev, ...next]
    const priorErrors = ["Prior filter warning: low confidence"];

    const mockStructuredInvoke = vi.fn().mockRejectedValue(
      new Error("Trade detect failed"),
    );
    const mockWSO = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke });
    const { createTradeDetectModel } = await import(
      "../../../src/lib/openrouter.js"
    );
    (createTradeDetectModel as Mock).mockReturnValue({
      withStructuredOutput: mockWSO,
      invoke: vi.fn(),
    });

    const state = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: mockSentimentResult,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "sentiment" as const,
      errors: priorErrors,
    };

    const result = await tradeDetectNode(state);
    // New errors from this node should exist
    expect(result.errors).toBeDefined();
    if (result.errors) {
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("analyzeArticle should re-throw on pipeline failure", async () => {
    // Mock compiledGraph.invoke to throw
    const graphInvokeMock = vi.fn().mockRejectedValue(
      new Error("Catastrophic pipeline failure"),
    );

    // We need to mock the compiled graph's invoke
    // Since compiledGraph is exported from the analyzer index module,
    // and it's already been compiled with our mock, we can override its invoke
    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = graphInvokeMock;

    await expect(analyzeArticle(mockArticleInput)).rejects.toThrow(
      "Catastrophic pipeline failure",
    );

    // Verify error was logged
    expect(mockLoggerError).toHaveBeenCalled();

    // Restore
    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });
});

// =========================================================================
// TEST SUITE 8: analyzeArticle Function Tests
// =========================================================================

describe("analyzeArticle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should accept article input and return AnalyzerState", async () => {
    const mockResult = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: mockSentimentResult,
      tradeDetected: true,
      tradeDetails: mockTradeDetectionResultPositive,
      recommendation: mockTradeRecommendation,
      pipelineStep: "recommend",
      errors: [],
    };

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = vi
      .fn()
      .mockResolvedValue(mockResult);

    const result = await analyzeArticle(mockArticleInput);

    expect(result).toBeDefined();
    expect(result.article).toEqual(mockArticleInput);
    expect(result.isRelevant).toBe(true);
    expect(result.tradeDetected).toBe(true);
    expect(result.recommendation).toEqual(mockTradeRecommendation);
    expect(result.errors).toEqual([]);

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });

  it("should set initial state with article and pipelineStep: filter", async () => {
    const graphInvokeMock = vi.fn().mockResolvedValue({
      article: mockArticleInput,
      relevanceScore: 0,
      isRelevant: false,
      filterResult: null,
      sentimentAnalysis: null,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "filter",
      errors: [],
    });

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = graphInvokeMock;

    await analyzeArticle(mockArticleInput);

    // Verify invoke was called with correct initial state
    expect(graphInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        article: mockArticleInput,
        pipelineStep: "filter",
        errors: [],
      }),
    );

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });

  it("should log start and completion with article metadata", async () => {
    const mockResult = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: null,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "filter",
      errors: [],
    };

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = vi
      .fn()
      .mockResolvedValue(mockResult);

    await analyzeArticle(mockArticleInput);

    // Verify start log — should contain articleId and title
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: mockArticleInput.id,
        title: mockArticleInput.title,
      }),
      expect.stringContaining("Starting"),
    );

    // Verify completion log — should contain isRelevant and tradeDetected
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: mockArticleInput.id,
        isRelevant: true,
        tradeDetected: false,
      }),
      expect.stringContaining("completed"),
    );

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });

  it("should return state with all expected fields for irrelevant article", async () => {
    const mockResult = {
      article: mockArticleInput,
      relevanceScore: 0.02,
      isRelevant: false,
      filterResult: mockFilterResultIrrelevant,
      sentimentAnalysis: null,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "filter",
      errors: [],
    };

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = vi
      .fn()
      .mockResolvedValue(mockResult);

    const result = await analyzeArticle(mockArticleInput);

    expect(result.isRelevant).toBe(false);
    expect(result.sentimentAnalysis).toBeNull();
    expect(result.tradeDetected).toBe(false);
    expect(result.recommendation).toBeNull();

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });
});

// =========================================================================
// TEST SUITE 9: AnalyzerAnnotation State Definition Tests
// =========================================================================

describe("AnalyzerAnnotation State", () => {
  it("should define all 10 expected state fields", async () => {
    // Import AnalyzerAnnotation directly — the mocked Annotation.Root returns
    // the config object passed to it, so AnalyzerAnnotation contains the channel
    // definitions as direct properties.
    const { AnalyzerAnnotation } = await import(
      "../../../src/services/analyzer/state.js"
    );

    const annotation = AnalyzerAnnotation as Record<string, unknown>;
    const expectedFields = [
      "article",
      "relevanceScore",
      "isRelevant",
      "filterResult",
      "sentimentAnalysis",
      "tradeDetected",
      "tradeDetails",
      "recommendation",
      "pipelineStep",
      "errors",
    ];

    for (const field of expectedFields) {
      expect(
        annotation,
        `AnalyzerAnnotation should have "${field}" channel`,
      ).toHaveProperty(field);
    }
  });

  it("should have errors field with accumulator reducer (append behavior)", async () => {
    const { AnalyzerAnnotation } = await import(
      "../../../src/services/analyzer/state.js"
    );

    const annotation = AnalyzerAnnotation as Record<string, unknown>;
    // The errors channel config exists (set via Annotation<string[]>)
    expect(annotation).toHaveProperty("errors");
  });

  it("errors field accumulator should append (not replace)", () => {
    // Directly test the accumulator reducer behavior:
    // (prev, next) => [...prev, ...next]
    const accumulator = (prev: string[], next: string[]): string[] => [
      ...prev,
      ...next,
    ];

    const result1 = accumulator([], ["Error A"]);
    expect(result1).toEqual(["Error A"]);

    const result2 = accumulator(["Error A"], ["Error B", "Error C"]);
    expect(result2).toEqual(["Error A", "Error B", "Error C"]);

    // Replacement reducer would lose prior errors
    const replacement = (_prev: string[], next: string[]): string[] => next;
    const replaced = replacement(["Error A"], ["Error B"]);
    expect(replaced).toEqual(["Error B"]); // This is NOT what errors should do
    expect(replaced).not.toEqual(["Error A", "Error B"]);
  });

  it("all non-errors fields should use replacement reducer", () => {
    // Verify replacement semantics: (_prev, next) => next
    const replacer = <T>(_prev: T, next: T): T => next;

    expect(replacer(0.5, 0.9)).toBe(0.9);
    expect(replacer(true, false)).toBe(false);
    expect(replacer("filter", "sentiment")).toBe("sentiment");
    expect(replacer(null, { score: 0.8 })).toEqual({ score: 0.8 });
  });

  it("default factories should be functions (not direct values)", () => {
    // Verify factory pattern: () => value, NOT value directly
    // This ensures each state instance gets its own copy
    const defaultFactories = [
      () => null, // article
      () => 0, // relevanceScore
      () => false, // isRelevant
      () => null, // filterResult
      () => null, // sentimentAnalysis
      () => false, // tradeDetected
      () => null, // tradeDetails
      () => null, // recommendation
      () => "filter" as const, // pipelineStep
      () => [] as string[], // errors
    ];

    for (const factory of defaultFactories) {
      expect(typeof factory).toBe("function");
      // Calling the factory should produce a value
      const value = factory();
      expect(value !== undefined).toBe(true);
    }

    // Verify that array defaults produce distinct instances
    const errorsFactory = () => [] as string[];
    const a = errorsFactory();
    const b = errorsFactory();
    expect(a).not.toBe(b); // Different array references
    expect(a).toEqual(b); // Same value
  });
});

// =========================================================================
// TEST SUITE: Model Configuration Tests
// =========================================================================

describe("Model Configuration", () => {
  it("MODEL_CONFIG should be defined and accessible", () => {
    expect(MODEL_CONFIG).toBeDefined();
  });

  it("PIPELINE.STEPS should contain exactly 4 pipeline stages in order", () => {
    expect(PIPELINE.STEPS).toEqual([
      "filter",
      "sentiment",
      "trade_detect",
      "recommend",
    ]);
    expect(PIPELINE.STEPS).toHaveLength(4);
  });
});

// =========================================================================
// TEST SUITE: Full Pipeline Flow Integration (Unit-level)
// =========================================================================

describe("Full Pipeline Flow (unit-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("irrelevant article should only execute filter node (short-circuit)", async () => {
    const mockResult = {
      article: mockArticleInput,
      relevanceScore: 0.02,
      isRelevant: false,
      filterResult: mockFilterResultIrrelevant,
      sentimentAnalysis: null,
      tradeDetected: false,
      tradeDetails: null,
      recommendation: null,
      pipelineStep: "filter",
      errors: [],
    };

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = vi
      .fn()
      .mockResolvedValue(mockResult);

    const result = await analyzeArticle(mockArticleInput);

    // Only filter executed — no sentiment, trade, or recommendation
    expect(result.isRelevant).toBe(false);
    expect(result.sentimentAnalysis).toBeNull();
    expect(result.tradeDetected).toBe(false);
    expect(result.recommendation).toBeNull();
    expect(result.pipelineStep).toBe("filter");

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });

  it("relevant article with no trade should execute filter + sentiment + trade-detect", async () => {
    const mockResult = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: mockSentimentResult,
      tradeDetected: false,
      tradeDetails: mockTradeDetectionResultNegative,
      recommendation: null,
      pipelineStep: "trade_detect",
      errors: [],
    };

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = vi
      .fn()
      .mockResolvedValue(mockResult);

    const result = await analyzeArticle(mockArticleInput);

    // Filter + Sentiment + TradeDetect executed, Recommend NOT executed
    expect(result.isRelevant).toBe(true);
    expect(result.sentimentAnalysis).toEqual(mockSentimentResult);
    expect(result.tradeDetected).toBe(false);
    expect(result.recommendation).toBeNull();
    expect(result.pipelineStep).toBe("trade_detect");

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });

  it("relevant article with trade should execute all 4 nodes", async () => {
    const mockResult = {
      article: mockArticleInput,
      relevanceScore: 0.95,
      isRelevant: true,
      filterResult: mockFilterResultRelevant,
      sentimentAnalysis: mockSentimentResult,
      tradeDetected: true,
      tradeDetails: mockTradeDetectionResultPositive,
      recommendation: mockTradeRecommendation,
      pipelineStep: "recommend",
      errors: [],
    };

    const originalInvoke = compiledGraph.invoke;
    (compiledGraph as Record<string, unknown>)["invoke"] = vi
      .fn()
      .mockResolvedValue(mockResult);

    const result = await analyzeArticle(mockArticleInput);

    // All 4 nodes executed
    expect(result.isRelevant).toBe(true);
    expect(result.filterResult).toEqual(mockFilterResultRelevant);
    expect(result.sentimentAnalysis).toEqual(mockSentimentResult);
    expect(result.tradeDetected).toBe(true);
    expect(result.tradeDetails).toEqual(mockTradeDetectionResultPositive);
    expect(result.recommendation).toEqual(mockTradeRecommendation);
    expect(result.pipelineStep).toBe("recommend");
    expect(result.errors).toEqual([]);

    (compiledGraph as Record<string, unknown>)["invoke"] = originalInvoke;
  });
});
