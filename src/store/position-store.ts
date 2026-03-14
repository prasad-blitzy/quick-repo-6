/**
 * src/store/position-store.ts — Zustand Store for Tracked Positions
 *
 * Manages tracked trading positions for the GMGN Signal Bot Chrome Extension.
 * Each position tracks entry price, current price, take-profit (TP) ladder
 * levels, stop-loss thresholds, partial exit history, trailing stop state,
 * and active exit alerts.
 *
 * Per AAP Section 0.5.1 Group 10:
 * "Zustand store for tracked positions; state includes positions: Map<string,
 *  Position> with entry price, entry time, TP/SL levels, partial exit history;
 *  actions: openPosition, closePartial, closeAll; persisted to
 *  chrome.storage.local"
 *
 * Writers (Producers): scoring-engine.ts (entry), exit-signals.ts (exit)
 * Readers (Consumers): ExitStrategy.tsx, SignalPanel.tsx
 * Persistence: chrome.storage.local (per-device, NOT sync)
 *
 * Default TP Ladder (AAP Section 0.1.1):
 *   - Sell 50% at 2× entry price
 *   - Sell 25% at 5× entry price
 *   - Sell 25% at 10× entry price
 *   - Let remainder ride with trailing stop
 *
 * Day-trade TP/SL: +15%/+30%/+60%, SL -12%
 * Swing trade TP/SL: +40%/+100%/+200%/+500%, SL -18%
 *
 * Uses zustand/vanilla for service worker context (non-React/Preact).
 * All state is persisted via the chrome-storage-adapter middleware with
 * debounced writes and cross-context synchronization.
 *
 * @module store/position-store
 */

import { createStore } from 'zustand/vanilla';
import { createChromeStorageMiddleware } from './chrome-storage-adapter';
import { DEFAULT_EXIT_STRATEGY } from '../utils/config';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger for position store operations.
 * Tagged with 'position-store' for source identification in logs.
 */
const logger = createLogger('position-store');

// ---------------------------------------------------------------------------
// Exit Reason Type
// ---------------------------------------------------------------------------

/**
 * Discriminated exit reason type covering all AAP-specified exit triggers.
 *
 * Used in PartialExit records and ExitAlert objects to identify the cause
 * of a position exit or exit alert.
 */
export type ExitReason =
  | 'tp-ladder'        // Take-profit ladder level hit
  | 'stop-loss'        // Stop-loss threshold triggered
  | 'trailing-stop'    // Trailing stop triggered (price dropped trailPercent below high)
  | 'dev-sell'         // Developer wallet detected selling
  | 'smart-money-exit' // Smart money wallets reducing position 40-60%
  | 'volume-decline'   // Volume-to-market-cap ratio below 10%
  | 'manual';          // User-initiated manual exit

// ---------------------------------------------------------------------------
// Take-Profit Level Interface
// ---------------------------------------------------------------------------

/**
 * Represents a single level in the take-profit ladder.
 *
 * The ladder strategy stages exits at progressively higher multipliers
 * of the entry price, selling a configured percentage at each level.
 * Default configuration: 50% at 2×, 25% at 5×, 25% at 10×.
 */
export interface TpLevel {
  /** Target price multiplier relative to entry (e.g., 2 for 2× entry) */
  multiplier: number;
  /** Target price in USD computed as entryPrice × multiplier */
  targetPrice: number;
  /** Percentage of the original position to sell at this level */
  sellPercent: number;
  /** Whether this TP level has been triggered and executed */
  triggered: boolean;
  /** Timestamp (ms) when this level was triggered, null if not yet */
  triggeredAt: number | null;
}

// ---------------------------------------------------------------------------
// Partial Exit Record Interface
// ---------------------------------------------------------------------------

/**
 * Records details of a partial position exit.
 *
 * Each time a portion of a position is sold (via TP ladder, stop-loss,
 * or external trigger), a PartialExit record is appended to the position's
 * exitHistory array for audit trail and P&L tracking.
 */
export interface PartialExit {
  /** Timestamp (ms) of the partial exit execution */
  timestamp: number;
  /** Price in USD at which the exit occurred */
  exitPrice: number;
  /** Percentage of the original position exited in this operation */
  exitPercent: number;
  /** Reason for the exit — TP ladder hit, stop-loss, manual, etc. */
  reason: ExitReason;
  /** Realized P&L percentage for this exit relative to entry price */
  realizedPnlPercent: number;
}

// ---------------------------------------------------------------------------
// Exit Alert Interface
// ---------------------------------------------------------------------------

