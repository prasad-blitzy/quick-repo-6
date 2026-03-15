/**
 * src/safety/lp-analyzer.ts — LP Lock/Burn Verification
 *
 * Examines whether the liquidity pool (LP) tokens for a given Solana trading
 * pair have been burned (sent to a known burn address) or locked in a
 * time-lock contract.  Burned/locked LP drastically reduces the risk of a
 * rug-pull because the deployer can no longer withdraw liquidity.
 *
 * Data sources consumed (passed in by `src/safety/checker.ts`):
 *   - RugCheck  → `lpLocked`, `lpBurned`, `lpBurnPercentage`
 *   - GoPlus    → `lpHolders[]` (with address & percent), `isLpLocked`
 *
 * Merge strategy: **worst-case-wins** — if sources disagree, the more
 * conservative (riskier) assessment is used.  If no data is available the
 * default is `{ burned: false, burnPercent: 0, locked: false }` which will
 * cause the hard filter ("no LP lock/burn" → SKIP) to trigger.
 *
 * Per AAP Section 0.5.1 Group 6:
 *   "LP lock/burn verification; checks if the known burn address
 *    (`1nc1nerator11111111111111111111111111111111`) holds the majority of LP
 *    tokens; validates LP token distribution among top holders"
 *
 * Per AAP Section 0.7.3 (Hard Filters):
 *   "no LP lock/burn" = hard filter fail → token is immediately classified
 *    as SKIP regardless of composite score.
 *
 * @module safety/lp-analyzer
 */

import type { LPStatus } from './types';
import type { RugCheckReport, GoPlusResult, GoPlusLPHolder } from '../api/types';
import { createLogger, type Logger } from '../utils/logger';
import { SOLANA } from '../utils/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Set of well-known Solana LP-token burn / dead addresses.
 *
 * The primary burn address is sourced from `SOLANA.LP_BURN_ADDRESS` in the
 * application config.  The system-program null address is included as a
 * secondary dead address that can also hold LP tokens.
 */
const KNOWN_BURN_ADDRESSES: ReadonlySet<string> = new Set<string>([
  SOLANA.LP_BURN_ADDRESS,                    // '1nc1nerator11111111111111111111111111111111'
  '11111111111111111111111111111111',         // System program (null address)
]);

/**
 * Minimum cumulative burn percentage for LP tokens to be classified as
 * "burned".  A value above 50 % means the majority of LP is unrecoverable.
 */
const MIN_BURN_PERCENT_THRESHOLD = 50;

/**
 * High-confidence burn threshold.  Above 90 % burned the LP is effectively
 * irrecoverable — this is the "safe" classification level.
 */
const HIGH_BURN_PERCENT = 90;

/**
 * Thirty days expressed in seconds — the minimum lock duration for an LP
 * lock to be considered "safe" in `getLPRiskLevel()`.
 */
const LOCK_DURATION_30_DAYS_SEC = 30 * 24 * 60 * 60;

/**
 * Conservative default `LPStatus` returned whenever data is unavailable or
 * an error occurs.  "Not verified" intentionally triggers the hard filter
 * ("no LP lock/burn" → SKIP).
 */
const DEFAULT_LP_STATUS: LPStatus = {
  burned: false,
  burnPercent: 0,
  locked: false,
  lockDuration: undefined,
  lockExpiresAt: undefined,
};

// ---------------------------------------------------------------------------
// LPAnalyzer
// ---------------------------------------------------------------------------

/**
 * Analyses LP (Liquidity Pool) token status using data from RugCheck and
 * GoPlus to determine whether LP tokens have been burned or locked.
 *
 * This class does **not** make external API calls itself — it relies on
 * pre-fetched `RugCheckReport` and `GoPlusResult` objects supplied by
 * `src/safety/checker.ts`.
 *
 * ### Usage
 * ```typescript
 * const lpAnalyzer = new LPAnalyzer();
 * const status = await lpAnalyzer.analyzeLPStatus(mint, rugCheckReport, goPlusResult);
 * const risk   = lpAnalyzer.getLPRiskLevel(status);
 * ```
 */
