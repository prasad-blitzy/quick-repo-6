/**
 * @file src/tracking/types.ts
 * @description Type definitions for the Smart Money Wallet Tracking module.
 *
 * This is the foundational type definitions file for the entire `src/tracking/` module.
 * It contains ZERO imports and ZERO runtime code — only pure TypeScript interfaces and
 * string literal union types.
 *
 * Consumers:
 * - `src/tracking/wallet-tracker.ts` — imports TrackedWallet, WalletClassification
 * - `src/tracking/convergence-detector.ts` — imports ConvergenceEvent, PositionSizeContext, TrackedWallet, WalletClassification
 * - `src/tracking/wallet-classifier.ts` — imports WalletClassification
 * - `src/signals/factors/smart-money-convergence.ts` — imports ConvergenceEvent for scoring
 * - `src/utils/messaging.ts` — may reference tracking types in message payload definitions
 * - `src/components/SmartMoneyIndicator.tsx` — imports types for UI display
 *
 * All timestamp fields use **Unix milliseconds** (i.e. `Date.now()` convention).
 */

// =============================================================================
// Wallet Classification
// =============================================================================

/**
 * Classification types for tracked wallets, based on GMGN's categorization system.
 *
 * GMGN classifies wallets into six categories, each carrying a different quality
 * weight for convergence scoring. "Smart Money" wallets (70%+ win rate) carry the
 * highest quality signal, while "Developer" wallets may indicate selling pressure.
 *
 * @see AAP Section 0.8.4 — GMGN wallet classification system
 */
export type WalletClassification =
  | 'smart_money'  // 70%+ win rate across trading history — highest quality signal
  | 'kol'          // Key Opinion Leader — influencer with significant following
  | 'whale'        // Large position holder — moves significant capital
  | 'sniper'       // First-block buyer — enters tokens very early, may be bot-driven
  | 'insider'      // Connected to project team — early access to information
  | 'developer';   // Token creator/deployer — may be associated with selling pressure

// =============================================================================
// Tracked Wallet
// =============================================================================

/**
 * Represents a wallet being tracked for smart money convergence detection.
 *
 * Tracked wallets are stored in `chrome.storage.local` for persistence across
 * service worker restarts. The wallet tracker monitors activity via intercepted
 * GMGN data and the Helius Enhanced Transactions API.
 *
 * @see AAP Section 0.5.1 Group 7 — wallet-tracker.ts
 */
export interface TrackedWallet {
  /** Solana wallet address (base58-encoded public key). */
  address: string;

  /** Classification type from GMGN's categorization system. */
  classification: WalletClassification;

  /**
   * Timestamp (Unix milliseconds) of the last known trading activity for
   * this wallet. Used to prune stale wallets and prioritize active ones.
   */
  lastActivity: number;

  /**
   * Running average of position sizes in USD (EMA-smoothed).
   * Used for conviction analysis in convergence detection — when a wallet
   * enters a position at or above 80% of this average, it signals conviction.
   */
  avgPositionSize: number;

  /**
   * Optional human-readable tag or label from GMGN data.
   * May contain a wallet name, ENS-like identifier, or platform-assigned alias.
   */
  tag?: string;

  /**
   * Historical win rate as a percentage (0–100) from GMGN data.
   * A win rate of 70 or above is the primary criterion for "smart_money"
   * classification.
   */
  winRate?: number;

  /**
   * Timestamp (Unix milliseconds) when this wallet was first added to the
   * tracked list. Used for retention analytics and display ordering.
   */
  addedAt: number;
}

// =============================================================================
// Convergence Wallet Entry
// =============================================================================

/**
 * Represents one smart money wallet's entry into a specific token within a
 * convergence event. Each entry captures the wallet's classification,
 * position size, and on-chain transaction reference.
 */
export interface ConvergenceWalletEntry {
  /** Solana wallet address (base58-encoded public key). */
  address: string;

  /** Wallet classification type at the time of entry. */
  classification: WalletClassification;

  /** Position size in USD for this specific token entry. */
  positionSize: number;

  /**
   * Timestamp (Unix milliseconds) when the wallet entered this token.
   * Used to order entries within the convergence window.
   */
  entryTimestamp: number;

  /**
   * Solana transaction signature (base58-encoded hash) for on-chain
   * verification. Optional because some entries may be inferred from
   * aggregated GMGN data rather than individual transactions.
   */
  txHash?: string;
}

// =============================================================================
// Convergence Event
// =============================================================================

