/**
 * src/signals/factors/safety-score.ts — Safety Score Integration Factor Module
 *
 * Evaluates the overall safety of a token by consuming pre-populated safety data
 * from the TokenAnalysisInput. This factor module does NOT directly call external
 * APIs — all safety data (RugCheck, GoPlus, Jupiter honeypot simulation) is
 * already present in the input, populated upstream by the safety checker pipeline
 * (src/safety/checker.ts).
 *
 * Scoring logic (per AAP Section 0.5.1 Group 5):
 *   - Maps RugCheck score (0–1000) to a 0–100 base score with ≥300 as the "safe"
 *     baseline at score 50.
 *   - Applies penalties for: honeypot detection (−50), active mint authority (−25),
 *     active freeze authority (−20), high holder concentration >20% (−15),
 *     mutable metadata (−10), no LP lock/burn (−15).
 *   - Applies bonuses for: all authorities revoked (+15), LP burned (+10),
 *     low holder concentration ≤10% (+5).
 *   - Clamps the final score to [0, 100] as an integer.
 *
 * Integration points (per AAP Section 0.4.3):
 *   - Consumed by src/signals/scoring-engine.ts as one of the 7 factor modules.
 *   - Safety data sourced from src/safety/checker.ts (RugCheck + GoPlus),
 *     src/safety/honeypot-detector.ts (Jupiter sell simulation).
 *
 * Critical rules:
 *   - Score range is always 0–100 (integer, clamped).
 *   - Weight is always 0 — the scoring engine applies configurable weights.
 *   - FactorResult.name is exactly 'safetyScore'.
 *   - No cross-dependencies with other factor modules.
 *   - Pure async function with try/catch error handling.
 *
 * @module signals/factors/safety-score
 */

import type { TokenAnalysisInput, FactorResult } from '../types';
import type { SafetyReport } from '../../safety/types';
import { createLogger } from '../../utils/logger';
import { HARD_FILTER_THRESHOLDS } from '../../utils/config';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger with 'safety-score' context tag for all operational
 * logging within this module — honeypot detection, score computation, and
 * error reporting.
 */
const logger = createLogger('safety-score');

// ---------------------------------------------------------------------------
// Scoring Constants — Penalties
// ---------------------------------------------------------------------------

/**
 * Penalty applied when Jupiter sell simulation identifies the token as a
 * honeypot (cannot be sold). This is the most severe penalty because a
 * honeypot renders the token completely untradeable.
 */
const PENALTY_HONEYPOT = 50;

/**
 * Penalty applied when the token's mint authority is still active.
 * An active mint authority allows the creator to inflate supply at will,
 * diluting existing holders.
 */
const PENALTY_MINT_AUTHORITY_ACTIVE = 25;

/**
 * Penalty applied when the token's freeze authority is still active.
 * An active freeze authority allows the creator to freeze any token account,
 * preventing holders from selling.
 */
const PENALTY_FREEZE_AUTHORITY_ACTIVE = 20;

/**
 * Penalty applied when the top holder concentration exceeds the
 * MAX_TOP_HOLDER_CONCENTRATION threshold (20% per AAP).
 * High concentration signals that a few wallets can dump and crash the price.
 */
const PENALTY_HIGH_CONCENTRATION = 15;

/**
 * Penalty applied when the token's metadata is mutable.
 * Mutable metadata allows the creator to change token name, symbol, or logo
 * post-launch, potentially impersonating other tokens.
 */
const PENALTY_MUTABLE_METADATA = 10;

/**
 * Penalty applied when LP (liquidity pool) tokens are neither burned nor
 * locked. Without LP protection, the creator can pull all liquidity (rug pull)
 * at any time.
 */
const PENALTY_NO_LP_LOCK = 15;

// ---------------------------------------------------------------------------
// Scoring Constants — Bonuses
// ---------------------------------------------------------------------------

/**
 * Bonus applied when BOTH mint and freeze authorities have been revoked.
 * This is a strong safety signal indicating the creator has permanently
 * relinquished control over token supply and account freezing.
 */
const BONUS_ALL_AUTHORITIES_REVOKED = 15;

