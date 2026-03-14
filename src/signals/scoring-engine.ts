/**
 * src/signals/scoring-engine.ts — Composite Signal Scoring Orchestrator
 *
 * The **central integration hub** of the GMGN Signal Bot's analysis pipeline.
 * Orchestrates 7 independent factor modules, applies hard filter safety gates,
 * computes weighted composite scores, and produces BUY/SKIP/EXIT decisions
 * based on configurable trading-mode thresholds.
 *
 * Architecture:
 * ```
 * TokenAnalysisInput
 *   → [Hard Filters]
 *       → (fail → SKIP immediately, no factor execution)
 *       → (pass) → [7 Parallel Factor Modules via Promise.allSettled]
 *           → Weighted Composite Sum (0–100)
 *               → Trading Mode Decision (conservative ≥80, aggressive ≥45)
 *                   → CompositeSignal output
 * ```
 *
 * Per AAP Section 0.5.1 Group 5:
 *   "Composite orchestrator; accepts a TokenAnalysisInput (GMGN data + API
 *    enrichment); runs all 7 factor modules in parallel via Promise.allSettled;
 *    computes weighted sum with configurable weights from settings-store;
 *    applies hard filters from hard-filters.ts; returns CompositeSignal."
 *
 * Per AAP Section 0.7.3:
 *   "Hard filters are absolute: If any hard filter fails, the token is
 *    immediately classified as SKIP regardless of composite score."
 *   "Configurable scoring weights: All 7 factor weights must be user-configurable
 *    via the settings panel."
 *   "Safety checks before AI analysis: Never send a token to the LLM tier
 *    unless it has passed both hard filters and achieved a minimum composite
 *    score threshold."
 *
 * Consumers:
 *   - entrypoints/background.ts — calls analyzeToken() for signal generation
 *   - src/ai/router.ts — receives CompositeSignal for AI dispatch decisions
 *   - src/store/signal-store.ts — stores CompositeSignal results
 *   - tests/unit/signals/scoring-engine.test.ts
 *   - tests/integration/signal-pipeline.test.ts
 *
 * @module signals/scoring-engine
 */

import type {
  TokenAnalysisInput,
  CompositeSignal,
  FactorResult,
  ScoringWeights,
  TradingMode,
  HardFilterResult,
} from './types';

import { runHardFilters } from './hard-filters';
import { scoreVolumeSpike } from './factors/volume-spike';
import { scoreSmartMoneyConvergence } from './factors/smart-money-convergence';
import { scoreBuySellRatio } from './factors/buy-sell-ratio';
import { scoreHolderGrowth } from './factors/holder-growth';
import { scoreLiquidity } from './factors/liquidity';
import { scoreTokenAge } from './factors/token-age';
import { scoreSafetyScore } from './factors/safety-score';
import { createLogger } from '../utils/logger';
import { DEFAULT_SCORING_WEIGHTS, SCORING_THRESHOLDS } from '../utils/config';

// ---------------------------------------------------------------------------
// Module-scoped Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger for the scoring-engine module.
 * Context tag: 'scoring-engine' — used to identify log output from this module
 * across the service worker, covering input validation warnings, hard filter
 * results, individual factor failures, and final BUY/SKIP decisions.
 */
const logger = createLogger('scoring-engine');

// ---------------------------------------------------------------------------
// Factor Scorer Type and Registry
// ---------------------------------------------------------------------------

/**
 * Type definition for a single factor scoring function.
 *
 * Each factor module exports an async function with this signature — accepting
 * a {@link TokenAnalysisInput} and returning a {@link FactorResult} with a
 * score in the range [0, 100], weight 0 (weight is applied by the engine),
 * and factor-specific metadata.
 */
type FactorScorer = (input: TokenAnalysisInput) => Promise<FactorResult>;

/**
 * Registry mapping factor names (matching {@link ScoringWeights} keys) to
 * their corresponding scoring functions.
 *
 * The keys MUST match exactly:
 *   - The {@link ScoringWeights} interface property names
 *   - The {@link FactorName} type literals in types.ts
 *
 * All 7 scorers are executed in parallel via `Promise.allSettled` to ensure
 * that a failure in one factor does not prevent the others from completing.
 */
const FACTOR_SCORERS: Record<string, FactorScorer> = {
  volumeSpike: scoreVolumeSpike,
  smartMoneyConvergence: scoreSmartMoneyConvergence,
  buySellRatio: scoreBuySellRatio,
  holderGrowth: scoreHolderGrowth,
  liquidity: scoreLiquidity,
  tokenAge: scoreTokenAge,
  safetyScore: scoreSafetyScore,
};

