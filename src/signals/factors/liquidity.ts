/**
 * src/signals/factors/liquidity.ts — Liquidity Validation Factor Module
 *
 * Evaluates how liquid a token is — whether there's enough depth in the
 * trading pool for safe entry and exit at reasonable price impact.
 *
 * Scoring dimensions:
 *   1. Tiered liquidity depth (0–90 base score)
 *      - $3K–$5K  → 10–20 (minimal)
 *      - $5K–$15K → 20–40 (growing)
 *      - $15K–$50K → 40–60 (moderate)
 *      - $50K–$200K → 60–80 (healthy)
 *      - $200K+   → 80–90 (deep, logarithmically capped)
 *   2. Volume-to-liquidity ratio adjustment (±5)
 *      - 0.5–5.0  → +5 (healthy ratio)
 *      - <0.1     → -5 (dead token)
 *      - >10      → -5 (potential wash trading)
 *   3. LP burn/lock status adjustment (+10/+5/-10)
 *      - LP burned → +10 (committed, reduced rug risk)
 *      - LP locked → +5  (some protection)
 *      - Neither   → -10 (higher risk)
 *
 * Per AAP Section 0.5.1 Group 5:
 *   "Validates minimum liquidity ($3K for early pump.fun, $30K for established);
 *    confirms volume is 10× intended position size for safe exits;
 *    checks LP burn/lock status"
 *
 * Per AAP Section 0.7.3:
 *   Hard $3K minimum is handled by hard-filters.ts separately, but this
 *   factor scores the quality and depth of liquidity. All threshold values
 *   come from config constants (src/utils/config.ts) rather than being
 *   hardcoded to maintain consistency with hard-filters.ts.
 *
 * Critical rules:
 *   - Score range: 0–100, always integer, always clamped
 *   - Weight = 0 — weight is NEVER applied inside factor modules
 *   - Pure async function — no side effects beyond logging
 *   - No cross-dependencies with other factor modules
 *
 * @module signals/factors/liquidity
 */

import type { TokenAnalysisInput, FactorResult } from '../types';
import { createLogger } from '../../utils/logger';
import { LIQUIDITY } from '../../utils/config';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

const logger = createLogger('liquidity');

// ---------------------------------------------------------------------------
// Scoring Constants
// ---------------------------------------------------------------------------

/**
 * Liquidity depth scoring tiers.
 * The base score for tiered depth ranges from 0 to 90,
 * with adjustments applied on top for volume ratio and LP status.
 */

/** $5K = basic liquidity tier boundary */
const TIER_LOW = 5_000;

/** $15K = moderate liquidity tier boundary */
const TIER_MID = 15_000;

/** $50K = healthy liquidity tier boundary */
const TIER_HIGH = 50_000;

/** $200K = deep liquidity tier boundary */
const TIER_DEEP = 200_000;

// ---------------------------------------------------------------------------
// LP Status Adjustments
// ---------------------------------------------------------------------------

/** Bonus applied when LP tokens are burned (committed, reduced rug risk) */
const LP_BURNED_BONUS = 10;

/** Bonus applied when LP tokens are locked (some protection) */
const LP_LOCKED_BONUS = 5;

/** Penalty applied when LP is neither burned nor locked (higher risk) */
const LP_NEITHER_PENALTY = -10;

// ---------------------------------------------------------------------------
// Volume-to-Liquidity Ratio Boundaries
// ---------------------------------------------------------------------------

/** Minimum healthy volume-to-liquidity ratio */
const VOL_LIQ_RATIO_HEALTHY_MIN = 0.5;

/** Maximum healthy volume-to-liquidity ratio */
const VOL_LIQ_RATIO_HEALTHY_MAX = 5.0;

/** Below this ratio the token appears dead (very low trading activity) */
const VOL_LIQ_RATIO_DEAD = 0.1;

/** Above this ratio the volume is suspiciously high (potential wash trading) */
const VOL_LIQ_RATIO_SUSPICIOUS = 10;

/** Score adjustment for a healthy volume-to-liquidity ratio */
const VOL_RATIO_HEALTHY_ADJUSTMENT = 5;

/** Score penalty for dead or suspiciously high volume ratios */
const VOL_RATIO_PENALTY_ADJUSTMENT = -5;

// ---------------------------------------------------------------------------
// Liquidity Tier Labels
// ---------------------------------------------------------------------------

/** Possible tier label strings for UI display */
type LiquidityTier = 'below-minimum' | 'minimal' | 'growing' | 'moderate' | 'healthy' | 'deep';