/**
 * Bonus applied when LP tokens have been burned (sent to the burn address).
 * Burned LP permanently removes the possibility of a liquidity rug pull.
 */
const BONUS_LP_BURNED = 10;

/**
 * Bonus applied when top holder concentration is ≤10%.
 * Low concentration indicates a well-distributed token with reduced
 * single-entity dump risk.
 */
const BONUS_LOW_CONCENTRATION = 5;

// ---------------------------------------------------------------------------
// Low Concentration Threshold
// ---------------------------------------------------------------------------

/**
 * Threshold below which the token is considered "well distributed" for
 * the low concentration bonus. Top holder percent ≤10% earns the bonus.
 */
const LOW_CONCENTRATION_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Main Scoring Function
// ---------------------------------------------------------------------------

/**
 * Scores a token's safety based on pre-populated data from the safety checker
 * pipeline. Produces a FactorResult with a 0–100 integer score, weight of 0,
 * and metadata containing the RugCheck score, authority statuses, and a
 * human-readable risk factors array.
 *
 * @param input - TokenAnalysisInput with pre-populated safety fields
 *   (safetyScore, mintAuthorityActive, freezeAuthorityActive, topHolderPercent,
 *   metadataMutable, isHoneypot, lpBurned, lpLocked, mint).
 * @param safetyReport - Optional full SafetyReport from the safety checker
 *   pipeline. Provides access to detailed report data for enhanced metadata.
 *   When provided, its overallScore, rugCheckScore, and riskFactors are
 *   included in the returned metadata for richer UI display.
 * @returns Promise resolving to a FactorResult with name 'safetyScore',
 *   score 0–100, weight 0, and metadata. Returns score 0 with error metadata
 *   on failure.
 *
 * @example
 * ```typescript
 * const result = await scoreSafetyScore({
 *   mint: 'TokenMint123',
 *   safetyScore: 500,        // RugCheck 0-1000
 *   mintAuthorityActive: false,
 *   freezeAuthorityActive: false,
 *   topHolderPercent: 12,
 *   metadataMutable: false,
 *   isHoneypot: false,
 *   lpBurned: true,
 *   lpLocked: false,
 *   // ... other TokenAnalysisInput fields
 * });
 * // result.score ≈ 80+ (safe token with good indicators)
 * ```
 */
