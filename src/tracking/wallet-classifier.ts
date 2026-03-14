/**
 * @file src/tracking/wallet-classifier.ts
 * @description Wallet classification module using GMGN's categorization data.
 *
 * Classifies wallets into six categories based on GMGN's classification system:
 * - Smart Money (70%+ win rate) — highest reliability for convergence signals
 * - KOL (Key Opinion Leader) — influencer with significant following
 * - Whale — large position holder, significant capital impact
 * - Sniper — first-block buyer, may be bot-driven
 * - Insider — connected to project team, early access
 * - Developer — token creator/deployer, often associated with selling pressure
 *
 * Assigns quality weights used by convergence-detector.ts for weighted
 * convergence scoring. Higher weights indicate more reliable trade signals.
 *
 * Data Flow:
 *   GMGN smart money signals → wallet-classifier.ts → TrackedWallet with classification
 *   → convergence-detector.ts (uses quality weights)
 *
 * Consumers:
 * - src/tracking/wallet-tracker.ts — uses classifier for wallet classification
 * - src/tracking/convergence-detector.ts — uses quality weights for convergence scoring
 * - src/components/SmartMoneyIndicator.tsx — uses labels and emojis for display
 *
 * @see AAP Section 0.5.1 Group 7
 * @see AAP Section 0.8.4 — GMGN wallet classification system
 * @module tracking/wallet-classifier
 */

import type { WalletClassification } from './types';
import type { GmgnSmartMoneySignal } from '../gmgn/types';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Module-scoped structured logger with 'wallet-classifier' context tag.
 * Used for logging batch classification operations and debug information
 * during wallet classification processing.
 */
const log = createLogger('wallet-classifier');

// =============================================================================
// Quality Weight Constants
// =============================================================================

/**
 * Quality weights for each wallet classification type.
 *
 * Higher weight = more reliable signal for convergence detection.
 * These weights are used in convergence-detector.ts to compute the weighted
 * convergence score when evaluating whether multiple wallets entering the
 * same token constitutes a meaningful convergence signal.
 *
 * Weight rationale:
 * - smart_money (1.0): 70%+ win rate — proven track record, highest reliability
 * - insider (0.9): Connected to project team — very reliable but rare signals
 * - whale (0.8): Large positions — significant market impact and conviction
 * - kol (0.7): Key Opinion Leaders — influencer effect, somewhat reliable
 * - sniper (0.5): First-block buyer — early signal but may be bot-driven
 * - developer (0.3): Token creator/deployer — often associated with selling
 *
 * @see AAP Section 0.8.4: "GMGN classifies wallets into: Smart Money (70%+ win rate),
 *   KOL, Whale, Sniper, Insider, Developer"
 */
export const CLASSIFICATION_QUALITY_WEIGHTS: Record<WalletClassification, number> = {
  smart_money: 1.0,
  insider: 0.9,
  whale: 0.8,
  kol: 0.7,
  sniper: 0.5,
  developer: 0.3,
};

// =============================================================================
// Classification Criteria Constants
// =============================================================================

/**
 * Numeric thresholds used for metric-based wallet classification when GMGN
 * does not provide an explicit wallet type label (i.e., walletType === 'unknown').
 *
 * These criteria serve as heuristic fallbacks — GMGN's own classification
 * should always be preferred when available.
 *
 * - SMART_MONEY_MIN_WIN_RATE (70): 70%+ win rate is the defining criterion
 *   for Smart Money classification per the AAP specification
 * - WHALE_MIN_POSITION_USD (50000): $50K+ average position size indicates whale
 * - SNIPER_MAX_ENTRY_BLOCK_OFFSET (3): Entered within 3 blocks of token creation
 * - KOL_MIN_FOLLOWERS (1000): Minimum social following (when data is available)
 */
