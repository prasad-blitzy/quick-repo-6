/**
 * @fileoverview Buy/Sell Ratio Analysis Factor Module
 *
 * Evaluates buy/sell pressure by comparing the number of buy transactions vs sell
 * transactions across 1-hour and 24-hour windows. A high buy/sell ratio indicates
 * accumulation (buying pressure outweighs selling), which is a positive trading signal.
 *
 * Scoring thresholds (per AAP Section 0.5.1 Group 5):
 * - ≥1.3× buy/sell ratio = base accumulation signal (score ~40+)
 * - ≥2.0× buy/sell ratio = strong accumulation / day-trade mode amplification (score ~65+)
 * - ≥3.0× buy/sell ratio = extreme accumulation (score ~85+)
 *
 * Data sources:
 * - GMGN.ai intercepted API responses (buys1h, sells1h, buys24h, sells24h fields)
 *
 * Weighting strategy:
 * - 1-hour data receives 70% weight for freshness
 * - 24-hour data receives 30% weight for reliability
 * - Falls back to 100% 24h data when 1h transaction count is insufficient
 *
 * Confidence adjustment:
 * - Scores are penalized when transaction count is low (<50 per hour)
 * - Full confidence reached at 100+ transactions per hour
 *
 * @module signals/factors/buy-sell-ratio
 */

import type { TokenAnalysisInput, FactorResult } from '../types';
import { createLogger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Logger instance with 'buy-sell-ratio' context tag for structured logging.
 * Used for debugging ratio calculations and flagging insufficient data conditions.
 */
const logger = createLogger('buy-sell-ratio');

// ---------------------------------------------------------------------------
// Scoring Constants
// ---------------------------------------------------------------------------

/**
 * Minimum buy/sell ratio to qualify as an accumulation signal.
 * Per AAP: "minimum ≥1.3× for base accumulation signal"
 *
 * Ratios below this indicate neutral or selling pressure.
 */
const MIN_ACCUMULATION_RATIO = 1.3;

/**
 * Buy/sell ratio indicating strong accumulation suitable for day-trade mode.
 * Per AAP: "≥2.0× combined with volume spike for day-trade mode amplification"
 *
 * Tokens reaching this ratio show significant buying conviction.
 */
const STRONG_ACCUMULATION_RATIO = 2.0;

/**
 * Buy/sell ratio indicating extreme buying pressure.
 * Scores above this level reach the 85–100 range with diminishing returns.
 */
const EXTREME_ACCUMULATION_RATIO = 3.0;

/**
 * Maximum meaningful ratio cap for score calculation.
 * Ratios above this value are clamped to prevent unrealistic scores from
 * tokens with very few sell transactions. Also used as a fallback value
 * when sell count is zero but buy count is positive.
 */
const MAX_MEANINGFUL_RATIO = 5.0;

/**
 * Minimum number of transactions in the 1-hour window for the ratio
 * to be considered statistically meaningful. Below this threshold,
 * the 1h ratio is not used in the effective ratio calculation.
 */
const MIN_TRANSACTIONS_1H = 10;

/**
 * Minimum number of transactions in the 24-hour window for the ratio
 * to be considered reliable. When BOTH 1h and 24h transaction counts
 * are below their respective minimums, the factor returns score 0.
 */
const MIN_TRANSACTIONS_24H = 50;

/**
 * Weight applied to the 1-hour ratio in the effective ratio calculation.
 * Recent data is weighted more heavily for freshness (70%).
 */
const WEIGHT_1H = 0.7;

/**
 * Weight applied to the 24-hour ratio in the effective ratio calculation.
 * Longer-term data provides reliability context (30%).
 */
const WEIGHT_24H = 0.3;

/**
 * Transaction count at which full confidence is achieved.
 * Below this, scores receive a confidence penalty proportional
 * to the ratio of actual transactions to this threshold.
 */
const FULL_CONFIDENCE_TXNS = 100;

/**
 * Confidence threshold below which the score receives a penalty.
 * When txnConfidence < 0.5, the score is reduced by a multiplier
 * of (0.5 + txnConfidence), effectively scaling the score between
 * 50% and 100% of its raw value.
 */
const CONFIDENCE_PENALTY_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Creates a standardized FactorResult for the buy/sell ratio factor.
 *
 * This convenience helper ensures consistent structure across all return paths
 * (normal scoring, insufficient data, and error cases).
 *
 * @param score - Factor score in range [0, 100] (clamped internally)
 * @param input - The original TokenAnalysisInput for metadata extraction
 * @param extraMeta - Additional metadata fields (e.g., error reason, ratio data)
 * @returns A fully populated FactorResult object
 */
function createResult(
  score: number,
  input: TokenAnalysisInput,
  extraMeta: Record<string, unknown> = {},
): FactorResult {
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    name: 'buySellRatio',
    score: clampedScore,
    weight: 0,
    metadata: {
      buys1h: input.buys1h,
      sells1h: input.sells1h,
      buys24h: input.buys24h,
      sells24h: input.sells24h,
      ...extraMeta,
    },
  };
}

