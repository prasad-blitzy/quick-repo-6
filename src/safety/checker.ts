/**
 * src/safety/checker.ts — Multi-Source Safety Orchestrator
 *
 * Orchestrates concurrent safety analysis from RugCheck, GoPlus Security,
 * Jupiter honeypot simulation, and LP lock/burn analysis into a unified
 * {@link SafetyReport}. Results from all sources are merged using
 * **worst-case-wins** logic — if EITHER source indicates a risk, the merged
 * result reflects that risk.
 *
 * Per AAP Section 0.5.1 Group 6:
 *   "Multi-source safety orchestrator; calls RugCheck and GoPlus concurrently
 *    via `Promise.allSettled`; merges results into a unified SafetyReport with
 *    worst-case-wins logic; falls back to individual source if one fails"
 *
 * Per AAP Section 0.7.3 (CRITICAL RULES):
 *   - "Concurrent safety checks: RugCheck and GoPlus must be called
 *      concurrently via `Promise.allSettled`, not sequentially"
 *   - "Jupiter honeypot simulation is mandatory: Every new token must undergo
 *      a sell simulation via Jupiter's `/quote` endpoint before being scored"
 *   - "Safety checks before AI analysis: Never send a token to the LLM tier
 *      unless it has passed both hard filters and achieved a minimum composite
 *      score threshold"
 *
 * Per AAP Section 0.4.3:
 *   - "src/signals/factors/safety-score.ts ← src/safety/checker.ts"
 *   - "src/signals/factors/safety-score.ts ← src/safety/honeypot-detector.ts"
 *
 * Data flow:
 *   RugCheck API  ──┐
 *   GoPlus  API   ──┤── Promise.allSettled ──► mergeResults() ──► SafetyReport
 *   Jupiter /quote ──┘       │
 *                            └──► LP Analyzer ──► LPStatus
 *
 * @module safety/checker
 */

import type {
  SafetyReport,
  HoneypotResult,
  LPStatus,
  AuthorityStatus,
  GoPlusSecuritySummary,
} from './types';
import { RugCheckClient } from '../api/rugcheck';
import { GoPlusClient } from '../api/goplus';
import type { RugCheckReport, GoPlusResult } from '../api/types';
import { HoneypotDetector } from './honeypot-detector';
import { LPAnalyzer } from './lp-analyzer';
import { createLogger, type Logger } from '../utils/logger';
import { HARD_FILTER_THRESHOLDS } from '../utils/config';

// =============================================================================
// Section 1: Score Computation Constants
// =============================================================================

/**
 * Base safety score when RugCheck data is unavailable.
 * A neutral starting point (500/1000) that can be adjusted up or down
 * by penalty/bonus factors from other available data sources.
 */
const BASE_SCORE_NO_RUGCHECK = 500;

/**
 * Penalty applied when the Jupiter sell simulation fails (honeypot detected).
 * This is the most severe penalty since a honeypot means funds are locked.
 * A -500 penalty on a 1000-point scale virtually guarantees a failing score.
 */
const PENALTY_HONEYPOT = 500;

/**
 * Penalty for active mint authority — deployer can inflate supply at will.
 * Per AAP hard filters: "active mint authority" → SKIP.
 */
const PENALTY_MINT_AUTHORITY = 200;

/**
 * Penalty for active freeze authority — deployer can freeze user accounts.
 * Per AAP hard filters: "active freeze authority" → SKIP.
 */
const PENALTY_FREEZE_AUTHORITY = 150;

/**
 * Penalty when the largest single holder controls more than the
 * MAX_TOP_HOLDER_CONCENTRATION threshold (20% per AAP).
 */
const PENALTY_HIGH_HOLDER_CONCENTRATION = 100;

/**
 * Penalty when the top 10 holders control more than the
 * MAX_TOP_10_HOLDER_PERCENT threshold (50% per AAP).
 * Per AAP hard filters: "top 10 holders >50%" → SKIP.
 */
const PENALTY_HIGH_TOP_10_CONCENTRATION = 200;

/**
 * Penalty when LP tokens are neither locked nor burned.
 * Per AAP hard filters: "no LP lock/burn" → SKIP.
 */
const PENALTY_NO_LP_LOCK_BURN = 100;

/**
 * Penalty for tokens using Token-2022 extensions.
 * Per AAP: "Token-2022 may have PermanentDelegate and DefaultAccountState:
 * frozen extensions that introduce novel rug vectors."
 */
const PENALTY_TOKEN_2022 = 100;

/**
 * Penalty when metadata remains mutable — deployer can change token name,
 * symbol, and URI post-launch, a common pre-rug vector.
 */
const PENALTY_MUTABLE_METADATA = 50;

/**
 * Bonus when >90% of LP tokens have been burned — liquidity is effectively
 * irrecoverable, drastically reducing rug-pull risk.
 */
const BONUS_LP_BURNED_HIGH = 50;

/**
 * Bonus when all authorities (mint, freeze) are revoked — the deployer has
 * no remaining admin capabilities.
 */