// =============================================================================
// Exported Helper: normalizeWeights
// =============================================================================

/**
 * Normalizes scoring weights so they sum to exactly 1.0.
 *
 * This function handles three cases:
 * 1. Weights already sum to ~1.0 (within ±0.001 tolerance) → returned as-is
 * 2. All weights are 0 → returned as-is (scoring engine handles zero-weight)
 * 3. Weights sum to any other value → each weight is divided by the total sum
 *    to produce proportionally equivalent weights that sum to 1.0
 *
 * @param weights - The scoring weights to normalize (7 factor weights)
 * @returns A new ScoringWeights object with weights summing to 1.0, or the
 *          original object if already normalized or all-zero
 *
 * @example
 * ```typescript
 * // Weights already sum to 1.0
 * normalizeWeights(DEFAULT_SCORING_WEIGHTS); // returns same object
 *
 * // Weights sum to 2.0 — each halved
 * normalizeWeights({ volumeSpike: 0.4, smartMoneyConvergence: 0.4, ... });
 * ```
 */
export function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const sum =
    weights.volumeSpike +
    weights.smartMoneyConvergence +
    weights.buySellRatio +
    weights.holderGrowth +
    weights.liquidity +
    weights.tokenAge +
    weights.safetyScore;

  // If weights are already normalized or all zero, return as-is
  if (sum === 0 || Math.abs(sum - 1.0) < 0.001) {
    return weights;
  }

  // Proportionally normalize each weight so the total equals 1.0
  return {
    volumeSpike: weights.volumeSpike / sum,
    smartMoneyConvergence: weights.smartMoneyConvergence / sum,
    buySellRatio: weights.buySellRatio / sum,
    holderGrowth: weights.holderGrowth / sum,
    liquidity: weights.liquidity / sum,
    tokenAge: weights.tokenAge / sum,
    safetyScore: weights.safetyScore / sum,
  };
}

// =============================================================================
// Exported Helper: createSkipSignal
// =============================================================================

/**
 * Factory function for quickly creating a SKIP signal.
 *
 * Used when:
 * - The input is invalid (null, undefined, or missing mint address)
 * - An unexpected error occurs during analysis
 * - Any condition warrants an immediate SKIP without running factor modules
 *
 * Note: For hard filter failures, `analyzeToken` constructs the signal directly
 * with the actual {@link HardFilterResult} from `runHardFilters` to preserve
 * the detailed failure information (which specific filters failed).
 *
 * @param input - The token analysis input (may be null/undefined for invalid cases)
 * @param reason - Human-readable reason for the SKIP decision
 * @returns A CompositeSignal with composite=0, decision='SKIP', confidence=0,
 *          and empty factors array
 *
 * @example
 * ```typescript
 * // Invalid input handling
 * createSkipSignal(null, 'Invalid input');
 *
 * // Unexpected error
 * createSkipSignal(input, 'Unexpected error during analysis');
 * ```
 */
export function createSkipSignal(
  input: TokenAnalysisInput | null | undefined,
  reason: string,
): CompositeSignal {
  return {
    tokenMint: input?.mint ?? 'unknown',
    composite: 0,
    factors: [],
    decision: 'SKIP',
    confidence: 0,
    timestamp: Date.now(),
    tradingMode: 'conservative',
    hardFilterResult: {
      passed: false,
      failedFilters: [],
      failedReason: reason,
      checkedAt: Date.now(),
    },
    tokenSymbol: input?.symbol,
  };
}

// =============================================================================
// Internal Helper: calculateConfidence
// =============================================================================

/**
 * Calculates a confidence score (0–1) based on factor completion rate and
 * score consistency.
 *
 * Confidence blends two signals:
 * - **Completion rate** (50% weight): What fraction of the 7 factors returned
 *   successfully? Higher = more data available for the decision.
 * - **Score consistency** (50% weight): How consistent are the successful factor
 *   scores? Low variance (all factors agreeing) = higher consistency = higher
 *   confidence. High variance (conflicting signals) = lower confidence.
 *
 * The consistency metric uses the coefficient of variation (standard deviation
 * divided by the maximum possible score of 100) mapped inversely to a 0–1 scale.
 *
 * @param factors - Array of all factor results (both successful and failed)
 * @returns Confidence value clamped to [0, 1]
 */
