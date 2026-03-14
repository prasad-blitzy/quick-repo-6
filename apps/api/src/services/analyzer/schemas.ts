/**
 * @module apps/api/src/services/analyzer/schemas
 *
 * Zod schemas for structured LLM output across all 4 LangGraph analysis pipeline stages.
 *
 * These schemas serve a dual purpose (AAP Section 0.1.2):
 *   1. **Data contract documentation** — Each field's `.describe()` annotation defines
 *      the expected format and semantics, which `ChatOpenAI.withStructuredOutput()` uses
 *      to generate the JSON schema sent to the LLM.
 *   2. **Runtime validation code** — Zod validates every LLM response at runtime,
 *      guaranteeing type-safe, parseable output with no free-form text parsing.
 *
 * Pipeline stages and their designated models (via OpenRouter):
 *   - Filter       → DeepSeek V3.2   ($0.25/1M tokens) — binary relevance classification
 *   - Sentiment    → Claude Haiku 4.5 ($1.00/$5.00)     — nuanced sentiment analysis
 *   - Trade Detect → Claude Haiku 4.5 ($1.00/$5.00)     — opportunity identification
 *   - Recommend    → Claude Sonnet 4.6 ($3.00/$15.00)   — structured trade recommendation
 *
 * CRITICAL — Financial precision rules (AAP Rule 0.7.2):
 *   - All price fields use `z.string()` (mapped to PostgreSQL numeric(12,4)).
 *     NEVER use `z.number()` for monetary values to avoid floating-point precision loss.
 *   - Sentiment scores: `z.number().min(-1).max(1)` for range -1.000 to 1.000.
 *   - Confidence/relevance scores: `z.number().min(0).max(1)` for range 0.00 to 1.00.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Stage 1 — Filter Result Schema (DeepSeek V3.2)
// ---------------------------------------------------------------------------

/**
 * Schema for the binary relevance filter stage output.
 *
 * The filter node classifies whether an incoming news article is financially
 * relevant enough to proceed through the analysis pipeline. Only articles
 * with `isRelevant: true` advance to the sentiment stage, achieving ~75%
 * LLM cost reduction by short-circuiting irrelevant content early.
 *
 * Used with: `filterModel.withStructuredOutput(FilterResultSchema)`
 */
export const FilterResultSchema = z.object({
  /** Whether the article is financially relevant and warrants further analysis. */
  isRelevant: z
    .boolean()
    .describe("Whether the article is financially relevant"),

  /** Relevance score from 0.0 (completely irrelevant) to 1.0 (highly relevant). */
  relevanceScore: z
    .number()
    .min(0)
    .max(1)
    .describe("Relevance score from 0.0 to 1.0"),

  /** Brief explanation of why the article was classified as relevant or irrelevant. */
  reasoning: z
    .string()
    .describe("Brief explanation of relevance determination"),
});

/**
 * Inferred TypeScript type for the filter stage result.
 *
 * @example
 * ```typescript
 * const result: FilterResult = {
 *   isRelevant: true,
 *   relevanceScore: 0.85,
 *   reasoning: "Article discusses AAPL Q2 earnings beat with revenue guidance raise.",
 * };
 * ```
 */
export type FilterResult = z.infer<typeof FilterResultSchema>;

// ---------------------------------------------------------------------------
// Stage 2 — Sentiment Result Schema (Claude Haiku 4.5)
// ---------------------------------------------------------------------------

/**
 * Schema for the sentiment analysis stage output.
 *
 * The sentiment node performs nuanced financial sentiment analysis using
 * Domain Knowledge Chain-of-Thought (DK-CoT) prompting. Negative news is
 * weighted 2–3x higher than positive news (AAP Rule 0.7.3) to reflect
 * empirical market impact research.
 *
 * Used with: `sentimentModel.withStructuredOutput(SentimentResultSchema)`
 */
export const SentimentResultSchema = z.object({
  /**
   * Sentiment score from -1.0 (most negative) to 1.0 (most positive).
   * Maps to PostgreSQL numeric(5,3) for millisentiment precision.
   */
  sentimentScore: z
    .number()
    .min(-1)
    .max(1)
    .describe(
      "Sentiment score from -1.0 (most negative) to 1.0 (most positive)",
    ),

  /** Human-readable sentiment classification across 7 granularity levels. */
  sentimentLabel: z
    .enum([
      "strongly_negative",
      "moderately_negative",
      "slightly_negative",
      "neutral",
      "slightly_positive",
      "moderately_positive",
      "strongly_positive",
    ])
    .describe("Human-readable sentiment label"),

  /**
   * Detailed sentiment analysis incorporating financial domain knowledge.
   * Should reference specific financial indicators, market context, and
   * sector implications identified in the source article.
   */
  reasoning: z
    .string()
    .describe(
      "Detailed sentiment analysis incorporating financial domain knowledge",
    ),

  /**
   * Array of key factors driving the sentiment determination.
   * Each entry should be a concise, specific factor (e.g., "Revenue beat by 12%",
   * "CEO resignation announced", "Regulatory investigation disclosed").
   */
  keyFactors: z
    .array(z.string())
    .describe(
      "Array of key factors driving the sentiment determination",
    ),
});

