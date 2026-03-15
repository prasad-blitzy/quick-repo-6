/**
 * @fileoverview Structured JSON LLM Response Parser
 *
 * Parses structured JSON responses from the Groq/Anthropic LLM APIs into typed
 * `AIAnalysisResult` objects. Validates schema correctness, extracts dimension
 * scores (0–100 each), confidence levels (high/medium/low), and human-readable
 * narrative summaries. Handles malformed responses gracefully with safe fallback
 * defaults — this module NEVER throws exceptions.
 *
 * Design principles:
 * - **Defensive parsing**: Every field is treated as potentially missing, null,
 *   or incorrectly typed. LLMs may produce malformed JSON even with structured
 *   output instructions.
 * - **Fallback-first**: When parsing fails at any level, a neutral fallback
 *   result is returned (score 50, confidence 'low') to ensure the signal
 *   pipeline continues operating without crashes.
 * - **Score clamping**: All numeric scores are clamped to the 0–100 range.
 * - **Confidence normalization**: LLM confidence strings are normalized from
 *   various casing and synonym patterns to the canonical 'high'|'medium'|'low'.
 *
 * Per AAP Section 0.5.1 Group 8:
 * "Parses structured JSON responses from LLMs into typed AIAnalysisResult
 *  objects; validates schema, extracts dimension scores (0–100 each),
 *  confidence level, and human-readable narrative summary; handles malformed
 *  responses gracefully"
 *
 * Consumers:
 * - `src/ai/router.ts` → `parseAIResponse()` primary consumer
 * - `tests/unit/ai/response-parser.test.ts` → all exported functions
 *
 * @module src/ai/response-parser
 */

import type { AIAnalysisResult, AnalysisDimension, LLMTier } from './types';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Logger Instance
// ---------------------------------------------------------------------------

/**
 * Module-scoped structured logger with 'ai-response-parser' context tag.
 * Used for warning on malformed LLM responses and error on JSON parsing failures.
 */
const logger = createLogger('ai-response-parser');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum allowed length for narrative strings.
 * Narratives exceeding this limit are truncated to prevent excessive
 * storage consumption in chrome.storage.local.
 */
const MAX_NARRATIVE_LENGTH = 500;

/**
 * Minimum valid score value (inclusive).
 */
const MIN_SCORE = 0;

/**
 * Maximum valid score value (inclusive).
 */
const MAX_SCORE = 100;

/**
 * Default neutral score used when parsing fails.
 * 50 represents a neutral midpoint — neither bullish nor bearish.
 */
const DEFAULT_SCORE = 50;

/**
 * Default narrative message used when the LLM provides no narrative.
 */
const DEFAULT_NARRATIVE = 'Analysis completed. See dimension scores for details.';

/**
 * Fallback narrative used when parsing fails entirely.
 */
const FALLBACK_NARRATIVE = 'Unable to complete AI analysis. Using default scores.';

/**
 * Default reasoning text for dimensions when no data is available.
 */
const DEFAULT_REASONING = 'No data available';

/**
 * The 5 canonical analysis dimension names per AAP specification.
 * Used for generating default dimensions and matching LLM output.
 */
const CANONICAL_DIMENSION_NAMES: readonly string[] = [
  'on-chain momentum',
  'social velocity',
  'wallet intelligence',
  'liquidity health',
  'narrative fit',
] as const;

// ---------------------------------------------------------------------------
// Internal Raw Response Types
// ---------------------------------------------------------------------------

/**
 * Raw JSON structure expected from the LLM response.
 * All fields are optional because LLMs may omit or malform any field,
 * even when using `response_format: { type: 'json_object' }`.
 */