/**
 * Represents an active exit alert that has been triggered for a position.
 *
 * Alerts notify the trader of conditions that warrant attention, from
 * critical triggers (dev selling, smart money exiting) to informational
 * warnings (volume declining, approaching TP levels).
 */
export interface ExitAlert {
  /** Alert type — matches an ExitReason for the triggering condition */
  type: ExitReason;
  /** Human-readable alert message describing the condition */
  message: string;
  /** Timestamp (ms) when the alert was triggered */
  timestamp: number;
  /** Severity level: 'critical' requires immediate action, 'warning' is informational */
  severity: 'critical' | 'warning';
}

// ---------------------------------------------------------------------------
// Position Interface
// ---------------------------------------------------------------------------

/**
 * Full per-position tracked data structure.
 *
 * Each position represents a tracked trading entry with real-time price
 * monitoring, take-profit ladder management, stop-loss tracking, trailing
 * stop support, and a complete audit trail of partial exits.
 *
 * Keyed by tokenMint (Solana token mint address) in the position store.
 */
export interface Position {
  /** Token mint address — primary key for position lookup */
  tokenMint: string;
  /** Token symbol for display in the UI (e.g., "BONK", "WIF") */
  tokenSymbol: string;
  /** Entry price in USD at the time the position was opened */
  entryPrice: number;
  /** Current price in USD — updated in real-time via price feeds */
  currentPrice: number;
  /** Timestamp (ms) when the position was opened */
  entryTime: number;
  /** Initial position size (USD amount or portfolio percentage) */
  positionSize: number;
  /** Remaining position percentage — starts at 100, decreases with each partial exit */
  remainingPercent: number;
  /** Composite signal score at the time of entry (0-100) */
  entryScore: number;
  /** Active take-profit ladder levels with trigger status */
  tpLevels: TpLevel[];
  /** Stop-loss price threshold in USD — exit if price drops below */
  stopLossPrice: number;
  /** Stop-loss percentage relative to entry (negative, e.g., -12 means 12% below) */
  stopLossPercent: number;
  /** Complete history of partial exits executed on this position */
  exitHistory: PartialExit[];
  /** Whether the trailing stop mechanism is active for this position */
  trailingStopActive: boolean;
  /** Highest price observed since trailing stop activation */
  trailingStopHighPrice: number;
  /** Trailing stop distance as a percentage below the high (e.g., -15 means 15% below high) */
  trailingStopPercent: number;
  /** Current unrealized P&L as a percentage of entry price */
  unrealizedPnlPercent: number;
  /** Active exit alerts that have fired for this position */
  activeAlerts: ExitAlert[];
  /** Position lifecycle status: open → partial → closed */
  status: 'open' | 'partial' | 'closed';
  /** Timestamp (ms) of the most recent state update */
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Position Store State Interface
// ---------------------------------------------------------------------------

/**
 * State shape for the position store.
 *
 * Uses Record<string, Position> (keyed by token mint address) instead of
 * Map<string, Position> for JSON serialization compatibility with
 * chrome.storage.local.
 */
export interface PositionStoreState {
  /** Map of token mint address → Position */
  positions: Record<string, Position>;
  /** Maximum number of tracked positions (cap to prevent unbounded growth) */
  maxPositions: number;
  /** Cumulative realized P&L across all closed and partially closed positions */
  totalRealizedPnl: number;
}

// ---------------------------------------------------------------------------
// Position Store Actions Interface
// ---------------------------------------------------------------------------

/**
 * Action methods available on the position store.
 *
 * All mutating actions update the in-memory Zustand state and trigger
 * debounced persistence to chrome.storage.local via the middleware.
 */
export interface PositionStoreActions {
  /**
   * Opens a new tracked position with the given parameters.
   * Computes TP target prices from the entry price and ladder configuration.
   * Enforces the maxPositions cap — rejects if at capacity.
   */
  openPosition: (params: {
    tokenMint: string;
    tokenSymbol: string;
    entryPrice: number;
    positionSize: number;
    entryScore: number;
    tpLadder?: { sellPercent: number; multiplier: number }[];
    stopLossPercent?: number;
  }) => void;

  /**
   * Executes a partial exit on a position, reducing remainingPercent and
   * recording the exit in the exitHistory. Transitions status to 'partial'
   * or 'closed' based on remaining percentage.
   */
  closePartial: (
    tokenMint: string,
    exitPercent: number,
    exitPrice: number,
    reason: ExitReason,
  ) => void;

