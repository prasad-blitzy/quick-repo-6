/**
 * src/signals/hard-filters.ts — Binary Pass/Fail Safety Gates
 *
 * Implements the absolute safety gates that CANNOT be overridden by high
 * composite scores. If ANY hard filter fails, the token is immediately
 * classified as SKIP regardless of factor scores.
 *
 * Per AAP Section 0.7.3:
 * "Hard filters are absolute: If any hard filter fails (bundled launch >10%
 * sniper supply, active mint authority, active freeze authority, no LP
 * lock/burn, liquidity <$3K, top 10 holders >50%), the token is immediately
 * classified as SKIP regardless of composite score — hard filters cannot be
 * overridden by high scores in other factors."
 *
 * Architecture:
 * ```
 * TokenAnalysisInput → [Filter 1] → [Filter 2] → ... → [Filter 6]
 *    ↓ (any fail)                                          ↓ (all pass)
 *    SKIP (immediate)                                  Continue to scoring
 * ```
 *
 * All 6 hard filters run unconditionally (no short-circuit) so that a complete
 * report of ALL failures is available for debugging and UI display.
 *
 * Consumers:
 * - src/signals/scoring-engine.ts — calls runHardFilters() BEFORE running factor modules
 * - tests/unit/signals/hard-filters.test.ts
 *
 * @module signals/hard-filters
 */

import type { TokenAnalysisInput, HardFilterResult } from './types';
import { HARD_FILTER_THRESHOLDS } from '../utils/config';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module-scoped Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger for the hard-filters module.
 * Context tag: 'hard-filters' — used to identify log output from this module.
 */
const logger = createLogger('hard-filters');

// =============================================================================
// Hard Filter Interface
// =============================================================================

/**
 * Definition of a single hard filter safety gate.
 *
 * Each hard filter performs a binary pass/fail check on a token analysis input.
 * If the `check` function returns `false`, the filter has FAILED and the token
 * should be classified as SKIP regardless of its composite score.
 *
 * Exported for external filter creation and test extensibility.
 */
export interface HardFilter {
  /** Unique kebab-case identifier for this filter (e.g., 'bundled-launch') */
  name: string;

  /** Human-readable description of what this filter checks */
  description: string;

  /**
   * Evaluates the token against this filter's criteria.
   * @param input - The token analysis input containing all available token data
   * @returns `true` if the token PASSES (safe), `false` if the token FAILS (unsafe)
   */
  check: (input: TokenAnalysisInput) => boolean;
}

// =============================================================================
// Individual Hard Filter Implementations
// =============================================================================

/**
 * Filter 1: Bundled Launch (Sniper Supply)
 *
 * Detects tokens launched with bundled/sniped supply. When >10% of the token
 * supply is acquired by snipers/bundled wallets at launch, it indicates a
 * coordinated effort to control supply and dump on retail traders.
 *
 * Threshold: MAX_SNIPER_SUPPLY_PERCENT (10%) from config
 * Fail-open: If sniperSupplyPercent is unavailable (undefined), the filter PASSES
 * because we cannot verify the condition — blocking would cause false negatives.
 */
const bundledLaunchFilter: HardFilter = {
  name: 'bundled-launch',
  description: 'Bundled launch with >10% sniper supply',
  check: (input: TokenAnalysisInput): boolean => {
    // Fail-open: sniperSupplyPercent is optional — if data is unavailable, pass
    if (input.sniperSupplyPercent == null) {
      return true;
    }
    // PASS if sniper supply percentage is within the acceptable threshold
    return input.sniperSupplyPercent <= HARD_FILTER_THRESHOLDS.MAX_SNIPER_SUPPLY_PERCENT;
  },
};

/**
 * Filter 2: Active Mint Authority
 *
 * Checks whether the token's mint authority is still active. An active mint
 * authority means the token creator can mint unlimited additional tokens at any
 * time, effectively diluting all existing holders to zero — a critical rug
 * pull vector.
 *
 * No threshold needed: boolean check — active = FAIL, revoked = PASS.
 *
 * SECURITY: Fail-close — if mintAuthorityActive is undefined/null at runtime
 * (e.g., from incomplete JSON deserialization), the filter FAILS (blocks the
 * token). This is intentional: for security-critical checks, it is safer to
 * reject a token with unknown authority status than to allow it through.
 */
const mintAuthorityFilter: HardFilter = {
  name: 'mint-authority-active',
  description: 'Token has active mint authority (can create unlimited tokens)',
  check: (input: TokenAnalysisInput): boolean => {
    // Fail-close: if mintAuthorityActive is not explicitly false, FAIL.
    // This handles undefined/null values from runtime JSON deserialization
    // by blocking the token rather than silently passing.
    return input.mintAuthorityActive === false;
  },
};

/**
 * Filter 3: Active Freeze Authority
 *
 * Checks whether the token's freeze authority is still active. An active freeze
 * authority means the token creator can freeze any token account, preventing
 * holders from selling — another critical rug pull vector, especially common
 * with Token-2022 extensions.
 *
 * No threshold needed: boolean check — active = FAIL, revoked = PASS.
 *
 * SECURITY: Fail-close — if freezeAuthorityActive is undefined/null at runtime
 * (e.g., from incomplete JSON deserialization), the filter FAILS (blocks the
 * token). This is intentional: for security-critical checks, it is safer to
 * reject a token with unknown authority status than to allow it through.
 */
const freezeAuthorityFilter: HardFilter = {
  name: 'freeze-authority-active',
  description: 'Token has active freeze authority (can freeze token accounts)',
  check: (input: TokenAnalysisInput): boolean => {
    // Fail-close: if freezeAuthorityActive is not explicitly false, FAIL.
    // This handles undefined/null values from runtime JSON deserialization
    // by blocking the token rather than silently passing.
    return input.freezeAuthorityActive === false;
  },
};