/**
 * Fired when ≥3 qualified smart money wallets enter the same token within the
 * convergence detection window (default: 2 hours).
 *
 * Convergence events are the primary input to the smart-money-convergence
 * scoring factor. A higher `convictionScore` (wallets investing above 80%
 * of their historical average) amplifies the signal strength.
 *
 * @see AAP Section 0.1.1 — "Detect convergence signals when 3+ qualified
 *   smart money wallets enter the same token within a 2-hour window"
 * @see AAP Section 0.1.1 — "entries above 80% of historical average
 *   indicating conviction"
 */
export interface ConvergenceEvent {
  /** Solana token mint address where convergence was detected. */
  token: string;

  /** Array of wallet entries that contributed to the convergence signal. */
  wallets: ConvergenceWalletEntry[];

  /**
   * Timestamp (Unix milliseconds) of the earliest wallet entry in the
   * convergence window.
   */
  windowStart: number;

  /**
   * Timestamp (Unix milliseconds) of the most recent wallet entry in the
   * convergence window.
   */
  windowEnd: number;

  /**
   * Conviction score (0–100): percentage of participating wallets whose
   * entry position size is ≥80% of their historical average. A score of
   * 100 means every wallet invested at or above their typical level,
   * signaling strong conviction across the group.
   */
  convictionScore: number;

  /** Number of unique qualified wallets in the convergence (always ≥3). */
  walletCount: number;

  /**
   * Average quality weight of participating wallets. Higher values indicate
   * more reliable convergence (e.g., multiple "smart_money" wallets weigh
   * more than a mix of "sniper" and "developer" wallets). The quality weight
   * is derived from each wallet's classification in wallet-classifier.ts.
   */
  avgQualityWeight: number;
}

// =============================================================================
// Position Size Context
// =============================================================================

/**
 * Context for analyzing a wallet's position size relative to their historical
 * average. Used by the convergence detector to determine conviction.
 *
 * When `percentOfAvg` is ≥80, the wallet is investing at or above its
 * typical level, indicating conviction in the trade. Values above 100
 * mean the wallet is investing MORE than their average.
 *
 * @see AAP Section 0.1.1 — "position-size context analysis (entries above
 *   80% of historical average indicating conviction)"
 */
export interface PositionSizeContext {
  /** Current position size in USD for this specific trade. */
  currentSize: number;

  /** Historical average position size in USD (EMA-smoothed). */
  historicalAvg: number;

  /**
   * Current position as a percentage of historical average.
   * - 100 = investing exactly at average
   * - 120 = investing 20% MORE than average (strong conviction)
   * - 60  = investing 40% LESS than average (weak conviction)
   * - ≥80 is the threshold for "conviction" per AAP specification
   */
  percentOfAvg: number;
}

// =============================================================================
// Wallet Activity Event
// =============================================================================

/**
 * Represents a trading activity event from a tracked wallet. Used internally
 * by wallet-tracker.ts to notify convergence-detector.ts of new wallet
 * entries into tokens.
 *
 * Activity events are derived from intercepted GMGN data and Helius
 * Enhanced Transactions API responses.
 */
export interface WalletActivityEvent {
  /** Solana wallet address (base58-encoded) performing the trade action. */
  walletAddress: string;

  /** Solana token mint address involved in the trade. */
  tokenAddress: string;

  /** Trade direction: 'buy' for token acquisition, 'sell' for disposal. */
  action: 'buy' | 'sell';

  /** USD value of the trade at execution time. */
  amountUsd: number;

  /** Timestamp (Unix milliseconds) of the activity. */
  timestamp: number;

  /**
   * Solana transaction signature (base58-encoded hash). Optional because
   * some activity events may be derived from aggregated GMGN feed data
   * rather than individual on-chain transactions.
   */
  txHash?: string;

  /** Wallet classification at the time of this activity event. */
  classification: WalletClassification;
}

// =============================================================================
// Convergence Statistics
// =============================================================================

/**
 * Aggregate statistics from the convergence detector. Used for monitoring,
 * debugging, and displaying system health in the extension popup or
 * settings panel.
 */
export interface ConvergenceStats {
  /** Number of unique tokens currently being tracked for convergence. */
  tokenCount: number;

  /** Total number of wallet entries across all tracked tokens. */
  totalEntries: number;

  /**
   * Number of tokens that currently meet the convergence threshold
   * (≥3 qualified wallet entries within the detection window).
   */
  activeConvergences: number;
}
