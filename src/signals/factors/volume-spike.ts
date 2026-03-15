/**
 * src/signals/factors/volume-spike.ts — Volume Spike Detection Factor Module
 *
 * Detects abnormal trading volume spikes by comparing current 5-minute volume
 * against the 5-minute moving average (or an estimated MA derived from 1-hour
 * volume). A sudden volume increase is one of the earliest and strongest
 * indicators of emerging interest in a Solana memecoin.
 *
 * Scoring algorithm:
 *   1. Validate minimum volume thresholds ($200/5m, $2,000/1h).
 *   2. Calculate spike multiplier = current 5m vol / 5m MA (or estimated MA).
 *   3. Map multiplier → 0–100 score across tiered ranges:
 *      - ≤1×   → 0  (no spike)
 *      - 1–1.5×→ 0–15  (mild increase)
 *      - 1.5–3×→ 15–50 (moderate spike)
 *      - 3–8×  → 50–85 (high spike — AAP sweet spot)
 *      - 8–15× → 85–100 (extreme spike, diminishing returns)
 *   4. Apply +15 bonus when 24h volume ÷ market cap ≥ 100%.
 *   5. Clamp final score to [0, 100].
 *
 * Per AAP Section 0.5.1 Group 5:
 *   "Calculates volume spike score; compares current 5-minute volume against
 *    5-minute moving average; 3–8× spike = high score; validates minimum
 *    $200/5m and $2,000/1h thresholds; volume-to-market-cap ratio above
 *    100% adds bonus."
 *
 * Per AAP Section 0.7.3:
 *   "Configurable scoring weights: All 7 factor weights must be user-
 *    configurable via the settings panel; the scoring engine reads weights
 *    from the Zustand settings-store at analysis time, not from hardcoded
 *    constants." — therefore this module always returns weight = 0.
 *
 * @module signals/factors/volume-spike
 */

import type { TokenAnalysisInput, FactorResult } from '../types';
import { createLogger } from '../../utils/logger';
import { LIQUIDITY } from '../../utils/config';

// ---------------------------------------------------------------------------
// Module-level Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger with the 'volume-spike' context tag.
 * Used for debug logging of threshold checks, spike results, and errors.
 */
const logger = createLogger('volume-spike');

// ---------------------------------------------------------------------------
// Scoring Constants
// ---------------------------------------------------------------------------

/**
 * Spike multiplier ranges derived from the AAP:
 *   "3–8× spike = high score"
 *
 * The ranges define a piecewise-linear mapping from spike multiplier to score:
 *   - Below MIN_SPIKE_MULTIPLIER (1.5×): low score zone (0–15)
 *   - MID_SPIKE_MULTIPLIER (3.0×): transition to high-score zone (score ~50)
 *   - HIGH_SPIKE_MULTIPLIER (8.0×): top of AAP sweet spot (score ~85)
 *   - MAX_SPIKE_MULTIPLIER (15.0×): ceiling with diminishing returns (score ~100)
 */
const MIN_SPIKE_MULTIPLIER = 1.5;
const MID_SPIKE_MULTIPLIER = 3.0;
const HIGH_SPIKE_MULTIPLIER = 8.0;
const MAX_SPIKE_MULTIPLIER = 15.0;

/**
 * Volume-to-market-cap ratio bonus per AAP:
 *   "volume-to-market-cap ratio above 100% adds bonus"
 *
 * When (volume24h / marketCap) × 100 ≥ 100%, the token receives an extra
 * 15 points. This captures tokens experiencing extraordinary turnover
 * relative to their market capitalisation.
 */
const VOLUME_MC_BONUS_THRESHOLD = 100;
const VOLUME_MC_BONUS_POINTS = 15;

/**
 * Number of 5-minute intervals in one hour, used to estimate the 5-minute
 * moving average from the 1-hour aggregate volume when Birdeye OHLCV
 * enrichment data is unavailable.
 */
const INTERVALS_PER_HOUR = 12;

// ---------------------------------------------------------------------------
// Helper: Build FactorResult
// ---------------------------------------------------------------------------

/**
 * Constructs a consistently-shaped {@link FactorResult} for the volume spike
 * factor. Centralises the result-building logic so that early-return paths
 * (threshold failures, error catches) produce the same metadata envelope as
 * the main scoring path.
 *
 * @param score  - Final score (0–100 integer, pre-clamped by caller)
 * @param input  - The original token analysis input (for metadata extraction)
 * @param spikeMultiplier - Calculated spike multiplier (0 if not computed)
 * @param extraMeta       - Any additional metadata keys (e.g. `reason`, `error`)
 * @returns A complete FactorResult with name 'volumeSpike' and weight 0
 */
