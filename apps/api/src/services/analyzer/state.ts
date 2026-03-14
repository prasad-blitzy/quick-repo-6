/**
 * @module apps/api/src/services/analyzer/state
 *
 * LangGraph.js v1.2.2 Annotation-based typed state definition for the
 * four-stage AI analysis pipeline.
 *
 * This is the **most foundational file** in the analyzer module. It defines
 * the typed state shape that flows through all 4 nodes of the LangGraph
 * analysis pipeline:
 *
 *   Filter → Sentiment → Trade Detection → Recommendation
 *
 * Every node function receives the full state as input and returns a partial
 * state update. The reducers defined here control how those partial updates
 * are merged back into the canonical state.
 *
 * State channels and their reducers:
 *   - Most fields use a **replacement reducer** `(_, next) => next` — last
 *     write wins, because each pipeline stage "owns" its output fields and
 *     writes them exactly once.
 *   - The `errors` channel uses an **accumulator reducer**
 *     `(prev, next) => [...prev, ...next]` — errors from every stage are
 *     collected without overwriting earlier entries.
 *
 * Integration points:
 *   - `analyzer/index.ts`  — `new StateGraph(AnalyzerAnnotation)`
 *   - `analyzer/nodes/*.ts` — Node functions typed as `(state: AnalyzerState) => Partial<AnalyzerState>`
 *   - `queues/workers/analysis.worker.ts` — Constructs initial `ArticleInput`
 *
 * @see https://langchain-ai.github.io/langgraphjs/concepts/low_level/#annotation
 */

import { Annotation } from "@langchain/langgraph";