export const CLASSIFICATION_CRITERIA = {
  /** 70%+ win rate across trading history qualifies as Smart Money */
  SMART_MONEY_MIN_WIN_RATE: 70,
  /** $50K+ average position size qualifies as Whale */
  WHALE_MIN_POSITION_USD: 50000,
  /** Entered within 3 blocks of token creation qualifies as Sniper */
  SNIPER_MAX_ENTRY_BLOCK_OFFSET: 3,
  /** Minimum social following to qualify as KOL (when data available) */
  KOL_MIN_FOLLOWERS: 1000,
} as const;

// =============================================================================
// Primary Classification: GMGN Data
// =============================================================================

/**
 * Classifies a wallet from GMGN smart money signal data.
 *
 * This is the PRIMARY classification method. When GMGN provides a direct
 * wallet type label (smart_money, kol, whale, sniper, insider, developer),
 * that label is trusted and mapped directly to our internal WalletClassification.
 *
 * When GMGN's label is 'unknown' or unrecognized, falls back to metric-based
 * classification using the wallet's win rate, PnL, and average hold time.
 *
 * @param signal - GMGN smart money signal containing walletType, winRate, pnl,
 *   and avgHoldTime fields
 * @returns The wallet classification category
 *
 * @example
 * ```typescript
 * const classification = classifyFromGmgn({
 *   walletAddress: 'ABC123...',
 *   walletType: 'smart_money',
 *   winRate: 85,
 *   pnl: 150000,
 *   avgHoldTime: 7200,
 *   // ... other fields
 * });
 * // Returns: 'smart_money'
 * ```
 *
 * @example
 * ```typescript
 * // Unknown walletType falls back to metrics
 * const classification = classifyFromGmgn({
 *   walletAddress: 'DEF456...',
 *   walletType: 'unknown',
 *   winRate: 75,
 *   pnl: 50000,
 *   avgHoldTime: 3600,
 *   // ... other fields
 * });
 * // Returns: 'smart_money' (75% win rate > 70% threshold, positive PnL)
 * ```
 */
export function classifyFromGmgn(signal: GmgnSmartMoneySignal): WalletClassification {
  const gmgnType = signal.walletType;

  // Map GMGN's wallet type directly to our internal classification.
  // GMGN classification is authoritative — trust it when provided.
  switch (gmgnType) {
    case 'smart_money':
      return 'smart_money';
    case 'kol':
      return 'kol';
    case 'whale':
      return 'whale';
    case 'sniper':
      return 'sniper';
    case 'insider':
      return 'insider';
    case 'developer':
      return 'developer';
    case 'unknown':
    default:
      // Fallback: classify based on numerical metrics when GMGN
      // does not provide a definitive wallet type label
      return classifyFromMetrics(signal.winRate, signal.pnl, signal.avgHoldTime);
  }
}

// =============================================================================
// Fallback Classification: Numerical Metrics
// =============================================================================

/**
 * Classifies a wallet based on numerical trading metrics as a fallback
 * when GMGN does not provide an explicit wallet type label.
 *
 * The classification heuristic applies rules in priority order:
 * 1. Smart Money: win rate ≥70% AND positive PnL (proven profitable trader)
 * 2. Whale: absolute PnL ≥$100K (implies very large position sizes)
 * 3. Sniper: average hold time <600s (10 minutes — very short, likely bot)
 * 4. KOL: win rate ≥50% AND PnL >$10K (moderately successful, visible)
 * 5. Default: sniper (conservative fallback — lowest weight after developer)
 *
 * These are approximate heuristics. GMGN's own classification should always
 * be preferred when available via classifyFromGmgn().
 *
 * @param winRate - Historical win rate percentage (0–100)
 * @param pnl - Total profit and loss in USD (positive = profit)
 * @param avgHoldTime - Average trade hold time in seconds
 * @returns The wallet classification category
 *
 * @example
 * ```typescript
 * classifyFromMetrics(80, 50000, 3600);  // → 'smart_money' (high win rate)
 * classifyFromMetrics(40, 200000, 7200); // → 'whale' ($200K PnL)
 * classifyFromMetrics(30, 500, 120);     // → 'sniper' (short hold time)
 * classifyFromMetrics(55, 15000, 3600);  // → 'kol' (moderate success)
 * classifyFromMetrics(20, 100, 1800);    // → 'sniper' (default fallback)
 * ```
 */
