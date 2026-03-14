/**
 * @fileoverview Smart Money Convergence Factor Module
 *
 * Evaluates the concentration and quality of smart money wallet activity on a
 * given Solana memecoin. This module is one of the 7 independent factor scorers
 * consumed by the composite scoring engine (`src/signals/scoring-engine.ts`).
 *
 * Scoring rules (per AAP Section 0.5.1 Group 5):
 *   - 1 whale/smart-money buy  → base score +10
 *   - 2+ whale/smart-money buys → base score +25
 *   - 3+ qualified wallets within 2-hour window (convergence) → base score ≥60
 *   - Position size ≥80% of historical average → conviction multiplier (1.3×)
 *
 * Data sources:
 *   - Primary: `ConvergenceEvent` from `src/tracking/convergence-detector.ts`
 *     (passed as an optional parameter by the scoring engine)
 *   - Fallback: `TokenAnalysisInput.smartMoneyCount` from intercepted GMGN data
 *
 * Design constraints:
 *   - Pure async function — no side effects beyond structured logging
 *   - Returns `FactorResult` with `weight: 0` (weights applied by scoring-engine)
 *   - Score always clamped to integer [0, 100]
 *   - No cross-dependencies with other factor modules
 *   - TypeScript strict mode — all types explicit
 *
 * @module signals/factors/smart-money-convergence
 */

import type { FactorResult, TokenAnalysisInput } from '../types';
import type { ConvergenceEvent } from '../../tracking/types';
import { createLogger } from '../../utils/logger';
import { SMART_MONEY_CONFIG } from '../../utils/config';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

const logger = createLogger('smart-money-convergence');

// ---------------------------------------------------------------------------
// Scoring Constants
// ---------------------------------------------------------------------------

/**
 * Base points awarded when exactly 1 smart money / whale wallet is detected
 * buying the token. Per AAP: "1 whale buy = +10".
 */
const SINGLE_WHALE_BONUS = 10;

/**
 * Base points awarded when 2 or more smart money / whale wallets are detected
 * buying the token. Per AAP: "2+ whales = +25".
 */
const MULTI_WHALE_BONUS = 25;

/**
 * Base score granted when a full convergence event is confirmed — i.e. 3+
 * qualified wallets entered the same token within the convergence window
 * (default 2 hours).
 */
const CONVERGENCE_BASE_SCORE = 60;

/**
 * Maximum achievable score. All computed values are clamped to [0, MAX_SCORE].
 */
const MAX_SCORE = 100;

/**
 * Multiplier applied to the computed score when the convergence event's
 * conviction score meets or exceeds the conviction threshold (80%).
 * This represents "entries above 80% of historical average indicating
 * conviction" (AAP Section 0.1.1).
 */
const CONVICTION_MULTIPLIER = 1.3;

/**
 * Bonus points added per additional wallet beyond the minimum convergence
 * threshold (3). Capped at `MAX_EXTRA_WALLET_BONUS` total.
 */
const EXTRA_WALLET_POINTS = 5;

/**
 * Maximum total bonus points from extra wallets above the convergence minimum.
 * 4 extra wallets × 5 points = 20 cap.
 */
const MAX_EXTRA_WALLET_BONUS = 20;

/**
 * Quality weight threshold — if the average quality weight of wallets in a
 * convergence event exceeds this value, a bonus is applied.
 */
const HIGH_QUALITY_WEIGHT_THRESHOLD = 0.8;

/**
 * Bonus points awarded when the average wallet quality weight exceeds
 * {@link HIGH_QUALITY_WEIGHT_THRESHOLD}.
 */
const HIGH_QUALITY_WEIGHT_BONUS = 5;

/**
 * Factor name constant used in every returned `FactorResult`. Must match the
 * `FactorName` union literal `'smartMoneyConvergence'` from `types.ts`.
 */
const FACTOR_NAME = 'smartMoneyConvergence' as const;

// ---------------------------------------------------------------------------
// Helper: Clamp a value to an integer in [0, 100]
// ---------------------------------------------------------------------------

/**
 * Clamps a numeric score to the integer range [0, 100].
 *
 * @param value - Raw score (may be fractional or out of bounds)
 * @returns Integer in the range [0, 100]
 */
