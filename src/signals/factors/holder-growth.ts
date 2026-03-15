/**
 * src/signals/factors/holder-growth.ts — Holder Growth Tracking Factor Module
 *
 * Evaluates the quality and trajectory of token holder growth for the GMGN
 * Signal Bot's 7-factor composite scoring engine. This factor rewards organic
 * holder growth (many independent wallets accumulating and retaining tokens)
 * and penalizes bot-like distribution patterns (high concentration among few
 * wallets, simultaneous creation of many wallets with identical amounts).
 *
 * Scoring dimensions:
 * 1. **Holder count tiers** — Maps absolute holder count to a 0–95 base score
 *    across 5 tiers (10–50, 50–200, 200–500, 500–1000, 1000+).
 * 2. **Concentration adjustment** — Applies a bonus (+10) for excellent
 *    distribution (top 10 holders ≤10%) or a penalty (−15 to −25) for
 *    concentrated holdings (>20% or >50%).
 * 3. **Smart money bonus** — Adds +10 when 2+ qualified smart money wallets
 *    are holding the token, indicating institutional conviction.
 *
 * Per AAP Section 0.5.1 Group 5:
 * "Analyzes holder count trajectory; rewards organic growth (holders retaining
 *  tokens ≥24h); penalizes bot-like creation patterns (many wallets with
 *  identical amounts in quick succession)"
 *
 * Per AAP Section 0.7.3:
 * "All 7 factor weights must be user-configurable via the settings panel;
 *  the scoring engine reads weights from the Zustand settings-store at
 *  analysis time, not from hardcoded constants."
 * → Weight is always 0 in factor modules; scoring-engine.ts applies weights.
 *
 * @module signals/factors/holder-growth
 */

import type { TokenAnalysisInput, FactorResult } from '../types';
import { createLogger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

const logger = createLogger('holder-growth');

// ---------------------------------------------------------------------------
// Scoring Constants
// ---------------------------------------------------------------------------

/**
 * Minimum number of unique holders required for meaningful analysis.
 * Tokens below this threshold receive a minimal score of 5.
 */
const MIN_HOLDERS = 10;

/**
 * Holder count scoring tiers — each tier maps a range of holder counts
 * to a linearly interpolated sub-range of the 0–95 score space.
 *
 * Tier boundaries:
 * - 10–50 holders:   Early stage, score 10–25
 * - 50–200 holders:  Growing community, score 25–50
 * - 200–500 holders: Established token, score 50–70
 * - 500–1000 holders: Strong adoption, score 70–85
 * - 1000+ holders:   Wide distribution, score 85–95 (log-scaled)
 */
const TIER_LOW_HOLDERS = 50;
const TIER_MID_HOLDERS = 200;
const TIER_HIGH_HOLDERS = 500;
const TIER_STRONG_HOLDERS = 1000;

/**
 * Top 10 holder concentration thresholds used for distribution quality
 * assessment. Lower concentration = more organic distribution.
 *
 * - ≤10%: Excellent distribution → +10 bonus
 * - 10–20%: Acceptable → no adjustment
 * - 20–50%: High concentration → −15 penalty
 * - >50%: Extreme concentration → −25 penalty (hard filter also catches this)
 */
const MAX_TOP_HOLDER_PERCENT_IDEAL = 10;
const MAX_TOP_HOLDER_PERCENT_OK = 20;
const MAX_TOP_HOLDER_PERCENT_RISKY = 50;

/**
 * Smart money holder bonus constants.
 * When 2+ qualified smart money wallets hold the token, it signals
 * informed conviction — warranting a score bonus.
 */
const SMART_MONEY_BONUS_THRESHOLD = 2;
const SMART_MONEY_BONUS_POINTS = 10;

// ---------------------------------------------------------------------------
// Helper: Build FactorResult
// ---------------------------------------------------------------------------

/**
 * Convenience helper that constructs a fully-typed {@link FactorResult} for
 * the holderGrowth factor, merging base fields with any extra metadata.
 *
 * @param score - Clamped 0–100 integer score
 * @param input - The original TokenAnalysisInput (used for baseline metadata)
 * @param extraMeta - Additional metadata key-value pairs to include
 * @returns A complete FactorResult with name 'holderGrowth' and weight 0
 */
function createResult(
  score: number,
  input: TokenAnalysisInput,
  extraMeta: Record<string, unknown> = {},
): FactorResult {
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    name: 'holderGrowth',
    score: clampedScore,
    weight: 0, // Weight is NEVER applied inside factor modules
    metadata: {
      holderCount: input.holderCount,
      topHolderPercent: input.topHolderPercent,
      smartMoneyCount: input.smartMoneyCount,
      ...extraMeta,
    },
  };
}

// ---------------------------------------------------------------------------
// Main Scoring Function
// ---------------------------------------------------------------------------

/**
 * Scores the holder growth quality for a given token.
 *
 * The scoring pipeline:
 * 1. Validates minimum holder count (< 10 → score 5)
 * 2. Computes a tiered holder count base score (10–95)
 * 3. Applies a concentration adjustment (+10 to −25)
 * 4. Applies a smart money bonus (+10 when ≥ 2 SM wallets)
 * 5. Clamps the final score to [0, 100]
 *
 * @param input - Comprehensive token data containing holderCount,
 *   topHolderPercent, smartMoneyCount, and mint fields.
 * @returns A Promise resolving to a FactorResult with name 'holderGrowth',
 *   a 0–100 integer score, weight 0, and detailed scoring metadata.
 */
