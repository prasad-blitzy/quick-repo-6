/**
 * @fileoverview Type definitions for the AI/LLM integration module.
 *
 * This is the foundational type definitions file for the entire `src/ai/` module.
 * Every other file in this folder imports types from this file. It contains NO
 * imports from other files — it is pure TypeScript interfaces and type aliases.
 *
 * Consumers:
 * - `src/ai/router.ts` → `AIAnalysisResult`, `LLMTier`, `AIAnalysisRequest`
 * - `src/ai/prompts.ts` → `LLMTier`, `PromptTemplate`, `AnalysisDimensionName`
 * - `src/ai/response-parser.ts` → `AIAnalysisResult`, `AnalysisDimension`, `LLMTier`
 * - `src/store/token-store.ts` → `AIAnalysisResult` (stores analysis results per token)
 * - `src/store/signal-store.ts` → `AIAnalysisResult` (attaches to signals)
 * - `src/components/AIInsight.tsx` → `AIAnalysisResult`, `AnalysisDimension` (displays to user)
 * - `src/utils/messaging.ts` → `AIAnalysisResult` (for AI_ANALYSIS_RESULT message type)
 *
 * @module src/ai/types
 */

// ---------------------------------------------------------------------------
// LLM Tier Type
// ---------------------------------------------------------------------------

/**
 * LLM tier determining which model is used for analysis.
 *
 * The three-tier routing strategy optimizes cost vs. quality:
 * - `'fast'`: `llama-3.1-8b-instant` — 80% of calls, routine screening, cheapest.
 *   Used for tokens with composite score < 45 (quick pass/fail).
 * - `'detailed'`: `llama-3.3-70b-versatile` — 15% of calls, detailed analysis,
 *   moderate cost. Used for tokens with composite score 45–80.
 * - `'premium'`: Claude Sonnet — 5% of calls, narrative analysis, most expensive.
 *   Reserved for highest-confidence signals with composite score > 80.
 *
 * Per AAP Section 0.7.4: "Maintain the 80/15/5 distribution — 80% of analyses
 * use llama-3.1-8b-instant (cheapest), 15% use llama-3.3-70b-versatile (moderate),
 * and only 5% (highest-confidence signals) escalate to Claude Sonnet (expensive)."
 */
export type LLMTier = 'fast' | 'detailed' | 'premium';

// ---------------------------------------------------------------------------
// Confidence Level Type
// ---------------------------------------------------------------------------

/**
 * Confidence level for AI analysis output.
 *
 * Indicates the strength and reliability of the analysis result based on
 * data quality, signal clarity, and model agreement:
 * - `'high'`: Strong data support, clear and consistent signals, high model
 *   agreement across dimensions. Suitable for position entry decisions.
 * - `'medium'`: Moderate data availability, some ambiguity or conflicting
 *   signals. Requires additional manual review before acting.
 * - `'low'`: Limited data, high uncertainty, conflicting or insufficient
 *   signals. Should not be relied upon for trading decisions.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Analysis Dimension Name Type
// ---------------------------------------------------------------------------

/**
 * Canonical names for the 5 analysis dimensions evaluated by the LLM.
 *
 * Each dimension captures a distinct aspect of token viability:
 * 1. `'on-chain momentum'` — Buy/sell ratio dynamics in the first 5 minutes,
 *    transaction velocity, and accumulation patterns.
 * 2. `'social velocity'` — Tweet rate acceleration, social media mention
 *    growth, and community engagement trajectory.
 * 3. `'wallet intelligence'` — Known profitable wallets accumulating,
 *    smart money convergence, and whale activity patterns.
 * 4. `'liquidity health'` — LP token distribution, bundle detection,
 *    creator wallet behavior, and liquidity stability.
 * 5. `'narrative fit'` — Token name/theme alignment with current market
 *    trends, meme relevance, and narrative timing.
 *
 * Per AAP Section 0.5.1 Group 8: "Prompt templates for 5 analysis dimensions:
 * on-chain momentum, social velocity, wallet intelligence, liquidity health,
 * narrative fit."
 */
export type AnalysisDimensionName =
  | 'on-chain momentum'
  | 'social velocity'
  | 'wallet intelligence'
  | 'liquidity health'
  | 'narrative fit';