function calculateConfidence(factors: FactorResult[]): number {
  if (factors.length === 0) {
    return 0;
  }

  // Separate successful factors from failed ones (failed = metadata contains 'error')
  const successfulFactors = factors.filter(
    (f) => f.metadata.error === undefined,
  );

  const totalFactors = factors.length;
  const successCount = successfulFactors.length;

  // Completion rate: percentage of factors that completed successfully
  const completionRate = successCount / totalFactors;

  // Score consistency: 1 - (stddev / 100), where 100 is max possible score
  // A stddev of 0 (all identical scores) → consistency = 1.0
  // A stddev of 100 (maximum spread) → consistency = 0.0
  let consistency = 1;
  if (successCount > 0) {
    const avgScore =
      successfulFactors.reduce((sum, f) => sum + f.score, 0) / successCount;
    const variance =
      successfulFactors.reduce(
        (sum, f) => sum + Math.pow(f.score - avgScore, 2),
        0,
      ) / successCount;
    const stddev = Math.sqrt(variance);
    consistency = 1 - Math.min(1, stddev / 100);
  }

  // Blend completion rate and consistency equally
  const confidence = completionRate * 0.5 + consistency * 0.5;

  // Clamp to [0, 1] for safety
  return Math.max(0, Math.min(1, confidence));
}

// =============================================================================
// Main Entry Point: analyzeToken
// =============================================================================

/**
 * Performs comprehensive signal analysis on a single token.
 *
 * This is the **primary entry point** for the signal scoring engine. It accepts
 * a pre-populated {@link TokenAnalysisInput} (combining GMGN intercepted data
 * and external API enrichment), applies hard filter safety gates, runs all 7
 * factor modules in parallel, and produces a {@link CompositeSignal} with a
 * weighted composite score and BUY/SKIP decision.
 *
 * **Execution pipeline:**
 * 1. **Input validation** — rejects null/undefined/missing-mint inputs
 * 2. **Hard filters** — runs 6 binary pass/fail safety gates
 *    (mint authority, freeze authority, LP lock, liquidity, sniper supply,
 *     holder concentration). If ANY fail → immediate SKIP, no factor execution.
 * 3. **Weight resolution** — uses provided weights or falls back to
 *    {@link DEFAULT_SCORING_WEIGHTS}; normalizes to sum to 1.0
 * 4. **Parallel factor execution** — runs all 7 factor modules concurrently
 *    via `Promise.allSettled`; failed factors receive score 0
 * 5. **Weighted composite** — computes weighted average, rounds to integer,
 *    clamps to [0, 100]
 * 6. **Trading decision** — compares composite against trading-mode threshold
 *    (conservative ≥80, aggressive ≥45)
 * 7. **Confidence calculation** — blends factor completion rate and score
 *    consistency into a 0–1 confidence metric
 *
 * @param input - Comprehensive token data from GMGN interception + API enrichment
 * @param weights - Optional custom scoring weights (defaults to {@link DEFAULT_SCORING_WEIGHTS})
 * @param tradingMode - Optional trading mode (defaults to `'conservative'`)
 * @returns Promise resolving to a CompositeSignal with composite score, factor
 *          breakdown, BUY/SKIP decision, and confidence level
 *
 * @example
 * ```typescript
 * const signal = await analyzeToken(tokenData, customWeights, 'aggressive');
 * if (signal.decision === 'BUY') {
 *   // Token passed hard filters and composite ≥45 in aggressive mode
 *   await aiRouter.analyze(tokenData, signal);
 * }
 * ```
 */