function createResult(
  score: number,
  input: TokenAnalysisInput,
  spikeMultiplier: number,
  extraMeta?: Record<string, unknown>,
): FactorResult {
  const volumeToMcRatio: number | null =
    input.marketCap > 0
      ? Math.round((input.volume24h / input.marketCap) * 10000) / 100
      : null;

  return {
    name: 'volumeSpike',
    score,
    weight: 0, // Weight is applied externally by scoring-engine.ts
    metadata: {
      volume5m: input.volume5m,
      volume1h: input.volume1h,
      volume24h: input.volume24h,
      volume5mMA: input.volume5mMA ?? null,
      spikeMultiplier: Math.round(spikeMultiplier * 100) / 100,
      volumeToMcRatio,
      marketCap: input.marketCap,
      ...extraMeta,
    },
  };
}

// ---------------------------------------------------------------------------
// Main Scoring Function
// ---------------------------------------------------------------------------

/**
 * Evaluates a token's volume spike intensity and returns a factor score from
 * 0 to 100.
 *
 * The function is designed as a pure async computation with no side effects
 * beyond structured logging. It does not mutate input data, interact with
 * external services, or modify any global state.
 *
 * **Minimum volume thresholds** (immediate score-0 if not met):
 *   - 5-minute volume ≥ $200  (from {@link LIQUIDITY.MIN_5M_VOLUME_USD})
 *   - 1-hour volume  ≥ $2,000 (from {@link LIQUIDITY.MIN_1H_VOLUME_USD})
 *
 * **Spike multiplier calculation**:
 *   - Primary: `volume5m / volume5mMA` (Birdeye OHLCV enrichment)
 *   - Fallback: `volume5m / (volume1h / 12)` (estimated MA)
 *
 * **Volume-to-market-cap bonus** (+15 points):
 *   - Applied when `(volume24h / marketCap) × 100 ≥ 100%`
 *
 * @param input - Token analysis data containing volume, market cap, and
 *                optional 5-minute moving average fields
 * @returns A FactorResult with name 'volumeSpike', score 0–100, weight 0,
 *          and diagnostic metadata
 *
 * @example
 * ```typescript
 * const result = await scoreVolumeSpike({
 *   mint: 'TokenABC...', symbol: 'MEME', name: 'MemeCoin',
 *   price: 0.001, priceChange5m: 10, priceChange1h: 25, priceChange24h: 100,
 *   marketCap: 50_000, volume5m: 5000, volume1h: 12_000, volume24h: 80_000,
 *   liquidity: 10_000, supply: 1_000_000_000,
 *   buys1h: 200, sells1h: 100, buys24h: 1000, sells24h: 500,
 *   holderCount: 500, topHolderPercent: 15,
 *   smartMoneyCount: 3,
 *   mintAuthorityActive: false, freezeAuthorityActive: false,
 *   lpBurned: true, lpLocked: false, lpBurnPercent: 95,
 *   isHoneypot: false, safetyScore: 500, metadataMutable: false,
 *   devWalletAddress: 'Dev...', devWalletSold: false,
 *   createdAt: Date.now() / 1000 - 3600,
 *   volume5mMA: 1000,
 * });
 * // result.score → ~85 (5× spike = high zone)
 * ```
 */
