/**
 * Filter Node — Binary Relevance Classification (Stage 1)
 *
 * The FIRST node in the LangGraph.js AI analysis pipeline. Performs binary
 * relevance classification using **DeepSeek V3.2** ($0.25/1M tokens — the
 * cheapest model in the tiered strategy) to determine whether an incoming
 * news article is financially relevant.
 *
 * Short-circuit behaviour:
 *   - Articles classified as `isRelevant: false` (~75%) are routed to END
 *     by the conditional edge in the StateGraph, preventing them from
 *     reaching the more expensive downstream models (Haiku, Sonnet).
 *   - This achieves approximately **75% LLM cost reduction** across the
 *     overall pipeline.
 *
 * Model configuration:
 *   - Model: DeepSeek V3.2 via OpenRouter (`deepseek/deepseek-v3-0324`)
 *   - Temperature: 0 (deterministic — AAP Rule 0.7.3)
 *   - Structured output: Zod schema → `FilterResultSchema`
 *   - DK-CoT prompting: Financial domain knowledge chain-of-thought
 *   - Anti-hallucination safeguards embedded in system prompt
 *
 * Integration:
 *   - Registered as the `"filter"` node in `analyzer/index.ts`
 *   - Pipeline path: START → filter → (conditional edge on `isRelevant`)
 *   - Consumes `state.article` and produces `isRelevant`, `relevanceScore`,
 *     `filterResult`, and `pipelineStep` state updates.
 *
 * Error handling:
 *   - Fail-safe: on any error, returns `isRelevant: false` so the article
 *     will NOT proceed to expensive downstream models.
 *   - Error messages are accumulated in the `errors` state channel via the
 *     accumulator reducer defined in `state.ts`.
 *
 * @module services/analyzer/nodes/filter
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import type { AnalyzerState } from "../state.js";
import { FilterResultSchema } from "../schemas.js";
import { FILTER_SYSTEM_PROMPT, buildArticlePrompt } from "../prompts.js";
import { getFilterModel } from "../models.js";
import { createLogger } from "../../../lib/logger.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "analyzer:filter" }` context for
 * structured logging of the filter node lifecycle including:
 *   - Pipeline start with article ID and title
 *   - Successful filter results (isRelevant, relevanceScore)
 *   - Null article error handling
 *   - LLM invocation failures with error details
 */
const logger = createLogger("analyzer:filter");

// ---------------------------------------------------------------------------
// Filter Node Function
// ---------------------------------------------------------------------------

/**
 * LangGraph node function that performs binary relevance classification on
 * a news article using DeepSeek V3.2 via OpenRouter.
 *
 * The function receives the full `AnalyzerState` (populated with an article
 * by the analysis worker before pipeline invocation) and returns a partial
 * state update containing only the fields it modifies:
 *   - `isRelevant` — Boolean flag used by conditional edge routing
 *   - `relevanceScore` — Numeric score 0.0–1.0 from the LLM
 *   - `filterResult` — Full structured output including reasoning
 *   - `pipelineStep` — Set to `"filter"` to track pipeline progress
 *   - `errors` — Populated only on failure (accumulator reducer appends)
 *
 * @param state - The current LangGraph pipeline state containing the article
 *                to classify and any prior state from previous invocations.
 * @returns Partial state update with filter classification results.
 *
 * @example
 * ```typescript
 * // Used in LangGraph StateGraph assembly:
 * const graph = new StateGraph(AnalyzerAnnotation)
 *   .addNode("filter", filterNode)
 *   .addConditionalEdges("filter", routeAfterFilter)
 *   .compile();
 * ```
 */
export async function filterNode(
  state: AnalyzerState,
): Promise<Partial<AnalyzerState>> {
  const article = state.article;

  // -------------------------------------------------------------------------
  // Guard: Null article — fail-safe early return
  // -------------------------------------------------------------------------

  if (!article) {
    logger.error("Filter node received null article");
    return {
      isRelevant: false,
      relevanceScore: 0,
      filterResult: null,
      pipelineStep: "filter",
      errors: ["Filter node received null article"],
    };
  }

  logger.info(
    { articleId: article.id, title: article.title },
    "Starting filter analysis",
  );

  try {
    // -----------------------------------------------------------------------
    // Model setup — DeepSeek V3.2 with structured output validation
    // -----------------------------------------------------------------------

    const model = getFilterModel();
    const modelWithOutput = model.withStructuredOutput(FilterResultSchema);

    // -----------------------------------------------------------------------
    // Message construction — DK-CoT system prompt + article content
    // -----------------------------------------------------------------------

    const systemMessage = new SystemMessage(FILTER_SYSTEM_PROMPT);
    const humanMessage = new HumanMessage(buildArticlePrompt(article));

    // -----------------------------------------------------------------------
    // LLM invocation — returns typed FilterResult via Zod validation
    // -----------------------------------------------------------------------

    const result = await modelWithOutput.invoke([systemMessage, humanMessage]);

    logger.info(
      {
        articleId: article.id,
        isRelevant: result.isRelevant,
        relevanceScore: result.relevanceScore,
      },
      "Filter analysis complete",
    );

    // -----------------------------------------------------------------------
    // Success return — only populate fields this node owns
    // -----------------------------------------------------------------------

    return {
      isRelevant: result.isRelevant,
      relevanceScore: result.relevanceScore,
      filterResult: result,
      pipelineStep: "filter",
    };
  } catch (error: unknown) {
    // -----------------------------------------------------------------------
    // Error handling — fail-safe: article will NOT proceed to expensive models
    // -----------------------------------------------------------------------

    const errorMessage =
      error instanceof Error ? error.message : "Unknown filter error";

    logger.error(
      { articleId: article.id, error },
      "Filter node failed",
    );

    return {
      isRelevant: false,
      relevanceScore: 0,
      filterResult: null,
      pipelineStep: "filter",
      errors: [`Filter error: ${errorMessage}`],
    };
  }
}