// ---------------------------------------------------------------------------
// Analysis Dimension Interface
// ---------------------------------------------------------------------------

/**
 * Represents a single analysis dimension score from the LLM.
 *
 * The AI/LLM analysis evaluates each token across 5 independent dimensions.
 * Each dimension produces a score (0–100) and a human-readable reasoning
 * string explaining the assessment.
 *
 * The 5 dimensions per AAP are:
 * 1. on-chain momentum — buy/sell ratio in first 5 minutes
 * 2. social velocity — tweet rate acceleration
 * 3. wallet intelligence — known profitable wallets accumulating
 * 4. liquidity health — LP, bundle detection, creator behavior
 * 5. narrative fit — token name/theme trend alignment
 */
export interface AnalysisDimension {
  /**
   * Dimension name identifying which aspect of token viability is evaluated.
   * Should be one of the canonical {@link AnalysisDimensionName} values
   * (e.g., `'on-chain momentum'`, `'social velocity'`), but typed as
   * `string` for flexibility when parsing LLM responses that may not
   * exactly match the canonical names.
   */
  name: string;

  /**
   * Score for this dimension on a 0–100 scale.
   * - 0 = worst / most bearish signal for this dimension
   * - 100 = best / most bullish signal for this dimension
   *
   * Scores are produced by the LLM's structured JSON output and parsed
   * by `src/ai/response-parser.ts`.
   */
  score: number;

  /**
   * Human-readable reasoning or explanation for the assigned score.
   * Typically 1–3 sentences describing the key factors that influenced
   * the score for this dimension.
   *
   * Example: "Strong buy pressure with 4.2× buy/sell ratio in the first
   * 3 minutes. Transaction count accelerating with 127 buys in the latest
   * 5-minute window."
   */
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Prompt Template Interface
// ---------------------------------------------------------------------------

/**
 * Template for constructing LLM prompts.
 *
 * Used by `src/ai/prompts.ts` to build structured analysis requests
 * that are sent to the Groq API (or Anthropic API for premium tier).
 * Each prompt template defines the system role, user request, and the
 * expected JSON output schema to enforce structured responses.
 */
export interface PromptTemplate {
  /**
   * System prompt setting the LLM's role, behavior constraints, and
   * output format requirements. This establishes the analytical framework
   * and instructs the model to respond with structured JSON.
   *
   * Example: "You are a Solana memecoin analyst. Analyze the following
   * token data and respond with a JSON object matching the provided schema."
   */
  system: string;

  /**
   * User prompt containing the token data payload and specific analysis
   * request. This is populated at runtime with real token metrics, safety
   * data, smart money activity, and market context.
   *
   * Example: "Analyze token BONK (mint: DezX...): price $0.00001234,
   * volume $1.2M/24h, 3 smart money wallets entered in last 2 hours..."
   */
  user: string;

  /**
   * Expected JSON output schema description embedded in the system prompt.
   * Describes the exact structure the LLM should produce, enabling
   * deterministic parsing by `src/ai/response-parser.ts`.
   *
   * This string is typically a JSON schema or a descriptive specification
   * of the expected output fields including dimension scores, confidence,
   * and narrative summary.
   */
  expectedSchema: string;
}

// ---------------------------------------------------------------------------
// AI Analysis Result Interface
// ---------------------------------------------------------------------------

/**
 * Complete result from the AI/LLM analysis pipeline.
 *
 * Produced by the three-tier LLM router (`src/ai/router.ts`) and consumed
 * by the signal store, token store, and UI components for display. Each
 * result contains per-dimension scores, a composite AI score, confidence
 * assessment, and a human-readable narrative summary.
 *
 * The result is cached in `chrome.storage.local` with a 5-minute TTL
 * keyed by token mint address + analysis tier to prevent duplicate
 * LLM calls within the cache window.
 */
export interface AIAnalysisResult {
  /**
   * Array of analysis results for each of the 5 dimensions.
   * Each entry contains the dimension name, a 0–100 score, and
   * human-readable reasoning.
   *
   * Expected to contain exactly 5 entries corresponding to the
   * canonical {@link AnalysisDimensionName} values.
   */
  dimensions: AnalysisDimension[];