export class LPAnalyzer {
  /** Structured logger tagged with `[lp-analyzer]` context. */
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger('lp-analyzer');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Determines the LP burn / lock status for a given token.
   *
   * Strategy:
   * 1. Extract LP data from the RugCheck report (if available).
   * 2. Extract LP data from the GoPlus result (if available).
   * 3. Merge both data sources using worst-case-wins logic.
   * 4. Return a unified {@link LPStatus}.
   *
   * If both sources are `null` or produce errors the conservative default
   * `{ burned: false, burnPercent: 0, locked: false }` is returned, which
   * will trigger the hard filter.
   *
   * @param mint             - Solana token mint address being analysed.
   * @param rugCheckReport   - RugCheck safety report (may be `null`).
   * @param goPlusResult     - GoPlus security result (may be `null`).
   * @returns Unified LP lock / burn status.
   */
  async analyzeLPStatus(
    mint: string,
    rugCheckReport: RugCheckReport | null,
    goPlusResult: GoPlusResult | null,
  ): Promise<LPStatus> {
    try {
      this.logger.debug('Analysing LP status', { mint });

      // Step 1 — Extract data from RugCheck
      const rugCheckLP: Partial<LPStatus> = rugCheckReport
        ? this.checkBurnFromRugCheck(rugCheckReport)
        : {};

      // Step 2 — Extract data from GoPlus
      const goPlusLP: Partial<LPStatus> = goPlusResult
        ? this.checkBurnFromGoPlus(goPlusResult)
        : {};

      // Step 3 — Merge with worst-case-wins logic
      const merged = this.mergeLPStatus(rugCheckLP, goPlusLP);

      this.logger.info('LP analysis complete', {
        mint,
        burned: merged.burned,
        burnPercent: merged.burnPercent,
        locked: merged.locked,
        lockDuration: merged.lockDuration,
        lockExpiresAt: merged.lockExpiresAt,
      });

      return merged;
    } catch (err: unknown) {
      this.logger.error('LP analysis failed — returning conservative default', {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ...DEFAULT_LP_STATUS };
    }
  }

  /**
   * Categorises the LP risk level from an {@link LPStatus} object.
   *
   * | Level      | Condition                                                    |
   * |------------|--------------------------------------------------------------|
   * | `'safe'`   | LP burned > 90 %  **OR**  locked with duration > 30 days    |
   * | `'moderate'`| LP burned 50–90 %  **OR**  locked with shorter duration     |
   * | `'risky'`  | LP not burned **AND** not locked (hard filter fail territory)|
   *
   * @param lpStatus - The LP status to evaluate.
   * @returns `'safe'`, `'moderate'`, or `'risky'`.
   */
  getLPRiskLevel(lpStatus: LPStatus): 'safe' | 'moderate' | 'risky' {
    try {
      // High-confidence burn or long-duration lock → safe
      if (lpStatus.burned && lpStatus.burnPercent >= HIGH_BURN_PERCENT) {
        return 'safe';
      }

      if (
        lpStatus.locked &&
        lpStatus.lockDuration !== undefined &&
        lpStatus.lockDuration >= LOCK_DURATION_30_DAYS_SEC
      ) {
        return 'safe';
      }

      // Moderate burn or any lock → moderate
      if (
        lpStatus.burned &&
        lpStatus.burnPercent >= MIN_BURN_PERCENT_THRESHOLD
      ) {
        return 'moderate';
      }

      if (lpStatus.locked) {
        return 'moderate';
      }

      // Everything else → risky (hard filter fail territory)
      return 'risky';
    } catch (err: unknown) {
      this.logger.error('getLPRiskLevel failed — defaulting to risky', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'risky';
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Extracts LP burn / lock data from a RugCheck report.
   *
   * RugCheck provides these fields directly:
   * - `lpBurned`          → boolean
   * - `lpBurnPercentage`  → number (0–100)
   * - `lpLocked`          → boolean
   *
   * @param report - Validated RugCheck report.
   * @returns Partial LP status derived from RugCheck data.
   */
  private checkBurnFromRugCheck(report: RugCheckReport): Partial<LPStatus> {
    try {
      const partial: Partial<LPStatus> = {};

      // Burn data
      if (typeof report.lpBurned === 'boolean') {
        partial.burned = report.lpBurned;
      }

      if (typeof report.lpBurnPercentage === 'number' && !Number.isNaN(report.lpBurnPercentage)) {
        partial.burnPercent = Math.max(0, Math.min(100, report.lpBurnPercentage));
      } else if (partial.burned === true && partial.burnPercent === undefined) {
        // RugCheck says burned but didn't provide a percentage — assume high burn
        partial.burnPercent = HIGH_BURN_PERCENT;
      }

      // Lock data
      if (typeof report.lpLocked === 'boolean') {
        partial.locked = report.lpLocked;
      }

      this.logger.debug('RugCheck LP data extracted', {
        burned: partial.burned,
        burnPercent: partial.burnPercent,
        locked: partial.locked,
      });

      return partial;
    } catch (err: unknown) {
      this.logger.warn('Failed to extract LP data from RugCheck', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * Extracts LP burn / lock data from a GoPlus security result.
   *
   * GoPlus provides:
   * - `lpHolders[]` with `address`, `percent` (string), and `isLocked`
   * - `isLpLocked` boolean
   *
   * The method checks whether any LP holder address matches a known burn
   * address and sums the total percentage held by burn addresses.
   *
   * @param result - Validated GoPlus result.
   * @returns Partial LP status derived from GoPlus data.
   */
  private checkBurnFromGoPlus(result: GoPlusResult): Partial<LPStatus> {
    try {
      const partial: Partial<LPStatus> = {};

      // Analyse LP holder distribution for burn address holdings
      if (Array.isArray(result.lpHolders) && result.lpHolders.length > 0) {
        const burnAnalysis = this.checkBurnAddress(result.lpHolders);
        partial.burned = burnAnalysis.burned;
        partial.burnPercent = burnAnalysis.burnPercent;
      }

      // Lock status from GoPlus global flag
      if (typeof result.isLpLocked === 'boolean') {
        partial.locked = result.isLpLocked;
      }

      // Also check individual LP holder lock flags
      if (
        !partial.locked &&
        Array.isArray(result.lpHolders) &&
        result.lpHolders.length > 0
      ) {
        const anyHolderLocked = result.lpHolders.some(
          (holder: GoPlusLPHolder) => holder.isLocked === true,
        );
        if (anyHolderLocked) {
          partial.locked = true;
        }
      }

      this.logger.debug('GoPlus LP data extracted', {
        burned: partial.burned,
        burnPercent: partial.burnPercent,
        locked: partial.locked,
        lpHolderCount: Array.isArray(result.lpHolders) ? result.lpHolders.length : 0,
      });

      return partial;
    } catch (err: unknown) {
      this.logger.warn('Failed to extract LP data from GoPlus', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * Generic burn-address checker that works with LP holder data from any
   * source.  Iterates through LP holders, matches addresses against
   * {@link KNOWN_BURN_ADDRESSES}, and sums the percentage held by burn
   * addresses.
   *
   * Handles both `string` and `number` percentage formats robustly — GoPlus
   * returns percentages as strings (e.g. `"98.5"`), while other sources may
   * return numbers.
   *
   * @param lpHolders - Array of LP holder entries.
   * @returns Object indicating whether LP is burned and the cumulative burn
   *          percentage.
   */
  private checkBurnAddress(
    lpHolders: Array<{ address: string; percent: string | number }>,
  ): { burned: boolean; burnPercent: number } {
    let totalBurnPercent = 0;

    for (const holder of lpHolders) {
      // Validate holder has required fields
      if (typeof holder.address !== 'string' || !holder.address) {
        continue;
      }

      if (!KNOWN_BURN_ADDRESSES.has(holder.address)) {
        continue;
      }

      // Parse percentage — handle string, number, and "%" suffix formats
      const parsed = this.parsePercent(holder.percent);
      if (parsed > 0) {
        totalBurnPercent += parsed;
      }
    }

    // Clamp to 0–100
    totalBurnPercent = Math.max(0, Math.min(100, totalBurnPercent));

    return {
      burned: totalBurnPercent >= MIN_BURN_PERCENT_THRESHOLD,
      burnPercent: totalBurnPercent,
    };
  }

  /**
   * Merges LP data from RugCheck and GoPlus using **worst-case-wins** logic.
   *
   * Merge rules:
   * - `burned`: Only `true` if at least one source confirms AND the burn
   *   percent is above the threshold.
   * - `burnPercent`: If both sources report, take the **lower** (more
   *   conservative) value.  If only one source reports, use that value.
   * - `locked`: `true` if at least one source confirms lock status.
   * - `lockDuration` / `lockExpiresAt`: Use whichever source provides it;
   *   if both do, take the shorter (more conservative) duration.
   *
   * If neither source provides any data the conservative default is returned:
   * `{ burned: false, burnPercent: 0, locked: false }`.
   *
   * @param rugCheckLP - Partial LP status from RugCheck.
   * @param goPlusLP   - Partial LP status from GoPlus.
   * @returns Complete, merged {@link LPStatus}.
   */
  private mergeLPStatus(
    rugCheckLP: Partial<LPStatus>,
    goPlusLP: Partial<LPStatus>,
  ): LPStatus {
    const hasRugCheck =
      rugCheckLP.burned !== undefined ||
      rugCheckLP.burnPercent !== undefined ||
      rugCheckLP.locked !== undefined;
    const hasGoPlus =
      goPlusLP.burned !== undefined ||
      goPlusLP.burnPercent !== undefined ||
      goPlusLP.locked !== undefined;

    // Neither source provided data — return conservative default
    if (!hasRugCheck && !hasGoPlus) {
      this.logger.warn('No LP data from either source — returning conservative default');
      return { ...DEFAULT_LP_STATUS };
    }

    // ---------- burn percent (worst-case = lower value) ----------
    let burnPercent: number;
    if (
      rugCheckLP.burnPercent !== undefined &&
      goPlusLP.burnPercent !== undefined
    ) {
      // Both available — take the lower (more conservative) value
      burnPercent = Math.min(rugCheckLP.burnPercent, goPlusLP.burnPercent);
    } else {
      burnPercent = rugCheckLP.burnPercent ?? goPlusLP.burnPercent ?? 0;
    }
    burnPercent = Math.max(0, Math.min(100, burnPercent));

    // ---------- burned flag ----------
    // True only if at least one source confirms AND burn percent meets threshold
    const anySourceConfirmsBurn =
      rugCheckLP.burned === true || goPlusLP.burned === true;
    const burned = anySourceConfirmsBurn && burnPercent >= MIN_BURN_PERCENT_THRESHOLD;

    // ---------- locked flag ----------
    // True if at least one source confirms lock
    const locked = rugCheckLP.locked === true || goPlusLP.locked === true;

    // ---------- lock duration (worst-case = shorter duration) ----------
    let lockDuration: number | undefined;
    if (
      rugCheckLP.lockDuration !== undefined &&
      goPlusLP.lockDuration !== undefined
    ) {
      lockDuration = Math.min(rugCheckLP.lockDuration, goPlusLP.lockDuration);
    } else {
      lockDuration = rugCheckLP.lockDuration ?? goPlusLP.lockDuration;
    }

    // ---------- lock expires at (worst-case = earlier expiry) ----------
    let lockExpiresAt: number | undefined;
    if (
      rugCheckLP.lockExpiresAt !== undefined &&
      goPlusLP.lockExpiresAt !== undefined
    ) {
      lockExpiresAt = Math.min(rugCheckLP.lockExpiresAt, goPlusLP.lockExpiresAt);
    } else {
      lockExpiresAt = rugCheckLP.lockExpiresAt ?? goPlusLP.lockExpiresAt;
    }

    this.logger.debug('LP status merge result', {
      burned,
      burnPercent,
      locked,
      lockDuration,
      lockExpiresAt,
    });

    return {
      burned,
      burnPercent,
      locked,
      lockDuration,
      lockExpiresAt,
    };
  }

  /**
   * Safely parses a percentage value that may be a string, number, or
   * string with `%` suffix.  Returns `0` for any unparseable input.
   *
   * @param value - Raw percentage value from an API response.
   * @returns Parsed numeric percentage (0–100) or `0` on failure.
   */
  private parsePercent(value: string | number | null | undefined): number {
    if (value === null || value === undefined) {
      return 0;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
      // Strip optional "%" suffix and whitespace
      const cleaned = value.replace(/%/g, '').trim();
      if (cleaned === '') {
        return 0;
      }
      const parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }
}
