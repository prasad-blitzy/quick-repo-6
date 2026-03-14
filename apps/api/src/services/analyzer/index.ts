/**
 * LangGraph.js Analysis Pipeline Orchestrator
 *
 * Main entry point for the AI analysis pipeline. Assembles a LangGraph.js
 * v1.2.2 `StateGraph` that wires 4 pipeline nodes with conditional edges
 * for early termination, achieving ~75% LLM cost reduction:
 *
 *   START → filter → (relevant? → sentiment : END)
 *                       → tradeDetect → (trade? → recommend : END)
 *                                                     → END
 *
 * Pipeline stages and model tiers (via OpenRouter):
 *   1. **Filter** (DeepSeek V3.2 — $0.25/1M) — Binary relevance classification
 *      ~75% of articles are filtered out here, preventing expensive downstream calls.
 *   2. **Sentiment** (Claude Haiku 4.5 — $1.00/$5.00) — Nuanced financial sentiment
 *      with 2–3× negative news weighting (AAP Rule 0.7.3).
 *   3. **Trade Detection** (Claude Haiku 4.5 — $1.00/$5.00) — Identifies actionable
 *      trade signals with symbol, direction, timeframe, and signal strength.
 *   4. **Recommendation** (Claude Sonnet 4.6 — $3.00/$15.00) — Generates structured
 *      trade recommendations with entry, stop loss, and take profit prices. Only
 *      ~25% of articles reach this expensive model.
 *
 * The graph is compiled once at module load time (singleton pattern) and reused
 * across all invocations by the analysis worker queue.
 *
 * Integration:
 *   - Consumed by `queues/workers/analysis.worker.ts` via `analyzeArticle()`
 *   - Pipeline results flow to `trade_opportunities` and `notification_logs` tables
 *   - All node functions are defined in `./nodes/*.ts` and imported here
 *
 * CRITICAL AAP compliance:
 *   - Temperature = 0 for all models (enforced in `models.ts`, not here)
 *   - TypeScript strict mode with `verbatimModuleSyntax`
 *   - No `any` types — `unknown` with type guards for error handling
 *   - ESM-first with `.js` extensions on all local imports
 *
 * @module services/analyzer/index
 * @see {@link https://langchain-ai.github.io/langgraphjs/concepts/low_level/#stategraph}
 */

import { StateGraph, START, END } from "@langchain/langgraph";

