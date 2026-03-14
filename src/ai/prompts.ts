/**
 * @fileoverview Prompt templates for LLM token analysis.
 *
 * This module provides structured prompt templates for the three-tier AI/LLM
 * analysis pipeline. Each prompt is designed to instruct the LLM to respond
 * with valid JSON matching a defined schema, enabling deterministic parsing
 * by `src/ai/response-parser.ts`.
 *
 * The 5 analysis dimensions per AAP:
 * 1. on-chain momentum — buy/sell ratio, volume acceleration, price trajectory
 * 2. social velocity — tweet rate acceleration, community growth indicators
 * 3. wallet intelligence — smart money accumulation, convergence, position sizes
 * 4. liquidity health — LP lock/burn, bundle detection, developer behavior
 * 5. narrative fit — token name/theme alignment with current memecoin trends
 *
 * Three LLM tiers with tier-specific verbosity:
 * - Fast (llama-3.1-8b-instant, 80% of calls): Brief, 1 sentence per dimension
 * - Detailed (llama-3.3-70b-versatile, 15% of calls): Thorough, 1-2 sentences
 * - Premium (Claude Sonnet, 5% of calls): Rich narrative, 2-3 sentences
 *
 * Consumers:
 * - `src/ai/router.ts` → `buildFullPrompt()`, `buildAnalysisPrompt()`, `buildSystemPrompt()`
 *
 * @module src/ai/prompts
 */

import type { LLMTier, PromptTemplate } from './types';

// ---------------------------------------------------------------------------
// TokenDataForPrompt Interface
// ---------------------------------------------------------------------------

/**
 * Input data shape for constructing LLM analysis prompts.
 *
 * Contains all available token metrics, safety data, and smart money activity
 * needed to produce a comprehensive analysis prompt. Every field is required
 * to give the LLM maximum context for accurate signal evaluation.
 *
 * This interface is intentionally separate from `AIAnalysisRequest` in
 * `./types.ts` because it contains the fully resolved, type-safe data fields
 * (not `Record<string, unknown>`) needed for prompt string interpolation.
 */
export interface TokenDataForPrompt {
  /** Solana token mint address (base58-encoded public key). */
  mint: string;

  /** Token trading symbol (e.g., "BONK", "WIF", "POPCAT"). */
  symbol: string;

  /** Current token price in USD. */
  price: number;

  /** Market capitalization in USD. */
  marketCap: number;

  /** 24-hour trading volume in USD. */
  volume24h: number;

  /** Total liquidity depth in USD (LP pool value). */
  liquidity: number;

  /** Current number of unique token holders. */
  holderCount: number;

  /** Buy/sell transaction ratio over the last hour (e.g., 1.5 means 50% more buys than sells). */
  buySellRatio: number;

  /** Number of qualified smart money wallets that have entered this token. */
  smartMoneyCount: number;

  /** Token age in hours since creation on-chain. */
  tokenAgeHours: number;

  /** Aggregated safety score from RugCheck (0–1000 scale, higher is safer). */
  safetyScore: number;

  /** Whether the token failed Jupiter honeypot sell simulation. */
  isHoneypot: boolean;

  /** Whether the developer wallet has sold their holdings. */
  devWalletSold: boolean;

  /** Percentage of total supply held by the top holder (0–100). */
  topHolderPercent: number;

  /** Whether LP tokens have been burned (sent to burn address). */
  lpBurned: boolean;

  /** Initial composite score from the 7-factor scoring engine (0–100). */
  compositeScore: number;
}

// ---------------------------------------------------------------------------
// Analysis Dimensions Constant
// ---------------------------------------------------------------------------

/**
 * The 5 canonical analysis dimensions evaluated by the LLM.
 *
 * Each dimension captures a distinct aspect of token trading viability.
 * These descriptions are embedded directly into every user prompt to
 * instruct the LLM on what to analyze for each dimension.
 *
 * Per AAP Section 0.5.1 Group 8: "Prompt templates for 5 analysis dimensions:
 * on-chain momentum, social velocity, wallet intelligence, liquidity health,
 * narrative fit."
 */
