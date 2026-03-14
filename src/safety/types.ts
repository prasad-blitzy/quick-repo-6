/**
 * @fileoverview Token Safety Type Definitions
 *
 * Foundational type definitions for the entire `src/safety/` module.
 * Every safety-related file imports types from this module.
 *
 * This file contains ONLY TypeScript interfaces and type aliases — no runtime
 * code, no imports, no external dependencies.
 *
 * Consumers:
 * - `src/safety/checker.ts`           → SafetyReport, HoneypotResult, LPStatus, AuthorityStatus
 * - `src/safety/honeypot-detector.ts` → HoneypotResult
 * - `src/safety/lp-analyzer.ts`       → LPStatus
 * - `src/signals/factors/safety-score.ts` → SafetyReport (safety factor scoring)
 * - `src/signals/hard-filters.ts`     → SafetyReport (hard filter evaluation)
 * - `src/utils/messaging.ts`          → Safety types for message typing
 * - `src/store/token-store.ts`        → SafetyReport (per-token storage)
 *
 * @module safety/types
 */

// ---------------------------------------------------------------------------
// HoneypotResult — Jupiter sell simulation result
// ---------------------------------------------------------------------------

/**
 * Result of a Jupiter-based sell simulation for honeypot detection.
 *
 * Per AAP Section 0.7.3:
 * - "Jupiter honeypot simulation is mandatory: Every new token must undergo
 *    a sell simulation via Jupiter's `/quote` endpoint before being scored."
 * - "Tokens that cannot be sold are classified as honeypots and filtered out."
 *
 * A valid Jupiter quote for TOKEN → SOL means the token is sellable (not a
 * honeypot). Failure, timeout, or error flags the token as potentially
 * dangerous.
 */
export interface HoneypotResult {
  /** Whether the token can be sold (swapped back to SOL via Jupiter). */
  sellable: boolean;

  /**
   * Estimated sell tax / fee percentage.
   *
   * - `0`   → No tax detected (normal slippage + DEX fees only).
   * - `100` → Cannot sell at all (complete honeypot).
   *
   * Thresholds for concern:
   * - 0–5%   Normal (slippage + DEX fees).
   * - 5–20%  Suspicious (may have built-in sell tax).
   * - 20–50% High risk (likely intentional sell restriction).
   * - 50–100% Critical (effectively a honeypot even if technically sellable).
   */
  estimatedTax: number;

  /**
   * Amount of SOL quoted for the sell simulation, expressed in lamports.
   * Present only when the simulation succeeded and a quote was returned.
   */
  quotedAmount?: number;

  /**
   * Price impact percentage from the sell simulation.
   * A value above 50% suggests extremely low liquidity or manipulation.
   */
  priceImpactPct?: number;

  /**
   * Error message if the sell simulation failed.
   * Examples: "No swap route found", "Jupiter API error", "Rate limited".
   */
  error?: string;

  /**
   * Whether the sell simulation timed out before completing.
   * Timeouts are treated as potential honeypot indicators (fail-safe).
   */
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// LPStatus — Liquidity Pool lock / burn status
// ---------------------------------------------------------------------------

/**
 * Liquidity Pool (LP) lock and burn status.
 *
 * Per AAP hard filters:
 * - "no LP lock/burn" → token is immediately classified as SKIP.
 *
 * LP burn address: `1nc1nerator11111111111111111111111111111111`
 *
 * LP tokens can be either *burned* (sent to the burn address, permanently
 * removing them from circulation) or *locked* (held in a time-lock contract,
 * preventing the deployer from pulling liquidity for a defined period).
 */
export interface LPStatus {
  /** Whether LP tokens have been burned (sent to burn address). */
  burned: boolean;

  /**
   * Percentage of LP tokens burned (0–100).
   *
   * A `burnPercent` above 90% is considered high-confidence burned.
   * Above 50% is considered burned (default threshold).
   */
  burnPercent: number;

  /** Whether LP tokens are locked in a time-lock contract. */
  locked: boolean;

  /** Lock duration in seconds (present only when `locked` is `true`). */
  lockDuration?: number;

  /** Lock expiration as a Unix timestamp in milliseconds (present only when `locked` is `true`). */
  lockExpiresAt?: number;
}

// ---------------------------------------------------------------------------
// AuthorityStatus — Token mint / freeze authority status
// ---------------------------------------------------------------------------

/**
 * Token authority (mint / freeze) status.
 *
 * Per AAP Section 0.1.1 – Entry prevention (hard filters):
 * - "active mint authority"   → SKIP  (if `mintRevoked` is `false`).
 * - "active freeze authority" → SKIP  (if `freezeRevoked` is `false`).
 *
 * A safe token should have both authorities revoked and metadata set to
 * immutable.
 */
export interface AuthorityStatus {
  /**
   * Whether the mint authority has been revoked.
   * - `true`  → Safe: no new tokens can be minted.
   * - `false` → Risky: deployer can inflate supply at will.
   */
  mintRevoked: boolean;

  /**
   * Whether the freeze authority has been revoked.
   * - `true`  → Safe: token accounts cannot be frozen.
   * - `false` → Risky: deployer can freeze user accounts.
   */
  freezeRevoked: boolean;

  /**
   * Whether the token metadata is mutable.
   * - `true`  → Risky: metadata (name, symbol, URI) can be changed post-launch.
   * - `false` → Safe: metadata is immutable.
   */
  metadataMutable: boolean;
}

// ---------------------------------------------------------------------------
// GoPlusSecuritySummary — Summarised GoPlus result
// ---------------------------------------------------------------------------

/**
 * Summarised GoPlus Security result for inclusion in {@link SafetyReport}.
 *
 * This is a lightweight summary extracted from the full `GoPlusResult`
 * defined in `src/api/types.ts`. It captures the security-relevant fields
 * from GoPlus's `/api/v1/solana/token_security` endpoint.
 */
export interface GoPlusSecuritySummary {
  /** Whether new tokens can be minted (risky if `true`). */
  isMintable: boolean;