interface RawLLMResponse {
  /** Array of dimension analysis results */
  dimensions?: RawDimension[];
  /** Overall composite score from the LLM (0–100) */
  compositeScore?: number;
  /** Confidence level string (e.g., 'high', 'medium', 'low') */
  confidence?: string;
  /** Human-readable narrative summary of the analysis */
  narrative?: string;
  /** Alternative field name for narrative (some prompts use 'recommendation') */
  recommendation?: string;
  /** Alternative field name for composite score */
  overall_score?: number;
  /** Alternative field name for composite score */
  composite_score?: number;
}

/**
 * Raw dimension structure from LLM JSON output.
 * Fields are optional for defensive parsing.
 */
interface RawDimension {
  /** Dimension name (e.g., 'on-chain momentum') */
  name?: string;
  /** Dimension score (0–100) */
  score?: number;
  /** Human-readable reasoning for the score */
  reasoning?: string;
  /** Alternative field name for reasoning */
  explanation?: string;
  /** Alternative field name for reasoning */
  analysis?: string;
}

// ---------------------------------------------------------------------------
// Confidence Mapping
// ---------------------------------------------------------------------------

/**
 * Mapping of common LLM confidence string variations to canonical values.
 * LLMs often produce variations like 'HIGH', 'Very High', 'moderate', etc.
 * This map normalizes all recognized variations to 'high' | 'medium' | 'low'.
 */
const CONFIDENCE_MAP: ReadonlyMap<string, 'high' | 'medium' | 'low'> = new Map([
  // Direct matches
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
  // Common LLM variations for 'high'
  ['very high', 'high'],
  ['strong', 'high'],
  ['confident', 'high'],
  ['very confident', 'high'],
  ['highly confident', 'high'],
  // Common LLM variations for 'medium'
  ['moderate', 'medium'],
  ['mid', 'medium'],
  ['average', 'medium'],
  ['somewhat confident', 'medium'],
  ['moderately confident', 'medium'],
  ['neutral', 'medium'],
  // Common LLM variations for 'low'
  ['very low', 'low'],
  ['weak', 'low'],
  ['uncertain', 'low'],
  ['not confident', 'low'],
  ['low confidence', 'low'],
  ['minimal', 'low'],
]);

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Parses a raw LLM response into a typed `AIAnalysisResult`.
 *
 * This is the PRIMARY export consumed by `src/ai/router.ts`. It accepts
 * any value (unknown) and performs comprehensive validation and normalization
 * to produce a well-typed result. When parsing fails at any level, graceful
 * fallbacks are used — this function NEVER throws.
 *
 * Handles these input forms:
 * - `null` / `undefined` → fallback result
 * - JSON string → parsed then validated
 * - Object → validated directly
 * - Any other type → fallback result
 *
 * @param raw - The raw LLM response (may be string, object, null, or undefined)
 * @param tier - The LLM tier that produced this response ('fast'|'detailed'|'premium')
 * @returns A fully typed `AIAnalysisResult` — always returns a valid result, never throws
 *
 * @example
 * ```typescript
 * const result = parseAIResponse(groqResponse.choices[0].message.content, 'fast');
 * // result is always a valid AIAnalysisResult
 * ```
 */
export function parseAIResponse(raw: unknown, tier: LLMTier): AIAnalysisResult {
  // 1. Handle null/undefined/falsy input
  if (raw === null || raw === undefined) {
    logger.warn('Received null/undefined LLM response, returning fallback');
    return createFallbackResult(tier);
  }

  // 2. Parse string input (some LLM APIs return JSON as a string)
  let parsed: RawLLMResponse;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      logger.warn('Received empty string LLM response, returning fallback');
      return createFallbackResult(tier);
    }
    try {
      parsed = JSON.parse(trimmed) as RawLLMResponse;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Failed to parse LLM response as JSON', errorMessage);
      return createFallbackResult(tier);
    }
  } else if (typeof raw === 'object') {
    // 3. Direct object input
    parsed = raw as RawLLMResponse;
  } else {
    // 4. Unsupported type (number, boolean, symbol, etc.)
    logger.warn('Received unsupported LLM response type', typeof raw);
    return createFallbackResult(tier);
  }

  // 5. Guard against null parsed result (e.g., JSON.parse('null'))
  if (parsed === null || typeof parsed !== 'object') {
    logger.warn('Parsed LLM response is not a valid object');
    return createFallbackResult(tier);
  }

  // 6. Extract and validate each field with defensive parsing
  const dimensions = parseDimensions(parsed.dimensions);
  const compositeAI = validateScore(
    extractCompositeScore(parsed),
    computeAverageScore(dimensions),
  );
  const confidence = validateConfidence(parsed.confidence);
  const narrative = validateNarrative(parsed.narrative, parsed.recommendation);

  return {
    dimensions,
    compositeAI,
    confidence,
    narrative,
    tier,
    timestamp: Date.now(),
  };
}

