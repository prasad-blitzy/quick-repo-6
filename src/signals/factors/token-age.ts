/**
 * src/signals/factors/token-age.ts — Token Age Filter Factor Module
 *
 * Evaluates how recently a token was created using a three-tier scoring system:
 * - ≤3 hours: Early accumulation mode (highest score, 75–100)
 * - ≤12 hours: Gem scanning mode (moderate score, 40–75)
 * - >12 hours: Diminished score (10–40 for 12–24h, 0–10 for 24–72h, 0 for >72h)
 *
 * Memecoins have the highest signal-to-noise ratio in the first few hours of
 * trading. Early detection is the primary alpha — newer tokens get higher scores.
 *
 * Per AAP Section 0.5.1 Group 5:
 * "Filters by token creation timestamp; ≤3 hours = early accumulation mode
 *  (highest score); ≤12 hours = gem scanning mode; >12 hours = diminished score"
 *
 * Per AAP Section 0.1.1:
 * Only 0.4%–1.8% of pump.fun tokens graduate to DEXes; the signal engine must
 * account for extreme failure rates and filter for tokens at ≥30% bonding curve
 * progress.
 *
 * Consumers:
 * - src/signals/scoring-engine.ts — calls scoreTokenAge() in parallel with
 *   6 other factor modules via Promise.allSettled
 * - tests/unit/signals/factors/token-age.test.ts
 *
 * @module signals/factors/token-age
 */