export const ANALYSIS_DIMENSIONS = [
  {
    name: 'on-chain momentum',
    description:
      'Analyze buy/sell transaction ratio, volume acceleration in recent 5-minute windows, price trajectory, and whether buying pressure is increasing or declining.',
  },
  {
    name: 'social velocity',
    description:
      'Evaluate social media buzz, tweet rate acceleration, community growth indicators, and whether social attention is preceding or following price action.',
  },
  {
    name: 'wallet intelligence',
    description:
      'Assess smart money wallet activity — are known profitable traders accumulating? How many qualified wallets have entered? What are their typical position sizes relative to historical averages?',
  },
  {
    name: 'liquidity health',
    description:
      'Evaluate LP lock/burn status, liquidity depth relative to market cap, presence of bundle detection (wallets funded from the same source), and creator/developer wallet behavior.',
  },
  {
    name: 'narrative fit',
    description:
      'Assess whether the token name, theme, and concept align with current memecoin trends, cultural moments, or viral narratives that could drive organic interest.',
  },
] as const;

// ---------------------------------------------------------------------------
// Expected JSON Output Schema
// ---------------------------------------------------------------------------

/**
 * JSON schema description embedded in every system prompt to enforce
 * structured LLM output. The LLM is instructed to respond ONLY with
 * valid JSON matching this exact structure.
 *
 * This schema is consumed by `src/ai/response-parser.ts` for
 * deterministic parsing of LLM responses.
 */
export const EXPECTED_OUTPUT_SCHEMA = `{
  "dimensions": [
    {
      "name": "on-chain momentum",
      "score": 0,
      "reasoning": "1-2 sentence explanation"
    },
    {
      "name": "social velocity",
      "score": 0,
      "reasoning": "1-2 sentence explanation"
    },
    {
      "name": "wallet intelligence",
      "score": 0,
      "reasoning": "1-2 sentence explanation"
    },
    {
      "name": "liquidity health",
      "score": 0,
      "reasoning": "1-2 sentence explanation"
    },
    {
      "name": "narrative fit",
      "score": 0,
      "reasoning": "1-2 sentence explanation"
    }
  ],
  "compositeScore": 0,
  "confidence": "high | medium | low",
  "narrative": "2-3 sentence summary of the overall analysis",
  "recommendation": "BUY | SKIP | WATCH"
}`;

// ---------------------------------------------------------------------------
// Tier-Specific System Prompts
// ---------------------------------------------------------------------------

/**
 * System prompt for the fast tier (llama-3.1-8b-instant).
 * Handles 80% of all LLM calls — optimized for speed and cost.
 * Instructs the model to provide brief, factual analysis with
 * 1 sentence of reasoning per dimension.
 */
const FAST_SYSTEM_PROMPT = `You are a Solana memecoin signal screening analyst. Your job is to quickly evaluate a token's trading viability based on on-chain data.

Respond ONLY with valid JSON matching this exact schema:
${EXPECTED_OUTPUT_SCHEMA}

Rules:
- Score each of the 5 dimensions from 0 (worst) to 100 (best).
- Keep reasoning brief (1 sentence per dimension).
- Focus on factual data interpretation, not speculation.
- The "compositeScore" should be the weighted average of all dimension scores.
- Set "confidence" to "high", "medium", or "low" based on data quality.
- The "narrative" must be a 2-3 sentence actionable summary.
- "recommendation" must be exactly "BUY", "SKIP", or "WATCH".
- Return ONLY the JSON object, no additional text or markdown.`;

/**
 * System prompt for the detailed tier (llama-3.3-70b-versatile).
 * Handles 15% of all LLM calls — balanced cost and quality.
 * Instructs the model to provide thorough analysis with 1-2 sentences
 * of reasoning per dimension, citing specific data points.
 */
const DETAILED_SYSTEM_PROMPT = `You are an expert Solana memecoin analyst specializing in on-chain intelligence and trading signal generation. Provide thorough analysis across all 5 dimensions.

Respond ONLY with valid JSON matching this exact schema:
${EXPECTED_OUTPUT_SCHEMA}

Rules:
- Score each of the 5 dimensions from 0 (worst) to 100 (best).
- Provide detailed reasoning (1-2 sentences per dimension) citing specific data points from the token data provided.
- Your confidence level should reflect the quality and completeness of available data.
- Consider cross-dimensional correlations (e.g., high smart money activity with low liquidity is risky).
- The "compositeScore" should reflect your holistic assessment, not just an average.
- The "narrative" should be a 2-3 sentence trading-grade summary with specific risk callouts.
- "recommendation" must be exactly "BUY", "SKIP", or "WATCH".
- Return ONLY the JSON object, no additional text or markdown.`;

/**
 * System prompt for the premium tier (Claude Sonnet).
 * Handles 5% of all LLM calls — reserved for highest-confidence signals.
 * Instructs the model to provide rich, narrative-grade analysis with
 * 2-3 sentences per dimension and specific data-backed observations.
 */