export function classifyFromMetrics(
  winRate: number,
  pnl: number,
  avgHoldTime: number,
): WalletClassification {
  // Priority 1: Smart Money — high win rate (≥70%) AND profitable
  // This is the defining criterion per AAP: "Smart Money (70%+ win rate)"
  if (winRate >= CLASSIFICATION_CRITERIA.SMART_MONEY_MIN_WIN_RATE && pnl > 0) {
    return 'smart_money';
  }

  // Priority 2: Whale — very large total PnL implies large position sizes
  // Uses absolute value so both highly profitable and heavily losing
  // large traders are classified as whales based on capital deployed
  if (Math.abs(pnl) >= 100000) {
    return 'whale';
  }

  // Priority 3: Sniper — very short average hold time indicates
  // first-block or early-block buying behavior (< 10 minutes = 600 seconds)
  // Must have positive avgHoldTime to avoid classifying wallets with no data
  if (avgHoldTime > 0 && avgHoldTime < 600) {
    return 'sniper';
  }

  // Priority 4: KOL — moderate win rate (≥50%) and meaningful profit (>$10K)
  // Not enough data to classify as smart money, but shows consistent success
  if (winRate >= 50 && pnl > 10000) {
    return 'kol';
  }

  // Default: classify as sniper — conservative fallback choice.
  // Snipers have a quality weight of 0.5, which is the second-lowest after
  // developers (0.3). This prevents unknown wallets from inflating
  // convergence scores with high-weight classifications.
  return 'sniper';
}

// =============================================================================
// Quality Weight Lookup
// =============================================================================

/**
 * Returns the numeric quality weight for a given wallet classification.
 *
 * Quality weights are used by convergence-detector.ts to compute weighted
 * convergence scores. Higher weights indicate more reliable trade signals:
 * - smart_money: 1.0 (highest)
 * - insider: 0.9
 * - whale: 0.8
 * - kol: 0.7
 * - sniper: 0.5
 * - developer: 0.3 (lowest)
 *
 * Defaults to 0.3 (developer-level) for any unrecognized classification
 * to prevent false convergence signals from unknown wallet types.
 *
 * @param classification - The wallet classification category
 * @returns Numeric quality weight between 0 and 1
 *
 * @example
 * ```typescript
 * getQualityWeight('smart_money'); // → 1.0
 * getQualityWeight('developer');   // → 0.3
 * ```
 */
export function getQualityWeight(classification: WalletClassification): number {
  return CLASSIFICATION_QUALITY_WEIGHTS[classification] ?? 0.3;
}

// =============================================================================
// Convergence Qualification Check
// =============================================================================

/**
 * Determines whether a wallet classification qualifies for convergence detection.
 *
 * Only wallets with a quality weight at or above the minimum threshold are
 * considered "qualified" for convergence signals. By default, the threshold
 * is 0.5, which means:
 * - Qualified: smart_money (1.0), insider (0.9), whale (0.8), kol (0.7), sniper (0.5)
 * - NOT qualified: developer (0.3) — developers often sell, not accumulate
 *
 * The threshold can be raised to be more selective (e.g., 0.8 for only
 * smart_money, insider, and whale) or lowered to include developers.
 *
 * @param classification - The wallet classification category
 * @param minWeight - Minimum quality weight threshold (default: 0.5)
 * @returns true if the wallet's quality weight meets or exceeds the threshold
 *
 * @example
 * ```typescript
 * isQualifiedForConvergence('smart_money');           // → true (1.0 >= 0.5)
 * isQualifiedForConvergence('developer');             // → false (0.3 < 0.5)
 * isQualifiedForConvergence('developer', 0.2);       // → true (0.3 >= 0.2)
 * isQualifiedForConvergence('kol', 0.8);             // → false (0.7 < 0.8)
 * ```
 */
export function isQualifiedForConvergence(
  classification: WalletClassification,
  minWeight: number = 0.5,
): boolean {
  return getQualityWeight(classification) >= minWeight;
}