/**
 * Inferred TypeScript type for the sentiment analysis result.
 *
 * @example
 * ```typescript
 * const result: SentimentResult = {
 *   sentimentScore: -0.72,
 *   sentimentLabel: "moderately_negative",
 *   reasoning: "SEC investigation into accounting irregularities signals material risk...",
 *   keyFactors: [
 *     "SEC formal investigation announced",
 *     "CFO placed on administrative leave",
 *     "Auditor qualification on Q3 financials",
 *   ],
 * };
 * ```
 */
export type SentimentResult = z.infer<typeof SentimentResultSchema>;

// ---------------------------------------------------------------------------
// Stage 3 — Trade Detection Result Schema (Claude Haiku 4.5)
// ---------------------------------------------------------------------------

/**
 * Schema for the trade detection stage output.
 *
 * The trade detection node identifies whether the analyzed article presents
 * an actionable trade opportunity. Only ~25% of articles reaching this stage
 * will have `tradeDetected: true`, triggering advancement to the expensive
 * recommendation model.
 *
 * Fields `symbol`, `direction`, and `timeframe` are optional because they
 * are only populated when `tradeDetected` is `true`.
 *
 * Used with: `tradeDetectModel.withStructuredOutput(TradeDetectionResultSchema)`
 */
export const TradeDetectionResultSchema = z.object({
  /** Whether an actionable trade opportunity was detected in the article. */
  tradeDetected: z
    .boolean()
    .describe("Whether an actionable trade opportunity was detected"),

  /**
   * Stock or crypto ticker symbol (e.g., "AAPL", "BTC", "RELIANCE").
   * Only present when `tradeDetected` is `true`.
   */
  symbol: z
    .string()
    .optional()
    .describe("Stock/crypto ticker symbol (e.g., 'AAPL', 'BTC')"),

  /**
   * Recommended trade direction — LONG (bullish) or SHORT (bearish).
   * Only present when `tradeDetected` is `true`.
   */
  direction: z
    .enum(["LONG", "SHORT"])
    .optional()
    .describe("Recommended trade direction"),

  /**
   * Explanation of the trade detection analysis, including identified
   * catalysts, market context, and the rationale for the detection outcome.
   * Always present regardless of whether a trade was detected.
   */
  reasoning: z
    .string()
    .describe("Explanation of trade detection analysis"),

  /**
   * Recommended trading timeframe for the detected opportunity.
   * Only present when `tradeDetected` is `true`.
   *
   * - INTRADAY: Same-day execution expected
   * - SWING: 2–10 day holding period
   * - POSITIONAL: 10+ day holding period
   */
  timeframe: z
    .enum(["INTRADAY", "SWING", "POSITIONAL"])
    .optional()
    .describe("Recommended trading timeframe"),

  /**
   * Strength of the detected trade signal from 0.0 (weakest) to 1.0 (strongest).
   * A higher signal strength indicates stronger conviction in the opportunity.
   */
  signalStrength: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Strength of the detected trade signal from 0.0 to 1.0",
    ),
});

/**
 * Inferred TypeScript type for the trade detection result.
 *
 * @example
 * ```typescript
 * // Trade detected
 * const detected: TradeDetectionResult = {
 *   tradeDetected: true,
 *   symbol: "AAPL",
 *   direction: "LONG",
 *   reasoning: "Strong earnings beat with raised guidance suggests upside...",
 *   timeframe: "SWING",
 *   signalStrength: 0.82,
 * };
 *
 * // No trade detected
 * const notDetected: TradeDetectionResult = {
 *   tradeDetected: false,
 *   reasoning: "Article discusses general market conditions without specific catalyst.",
 *   signalStrength: 0.15,
 * };
 * ```
 */
export type TradeDetectionResult = z.infer<typeof TradeDetectionResultSchema>;

// ---------------------------------------------------------------------------
// Stage 4 — Trade Recommendation Schema (Claude Sonnet 4.6)
// ---------------------------------------------------------------------------