/**
 * Calculates the buy/sell ratio for a given window, handling division-by-zero.
 *
 * When the sell count is zero:
 * - If buys > 0, returns MAX_MEANINGFUL_RATIO (capped to prevent infinite ratios)
 * - If buys === 0, returns 0 (no activity)
 *
 * @param buys - Number of buy transactions in the window
 * @param sells - Number of sell transactions in the window
 * @returns The computed buy/sell ratio, capped at MAX_MEANINGFUL_RATIO
 */
function calculateRatio(buys: number, sells: number): number {
  if (sells > 0) {
    return buys / sells;
  }
  return buys > 0 ? MAX_MEANINGFUL_RATIO : 0;
}

/**
 * Maps an effective buy/sell ratio to a raw score in the range [0, 100].
 *
 * Score distribution:
 * - ratio < 1.0: Selling pressure — score 0–25 (linear scale, ratio × 25)
 * - ratio 1.0–1.3: Slight buying — score 25–40 (linear interpolation)
 * - ratio 1.3–2.0: Base accumulation — score 40–65 (linear interpolation)
 * - ratio 2.0–3.0: Strong accumulation — score 65–85 (linear interpolation)
 * - ratio 3.0+: Extreme accumulation — score 85–100 (diminishing returns)
 *
 * @param effectiveRatio - The weighted effective buy/sell ratio
 * @returns Raw score before confidence adjustment
 */
function mapRatioToScore(effectiveRatio: number): number {
  if (effectiveRatio < 1.0) {
    // Selling pressure outweighs buying — low score
    // Ratio 0.5 → score ~13, ratio 0.8 → score ~20
    return Math.round(effectiveRatio * 25);
  }

  if (effectiveRatio < MIN_ACCUMULATION_RATIO) {
    // Slight buying pressure but below accumulation threshold (1.0–1.3×)
    const progress = (effectiveRatio - 1.0) / (MIN_ACCUMULATION_RATIO - 1.0);
    return 25 + Math.round(progress * 15);
  }

  if (effectiveRatio < STRONG_ACCUMULATION_RATIO) {
    // Base accumulation signal (1.3–2.0× per AAP)
    const progress =
      (effectiveRatio - MIN_ACCUMULATION_RATIO) /
      (STRONG_ACCUMULATION_RATIO - MIN_ACCUMULATION_RATIO);
    return 40 + Math.round(progress * 25);
  }

  if (effectiveRatio < EXTREME_ACCUMULATION_RATIO) {
    // Strong accumulation (2.0–3.0× per AAP: "day-trade mode amplification")
    const progress =
      (effectiveRatio - STRONG_ACCUMULATION_RATIO) /
      (EXTREME_ACCUMULATION_RATIO - STRONG_ACCUMULATION_RATIO);
    return 65 + Math.round(progress * 20);
  }

  // Extreme accumulation (3.0×+): score 85–100 with diminishing returns
  const extraFactor = Math.min(
    1,
    (effectiveRatio - EXTREME_ACCUMULATION_RATIO) /
      (MAX_MEANINGFUL_RATIO - EXTREME_ACCUMULATION_RATIO),
  );
  return 85 + Math.round(extraFactor * 15);
}