/**
 * Filter 4: No LP Lock/Burn
 *
 * Validates that liquidity pool tokens are either locked or burned. If LP tokens
 * are neither locked NOR burned, the creator can remove all liquidity at any time,
 * causing a rug pull. Burned LP is the strongest protection (permanent); locked LP
 * provides time-limited protection.
 *
 * PASS condition: lpBurned === true OR lpLocked === true
 * FAIL condition: both lpBurned and lpLocked are false
 */
const lpLockFilter: HardFilter = {
  name: 'no-lp-lock-burn',
  description: 'LP tokens are neither locked nor burned',
  check: (input: TokenAnalysisInput): boolean => {
    // Fail-close: both lpBurned and lpLocked must be explicitly true to pass.
    // If either is undefined/null from incomplete data, the check fails safely.
    return input.lpBurned === true || input.lpLocked === true;
  },
};

/**
 * Filter 5: Minimum Liquidity
 *
 * Ensures the token has sufficient liquidity to support safe trading. Tokens
 * with liquidity below $3K are extremely dangerous — small trades can cause
 * massive price impact, and the creator may have intentionally kept liquidity
 * low to facilitate a rug pull.
 *
 * Threshold: MIN_LIQUIDITY_USD ($3,000) from config
 */
const minLiquidityFilter: HardFilter = {
  name: 'min-liquidity',
  description: 'Token liquidity is below $3K minimum',
  check: (input: TokenAnalysisInput): boolean => {
    // Fail-close: if liquidity is null/undefined/NaN, treat as 0 (below threshold).
    if (input.liquidity == null || Number.isNaN(input.liquidity)) {
      return false;
    }
    // PASS if liquidity meets or exceeds the minimum threshold
    return input.liquidity >= HARD_FILTER_THRESHOLDS.MIN_LIQUIDITY_USD;
  },
};

/**
 * Filter 6: Top 10 Holder Concentration
 *
 * Detects tokens where supply is excessively concentrated among the top 10
 * holders. When >50% of supply is controlled by just 10 wallets, these holders
 * can coordinate selling to crash the price, and the token is effectively
 * controlled by a small cartel.
 *
 * Threshold: MAX_TOP_10_HOLDER_PERCENT (50%) from config
 */
const holderConcentrationFilter: HardFilter = {
  name: 'top-10-holder-concentration',
  description: 'Top 10 holders control >50% of supply',
  check: (input: TokenAnalysisInput): boolean => {
    // Fail-open: if topHolderPercent is null/undefined/NaN, the filter PASSES
    // because we cannot verify the condition — blocking would cause false negatives.
    // topHolderPercent data may be unavailable from external API responses.
    if (input.topHolderPercent == null || Number.isNaN(input.topHolderPercent)) {
      return true;
    }
    // PASS if top 10 holders hold at or below the maximum threshold
    return input.topHolderPercent <= HARD_FILTER_THRESHOLDS.MAX_TOP_10_HOLDER_PERCENT;
  },
};

// =============================================================================
// Hard Filters Registry
// =============================================================================

/**
 * Ordered array of all hard filter safety gates.
 *
 * All filters in this array are executed for every token analysis — none are
 * skipped. The order does not affect the result (all filters run regardless),
 * but is arranged logically from supply-level concerns to holder-level concerns.
 *
 * Exported for testing extensibility and external introspection.
 */
export const HARD_FILTERS: readonly HardFilter[] = [
  bundledLaunchFilter,
  mintAuthorityFilter,
  freezeAuthorityFilter,
  lpLockFilter,
  minLiquidityFilter,
  holderConcentrationFilter,
] as const;

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Runs ALL hard filter safety gates against a token analysis input.
 *
 * This function does NOT short-circuit — it evaluates every filter regardless
 * of prior failures, providing a complete report of all failed conditions.
 * This is critical for:
 * 1. UI display — showing the user ALL reasons a token was rejected
 * 2. Debugging — understanding which filters are most commonly triggered
 * 3. Monitoring — tracking filter failure patterns over time
 *
 * @param input - The token analysis input containing all available token data.
 *   Must include all fields required by individual hard filters.
 * @returns A {@link HardFilterResult} containing:
 *   - `passed`: `true` if ALL filters passed, `false` if ANY filter failed
 *   - `failedFilters`: Array of filter names that failed (empty if all passed)
 *   - `failedReason`: Human-readable failure description, or `null` if all passed
 *   - `checkedAt`: Timestamp (ms) of when the check was performed
 *
 * @example
 * ```typescript
 * const result = runHardFilters(tokenData);
 * if (!result.passed) {
 *   console.log(`Token ${tokenData.mint} failed: ${result.failedReason}`);
 *   // Output: "Token ABC123... failed: Failed 2 hard filter(s): mint-authority-active, min-liquidity"
 * }
 * ```
 */
export function runHardFilters(input: TokenAnalysisInput): HardFilterResult {
  const failedFilters: string[] = [];

  for (const filter of HARD_FILTERS) {
    const passed = filter.check(input);
    if (!passed) {
      failedFilters.push(filter.name);
      logger.info(
        `Hard filter FAILED: ${filter.name} — ${filter.description} [token: ${input.mint}]`,
      );
    }
  }

  const allPassed = failedFilters.length === 0;

  return {
    passed: allPassed,
    failedFilters,
    failedReason: allPassed
      ? null
      : `Failed ${failedFilters.length} hard filter(s): ${failedFilters.join(', ')}`,
    checkedAt: Date.now(),
  };
}
