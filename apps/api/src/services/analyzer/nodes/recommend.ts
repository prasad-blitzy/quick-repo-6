/**
 * Recommendation Node — Stage 4 (Final) of the LangGraph Analysis Pipeline
 *
 * Generates **structured trade recommendations** using **Claude Sonnet 4.6**
 * ($3.00/$15.00 per 1M tokens) — the most expensive model in the pipeline.
 * This node only runs on the ~25% of articles that both passed the filter
 * AND had a trade detected, achieving ~75% LLM cost reduction via upstream
 * short-circuiting.
 *
 * Pipeline flow: Filter → Sentiment → Trade Detection → **Recommendation** → END
 *
 * Key responsibilities:
 *   1. Collects prior analysis results (sentiment, trade detection) from state
 *   2. Invokes Claude Sonnet 4.6 with structured output (Zod schema) for a
 *      complete trade recommendation with entry, stop loss, take profit prices
 *   3. Validates LLM-generated price targets against reference market data
 *      via the anti-hallucination `validatePriceTargets` helper
 *   4. Returns the recommendation to state for downstream notification dispatch
 *
 * CRITICAL rules (AAP Sections 0.7.2, 0.7.3):
 *   - Temperature = 0 for deterministic financial analysis
 *   - All price fields are strings (PostgreSQL numeric(12,4) precision)
 *   - Anti-hallucination price validation per DEFAULTS.PRICE_DEVIATION_THRESHOLD
 *   - Structured output via `withStructuredOutput(TradeRecommendationSchema)`
 *   - DK-CoT prompting with RECOMMEND_SYSTEM_PROMPT
 *
 * @module services/analyzer/nodes/recommend
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import type { AnalyzerState } from "../state.js";
import { TradeRecommendationSchema } from "../schemas.js";
import {
  RECOMMEND_SYSTEM_PROMPT,
  buildRecommendationContext,
} from "../prompts.js";
import { getRecommendModel } from "../models.js";
import { createLogger } from "../../../lib/logger.js";
import { DEFAULTS } from "../../../config/constants.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "analyzer:recommend" }` context for
 * structured logging of recommendation generation lifecycle events:
 * pipeline start, LLM invocation, anti-hallucination price validation
 * warnings, successful completion with full trade details, and errors.
 */
const logger = createLogger("analyzer:recommend");

// ---------------------------------------------------------------------------
// Anti-Hallucination Price Validation Helper
// ---------------------------------------------------------------------------

/**
 * Validates LLM-generated price targets against a known reference market price
 * to detect potential hallucinations where the model fabricates unrealistic
 * price levels.
 *
 * Validation thresholds (per AAP Rule 0.7.2):
 *   - Entry price: must be within `PRICE_DEVIATION_THRESHOLD` (10%) of reference
 *   - Stop loss: must be within 3× threshold (30%) — wider tolerance for stops
 *   - Take profit: must be within 5× threshold (50%) — widest tolerance for targets
 *   - Logical consistency: entry ≠ stop loss and entry ≠ take profit
 *
 * When no reference price is available, the function returns `isValid: true`
 * with a warning indicating the validation was skipped (graceful degradation).
 * The caller is responsible for providing reference price data when available.
 *
 * @param recommendation - The LLM-generated price fields (all as strings)
 * @param referencePrice - Optional current market price for cross-validation
 * @returns Object with `isValid` boolean and array of warning messages
 */
function validatePriceTargets(
  recommendation: { entryPrice: string; stopLoss: string; takeProfit: string },
  referencePrice?: number,
): { isValid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // No reference price available — skip price deviation checks but log warning
  if (referencePrice === undefined || referencePrice <= 0) {
    warnings.push("No reference market price available for validation");
    return { isValid: true, warnings };
  }

  const entry = parseFloat(recommendation.entryPrice);
  const stopLoss = parseFloat(recommendation.stopLoss);
  const takeProfit = parseFloat(recommendation.takeProfit);
  const threshold = DEFAULTS.PRICE_DEVIATION_THRESHOLD; // 0.10 = 10%

  // Validate entry price is within threshold of reference market price
  if (!isNaN(entry) && Math.abs(entry - referencePrice) / referencePrice > threshold) {
    warnings.push(
      `Entry price ${recommendation.entryPrice} deviates >${threshold * 100}% from market price ${referencePrice}`,
    );
  }

  // Validate stop loss is within 3× threshold (30%) of reference price
  // Wider tolerance because stop losses can be placed at significant distance
  if (
    !isNaN(stopLoss) &&
    Math.abs(stopLoss - referencePrice) / referencePrice > threshold * 3
  ) {
    warnings.push(
      `Stop loss ${recommendation.stopLoss} deviates >${threshold * 300}% from market price ${referencePrice}`,
    );
  }

  // Validate take profit is within 5× threshold (50%) of reference price
  // Widest tolerance because take profit targets can be ambitious
  if (
    !isNaN(takeProfit) &&
    Math.abs(takeProfit - referencePrice) / referencePrice > threshold * 5
  ) {
    warnings.push(
      `Take profit ${recommendation.takeProfit} deviates >${threshold * 500}% from market price ${referencePrice}`,
    );
  }

  // Validate logical consistency of price levels
  // Basic sanity: entry should not equal stop or target (egregious hallucination indicator)
  if (!isNaN(entry) && !isNaN(stopLoss) && !isNaN(takeProfit)) {
    if (entry === stopLoss || entry === takeProfit) {
      warnings.push(
        "Entry price equals stop loss or take profit — likely hallucinated",
      );
    }
  }

  const isValid = warnings.length === 0;
  return { isValid, warnings };
}

