/**
 * src/tracking/convergence-detector.ts — Time-Windowed Smart Money Convergence Detection
 *
 * Maintains a sliding window (default 2 hours) of smart wallet entries per token
 * and fires a ConvergenceEvent when ≥3 qualified wallets enter the same token
 * within the configurable window. Tracks position sizes for conviction analysis
 * — entries above 80% of historical average indicate conviction.
 *
 * Data Flow:
 *   GMGN wallet activity / smart money signals
 *     → wallet-tracker.ts
 *       → convergence-detector.ts
 *         → smart-money-convergence.ts (signal factor)
 *
 * Consumers:
 * - src/signals/factors/smart-money-convergence.ts — queries for active convergence events
 * - entrypoints/background.ts — initializes and triggers convergence checks
 *
 * Per AAP Section 0.1.1:
 *   "Detect convergence signals when 3+ qualified smart money wallets enter
 *    the same token within a 2-hour window, with position-size context analysis
 *    (entries above 80% of historical average indicating conviction)"
 *
 * Per AAP Section 0.4.3 (Signal Pipeline Integration):
 *   "src/signals/factors/smart-money-convergence.ts ← src/tracking/convergence-detector.ts:
 *    Receives convergence events when 3+ qualified wallets enter the same token
 *    within the time window"
 *
 * @module tracking/convergence-detector
 */

import type {
  TrackedWallet,
  WalletClassification,
  ConvergenceEvent,
  PositionSizeContext,
  ConvergenceStats,
} from './types';
import { createLogger } from '../utils/logger';
import { SMART_MONEY_CONFIG } from '../utils/config';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Module-scoped structured logger with 'convergence-detector' context tag.
 * Provides debug/info/warn/error methods with formatted timestamps and context.
 */
const logger = createLogger('convergence-detector');

// ---------------------------------------------------------------------------
// Quality Weights
// ---------------------------------------------------------------------------

/**
 * Classification-based quality weights for convergence scoring.
 *
 * Each wallet classification carries a different quality weight that reflects
 * signal reliability. Smart Money wallets (70%+ win rate) are the highest
 * quality, while Developer wallets may indicate selling pressure and carry
 * the lowest weight.
 *
 * Wallets with a quality weight below 0.5 are not counted as "qualified"
 * for convergence detection purposes.
 *
 * @see AAP Section 0.5.1 Group 7 — wallet-classifier.ts classification system
 */
export const QUALITY_WEIGHTS: Record<WalletClassification, number> = {
  /** Highest quality — 70%+ win rate across trading history */
  smart_money: 1.0,
  /** Key Opinion Leaders — influencers with significant following */
  kol: 0.7,
  /** Large position holders — moves significant capital */
  whale: 0.8,
  /** First-block buyers — may be bot-driven, less reliable signal */
  sniper: 0.5,
  /** Connected to project team — early access to information */
  insider: 0.9,
  /** Token creator/deployer — may be associated with selling pressure */
  developer: 0.3,
};

/**
 * Minimum quality weight threshold for a wallet to be considered "qualified"
 * for convergence detection. Wallets below this threshold are stored but
 * do not count toward the minimum wallet requirement.
 */
const MIN_QUALITY_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Internal Data Structures
// ---------------------------------------------------------------------------

/**
 * Internal representation of a single wallet entry into a token within the
 * convergence detection sliding window. Extends the output ConvergenceWalletEntry
 * with additional fields needed for conviction analysis and quality weighting.
 *
 * @internal Not exported — used only within the ConvergenceDetector class.
 */
interface WalletEntry {
  /** Solana wallet address (base58-encoded public key). */
  walletAddress: string;

  /** Classification type from GMGN's categorization system. */
  classification: WalletClassification;

  /** Timestamp (Unix milliseconds) when the wallet entered this token. */
  timestamp: number;

  /** USD value of the position taken in this specific entry. */
  positionSize: number;

  /** Historical average position size in USD for this wallet (EMA-smoothed). */
  historicalAvgSize: number;

  /** Solana transaction signature for on-chain verification. */
  txHash: string;

