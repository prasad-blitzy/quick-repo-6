/**
 * Sentiment Analysis Node — LangGraph Analysis Pipeline Stage 2
 *
 * Performs **nuanced financial sentiment analysis** using **Claude Haiku 4.5**
 * via OpenRouter ($1.00 input / $5.00 output per 1M tokens). This node only
 * executes on articles that passed the binary relevance filter (Stage 1),
 * meaning roughly ~25% of all ingested articles reach this stage.
 *
 * Pipeline position: filter → **sentiment** → tradeDetect → (conditional)
 *
 * There is NO conditional edge after this node — it always transitions to
 * the tradeDetect node. The conditional short-circuiting that achieves ~75%
 * cost reduction occurs at the filter→sentiment and tradeDetect→recommend
 * boundaries, not here.
 *
 * CRITICAL — AAP Rule 0.7.3 compliance:
 *   - Temperature = 0 for deterministic financial analysis (enforced by models.ts)
 *   - Structured output via `withStructuredOutput(SentimentResultSchema)`
 *   - DK-CoT (Domain Knowledge Chain-of-Thought) prompting with financial
 *     domain knowledge embedded in SENTIMENT_SYSTEM_PROMPT
 *   - **Negative news weighting**: Negative financial news weighted 2–3×
 *     higher than positive news (earnings miss 2.5×, analyst downgrade 2×,
 *     regulatory investigation 3×, guidance cut 2.5×) — handled at the
 *     prompt level, not in code
 *   - Anti-hallucination safeguards: prompt instructs model to NOT fabricate
 *     price targets, earnings numbers, or analyst ratings
 *
 * CRITICAL — AAP Rule 0.7.2 compliance:
 *   - Sentiment scores range -1.000 to 1.000 (numeric(5,3) precision)
 *   - Seven-level granularity: strongly_negative through strongly_positive
 *
 * @module services/analyzer/nodes/sentiment
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import type { AnalyzerState } from "../state.js";
import { SentimentResultSchema } from "../schemas.js";
import {
  SENTIMENT_SYSTEM_PROMPT,
  buildArticlePrompt,
} from "../prompts.js";
import { getSentimentModel } from "../models.js";
import { createLogger } from "../../../lib/logger.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "analyzer:sentiment" }` context for
 * structured logging of the sentiment analysis lifecycle: pipeline start
 * with article ID and title, successful analysis results (sentimentScore,
 * sentimentLabel, keyFactors), and error handling with unknown error type.
 */
const logger = createLogger("analyzer:sentiment");

// ---------------------------------------------------------------------------
// Sentiment Node Function
// ---------------------------------------------------------------------------

/**
 * LangGraph node function for Stage 2 — Financial Sentiment Analysis.
 *
 * Receives the full `AnalyzerState` (which includes the article data and
 * results from the prior filter stage) and returns a partial state update
 * with sentiment analysis results.
 *
 * The function:
 * 1. Guards against null article (returns error state immediately)
 * 2. Creates a Claude Haiku 4.5 model instance via `getSentimentModel()`
 *    with temperature=0 for deterministic financial analysis
 * 3. Binds `SentimentResultSchema` via `withStructuredOutput()` for typed,
 *    Zod-validated LLM responses
 * 4. Constructs chat messages:
 *    - `SystemMessage` with `SENTIMENT_SYSTEM_PROMPT` containing DK-CoT
 *      financial domain knowledge, negative news 2–3× weighting instructions,
 *      contextual sentiment modifiers, crypto-specific guidelines,
 *      anti-hallucination rules, and 3 few-shot examples
 *    - `HumanMessage` with `buildArticlePrompt(article)` containing article
 *      title, content, source, market, and symbols
 * 5. Invokes the model and returns the structured `SentimentResult`
 *
 * Return state fields:
 * - `sentimentAnalysis` — `SentimentResult | null` with sentimentScore
 *   (-1.0 to 1.0), sentimentLabel (7 levels), reasoning (DK-CoT analysis),
 *   and keyFactors (sentiment drivers array)
 * - `pipelineStep` — Set to `"sentiment"` to track pipeline progress
 * - `errors` — Only populated on failure; uses the accumulator reducer
 *   so errors from the filter stage are preserved
 *
 * @param state - Full analyzer pipeline state containing the article and
 *                prior stage results
 * @returns Partial state update with sentiment analysis results or error info
 */
export async function sentimentNode(
  state: AnalyzerState,
): Promise<Partial<AnalyzerState>> {
  const article = state.article;

  // -------------------------------------------------------------------------
  // Null Article Guard
  // -------------------------------------------------------------------------

  if (!article) {
    logger.error("Sentiment node received null article");
    return {
      sentimentAnalysis: null,
      pipelineStep: "sentiment",
      errors: ["Sentiment node received null article"],
    };
  }

  logger.info(
    { articleId: article.id, title: article.title },
    "Starting sentiment analysis",
  );

  try {
    // -----------------------------------------------------------------------
    // Model Setup — Claude Haiku 4.5 via OpenRouter (temperature: 0)
    // -----------------------------------------------------------------------

    const model = getSentimentModel();
    const modelWithOutput = model.withStructuredOutput(SentimentResultSchema);

    // -----------------------------------------------------------------------
    // Message Construction — DK-CoT System Prompt + Article Content
    // -----------------------------------------------------------------------

    const systemMessage = new SystemMessage(SENTIMENT_SYSTEM_PROMPT);
    const humanMessage = new HumanMessage(buildArticlePrompt(article));

    // -----------------------------------------------------------------------
    // LLM Invocation — Structured Sentiment Analysis
    // -----------------------------------------------------------------------

    const result = await modelWithOutput.invoke([systemMessage, humanMessage]);

    logger.info(
      {
        articleId: article.id,
        sentimentScore: result.sentimentScore,
        sentimentLabel: result.sentimentLabel,
        keyFactors: result.keyFactors,
      },
      "Sentiment analysis complete",
    );

    return {
      sentimentAnalysis: result,
      pipelineStep: "sentiment",
    };
  } catch (error: unknown) {
    // -----------------------------------------------------------------------
    // Error Handling — Catch unknown, log context, return error state
    // -----------------------------------------------------------------------

    const errorMessage =
      error instanceof Error ? error.message : "Unknown sentiment error";

    logger.error(
      { articleId: article.id, error },
      "Sentiment node failed",
    );

    return {
      sentimentAnalysis: null,
      pipelineStep: "sentiment",
      errors: [`Sentiment error: ${errorMessage}`],
    };
  }
}