export async function scoreSafetyScore(
  input: TokenAnalysisInput,
  safetyReport?: SafetyReport | null,
): Promise<FactorResult> {
  try {
    // ------------------------------------------------------------------
    // Step 1: Derive base score from RugCheck safety score (0–1000)
    // ------------------------------------------------------------------
    // Mapping strategy:
    //   - 0 → 0 (no RugCheck data or worst score)
    //   - HARD_FILTER_THRESHOLDS.MIN_SAFETY_SCORE (300) → 50 (baseline "safe")
    //   - 1000 → 100 (perfect score)
    // This provides a linear scale where the AAP-defined "safe" threshold
    // maps to the midpoint of our 0–100 range.

    const rugCheckSafeThreshold = HARD_FILTER_THRESHOLDS.MIN_SAFETY_SCORE;
    const maxHolderConcentration = HARD_FILTER_THRESHOLDS.MAX_TOP_HOLDER_CONCENTRATION;

    let score = 0;

    if (input.safetyScore > 0) {
      if (input.safetyScore >= rugCheckSafeThreshold) {
        // Score ≥300: Map from [300, 1000] → [50, 100]
        score =
          50 +
          Math.round(
            ((input.safetyScore - rugCheckSafeThreshold) /
              (1000 - rugCheckSafeThreshold)) *
              50,
          );
      } else {
        // Score <300: Map from [0, 300) → [0, 50)
        score = Math.round(
          (input.safetyScore / rugCheckSafeThreshold) * 50,
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 2: Apply penalties for detected risk factors
    // ------------------------------------------------------------------

    // Honeypot is the most severe penalty — token cannot be sold
    if (input.isHoneypot) {
      score -= PENALTY_HONEYPOT;
      logger.info(
        `Token ${input.mint}: honeypot detected, -${PENALTY_HONEYPOT}`,
      );
    }

    // Active mint authority — creator can inflate supply at will
    if (input.mintAuthorityActive) {
      score -= PENALTY_MINT_AUTHORITY_ACTIVE;
    }

    // Active freeze authority — creator can freeze token accounts
    if (input.freezeAuthorityActive) {
      score -= PENALTY_FREEZE_AUTHORITY_ACTIVE;
    }

    // High holder concentration — top holders exceed threshold (>20% per AAP)
    if (input.topHolderPercent > maxHolderConcentration) {
      score -= PENALTY_HIGH_CONCENTRATION;
    }

    // Mutable metadata — creator can change token identity post-launch
    if (input.metadataMutable) {
      score -= PENALTY_MUTABLE_METADATA;
    }

    // No LP lock or burn — creator can pull all liquidity (rug pull)
    if (!input.lpBurned && !input.lpLocked) {
      score -= PENALTY_NO_LP_LOCK;
    }

    // ------------------------------------------------------------------
    // Step 3: Apply bonuses for positive safety indicators
    // ------------------------------------------------------------------

    // Both authorities revoked — strong safety commitment
    if (!input.mintAuthorityActive && !input.freezeAuthorityActive) {
      score += BONUS_ALL_AUTHORITIES_REVOKED;
    }

    // LP burned — permanent liquidity commitment
    if (input.lpBurned) {
      score += BONUS_LP_BURNED;
    }

    // Low holder concentration (≤10%) — well-distributed token
    if (input.topHolderPercent <= LOW_CONCENTRATION_THRESHOLD) {
      score += BONUS_LOW_CONCENTRATION;
    }

    // ------------------------------------------------------------------
    // Step 4: Clamp the final score to [0, 100] integer range
    // ------------------------------------------------------------------

    const clampedScore = Math.max(0, Math.min(100, Math.round(score)));

    // ------------------------------------------------------------------
    // Step 5: Build human-readable risk factors array for metadata
    // ------------------------------------------------------------------

    const riskFactors: string[] = [];

    if (input.isHoneypot) {
      riskFactors.push('Potential honeypot - sell simulation failed');
    }
    if (input.mintAuthorityActive) {
      riskFactors.push('Mint authority active');
    }
    if (input.freezeAuthorityActive) {
      riskFactors.push('Freeze authority active');
    }
    if (input.topHolderPercent > maxHolderConcentration) {
      riskFactors.push(
        `Top holder concentration ${input.topHolderPercent.toFixed(1)}% > ${maxHolderConcentration}%`,
      );
    }
    if (input.metadataMutable) {
      riskFactors.push('Metadata is mutable');
    }
    if (!input.lpBurned && !input.lpLocked) {
      riskFactors.push('LP not burned or locked');
    }

    // ------------------------------------------------------------------
    // Step 6: Build and return the FactorResult
    // ------------------------------------------------------------------

    const result: FactorResult = {
      name: 'safetyScore',
      score: clampedScore,
      weight: 0, // Weight is applied by scoring-engine.ts, NOT by factor modules
      metadata: {
        rugCheckScore: input.safetyScore,
        rugCheckSafe: input.safetyScore >= rugCheckSafeThreshold,
        mintAuthorityActive: input.mintAuthorityActive,
        freezeAuthorityActive: input.freezeAuthorityActive,
        topHolderPercent: input.topHolderPercent,
        metadataMutable: input.metadataMutable,
        isHoneypot: input.isHoneypot,
        lpBurned: input.lpBurned,
        lpLocked: input.lpLocked,
        riskFactors,
        // Include SafetyReport details when available for enhanced metadata
        ...(safetyReport != null
          ? {
              reportOverallScore: safetyReport.overallScore,
              reportRugCheckScore: safetyReport.rugCheckScore,
              reportRiskFactors: safetyReport.riskFactors,
            }
          : {}),
      },
    };

    return result;
  } catch (error: unknown) {
    // ------------------------------------------------------------------
    // Error Handling: Return a safe default with score 0
    // ------------------------------------------------------------------
    logger.error('Safety score scoring failed:', error);

    return {
      name: 'safetyScore',
      score: 0,
      weight: 0,
      metadata: { error: String(error) },
    };
  }
}