/**
 * Maps a liquidity USD value to a human-readable tier label for UI display.
 *
 * @param liquidity - Total liquidity in USD across all DEX pools
 * @returns One of: 'below-minimum', 'minimal', 'growing', 'moderate', 'healthy', 'deep'
 */
function getLiquidityTier(liquidity: number): LiquidityTier {
  if (liquidity < LIQUIDITY.MIN_PUMP_FUN_USD) {
    return 'below-minimum';
  }
  if (liquidity < TIER_LOW) {
    return 'minimal';
  }
  if (liquidity < TIER_MID) {
    return 'growing';
  }
  if (liquidity < TIER_HIGH) {
    return 'moderate';
  }
  if (liquidity < TIER_DEEP) {
    return 'healthy';
  }
  return 'deep';
}

// ---------------------------------------------------------------------------
// Result Helper
// ---------------------------------------------------------------------------

/**
 * Convenience factory for building a complete FactorResult with consistent
 * metadata structure.
 *
 * @param score       - The final clamped score (0–100)
 * @param input       - The original TokenAnalysisInput for extracting metadata fields
 * @param breakdown   - Scoring breakdown components for debugging
 * @param extraMeta   - Any additional metadata keys to merge in
 * @returns A fully-populated FactorResult
 */
function createResult(
  score: number,
  input: TokenAnalysisInput,
  breakdown: {
    liquidityScore: number;
    volumeRatioAdjustment: number;
    lpAdjustment: number;
  },
  extraMeta?: Record<string, unknown>,
): FactorResult {
  const volumeToLiqRatio =
    input.liquidity > 0
      ? Math.round((input.volume24h / input.liquidity) * 100) / 100
      : 0;

  // Per AAP: "volume is 10× intended position size for safe exits"
  // Check if volume supports the position-safety ratio from config
  const meetsEstablishedLiquidity = input.liquidity >= LIQUIDITY.MIN_ESTABLISHED_USD;
  const volumePositionSafe = input.liquidity > 0
    ? input.volume24h >= input.liquidity * LIQUIDITY.VOLUME_POSITION_RATIO
    : false;

  return {
    name: 'liquidity',
    score,
    weight: 0,
    metadata: {
      liquidityUsd: input.liquidity,
      volume24h: input.volume24h,
      volumeToLiqRatio,
      lpBurned: input.lpBurned,
      lpLocked: input.lpLocked,
      lpBurnPercent: input.lpBurnPercent,
      liquidityTier: getLiquidityTier(input.liquidity),
      liquidityScore: breakdown.liquidityScore,
      volumeRatioAdjustment: breakdown.volumeRatioAdjustment,
      lpAdjustment: breakdown.lpAdjustment,
      meetsEstablishedLiquidity,
      volumePositionSafe,
      ...extraMeta,
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring Sub-Steps
// ---------------------------------------------------------------------------

/**
 * Calculates the base liquidity depth score (0–90).
 *
 * Uses a tiered interpolation approach:
 *   - $3K–$5K   →  10–20 (minimal)
 *   - $5K–$15K  →  20–40 (growing)
 *   - $15K–$50K →  40–60 (moderate)
 *   - $50K–$200K → 60–80 (healthy)
 *   - $200K+    →  80–90 (deep, logarithmically capped)
 *
 * @param liquidity - Total liquidity in USD
 * @returns Integer score between 0 and 90
 */
function calculateLiquidityDepthScore(liquidity: number): number {
  const minLiq = LIQUIDITY.MIN_PUMP_FUN_USD;

  if (liquidity < minLiq) {
    // Below absolute minimum — score 0
    return 0;
  }

  if (liquidity < TIER_LOW) {
    // $3K–$5K: minimal liquidity → score 10–20
    const proportion = (liquidity - minLiq) / (TIER_LOW - minLiq);
    return 10 + Math.round(proportion * 10);
  }

  if (liquidity < TIER_MID) {
    // $5K–$15K: growing liquidity → score 20–40
    const proportion = (liquidity - TIER_LOW) / (TIER_MID - TIER_LOW);
    return 20 + Math.round(proportion * 20);
  }

  if (liquidity < TIER_HIGH) {
    // $15K–$50K: moderate liquidity → score 40–60
    const proportion = (liquidity - TIER_MID) / (TIER_HIGH - TIER_MID);
    return 40 + Math.round(proportion * 20);
  }

  if (liquidity < TIER_DEEP) {
    // $50K–$200K: healthy liquidity → score 60–80
    const proportion = (liquidity - TIER_HIGH) / (TIER_DEEP - TIER_HIGH);
    return 60 + Math.round(proportion * 20);
  }

  // $200K+: deep liquidity → score 80–90 (logarithmically capped)
  const logFactor = Math.log10(liquidity / TIER_DEEP);
  return Math.min(90, 80 + Math.round(logFactor * 10));
}

/**
 * Assesses the volume-to-liquidity ratio and returns a score adjustment.
 *
 * Healthy tokens have volume proportional to their liquidity:
 *   - 0.5–5.0  → +5  (healthy organic trading)
 *   - <0.1     → -5  (dead token, very low volume relative to liquidity)
 *   - >10      → -5  (suspiciously high volume, potential wash trading)
 *   - otherwise → 0  (neutral, borderline range)
 *
 * @param volume24h  - 24-hour trading volume in USD
 * @param liquidity  - Total liquidity in USD across all DEX pools
 * @returns Integer adjustment between -5 and +5
 */
function calculateVolumeRatioAdjustment(volume24h: number, liquidity: number): number {
  if (liquidity <= 0) {
    // No liquidity means we cannot compute a meaningful ratio
    return VOL_RATIO_PENALTY_ADJUSTMENT;
  }

  const volumeToLiqRatio = volume24h / liquidity;

  if (volumeToLiqRatio >= VOL_LIQ_RATIO_HEALTHY_MIN && volumeToLiqRatio <= VOL_LIQ_RATIO_HEALTHY_MAX) {
    return VOL_RATIO_HEALTHY_ADJUSTMENT;
  }

  if (volumeToLiqRatio < VOL_LIQ_RATIO_DEAD) {
    return VOL_RATIO_PENALTY_ADJUSTMENT;
  }

  if (volumeToLiqRatio > VOL_LIQ_RATIO_SUSPICIOUS) {
    return VOL_RATIO_PENALTY_ADJUSTMENT;
  }

  // Borderline ranges (0.1–0.5 or 5.0–10.0): no adjustment
  return 0;
}

/**
 * Evaluates LP burn/lock status and returns a score adjustment.
 *
 * - LP burned → +10 (creator committed, liquidity cannot be pulled)
 * - LP locked → +5  (time-limited rug protection)
 * - Neither   → -10 (high risk, creator can rug-pull at any time)
 *
 * @param lpBurned - Whether LP tokens have been burned
 * @param lpLocked - Whether LP tokens are locked in a time-lock contract
 * @returns Integer adjustment: +10, +5, or -10
 */
function calculateLPAdjustment(lpBurned: boolean, lpLocked: boolean): number {
  if (lpBurned) {
    return LP_BURNED_BONUS;
  }
  if (lpLocked) {
    return LP_LOCKED_BONUS;
  }
  return LP_NEITHER_PENALTY;
}

// ---------------------------------------------------------------------------
// Main Export: scoreLiquidity
// ---------------------------------------------------------------------------

/**
 * Scores a token's liquidity quality on a 0–100 scale.
 *
 * Evaluates three dimensions:
 *   1. **Liquidity depth** — tiered scoring from $3K (minimum) to $200K+ (deep)
 *   2. **Volume-to-liquidity ratio** — healthy organic activity vs. dead/wash trading
 *   3. **LP burn/lock status** — commitment level of the token creator
 *
 * Tokens below the absolute minimum liquidity ($3K for pump.fun) receive
 * a score of 0. The hard filter at $3K is enforced separately in
 * `hard-filters.ts`; this factor still scores low liquidity poorly to
 * depress the composite score.
 *
 * @param input - Comprehensive token analysis data (see {@link TokenAnalysisInput})
 * @returns Promise resolving to a {@link FactorResult} with name `'liquidity'`,
 *          score 0–100, weight 0, and detailed metadata
 *
 * @example
 * ```typescript
 * const result = await scoreLiquidity({
 *   mint: 'So111...', liquidity: 50000, volume24h: 100000,
 *   lpBurned: true, lpLocked: false, lpBurnPercent: 100,
 *   // ...other TokenAnalysisInput fields
 * });
 * // result.score → ~75 (healthy liquidity + healthy ratio + LP burned bonus)
 * ```
 */
export async function scoreLiquidity(input: TokenAnalysisInput): Promise<FactorResult> {
  try {
    // -----------------------------------------------------------------
    // Step 1: Check below-minimum liquidity
    // -----------------------------------------------------------------
    if (input.liquidity < LIQUIDITY.MIN_PUMP_FUN_USD) {
      logger.debug(
        `Token ${input.mint}: liquidity $${input.liquidity} below minimum $${LIQUIDITY.MIN_PUMP_FUN_USD}`,
      );
      return createResult(
        0,
        input,
        { liquidityScore: 0, volumeRatioAdjustment: 0, lpAdjustment: 0 },
        { reason: 'Below minimum liquidity threshold' },
      );
    }

    // -----------------------------------------------------------------
    // Step 2: Calculate liquidity depth score (0–90 base)
    // -----------------------------------------------------------------
    const liquidityScore = calculateLiquidityDepthScore(input.liquidity);

    logger.debug(
      `Token ${input.mint}: liquidity $${input.liquidity} → depth score ${liquidityScore} (tier: ${getLiquidityTier(input.liquidity)})`,
    );

    // -----------------------------------------------------------------
    // Step 3: Volume-to-liquidity ratio assessment
    // -----------------------------------------------------------------
    const volumeRatioAdjustment = calculateVolumeRatioAdjustment(
      input.volume24h,
      input.liquidity,
    );

    if (volumeRatioAdjustment !== 0) {
      const ratio = input.liquidity > 0
        ? (input.volume24h / input.liquidity).toFixed(2)
        : 'N/A';
      logger.debug(
        `Token ${input.mint}: vol/liq ratio ${ratio} → adjustment ${volumeRatioAdjustment > 0 ? '+' : ''}${volumeRatioAdjustment}`,
      );
    }

    // -----------------------------------------------------------------
    // Step 4: LP burn/lock status adjustment
    // -----------------------------------------------------------------
    const lpAdjustment = calculateLPAdjustment(input.lpBurned, input.lpLocked);

    logger.debug(
      `Token ${input.mint}: LP burned=${input.lpBurned}, locked=${input.lpLocked} → adjustment ${lpAdjustment > 0 ? '+' : ''}${lpAdjustment}`,
    );

    // -----------------------------------------------------------------
    // Step 5: Combine and clamp to 0–100
    // -----------------------------------------------------------------
    const rawScore = liquidityScore + volumeRatioAdjustment + lpAdjustment;
    const clampedScore = Math.max(0, Math.min(100, Math.round(rawScore)));

    logger.debug(
      `Token ${input.mint}: final liquidity score ${clampedScore} (base=${liquidityScore}, volAdj=${volumeRatioAdjustment}, lpAdj=${lpAdjustment})`,
    );

    // -----------------------------------------------------------------
    // Step 6: Build and return FactorResult
    // -----------------------------------------------------------------
    return createResult(clampedScore, input, {
      liquidityScore,
      volumeRatioAdjustment,
      lpAdjustment,
    });
  } catch (error: unknown) {
    // -----------------------------------------------------------------
    // Error handling: return score 0 with error metadata
    // Property access on `input` is wrapped in try/catch to prevent
    // cascading failures if the input object itself is the error source
    // (e.g., a Proxy that throws on property access).
    // -----------------------------------------------------------------
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Safely extract input properties for metadata — any access could throw
    let safeLiquidity = 0;
    let safeVolume24h = 0;
    let safeLpBurned = false;
    let safeLpLocked = false;
    let safeLpBurnPercent = 0;
    let safeMint = 'unknown';

    try {
      safeMint = input.mint ?? 'unknown';
      safeLiquidity = input.liquidity ?? 0;
      safeVolume24h = input.volume24h ?? 0;
      safeLpBurned = input.lpBurned ?? false;
      safeLpLocked = input.lpLocked ?? false;
      safeLpBurnPercent = input.lpBurnPercent ?? 0;
    } catch {
      // Input is not safely accessible — use defaults above
    }

    logger.error(
      `Token ${safeMint}: liquidity scoring failed — ${errorMessage}`,
      error,
    );

    return {
      name: 'liquidity',
      score: 0,
      weight: 0,
      metadata: {
        liquidityUsd: safeLiquidity,
        volume24h: safeVolume24h,
        volumeToLiqRatio: 0,
        lpBurned: safeLpBurned,
        lpLocked: safeLpLocked,
        lpBurnPercent: safeLpBurnPercent,
        liquidityTier: 'below-minimum' as LiquidityTier,
        liquidityScore: 0,
        volumeRatioAdjustment: 0,
        lpAdjustment: 0,
        error: errorMessage,
      },
    };
  }
}
