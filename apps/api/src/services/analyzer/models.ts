/**
 * Per-Stage Model Configuration — LangGraph Analysis Pipeline
 *
 * Maps each of the 4 pipeline stages to its designated OpenRouter model via
 * pre-configured factory functions from `lib/openrouter.ts`. This module is
 * the **single source of truth** for model assignment, cost documentation,
 * and token budget configuration consumed by the pipeline node functions.
 *
 * Tiered model strategy (AAP Section 0.1.2):
 *
 * | Pipeline Stage   | Model              | Cost (input / output per 1M tokens) |
 * |------------------|--------------------|-------------------------------------|
 * | Filter           | DeepSeek V3.2      | $0.25 / $0.38                       |
 * | Sentiment        | Claude Haiku 4.5   | $1.00 / $5.00                       |
 * | Trade Detection  | Claude Haiku 4.5   | $1.00 / $5.00                       |
 * | Recommendation   | Claude Sonnet 4.6  | $3.00 / $15.00                      |
 *
 * **CRITICAL**: Every model getter enforces `temperature = 0` via
 * `PIPELINE.TEMPERATURE` from constants.ts for deterministic, reproducible
 * financial analysis (AAP Rule 0.7.3). This value is NEVER hardcoded.
 *
 * @module services/analyzer/models
 */

import {
  createFilterModel,
  createSentimentModel,
  createTradeDetectModel,
  createRecommendModel,
} from "../../lib/openrouter.js";
import { createLogger } from "../../lib/logger.js";
import { PIPELINE } from "../../config/constants.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "analyzer:models" }` context for
 * structured logging of model instance creation events at debug level.
 */
const logger = createLogger("analyzer:models");

// ---------------------------------------------------------------------------
// Model Configuration Constants
// ---------------------------------------------------------------------------

/**
 * Static configuration map documenting model assignments, pipeline stage
 * names, human-readable descriptions, and cost information for each stage.
 *
 * This constant is used for logging, monitoring dashboards, and cost
 * estimation calculations. The `as const` assertion ensures all values
 * are literal types for maximum type safety.
 *
 * Cost information reflects OpenRouter pricing as of March 2026.
 */
export const MODEL_CONFIG = {
  /** Filter stage — binary relevance classification using cheapest model */
  filter: {
    stage: "filter",
    description: "Binary relevance classification — DeepSeek V3.2",
    costPer1MInput: "$0.25",
    costPer1MOutput: "$0.38",
  },
  /** Sentiment stage — nuanced financial sentiment with mid-tier model */
  sentiment: {
    stage: "sentiment",
    description: "Nuanced financial sentiment analysis — Claude Haiku 4.5",
    costPer1MInput: "$1.00",
    costPer1MOutput: "$5.00",
  },
  /** Trade detection stage — opportunity identification with mid-tier model */
  tradeDetect: {
    stage: "trade_detect",
    description: "Trade opportunity detection — Claude Haiku 4.5",
    costPer1MInput: "$1.00",
    costPer1MOutput: "$5.00",
  },
  /** Recommendation stage — structured output using most capable model */
  recommend: {
    stage: "recommend",
    description: "Structured trade recommendation — Claude Sonnet 4.6",
    costPer1MInput: "$3.00",
    costPer1MOutput: "$15.00",
  },
} as const;

// ---------------------------------------------------------------------------
// Token Budget Configuration
// ---------------------------------------------------------------------------

/**
 * Maximum token budgets per pipeline stage to control costs and prevent
 * runaway generation. These values are used by node functions when calling
 * `.withStructuredOutput()` or setting `maxTokens` on model instances.
 *
 * Budget rationale:
 * - **filter (256)**: Binary yes/no classification requires minimal tokens.
 * - **sentiment (512)**: Sentiment analysis needs moderate tokens for
 *   nuanced scoring and brief reasoning.
 * - **tradeDetect (512)**: Trade detection needs moderate tokens to
 *   identify direction, symbols, and preliminary confidence.
 * - **recommend (1024)**: Structured recommendation with entry/stop/target
 *   prices, risk-reward ratio, and detailed reasoning requires the most tokens.
 */