  /**
   * Closes the entire remaining position at the given price.
   * Delegates to closePartial with the full remaining percentage.
   */
  closeAll: (tokenMint: string, exitPrice: number, reason: ExitReason) => void;

  /**
   * Updates the current price for a position and recalculates
   * unrealized P&L. Skips closed positions.
   */
  updatePrice: (tokenMint: string, currentPrice: number) => void;

  /**
   * Checks all TP levels for a position and returns any levels that
   * should trigger (currentPrice >= targetPrice and not already triggered).
   * Does NOT execute the exits — the caller is responsible for that.
   */
  checkTpLevels: (tokenMint: string) => TpLevel[];

  /**
   * Adds an exit alert to a position's activeAlerts array.
   */
  addAlert: (tokenMint: string, alert: ExitAlert) => void;

  /**
   * Clears all active alerts from a position.
   */
  clearAlerts: (tokenMint: string) => void;

  /**
   * Retrieves a specific position by token mint address.
   * Returns undefined if the position does not exist.
   */
  getPosition: (tokenMint: string) => Position | undefined;

  /**
   * Returns all positions that are not fully closed (status 'open' or 'partial').
   */
  getOpenPositions: () => Position[];

  /**
   * Activates the trailing stop mechanism for a position with the
   * specified trail percentage distance.
   */
  activateTrailingStop: (tokenMint: string, trailPercent: number) => void;

  /**
   * Updates the trailing stop high-water mark when the price reaches
   * a new high. Only updates if the trailing stop is active and the
   * new high exceeds the current recorded high.
   */
  updateTrailingStopHigh: (tokenMint: string, highPrice: number) => void;