/**
 * Strict parser that returns `null` instead of fallbacks when parsing fails.
 *
 * Unlike `parseAIResponse`, this function does not produce fallback results.
 * It returns `null` when any critical field is missing or unparseable, making
 * it useful for testing and validation scenarios where the caller needs to
 * distinguish between genuine parse success and fallback results.
 *
 * Critical fields required for a non-null result:
 * - At least one parseable dimension with a valid score
 * - A parseable composite score or valid dimensions to compute one
 * - Valid JSON structure (if input is a string)
 *
 * @param raw - The raw LLM response
 * @param tier - The LLM tier that produced this response
 * @returns A typed `AIAnalysisResult` if parsing succeeds, or `null` if it fails
 */
export function parseAIResponseStrict(raw: unknown, tier: LLMTier): AIAnalysisResult | null {
  // Reject null/undefined
  if (raw === null || raw === undefined) {
    return null;
  }

  // Parse string input
  let parsed: RawLLMResponse;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed) as RawLLMResponse;
    } catch {
      return null;
    }
  } else if (typeof raw === 'object') {
    parsed = raw as RawLLMResponse;
  } else {
    return null;
  }

  // Guard against null parsed result
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  // Require at least some parseable dimensions
  const dimensions = parseDimensions(parsed.dimensions);
  const hasRealDimensions = Array.isArray(parsed.dimensions) && parsed.dimensions.length > 0;

  if (!hasRealDimensions) {
    return null;
  }

  // Require a composite score (either explicit or computable from dimensions)
  const rawComposite = extractCompositeScore(parsed);
  const hasExplicitScore = typeof rawComposite === 'number' && !Number.isNaN(rawComposite);
  const hasComputedScore = dimensions.some(d => d.score !== DEFAULT_SCORE);

  if (!hasExplicitScore && !hasComputedScore) {
    return null;
  }

  const compositeAI = validateScore(rawComposite, computeAverageScore(dimensions));
  const confidence = validateConfidence(parsed.confidence);
  const narrative = validateNarrative(parsed.narrative, parsed.recommendation);

  return {
    dimensions,
    compositeAI,
    confidence,
    narrative,
    tier,
    timestamp: Date.now(),
  };
}

/**
 * Creates a safe fallback `AIAnalysisResult` when parsing fails entirely.
 *
 * Returns a neutral result with:
 * - All 5 dimensions at score 50 (neutral midpoint)
 * - Composite AI score of 50
 * - Confidence level 'low' (indicating unreliable data)
 * - Generic fallback narrative
 *
 * This ensures the signal pipeline NEVER crashes due to LLM response issues.
 * The fallback is designed to be non-actionable (low confidence prevents
 * the signal engine from treating it as a real analysis).
 *
 * @param tier - The LLM tier for the failed analysis attempt
 * @returns A neutral `AIAnalysisResult` with safe defaults
 */
export function createFallbackResult(tier: LLMTier): AIAnalysisResult {
  return {
    dimensions: getDefaultDimensions(),
    compositeAI: DEFAULT_SCORE,
    confidence: 'low',
    narrative: FALLBACK_NARRATIVE,
    tier,
    timestamp: Date.now(),
  };
}