const PREMIUM_SYSTEM_PROMPT = `You are a senior Solana memecoin analyst providing narrative-grade analysis for high-confidence trading signals. This token has already passed initial screening with a high composite score.

Respond ONLY with valid JSON matching this exact schema:
${EXPECTED_OUTPUT_SCHEMA}

Rules:
- Score each of the 5 dimensions from 0 (worst) to 100 (best).
- Provide rich, insightful reasoning (2-3 sentences per dimension) with specific data-backed observations.
- Identify non-obvious patterns, correlations, and risk factors across dimensions.
- Consider market context, timing windows, and entry/exit implications.
- Your narrative should be a compelling, actionable summary that a trader can use for immediate decision-making.
- Assess whether the convergence of signals suggests genuine opportunity or coordinated manipulation.
- The "compositeScore" should reflect your conviction level as a seasoned analyst.
- "recommendation" must be exactly "BUY", "SKIP", or "WATCH".
- Return ONLY the JSON object, no additional text or markdown.`;

/**
 * Maps LLM tier identifiers to their corresponding system prompts.
 * Used by `buildSystemPrompt()` for O(1) tier lookup.
 */
const SYSTEM_PROMPTS: Record<LLMTier, string> = {
  fast: FAST_SYSTEM_PROMPT,
  detailed: DETAILED_SYSTEM_PROMPT,
  premium: PREMIUM_SYSTEM_PROMPT,
};

// ---------------------------------------------------------------------------
// Dimension-Specific Data Extractors
// ---------------------------------------------------------------------------

/**
 * Maps each analysis dimension to the most relevant subset of token data
 * fields. Used by `buildDimensionPrompt()` to construct focused prompts
 * containing only the data relevant to a specific dimension.
 */
const DIMENSION_DATA_EXTRACTORS: Record<
  string,
  (input: TokenDataForPrompt) => string
> = {
  'on-chain momentum': (input: TokenDataForPrompt): string =>
    `- Price: $${formatPrice(input.price)}
- Market Cap: $${formatLargeNumber(input.marketCap)}
- 24h Volume: $${formatLargeNumber(input.volume24h)}
- Buy/Sell Ratio (1h): ${input.buySellRatio.toFixed(2)}
- Token Age: ${input.tokenAgeHours.toFixed(1)} hours
- Volume-to-MarketCap Ratio: ${input.marketCap > 0 ? ((input.volume24h / input.marketCap) * 100).toFixed(1) : '0.0'}%`,

  'social velocity': (input: TokenDataForPrompt): string =>
    `- Symbol: ${input.symbol}
- Token Age: ${input.tokenAgeHours.toFixed(1)} hours
- Holder Count: ${formatLargeNumber(input.holderCount)}
- Market Cap: $${formatLargeNumber(input.marketCap)}
- Current Price: $${formatPrice(input.price)}
- Initial Signal Score: ${input.compositeScore}/100`,

  'wallet intelligence': (input: TokenDataForPrompt): string =>
    `- Smart Money Wallets: ${input.smartMoneyCount}
- Buy/Sell Ratio (1h): ${input.buySellRatio.toFixed(2)}
- Holder Count: ${formatLargeNumber(input.holderCount)}
- Top Holder Concentration: ${input.topHolderPercent.toFixed(1)}%
- Dev Wallet Sold: ${input.devWalletSold ? 'YES (WARNING)' : 'No'}
- Token Age: ${input.tokenAgeHours.toFixed(1)} hours`,

  'liquidity health': (input: TokenDataForPrompt): string =>
    `- Liquidity: $${formatLargeNumber(input.liquidity)}
- Market Cap: $${formatLargeNumber(input.marketCap)}
- LP Burned: ${input.lpBurned ? 'Yes (Positive)' : 'No (Risk)'}
- Top Holder Concentration: ${input.topHolderPercent.toFixed(1)}%
- Dev Wallet Sold: ${input.devWalletSold ? 'YES (WARNING)' : 'No'}
- Honeypot Detected: ${input.isHoneypot ? 'YES (DANGER)' : 'No'}
- Safety Score: ${input.safetyScore}/1000
- Liquidity-to-MarketCap Ratio: ${input.marketCap > 0 ? ((input.liquidity / input.marketCap) * 100).toFixed(1) : '0.0'}%`,

  'narrative fit': (input: TokenDataForPrompt): string =>
    `- Symbol: ${input.symbol}
- Token Mint: ${input.mint}
- Token Age: ${input.tokenAgeHours.toFixed(1)} hours
- Market Cap: $${formatLargeNumber(input.marketCap)}
- Holder Count: ${formatLargeNumber(input.holderCount)}
- Smart Money Wallets: ${input.smartMoneyCount}
- Current Momentum (Buy/Sell Ratio): ${input.buySellRatio.toFixed(2)}`,
};