import type { TokenAnalysisInput, FactorResult } from '../types';
import { TOKEN_AGE } from '../../utils/config';
import { createLogger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger instance with 'token-age' context tag for source
 * identification in log output. Used for debug-level tier classification
 * results, warn-level invalid timestamp alerts, and error-level catch blocks.
 */
const logger = createLogger('token-age');

// ---------------------------------------------------------------------------
// Time Threshold Constants
// ---------------------------------------------------------------------------

/**
 * Early accumulation boundary: 3 hours in milliseconds.
 * Sourced from centralized config to maintain consistency with other modules.
 * Tokens younger than this receive the highest possible scores (75–100).
 */
const EARLY_ACCUMULATION_MS: number = TOKEN_AGE.EARLY_ACCUMULATION_MAX_MS;

/**
 * Gem scanning boundary: 12 hours in milliseconds.
 * Sourced from centralized config. Tokens between 3h and 12h old receive
 * moderate scores (40–75), indicating they are still viable but past
 * the initial pump opportunity window.
 */
const GEM_SCANNING_MS: number = TOKEN_AGE.GEM_SCANNING_MAX_MS;

/**
 * Maximum age for any meaningful signal: 24 hours in milliseconds.
 * Tokens between 12h and 24h old receive diminished scores (10–40).
 * Beyond this threshold, memecoin trading alpha drops significantly.
 */
const MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

/**
 * Stale token boundary: 72 hours in milliseconds.
 * Tokens between 24h and 72h old receive very diminished scores (0–10).
 * Tokens older than 72h are classified as expired with a score of 0.
 */
const STALE_AGE_MS: number = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Score Range Constants
// ---------------------------------------------------------------------------

/**
 * Maximum score for the early accumulation tier (brand-new tokens).
 * A token created moments ago receives this score.
 */
const EARLY_ACCUMULATION_MAX_SCORE: number = 100;

/**
 * Minimum score for the early accumulation tier (at the 3h boundary).
 * Score decays linearly from MAX to MIN within this tier.
 */
const EARLY_ACCUMULATION_MIN_SCORE: number = 75;

/**
 * Maximum score for the gem scanning tier (just past the 3h boundary).
 * Equals EARLY_ACCUMULATION_MIN_SCORE for continuous scoring curve.
 */
const GEM_SCANNING_MAX_SCORE: number = 75;

/**
 * Minimum score for the gem scanning tier (at the 12h boundary).
 */
const GEM_SCANNING_MIN_SCORE: number = 40;

/**
 * Maximum score for the aged token tier (just past the 12h boundary).
 * Equals GEM_SCANNING_MIN_SCORE for continuous scoring curve.
 */
const AGED_TOKEN_MAX_SCORE: number = 40;

/**
 * Minimum score for the aged token tier (at the 24h boundary).
 */
const AGED_TOKEN_MIN_SCORE: number = 10;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Creates a FactorResult with a given score and standard metadata fields.
 * Centralizes result construction to guarantee consistent field naming,
 * score clamping, and the required metadata shape for UI display and debugging.
 *
 * @param score - Raw computed score (will be clamped to 0–100 integer)
 * @param ageMs - Token age in milliseconds
 * @param ageHours - Token age in hours (will be rounded to 1 decimal place)
 * @param ageTier - Assigned age tier name (e.g., 'early-accumulation', 'gem-scanning')
 * @param isEarlyAccumulation - Whether the token falls in the early accumulation tier
 * @param isGemScanning - Whether the token falls in the gem scanning tier
 * @param extraMeta - Optional additional metadata fields (merged into metadata object)
 * @returns Complete FactorResult with name='tokenAge', weight=0, and populated metadata
 */
function createResult(
  score: number,
  ageMs: number,
  ageHours: number,
  ageTier: string,
  isEarlyAccumulation: boolean,
  isGemScanning: boolean,
  extraMeta?: Record<string, unknown>,
): FactorResult {
  return {
    name: 'tokenAge',
    score: Math.max(0, Math.min(100, Math.round(score))),
    weight: 0,
    metadata: {
      ageMs,
      ageHours: Math.round(ageHours * 10) / 10,
      ageTier,
      isEarlyAccumulation,
      isGemScanning,
      ...extraMeta,
    },
  };
}

/**
 * Creates a FactorResult for error or invalid-input conditions.
 * Returns score 0 with descriptive error metadata so the scoring engine
 * and UI can understand why no valid score was produced.
 *
 * @param reason - Human-readable reason for the zero score
 * @param extraMeta - Optional additional error context metadata
 * @returns FactorResult with score 0, ageTier='invalid', and error details
 */
function createErrorResult(
  reason: string,
  extraMeta?: Record<string, unknown>,
): FactorResult {
  return {
    name: 'tokenAge',
    score: 0,
    weight: 0,
    metadata: {
      ageMs: 0,
      ageHours: 0,
      ageTier: 'invalid',
      isEarlyAccumulation: false,
      isGemScanning: false,
      reason,
      ...extraMeta,
    },
  };
}

// ---------------------------------------------------------------------------
// Main Scoring Function
// ---------------------------------------------------------------------------

/**
 * Scores a token based on its age using a three-tier linear decay system.
 *
 * **Scoring tiers (per AAP):**
 *
 * | Tier                | Age Range   | Score Range | Description                    |
 * |---------------------|-------------|-------------|--------------------------------|
 * | Early Accumulation  | 0–3 hours   | 100–75      | Highest score, primary alpha   |
 * | Gem Scanning        | 3–12 hours  | 75–40       | Moderate, still viable         |
 * | Aged                | 12–24 hours | 40–10       | Diminished upside potential    |
 * | Stale               | 24–72 hours | 10–0        | Very low signal value          |
 * | Expired             | >72 hours   | 0           | No signal value                |
 *
 * Within each tier, the score decays linearly from the tier's maximum to its
 * minimum as the token ages. This produces a smooth, continuous curve where
 * newer tokens always score higher than older ones.
 *
 * **Edge cases handled:**
 * - `createdAt <= 0`: Returns score 0 (invalid timestamp)
 * - `createdAt` in the future (ageMs < 0): Returns score 0 (clock skew)
 * - Unexpected errors: Caught and returned as score 0 with error metadata
 *
 * @param input - Token analysis data containing:
 *   - `createdAt`: Unix timestamp in **seconds** (NOT milliseconds)
 *   - `mint`: Token mint address for log identification
 * @returns Promise resolving to a FactorResult with:
 *   - `name`: Always `'tokenAge'`
 *   - `score`: Integer 0–100
 *   - `weight`: Always 0 (applied later by scoring-engine.ts)
 *   - `metadata`: Object with `ageMs`, `ageHours`, `ageTier`,
 *     `isEarlyAccumulation`, `isGemScanning`
 *
 * @example
 * ```typescript
 * // Token created 1 hour ago
 * const result = await scoreTokenAge({
 *   ...tokenData,
 *   createdAt: Math.floor(Date.now() / 1000) - 3600,
 * });
 * // result.score ≈ 92 (early accumulation)
 * // result.metadata.ageTier === 'early-accumulation'
 * // result.metadata.isEarlyAccumulation === true
 * ```
 */
export async function scoreTokenAge(input: TokenAnalysisInput): Promise<FactorResult> {
  try {
    // -----------------------------------------------------------------------
    // Step 1: Validate creation timestamp
    // -----------------------------------------------------------------------
    if (!input.createdAt || input.createdAt <= 0) {
      logger.warn(
        `Token ${input.mint}: invalid creation timestamp ${input.createdAt}`,
      );
      return createErrorResult('Invalid creation timestamp', {
        createdAt: input.createdAt,
      });
    }

    // -----------------------------------------------------------------------
    // Step 2: Calculate token age in milliseconds and hours
    // -----------------------------------------------------------------------
    const now: number = Date.now();
    const createdAtMs: number = input.createdAt * 1000; // Unix seconds → ms
    const ageMs: number = now - createdAtMs;
    const ageHours: number = ageMs / (60 * 60 * 1000);

    // -----------------------------------------------------------------------
    // Step 3: Handle future timestamps (clock skew or corrupted data)
    // -----------------------------------------------------------------------
    if (ageMs < 0) {
      logger.warn(
        `Token ${input.mint}: creation timestamp is in the future ` +
          `(createdAt=${input.createdAt}, ageMs=${ageMs})`,
      );
      return createErrorResult('Creation timestamp is in the future', {
        createdAt: input.createdAt,
        ageMs,
      });
    }

    // -----------------------------------------------------------------------
    // Step 4: Map age to score using three-tier + extended decay system
    // -----------------------------------------------------------------------
    let score: number = 0;
    let ageTier: string = 'expired';

    if (ageMs <= EARLY_ACCUMULATION_MS) {
      // ≤3 hours: Early accumulation mode — HIGHEST SCORE per AAP
      // Linear decay from 100 (brand new) to 75 (at 3h boundary)
      const progress: number = ageMs / EARLY_ACCUMULATION_MS;
      score =
        EARLY_ACCUMULATION_MAX_SCORE -
        Math.round(
          progress *
            (EARLY_ACCUMULATION_MAX_SCORE - EARLY_ACCUMULATION_MIN_SCORE),
        );
      ageTier = 'early-accumulation';

      logger.debug(
        `Token ${input.mint}: ${ageHours.toFixed(1)}h old — early accumulation mode (score=${score})`,
      );
    } else if (ageMs <= GEM_SCANNING_MS) {
      // 3h–12h: Gem scanning mode
      // Linear decay from 75 (just past 3h) to 40 (at 12h boundary)
      const progress: number =
        (ageMs - EARLY_ACCUMULATION_MS) /
        (GEM_SCANNING_MS - EARLY_ACCUMULATION_MS);
      score =
        GEM_SCANNING_MAX_SCORE -
        Math.round(
          progress * (GEM_SCANNING_MAX_SCORE - GEM_SCANNING_MIN_SCORE),
        );
      ageTier = 'gem-scanning';

      logger.debug(
        `Token ${input.mint}: ${ageHours.toFixed(1)}h old — gem scanning mode (score=${score})`,
      );
    } else if (ageMs <= MAX_AGE_MS) {
      // 12h–24h: Diminished score per AAP
      // Linear decay from 40 (just past 12h) to 10 (at 24h boundary)
      const progress: number =
        (ageMs - GEM_SCANNING_MS) / (MAX_AGE_MS - GEM_SCANNING_MS);
      score =
        AGED_TOKEN_MAX_SCORE -
        Math.round(progress * (AGED_TOKEN_MAX_SCORE - AGED_TOKEN_MIN_SCORE));
      ageTier = 'aged';

      logger.debug(
        `Token ${input.mint}: ${ageHours.toFixed(1)}h old — aged token (score=${score})`,
      );
    } else if (ageMs <= STALE_AGE_MS) {
      // 24h–72h: Very diminished — score decays from 10 to 0
      const progress: number =
        (ageMs - MAX_AGE_MS) / (STALE_AGE_MS - MAX_AGE_MS);
      score =
        AGED_TOKEN_MIN_SCORE -
        Math.round(progress * AGED_TOKEN_MIN_SCORE);
      ageTier = 'stale';

      logger.debug(
        `Token ${input.mint}: ${ageHours.toFixed(1)}h old — stale token (score=${score})`,
      );
    } else {
      // >72h: Essentially expired for memecoin signal generation
      score = 0;
      ageTier = 'expired';

      logger.debug(
        `Token ${input.mint}: ${ageHours.toFixed(1)}h old — expired (score=0)`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Clamp score and build result
    // -----------------------------------------------------------------------
    const clampedScore: number = Math.max(0, Math.min(100, Math.round(score)));

    return createResult(
      clampedScore,
      ageMs,
      ageHours,
      ageTier,
      ageMs <= EARLY_ACCUMULATION_MS,
      ageMs > EARLY_ACCUMULATION_MS && ageMs <= GEM_SCANNING_MS,
    );
  } catch (error: unknown) {
    // Defensive error handling — factor modules must never throw
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger.error(
      `Token ${input?.mint ?? 'unknown'}: unexpected error in token age scoring — ${errorMessage}`,
    );

    return createErrorResult('Unexpected error during scoring', {
      error: errorMessage,
    });
  }
}
