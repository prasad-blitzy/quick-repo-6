/**
 * @file src/tracking/wallet-tracker.ts
 * @description Smart Money Wallet Watchlist Manager
 *
 * Manages the tracked wallet watchlist, persisting wallet addresses and
 * classifications in `chrome.storage.local` for survival across service
 * worker restarts. Monitors wallet activity via intercepted GMGN data
 * (wallet activity and smart money signals) and bridges detected trades
 * to the convergence detector via an activity callback system.
 *
 * Data Flow:
 *   GMGN intercepted data (smart money signals, wallet activity)
 *     → wallet-tracker.ts
 *     → convergence-detector.ts (via activity callbacks)
 *     → signal scoring engine
 *
 * Integration Points:
 *   - Fed by `src/gmgn/parsers.ts` — receives GmgnWalletActivity and
 *     GmgnSmartMoneySignal objects via the service worker message bus
 *   - Feeds into `src/tracking/convergence-detector.ts` — when a tracked
 *     wallet makes a trade, passes the entry to convergence detection
 *   - Wallet data persisted via `chrome.storage.local`
 *
 * @see AAP Section 0.5.1 Group 7 — Smart Money Tracking
 * @see AAP Section 0.4.6 — External API Integration Map
 * @module tracking/wallet-tracker
 */

import type { TrackedWallet, WalletClassification } from './types';
import type { GmgnWalletActivity, GmgnSmartMoneySignal } from '../gmgn/types';
import { createLogger } from '../utils/logger';

// =============================================================================
// Constants
// =============================================================================

/**
 * Chrome storage key used to persist the tracked wallet list in
 * `chrome.storage.local`. Exported for use in tests and external
 * storage access patterns.
 */
export const STORAGE_KEY = 'tracked_wallets';

/**
 * Maximum number of wallets that can be tracked simultaneously.
 * Prevents unbounded growth of the in-memory Map and
 * `chrome.storage.local` usage. 500 wallets is a reasonable limit
 * that balances comprehensive tracking with storage constraints.
 */
export const MAX_TRACKED_WALLETS = 500;

// =============================================================================
// Internal Constants
// =============================================================================

/**
 * Minimum win rate percentage required for auto-discovery of smart money
 * wallets from GMGN signals. Per AAP: "winRate >= 70%".
 */
const AUTO_DISCOVER_MIN_WIN_RATE = 70;

/**
 * Wallet classifications eligible for auto-discovery from GMGN smart
 * money signals. Per AAP Section 0.5.1 Group 7:
 * "Check classification: only auto-add 'smart_money' (70%+ win rate),
 * 'whale', and 'insider'. Don't auto-add 'sniper' or 'developer'
 * (less reliable signals)."
 */
const AUTO_DISCOVER_CLASSIFICATIONS: ReadonlySet<WalletClassification> = new Set([
  'smart_money',
  'whale',
  'insider',
]);

/**
 * EMA smoothing factor (alpha) for position size running average.
 * A value of 0.2 gives ~80% weight to the historical average and
 * ~20% weight to the newest observation, providing smooth updates
 * that resist outlier noise while still adapting to trend changes.
 */
const EMA_ALPHA = 0.2;

/**
 * Debounce interval (in milliseconds) for batching persistence writes
 * to `chrome.storage.local`. Prevents excessive writes when processing
 * large batches of activity data or smart money signals.
 */
const PERSIST_DEBOUNCE_MS = 500;

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Callback function type for wallet activity events.
 * Fired when a tracked wallet performs a buy or sell action.
 * Used by convergence-detector.ts to record wallet entries.
 */
type ActivityCallback = (
  walletAddress: string,
  tokenAddress: string,
  action: 'buy' | 'sell',
  amountUsd: number,
) => void;

// =============================================================================
// WalletTracker Class
// =============================================================================