/**
 * Applies a confidence penalty to the raw score based on 1-hour transaction volume.
 *
 * When the 1h transaction count is below the full confidence threshold (100 txns),
 * a proportional penalty is applied. The penalty only activates when confidence
 * drops below 0.5 (< 50 txns/hr), scaling the score between 50%–100% of its raw value.
 *
 * @param rawScore - The score before confidence adjustment
 * @param totalTxns1h - Total number of transactions in the 1-hour window
 * @returns Score adjusted for confidence, still in [0, 100] range
 */
function applyConfidenceAdjustment(rawScore: number, totalTxns1h: number): number {
  const txnConfidence = Math.min(1, totalTxns1h / FULL_CONFIDENCE_TXNS);

  if (txnConfidence < CONFIDENCE_PENALTY_THRESHOLD) {
    return Math.round(rawScore * (CONFIDENCE_PENALTY_THRESHOLD + txnConfidence));
  }

  return rawScore;
}

// ---------------------------------------------------------------------------
// Main Scoring Function
// ---------------------------------------------------------------------------

/**
 * Computes the buy/sell ratio factor score for a token.
 *
 * Evaluates accumulation pressure by comparing buy and sell transaction counts
 * across 1-hour and 24-hour windows. Returns a FactorResult with:
 * - score: 0–100 integer representing buy/sell pressure quality
 * - weight: always 0 (weight is applied by the scoring engine, not factors)
 * - metadata: detailed breakdown including ratios, effective ratio, and flags
 *
 * Algorithm:
 * 1. Validate sufficient transaction count for meaningful analysis
 * 2. Calculate buy/sell ratios for 1h and 24h windows
 * 3. Compute weighted effective ratio (70% 1h + 30% 24h)
 * 4. Map effective ratio to a 0–100 raw score
 * 5. Apply confidence adjustment based on transaction volume
 * 6. Clamp final score to [0, 100]
 *
 * @param input - Token analysis data containing buys/sells for 1h and 24h windows
 * @returns FactorResult with composite buy/sell ratio score and detailed metadata
 *
 * @example
 * ```typescript
 * const result = await scoreBuySellRatio({
 *   mint: 'TokenMintAddress...',
 *   buys1h: 50, sells1h: 10,  // 5:1 ratio → high score
 *   buys24h: 500, sells24h: 200,
 *   // ... other TokenAnalysisInput fields
 * });
 * // result.score ≈ 87 (high accumulation signal)
 * // result.metadata.isAccumulating === true
 * // result.metadata.isStrongAccumulation === true
 * ```
 */