/**
 * Schema for the final trade recommendation output — the most critical
 * schema in the pipeline.
 *
 * This schema is ONLY invoked for articles that pass all three preceding
 * stages (~25% of total articles), using Claude Sonnet 4.6 (the most
 * expensive model at $3.00/$15.00 per 1M tokens) for complex reasoning
 * and precise structured output.
 *
 * CRITICAL — Financial precision (AAP Rule 0.7.2):
 *   - `entryPrice`, `stopLoss`, `takeProfit`, and `riskRewardRatio` are ALL
 *     `z.string()` — NEVER `z.number()`. They represent PostgreSQL numeric(12,4)
 *     values and must avoid JavaScript floating-point precision loss.
 *   - LLMs generate prices as text; storing as strings preserves decimal precision
 *     all the way from LLM response → Zod validation → database insert.
 *
 * CRITICAL — Anti-hallucination (AAP Rule 0.7.3):
 *   - All LLM-generated price targets must be cross-validated against actual
 *     market data from API sources before storage or notification delivery.
 *     This validation happens downstream, NOT in this schema definition.
 *
 * Used with: `recommendModel.withStructuredOutput(TradeRecommendationSchema)`
 */
export const TradeRecommendationSchema = z.object({
  /** Stock or crypto ticker symbol (e.g., "AAPL", "BTC", "RELIANCE"). */
  symbol: z
    .string()
    .describe("Stock/crypto ticker symbol"),

  /**
   * Market category for the recommended trade.
   * - US: US equities (NYSE, NASDAQ)
   * - INDIA: Indian equities (NSE, BSE)
   * - CRYPTO: Cryptocurrency markets
   *
   * Note: "SOCIAL" is excluded as it is a news source, not a tradable market.
   */
  market: z
    .enum(["US", "INDIA", "CRYPTO"])
    .describe("Market category"),

  /** Trade direction — LONG (buy/bullish) or SHORT (sell/bearish). */
  direction: z
    .enum(["LONG", "SHORT"])
    .describe("Trade direction"),

  /**
   * Confidence score from 0.00 to 1.00.
   * Maps to PostgreSQL numeric(3,2). Higher values indicate stronger conviction.
   */
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score from 0.00 to 1.00"),

  /**
   * Recommended entry price as a decimal string (e.g., "875.0000").
   * CRITICAL: `z.string()` — NOT `z.number()` — to preserve PostgreSQL
   * numeric(12,4) precision and avoid floating-point loss.
   */
  entryPrice: z
    .string()
    .describe("Recommended entry price as decimal string (e.g., '875.00')"),

  /**
   * Stop loss price as a decimal string (e.g., "845.0000").
   * CRITICAL: `z.string()` — NOT `z.number()` — to preserve PostgreSQL
   * numeric(12,4) precision and avoid floating-point loss.
   */
  stopLoss: z
    .string()
    .describe("Stop loss price as decimal string (e.g., '845.00')"),

  /**
   * Take profit price as a decimal string (e.g., "950.0000").
   * CRITICAL: `z.string()` — NOT `z.number()` — to preserve PostgreSQL
   * numeric(12,4) precision and avoid floating-point loss.
   */
  takeProfit: z
    .string()
    .describe("Take profit price as decimal string (e.g., '950.00')"),

  /**
   * Trading timeframe for the recommendation.
   *
   * - INTRADAY: Same-day execution, exit before market close
   * - SWING: 2–10 day holding period
   * - POSITIONAL: 10+ day holding period
   */
  timeframe: z
    .enum(["INTRADAY", "SWING", "POSITIONAL"])
    .describe("Trading timeframe"),

  /**
   * Calculated risk-reward ratio as a string (e.g., "2.50").
   * CRITICAL: `z.string()` — NOT `z.number()` — to preserve precision.
   * Ratio = (takeProfit - entryPrice) / (entryPrice - stopLoss) for LONG trades.
   */
  riskRewardRatio: z
    .string()
    .describe("Calculated risk-reward ratio as string (e.g., '2.50')"),

  /**
   * Detailed trade reasoning incorporating financial domain knowledge.
   * Must reference specific catalysts, technical levels, fundamental factors,
   * and market context. Must NOT fabricate data not present in the source material.
   */
  reasoning: z
    .string()
    .describe(
      "Detailed trade reasoning incorporating domain knowledge",
    ),

  /**
   * ISO 8601 date string indicating when the catalyst driving this
   * recommendation expires or becomes stale (e.g., "2026-03-21T00:00:00Z").
   * Optional because some catalysts have indefinite relevance windows.
   */
  catalystExpiry: z
    .string()
    .optional()
    .describe("ISO 8601 date when catalyst relevance expires"),
});

/**
 * Inferred TypeScript type for the final trade recommendation.
 *
 * @example
 * ```typescript
 * const recommendation: TradeRecommendation = {
 *   symbol: "AAPL",
 *   market: "US",
 *   direction: "LONG",
 *   confidence: 0.87,
 *   entryPrice: "875.00",
 *   stopLoss: "845.00",
 *   takeProfit: "950.00",
 *   timeframe: "SWING",
 *   riskRewardRatio: "2.50",
 *   reasoning: "Strong Q2 earnings beat with 12% revenue growth and raised guidance...",
 *   catalystExpiry: "2026-04-15T00:00:00Z",
 * };
 * ```
 */
export type TradeRecommendation = z.infer<typeof TradeRecommendationSchema>;