import { AnalyzerAnnotation, type AnalyzerState } from "./state.js";
import { filterNode } from "./nodes/filter.js";
import { sentimentNode } from "./nodes/sentiment.js";
import { tradeDetectNode } from "./nodes/trade-detect.js";
import { recommendNode } from "./nodes/recommend.js";
import { createLogger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "analyzer" }` context for structured
 * logging of pipeline orchestration events:
 *   - Article analysis start and completion
 *   - Conditional edge routing decisions (filter short-circuit, trade gate)
 *   - Pipeline error handling and re-throw
 */
const logger = createLogger("analyzer");

// ---------------------------------------------------------------------------
// Exported Input Interface
// ---------------------------------------------------------------------------

/**
 * Input interface for the `analyzeArticle` function. Contains the essential
 * fields from a news article needed by the analysis pipeline.
 *
 * This interface is intentionally defined separately from the database
 * `ArticleInput` type in `state.ts` to provide a clean public API contract
 * for the analysis worker. It is structurally identical to `ArticleInput`,
 * ensuring full compatibility with the pipeline state's `article` channel.
 *
 * All fields map 1-to-1 with columns in the `news_articles` database table.
 */
export interface AnalyzeArticleInput {
  /** UUID primary key from the `news_articles` table. */
  id: string;

  /** Article headline / title text. */
  title: string;

  /**
   * Full article body content that the LLM will analyze.
   * May be truncated by individual nodes to fit within model context windows.
   */
  content: string;

  /** Canonical URL of the article — used for deduplication. */
  url: string;

  /** Data source identifier (e.g., "finnhub", "economic_times_rss"). */
  source: string;

  /**
   * Market classification string (e.g., "us_stock", "indian_equity",
   * "crypto", "social"). Kept as `string` to decouple from the database
   * enum type.
   */
  market: string;

  /** Array of ticker symbols mentioned in or associated with the article. */
  symbols: string[];

  /** ISO 8601 publication timestamp string. */
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Conditional Edge Routing Functions
// ---------------------------------------------------------------------------

/**
 * Routing function for the conditional edge after the **filter** node.
 *
 * Determines whether the article should continue to sentiment analysis or
 * terminate early. Approximately ~75% of articles are filtered out at this
 * stage, preventing them from reaching the more expensive downstream models
 * (Claude Haiku for sentiment/trade-detect, Claude Sonnet for recommendation).
 *
 * @param state - Current pipeline state after the filter node has executed.
 *                The `isRelevant` field is set by the filter node.
 * @returns `"sentiment"` if the article is relevant, or `END` (`"__end__"`)
 *          to terminate the pipeline.
 */
function shouldContinueAfterFilter(state: AnalyzerState): string {
  if (!state.isRelevant) {
    logger.debug(
      { articleId: state.article?.id },
      "Article filtered out — not relevant, terminating pipeline early",
    );
    return END;
  }

  logger.debug(
    { articleId: state.article?.id },
    "Article is relevant — proceeding to sentiment analysis",
  );
  return "sentiment";
}

/**
 * Routing function for the conditional edge after the **tradeDetect** node.
 *
 * Determines whether the article should proceed to the expensive
 * recommendation model (Claude Sonnet 4.6 at $3.00/$15.00 per 1M tokens)
 * or terminate. Only ~25% of articles that reach this stage will have an
 * actionable trade opportunity detected.
 *
 * @param state - Current pipeline state after the trade detection node has
 *                executed. The `tradeDetected` field is set by the tradeDetect node.
 * @returns `"recommend"` if a trade opportunity was detected, or `END`
 *          (`"__end__"`) to terminate the pipeline.
 */
function shouldContinueAfterTradeDetect(state: AnalyzerState): string {
  if (!state.tradeDetected) {
    logger.debug(
      { articleId: state.article?.id },
      "No trade opportunity detected — stopping before expensive recommendation model",
    );
    return END;
  }

  logger.debug(
    { articleId: state.article?.id },
    "Trade opportunity detected — proceeding to recommendation generation",
  );
  return "recommend";
}

// ---------------------------------------------------------------------------
// Graph Assembly and Compilation
// ---------------------------------------------------------------------------

/**
 * Builds and compiles the LangGraph.js analysis pipeline `StateGraph`.
 *
 * Graph topology:
 * ```
 * START → filter → [conditional] → sentiment → tradeDetect → [conditional] → recommend → END
 *                       ↓                                          ↓
 *                      END                                        END
 * ```
 *
 * Node registration:
 *   - `"filter"` → `filterNode` (DeepSeek V3.2 — binary relevance)
 *   - `"sentiment"` → `sentimentNode` (Claude Haiku 4.5 — sentiment analysis)
 *   - `"tradeDetect"` → `tradeDetectNode` (Claude Haiku 4.5 — trade detection)
 *   - `"recommend"` → `recommendNode` (Claude Sonnet 4.6 — structured recommendation)
 *
 * Edge configuration:
 *   - `START → filter` — Every article enters the pipeline through the filter
 *   - `filter → [conditional]` — Routes to `"sentiment"` or `END` based on `isRelevant`
 *   - `sentiment → tradeDetect` — Direct (unconditional) edge
 *   - `tradeDetect → [conditional]` — Routes to `"recommend"` or `END` based on `tradeDetected`
 *   - `recommend → END` — Direct terminal edge
 *
 * @returns A compiled `CompiledStateGraph` ready for repeated `invoke()` calls.
 */
function buildAnalyzerGraph() {
  const graph = new StateGraph(AnalyzerAnnotation)
    // --- Register all 4 pipeline nodes ---
    .addNode("filter", filterNode)
    .addNode("sentiment", sentimentNode)
    .addNode("tradeDetect", tradeDetectNode)
    .addNode("recommend", recommendNode)

    // --- Define edges and conditional routing ---
    // Entry: every article starts at the filter node
    .addEdge(START, "filter")

    // Conditional: filter → sentiment (relevant) or END (irrelevant)
    .addConditionalEdges("filter", shouldContinueAfterFilter, {
      sentiment: "sentiment",
      [END]: END,
    })

    // Direct: sentiment always flows to trade detection
    .addEdge("sentiment", "tradeDetect")

    // Conditional: tradeDetect → recommend (trade found) or END (no trade)
    .addConditionalEdges("tradeDetect", shouldContinueAfterTradeDetect, {
      recommend: "recommend",
      [END]: END,
    })

    // Terminal: recommendation is the final stage
    .addEdge("recommend", END);

  return graph.compile();
}

/**
 * Compiled LangGraph.js analysis pipeline — singleton instance.
 *
 * The graph is compiled once at module load time and reused for all
 * subsequent `analyzeArticle()` invocations. LangGraph's `compile()` method
 * is synchronous and produces an immutable graph structure that can be
 * safely invoked concurrently.
 *
 * Exported for direct testing of the compiled graph's `invoke()` method
 * in unit tests where fine-grained control over initial state is needed.
 */
export const compiledGraph = buildAnalyzerGraph();

// ---------------------------------------------------------------------------
// Primary Analysis Function
// ---------------------------------------------------------------------------

/**
 * Analyzes a news article through the full LangGraph.js AI analysis pipeline.
 *
 * This is the primary entry point consumed by the analysis queue worker
 * (`queues/workers/analysis.worker.ts`). It:
 *   1. Creates an initial pipeline state with the article data
 *   2. Invokes the compiled LangGraph pipeline
 *   3. Returns the final state containing all analysis results
 *
 * The pipeline automatically short-circuits at two conditional edges:
 *   - After `filter`: ~75% of articles terminate here (not relevant)
 *   - After `tradeDetect`: Articles without trade opportunities terminate here
 *
 * Only the ~25% of articles that pass both gates reach the expensive
 * Claude Sonnet 4.6 recommendation model.
 *
 * @param article - Input article data with the essential fields needed by
 *                  the pipeline. Structurally compatible with `ArticleInput`
 *                  from `state.ts`.
 * @returns The final `AnalyzerState` containing:
 *   - `isRelevant` — Whether the article passed the relevance filter
 *   - `relevanceScore` — Numeric relevance score (0.0–1.0)
 *   - `filterResult` — Full filter stage output (if processed)
 *   - `sentimentAnalysis` — Sentiment analysis results (if relevant)
 *   - `tradeDetected` — Whether a trade opportunity was identified
 *   - `tradeDetails` — Trade detection details (if trade found)
 *   - `recommendation` — Full trade recommendation (if trade detected)
 *   - `pipelineStep` — Last executed pipeline step
 *   - `errors` — Accumulated error messages from any stage
 * @throws Re-throws any unrecoverable error from the LangGraph pipeline
 *         invocation. The calling worker is responsible for retry logic.
 *
 * @example
 * ```typescript
 * import { analyzeArticle } from "../services/analyzer/index.js";
 *
 * const result = await analyzeArticle({
 *   id: "550e8400-e29b-41d4-a716-446655440000",
 *   title: "NVIDIA Reports Record Q4 Revenue",
 *   content: "NVIDIA Corporation reported quarterly revenue of $22.1B...",
 *   url: "https://example.com/nvidia-q4",
 *   source: "finnhub",
 *   market: "us_stock",
 *   symbols: ["NVDA"],
 *   publishedAt: "2026-03-14T10:30:00Z",
 * });
 *
 * if (result.recommendation) {
 *   // Trade recommendation generated — dispatch notification
 * }
 * ```
 */
export async function analyzeArticle(
  article: AnalyzeArticleInput,
): Promise<AnalyzerState> {
  logger.info(
    { articleId: article.id, title: article.title, market: article.market },
    "Starting analysis pipeline",
  );

  try {
    const result = await compiledGraph.invoke({
      article,
      pipelineStep: "filter" as const,
      errors: [],
    });

    const typedResult = result as AnalyzerState;

    logger.info(
      {
        articleId: article.id,
        isRelevant: typedResult.isRelevant,
        tradeDetected: typedResult.tradeDetected,
        finalStep: typedResult.pipelineStep,
        errorCount: typedResult.errors.length,
      },
      "Analysis pipeline completed",
    );

    return typedResult;
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown pipeline error";

    logger.error(
      { articleId: article.id, error: errorMessage },
      "Analysis pipeline failed",
    );

    throw error;
  }
}