/**
 * Smart Money Wallet Watchlist Manager.
 *
 * Provides CRUD operations for tracked wallets, processes intercepted
 * GMGN data to update wallet activity and auto-discover new smart money
 * wallets, and bridges activity events to the convergence detector via
 * a callback system.
 *
 * Lifecycle:
 *   1. Construct with `new WalletTracker()`
 *   2. Call `await initialize()` to load persisted state from chrome.storage
 *   3. Register activity callbacks via `onActivity()`
 *   4. Feed GMGN data via `processGmgnWalletActivity()` and
 *      `processGmgnSmartMoneySignals()`
 *   5. Query tracked wallets via `getWallet()`, `getAllWallets()`,
 *      `getWalletsByClassification()`, `isTracked()`, `getWalletCount()`
 *   6. Periodically call `pruneInactive()` to remove stale wallets
 *
 * All mutations are persisted to `chrome.storage.local` via a debounced
 * write mechanism to avoid excessive storage operations.
 *
 * @example
 * ```typescript
 * const tracker = new WalletTracker();
 * await tracker.initialize();
 *
 * // Register convergence detector callback
 * tracker.onActivity((wallet, token, action, amount) => {
 *   convergenceDetector.recordEntry(wallet, token, action, amount);
 * });
 *
 * // Add a known smart money wallet
 * await tracker.addWallet('Abc123...', 'smart_money', {
 *   tag: 'DegenTrader',
 *   winRate: 82,
 *   avgPositionSize: 5000,
 * });
 *
 * // Process intercepted GMGN data
 * tracker.processGmgnWalletActivity(activities);
 * tracker.processGmgnSmartMoneySignals(signals);
 * ```
 */
export class WalletTracker {
  /** In-memory Map of wallet address → TrackedWallet for fast lookups. */
  private wallets: Map<string, TrackedWallet>;

  /** Structured logger instance with 'wallet-tracker' context tag. */
  private logger: ReturnType<typeof createLogger>;

  /** Registered activity callbacks fired on tracked wallet trades. */
  private activityCallbacks: ActivityCallback[];

  /** Whether the tracker has been initialized from chrome.storage. */
  private initialized: boolean;

  /** Handle for the debounced persistence timer. */
  private persistTimerId: ReturnType<typeof setTimeout> | null;

  /** Flag indicating a persist operation is pending (debounced). */
  private persistPending: boolean;

  constructor() {
    this.wallets = new Map();
    this.logger = createLogger('wallet-tracker');
    this.activityCallbacks = [];
    this.initialized = false;
    this.persistTimerId = null;
    this.persistPending = false;
  }

  // ===========================================================================
  // Initialization and Persistence
  // ===========================================================================

  /**
   * Initializes the wallet tracker by loading persisted wallet data from
   * `chrome.storage.local`. Must be called once before any other operations.
   *
   * Populates the in-memory Map from stored data and marks the tracker
   * as initialized. Safe to call multiple times — subsequent calls are no-ops.
   *
   * @throws Logs error and continues with empty wallet list if storage read fails
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.debug('Wallet tracker already initialized, skipping');
      return;
    }

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const walletData = stored[STORAGE_KEY] as TrackedWallet[] | undefined;

      if (walletData && Array.isArray(walletData)) {
        for (const wallet of walletData) {
          if (wallet && typeof wallet.address === 'string' && wallet.address.length > 0) {
            this.wallets.set(wallet.address, wallet);
          }
        }
      }

      this.initialized = true;
      this.logger.info(
        `Wallet tracker initialized with ${this.wallets.size} tracked wallets`,
      );
    } catch (error) {
      this.initialized = true;
      this.logger.error('Failed to load wallet data from storage, starting empty', error);
    }
  }

  /**
   * Persists the current wallet Map to `chrome.storage.local`.
   *
   * Called after every mutation (add, remove, update). Uses debouncing
   * to batch rapid successive mutations into a single write, preventing
   * excessive storage operations when processing large batches of GMGN data.
   */
  private async persistToStorage(): Promise<void> {
    try {
      const walletArray = Array.from(this.wallets.values());
      await chrome.storage.local.set({ [STORAGE_KEY]: walletArray });
      this.logger.debug(
        `Persisted ${walletArray.length} wallets to chrome.storage.local`,
      );
    } catch (error) {
      this.logger.error('Failed to persist wallet data to storage', error);
    }
  }

  /**
   * Schedules a debounced persistence write. Multiple calls within the
   * debounce window (PERSIST_DEBOUNCE_MS) are collapsed into a single
   * storage write, reducing chrome.storage.local I/O pressure.
   */
  private schedulePersist(): void {
    this.persistPending = true;

    if (this.persistTimerId !== null) {
      clearTimeout(this.persistTimerId);
    }

    this.persistTimerId = setTimeout(() => {
      this.persistTimerId = null;
      this.persistPending = false;
      this.persistToStorage();
    }, PERSIST_DEBOUNCE_MS);
  }