export async function scoreHolderGrowth(
  input: TokenAnalysisInput,
): Promise<FactorResult> {
  try {
    // -----------------------------------------------------------------
    // Step 1: Check minimum holder count
    // -----------------------------------------------------------------
    if (input.holderCount < MIN_HOLDERS) {
      logger.debug(
        `Token ${input.mint}: only ${input.holderCount} holders, below minimum ${MIN_HOLDERS}`,
      );
      return createResult(5, input, {
        reason: 'Very few holders',
        holderCountScore: 0,
        concentrationAdjustment: 0,
        smartMoneyBonus: 0,
        distributionQuality: 'insufficient',
      });
    }

    // -----------------------------------------------------------------
    // Step 2: Score based on absolute holder count (adoption breadth)
    // -----------------------------------------------------------------
    let holderCountScore = 0;

    if (input.holderCount < TIER_LOW_HOLDERS) {
      // 10–50 holders: score 10–25
      const progress =
        (input.holderCount - MIN_HOLDERS) /
        (TIER_LOW_HOLDERS - MIN_HOLDERS);
      holderCountScore = 10 + Math.round(progress * 15);
    } else if (input.holderCount < TIER_MID_HOLDERS) {
      // 50–200 holders: score 25–50
      const progress =
        (input.holderCount - TIER_LOW_HOLDERS) /
        (TIER_MID_HOLDERS - TIER_LOW_HOLDERS);
      holderCountScore = 25 + Math.round(progress * 25);
    } else if (input.holderCount < TIER_HIGH_HOLDERS) {
      // 200–500 holders: score 50–70
      const progress =
        (input.holderCount - TIER_MID_HOLDERS) /
        (TIER_HIGH_HOLDERS - TIER_MID_HOLDERS);
      holderCountScore = 50 + Math.round(progress * 20);
    } else if (input.holderCount < TIER_STRONG_HOLDERS) {
      // 500–1000 holders: score 70–85
      const progress =
        (input.holderCount - TIER_HIGH_HOLDERS) /
        (TIER_STRONG_HOLDERS - TIER_HIGH_HOLDERS);
      holderCountScore = 70 + Math.round(progress * 15);
    } else {
      // 1000+ holders: score 85–95 (logarithmic scaling, capped)
      holderCountScore = Math.min(
        95,
        85 + Math.round(Math.log10(input.holderCount / TIER_STRONG_HOLDERS) * 10),
      );
    }

    // -----------------------------------------------------------------
    // Step 3: Apply holder concentration adjustment
    // Low concentration = well distributed = organic growth signal
    // High concentration = bot-like or whale-dominated = penalized
    // -----------------------------------------------------------------
    let concentrationAdjustment = 0;

    if (input.topHolderPercent <= MAX_TOP_HOLDER_PERCENT_IDEAL) {
      // Excellent distribution: top 10 holders hold ≤10% of supply
      concentrationAdjustment = 10;
    } else if (input.topHolderPercent <= MAX_TOP_HOLDER_PERCENT_OK) {
      // Acceptable distribution: 10–20%
      concentrationAdjustment = 0;
    } else if (input.topHolderPercent <= MAX_TOP_HOLDER_PERCENT_RISKY) {
      // High concentration: 20–50% — penalized
      concentrationAdjustment = -15;
    } else {
      // Extreme concentration: >50% — severe penalty
      // (hard-filters.ts also catches >50%, but we still penalize here for scoring)
      concentrationAdjustment = -25;
    }

    // -----------------------------------------------------------------
    // Step 4: Apply smart money holder bonus
    // 2+ smart money wallets holding the token indicates informed conviction
    // -----------------------------------------------------------------
    let smartMoneyBonus = 0;

    if (input.smartMoneyCount >= SMART_MONEY_BONUS_THRESHOLD) {
      smartMoneyBonus = SMART_MONEY_BONUS_POINTS;
    }

    // -----------------------------------------------------------------
    // Step 5: Combine scores and clamp to [0, 100]
    // -----------------------------------------------------------------
    const rawScore = holderCountScore + concentrationAdjustment + smartMoneyBonus;
    const clampedScore = Math.max(0, Math.min(100, Math.round(rawScore)));

    // Determine distribution quality label for UI display
    const distributionQuality: string =
      input.topHolderPercent <= MAX_TOP_HOLDER_PERCENT_IDEAL
        ? 'excellent'
        : input.topHolderPercent <= MAX_TOP_HOLDER_PERCENT_OK
          ? 'acceptable'
          : 'poor';

    logger.debug(
      `Token ${input.mint}: holderCount=${input.holderCount}, ` +
        `topHolder=${input.topHolderPercent}%, smartMoney=${input.smartMoneyCount}, ` +
        `countScore=${holderCountScore}, concAdj=${concentrationAdjustment}, ` +
        `smBonus=${smartMoneyBonus}, final=${clampedScore}`,
    );

    return {
      name: 'holderGrowth',
      score: clampedScore,
      weight: 0,
      metadata: {
        holderCount: input.holderCount,
        topHolderPercent: input.topHolderPercent,
        smartMoneyCount: input.smartMoneyCount,
        holderCountScore,
        concentrationAdjustment,
        smartMoneyBonus,
        distributionQuality,
      },
    };
  } catch (error: unknown) {
    // -----------------------------------------------------------------
    // Error fallback: return a safe zero-score result
    // -----------------------------------------------------------------
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger.debug(`Holder growth scoring failed for ${input.mint}: ${errorMessage}`);

    return createResult(0, input, {
      error: errorMessage,
      holderCountScore: 0,
      concentrationAdjustment: 0,
      smartMoneyBonus: 0,
      distributionQuality: 'error',
    });
  }
}