// ---------------------------------------------------------------------------
// Number Formatting Helpers (Internal)
// ---------------------------------------------------------------------------

/**
 * Formats a large number with K/M/B suffix for human readability.
 * Used in prompt text to avoid overwhelming the LLM with raw numbers.
 *
 * @param value - The number to format
 * @returns Formatted string (e.g., "1.23M", "456K", "78.5B")
 */
function formatLargeNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toFixed(2);
}

/**
 * Formats a token price with appropriate decimal precision.
 * Memecoins often have very small prices requiring many decimal places.
 *
 * @param price - The price in USD
 * @returns Formatted price string with dynamic decimal precision
 */
function formatPrice(price: number): string {
  if (price === 0) {
    return '0.00';
  }
  if (price >= 1) {
    return price.toFixed(2);
  }
  if (price >= 0.01) {
    return price.toFixed(4);
  }
  if (price >= 0.0001) {
    return price.toFixed(6);
  }
  // For very small memecoin prices (e.g., 0.00000001234)
  return price.toExponential(4);
}

// ---------------------------------------------------------------------------
// Public Functions
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt for a given LLM tier.
 *
 * The system prompt establishes the LLM's role, behavior constraints,
 * output format requirements, and tier-specific verbosity expectations.
 * The `EXPECTED_OUTPUT_SCHEMA` is embedded in every system prompt to
 * ensure consistent JSON output regardless of the model used.
 *
 * @param tier - The LLM tier determining prompt verbosity:
 *   - `'fast'`: Brief analysis, 1 sentence per dimension (80% of calls)
 *   - `'detailed'`: Thorough analysis, 1-2 sentences per dimension (15%)
 *   - `'premium'`: Rich narrative, 2-3 sentences per dimension (5%)
 * @returns The complete system prompt string for the given tier
 */
export function buildSystemPrompt(tier: LLMTier): string {
  const prompt = SYSTEM_PROMPTS[tier];
  if (!prompt) {
    // Defensive: if an unknown tier is somehow passed, fall back to fast
    return SYSTEM_PROMPTS.fast;
  }
  return prompt;
}

/**
 * Builds the user analysis prompt containing all available token data.
 *
 * Constructs a structured prompt with two sections:
 * 1. TOKEN DATA — Price, volume, market cap, holders, buy/sell ratio,
 *    smart money activity, token age, and initial signal score.
 * 2. SAFETY DATA — Safety score, honeypot status, dev wallet status,
 *    holder concentration, and LP burn status.
 *
 * The prompt also lists all 5 analysis dimensions with their descriptions
 * and instructs the LLM to respond with JSON only.
 *
 * Numbers are formatted for human readability (K/M/B suffixes, currency
 * symbols, percentages) to optimize LLM comprehension.
 *
 * @param input - All available token data for prompt construction
 * @returns The complete user prompt string with formatted token data
 */
export function buildAnalysisPrompt(input: TokenDataForPrompt): string {
  const volumeToMcRatio =
    input.marketCap > 0
      ? ((input.volume24h / input.marketCap) * 100).toFixed(1)
      : '0.0';

  const liquidityToMcRatio =
    input.marketCap > 0
      ? ((input.liquidity / input.marketCap) * 100).toFixed(1)
      : '0.0';

  const dimensionList = ANALYSIS_DIMENSIONS.map(
    (d, i) => `${i + 1}. ${d.name}: ${d.description}`
  ).join('\n');

  return `Analyze this Solana memecoin token for trading signal quality.

TOKEN DATA:
- Symbol: ${input.symbol}
- Mint: ${input.mint}
- Price: $${formatPrice(input.price)}
- Market Cap: $${formatLargeNumber(input.marketCap)}
- 24h Volume: $${formatLargeNumber(input.volume24h)}
- Liquidity: $${formatLargeNumber(input.liquidity)}
- Holders: ${formatLargeNumber(input.holderCount)}
- Buy/Sell Ratio (1h): ${input.buySellRatio.toFixed(2)}
- Smart Money Wallets: ${input.smartMoneyCount}
- Token Age: ${input.tokenAgeHours.toFixed(1)} hours
- Initial Signal Score: ${input.compositeScore}/100
- Volume-to-MarketCap Ratio: ${volumeToMcRatio}%
- Liquidity-to-MarketCap Ratio: ${liquidityToMcRatio}%

SAFETY DATA:
- Safety Score: ${input.safetyScore}/1000
- Honeypot Detected: ${input.isHoneypot ? 'YES (DANGER)' : 'No'}
- Dev Wallet Sold: ${input.devWalletSold ? 'YES (WARNING)' : 'No'}
- Top Holder Concentration: ${input.topHolderPercent.toFixed(1)}%
- LP Burned: ${input.lpBurned ? 'Yes' : 'No'}

Analyze across these 5 dimensions:
${dimensionList}

Respond with JSON only.`;
}