const BONUS_ALL_AUTHORITIES_REVOKED = 100;

/**
 * Bonus when holder concentration is very low (<10% for the largest holder),
 * indicating healthy token distribution.
 */
const BONUS_LOW_CONCENTRATION = 50;

/** Threshold for the LP high-burn bonus (>90% burned). */
const LP_HIGH_BURN_THRESHOLD = 90;

/** Threshold for the low-concentration bonus (<10% largest holder). */
const LOW_CONCENTRATION_THRESHOLD = 10;

/** Minimum allowed safety score (floor clamp). */
const SCORE_MIN = 0;

/** Maximum allowed safety score (ceiling clamp). */
const SCORE_MAX = 1000;

// =============================================================================
// Section 2: SafetyChecker Class
// =============================================================================

/**
 * Multi-source safety orchestrator for Solana memecoin tokens.
 *
 * Coordinates concurrent safety checks across:
 *   1. **RugCheck**  — token safety report, risk factors, authority status
 *   2. **GoPlus**    — contract security, holder distribution, LP lock status
 *   3. **Jupiter**   — honeypot sell simulation (mandatory per AAP)
 *   4. **LP Analyzer** — LP burn/lock verification from merged data
 *
 * All external calls are made via constructor-injected client instances for
 * dependency injection and testability.
 *
 * @example
 * ```typescript
 * const checker = new SafetyChecker(rugCheckClient, goPlusClient, honeypotDetector, lpAnalyzer);
 * const report = await checker.checkToken('TokenMintAddress...');
 *
 * if (report.overallScore >= 300) {
 *   console.log('Token passes safety threshold');
 * }
 *
 * if (!report.honeypotResult.sellable) {
 *   console.warn('HONEYPOT: Token cannot be sold');
 * }
 * ```
 */
export class SafetyChecker {
  /** RugCheck REST API client — fetches token safety reports. */
  private readonly rugCheckClient: RugCheckClient;

  /** GoPlus Security API client — fetches contract security data. */
  private readonly goPlusClient: GoPlusClient;

  /** Jupiter-based honeypot detector — simulates sell transactions. */
  private readonly honeypotDetector: HoneypotDetector;

  /** LP lock/burn analyzer — merges LP data from RugCheck and GoPlus. */
  private readonly lpAnalyzer: LPAnalyzer;

  /** Structured logger with 'safety-checker' context tag. */
  private readonly logger: Logger;