  /** Computed quality weight based on wallet classification. */
  qualityWeight: number;
}

// ---------------------------------------------------------------------------
// ConvergenceDetector Class
// ---------------------------------------------------------------------------

/**
 * Time-windowed smart money convergence detector.
 *
 * Tracks wallet entries into tokens over a configurable sliding window and
 * detects convergence patterns — when multiple qualified smart money wallets
 * enter the same token within the window. Supports conviction analysis based
 * on position sizes relative to historical averages.
 *
 * Design principles:
 * - Memory-bounded: sliding window pruning removes expired entries automatically
 * - Service worker compatible: no setInterval/setTimeout usage, cleanup is
 *   triggered externally via chrome.alarms
 * - Thread-safe: service worker is single-threaded, no concurrency concerns
 * - Event-driven: convergence events are dispatched via registered callbacks
 *
 * @example
 * ```typescript
 * const detector = new ConvergenceDetector();
 *
 * detector.onConvergence((event) => {
 *   console.log(`Convergence: ${event.walletCount} wallets entered ${event.token}`);
 * });
 *
 * detector.recordEntry('TokenMintAddress', {
 *   walletAddress: 'WalletAddr1',
 *   classification: 'smart_money',
 *   timestamp: Date.now(),
 *   positionSize: 5000,
 *   historicalAvgSize: 4000,
 *   txHash: 'TxHash123',
 * });
 * ```
 */
export class ConvergenceDetector {
  /**
   * Map of token mint address → array of wallet entries within the sliding window.
   * Entries are pruned lazily on access and periodically via cleanup().
   */
  private tokenEntries: Map<string, WalletEntry[]>;

  /**
   * Registered callback functions invoked when a convergence event is detected.
   * Callbacks receive a fully-constructed ConvergenceEvent object.
   */
  private convergenceCallbacks: Array<(event: ConvergenceEvent) => void>;

  /**
   * Sliding window duration in milliseconds. Entries older than this relative
   * to the current time are considered expired and pruned.
   * Default: 2 hours (from SMART_MONEY_CONFIG.CONVERGENCE_WINDOW_MS).
   */
  private windowMs: number;

  /**
   * Minimum number of unique qualified wallets required within the window
   * to trigger a convergence event.
   * Default: 3 (from SMART_MONEY_CONFIG.MIN_CONVERGENCE_WALLETS).
   */
  private minWallets: number;

  /**
   * Conviction threshold as a percentage (0–100). Wallets whose position
   * size is at or above this percentage of their historical average are
   * considered to be showing "conviction" in their trade.
   * Default: 80 (from SMART_MONEY_CONFIG.CONVICTION_THRESHOLD_PERCENT).
   */
  private convictionThreshold: number;

  /**
   * Creates a new ConvergenceDetector instance.
   *
   * Constructor reads defaults from SMART_MONEY_CONFIG but allows overrides
   * for testing and user configuration via the settings store.
   *
   * @param options - Optional configuration overrides
   * @param options.windowMs - Sliding window duration in ms (default: 2 hours)
   * @param options.minWallets - Minimum qualified wallets for convergence (default: 3)
   * @param options.convictionThreshold - Conviction threshold percentage (default: 80)
   */
  constructor(options?: {
    windowMs?: number;
    minWallets?: number;
    convictionThreshold?: number;
  }) {
    this.tokenEntries = new Map();
    this.convergenceCallbacks = [];
    this.windowMs = options?.windowMs ?? SMART_MONEY_CONFIG.CONVERGENCE_WINDOW_MS;
    this.minWallets = options?.minWallets ?? SMART_MONEY_CONFIG.MIN_CONVERGENCE_WALLETS;
    this.convictionThreshold =
      options?.convictionThreshold ?? SMART_MONEY_CONFIG.CONVICTION_THRESHOLD_PERCENT;

    logger.debug('ConvergenceDetector initialized', {
      windowMs: this.windowMs,
      minWallets: this.minWallets,
      convictionThreshold: this.convictionThreshold,
    });
  }

  // -------------------------------------------------------------------------
  // Core Entry Recording
  // -------------------------------------------------------------------------