  // ===========================================================================
  // Wallet CRUD Operations
  // ===========================================================================

  /**
   * Adds a wallet to the tracked list and persists the change.
   *
   * @param address - Solana wallet address (base58-encoded public key)
   * @param classification - Wallet classification type
   * @param metadata - Optional metadata: tag, winRate, avgPositionSize
   * @returns `true` if the wallet was added, `false` if at limit or already exists
   */
  async addWallet(
    address: string,
    classification: WalletClassification,
    metadata?: {
      tag?: string;
      winRate?: number;
      avgPositionSize?: number;
    },
  ): Promise<boolean> {
    if (!address || typeof address !== 'string') {
      this.logger.warn('Attempted to add wallet with invalid address');
      return false;
    }

    if (this.wallets.has(address)) {
      this.logger.debug(`Wallet ${address} is already tracked, skipping add`);
      return false;
    }

    if (this.wallets.size >= MAX_TRACKED_WALLETS) {
      this.logger.warn(
        `Cannot add wallet ${address}: at maximum tracked wallet limit (${MAX_TRACKED_WALLETS})`,
      );
      return false;
    }

    const wallet: TrackedWallet = {
      address,
      classification,
      lastActivity: Date.now(),
      avgPositionSize: metadata?.avgPositionSize ?? 0,
      tag: metadata?.tag,
      winRate: metadata?.winRate,
      addedAt: Date.now(),
    };

    this.wallets.set(address, wallet);
    await this.persistToStorage();
    this.logger.info(
      `Added tracked wallet: ${address} (${classification})`,
    );
    return true;
  }

  /**
   * Removes a wallet from the tracked list and persists the change.
   *
   * @param address - Solana wallet address to remove
   * @returns `true` if the wallet was found and removed, `false` otherwise
   */
  async removeWallet(address: string): Promise<boolean> {
    if (!this.wallets.has(address)) {
      this.logger.debug(`Wallet ${address} not found in tracked list, nothing to remove`);
      return false;
    }

    this.wallets.delete(address);
    await this.persistToStorage();
    this.logger.info(`Removed tracked wallet: ${address}`);
    return true;
  }

  /**
   * Retrieves a tracked wallet by address.
   *
   * @param address - Solana wallet address to look up
   * @returns The TrackedWallet object if found, `undefined` otherwise
   */
  getWallet(address: string): TrackedWallet | undefined {
    return this.wallets.get(address);
  }

  /**
   * Returns all tracked wallets as an array.
   *
   * @returns Array of all TrackedWallet objects
   */
  getAllWallets(): TrackedWallet[] {
    return Array.from(this.wallets.values());
  }

  /**
   * Filters tracked wallets by classification type.
   *
   * @param classification - The WalletClassification to filter by
   * @returns Array of TrackedWallet objects matching the classification
   */
  getWalletsByClassification(classification: WalletClassification): TrackedWallet[] {
    const result: TrackedWallet[] = [];
    for (const wallet of this.wallets.values()) {
      if (wallet.classification === classification) {
        result.push(wallet);
      }
    }
    return result;
  }

  /**
   * Checks whether a wallet address is in the tracked list.
   *
   * @param address - Solana wallet address to check
   * @returns `true` if the wallet is being tracked
   */
  isTracked(address: string): boolean {
    return this.wallets.has(address);
  }

  /**
   * Returns the current number of tracked wallets.
   *
   * @returns Count of tracked wallets
   */
  getWalletCount(): number {
    return this.wallets.size;
  }

  // ===========================================================================
  // GMGN Data Processing
  // ===========================================================================