/**
 * Returns the 5 default analysis dimensions with neutral scores.
 *
 * Each dimension corresponds to one of the canonical analysis dimensions
 * defined in the AAP:
 * 1. on-chain momentum — buy/sell ratio in first 5 minutes
 * 2. social velocity — tweet rate acceleration
 * 3. wallet intelligence — known profitable wallets accumulating
 * 4. liquidity health — LP, bundle detection, creator behavior
 * 5. narrative fit — token name/theme trend alignment
 *
 * All scores are set to 50 (neutral) with 'No data available' reasoning.
 *
 * @returns Array of 5 `AnalysisDimension` objects with neutral scores
 */
export function getDefaultDimensions(): AnalysisDimension[] {
  return CANONICAL_DIMENSION_NAMES.map((name) => ({
    name,
    score: DEFAULT_SCORE,
    reasoning: DEFAULT_REASONING,
  }));
}

/**
 * Validates and clamps a raw score value to the 0–100 range.
 *
 * Accepts any unknown value and produces a valid numeric score:
 * - Numbers are clamped to [0, 100]
 * - Numeric strings are parsed and clamped
 * - NaN, undefined, null, or non-numeric values use the provided fallback
 *
 * @param raw - The raw score value from the LLM response
 * @param fallback - Fallback score to use if raw is invalid (default: 50)
 * @returns A valid score between 0 and 100 (inclusive)
 *
 * @example
 * ```typescript
 * validateScore(85, 50);    // → 85
 * validateScore(150, 50);   // → 100 (clamped)
 * validateScore(-10, 50);   // → 0 (clamped)
 * validateScore(null, 50);  // → 50 (fallback)
 * validateScore('75', 50);  // → 75 (parsed)
 * ```
 */
export function validateScore(raw: unknown, fallback: number = DEFAULT_SCORE): number {
  // Handle null/undefined
  if (raw === null || raw === undefined) {
    return clampScore(fallback);
  }

  // Handle numeric values directly
  if (typeof raw === 'number') {
    if (Number.isNaN(raw) || !Number.isFinite(raw)) {
      return clampScore(fallback);
    }
    return clampScore(raw);
  }

  // Handle numeric strings
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // Empty string or whitespace-only → fallback (Number('') === 0 is misleading)
    if (trimmed.length === 0) {
      return clampScore(fallback);
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      return clampScore(fallback);
    }
    return clampScore(parsed);
  }

  // Anything else → fallback
  return clampScore(fallback);
}

/**
 * Validates and normalizes a raw confidence value from the LLM response.
 *
 * LLMs may produce various confidence strings (e.g., 'HIGH', 'Very High',
 * 'moderate', 'weak'). This function normalizes all recognized variations
 * to the canonical 'high' | 'medium' | 'low' values.
 *
 * Unrecognized values default to 'medium' as a safe middle ground.
 *
 * @param raw - The raw confidence value from the LLM response
 * @returns Normalized confidence level: 'high' | 'medium' | 'low'
 *
 * @example
 * ```typescript
 * validateConfidence('HIGH');      // → 'high'
 * validateConfidence('moderate');  // → 'medium'
 * validateConfidence('weak');      // → 'low'
 * validateConfidence('xyz');       // → 'medium' (default)
 * validateConfidence(null);        // → 'medium' (default)
 * ```
 */
export function validateConfidence(raw: unknown): 'high' | 'medium' | 'low' {
  // Handle non-string inputs
  if (raw === null || raw === undefined || typeof raw !== 'string') {
    return 'medium';
  }

  // Normalize: trim, lowercase
  const normalized = raw.trim().toLowerCase();

  if (normalized.length === 0) {
    return 'medium';
  }

  // Direct map lookup for known variations
  const mapped = CONFIDENCE_MAP.get(normalized);
  if (mapped !== undefined) {
    return mapped;
  }

  // Partial matching: check if the string contains key terms
  if (normalized.includes('high') || normalized.includes('strong')) {
    return 'high';
  }
  if (normalized.includes('low') || normalized.includes('weak') || normalized.includes('uncertain')) {
    return 'low';
  }
  if (normalized.includes('medium') || normalized.includes('moderate') || normalized.includes('mid')) {
    return 'medium';
  }

  // Unrecognized: safe default
  return 'medium';
}