  /**
   * Removes a position entirely from the store. Typically used to
   * clean up closed positions after they are no longer needed.
   */
  removePosition: (tokenMint: string) => void;
}

// ---------------------------------------------------------------------------
// Combined Position Store Type
// ---------------------------------------------------------------------------

/**
 * Full position store type combining state and actions.
 * Used as the type parameter for the vanilla Zustand createStore call.
 */
export type PositionStore = PositionStoreState & PositionStoreActions;

// ---------------------------------------------------------------------------
// Store Creator Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new vanilla Zustand position store with chrome.storage.local
 * persistence via the chrome-storage-adapter middleware.
 *
 * Intended to be called once during service worker initialization in
 * entrypoints/background.ts. The returned store uses vanilla Zustand API
 * (.getState(), .setState(), .subscribe()) — NOT React/Preact hooks.
 *
 * For Preact UI consumption, the content script reads store state via
 * chrome.storage.onChanged synchronization and creates hook-based wrappers.
 *
 * @returns A vanilla Zustand StoreApi<PositionStore> instance
 *
 * @example
 * ```typescript
 * // In the service worker (background.ts)
 * import { createPositionStore } from '@/store/position-store';
 * const positionStore = createPositionStore();
 *
 * // Open a new position
 * positionStore.getState().openPosition({
 *   tokenMint: 'ABC123...',
 *   tokenSymbol: 'BONK',
 *   entryPrice: 0.00001234,
 *   positionSize: 100,
 *   entryScore: 85,
 * });
 *
 * // Update price and check TP levels
 * positionStore.getState().updatePrice('ABC123...', 0.00002468);
 * const triggered = positionStore.getState().checkTpLevels('ABC123...');
 * ```
 */
export function createPositionStore() {
  return createStore<PositionStore>()(
    createChromeStorageMiddleware<PositionStore>(
      'position-store',
      'local',
      (set, get) => ({
        // -------------------------------------------------------------------
        // Initial State
        // -------------------------------------------------------------------

        /** Positions keyed by token mint address */
        positions: {},

        /** Maximum tracked positions — cap to prevent unbounded state growth */
        maxPositions: 50,

        /** Cumulative realized P&L across all closed positions */
        totalRealizedPnl: 0,

        // -------------------------------------------------------------------
        // Actions
        // -------------------------------------------------------------------

        openPosition: (params) => {
          const state = get();

          // Enforce max positions cap
          const openCount = Object.values(state.positions).filter(
            (p) => p.status !== 'closed',
          ).length;
          if (openCount >= state.maxPositions) {
            logger.warn(
              `Cannot open position for ${params.tokenSymbol}: max positions ` +
              `(${state.maxPositions}) reached. Currently ${openCount} open.`,
            );
            return;
          }

          // Prevent duplicate positions for the same token
          if (state.positions[params.tokenMint] && state.positions[params.tokenMint].status !== 'closed') {
            logger.warn(
              `Position already exists for ${params.tokenSymbol} ` +
              `(${params.tokenMint}). Skipping duplicate open.`,
            );
            return;
          }

          // Use provided TP ladder or fall back to default from config
          const tpLadder = params.tpLadder && params.tpLadder.length > 0
            ? params.tpLadder
            : DEFAULT_EXIT_STRATEGY.LADDER as unknown as { sellPercent: number; multiplier: number }[];

          // Use provided stop-loss percent or fall back to day-trade default
          const stopLossPercent = params.stopLossPercent ?? DEFAULT_EXIT_STRATEGY.DAY_TRADE.stopLoss;

          // Build TP levels with computed target prices
          const tpLevels: TpLevel[] = tpLadder.map((tp) => ({
            multiplier: tp.multiplier,
            targetPrice: params.entryPrice * tp.multiplier,
            sellPercent: tp.sellPercent,
            triggered: false,
            triggeredAt: null,
          }));

          // Compute stop-loss price from entry and stop-loss percentage
          // stopLossPercent is negative (e.g., -12 means 12% below entry)
          const stopLossPrice = params.entryPrice * (1 + stopLossPercent / 100);

          const now = Date.now();

          const position: Position = {
            tokenMint: params.tokenMint,
            tokenSymbol: params.tokenSymbol,
            entryPrice: params.entryPrice,
            currentPrice: params.entryPrice,
            entryTime: now,
            positionSize: params.positionSize,
            remainingPercent: 100,
            entryScore: params.entryScore,
            tpLevels,
            stopLossPrice,
            stopLossPercent,
            exitHistory: [],
            trailingStopActive: false,
            trailingStopHighPrice: params.entryPrice,
            trailingStopPercent: 0,
            unrealizedPnlPercent: 0,
            activeAlerts: [],
            status: 'open',
            lastUpdated: now,
          };

          set((s) => ({
            positions: { ...s.positions, [params.tokenMint]: position },
          }));

          logger.info(
            `Position opened: ${params.tokenSymbol} at $${params.entryPrice} ` +
            `(score: ${params.entryScore}, SL: ${stopLossPercent}%, ` +
            `${tpLevels.length} TP levels)`,
          );
        },

        closePartial: (tokenMint, exitPercent, exitPrice, reason) => {
          const pos = get().positions[tokenMint];
          if (!pos) {
            logger.warn(`closePartial: No position found for ${tokenMint}`);
            return;
          }
          if (pos.status === 'closed') {
            logger.warn(`closePartial: Position ${tokenMint} is already closed`);
            return;
          }
          if (exitPercent <= 0) {
            logger.warn(`closePartial: Invalid exitPercent ${exitPercent} for ${tokenMint}`);
            return;
          }

          // Clamp exit percent to remaining position
          const effectiveExitPercent = Math.min(exitPercent, pos.remainingPercent);

          // Calculate realized P&L for this exit
          const realizedPnlPercent =
            ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

          const partialExit: PartialExit = {
            timestamp: Date.now(),
            exitPrice,
            exitPercent: effectiveExitPercent,
            reason,
            realizedPnlPercent,
          };

          const newRemaining = pos.remainingPercent - effectiveExitPercent;
          const isFullyClosed = newRemaining <= 0;

          // Calculate weighted realized PnL contribution to total
          const pnlContribution =
            (realizedPnlPercent * effectiveExitPercent) / 100;

          set((state) => {
            const updatedPos: Position = {
              ...pos,
              remainingPercent: Math.max(0, newRemaining),
              exitHistory: [...pos.exitHistory, partialExit],
              status: isFullyClosed ? 'closed' : 'partial',
              lastUpdated: Date.now(),
            };

            return {
              positions: {
                ...state.positions,
                [tokenMint]: updatedPos,
              },
              totalRealizedPnl: state.totalRealizedPnl + pnlContribution,
            };
          });

          logger.info(
            `Partial exit: ${pos.tokenSymbol} (${tokenMint}) — ` +
            `${effectiveExitPercent}% at $${exitPrice} (${reason}), ` +
            `realized PnL: ${realizedPnlPercent.toFixed(2)}%, ` +
            `remaining: ${Math.max(0, newRemaining).toFixed(1)}%`,
          );
        },

        closeAll: (tokenMint, exitPrice, reason) => {
          const pos = get().positions[tokenMint];
          if (!pos) {
            logger.warn(`closeAll: No position found for ${tokenMint}`);
            return;
          }
          if (pos.status === 'closed') {
            logger.warn(`closeAll: Position ${tokenMint} is already closed`);
            return;
          }

          // Delegate to closePartial with the full remaining percentage
          get().closePartial(tokenMint, pos.remainingPercent, exitPrice, reason);

          logger.info(
            `Position fully closed: ${pos.tokenSymbol} (${tokenMint}) ` +
            `at $${exitPrice} (${reason})`,
          );
        },

        updatePrice: (tokenMint, currentPrice) => {
          set((state) => {
            const pos = state.positions[tokenMint];
            if (!pos) {
              return state;
            }
            if (pos.status === 'closed') {
              return state;
            }

            // Recalculate unrealized P&L
            const unrealizedPnlPercent =
              ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

            return {
              positions: {
                ...state.positions,
                [tokenMint]: {
                  ...pos,
                  currentPrice,
                  unrealizedPnlPercent,
                  lastUpdated: Date.now(),
                },
              },
            };
          });
        },

        checkTpLevels: (tokenMint) => {
          const pos = get().positions[tokenMint];
          if (!pos) {
            return [];
          }
          if (pos.status === 'closed') {
            return [];
          }

          const triggered: TpLevel[] = [];
          for (const tp of pos.tpLevels) {
            if (!tp.triggered && pos.currentPrice >= tp.targetPrice) {
              triggered.push(tp);
            }
          }
          return triggered;
        },

        addAlert: (tokenMint, alert) => {
          set((state) => {
            const pos = state.positions[tokenMint];
            if (!pos) {
              logger.warn(`addAlert: No position found for ${tokenMint}`);
              return state;
            }

            return {
              positions: {
                ...state.positions,
                [tokenMint]: {
                  ...pos,
                  activeAlerts: [...pos.activeAlerts, alert],
                  lastUpdated: Date.now(),
                },
              },
            };
          });

          logger.debug(
            `Alert added for ${tokenMint}: [${alert.severity}] ${alert.type} — ${alert.message}`,
          );
        },

        clearAlerts: (tokenMint) => {
          set((state) => {
            const pos = state.positions[tokenMint];
            if (!pos) {
              return state;
            }

            return {
              positions: {
                ...state.positions,
                [tokenMint]: {
                  ...pos,
                  activeAlerts: [],
                  lastUpdated: Date.now(),
                },
              },
            };
          });

          logger.debug(`Alerts cleared for ${tokenMint}`);
        },

        getPosition: (tokenMint) => {
          return get().positions[tokenMint];
        },

        getOpenPositions: () => {
          return Object.values(get().positions).filter(
            (p) => p.status !== 'closed',
          );
        },

        activateTrailingStop: (tokenMint, trailPercent) => {
          set((state) => {
            const pos = state.positions[tokenMint];
            if (!pos) {
              logger.warn(
                `activateTrailingStop: No position found for ${tokenMint}`,
              );
              return state;
            }
            if (pos.status === 'closed') {
              logger.warn(
                `activateTrailingStop: Position ${tokenMint} is already closed`,
              );
              return state;
            }

            return {
              positions: {
                ...state.positions,
                [tokenMint]: {
                  ...pos,
                  trailingStopActive: true,
                  trailingStopPercent: trailPercent,
                  trailingStopHighPrice: Math.max(
                    pos.currentPrice,
                    pos.trailingStopHighPrice,
                  ),
                  lastUpdated: Date.now(),
                },
              },
            };
          });

          logger.info(
            `Trailing stop activated for ${tokenMint}: trail ${trailPercent}%`,
          );
        },

        updateTrailingStopHigh: (tokenMint, highPrice) => {
          set((state) => {
            const pos = state.positions[tokenMint];
            if (!pos) {
              return state;
            }
            if (!pos.trailingStopActive) {
              return state;
            }
            if (highPrice <= pos.trailingStopHighPrice) {
              return state;
            }

            return {
              positions: {
                ...state.positions,
                [tokenMint]: {
                  ...pos,
                  trailingStopHighPrice: highPrice,
                  lastUpdated: Date.now(),
                },
              },
            };
          });
        },

        removePosition: (tokenMint) => {
          const pos = get().positions[tokenMint];
          if (!pos) {
            logger.debug(`removePosition: No position found for ${tokenMint}`);
            return;
          }

          set((state) => {
            const { [tokenMint]: removed, ...rest } = state.positions;
            // Avoid unused variable warning
            void removed;
            return { positions: rest };
          });

          logger.info(
            `Position removed: ${pos.tokenSymbol} (${tokenMint})`,
          );
        },
      }),
    ),
  );
}