  /**
   * Processes intercepted GMGN wallet activity data.
   *
   * For each activity:
   * - If the wallet is tracked: updates `lastActivity`, emits buy/sell
   *   events to registered activity callbacks, and updates position size
   *   tracking for buy actions.
   * - If the wallet is not tracked: logs notable activities for discovery.
   *
   * Persistence is debounced to avoid excessive `chrome.storage.local`
   * writes when processing large activity batches.
   *
   * @param activities - Array of GmgnWalletActivity objects from GMGN data
   */
  processGmgnWalletActivity(activities: GmgnWalletActivity[]): void {
    if (!activities || activities.length === 0) {
      return;
    }

    let hasUpdates = false;

    for (const activity of activities) {
      const wallet = this.wallets.get(activity.walletAddress);

      if (wallet) {
        // Update last activity timestamp — GMGN timestamps are in seconds,
        // convert to milliseconds for consistency with TrackedWallet fields
        wallet.lastActivity = activity.timestamp * 1000;
        hasUpdates = true;

        // Only emit buy/sell actions to callbacks (not 'transfer')
        if (activity.action === 'buy' || activity.action === 'sell') {
          this.logger.debug(
            `Tracked wallet ${activity.walletAddress} ${activity.action} on ` +
            `${activity.tokenAddress} for $${activity.amountUsd.toFixed(2)}`,
          );

          // Update position size tracking for buy actions
          if (activity.action === 'buy' && activity.amountUsd > 0) {
            this.updateAvgPositionSizeInternal(wallet, activity.amountUsd);
          }

          this.emitActivity(
            activity.walletAddress,
            activity.tokenAddress,
            activity.action,
            activity.amountUsd,
          );
        }
      } else {
        // Not tracked — log notable large-amount activities for potential discovery
        if (activity.amountUsd >= 10000) {
          this.logger.debug(
            `Notable untracked activity: ${activity.walletAddress} ` +
            `${activity.action} $${activity.amountUsd.toFixed(2)} on ${activity.tokenAddress}`,
          );
        }
      }
    }

    if (hasUpdates) {
      this.schedulePersist();
    }
  }

  /**
   * Processes intercepted GMGN smart money signals for wallet tracking.
   *
   * For each signal:
   * - If the wallet is already tracked: updates classification, winRate,
   *   lastActivity, tag, and emits buy activity events.
   * - If not tracked and meets auto-discovery criteria (smart_money/whale/insider
   *   with winRate ≥ 70%): auto-adds the wallet to the tracked list.
   *
   * Auto-discovery follows AAP rules:
   * - Only auto-add 'smart_money' (70%+ win rate), 'whale', and 'insider'
   * - Don't auto-add 'sniper', 'developer', or 'unknown'
   * - Respect MAX_TRACKED_WALLETS limit
   *
   * @param signals - Array of GmgnSmartMoneySignal objects from GMGN data
   */
  processGmgnSmartMoneySignals(signals: GmgnSmartMoneySignal[]): void {
    if (!signals || signals.length === 0) {
      return;
    }

    let hasUpdates = false;

    for (const signal of signals) {
      const existingWallet = this.wallets.get(signal.walletAddress);
      // Convert GmgnWalletType to WalletClassification — filter out 'unknown'
      const classification = this.mapGmgnWalletType(signal.walletType);

      if (existingWallet) {
        // Update existing tracked wallet data
        existingWallet.lastActivity = signal.timestamp * 1000;
        if (classification) {
          existingWallet.classification = classification;
        }
        if (signal.winRate > 0) {
          existingWallet.winRate = signal.winRate;
        }
        if (signal.walletTag) {
          existingWallet.tag = signal.walletTag;
        }
        hasUpdates = true;

        // Emit buy activity events for existing tracked wallets
        if (signal.action === 'buy' && signal.amountUsd > 0) {
          this.updateAvgPositionSizeInternal(existingWallet, signal.amountUsd);
          this.emitActivity(
            signal.walletAddress,
            signal.tokenAddress,
            signal.action,
            signal.amountUsd,
          );
        } else if (signal.action === 'sell') {
          this.emitActivity(
            signal.walletAddress,
            signal.tokenAddress,
            signal.action,
            signal.amountUsd,
          );
        }
      } else {
        // Auto-discovery: check if this wallet qualifies for automatic tracking
        if (this.shouldAutoDiscover(signal, classification)) {
          // Auto-add wallet — use non-async internal add to avoid
          // individual persist calls in a batch
          const wallet: TrackedWallet = {
            address: signal.walletAddress,
            classification: classification!,
            lastActivity: signal.timestamp * 1000,
            avgPositionSize: signal.amountUsd > 0 ? signal.amountUsd : 0,
            tag: signal.walletTag || undefined,
            winRate: signal.winRate,
            addedAt: Date.now(),
          };

          this.wallets.set(signal.walletAddress, wallet);
          hasUpdates = true;

          this.logger.info(
            `Auto-discovered smart money wallet: ${signal.walletAddress} ` +
            `(${wallet.classification}, win rate: ${signal.winRate}%)`,
          );

          // Emit buy activity for newly discovered wallet
          if (signal.action === 'buy' && signal.amountUsd > 0) {
            this.emitActivity(
              signal.walletAddress,
              signal.tokenAddress,
              signal.action,
              signal.amountUsd,
            );
          }
        }
      }
    }

    if (hasUpdates) {
      this.schedulePersist();
    }
  }

