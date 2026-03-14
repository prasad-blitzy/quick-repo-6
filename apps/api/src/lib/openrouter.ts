/**
 * OpenRouter ChatOpenAI Client Factory
 *
 * Unified LLM gateway factory for the Trading Intelligence Application.
 * Creates {@link ChatOpenAI} instances from `@langchain/openai` configured to
 * use OpenRouter (https://openrouter.ai/api/v1) as the API backend instead of
 * OpenAI directly. This enables tiered model routing through a single gateway:
 *
 * | Pipeline Stage   | Model              | Cost (input/output per 1M tokens) |
 * |------------------|--------------------|-----------------------------------|
 * | Filtering        | DeepSeek V3.2      | $0.25 / $0.38                     |
 * | Sentiment        | Claude Haiku 4.5   | $1.00 / $5.00                     |
 * | Trade Detection  | Claude Haiku 4.5   | $1.00 / $5.00                     |
 * | Recommendation   | Claude Sonnet 4.6  | $3.00 / $15.00                    |
 *
 * **CRITICAL**: Every model instance defaults to `temperature = 0` for
 * deterministic, reproducible financial analysis (AAP Rule 0.7.3).
 *
 * @module lib/openrouter
 * @see {@link https://openrouter.ai/docs} OpenRouter API documentation
 */