export async function scoreVolumeSpike(
  input: TokenAnalysisInput,
): Promise<FactorResult> {
  try {
    // ------------------------------------------------------------------
    // Step 1: Validate minimum volume thresholds
    // ------------------------------------------------------------------

    if (input.volume5m < LIQUIDITY.MIN_5M_VOLUME_USD) {
      logger.debug(
        `Token ${input.mint}: 5m volume $${input.volume5m} below minimum $${LIQUIDITY.MIN_5M_VOLUME_USD}`,
      );
      return createResult(0, input, 0, {
        reason: '5m volume below minimum threshold',
      });
    }

    if (input.volume1h < LIQUIDITY.MIN_1H_VOLUME_USD) {
      logger.debug(
        `Token ${input.mint}: 1h volume $${input.volume1h} below minimum $${LIQUIDITY.MIN_1H_VOLUME_USD}`,
      );
      return createResult(0, input, 0, {
        reason: '1h volume below minimum threshold',
      });
    }

    // ------------------------------------------------------------------
    // Step 2: Calculate spike multiplier
    // ------------------------------------------------------------------

    let spikeMultiplier = 0;

    if (input.volume5mMA !== undefined && input.volume5mMA > 0) {
      // Primary: use 5-minute moving average from Birdeye OHLCV enrichment
      spikeMultiplier = input.volume5m / input.volume5mMA;
    } else {
      // Fallback: estimate MA from 1-hour volume divided by 12 intervals
      const estimated5mMA = input.volume1h / INTERVALS_PER_HOUR;
      if (estimated5mMA > 0) {
        spikeMultiplier = input.volume5m / estimated5mMA;
      }
    }

    // ------------------------------------------------------------------
    // Step 3: Map spike multiplier → 0–100 score (piecewise linear)
    // ------------------------------------------------------------------

    let score = 0;

    if (spikeMultiplier <= 1.0) {
      // No spike or declining volume — no signal
      score = 0;
    } else if (spikeMultiplier < MIN_SPIKE_MULTIPLIER) {
      // Mild increase (1.0–1.5×): linear ramp 0→15
      score = Math.round(
        ((spikeMultiplier - 1.0) / (MIN_SPIKE_MULTIPLIER - 1.0)) * 15,
      );
    } else if (spikeMultiplier < MID_SPIKE_MULTIPLIER) {
      // Moderate spike (1.5–3×): linear ramp 15→50
      score =
        15 +
        Math.round(
          ((spikeMultiplier - MIN_SPIKE_MULTIPLIER) /
            (MID_SPIKE_MULTIPLIER - MIN_SPIKE_MULTIPLIER)) *
            35,
        );
    } else if (spikeMultiplier < HIGH_SPIKE_MULTIPLIER) {
      // High spike (3–8×): linear ramp 50→85 — the AAP sweet spot
      score =
        50 +
        Math.round(
          ((spikeMultiplier - MID_SPIKE_MULTIPLIER) /
            (HIGH_SPIKE_MULTIPLIER - MID_SPIKE_MULTIPLIER)) *
            35,
        );
    } else {
      // Extreme spike (8×+): linear ramp 85→100 with cap at MAX_SPIKE_MULTIPLIER
      const extraFactor = Math.min(
        1,
        (spikeMultiplier - HIGH_SPIKE_MULTIPLIER) /
          (MAX_SPIKE_MULTIPLIER - HIGH_SPIKE_MULTIPLIER),
      );
      score = 85 + Math.round(extraFactor * 15);
    }

    // ------------------------------------------------------------------
    // Step 4: Apply volume-to-market-cap ratio bonus
    // ------------------------------------------------------------------

    if (input.marketCap > 0) {
      const volumeToMcRatio = (input.volume24h / input.marketCap) * 100;
      if (volumeToMcRatio >= VOLUME_MC_BONUS_THRESHOLD) {
        score += VOLUME_MC_BONUS_POINTS;
        logger.debug(
          `Token ${input.mint}: vol/MC ratio ${volumeToMcRatio.toFixed(0)}% >= 100%, +${VOLUME_MC_BONUS_POINTS} bonus`,
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Clamp final score to [0, 100]
    // ------------------------------------------------------------------

    const clampedScore = Math.max(0, Math.min(100, Math.round(score)));

    return createResult(clampedScore, input, spikeMultiplier);
  } catch (error: unknown) {
    // ------------------------------------------------------------------
    // Error fallback: return score 0 with error metadata
    // ------------------------------------------------------------------

    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Safely extract the mint for logging — the input may be corrupted
    let mint = 'unknown';
    try {
      mint = input.mint;
    } catch {
      // input.mint access may itself throw in extreme edge cases
    }

    logger.debug(
      `Token ${mint}: volume spike scoring error — ${errorMessage}`,
    );

    // Build a safe fallback result without re-accessing potentially
    // broken input properties (e.g. a proxy that throws on access).
    try {
      return createResult(0, input, 0, {
        error: errorMessage,
        reason: 'scoring error',
      });
    } catch {
      // If even createResult fails (e.g. input properties throw),
      // return a minimal hard-coded FactorResult.
      return {
        name: 'volumeSpike',
        score: 0,
        weight: 0,
        metadata: {
          volume5m: 0,
          volume1h: 0,
          volume24h: 0,
          volume5mMA: null,
          spikeMultiplier: 0,
          volumeToMcRatio: null,
          marketCap: 0,
          error: errorMessage,
          reason: 'scoring error',
        },
      };
    }
  }
}