  /**
   * Composite AI score on a 0–100 scale.
   * Computed as a weighted average of dimension scores or directly
   * determined by the LLM's overall assessment.
   *
   * - 0–30: Bearish / avoid
   * - 31–60: Neutral / mixed signals
   * - 61–80: Bullish / moderate confidence
   * - 81–100: Strongly bullish / high confidence
   */
  compositeAI: number;

  /**
   * Overall confidence level of the analysis.
   * Reflects data quality, signal consistency, and the LLM's certainty
   * in its assessment.
   *
   * - `'high'`: Strong data, clear signals, suitable for entry decisions
   * - `'medium'`: Moderate data, some ambiguity, needs manual review
   * - `'low'`: Limited data, high uncertainty, not actionable
   */
  confidence: ConfidenceLevel;

  /**
   * Human-readable narrative summary of the analysis (2–3 sentences).
   * Provides a trader-friendly overview of the key findings, risks,
   * and opportunities identified across all dimensions.
   *
   * Example: "Strong early momentum with 3 smart money wallets converging.
   * Liquidity appears healthy but narrative fit is weak for current market
   * trends. Moderate conviction entry with tight stop-loss recommended."
   */
  narrative: string;

  /**
   * Which LLM tier produced this analysis result.
   * Indicates the model quality level and can be displayed in the UI
   * to inform the user of analysis depth.
   *
   * - `'fast'`: Quick screening via llama-3.1-8b-instant
   * - `'detailed'`: In-depth analysis via llama-3.3-70b-versatile
   * - `'premium'`: Narrative analysis via Claude Sonnet
   */
  tier: LLMTier;

  /**
   * Timestamp when the analysis was completed, in milliseconds since
   * the Unix epoch (i.e., `Date.now()` at completion time).
   *
   * Used for cache TTL calculations (5-minute expiry) and for displaying
   * "analyzed X minutes ago" in the UI.
   */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// AI Analysis Request Interface
// ---------------------------------------------------------------------------

/**
 * Input data shape for requesting AI analysis on a token.
 *
 * Passed from the scoring engine to the AI router (`src/ai/router.ts`).
 * Contains the token identification, its initial composite score from
 * the 7-factor scoring engine, and all available token data for prompt
 * construction.
 *
 * The router uses `compositeScore` to determine which LLM tier to invoke:
 * - compositeScore < 45 → `'fast'` tier (llama-3.1-8b-instant)
 * - compositeScore 45–80 → `'detailed'` tier (llama-3.3-70b-versatile)
 * - compositeScore > 80 → `'premium'` tier (Claude Sonnet)
 */
export interface AIAnalysisRequest {
  /**
   * Solana token mint address (base58-encoded public key).
   * Used as the primary identifier for cache key construction
   * and for correlating analysis results with token data.
   *
   * Example: `"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"`
   */
  mint: string;

  /**
   * Token trading symbol (e.g., `"BONK"`, `"WIF"`, `"POPCAT"`).
   * Included in the LLM prompt for context and used in the
   * narrative analysis dimension (narrative fit).
   */
  symbol: string;

  /**
   * Initial composite score from the 7-factor scoring engine (0–100).
   * This score determines which LLM tier is selected for analysis
   * and provides baseline context for the LLM's evaluation.
   *
   * Per AAP: Score < 45 → fast tier, 45–80 → detailed tier, > 80 → premium tier.
   */
  compositeScore: number;

  /**
   * All available token data for prompt construction.
   * This is an open-ended record containing fields from GMGN intercepted
   * data, Birdeye analytics, safety reports, smart money activity, and
   * any other enrichment data available at analysis time.
   *
   * The prompt builder (`src/ai/prompts.ts`) extracts relevant fields
   * from this record to construct dimension-specific prompts.
   *
   * Typical fields include: price, volume24h, marketCap, liquidity,
   * holderCount, topHolderPercent, buySellRatio, smartMoneyCount,
   * safetyScore, rugCheckScore, tokenAge, bondingCurveProgress, etc.
   */
  tokenData: Record<string, unknown>;
}