  /**
   * Records a wallet's entry into a token within the convergence window.
   *
   * Automatically computes the quality weight based on wallet classification,
   * prunes expired entries for the token, and checks whether the convergence
   * threshold has been met. If convergence is detected, all registered
   * callbacks are invoked with the ConvergenceEvent.
   *
   * CRITICAL:
   * - Only UNIQUE wallets are counted — same wallet buying twice = 1 wallet
   * - Only "qualified" wallets count — quality weight must be ≥ 0.5
   *
   * @param tokenAddress - Solana token mint address
   * @param entry - Wallet entry data (quality weight is computed automatically)
   */
  recordEntry(
    tokenAddress: string,
    entry: Omit<WalletEntry, 'qualityWeight'>,
  ): void {
    // Compute quality weight from wallet classification
    const qualityWeight: number =
      QUALITY_WEIGHTS[entry.classification] ?? 0;

    const fullEntry: WalletEntry = {
      ...entry,
      qualityWeight,
    };

    // Retrieve or create the entry list for this token
    let entries = this.tokenEntries.get(tokenAddress);
    if (!entries) {
      entries = [];
      this.tokenEntries.set(tokenAddress, entries);
    }

    // Add the new entry
    entries.push(fullEntry);

    // Prune expired entries outside the sliding window
    this.pruneExpired(tokenAddress);

    // Count unique qualified wallets for logging
    const uniqueCount = this.countUniqueQualified(tokenAddress);

    logger.info(
      `Wallet ${entry.walletAddress} entered ${tokenAddress}, ` +
        `${uniqueCount} unique qualified wallet(s) in window`,
    );

    // Check if convergence threshold is now met
    this.checkConvergence(tokenAddress);
  }

  // -------------------------------------------------------------------------
  // Sliding Window Pruning
  // -------------------------------------------------------------------------