  /** Whether token accounts can be frozen (risky if `true`). */
  isFreezable: boolean;

  /** Whether the token contract source is verified / open-source. */
  isOpenSource: boolean;

  /** Total number of token holders reported by GoPlus. */
  holderCount: number;

  /**
   * Sum of top 10 holder percentages.
   * Per AAP hard filter: top 10 holders > 50% → SKIP.
   */
  top10HolderPercent: number;

  /**
   * Largest single holder percentage.
   * Per AAP: single holder > 20% triggers a penalty in the safety score.
   */
  largestHolderPercent: number;

  /** Whether LP is locked according to GoPlus data. */
  isLpLocked: boolean;

  /** Creator / deployer wallet address. */
  creatorAddress: string;
}

// ---------------------------------------------------------------------------
// SafetyReport — Unified safety assessment
// ---------------------------------------------------------------------------

/**
 * Unified safety report produced by the multi-source safety checker.
 *
 * This is the primary output type of `src/safety/checker.ts`. It aggregates
 * results from RugCheck, GoPlus, Jupiter honeypot simulation, and LP
 * analysis into a single assessment object.
 *
 * Scoring (0–1000 scale):
 * - `overallScore` ≥ 300 → "safe" per AAP Section 0.7.3.
 *
 * Hard filter thresholds (AAP Section 0.7.3):
 * - Top 10 holders > 50% → SKIP.
 * - Liquidity < $3 000    → SKIP.
 * - No LP lock / burn     → SKIP.
 * - Active mint authority  → SKIP.
 * - Active freeze authority → SKIP.
 */
export interface SafetyReport {
  /** Token mint address that was analysed. */
  mint: string;

  /**
   * Overall composite safety score on a 0–1000 scale.
   * A score ≥ 300 is considered "safe" per AAP Section 0.7.3.
   */
  overallScore: number;

  /**
   * Raw RugCheck safety score (if the RugCheck API returned data).
   * `null` when RugCheck was unavailable or returned an error.
   */
  rugCheckScore: number | null;

  /**
   * Parsed GoPlus security result (if GoPlus data was available).
   * `null` when GoPlus was unavailable or returned an error.
   */
  goPlusResult: GoPlusSecuritySummary | null;

  /**
   * Jupiter sell simulation result — **MANDATORY** per AAP.
   *
   * Every new token must undergo a sell simulation before being scored.
   * This field is always present (non-optional).
   */
  honeypotResult: HoneypotResult;

  /** LP lock / burn status. */
  lpStatus: LPStatus;

  /** Mint and freeze authority status. */
  authorityStatus: AuthorityStatus;

  /**
   * Human-readable risk factors detected during the safety check.
   *
   * Examples:
   * - "Mint authority is active — new tokens can be created"
   * - "Token is a potential honeypot — sell simulation failed"
   * - "Top 10 holders control > 50% of supply"
   */
  riskFactors: string[];

  /**
   * Whether the token uses Token-2022 extensions.
   *
   * Per AAP Section 0.1.1: "Modern Solana tokens using Token-2022 may have
   * `PermanentDelegate` and `DefaultAccountState: frozen` extensions that
   * introduce novel rug vectors not caught by standard checks."
   */
  isToken2022: boolean;

  /** Unix timestamp (milliseconds) when this safety check was performed. */
  checkedAt: number;

  /** Whether RugCheck data was successfully retrieved for this report. */
  rugCheckAvailable: boolean;

  /** Whether GoPlus data was successfully retrieved for this report. */
  goPlusAvailable: boolean;

  /**
   * Top-10 holder concentration percentage (0–100).
   * Per AAP hard filter: > 50% → SKIP.
   */
  top10HolderPercent: number;

  /**
   * Largest single holder percentage (0–100).
   * Per AAP: > 20% triggers a penalty in the safety score.
   */
  largestHolderPercent: number;
}

// ---------------------------------------------------------------------------
// SafetyCheckStatus — Safety check lifecycle status
// ---------------------------------------------------------------------------

/**
 * Represents the lifecycle status of a safety check operation.
 *
 * Used by the UI and store layers to display progress indicators and
 * handle partial-result scenarios when one or more safety sources fail.
 *
 * - `'pending'`   — Safety check not yet started.
 * - `'checking'`  — Safety check in progress.
 * - `'completed'` — Safety check finished successfully with all sources.
 * - `'partial'`   — Some sources failed but partial results are available.
 * - `'failed'`    — All safety sources failed; no usable data.
 */
export type SafetyCheckStatus =
  | 'pending'
  | 'checking'
  | 'completed'
  | 'partial'
  | 'failed';

// ---------------------------------------------------------------------------
// SafetyRiskLevel — Risk classification
// ---------------------------------------------------------------------------

/**
 * Risk-level classification derived from the overall safety score and
 * individual check results.
 *
 * Used by `SafetyBadge.tsx` for colour coding:
 * - `'safe'`     → Green  (score ≥ 300, authorities revoked, LP burned/locked).
 * - `'moderate'` → Yellow (some concerns but no critical risks).
 * - `'risky'`    → Orange (multiple risk factors, failed some checks).
 * - `'critical'` → Red    (hard-filter failures, honeypot, active authorities).
 */
export type SafetyRiskLevel =
  | 'safe'
  | 'moderate'
  | 'risky'
  | 'critical';