import type {
  FilterResult,
  SentimentResult,
  TradeDetectionResult,
  TradeRecommendation,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Article Input Interface
// ---------------------------------------------------------------------------

/**
 * Represents the subset of a news article that is fed into the analysis
 * pipeline. This is intentionally a **plain interface** rather than a
 * re-export of the full `NewsArticle` database type so that the analyzer
 * module remains decoupled from the database schema and shared packages.
 *
 * All fields map 1-to-1 with columns in the `news_articles` table, but
 * `market` is typed as `string` (not the PostgreSQL `market` enum) to
 * avoid a hard dependency on `packages/types`.
 */
export interface ArticleInput {
  /** UUID primary key from the `news_articles` table. */
  id: string;

  /** Article headline / title text. */
  title: string;

  /**
   * Full article body content that the LLM will analyze.
   * May be truncated to fit within the model's context window.
   */
  content: string;

  /** Canonical URL of the article — used for deduplication. */
  url: string;

  /** Data source identifier (e.g., "finnhub", "economic_times_rss"). */
  source: string;

  /**
   * Market classification string (e.g., "us_stock", "indian_equity", "crypto", "social").
   * Kept as `string` to decouple from the database enum type.
   */
  market: string;

  /** Array of ticker symbols mentioned in or associated with the article. */
  symbols: string[];

  /** ISO 8601 publication timestamp string. */
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Pipeline Step Type
// ---------------------------------------------------------------------------

/**
 * Literal union representing the current (or last completed) step in the
 * analysis pipeline. Used for pipeline metadata tracking and conditional
 * routing decisions.
 *
 * Values:
 *   - `"filter"`       — Binary relevance classification (DeepSeek V3.2)
 *   - `"sentiment"`    — Nuanced sentiment analysis (Claude Haiku 4.5)
 *   - `"trade_detect"` — Trade opportunity identification (Claude Haiku 4.5)
 *   - `"recommend"`    — Structured trade recommendation (Claude Sonnet 4.6)
 *   - `"complete"`     — Pipeline has finished (terminal state)
 */
export type PipelineStep =
  | "filter"
  | "sentiment"
  | "trade_detect"
  | "recommend"
  | "complete";

// ---------------------------------------------------------------------------
// LangGraph Annotation Definition (Core State)
// ---------------------------------------------------------------------------

/**
 * The top-level LangGraph `Annotation.Root` that defines every state
 * channel in the analysis pipeline.
 *
 * Usage with StateGraph:
 * ```typescript
 * import { StateGraph } from "@langchain/langgraph";
 * import { AnalyzerAnnotation } from "./state.js";
 *
 * const graph = new StateGraph(AnalyzerAnnotation)
 *   .addNode("filter", filterNode)
 *   .addNode("sentiment", sentimentNode)
 *   // ...
 *   .compile();
 * ```
 *
 * Each channel specifies:
 *   - A **reducer** that merges partial node returns into the full state.
 *   - A **default factory** that produces the initial value for fresh
 *     invocations. Factories (not raw values) are required so that
 *     LangGraph can create independent state copies per invocation.
 */
export const AnalyzerAnnotation = Annotation.Root({
  // -----------------------------------------------------------------------
  // Input article data — set once at pipeline start, read by all nodes
  // -----------------------------------------------------------------------

  /**
   * The news article being analyzed. Populated before the first node
   * executes and remains unchanged throughout the pipeline.
   */
  article: Annotation<ArticleInput | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // -----------------------------------------------------------------------
  // Filter stage results (Stage 1 — DeepSeek V3.2)
  // -----------------------------------------------------------------------

  /**
   * Relevance score from 0.0 (completely irrelevant) to 1.0 (highly
   * relevant). Produced by the filter node.
   */
  relevanceScore: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /**
   * Binary relevance flag. When `false`, the conditional edge after the
   * filter node short-circuits the pipeline (skipping sentiment, trade
   * detection, and recommendation), achieving ~75% LLM cost reduction.
   */
  isRelevant: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /**
   * Full structured output from the filter stage, including the
   * reasoning explanation for the relevance determination.
   */
  filterResult: Annotation<FilterResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // -----------------------------------------------------------------------
  // Sentiment stage results (Stage 2 — Claude Haiku 4.5)
  // -----------------------------------------------------------------------

  /**
   * Full structured sentiment analysis output, including sentiment score
   * (-1.0 to 1.0), human-readable label, reasoning, and key factors.
   * Negative news is weighted 2–3× higher (AAP Rule 0.7.3).
   */
  sentimentAnalysis: Annotation<SentimentResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // -----------------------------------------------------------------------
  // Trade detection stage results (Stage 3 — Claude Haiku 4.5)
  // -----------------------------------------------------------------------

  /**
   * Whether the trade detection node identified an actionable trade
   * opportunity. When `false`, the conditional edge routes to "complete"
   * instead of the expensive recommendation model.
   */
  tradeDetected: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /**
   * Full structured trade detection output, including symbol, direction,
   * timeframe, signal strength, and reasoning. Only meaningful when
   * `tradeDetected` is `true`.
   */
  tradeDetails: Annotation<TradeDetectionResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // -----------------------------------------------------------------------
  // Recommendation stage results (Stage 4 — Claude Sonnet 4.6)
  // -----------------------------------------------------------------------

  /**
   * Final structured trade recommendation with entry price, stop loss,
   * take profit, risk-reward ratio, and detailed reasoning. All price
   * fields are strings to preserve PostgreSQL numeric(12,4) precision.
   * Only populated for the ~25% of articles that reach this stage.
   */
  recommendation: Annotation<TradeRecommendation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // -----------------------------------------------------------------------
  // Pipeline metadata
  // -----------------------------------------------------------------------

  /**
   * Tracks which pipeline step is currently executing or was last
   * completed. Used for logging and progress monitoring.
   */
  pipelineStep: Annotation<PipelineStep>({
    reducer: (_prev, next) => next,
    default: () => "filter" as PipelineStep,
  }),

  /**
   * Accumulates error messages from any pipeline stage that encounters
   * a recoverable failure. Uses an **accumulator reducer** so that
   * errors from earlier stages are preserved when later stages append
   * their own errors.
   *
   * IMPORTANT: This is the only channel that does NOT use a simple
   * replacement reducer — it concatenates arrays instead.
   */
  errors: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

// ---------------------------------------------------------------------------
// Inferred State Type
// ---------------------------------------------------------------------------

/**
 * TypeScript type inferred from the `AnalyzerAnnotation` definition.
 *
 * This type is used as the function signature for:
 *   - All 4 node functions (input parameter type)
 *   - Conditional edge routing functions
 *   - The `analyzeArticle` return type in `analyzer/index.ts`
 *
 * Shape (all properties are required at the type level because
 * LangGraph initializes every channel from its `default` factory):
 * ```typescript
 * {
 *   article: ArticleInput | null;
 *   relevanceScore: number;
 *   isRelevant: boolean;
 *   filterResult: FilterResult | null;
 *   sentimentAnalysis: SentimentResult | null;
 *   tradeDetected: boolean;
 *   tradeDetails: TradeDetectionResult | null;
 *   recommendation: TradeRecommendation | null;
 *   pipelineStep: PipelineStep;
 *   errors: string[];
 * }
 * ```
 */
export type AnalyzerState = typeof AnalyzerAnnotation.State;