/**
 * Builds a complete prompt template combining system and user prompts.
 *
 * This is the primary convenience function called by `src/ai/router.ts`
 * to get both the system prompt (tier-specific role + JSON schema) and
 * the user prompt (token data + dimension instructions) in a single call.
 *
 * The returned `PromptTemplate` object contains:
 * - `system`: Tier-specific system prompt with embedded JSON schema
 * - `user`: Token data + analysis instructions
 * - `expectedSchema`: The raw JSON schema string for reference
 *
 * @param input - All available token data for prompt construction
 * @param tier - The LLM tier determining system prompt verbosity
 * @returns A complete `PromptTemplate` ready to send to the LLM
 */
export function buildFullPrompt(
  input: TokenDataForPrompt,
  tier: LLMTier
): PromptTemplate {
  return {
    system: buildSystemPrompt(tier),
    user: buildAnalysisPrompt(input),
    expectedSchema: EXPECTED_OUTPUT_SCHEMA,
  };
}

/**
 * Builds a focused prompt for analyzing a single dimension of a token.
 *
 * Each dimension prompt includes only the data fields most relevant to
 * that specific dimension, reducing token usage and focusing the LLM's
 * attention. This can be used for per-dimension analysis when a more
 * targeted evaluation is needed (e.g., re-analyzing a specific dimension
 * after new data arrives).
 *
 * If the requested dimension is not recognized, falls back to a generic
 * prompt using all available token data.
 *
 * @param dimensionName - One of the 5 canonical dimension names:
 *   'on-chain momentum', 'social velocity', 'wallet intelligence',
 *   'liquidity health', 'narrative fit'
 * @param input - All available token data for prompt construction
 * @returns A focused prompt string for the specified dimension
 */
export function buildDimensionPrompt(
  dimensionName: string,
  input: TokenDataForPrompt
): string {
  const dimension = ANALYSIS_DIMENSIONS.find(
    (d) => d.name === dimensionName
  );

  const dimensionDescription = dimension
    ? dimension.description
    : `Analyze the "${dimensionName}" aspect of this token.`;

  const dataExtractor = DIMENSION_DATA_EXTRACTORS[dimensionName];

  const relevantData = dataExtractor
    ? dataExtractor(input)
    : buildGenericDataSection(input);

  return `Analyze the "${dimensionName}" dimension for this Solana memecoin token.

DIMENSION: ${dimensionName}
INSTRUCTION: ${dimensionDescription}

TOKEN: ${input.symbol} (${input.mint})

RELEVANT DATA:
${relevantData}

Respond with valid JSON matching this schema:
{
  "name": "${dimensionName}",
  "score": 0,
  "reasoning": "2-3 sentence explanation for the score"
}

Score from 0 (worst) to 100 (best). Provide specific, data-backed reasoning.
Return ONLY the JSON object, no additional text.`;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a generic data section with all token fields for unrecognized
 * dimension names. Used as a fallback when `DIMENSION_DATA_EXTRACTORS`
 * does not have a specific extractor for the requested dimension.
 *
 * @param input - All available token data
 * @returns A formatted string containing all token data fields
 */
function buildGenericDataSection(input: TokenDataForPrompt): string {
  return `- Symbol: ${input.symbol}
- Mint: ${input.mint}
- Price: $${formatPrice(input.price)}
- Market Cap: $${formatLargeNumber(input.marketCap)}
- 24h Volume: $${formatLargeNumber(input.volume24h)}
- Liquidity: $${formatLargeNumber(input.liquidity)}
- Holders: ${formatLargeNumber(input.holderCount)}
- Buy/Sell Ratio: ${input.buySellRatio.toFixed(2)}
- Smart Money Wallets: ${input.smartMoneyCount}
- Token Age: ${input.tokenAgeHours.toFixed(1)} hours
- Safety Score: ${input.safetyScore}/1000
- Honeypot: ${input.isHoneypot ? 'YES' : 'No'}
- Dev Wallet Sold: ${input.devWalletSold ? 'YES' : 'No'}
- Top Holder: ${input.topHolderPercent.toFixed(1)}%
- LP Burned: ${input.lpBurned ? 'Yes' : 'No'}
- Composite Score: ${input.compositeScore}/100`;
}