export async function analyzeToken(
  input: TokenAnalysisInput,
  weights?: ScoringWeights,
  tradingMode?: TradingMode,
): Promise<CompositeSignal> {
  // -------------------------------------------------------------------------
  // Step 1: Validate input — reject null/undefined/missing-mint
  // -------------------------------------------------------------------------
  if (!input || !input.mint) {
    logger.warn('Invalid token analysis input — missing mint address');
    return createSkipSignal(input, 'Invalid input');
  }

  logger.debug(
    `Starting analysis for token ${input.mint} (${input.symbol ?? 'unknown'})`,
  );

  // -------------------------------------------------------------------------
  // Step 2: Run hard filters FIRST — per AAP: "Hard filters are absolute"
  // If ANY hard filter fails, immediately return SKIP without running factors
  // -------------------------------------------------------------------------
  let hardFilterResult: HardFilterResult;
  try {
    hardFilterResult = runHardFilters(input);
  } catch (error: unknown) {
    logger.warn(
      `Hard filter execution error for ${input.mint}: ${String(error)}`,
    );
    return createSkipSignal(input, `Hard filter error: ${String(error)}`);
  }

  if (!hardFilterResult.passed) {
    logger.info(
      `Token ${input.mint} failed hard filter: ${hardFilterResult.failedReason ?? 'Unknown'}`,
    );

    // Return SKIP with the ACTUAL hard filter result (preserves failedFilters details)
    return {
      tokenMint: input.mint,
      composite: 0,
      factors: [],
      decision: 'SKIP',
      confidence: 0,
      timestamp: Date.now(),
      tradingMode: tradingMode ?? 'conservative',
      hardFilterResult,
      tokenSymbol: input.symbol,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Resolve and normalize scoring weights
  // Priority: (1) explicit parameter → (2) DEFAULT_SCORING_WEIGHTS fallback
  // The caller (background.ts) is responsible for reading from settings-store
  // and passing the user-configured weights here.
  // -------------------------------------------------------------------------
  const resolvedWeights: ScoringWeights = normalizeWeights(
    weights ?? DEFAULT_SCORING_WEIGHTS,
  );

  // -------------------------------------------------------------------------
  // Step 4: Run all 7 factor modules in parallel via Promise.allSettled
  // Promise.allSettled ensures ALL factors complete even if some reject.
  // -------------------------------------------------------------------------
  const factorEntries = Object.entries(FACTOR_SCORERS);

  const results = await Promise.allSettled(
    factorEntries.map(([, scorer]) => scorer(input)),
  );

  // -------------------------------------------------------------------------
  // Step 5: Process results — fulfilled factors keep their score, rejected
  // factors receive score 0 with error metadata. Apply resolved weights.
  // -------------------------------------------------------------------------
  const factors: FactorResult[] = results.map(
    (result, index): FactorResult => {
      const factorName = factorEntries[index][0];
      const weight =
        resolvedWeights[factorName as keyof ScoringWeights] ?? 0;

      if (result.status === 'fulfilled') {
        // Successful factor — apply weight from resolved weights
        return {
          ...result.value,
          weight,
        };
      }

      // Failed factor — log the failure and assign score 0
      logger.warn(
        `Factor ${factorName} failed for token ${input.mint}: ${String(result.reason)}`,
      );

      return {
        name: factorName,
        score: 0,
        weight,
        metadata: { error: String(result.reason) },
      };
    },
  );

  // -------------------------------------------------------------------------
  // Step 6: Compute weighted composite score (0–100 integer)
  // Normalize by total weight to handle cases where weights don't sum to
  // exactly 1.0 (defensive). Round to integer and clamp to [0, 100].
  // -------------------------------------------------------------------------
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);

  const rawComposite =
    totalWeight > 0
      ? factors.reduce((sum, f) => sum + f.score * f.weight, 0) / totalWeight
      : 0;

  const clampedComposite = Math.max(0, Math.min(100, Math.round(rawComposite)));

  // -------------------------------------------------------------------------
  // Step 7: Determine trading decision based on mode and thresholds
  // Per AAP: Conservative ≥80 → BUY, Aggressive ≥45 → BUY
  // -------------------------------------------------------------------------
  const resolvedMode: TradingMode = tradingMode ?? 'conservative';

  const threshold =
    resolvedMode === 'conservative'
      ? SCORING_THRESHOLDS.CONSERVATIVE_MIN // 80
      : SCORING_THRESHOLDS.AGGRESSIVE_MIN; // 45

  const decision: 'BUY' | 'SKIP' | 'EXIT' =
    clampedComposite >= threshold ? 'BUY' : 'SKIP';

  // -------------------------------------------------------------------------
  // Step 8: Calculate confidence (0–1 scale)
  // Blends factor completion rate (50%) and score consistency (50%)
  // -------------------------------------------------------------------------
  const confidence = calculateConfidence(factors);

  // -------------------------------------------------------------------------
  // Step 9: Build and return the CompositeSignal
  // -------------------------------------------------------------------------
  const signal: CompositeSignal = {
    tokenMint: input.mint,
    composite: clampedComposite,
    factors,
    decision,
    confidence,
    timestamp: Date.now(),
    tradingMode: resolvedMode,
    hardFilterResult,
    tokenSymbol: input.symbol,
  };

  logger.info(
    `Token ${input.mint}: composite=${clampedComposite}, decision=${decision}, ` +
      `confidence=${confidence.toFixed(2)}, mode=${resolvedMode}, ` +
      `factors=${factors.length}/7 completed`,
  );

  return signal;
}