  // ===========================================================================
  // Activity Callback System
  // ===========================================================================

  /**
   * Registers a callback that fires when a tracked wallet performs a trade.
   * Used by convergence-detector.ts to record wallet entries for
   * convergence detection.
   *
   * @param callback - Function to call on tracked wallet activity
   */
  onActivity(
    callback: (
      walletAddress: string,
      tokenAddress: string,
      action: 'buy' | 'sell',
      amountUsd: number,
    ) => void,
  ): void {
    this.activityCallbacks.push(callback);
    this.logger.debug(
      `Registered activity callback (total: ${this.activityCallbacks.length})`,
    );
  }

  /**
   * Removes a previously registered activity callback.
   *
   * @param callback - The callback function reference to remove
   */
  removeActivityCallback(callback: Function): void {
    const index = this.activityCallbacks.indexOf(callback as ActivityCallback);
    if (index !== -1) {
      this.activityCallbacks.splice(index, 1);
      this.logger.debug(
        `Removed activity callback (remaining: ${this.activityCallbacks.length})`,
      );
    }
  }

  /**
   * Fires all registered activity callbacks with the provided trade details.
   * This is the bridge between the wallet tracker and the convergence detector.
   *
   * Errors in individual callbacks are caught and logged to prevent a single
   * failing callback from breaking the entire activity notification chain.
   *
   * @param walletAddress - Solana wallet address performing the trade
   * @param tokenAddress - Solana token mint address being traded
   * @param action - Trade direction ('buy' or 'sell')
   * @param amountUsd - USD value of the trade
   */
  private emitActivity(
    walletAddress: string,
    tokenAddress: string,
    action: 'buy' | 'sell',
    amountUsd: number,
  ): void {
    for (const callback of this.activityCallbacks) {
      try {
        callback(walletAddress, tokenAddress, action, amountUsd);
      } catch (error) {
        this.logger.error(
          `Activity callback threw an error for wallet ${walletAddress}`,
          error,
        );
      }
    }
  }

  // ===========================================================================
  // Position Size Tracking
  // ===========================================================================

  /**
   * Updates the running average position size for a tracked wallet using
   * Exponential Moving Average (EMA).
   *
   * The EMA formula with alpha = 0.2 gives:
   *   newAvg = 0.2 * newPositionSize + 0.8 * currentAvg
   *
   * This provides smooth adaptation to changing position sizes while
   * resisting outlier noise. The historical average is used by
   * convergence-detector.ts for conviction analysis — entries at or
   * above 80% of the historical average indicate conviction.
   *
   * @param address - Solana wallet address
   * @param newPositionSize - New position size in USD
   */
  updateAvgPositionSize(address: string, newPositionSize: number): void {
    const wallet = this.wallets.get(address);
    if (!wallet) {
      this.logger.warn(
        `Cannot update position size for untracked wallet: ${address}`,
      );
      return;
    }

    this.updateAvgPositionSizeInternal(wallet, newPositionSize);
    this.schedulePersist();
  }

  /**
   * Returns the historical average position size for a tracked wallet.
   *
   * @param address - Solana wallet address
   * @returns Historical average position size in USD, or 0 if wallet
   *          is not tracked or has no position history
   */
  getAvgPositionSize(address: string): number {
    const wallet = this.wallets.get(address);
    return wallet ? wallet.avgPositionSize : 0;
  }

  /**
   * Internal EMA position size update without triggering persistence.
   * Used during batch processing to avoid multiple persist calls.
   *
   * @param wallet - TrackedWallet reference to update (mutated in-place)
   * @param newPositionSize - New position size in USD
   */
  private updateAvgPositionSizeInternal(
    wallet: TrackedWallet,
    newPositionSize: number,
  ): void {
    if (newPositionSize <= 0) {
      return;
    }

    if (wallet.avgPositionSize === 0) {
      // First position observation — use it directly instead of EMA
      wallet.avgPositionSize = newPositionSize;
    } else {
      // EMA update: newAvg = alpha * new + (1 - alpha) * old
      wallet.avgPositionSize =
        EMA_ALPHA * newPositionSize + (1 - EMA_ALPHA) * wallet.avgPositionSize;
    }
  }