import { ChatOpenAI } from "@langchain/openai";
import { env } from "../config/env.js";
import { createLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "openrouter" }` context for structured
 * logging of model instance creation and configuration events.
 */
const logger = createLogger("openrouter");

// ---------------------------------------------------------------------------
// Model Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Configuration options for creating OpenRouter model instances.
 *
 * All properties are optional — sensible defaults are applied:
 * - `temperature` defaults to `0` (deterministic financial analysis)
 * - `maxTokens` is unconstrained when omitted (model decides)
 * - `modelName` defaults to the environment-configured model ID
 *
 * @example
 * ```typescript
 * import { createModel, type ModelOptions } from "../lib/openrouter.js";
 *
 * // Use default temperature=0, override max tokens
 * const model = createModel("deepseek/deepseek-v3-0324", { maxTokens: 512 });
 * ```
 */
export interface ModelOptions {
  /**
   * Sampling temperature for the model response.
   *
   * **CRITICAL**: Defaults to `0` for deterministic, reproducible financial
   * analysis. This is a non-negotiable requirement from AAP Rule 0.7.3.
   * Override to a non-zero value ONLY for non-financial use cases.
   */
  temperature?: number;

  /**
   * Maximum number of tokens the model may generate in its response.
   * When omitted, the model uses its own default maximum context limit.
   * Use this to control per-call token budgets and costs.
   */
  maxTokens?: number;

  /**
   * Override the model identifier. When provided, this takes precedence
   * over the `modelId` argument passed to {@link createModel}.
   *
   * Model IDs use the OpenRouter format: `"provider/model-name"`.
   * Examples: `"deepseek/deepseek-v3-0324"`, `"anthropic/claude-haiku-4-5-20241022"`.
   */
  modelName?: string;
}

// ---------------------------------------------------------------------------
// Core Factory Function
// ---------------------------------------------------------------------------

/**
 * Creates a {@link ChatOpenAI} instance configured to route through OpenRouter.
 *
 * The returned instance behaves identically to a standard OpenAI ChatOpenAI
 * model, but all inference requests are proxied through OpenRouter's unified
 * API gateway. This enables access to models from multiple providers (DeepSeek,
 * Anthropic, etc.) using a single API key and consistent interface.
 *
 * @param modelId — OpenRouter model identifier (e.g., `"deepseek/deepseek-v3-0324"`).
 *                   Overridden by `options.modelName` if provided.
 * @param options — Optional configuration overrides. See {@link ModelOptions}.
 * @returns A configured ChatOpenAI instance ready for `.invoke()` or
 *          `.withStructuredOutput()` calls.
 *
 * @example
 * ```typescript
 * const model = createModel("anthropic/claude-sonnet-4-6-20250514", {
 *   maxTokens: 2048,
 * });
 *
 * const response = await model.invoke([
 *   { role: "system", content: "You are a financial analyst." },
 *   { role: "user", content: "Analyze AAPL earnings." },
 * ]);
 * ```
 */
export function createModel(
  modelId: string,
  options?: ModelOptions,
): ChatOpenAI {
  const resolvedModel = options?.modelName ?? modelId;
  const resolvedTemperature = options?.temperature ?? 0;

  // Build constructor arguments, conditionally including maxTokens only when
  // explicitly provided to respect exactOptionalPropertyTypes strictness.
  const constructorArgs: Record<string, unknown> = {
    model: resolvedModel,
    temperature: resolvedTemperature,
    apiKey: env.OPENROUTER_API_KEY,
    configuration: {
      baseURL: env.OPENROUTER_BASE_URL,
    },
  };

  if (options?.maxTokens !== undefined) {
    constructorArgs["maxTokens"] = options.maxTokens;
  }

  const model = new ChatOpenAI(
    constructorArgs as ConstructorParameters<typeof ChatOpenAI>[0],
  );

  logger.debug(
    { modelId: resolvedModel, temperature: resolvedTemperature },
    "Created OpenRouter model instance",
  );

  return model;
}

// ---------------------------------------------------------------------------
// Pre-configured Pipeline Stage Factories
// ---------------------------------------------------------------------------

/**
 * Creates a ChatOpenAI model instance configured for the **Filter** pipeline
 * stage using the environment-configured filter model.
 *
 * Default model: DeepSeek V3.2 (`deepseek/deepseek-v3-0324`)
 * Cost: $0.25 / $0.38 per 1M tokens (input/output)
 * Purpose: Binary relevance classification — determines whether a news article
 * is financially relevant enough to proceed to sentiment analysis.
 *
 * @param options — Optional temperature and maxTokens overrides.
 *                   `modelName` is excluded; the env-configured model is always used.
 * @returns A ChatOpenAI instance configured for filtering.
 *
 * @example
 * ```typescript
 * const filterModel = createFilterModel({ maxTokens: 128 });
 * const result = await filterModel.invoke(filterPrompt);
 * ```
 */
export function createFilterModel(
  options?: Omit<ModelOptions, "modelName">,
): ChatOpenAI {
  return createModel(env.FILTER_MODEL, options);
}

/**
 * Creates a ChatOpenAI model instance configured for the **Sentiment** pipeline
 * stage using the environment-configured sentiment model.
 *
 * Default model: Claude Haiku 4.5 (`anthropic/claude-haiku-4-5-20241022`)
 * Cost: $1.00 / $5.00 per 1M tokens (input/output)
 * Purpose: Nuanced financial sentiment analysis with negative news weighting
 * (2–3x impact multiplier per AAP Rule 0.7.3).
 *
 * @param options — Optional temperature and maxTokens overrides.
 * @returns A ChatOpenAI instance configured for sentiment analysis.
 */
export function createSentimentModel(
  options?: Omit<ModelOptions, "modelName">,
): ChatOpenAI {
  return createModel(env.SENTIMENT_MODEL, options);
}

/**
 * Creates a ChatOpenAI model instance configured for the **Trade Detection**
 * pipeline stage using the environment-configured trade detection model.
 *
 * Default model: Claude Haiku 4.5 (`anthropic/claude-haiku-4-5-20241022`)
 * Cost: $1.00 / $5.00 per 1M tokens (input/output)
 * Purpose: Identifies actionable trade opportunities from sentiment-analyzed
 * articles — determines direction (LONG/SHORT), affected symbols, and
 * preliminary confidence scoring.
 *
 * @param options — Optional temperature and maxTokens overrides.
 * @returns A ChatOpenAI instance configured for trade detection.
 */
export function createTradeDetectModel(
  options?: Omit<ModelOptions, "modelName">,
): ChatOpenAI {
  return createModel(env.TRADE_DETECT_MODEL, options);
}

/**
 * Creates a ChatOpenAI model instance configured for the **Recommendation**
 * pipeline stage using the environment-configured recommendation model.
 *
 * Default model: Claude Sonnet 4.6 (`anthropic/claude-sonnet-4-6-20250514`)
 * Cost: $3.00 / $15.00 per 1M tokens (input/output)
 * Purpose: Generates structured trade recommendations with entry price, stop
 * loss, take profit targets, risk-reward ratio, and detailed reasoning.
 * Only ~25% of articles reach this stage due to conditional short-circuiting
 * in the LangGraph pipeline, achieving ~75% LLM cost reduction.
 *
 * This model is typically used with `.withStructuredOutput()` and Zod schemas
 * for type-safe, parseable recommendation objects.
 *
 * @param options — Optional temperature and maxTokens overrides.
 * @returns A ChatOpenAI instance configured for trade recommendation generation.
 *
 * @example
 * ```typescript
 * import { z } from "zod";
 *
 * const recommendModel = createRecommendModel({ maxTokens: 4096 });
 * const structured = recommendModel.withStructuredOutput(tradeRecommendationSchema);
 * const recommendation = await structured.invoke(recommendPrompt);
 * ```
 */
export function createRecommendModel(
  options?: Omit<ModelOptions, "modelName">,
): ChatOpenAI {
  return createModel(env.RECOMMEND_MODEL, options);
}