export async function scoreBuySellRatio(
  input: TokenAnalysisInput,
): Promise<FactorResult> {
  try {
    // -----------------------------------------------------------------------
    // Step 1: Validate transaction count sufficiency
    // -----------------------------------------------------------------------
    const totalTxns1h = input.buys1h + input.sells1h;
    const totalTxns24h = input.buys24h + input.sells24h;

    if (totalTxns1h < MIN_TRANSACTIONS_1H && totalTxns24h < MIN_TRANSACTIONS_24H) {
      logger.debug(
        `Token ${input.mint}: insufficient transactions (1h=${totalTxns1h}, 24h=${totalTxns24h})`,
      );
      return createResult(0, input, {
        ratio1h: 0,
        ratio24h: 0,
        effectiveRatio: 0,
        totalTxns1h,
        totalTxns24h,
        isAccumulating: false,
        isStrongAccumulation: false,
        reason: 'Insufficient transaction count',
      });
    }

    // -----------------------------------------------------------------------
    // Step 2: Calculate buy/sell ratios for both time windows
    // -----------------------------------------------------------------------
    const ratio1h = calculateRatio(input.buys1h, input.sells1h);
    const ratio24h = calculateRatio(input.buys24h, input.sells24h);

    // -----------------------------------------------------------------------
    // Step 3: Compute weighted effective ratio
    // -----------------------------------------------------------------------
    // Weight recent data more heavily (70% 1h, 30% 24h) for freshness.
    // Falls back to 100% 24h data when 1h transaction count is insufficient.
    let effectiveRatio: number;
    if (totalTxns1h >= MIN_TRANSACTIONS_1H) {
      effectiveRatio = ratio1h * WEIGHT_1H + ratio24h * WEIGHT_24H;
    } else {
      // Not enough 1h data — rely entirely on 24h data
      effectiveRatio = ratio24h;
    }

    // -----------------------------------------------------------------------
    // Step 4: Map effective ratio to raw score (0–100)
    // -----------------------------------------------------------------------
    const rawScore = mapRatioToScore(effectiveRatio);

    // -----------------------------------------------------------------------
    // Step 5: Apply confidence adjustment based on transaction volume
    // -----------------------------------------------------------------------
    const adjustedScore = applyConfidenceAdjustment(rawScore, totalTxns1h);

    // -----------------------------------------------------------------------
    // Step 6: Clamp final score to [0, 100]
    // -----------------------------------------------------------------------
    const finalScore = Math.max(0, Math.min(100, Math.round(adjustedScore)));

    // -----------------------------------------------------------------------
    // Step 7: Build metadata and return result
    // -----------------------------------------------------------------------
    // Use rounded effectiveRatio (2 decimal places) for threshold comparisons
    // to avoid floating point precision issues (e.g., 1.3*0.7 + 1.3*0.3 = 1.2999999999999998)
    const roundedEffectiveRatio = Math.round(effectiveRatio * 100) / 100;
    const isAccumulating = roundedEffectiveRatio >= MIN_ACCUMULATION_RATIO;
    const isStrongAccumulation = roundedEffectiveRatio >= STRONG_ACCUMULATION_RATIO;

    logger.debug(
      `Token ${input.mint}: ratio1h=${ratio1h.toFixed(2)}, ratio24h=${ratio24h.toFixed(2)}, ` +
        `effective=${effectiveRatio.toFixed(2)}, score=${finalScore}, ` +
        `accumulating=${isAccumulating}, strong=${isStrongAccumulation}`,
    );

    return {
      name: 'buySellRatio',
      score: finalScore,
      weight: 0,
      metadata: {
        buys1h: input.buys1h,
        sells1h: input.sells1h,
        buys24h: input.buys24h,
        sells24h: input.sells24h,
        ratio1h: Math.round(ratio1h * 100) / 100,
        ratio24h: Math.round(ratio24h * 100) / 100,
        effectiveRatio: Math.round(effectiveRatio * 100) / 100,
        totalTxns1h,
        totalTxns24h,
        isAccumulating,
        isStrongAccumulation,
      },
    };
  } catch (error: unknown) {
    // -----------------------------------------------------------------------
    // Error handling: return score 0 with error metadata
    // -----------------------------------------------------------------------
    // Safely extract error message without re-throwing
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Safely extract mint for logging — input properties may be the error source
    let mintForLog = 'unknown';
    try {
      mintForLog = input.mint;
    } catch {
      // input.mint access failed — use fallback
    }

    logger.error(
      `Token ${mintForLog}: buy-sell-ratio scoring failed — ${errorMessage}`,
    );

    // Build error result without accessing potentially broken input properties
    // to avoid re-triggering the original error
    let safeInput: TokenAnalysisInput;
    try {
      safeInput = {
        ...input,
        buys1h: input.buys1h,
        sells1h: input.sells1h,
        buys24h: input.buys24h,
        sells24h: input.sells24h,
      };
    } catch {
      // If spreading input fails, create a minimal safe input
      safeInput = {
        mint: mintForLog,
        symbol: '',
        name: '',
        price: 0,
        priceChange5m: 0,
        priceChange1h: 0,
        priceChange24h: 0,
        marketCap: 0,
        volume5m: 0,
        volume1h: 0,
        volume24h: 0,
        liquidity: 0,
        supply: 0,
        buys1h: 0,
        sells1h: 0,
        buys24h: 0,
        sells24h: 0,
        holderCount: 0,
        topHolderPercent: 0,
      } as TokenAnalysisInput;
    }

    return createResult(0, safeInput, {
      ratio1h: 0,
      ratio24h: 0,
      effectiveRatio: 0,
      totalTxns1h: 0,
      totalTxns24h: 0,
      isAccumulating: false,
      isStrongAccumulation: false,
      error: errorMessage,
    });
  }
}