export const TOKEN_BUDGETS = {
  /** Binary classification — minimal token output */
  filter: 256,
  /** Sentiment analysis — moderate token output */
  sentiment: 512,
  /** Trade detection — moderate token output */
  tradeDetect: 512,
  /** Structured recommendation — largest token output */
  recommend: 1024,
} as const;

// ---------------------------------------------------------------------------
// Model Instance Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates and returns a ChatOpenAI model instance configured for the
 * **Filter** pipeline stage (DeepSeek V3.2).
 *
 * This is the cheapest model in the pipeline ($0.25/$0.38 per 1M tokens),
 * used for high-volume binary relevance classification. Every article
 * passes through this stage first, so cost efficiency is critical.
 *
 * The model is created per-call via `createFilterModel()` from
 * `lib/openrouter.ts`, which handles OpenRouter baseURL and API key
 * configuration. Temperature is enforced at 0 via `PIPELINE.TEMPERATURE`
 * for deterministic financial analysis.
 *
 * @returns A ChatOpenAI instance configured for DeepSeek V3.2 via OpenRouter.
 */
export function getFilterModel() {
  logger.debug(
    { stage: MODEL_CONFIG.filter.stage },
    "Creating filter model instance (DeepSeek V3.2)",
  );
  return createFilterModel({ temperature: PIPELINE.TEMPERATURE });
}

/**
 * Creates and returns a ChatOpenAI model instance configured for the
 * **Sentiment** pipeline stage (Claude Haiku 4.5).
 *
 * This mid-tier model ($1.00/$5.00 per 1M tokens) provides nuanced
 * language understanding required for financial sentiment analysis with
 * negative news weighting (2–3x impact per AAP Rule 0.7.3).
 *
 * Only articles that pass the filter stage reach this node, reducing
 * the volume processed by the more expensive model.
 *
 * @returns A ChatOpenAI instance configured for Claude Haiku 4.5 via OpenRouter.
 */
export function getSentimentModel() {
  logger.debug(
    { stage: MODEL_CONFIG.sentiment.stage },
    "Creating sentiment model instance (Claude Haiku 4.5)",
  );
  return createSentimentModel({ temperature: PIPELINE.TEMPERATURE });
}

/**
 * Creates and returns a ChatOpenAI model instance configured for the
 * **Trade Detection** pipeline stage (Claude Haiku 4.5).
 *
 * This mid-tier model ($1.00/$5.00 per 1M tokens) identifies actionable
 * trade opportunities from sentiment-analyzed articles — determining
 * direction (LONG/SHORT), affected symbols, and preliminary confidence.
 *
 * @returns A ChatOpenAI instance configured for Claude Haiku 4.5 via OpenRouter.
 */
export function getTradeDetectModel() {
  logger.debug(
    { stage: MODEL_CONFIG.tradeDetect.stage },
    "Creating trade detect model instance (Claude Haiku 4.5)",
  );
  return createTradeDetectModel({ temperature: PIPELINE.TEMPERATURE });
}

/**
 * Creates and returns a ChatOpenAI model instance configured for the
 * **Recommendation** pipeline stage (Claude Sonnet 4.6).
 *
 * This is the most expensive model in the pipeline ($3.00/$15.00 per 1M
 * tokens), used exclusively for generating structured trade recommendations
 * with entry price, stop loss, take profit targets, risk-reward ratio,
 * and detailed reasoning.
 *
 * Only ~25% of articles reach this stage due to conditional short-circuiting
 * in the LangGraph pipeline, achieving ~75% LLM cost reduction. This model
 * is typically used with `.withStructuredOutput()` and Zod schemas for
 * type-safe, parseable recommendation objects.
 *
 * @returns A ChatOpenAI instance configured for Claude Sonnet 4.6 via OpenRouter.
 */
export function getRecommendModel() {
  logger.debug(
    { stage: MODEL_CONFIG.recommend.stage },
    "Creating recommend model instance (Claude Sonnet 4.6)",
  );
  return createRecommendModel({ temperature: PIPELINE.TEMPERATURE });
}