/**
 * Validates and normalizes narrative text from the LLM response.
 *
 * Accepts a primary narrative and an optional fallback recommendation field.
 * Ensures the returned string is non-empty and within the maximum length
 * (500 characters) to prevent excessive storage consumption.
 *
 * @param narrative - Primary narrative text from the LLM
 * @param recommendation - Fallback recommendation text (some prompts use this field)
 * @returns A validated narrative string, truncated to 500 characters if necessary
 *
 * @example
 * ```typescript
 * validateNarrative('Strong momentum detected.', null);  // → 'Strong momentum detected.'
 * validateNarrative(null, 'Buy signal.');                 // → 'Buy signal.'
 * validateNarrative(null, null);                          // → default message
 * ```
 */
export function validateNarrative(narrative: unknown, recommendation: unknown): string {
  // Try primary narrative first
  if (typeof narrative === 'string') {
    const trimmed = narrative.trim();
    if (trimmed.length > 0) {
      return truncateString(trimmed, MAX_NARRATIVE_LENGTH);
    }
  }

  // Fall back to recommendation field
  if (typeof recommendation === 'string') {
    const trimmed = recommendation.trim();
    if (trimmed.length > 0) {
      return truncateString(trimmed, MAX_NARRATIVE_LENGTH);
    }
  }

  // Both missing: return generic default
  return DEFAULT_NARRATIVE;
}

// ---------------------------------------------------------------------------
// Internal Helper Functions
// ---------------------------------------------------------------------------

/**
 * Clamps a numeric value to the [0, 100] score range.
 *
 * @param value - The numeric value to clamp
 * @returns The value clamped to [MIN_SCORE, MAX_SCORE]
 */
function clampScore(value: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(value)));
}

/**
 * Truncates a string to the specified maximum length.
 * If truncated, appends '...' to indicate truncation.
 *
 * @param str - The string to truncate
 * @param maxLen - Maximum allowed length
 * @returns The original string if within limits, or truncated with '...'
 */
function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Extracts the composite score from a raw LLM response, checking
 * multiple possible field names that different LLMs may use.
 *
 * @param parsed - The parsed raw LLM response object
 * @returns The raw composite score value, or undefined if not found
 */
function extractCompositeScore(parsed: RawLLMResponse): unknown {
  // Check primary field name first
  if (parsed.compositeScore !== undefined && parsed.compositeScore !== null) {
    return parsed.compositeScore;
  }
  // Check alternative field names
  if (parsed.overall_score !== undefined && parsed.overall_score !== null) {
    return parsed.overall_score;
  }
  if (parsed.composite_score !== undefined && parsed.composite_score !== null) {
    return parsed.composite_score;
  }
  return undefined;
}

/**
 * Parses raw dimension data from the LLM response into typed AnalysisDimension[].
 *
 * If the raw input is not an array or is empty, returns default dimensions
 * with neutral scores. For each raw dimension:
 * - Validates `name` is a non-empty string
 * - Validates `score` is a number in [0, 100] (clamps if outside range)
 * - Validates `reasoning` is a non-empty string (checks alternative fields)
 *
 * After parsing provided dimensions, fills in any missing canonical dimensions
 * with default values to ensure all 5 dimensions are always present.
 *
 * @param raw - The raw dimensions array from the LLM response
 * @returns Array of typed `AnalysisDimension` objects (always contains all 5 dimensions)
 */