  /**
   * Removes all entries for a token that fall outside the current sliding window.
   * If no entries remain after pruning, the token is removed from the Map
   * entirely to keep memory usage bounded.
   *
   * @param tokenAddress - Solana token mint address to prune
   */
  private pruneExpired(tokenAddress: string): void {
    const entries = this.tokenEntries.get(tokenAddress);
    if (!entries) {
      return;
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Filter to keep only entries within the window
    const remaining = entries.filter(
      (entry) => entry.timestamp > cutoff,
    );

    if (remaining.length === 0) {
      // No entries remain — remove the token from tracking
      this.tokenEntries.delete(tokenAddress);
      logger.debug(
        `All entries expired for ${tokenAddress}, removed from tracking`,
      );
    } else if (remaining.length < entries.length) {
      // Some entries were pruned
      const prunedCount = entries.length - remaining.length;
      this.tokenEntries.set(tokenAddress, remaining);
      logger.debug(
        `Pruned ${prunedCount} expired entries for ${tokenAddress}, ` +
          `${remaining.length} remaining`,
      );
    }
    // If remaining.length === entries.length, nothing changed — no update needed
  }

  // -------------------------------------------------------------------------
  // Unique Qualified Wallet Counting
  // -------------------------------------------------------------------------

  /**
   * Counts the number of unique qualified wallets currently in the window
   * for a given token. A wallet is "qualified" if its classification quality
   * weight is at least MIN_QUALITY_WEIGHT (0.5).
   *
   * Same wallet appearing multiple times counts as 1.
   *
   * @param tokenAddress - Solana token mint address
   * @returns Number of unique qualified wallets
   */
  private countUniqueQualified(tokenAddress: string): number {
    const entries = this.tokenEntries.get(tokenAddress);
    if (!entries || entries.length === 0) {
      return 0;
    }

    const uniqueWallets = new Set<string>();
    for (const entry of entries) {
      if (entry.qualityWeight >= MIN_QUALITY_WEIGHT) {
        uniqueWallets.add(entry.walletAddress);
      }
    }
    return uniqueWallets.size;
  }

  /**
   * Returns deduplicated qualified entries for a token. For each unique
   * qualified wallet, only the most recent entry is retained.
   *
   * @param tokenAddress - Solana token mint address
   * @returns Array of deduplicated WalletEntry objects for qualified wallets
   */
  private getUniqueQualifiedEntries(tokenAddress: string): WalletEntry[] {
    const entries = this.tokenEntries.get(tokenAddress);
    if (!entries || entries.length === 0) {
      return [];
    }

    // Build a map of walletAddress → most recent entry (for qualified wallets only)
    const latestByWallet = new Map<string, WalletEntry>();
    for (const entry of entries) {
      if (entry.qualityWeight < MIN_QUALITY_WEIGHT) {
        continue;
      }
      const existing = latestByWallet.get(entry.walletAddress);
      if (!existing || entry.timestamp > existing.timestamp) {
        latestByWallet.set(entry.walletAddress, entry);
      }
    }

    return Array.from(latestByWallet.values());
  }

  // -------------------------------------------------------------------------
  // Convergence Check and Event Emission
  // -------------------------------------------------------------------------

  /**
   * Checks whether the convergence threshold is met for a token and emits
   * a ConvergenceEvent to all registered callbacks if so.
   *
   * Convergence is triggered when:
   * 1. The number of unique qualified wallets ≥ minWallets (default 3)
   * 2. Wallets are within the sliding time window
   *
   * The conviction score measures what percentage of participating wallets
   * are investing at or above their historical average position size.
   *
   * @param tokenAddress - Solana token mint address to check
   */
  private checkConvergence(tokenAddress: string): void {
    const uniqueEntries = this.getUniqueQualifiedEntries(tokenAddress);

    if (uniqueEntries.length < this.minWallets) {
      return;
    }

    // Build the convergence event
    const event = this.buildConvergenceEvent(tokenAddress, uniqueEntries);

    logger.info(
      `CONVERGENCE DETECTED: ${event.walletCount} wallets entered ${tokenAddress} ` +
        `in ${(this.windowMs / (60 * 60 * 1000)).toFixed(1)}h window, ` +
        `conviction: ${event.convictionScore.toFixed(1)}%`,
    );

    // Emit to all registered callbacks
    this.emitConvergence(event);
  }

  /**
   * Constructs a ConvergenceEvent from the provided unique qualified entries.
   *
   * Computes:
   * - convictionScore: percentage of wallets investing at ≥ convictionThreshold%
   *   of their historical average
   * - avgQualityWeight: mean quality weight across participating wallets
   * - windowStart/windowEnd: earliest and latest entry timestamps
   *
   * @param tokenAddress - Solana token mint address
   * @param uniqueEntries - Deduplicated qualified wallet entries
   * @returns Fully populated ConvergenceEvent
   */
  private buildConvergenceEvent(
    tokenAddress: string,
    uniqueEntries: WalletEntry[],
  ): ConvergenceEvent {
    // Calculate conviction score
    let walletsWithConviction = 0;
    for (const entry of uniqueEntries) {
      if (entry.historicalAvgSize > 0) {
        const percentOfAvg =
          (entry.positionSize / entry.historicalAvgSize) * 100;
        if (percentOfAvg >= this.convictionThreshold) {
          walletsWithConviction++;
        }
      } else {
        // If no historical data, we cannot assess conviction — treated as neutral
        // Do not count as conviction
      }
    }
    const convictionScore =
      uniqueEntries.length > 0
        ? (walletsWithConviction / uniqueEntries.length) * 100
        : 0;

    // Calculate average quality weight
    const totalQualityWeight = uniqueEntries.reduce(
      (sum, entry) => sum + entry.qualityWeight,
      0,
    );
    const avgQualityWeight =
      uniqueEntries.length > 0
        ? totalQualityWeight / uniqueEntries.length
        : 0;

    // Determine window boundaries from entry timestamps
    const timestamps = uniqueEntries.map((e) => e.timestamp);
    const windowStart = Math.min(...timestamps);
    const windowEnd = Math.max(...timestamps);

    // Map internal WalletEntry to output ConvergenceWalletEntry
    const wallets = uniqueEntries.map((entry) => ({
      address: entry.walletAddress,
      classification: entry.classification,
      positionSize: entry.positionSize,
      entryTimestamp: entry.timestamp,
      txHash: entry.txHash,
    }));

    const event: ConvergenceEvent = {
      token: tokenAddress,
      wallets,
      windowStart,
      windowEnd,
      convictionScore,
      walletCount: uniqueEntries.length,
      avgQualityWeight,
    };

    return event;
  }

  /**
   * Dispatches a ConvergenceEvent to all registered callback functions.
   * Errors in individual callbacks are caught and logged to prevent one
   * failing callback from blocking others.
   *
   * @param event - The convergence event to emit
   */
  private emitConvergence(event: ConvergenceEvent): void {
    for (const callback of this.convergenceCallbacks) {
      try {
        callback(event);
      } catch (error: unknown) {
        logger.error(
          'Error in convergence callback',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Query Methods
  // -------------------------------------------------------------------------

  /**
   * Queries whether a convergence event is currently active for a specific token.
   *
   * Prunes expired entries before evaluating to ensure freshness. If the number
   * of unique qualified wallets in the current window meets the threshold,
   * returns the full ConvergenceEvent. Otherwise returns null.
   *
   * This is the primary method called by the smart-money-convergence scoring factor.
   *
   * @param tokenAddress - Solana token mint address to query
   * @returns ConvergenceEvent if convergence is active, null otherwise
   */
  getConvergenceForToken(tokenAddress: string): ConvergenceEvent | null {
    // Prune expired entries first to ensure accurate window
    this.pruneExpired(tokenAddress);

    const uniqueEntries = this.getUniqueQualifiedEntries(tokenAddress);
    if (uniqueEntries.length < this.minWallets) {
      return null;
    }

    return this.buildConvergenceEvent(tokenAddress, uniqueEntries);
  }

  /**
   * Returns all tokens that currently have active convergence signals.
   *
   * Iterates all tracked tokens, prunes expired entries, and returns
   * ConvergenceEvents for tokens meeting the convergence threshold.
   * Results are sorted by conviction score descending (highest conviction first).
   *
   * @returns Array of active ConvergenceEvents sorted by conviction score
   */
  getActiveConvergences(): ConvergenceEvent[] {
    const activeEvents: ConvergenceEvent[] = [];

    // Collect token addresses before iteration to avoid concurrent modification
    const tokenAddresses = Array.from(this.tokenEntries.keys());

    for (const tokenAddress of tokenAddresses) {
      // Prune expired entries for each token
      this.pruneExpired(tokenAddress);

      const uniqueEntries = this.getUniqueQualifiedEntries(tokenAddress);
      if (uniqueEntries.length >= this.minWallets) {
        const event = this.buildConvergenceEvent(tokenAddress, uniqueEntries);
        activeEvents.push(event);
      }
    }

    // Sort by conviction score descending for priority display
    activeEvents.sort((a, b) => b.convictionScore - a.convictionScore);

    return activeEvents;
  }

  /**
   * Returns the number of unique qualified wallets currently in the sliding
   * window for a specific token. Useful for progressive signal strength
   * display in the UI (e.g., "2/3 wallets — approaching convergence").
   *
   * Prunes expired entries before counting.
   *
   * @param tokenAddress - Solana token mint address
   * @returns Number of unique qualified wallets in the current window
   */
  getEntryCount(tokenAddress: string): number {
    this.pruneExpired(tokenAddress);
    return this.countUniqueQualified(tokenAddress);
  }

  // -------------------------------------------------------------------------
  // Conviction Analysis
  // -------------------------------------------------------------------------

  /**
   * Computes position size context for a wallet, enabling conviction analysis.
   *
   * Per AAP: "entries above 80% of historical average indicating conviction"
   * A percentOfAvg ≥ 80 means the wallet is investing at or above its
   * typical level, signaling conviction in the trade. Values above 100
   * indicate the wallet is investing MORE than their historical average.
   *
   * @param _walletAddress - Solana wallet address (for identification context)
   * @param currentPositionSize - Current position size in USD
   * @param historicalAvg - Historical average position size in USD
   * @returns Position size context with current/historical comparison
   */
  getPositionContext(
    _walletAddress: string,
    currentPositionSize: number,
    historicalAvg: number,
  ): PositionSizeContext {
    const percentOfAvg =
      historicalAvg > 0
        ? (currentPositionSize / historicalAvg) * 100
        : 0;

    return {
      currentSize: currentPositionSize,
      historicalAvg,
      percentOfAvg,
    };
  }

  // -------------------------------------------------------------------------
  // Callback Registration
  // -------------------------------------------------------------------------

  /**
   * Registers a callback function to be invoked when a convergence event
   * is detected. Multiple callbacks can be registered; they are all invoked
   * in registration order.
   *
   * Used by the background service worker to trigger further analysis
   * (e.g., AI/LLM analysis, signal store updates) when convergence fires.
   *
   * @param callback - Function to invoke with the ConvergenceEvent
   */
  onConvergence(callback: (event: ConvergenceEvent) => void): void {
    this.convergenceCallbacks.push(callback);
    logger.debug(
      `Convergence callback registered, total: ${this.convergenceCallbacks.length}`,
    );
  }

  /**
   * Removes a previously registered convergence callback. Uses reference
   * equality to identify the callback to remove.
   *
   * @param callback - The exact callback function reference to remove
   */
  removeCallback(callback: (event: ConvergenceEvent) => void): void {
    const index = this.convergenceCallbacks.indexOf(callback);
    if (index !== -1) {
      this.convergenceCallbacks.splice(index, 1);
      logger.debug(
        `Convergence callback removed, remaining: ${this.convergenceCallbacks.length}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup and State Management
  // -------------------------------------------------------------------------

  /**
   * Prunes all expired entries across all tracked tokens. Removes tokens
   * with no remaining entries from the Map entirely.
   *
   * This method is designed to be called periodically by chrome.alarms in
   * the background service worker (since setInterval is unreliable in MV3
   * service workers that terminate after ~30s of inactivity).
   */
  cleanup(): void {
    const tokenAddresses = Array.from(this.tokenEntries.keys());
    let totalPruned = 0;
    let tokensRemoved = 0;

    for (const tokenAddress of tokenAddresses) {
      const before = this.tokenEntries.get(tokenAddress)?.length ?? 0;
      this.pruneExpired(tokenAddress);
      const after = this.tokenEntries.get(tokenAddress)?.length ?? 0;
      totalPruned += before - after;
      if (!this.tokenEntries.has(tokenAddress)) {
        tokensRemoved++;
      }
    }

    logger.debug(
      `Cleanup complete: pruned ${totalPruned} entries, ` +
        `removed ${tokensRemoved} tokens, ` +
        `${this.tokenEntries.size} tokens remaining`,
    );
  }

  /**
   * Clears all tracked entries and resets the detector to its initial state.
   * Convergence callbacks are preserved — only data is cleared.
   *
   * Used during extension reset, testing, or when the user explicitly
   * requests a fresh start.
   */
  clear(): void {
    const previousSize = this.tokenEntries.size;
    this.tokenEntries.clear();
    logger.info(
      `Convergence detector cleared: removed ${previousSize} tokens`,
    );
  }

  /**
   * Returns aggregate statistics for monitoring and debugging.
   *
   * Statistics include the number of tracked tokens, total wallet entries
   * across all tokens, and the count of tokens currently meeting the
   * convergence threshold.
   *
   * Used by the extension popup and settings panel for system health display.
   *
   * @returns ConvergenceStats with tokenCount, totalEntries, activeConvergences
   */
  getStats(): ConvergenceStats {
    let totalEntries = 0;
    let activeConvergences = 0;

    for (const [tokenAddress, entries] of this.tokenEntries) {
      totalEntries += entries.length;
      const uniqueQualified = this.countUniqueQualified(tokenAddress);
      if (uniqueQualified >= this.minWallets) {
        activeConvergences++;
      }
    }

    return {
      tokenCount: this.tokenEntries.size,
      totalEntries,
      activeConvergences,
    };
  }
}