function clampScore(value: number): number {
  return Math.min(MAX_SCORE, Math.max(0, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Scoring Path 1: Full Convergence Event Data
// ---------------------------------------------------------------------------

/**
 * Computes the smart money convergence score using detailed data from the
 * `ConvergenceDetector` module.
 *
 * Scoring logic:
 * 1. Start at {@link CONVERGENCE_BASE_SCORE} (60) — the detector already
 *    confirmed 3+ qualified wallets within the time window.
 * 2. Add bonus for extra wallets above the minimum:
 *    each additional wallet adds {@link EXTRA_WALLET_POINTS} (5) points,
 *    capped at {@link MAX_EXTRA_WALLET_BONUS} (20).
 * 3. If the average quality weight of wallets exceeds
 *    {@link HIGH_QUALITY_WEIGHT_THRESHOLD} (0.8), add
 *    {@link HIGH_QUALITY_WEIGHT_BONUS} (5) points.
 * 4. Apply the {@link CONVICTION_MULTIPLIER} (1.3×) if the conviction score
 *    meets or exceeds the configured threshold (default 80%).
 * 5. Clamp the final score to an integer in [0, 100].
 *
 * @param input - Token analysis data (used for metadata/logging context)
 * @param event - Convergence event from the convergence detector
 * @returns Populated `FactorResult`
 */
function scoreFromConvergenceEvent(
  input: TokenAnalysisInput,
  event: ConvergenceEvent,
): FactorResult {
  const minWallets = SMART_MONEY_CONFIG.MIN_CONVERGENCE_WALLETS;
  const convictionThreshold = SMART_MONEY_CONFIG.CONVICTION_THRESHOLD_PERCENT;

  // Step 1: Base score for confirmed convergence
  let score = CONVERGENCE_BASE_SCORE;

  // Step 2: Bonus for extra wallets above the convergence minimum
  const extraWallets = Math.max(0, event.walletCount - minWallets);
  const walletBonus = Math.min(extraWallets * EXTRA_WALLET_POINTS, MAX_EXTRA_WALLET_BONUS);
  score += walletBonus;

  // Step 3: Quality weight bonus for high-quality smart money wallets
  if (event.avgQualityWeight > HIGH_QUALITY_WEIGHT_THRESHOLD) {
    score += HIGH_QUALITY_WEIGHT_BONUS;
  }

  // Step 4: Conviction multiplier — applies when wallets invest above 80%
  //         of their historical average position sizes
  if (event.convictionScore >= convictionThreshold) {
    score = score * CONVICTION_MULTIPLIER;
  }

  // Step 5: Clamp to integer [0, 100]
  const finalScore = clampScore(score);

  logger.debug(
    `Convergence scoring for ${input.symbol}: ` +
    `wallets=${event.walletCount}, conviction=${event.convictionScore}, ` +
    `quality=${event.avgQualityWeight.toFixed(2)}, score=${finalScore}`,
  );

  return {
    name: FACTOR_NAME,
    score: finalScore,
    weight: 0,
    metadata: {
      smartMoneyCount: input.smartMoneyCount,
      convergenceDetected: true,
      convergenceWalletCount: event.walletCount,
      convictionScore: event.convictionScore,
      avgQualityWeight: event.avgQualityWeight,
      extraWalletBonus: walletBonus,
      convictionMultiplierApplied: event.convictionScore >= convictionThreshold,
      source: 'convergence-detector',
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring Path 2: Basic Smart Money Count (fallback)
// ---------------------------------------------------------------------------

/**
 * Computes the smart money convergence score using only the basic
 * `smartMoneyCount` field from the `TokenAnalysisInput`.
 *
 * This fallback path is used when no `ConvergenceEvent` is available —
 * for example, when the convergence detector hasn't fired yet or the
 * tracking module is not active.
 *
 * Scoring tiers:
 *   - 0 wallets → score 0   (no smart money interest)
 *   - 1 wallet  → score 10  (SINGLE_WHALE_BONUS per AAP)
 *   - 2 wallets → score 25  (MULTI_WHALE_BONUS per AAP)
 *   - 3+ wallets → score 50 (partial convergence, unconfirmed by detector)
 *
 * Note: The 3+ wallet basic score (50) is intentionally lower than the
 * convergence base score (60) because the convergence detector has not
 * confirmed the time-window requirement.
 *
 * @param input - Token analysis data containing `smartMoneyCount`
 * @returns Populated `FactorResult`
 */
function scoreFromBasicData(input: TokenAnalysisInput): FactorResult {
  const count = input.smartMoneyCount;
  let score: number;

  if (count <= 0) {
    score = 0;
  } else if (count === 1) {
    score = SINGLE_WHALE_BONUS;
  } else if (count === 2) {
    score = MULTI_WHALE_BONUS;
  } else {
    // 3+ wallets detected but no convergence event to confirm the
    // 2-hour time-window requirement — award a moderate score
    score = 50;
  }

  const finalScore = clampScore(score);

  logger.debug(
    `Basic smart money scoring for ${input.symbol}: ` +
    `count=${count}, score=${finalScore}`,
  );

  return {
    name: FACTOR_NAME,
    score: finalScore,
    weight: 0,
    metadata: {
      smartMoneyCount: count,
      convergenceDetected: false,
      convergenceWalletCount: 0,
      convictionScore: 0,
      avgQualityWeight: 0,
      source: 'basic',
    },
  };
}

// ---------------------------------------------------------------------------
// Main Exported Function
// ---------------------------------------------------------------------------

/**
 * Scores the smart money convergence factor for a given token.
 *
 * This is the primary entry point for the smart money convergence factor module.
 * It evaluates how much qualified smart money wallet activity is converging on
 * the target token and returns a score from 0 to 100.
 *
 * Dual-path scoring:
 *   1. **Convergence event path**: When a `ConvergenceEvent` is provided (from
 *      `src/tracking/convergence-detector.ts`), detailed scoring with wallet
 *      count bonuses, quality weight bonuses, and conviction multipliers is applied.
 *   2. **Basic data path**: When no convergence event is available, falls back
 *      to the `input.smartMoneyCount` field for simplified tiered scoring.
 *
 * @param input - Comprehensive token analysis data from multiple data sources
 * @param convergenceEvent - Optional convergence event from the convergence
 *   detector. Pass `null` or `undefined` to use the basic scoring path.
 * @returns Promise resolving to a `FactorResult` with:
 *   - `name`: `'smartMoneyConvergence'`
 *   - `score`: Integer [0, 100]
 *   - `weight`: `0` (weight is applied by the scoring engine, not the factor)
 *   - `metadata`: Detailed scoring context for UI display and debugging
 *
 * @example
 * ```typescript
 * // With convergence event
 * const result = await scoreSmartMoneyConvergence(tokenInput, convergenceEvent);
 * console.log(result.score); // 78 (convergence with conviction)
 *
 * // Without convergence event (basic fallback)
 * const basic = await scoreSmartMoneyConvergence(tokenInput);
 * console.log(basic.score); // 25 (2 smart money wallets detected)
 * ```
 */
export async function scoreSmartMoneyConvergence(
  input: TokenAnalysisInput,
  convergenceEvent?: ConvergenceEvent | null,
): Promise<FactorResult> {
  try {
    // Route to the appropriate scoring path based on data availability
    if (convergenceEvent) {
      return scoreFromConvergenceEvent(input, convergenceEvent);
    }

    return scoreFromBasicData(input);
  } catch (error: unknown) {
    // Graceful degradation: return a safe zero-score result on any error
    // to prevent a single factor failure from crashing the entire scoring pipeline
    logger.error('Smart money convergence scoring failed:', error);

    // Safely attempt to extract smartMoneyCount — the input itself may be
    // the source of the error (e.g. a Proxy that throws on property access)
    let safeSmartMoneyCount = 0;
    try {
      safeSmartMoneyCount = input?.smartMoneyCount ?? 0;
    } catch {
      // Input object is inaccessible; use default 0
    }

    return {
      name: FACTOR_NAME,
      score: 0,
      weight: 0,
      metadata: {
        error: String(error),
        smartMoneyCount: safeSmartMoneyCount,
        convergenceDetected: false,
        convergenceWalletCount: 0,
        convictionScore: 0,
        avgQualityWeight: 0,
        source: 'error-fallback',
      },
    };
  }
}