  // ===========================================================================
  // Cleanup and Maintenance
  // ===========================================================================

  /**
   * Removes wallets that haven't had any activity within the specified
   * time period. Used for periodic maintenance to keep the tracked list
   * current and within storage limits.
   *
   * @param maxInactiveMs - Maximum inactivity period in milliseconds.
   *   Wallets with `lastActivity` older than `now - maxInactiveMs` are
   *   removed. Default: 7 days (7 * 24 * 60 * 60 * 1000 = 604800000ms).
   * @returns Number of wallets pruned
   */
  async pruneInactive(maxInactiveMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxInactiveMs;
    const addressesToRemove: string[] = [];

    for (const [address, wallet] of this.wallets.entries()) {
      if (wallet.lastActivity < cutoff) {
        addressesToRemove.push(address);
      }
    }

    if (addressesToRemove.length === 0) {
      this.logger.debug('No inactive wallets to prune');
      return 0;
    }

    for (const address of addressesToRemove) {
      this.wallets.delete(address);
    }

    await this.persistToStorage();
    this.logger.info(
      `Pruned ${addressesToRemove.length} inactive wallets ` +
      `(cutoff: ${new Date(cutoff).toISOString()})`,
    );
    return addressesToRemove.length;
  }

  /**
   * Clears all tracked wallets and removes persisted data from
   * `chrome.storage.local`. Used for full reset scenarios.
   */
  async clear(): Promise<void> {
    const count = this.wallets.size;
    this.wallets.clear();

    // Cancel any pending debounced persist
    if (this.persistTimerId !== null) {
      clearTimeout(this.persistTimerId);
      this.persistTimerId = null;
      this.persistPending = false;
    }

    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch (error) {
      this.logger.error('Failed to clear wallet data from storage', error);
    }

    this.logger.info(`Cleared all ${count} tracked wallets`);
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Determines whether a GMGN smart money signal qualifies for automatic
   * wallet discovery and tracking.
   *
   * Auto-discovery criteria per AAP:
   * - Classification is 'smart_money', 'whale', or 'insider'
   * - Win rate ≥ 70% (for smart_money classification)
   * - Not already tracked
   * - Under MAX_TRACKED_WALLETS limit
   *
   * @param signal - The GMGN smart money signal to evaluate
   * @param classification - Mapped WalletClassification (null if 'unknown')
   * @returns `true` if the wallet should be auto-discovered and tracked
   */
  private shouldAutoDiscover(
    signal: GmgnSmartMoneySignal,
    classification: WalletClassification | null,
  ): boolean {
    // Must have a valid (non-unknown) classification
    if (!classification) {
      return false;
    }

    // Must be an eligible classification type
    if (!AUTO_DISCOVER_CLASSIFICATIONS.has(classification)) {
      return false;
    }

    // Smart money wallets require >= 70% win rate
    if (classification === 'smart_money' && signal.winRate < AUTO_DISCOVER_MIN_WIN_RATE) {
      return false;
    }

    // Must not exceed the wallet tracking limit
    if (this.wallets.size >= MAX_TRACKED_WALLETS) {
      this.logger.warn(
        `Cannot auto-discover wallet ${signal.walletAddress}: ` +
        `at maximum tracked wallet limit (${MAX_TRACKED_WALLETS})`,
      );
      return false;
    }

    return true;
  }

  /**
   * Maps a GmgnWalletType (which includes 'unknown') to a
   * WalletClassification (which does not include 'unknown').
   *
   * Returns `null` for 'unknown' wallet types, indicating the wallet
   * type cannot be mapped to a valid WalletClassification.
   *
   * @param walletType - GMGN wallet type string
   * @returns Mapped WalletClassification or null for 'unknown'
   */
  private mapGmgnWalletType(
    walletType: string,
  ): WalletClassification | null {
    switch (walletType) {
      case 'smart_money':
      case 'kol':
      case 'whale':
      case 'sniper':
      case 'insider':
      case 'developer':
        return walletType as WalletClassification;
      case 'unknown':
      default:
        return null;
    }
  }
}