// =============================================================================
// Display Helpers
// =============================================================================

/**
 * Returns a human-readable display label for a wallet classification.
 *
 * Used by UI components (e.g., SmartMoneyIndicator.tsx) to render
 * wallet classification in a user-friendly format.
 *
 * @param classification - The wallet classification category
 * @returns Human-readable label string
 *
 * @example
 * ```typescript
 * getClassificationLabel('smart_money'); // → 'Smart Money'
 * getClassificationLabel('kol');         // → 'KOL'
 * getClassificationLabel('whale');       // → 'Whale'
 * ```
 */
export function getClassificationLabel(classification: WalletClassification): string {
  const labels: Record<WalletClassification, string> = {
    smart_money: 'Smart Money',
    kol: 'KOL',
    whale: 'Whale',
    sniper: 'Sniper',
    insider: 'Insider',
    developer: 'Developer',
  };
  return labels[classification] ?? 'Unknown';
}

/**
 * Returns a compact emoji representation for a wallet classification.
 *
 * Used in UI components for space-constrained display contexts where a
 * full text label would be too wide (e.g., token card wallet indicators).
 *
 * Emoji mapping:
 * - 🧠 Smart Money — brain symbolizes intelligence/strategy
 * - 📣 KOL — megaphone for influence/visibility
 * - 🐋 Whale — whale for large capital
 * - 🎯 Sniper — target for precision timing
 * - 🔑 Insider — key for access/connection
 * - 👨‍💻 Developer — technologist for code/creation
 *
 * @param classification - The wallet classification category
 * @returns Emoji string for the classification
 *
 * @example
 * ```typescript
 * getClassificationEmoji('smart_money'); // → '🧠'
 * getClassificationEmoji('whale');       // → '🐋'
 * ```
 */
export function getClassificationEmoji(classification: WalletClassification): string {
  const emojis: Record<WalletClassification, string> = {
    smart_money: '🧠',
    kol: '📣',
    whale: '🐋',
    sniper: '🎯',
    insider: '🔑',
    developer: '👨‍💻',
  };
  return emojis[classification] ?? '❓';
}

// =============================================================================
// Batch Classification
// =============================================================================

/**
 * Classifies multiple wallets at once from an array of GMGN smart money signals.
 *
 * Returns a Map of wallet address → classification. If the same wallet appears
 * multiple times in the signals array, the classification from the LAST occurrence
 * is used (most recent signal is considered the most up-to-date classification).
 *
 * This function is optimized for processing batches of wallet signals received
 * from GMGN's smart money endpoints. It logs the batch size and result count
 * for operational monitoring.
 *
 * @param signals - Array of GMGN smart money signals to classify
 * @returns Map of wallet address (string) → WalletClassification
 *
 * @example
 * ```typescript
 * const signals: GmgnSmartMoneySignal[] = [
 *   { walletAddress: 'ABC', walletType: 'smart_money', winRate: 85, ... },
 *   { walletAddress: 'DEF', walletType: 'whale', winRate: 40, ... },
 *   { walletAddress: 'ABC', walletType: 'kol', winRate: 60, ... },
 * ];
 * const result = classifyBatch(signals);
 * // result.get('ABC') → 'kol' (last occurrence wins)
 * // result.get('DEF') → 'whale'
 * // result.size → 2 (unique wallets)
 * ```
 */
export function classifyBatch(
  signals: GmgnSmartMoneySignal[],
): Map<string, WalletClassification> {
  const classifications = new Map<string, WalletClassification>();

  for (const signal of signals) {
    const walletAddress = signal.walletAddress;

    // Skip signals with empty or missing wallet addresses
    if (!walletAddress) {
      continue;
    }

    const classification = classifyFromGmgn(signal);
    classifications.set(walletAddress, classification);
  }

  log.info(
    `Classified ${classifications.size} wallets from GMGN data`,
    { inputCount: signals.length, uniqueWallets: classifications.size },
  );

  return classifications;
}