function parseDimensions(raw: unknown): AnalysisDimension[] {
  // If not an array or empty, return defaults
  if (!Array.isArray(raw) || raw.length === 0) {
    return getDefaultDimensions();
  }

  // Parse each raw dimension
  const parsedDimensions: AnalysisDimension[] = [];
  const seenNames = new Set<string>();

  for (const item of raw) {
    if (item === null || item === undefined || typeof item !== 'object') {
      continue;
    }

    const rawDim = item as RawDimension;
    const dimension = parseSingleDimension(rawDim);

    if (dimension !== null) {
      // Avoid duplicate dimension names
      const normalizedName = dimension.name.toLowerCase().trim();
      if (!seenNames.has(normalizedName)) {
        seenNames.add(normalizedName);
        parsedDimensions.push(dimension);
      }
    }
  }

  // If no valid dimensions were parsed, return defaults
  if (parsedDimensions.length === 0) {
    return getDefaultDimensions();
  }

  // Fill in missing canonical dimensions with defaults
  for (const canonicalName of CANONICAL_DIMENSION_NAMES) {
    const exists = parsedDimensions.some(
      (d) => d.name.toLowerCase().trim() === canonicalName.toLowerCase(),
    );
    if (!exists) {
      parsedDimensions.push({
        name: canonicalName,
        score: DEFAULT_SCORE,
        reasoning: DEFAULT_REASONING,
      });
    }
  }

  return parsedDimensions;
}

/**
 * Parses a single raw dimension object into a typed AnalysisDimension.
 *
 * @param rawDim - The raw dimension object
 * @returns A typed AnalysisDimension, or null if the dimension is unparseable
 */
function parseSingleDimension(rawDim: RawDimension): AnalysisDimension | null {
  // Validate name: must be a non-empty string
  const name = extractDimensionName(rawDim.name);
  if (name === null) {
    return null;
  }

  // Validate score: number in [0, 100], clamp if outside range
  const score = validateScore(rawDim.score, DEFAULT_SCORE);

  // Validate reasoning: check multiple possible field names
  const reasoning = extractReasoning(rawDim);

  return {
    name,
    score,
    reasoning,
  };
}

/**
 * Extracts and validates a dimension name from raw input.
 *
 * @param raw - The raw name value
 * @returns A validated name string, or null if invalid
 */
function extractDimensionName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

/**
 * Extracts reasoning text from a raw dimension object, checking
 * multiple possible field names.
 *
 * @param rawDim - The raw dimension object
 * @returns The reasoning string, or a default if none found
 */
function extractReasoning(rawDim: RawDimension): string {
  // Check 'reasoning' field first
  if (typeof rawDim.reasoning === 'string' && rawDim.reasoning.trim().length > 0) {
    return truncateString(rawDim.reasoning.trim(), MAX_NARRATIVE_LENGTH);
  }
  // Check 'explanation' alternative field
  if (typeof rawDim.explanation === 'string' && rawDim.explanation.trim().length > 0) {
    return truncateString(rawDim.explanation.trim(), MAX_NARRATIVE_LENGTH);
  }
  // Check 'analysis' alternative field
  if (typeof rawDim.analysis === 'string' && rawDim.analysis.trim().length > 0) {
    return truncateString(rawDim.analysis.trim(), MAX_NARRATIVE_LENGTH);
  }
  return DEFAULT_REASONING;
}

/**
 * Computes the simple average of all dimension scores.
 *
 * Used as the fallback composite score when the LLM does not provide
 * an explicit composite score. Returns 50 (neutral) for empty arrays.
 *
 * @param dimensions - Array of analysis dimensions with scores
 * @returns The rounded average score, or 50 if the array is empty
 */
function computeAverageScore(dimensions: AnalysisDimension[]): number {
  if (dimensions.length === 0) {
    return DEFAULT_SCORE;
  }
  const sum = dimensions.reduce((acc, d) => acc + d.score, 0);
  return Math.round(sum / dimensions.length);
}