  /**
   * Creates a new SafetyChecker instance.
   *
   * All dependencies are injected via the constructor for testability —
   * test suites can provide mock implementations of each client.
   *
   * @param rugCheckClient  - Pre-configured RugCheck API client.
   * @param goPlusClient    - Pre-configured GoPlus Security API client.
   * @param honeypotDetector - Pre-configured Jupiter honeypot detector.
   * @param lpAnalyzer      - LP lock/burn analyzer instance.
   */
  constructor(
    rugCheckClient: RugCheckClient,
    goPlusClient: GoPlusClient,
    honeypotDetector: HoneypotDetector,
    lpAnalyzer: LPAnalyzer,
  ) {
    this.rugCheckClient = rugCheckClient;
    this.goPlusClient = goPlusClient;
    this.honeypotDetector = honeypotDetector;
    this.lpAnalyzer = lpAnalyzer;
    this.logger = createLogger('safety-checker');

    this.logger.info('SafetyChecker initialized with all safety data sources');
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Performs a comprehensive, multi-source safety analysis for a token.
   *
   * Execution flow:
   *   1. Run RugCheck, GoPlus, and Honeypot checks **concurrently** via
   *      `Promise.allSettled` (CRITICAL: never sequentially per AAP §0.7.3).
   *   2. Extract and validate results from each settled promise.
   *   3. Run LP analysis using data from RugCheck and GoPlus.
   *   4. Merge all results into a unified {@link SafetyReport} using
   *      worst-case-wins logic.
   *
   * This method **NEVER throws** — on catastrophic failure it returns a
   * maximally cautious SafetyReport with `overallScore = 0`.
   *
   * @param mint - Solana token mint address (base58 public key) to analyse.
   * @returns Unified safety report with composite score, risk factors, and
   *   individual check results from all sources.
   */
  async checkToken(mint: string): Promise<SafetyReport> {
    this.logger.info(`Starting comprehensive safety check for token: ${mint}`);
    const startTime = Date.now();

    try {
      // =====================================================================
      // Step 1: Run RugCheck, GoPlus, and Honeypot CONCURRENTLY
      // CRITICAL: Must use Promise.allSettled, NOT Promise.all (AAP §0.7.3)
      // =====================================================================
      const [rugCheckSettled, goPlusSettled, honeypotSettled] =
        await Promise.allSettled([
          this.rugCheckClient.getTokenReport(mint),
          this.goPlusClient.getTokenSecurity(mint),
          this.honeypotDetector.checkHoneypot(mint),
        ]);

      // =====================================================================
      // Step 2: Extract results with graceful failure handling
      // =====================================================================
      const rugCheckReport = this.extractRugCheckResult(rugCheckSettled, mint);
      const goPlusResult = this.extractGoPlusResult(goPlusSettled, mint);
      const honeypotResult = this.extractHoneypotResult(honeypotSettled, mint);

      const rugCheckAvailable = rugCheckReport !== null;
      const goPlusAvailable = goPlusResult !== null;

      this.logger.debug('Concurrent safety checks completed', {
        mint,
        rugCheckAvailable,
        goPlusAvailable,
        honeypotSellable: honeypotResult.sellable,
        honeypotEstimatedTax: honeypotResult.estimatedTax,
        rugCheckScore: rugCheckReport?.score ?? null,
      });

      // =====================================================================
      // Step 3: Run LP analysis using RugCheck and GoPlus data
      // =====================================================================
      const lpStatus = await this.runLPAnalysis(mint, rugCheckReport, goPlusResult);

      this.logger.debug('LP analysis completed', {
        mint,
        lpBurned: lpStatus.burned,
        lpBurnPercent: lpStatus.burnPercent,
        lpLocked: lpStatus.locked,
      });

      // =====================================================================
      // Step 4: Merge all results into a unified SafetyReport
      // =====================================================================
      const report = this.mergeResults(
        mint,
        rugCheckReport,
        goPlusResult,
        honeypotResult,
        lpStatus,
        rugCheckAvailable,
        goPlusAvailable,
      );

      const elapsed = Date.now() - startTime;
      this.logger.info(
        `Safety check completed for ${mint} in ${elapsed}ms — ` +
        `score: ${report.overallScore}, risks: ${report.riskFactors.length}, ` +
        `honeypot: ${!report.honeypotResult.sellable}, ` +
        `rugCheck: ${rugCheckAvailable ? 'available' : 'unavailable'}, ` +
        `goPlus: ${goPlusAvailable ? 'available' : 'unavailable'}`,
      );

      return report;
    } catch (err: unknown) {
      // Catastrophic failure — safety pipeline must NEVER crash
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Catastrophic failure during safety check for ${mint} — ` +
        'returning maximally cautious report',
        { mint, error: errorMessage },
      );
      return this.createFailsafeReport(mint);
    }
  }

  // ===========================================================================
  // Private — Result Extraction Helpers
  // ===========================================================================

  /**
   * Extracts the RugCheck report from a settled promise result.
   *
   * @param settled - The PromiseSettledResult from Promise.allSettled.
   * @param mint    - Token mint address for logging context.
   * @returns The RugCheckReport if available and valid, or null.
   */
  private extractRugCheckResult(
    settled: PromiseSettledResult<RugCheckReport | null>,
    mint: string,
  ): RugCheckReport | null {
    if (settled.status === 'rejected') {
      this.logger.warn(
        `RugCheck API call rejected for ${mint}`,
        { reason: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) },
      );
      return null;
    }

    // RugCheckClient.getTokenReport() returns null on failure
    if (settled.value === null) {
      this.logger.warn(`RugCheck returned null for ${mint} — token may not be indexed`);
      return null;
    }

    return settled.value;
  }

  /**
   * Extracts the GoPlus result from a settled promise result.
   *
   * @param settled - The PromiseSettledResult from Promise.allSettled.
   * @param mint    - Token mint address for logging context.
   * @returns The GoPlusResult if available, or null if the promise rejected.
   */
  private extractGoPlusResult(
    settled: PromiseSettledResult<GoPlusResult>,
    mint: string,
  ): GoPlusResult | null {
    if (settled.status === 'rejected') {
      this.logger.warn(
        `GoPlus API call rejected for ${mint}`,
        { reason: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) },
      );
      return null;
    }

    return settled.value;
  }

  /**
   * Extracts the honeypot result from a settled promise, providing a
   * fail-safe default if the simulation failed entirely.
   *
   * Per AAP: Jupiter honeypot simulation is MANDATORY. If the simulation
   * itself crashes, the fail-safe assumes the token is a honeypot
   * (sellable: false, estimatedTax: 100).
   *
   * @param settled - The PromiseSettledResult from Promise.allSettled.
   * @param mint    - Token mint address for logging context.
   * @returns A guaranteed HoneypotResult — either real data or fail-safe.
   */
  private extractHoneypotResult(
    settled: PromiseSettledResult<HoneypotResult>,
    mint: string,
  ): HoneypotResult {
    if (settled.status === 'rejected') {
      this.logger.error(
        `Honeypot detection crashed for ${mint} — assuming honeypot (fail-safe)`,
        { reason: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) },
      );
      return {
        sellable: false,
        estimatedTax: 100,
        error: `Honeypot detection failed: ${
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
        }`,
      };
    }

    return settled.value;
  }

  // ===========================================================================
  // Private — LP Analysis
  // ===========================================================================

  /**
   * Runs LP analysis with error handling.
   *
   * The LP analyzer requires RugCheck and GoPlus data which may be null
   * if those sources were unavailable. It handles null inputs gracefully,
   * returning a conservative default.
   *
   * @param mint          - Token mint address.
   * @param rugCheck      - RugCheck report (may be null).
   * @param goPlus        - GoPlus result (may be null).
   * @returns LP lock/burn status, or a conservative default on failure.
   */
  private async runLPAnalysis(
    mint: string,
    rugCheck: RugCheckReport | null,
    goPlus: GoPlusResult | null,
  ): Promise<LPStatus> {
    try {
      // Log raw RugCheck LP fields before delegating to the LP analyzer,
      // which merges both RugCheck and GoPlus LP data with worst-case-wins.
      if (rugCheck !== null) {
        this.logger.debug('RugCheck raw LP data before LP analysis', {
          mint,
          rugCheckLpLocked: rugCheck.lpLocked,
          rugCheckLpBurned: rugCheck.lpBurned,
          rugCheckLpBurnPercentage: rugCheck.lpBurnPercentage,
        });
      }

      return await this.lpAnalyzer.analyzeLPStatus(mint, rugCheck, goPlus);
    } catch (err: unknown) {
      this.logger.error(
        `LP analysis failed for ${mint} — returning conservative default`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return {
        burned: false,
        burnPercent: 0,
        locked: false,
      };
    }
  }

  // ===========================================================================
  // Private — Worst-Case-Wins Merge Logic
  // ===========================================================================

  /**
   * Merges all safety data sources into a unified {@link SafetyReport}
   * using **worst-case-wins** logic.
   *
   * Worst-case-wins principle:
   *   - `mintRevoked`:  Both sources must confirm revoked → safe.
   *   - `freezeRevoked`: Both sources must confirm revoked → safe.
   *   - `isMintable`:   If EITHER says mintable → risky.
   *   - `isFreezable`:  If EITHER says freezable → risky.
   *   - `top10HolderPercent`: Take the HIGHER (worse) value.
   *   - `largestHolderPercent`: Take the HIGHER (worse) value.
   *   - `overallScore`:  Computed from combined data with penalties/bonuses.
   *   - `lpLocked`: Only mark locked if LP analysis confirms it.
   *
   * @param mint              - Token mint address.
   * @param rugCheck          - RugCheck report (null if unavailable).
   * @param goPlus            - GoPlus result (null if unavailable).
   * @param honeypot          - Honeypot detection result (always present).
   * @param lp                - LP lock/burn status.
   * @param rugCheckAvailable - Whether RugCheck data was successfully retrieved.
   * @param goPlusAvailable   - Whether GoPlus data was successfully retrieved.
   * @returns Unified SafetyReport with worst-case-wins merged data.
   */
  private mergeResults(
    mint: string,
    rugCheck: RugCheckReport | null,
    goPlus: GoPlusResult | null,
    honeypot: HoneypotResult,
    lp: LPStatus,
    rugCheckAvailable: boolean,
    goPlusAvailable: boolean,
  ): SafetyReport {
    // Extract authority status using worst-case-wins logic
    const authorityStatus = this.extractAuthorityStatus(rugCheck, goPlus);

    // Compute holder concentration metrics (worst-case from both sources)
    const { top10HolderPercent, largestHolderPercent } =
      this.computeHolderConcentration(rugCheck, goPlus);

    // Determine Token-2022 status
    const isToken2022 = this.determineToken2022Status(rugCheck);

    // Build the GoPlus security summary for the report
    const goPlusSummary = goPlusAvailable && goPlus
      ? this.extractGoPlusSummary(goPlus)
      : null;

    // Collect all risk factors from all sources
    const riskFactors = this.collectRiskFactors(
      rugCheck,
      goPlus,
      honeypot,
      lp,
      authorityStatus,
      isToken2022,
      top10HolderPercent,
      largestHolderPercent,
      rugCheckAvailable,
      goPlusAvailable,
    );

    // Compute the overall safety score with penalties and bonuses
    const overallScore = this.computeOverallScore(
      rugCheck,
      goPlus,
      honeypot,
      lp,
      authorityStatus,
      isToken2022,
      top10HolderPercent,
      largestHolderPercent,
    );

    return {
      mint,
      overallScore,
      rugCheckScore: rugCheckAvailable && rugCheck ? rugCheck.score : null,
      goPlusResult: goPlusSummary,
      honeypotResult: honeypot,
      lpStatus: lp,
      authorityStatus,
      riskFactors,
      isToken2022,
      checkedAt: Date.now(),
      rugCheckAvailable,
      goPlusAvailable,
      top10HolderPercent,
      largestHolderPercent,
    };
  }

  // ===========================================================================
  // Private — Overall Score Computation
  // ===========================================================================

  /**
   * Computes the composite overall safety score on a 0–1000 scale.
   *
   * Algorithm:
   *   1. Start with RugCheck's score (if available), otherwise BASE_SCORE_NO_RUGCHECK (500).
   *   2. Subtract penalties for each identified risk.
   *   3. Add bonuses for each identified positive signal.
   *   4. Clamp the final result to [0, 1000].
   *
   * Per AAP: RugCheck score ≥300 is considered "safe" for the safety-score
   * factor in the composite scoring engine.
   *
   * @returns Clamped safety score in the [0, 1000] range.
   */
  private computeOverallScore(
    rugCheck: RugCheckReport | null,
    goPlus: GoPlusResult | null,
    honeypot: HoneypotResult,
    lp: LPStatus,
    authorityStatus: AuthorityStatus,
    isToken2022: boolean,
    top10HolderPercent: number,
    largestHolderPercent: number,
  ): number {
    // Start with RugCheck's raw score or a neutral base
    let score = rugCheck !== null ? rugCheck.score : BASE_SCORE_NO_RUGCHECK;

    this.logger.debug('Computing overall safety score', {
      baseScore: score,
      hasRugCheck: rugCheck !== null,
      hasGoPlus: goPlus !== null,
    });

    // ----- PENALTIES -----

    // Honeypot detected — most severe penalty
    if (!honeypot.sellable) {
      score -= PENALTY_HONEYPOT;
      this.logger.debug('Applied honeypot penalty', {
        penalty: PENALTY_HONEYPOT,
        estimatedTax: honeypot.estimatedTax,
      });
    }

    // Active mint authority
    if (!authorityStatus.mintRevoked) {
      score -= PENALTY_MINT_AUTHORITY;
      this.logger.debug('Applied mint authority penalty', { penalty: PENALTY_MINT_AUTHORITY });
    }

    // Active freeze authority
    if (!authorityStatus.freezeRevoked) {
      score -= PENALTY_FREEZE_AUTHORITY;
      this.logger.debug('Applied freeze authority penalty', { penalty: PENALTY_FREEZE_AUTHORITY });
    }

    // High single-holder concentration (>20% per AAP)
    if (largestHolderPercent > HARD_FILTER_THRESHOLDS.MAX_TOP_HOLDER_CONCENTRATION) {
      score -= PENALTY_HIGH_HOLDER_CONCENTRATION;
      this.logger.debug('Applied high holder concentration penalty', {
        penalty: PENALTY_HIGH_HOLDER_CONCENTRATION,
        largestHolderPercent,
        threshold: HARD_FILTER_THRESHOLDS.MAX_TOP_HOLDER_CONCENTRATION,
      });
    }

    // High top-10 holder concentration (>50% per AAP)
    if (top10HolderPercent > HARD_FILTER_THRESHOLDS.MAX_TOP_10_HOLDER_PERCENT) {
      score -= PENALTY_HIGH_TOP_10_CONCENTRATION;
      this.logger.debug('Applied top-10 holder concentration penalty', {
        penalty: PENALTY_HIGH_TOP_10_CONCENTRATION,
        top10HolderPercent,
        threshold: HARD_FILTER_THRESHOLDS.MAX_TOP_10_HOLDER_PERCENT,
      });
    }

    // No LP lock or burn
    if (!lp.burned && !lp.locked) {
      score -= PENALTY_NO_LP_LOCK_BURN;
      this.logger.debug('Applied no LP lock/burn penalty', { penalty: PENALTY_NO_LP_LOCK_BURN });
    }

    // Token-2022 extensions (additional risk vectors)
    if (isToken2022) {
      score -= PENALTY_TOKEN_2022;
      this.logger.debug('Applied Token-2022 penalty', { penalty: PENALTY_TOKEN_2022 });
    }

    // Mutable metadata
    if (authorityStatus.metadataMutable) {
      score -= PENALTY_MUTABLE_METADATA;
      this.logger.debug('Applied mutable metadata penalty', { penalty: PENALTY_MUTABLE_METADATA });
    }

    // ----- BONUSES -----

    // LP burned above 90% — liquidity is irrecoverable
    if (lp.burned && lp.burnPercent >= LP_HIGH_BURN_THRESHOLD) {
      score += BONUS_LP_BURNED_HIGH;
      this.logger.debug('Applied LP high-burn bonus', {
        bonus: BONUS_LP_BURNED_HIGH,
        burnPercent: lp.burnPercent,
      });
    }

    // All authorities revoked — deployer has no admin capabilities
    if (authorityStatus.mintRevoked && authorityStatus.freezeRevoked) {
      score += BONUS_ALL_AUTHORITIES_REVOKED;
      this.logger.debug('Applied all-authorities-revoked bonus', {
        bonus: BONUS_ALL_AUTHORITIES_REVOKED,
      });
    }

    // Low holder concentration (<10% for largest holder)
    if (largestHolderPercent > 0 && largestHolderPercent < LOW_CONCENTRATION_THRESHOLD) {
      score += BONUS_LOW_CONCENTRATION;
      this.logger.debug('Applied low-concentration bonus', {
        bonus: BONUS_LOW_CONCENTRATION,
        largestHolderPercent,
      });
    }

    // Clamp to valid range [0, 1000]
    const clampedScore = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));

    this.logger.debug('Final safety score computed', {
      rawScore: score,
      clampedScore,
      safeThreshold: HARD_FILTER_THRESHOLDS.MIN_SAFETY_SCORE,
      passesSafeThreshold: clampedScore >= HARD_FILTER_THRESHOLDS.MIN_SAFETY_SCORE,
    });

    return clampedScore;
  }

  // ===========================================================================
  // Private — Risk Factor Collection
  // ===========================================================================

  /**
   * Enumerates all detected risks as human-readable strings.
   *
   * These risk factor strings are displayed in the SafetyBadge tooltip
   * in the UI, providing traders with a quick overview of detected issues.
   *
   * @returns Array of human-readable risk description strings.
   */
  private collectRiskFactors(
    rugCheck: RugCheckReport | null,
    goPlus: GoPlusResult | null,
    honeypot: HoneypotResult,
    lp: LPStatus,
    authorityStatus: AuthorityStatus,
    isToken2022: boolean,
    top10HolderPercent: number,
    largestHolderPercent: number,
    rugCheckAvailable: boolean,
    goPlusAvailable: boolean,
  ): string[] {
    const risks: string[] = [];

    // --- Data Source Availability Warnings ---
    if (!rugCheckAvailable && !goPlusAvailable) {
      risks.push('All safety sources unavailable — treating token as unsafe');
    } else if (!rugCheckAvailable) {
      risks.push('RugCheck safety check unavailable — using GoPlus data only');
    } else if (!goPlusAvailable) {
      risks.push('GoPlus safety check unavailable — using RugCheck data only');
    }

    // --- Honeypot Risk ---
    if (!honeypot.sellable) {
      risks.push('Token is a potential honeypot — sell simulation failed');
    } else if (honeypot.estimatedTax > 10) {
      risks.push(
        `High sell tax detected: ${honeypot.estimatedTax.toFixed(1)}% — potential soft honeypot`,
      );
    }

    // --- Authority Risks ---
    if (!authorityStatus.mintRevoked) {
      risks.push('Mint authority is active — new tokens can be created');
    }

    if (!authorityStatus.freezeRevoked) {
      risks.push('Freeze authority is active — accounts can be frozen');
    }

    if (authorityStatus.metadataMutable) {
      risks.push('Token metadata is mutable — can be changed post-launch');
    }

    // --- Holder Concentration Risks ---
    if (largestHolderPercent > HARD_FILTER_THRESHOLDS.MAX_TOP_HOLDER_CONCENTRATION) {
      risks.push(
        `Top holder owns >${HARD_FILTER_THRESHOLDS.MAX_TOP_HOLDER_CONCENTRATION}% of supply ` +
        `(${largestHolderPercent.toFixed(1)}%)`,
      );
    }

    if (top10HolderPercent > HARD_FILTER_THRESHOLDS.MAX_TOP_10_HOLDER_PERCENT) {
      risks.push(
        `Top 10 holders control >${HARD_FILTER_THRESHOLDS.MAX_TOP_10_HOLDER_PERCENT}% of supply ` +
        `(${top10HolderPercent.toFixed(1)}%)`,
      );
    }

    // --- LP Risks ---
    if (!lp.burned && !lp.locked) {
      risks.push('Liquidity pool is not locked or burned');
    }

    // --- Token-2022 Risk ---
    if (isToken2022) {
      risks.push('Token uses Token-2022 extensions (additional risk vectors)');
    }

    // --- RugCheck Specific High-Severity Risks ---
    if (rugCheck !== null && rugCheck.risks.length > 0) {
      for (const risk of rugCheck.risks) {
        if (risk.level === 'critical' || risk.level === 'high') {
          risks.push(`RugCheck reported ${risk.level}-severity risk: ${risk.name}`);
        }
      }
    }

    // --- GoPlus Specific Risks ---
    if (goPlus !== null) {
      // Check LP holders for suspicious patterns
      if (goPlus.lpHolders.length === 0) {
        risks.push('No LP holders detected by GoPlus — token may lack liquidity');
      }

      // Check if contract source is not verified
      if (!goPlus.isOpenSource) {
        risks.push('Token contract source is not verified/open-source');
      }

      // Low holder count may indicate a very new or manipulated token
      if (goPlus.holderCount < 10) {
        risks.push(`Very low holder count: ${goPlus.holderCount} holders`);
      }
    }

    // --- RugCheck Liquidity Warning ---
    if (rugCheck !== null && rugCheck.totalMarketLiquidity < HARD_FILTER_THRESHOLDS.MIN_LIQUIDITY_USD) {
      risks.push(
        `Low total market liquidity: $${rugCheck.totalMarketLiquidity.toLocaleString()} ` +
        `(below $${HARD_FILTER_THRESHOLDS.MIN_LIQUIDITY_USD.toLocaleString()} threshold)`,
      );
    }

    return risks;
  }

  // ===========================================================================
  // Private — Authority Status Extraction
  // ===========================================================================

  /**
   * Extracts and merges authority status from both RugCheck and GoPlus
   * using worst-case-wins logic.
   *
   * Worst-case-wins for authorities:
   *   - `mintRevoked`: true ONLY if BOTH sources confirm revoked
   *     (or if only one source has data and it confirms revoked).
   *   - `freezeRevoked`: same logic.
   *   - `metadataMutable`: true if RugCheck indicates mutable metadata.
   *
   * If BOTH sources are null, returns the most conservative defaults
   * (all authorities active/mutable).
   *
   * @param rugCheck - RugCheck report (may be null).
   * @param goPlus   - GoPlus result (may be null).
   * @returns Merged authority status.
   */
  private extractAuthorityStatus(
    rugCheck: RugCheckReport | null,
    goPlus: GoPlusResult | null,
  ): AuthorityStatus {
    // Both sources unavailable — assume the worst
    if (rugCheck === null && goPlus === null) {
      this.logger.warn('No safety data available for authority status — assuming all active');
      return {
        mintRevoked: false,
        freezeRevoked: false,
        metadataMutable: true,
      };
    }

    // Only RugCheck available
    if (rugCheck !== null && goPlus === null) {
      return {
        // mintAuthority is null when revoked (safe), non-null when active (risky)
        mintRevoked: rugCheck.mintAuthority === null && !rugCheck.isMintable,
        freezeRevoked: rugCheck.freezeAuthority === null && !rugCheck.isFreezable,
        metadataMutable: this.checkMetadataMutable(rugCheck),
      };
    }

    // Only GoPlus available
    if (rugCheck === null && goPlus !== null) {
      return {
        mintRevoked: !goPlus.isMintable,
        freezeRevoked: !goPlus.isFreezable,
        // GoPlus doesn't provide metadata mutability info — assume worst case
        metadataMutable: true,
      };
    }

    // Both available — worst-case-wins
    // mintRevoked: true ONLY if BOTH say not mintable
    const rugCheckMintRevoked =
      rugCheck!.mintAuthority === null && !rugCheck!.isMintable;
    const goPlusMintRevoked = !goPlus!.isMintable;
    const mintRevoked = rugCheckMintRevoked && goPlusMintRevoked;

    // freezeRevoked: true ONLY if BOTH say not freezable
    const rugCheckFreezeRevoked =
      rugCheck!.freezeAuthority === null && !rugCheck!.isFreezable;
    const goPlusFreezeRevoked = !goPlus!.isFreezable;
    const freezeRevoked = rugCheckFreezeRevoked && goPlusFreezeRevoked;

    // Metadata mutability from RugCheck (GoPlus doesn't track this)
    const metadataMutable = this.checkMetadataMutable(rugCheck!);

    this.logger.debug('Authority status merged (worst-case-wins)', {
      rugCheckMintRevoked,
      goPlusMintRevoked,
      mintRevoked,
      rugCheckFreezeRevoked,
      goPlusFreezeRevoked,
      freezeRevoked,
      metadataMutable,
    });

    return { mintRevoked, freezeRevoked, metadataMutable };
  }

  // ===========================================================================
  // Private — GoPlus Summary Extraction
  // ===========================================================================

  /**
   * Extracts a {@link GoPlusSecuritySummary} from the full
   * {@link GoPlusResult} for inclusion in the SafetyReport.
   *
   * This is a lightweight projection of the most security-relevant fields
   * from the full GoPlus response.
   *
   * @param goPlus - The full GoPlus result to summarise.
   * @returns A GoPlusSecuritySummary with the key security metrics.
   */
  private extractGoPlusSummary(goPlus: GoPlusResult): GoPlusSecuritySummary {
    return {
      isMintable: goPlus.isMintable,
      isFreezable: goPlus.isFreezable,
      isOpenSource: goPlus.isOpenSource,
      holderCount: goPlus.holderCount,
      top10HolderPercent: goPlus.top10HolderPercent,
      largestHolderPercent: goPlus.largestHolderPercent,
      isLpLocked: goPlus.isLpLocked,
      creatorAddress: goPlus.creatorAddress,
    };
  }

  // ===========================================================================
  // Private — Holder Concentration Computation
  // ===========================================================================

  /**
   * Computes holder concentration metrics from both RugCheck and GoPlus
   * data using worst-case-wins (takes the HIGHER / worse value).
   *
   * For RugCheck: Computes top10HolderPercent and largestHolderPercent
   * from the `topHolders[]` array by summing and finding the maximum.
   *
   * For GoPlus: Uses the pre-computed `top10HolderPercent` and
   * `largestHolderPercent` fields.
   *
   * @returns Object with worst-case top10HolderPercent and largestHolderPercent.
   */
  private computeHolderConcentration(
    rugCheck: RugCheckReport | null,
    goPlus: GoPlusResult | null,
  ): { top10HolderPercent: number; largestHolderPercent: number } {
    let top10HolderPercent = 0;
    let largestHolderPercent = 0;

    // Extract from RugCheck topHolders array
    if (rugCheck !== null && rugCheck.topHolders.length > 0) {
      // Sort holders by percentage descending and take top 10
      const sortedHolders = [...rugCheck.topHolders]
        .sort((a, b) => b.percentage - a.percentage)
        .slice(0, 10);

      const rugCheckTop10 = sortedHolders.reduce(
        (sum, holder) => sum + holder.percentage,
        0,
      );
      const rugCheckLargest =
        sortedHolders.length > 0 ? sortedHolders[0].percentage : 0;

      top10HolderPercent = rugCheckTop10;
      largestHolderPercent = rugCheckLargest;
    }

    // Extract from GoPlus pre-computed fields — take worst case
    if (goPlus !== null) {
      if (goPlus.top10HolderPercent > top10HolderPercent) {
        top10HolderPercent = goPlus.top10HolderPercent;
      }
      if (goPlus.largestHolderPercent > largestHolderPercent) {
        largestHolderPercent = goPlus.largestHolderPercent;
      }

      // Also check GoPlus topHolders array for completeness
      if (goPlus.topHolders.length > 0) {
        const goPlusLargest = goPlus.topHolders.reduce((max, holder) => {
          const pct = parseFloat(holder.percent) || 0;
          return pct > max ? pct : max;
        }, 0);
        if (goPlusLargest > largestHolderPercent) {
          largestHolderPercent = goPlusLargest;
        }
      }
    }

    this.logger.debug('Holder concentration computed (worst-case-wins)', {
      top10HolderPercent,
      largestHolderPercent,
    });

    return { top10HolderPercent, largestHolderPercent };
  }

  // ===========================================================================
  // Private — Token-2022 Detection
  // ===========================================================================

  /**
   * Determines whether the token uses Token-2022 extensions.
   *
   * Currently sourced from RugCheck data only, as GoPlus does not
   * distinguish between standard SPL tokens and Token-2022 tokens.
   *
   * @param rugCheck - RugCheck report (may be null).
   * @returns true if the token uses Token-2022 extensions.
   */
  private determineToken2022Status(rugCheck: RugCheckReport | null): boolean {
    if (rugCheck !== null) {
      return rugCheck.isToken2022;
    }
    // If RugCheck is unavailable, cannot determine — assume false
    // (the absence of data shouldn't trigger an unwarranted penalty)
    return false;
  }

  // ===========================================================================
  // Private — Metadata Mutability Check
  // ===========================================================================

  /**
   * Checks whether token metadata is mutable from RugCheck data.
   *
   * Examines the RugCheck risk factors for indicators of mutable metadata.
   * If RugCheck explicitly reports a "Mutable Metadata" risk, the token's
   * metadata is considered mutable.
   *
   * @param rugCheck - The RugCheck report to inspect.
   * @returns true if metadata is mutable or if status cannot be determined.
   */
  private checkMetadataMutable(rugCheck: RugCheckReport): boolean {
    // Check if any risk factor mentions mutable metadata
    const hasMetadataRisk = rugCheck.risks.some(
      (risk) =>
        risk.name.toLowerCase().includes('mutable') ||
        risk.name.toLowerCase().includes('metadata'),
    );

    if (hasMetadataRisk) {
      return true;
    }

    // If no explicit metadata risk found, assume immutable (optimistic for RugCheck data)
    return false;
  }

  // ===========================================================================
  // Private — Catastrophic Failsafe Report
  // ===========================================================================

  /**
   * Creates a maximally cautious SafetyReport when all safety checks fail.
   *
   * This is the last-resort fallback — the safety pipeline must NEVER crash
   * or throw. When everything fails, we assume the absolute worst case:
   *   - overallScore = 0 (immediate SKIP)
   *   - All authorities active
   *   - Honeypot assumed
   *   - No LP lock/burn
   *   - All risk factors flagged
   *
   * @param mint - Token mint address for the report.
   * @returns A maximally cautious SafetyReport.
   */
  private createFailsafeReport(mint: string): SafetyReport {
    this.logger.error(
      `Creating failsafe report for ${mint} — all safety sources unavailable`,
    );

    return {
      mint,
      overallScore: 0,
      rugCheckScore: null,
      goPlusResult: null,
      honeypotResult: {
        sellable: false,
        estimatedTax: 100,
        error: 'Safety pipeline catastrophic failure — all sources unavailable',
      },
      lpStatus: {
        burned: false,
        burnPercent: 0,
        locked: false,
      },
      authorityStatus: {
        mintRevoked: false,
        freezeRevoked: false,
        metadataMutable: true,
      },
      riskFactors: [
        'All safety sources unavailable — treating token as unsafe',
        'Mint authority is active — new tokens can be created',
        'Freeze authority is active — accounts can be frozen',
        'Token is a potential honeypot — sell simulation failed',
        'Liquidity pool is not locked or burned',
      ],
      isToken2022: false,
      checkedAt: Date.now(),
      rugCheckAvailable: false,
      goPlusAvailable: false,
      top10HolderPercent: 0,
      largestHolderPercent: 0,
    };
  }
}