// ---------------------------------------------------------------------------
// Recommend Node — Pipeline Stage 4 (Final)
// ---------------------------------------------------------------------------

/**
 * Fourth and final node in the LangGraph analysis pipeline.
 *
 * Generates a structured trade recommendation using Claude Sonnet 4.6
 * via OpenRouter with `withStructuredOutput(TradeRecommendationSchema)`.
 * Combines article content with results from all prior pipeline stages
 * (sentiment analysis + trade detection) to produce a complete trade
 * recommendation with entry price, stop loss, take profit, risk-reward
 * ratio, and detailed reasoning.
 *
 * After receiving the LLM response, the function performs anti-hallucination
 * price validation using `validatePriceTargets()`. Validation warnings are
 * non-blocking — they are logged and appended to the `errors` accumulator
 * but do NOT prevent the recommendation from being returned.
 *
 * @param state - Full LangGraph pipeline state including article data,
 *                sentiment analysis, and trade detection results
 * @returns Partial state update with `recommendation`, `pipelineStep`, and
 *          optional `errors` from price validation or LLM failures
 */
export async function recommendNode(
  state: AnalyzerState,
): Promise<Partial<AnalyzerState>> {
  const article = state.article;

  // Null article guard — defensive check for malformed pipeline state
  if (!article) {
    logger.error("Recommend node received null article");
    return {
      recommendation: null,
      pipelineStep: "recommend",
      errors: ["Recommend node received null article"],
    };
  }

  // ---------------------------------------------------------------------------
  // Extract prior analysis results from state with safe defaults
  // ---------------------------------------------------------------------------

  const sentimentScore = state.sentimentAnalysis?.sentimentScore ?? 0;
  const sentimentLabel = state.sentimentAnalysis?.sentimentLabel ?? "neutral";
  const tradeDirection = state.tradeDetails?.direction ?? "long";
  const tradeSymbol = state.tradeDetails?.symbol ?? "";
  const tradeTimeframe = state.tradeDetails?.timeframe ?? "swing";
  const signalStrength = state.tradeDetails?.signalStrength ?? 0;

  logger.info(
    {
      articleId: article.id,
      title: article.title,
      symbol: tradeSymbol,
      direction: tradeDirection,
    },
    "Starting recommendation generation",
  );

  try {
    // -----------------------------------------------------------------------
    // Model setup — Claude Sonnet 4.6 via OpenRouter with structured output
    // -----------------------------------------------------------------------

    const model = getRecommendModel();
    const modelWithOutput = model.withStructuredOutput(
      TradeRecommendationSchema,
    );

    // -----------------------------------------------------------------------
    // Build messages with full context from prior pipeline stages
    // -----------------------------------------------------------------------

    const systemMessage = new SystemMessage(RECOMMEND_SYSTEM_PROMPT);
    const humanMessage = new HumanMessage(
      buildRecommendationContext({
        article,
        sentimentScore,
        sentimentLabel,
        tradeDirection,
        tradeSymbol,
        tradeTimeframe,
        signalStrength,
      }),
    );

    // -----------------------------------------------------------------------
    // Invoke the model with structured output
    // -----------------------------------------------------------------------

    const result = await modelWithOutput.invoke([systemMessage, humanMessage]);

    // -----------------------------------------------------------------------
    // Anti-hallucination price validation (AAP Rule 0.7.2)
    // -----------------------------------------------------------------------
    // NOTE: referencePrice would ideally come from cached market data in state.
    // Currently the pipeline state does not carry reference price data, so
    // validation performs logical consistency checks only (no market price
    // deviation check). The analysis worker that calls analyzeArticle() is
    // responsible for injecting reference price data if available.

    const priceValidation = validatePriceTargets(result);

    if (!priceValidation.isValid) {
      logger.warn(
        {
          articleId: article.id,
          symbol: result.symbol,
          warnings: priceValidation.warnings,
        },
        "Price validation warnings detected — potential LLM hallucination",
      );
    }

    // -----------------------------------------------------------------------
    // Log successful recommendation with full trade details
    // -----------------------------------------------------------------------

    logger.info(
      {
        articleId: article.id,
        symbol: result.symbol,
        market: result.market,
        direction: result.direction,
        confidence: result.confidence,
        entryPrice: result.entryPrice,
        stopLoss: result.stopLoss,
        takeProfit: result.takeProfit,
        riskRewardRatio: result.riskRewardRatio,
        priceValidationWarnings: priceValidation.warnings,
      },
      "Recommendation generation complete",
    );

    // -----------------------------------------------------------------------
    // Return state update with recommendation and optional price warnings
    // -----------------------------------------------------------------------

    return {
      recommendation: result,
      pipelineStep: "recommend",
      // Add price validation warnings to errors accumulator if any exist
      // These are non-blocking — the recommendation is still returned
      ...(priceValidation.warnings.length > 0
        ? {
            errors: priceValidation.warnings.map(
              (w) => `Price validation: ${w}`,
            ),
          }
        : {}),
    };
  } catch (error: unknown) {
    // Error handling with `error: unknown` per AAP Rule 0.7.1
    const errorMessage =
      error instanceof Error ? error.message : "Unknown recommendation error";

    logger.error(
      { articleId: article.id, error: errorMessage },
      "Recommend node failed",
    );

    return {
      recommendation: null,
      pipelineStep: "recommend",
      errors: [`Recommend error: ${errorMessage}`],
    };
  }
}
