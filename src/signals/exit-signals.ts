/**
 * src/signals/exit-signals.ts — Active Position Exit Signal Monitor
 *
 * Monitors active trading positions for exit triggers and produces exit signal
 * alerts. This is a pure analysis module with zero side effects — actual position
 * updates happen in the store layer (src/store/position-store.ts).
 *
 * Data Flow:
 *   Position Store (tracked positions) + Token Store (current prices/data)
 *     → Exit Signal Monitor checks each position
 *     → Detects: TP ladder hits, SL triggers, dev sell, smart money exit, volume decline
 *     → Emits ExitTrigger events
 *     → Written back to Position Store (alerts) + Signal Store (EXIT decisions)
 *
 * Supported Exit Trigger Types:
 *   - tp-ladder:        Take-profit ladder level hit (50% at 2×, 25% at 5×, 25% at 10×)
 *   - stop-loss:        Stop-loss threshold breached (day-trade: -12%, swing: -18%)
 *   - trailing-stop:    Trailing stop triggered (price dropped X% from highest observed)
 *   - dev-sell:         Developer/creator wallet sold tokens (CRITICAL — emergency exit)
 *   - smart-money-exit: Smart money wallets reducing positions by 40–60%
 *   - volume-decline:   Volume-to-market-cap ratio fell below 10%
 *
 * Consumers:
 *   - entrypoints/background.ts    — calls checkExitSignals() via chrome.alarms
 *   - src/store/position-store.ts  — reads/writes position data, receives exit alerts
 *   - src/store/signal-store.ts    — receives EXIT decision signals
 *   - src/components/ExitStrategy.tsx — displays exit status in UI
 *
 * Per AAP Section 0.5.1 Group 5:
 *   "Active position monitor; checks each tracked position against configurable
 *    TP ladder (50% at 2×, 25% at 5×, 25% at 10× with trailing stop) and SL
 *    thresholds; detects dev wallet selling, smart money exit (40–60% position
 *    reduction), volume decline (volume-to-MC below 10%)."
 *
 * Per AAP Section 0.1.1 (User Example — Exit Strategy):
 *   "The ladder strategy: Sell 50% at 2×, 25% at 5×, 25% at 10×, let remainder
 *    ride with trailing stop. Day-trade TP/SL: +15%/+30%/+60%, SL -12%.
 *    Swing trade: +40%/+100%/+200%/+500%, SL -18%."
 *
 * @module signals/exit-signals
 */

import type { ExitTrigger, ExitCheckResult, ExitReason } from './types';
import { createLogger } from '../utils/logger';
import { DEFAULT_EXIT_STRATEGY } from '../utils/config';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger instance with 'exit-signals' context tag.
 * Used for operational logging of TP ladder triggers, stop-loss hits,
 * dev sell detection, smart money exits, and volume decline warnings.
 */
const logger = createLogger('exit-signals');

// =============================================================================
// Exported Interface: TpLevelConfig
// =============================================================================

/**
 * Configuration for a single take-profit ladder level.
 *
 * Each level defines a price multiplier target and the percentage of the
 * remaining position to sell when that target is reached. The `triggered`
 * flag tracks whether this level has already been hit to prevent re-triggering.
 *
 * @example
 * ```typescript
 * // Default ladder: 50% at 2×, 25% at 5×, 25% at 10×
 * const levels: TpLevelConfig[] = [
 *   { multiplier: 2, sellPercent: 50, triggered: false },
 *   { multiplier: 5, sellPercent: 25, triggered: false },
 *   { multiplier: 10, sellPercent: 25, triggered: false },
 * ];
 * ```
 */
export interface TpLevelConfig {
  /** Price multiplier target relative to entry price (e.g., 2 = 2× entry price) */
  multiplier: number;

  /** Percentage of remaining position to sell when this level is reached (0–100) */
  sellPercent: number;

  /** Whether this take-profit level has already been triggered */
  triggered: boolean;
}

// =============================================================================
// Exported Interface: PositionData
// =============================================================================

/**
 * Input data shape for position exit checking.
 *
 * Combines position tracking data from the position store with current
 * market price data. This interface is compatible with the `Position` type
 * in `src/store/position-store.ts`.
 *
 * @example
 * ```typescript
 * const position: PositionData = {
 *   tokenMint: 'ABC123...',
 *   tokenSymbol: 'BONK',
 *   entryPrice: 0.000025,
 *   currentPrice: 0.000050,
 *   entryTime: Date.now() - 3600000,
 *   positionSize: 500,
 *   remainingPercent: 100,
 *   tpLevels: getDefaultTpLevels(0.000025, 'ladder'),
 *   stopLossPercent: -12,
 *   trailingStopActive: false,
 *   trailingStopHighPrice: 0,
 *   trailingStopPercent: 20,
 * };
 * ```
 */
export interface PositionData {
  /** Token mint address (Solana base58 public key) */
  tokenMint: string;

  /** Token ticker symbol (e.g., 'BONK', 'WIF') */
  tokenSymbol: string;

  /** Price at which the position was entered, in USD */
  entryPrice: number;

  /** Current token price in USD (updated from market data) */
  currentPrice: number;

  /** Unix timestamp in milliseconds when the position was opened */
  entryTime: number;

  /** Total position size in USD at entry */
  positionSize: number;

  /**
   * Percentage of the original position that remains open (0–100).
   * Decreases as partial exits are executed via TP ladder levels.
   * A value of 0 means the position is fully closed.
   */
  remainingPercent: number;

  /** Take-profit ladder level configurations for this position */
  tpLevels: TpLevelConfig[];

  /**
   * Stop-loss threshold as a negative percentage (e.g., -12 means -12%).
   * When the PnL drops below this value, the entire remaining position is closed.
   */
  stopLossPercent: number;

  /**
   * Whether the trailing stop is currently active for this position.
   * Activates after all TP ladder levels have been triggered.
   */
  trailingStopActive: boolean;

  /**
   * Highest price observed since position entry (used for trailing stop calculation).
   * Updated continuously as price rises. When price drops trailingStopPercent
   * from this high, the trailing stop triggers.
   */
  trailingStopHighPrice: number;

  /**
   * Trailing stop percentage drop threshold (e.g., 20 means a 20% drop from
   * the highest observed price triggers the stop).
   */
  trailingStopPercent: number;
}

// =============================================================================
// Exported Interface: TokenContext
// =============================================================================

/**
 * Additional market and on-chain context data needed for contextual exit checks.
 *
 * This data supplements the position data with real-time market conditions
 * and wallet activity information for detecting non-price-based exit triggers
 * (dev sell, smart money exit, volume decline).
 */
export interface TokenContext {
  /** Current token price in USD */
  currentPrice: number;

  /** 24-hour trading volume in USD */
  volume24h: number;

  /** Current market capitalization in USD */
  marketCap: number;

  /**
   * Whether the developer/creator wallet has sold tokens.
   * A `true` value triggers a CRITICAL exit signal (potential rug pull).
   */
  devWalletSold: boolean;

  /**
   * Percentage of tracked smart money wallets that have exited this token (0–100).
   * 40–59% triggers a warning; 60%+ triggers a critical exit signal.
   */
  smartMoneyExitPercent: number;

  /** Current number of unique token holders */
  holderCount: number;

  /** 1-hour trading volume in USD */
  volume1h: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Volume-to-market-cap ratio threshold for decline detection.
 * When the 24h volume / market cap ratio falls below this percentage,
 * a volume decline warning is triggered.
 */
const VOLUME_MC_DECLINE_THRESHOLD = 10;

/**
 * Smart money exit percentage threshold for warning severity.
 * When smart money exit percentage reaches this value, a warning is issued.
 */
const SMART_MONEY_WARNING_THRESHOLD = 40;

/**
 * Smart money exit percentage threshold for critical severity.
 * When smart money exit percentage reaches this value, it escalates to critical.
 */
const SMART_MONEY_CRITICAL_THRESHOLD = 60;

// =============================================================================
// Main Export: checkExitSignals
// =============================================================================

/**
 * Checks all exit conditions for a single active position.
 *
 * Evaluates 6 independent exit trigger categories:
 * 1. **Take-profit ladder** — Price multiples reached (2×, 5×, 10×)
 * 2. **Stop-loss** — PnL dropped below threshold (-12% day-trade, -18% swing)
 * 3. **Trailing stop** — Price dropped X% from highest observed price
 * 4. **Dev wallet sell** — Creator wallet dumped tokens (CRITICAL)
 * 5. **Smart money exit** — 40–60% of smart wallets exiting
 * 6. **Volume decline** — Volume/MC ratio below 10%
 *
 * Multiple triggers can fire simultaneously. The recommended action is
 * determined by the highest-severity trigger present.
 *
 * @param position - Position data including entry price, TP levels, and stop-loss config
 * @param context - Current market data and on-chain intelligence for the token
 * @returns Comprehensive exit check result with all detected triggers and recommended action
 *
 * @example
 * ```typescript
 * const result = checkExitSignals(position, context);
 * if (result.hasExitSignal && result.recommendedAction === 'CLOSE_ALL') {
 *   // Execute emergency exit
 * }
 * ```
 */
export function checkExitSignals(
  position: PositionData,
  context: TokenContext,
): ExitCheckResult {
  const triggers: ExitTrigger[] = [];

  logger.debug(
    `Checking exit signals for ${position.tokenSymbol} (${position.tokenMint})`,
    {
      entryPrice: position.entryPrice,
      currentPrice: context.currentPrice,
      remainingPercent: position.remainingPercent,
    },
  );

  // -------------------------------------------------------------------------
  // Step 1: Check take-profit ladder levels
  // -------------------------------------------------------------------------
  // Default ladder: 50% at 2×, 25% at 5×, 25% at 10×
  // Only trigger UNTRIGGERED levels to avoid re-triggering
  const currentMultiple =
    position.entryPrice > 0
      ? context.currentPrice / position.entryPrice
      : 0;

  for (const tp of position.tpLevels) {
    if (!tp.triggered && currentMultiple >= tp.multiplier) {
      const trigger: ExitTrigger = {
        type: 'tp-ladder' as ExitReason,
        reason: `Price reached ${tp.multiplier}× entry (${currentMultiple.toFixed(2)}×)`,
        severity: 'warning',
        sellPercent: tp.sellPercent,
        multiplier: tp.multiplier,
        timestamp: Date.now(),
      };
      triggers.push(trigger);

      logger.info(
        `TP ladder triggered for ${position.tokenSymbol}: ${tp.multiplier}× level hit ` +
          `(current: ${currentMultiple.toFixed(2)}×, sell ${tp.sellPercent}%)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Check stop-loss
  // -------------------------------------------------------------------------
  // Day-trade SL: -12%, Swing SL: -18%
  // Stop-loss = sell 100% of remaining position
  const pnlPercent =
    position.entryPrice > 0
      ? ((context.currentPrice - position.entryPrice) / position.entryPrice) * 100
      : 0;

  if (pnlPercent <= position.stopLossPercent) {
    const trigger: ExitTrigger = {
      type: 'stop-loss' as ExitReason,
      reason: `Stop loss hit at ${pnlPercent.toFixed(1)}% (threshold: ${position.stopLossPercent}%)`,
      severity: 'critical',
      sellPercent: 100,
      timestamp: Date.now(),
    };
    triggers.push(trigger);

    logger.warn(
      `Stop-loss triggered for ${position.tokenSymbol}: PnL ${pnlPercent.toFixed(1)}% ` +
        `below threshold ${position.stopLossPercent}%`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: Check trailing stop
  // -------------------------------------------------------------------------
  // Trailing stop activates after the last TP level; tracks highest price since entry.
  // Triggers when price drops trailingStopPercent from the highest observed price.
  if (position.trailingStopActive && position.trailingStopHighPrice > 0) {
    const dropFromHigh =
      ((position.trailingStopHighPrice - context.currentPrice) /
        position.trailingStopHighPrice) *
      100;

    if (dropFromHigh >= position.trailingStopPercent) {
      const trigger: ExitTrigger = {
        type: 'trailing-stop' as ExitReason,
        reason:
          `Price dropped ${dropFromHigh.toFixed(1)}% from high of ` +
          `$${position.trailingStopHighPrice.toFixed(6)} ` +
          `(threshold: ${position.trailingStopPercent}%)`,
        severity: 'critical',
        sellPercent: 100,
        timestamp: Date.now(),
      };
      triggers.push(trigger);

      logger.warn(
        `Trailing stop triggered for ${position.tokenSymbol}: ` +
          `dropped ${dropFromHigh.toFixed(1)}% from high $${position.trailingStopHighPrice.toFixed(6)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Check dev wallet selling
  // -------------------------------------------------------------------------
  // Dev selling is a CRITICAL exit signal per AAP — emergency exit, sell 100%
  if (context.devWalletSold) {
    const trigger: ExitTrigger = {
      type: 'dev-sell' as ExitReason,
      reason: 'Developer wallet has sold tokens — potential rug pull signal',
      severity: 'critical',
      sellPercent: 100,
      timestamp: Date.now(),
    };
    triggers.push(trigger);

    logger.warn(
      `Dev wallet sell detected for ${position.tokenSymbol} — emergency exit signal`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 5: Check smart money exit
  // -------------------------------------------------------------------------
  // Per AAP: "smart money exit (40–60% position reduction)"
  // 40–59% = warning (sell 50%), 60%+ = critical (sell 100%)
  if (
    context.smartMoneyExitPercent >= SMART_MONEY_WARNING_THRESHOLD &&
    context.smartMoneyExitPercent <= 100
  ) {
    const severity: 'critical' | 'warning' =
      context.smartMoneyExitPercent >= SMART_MONEY_CRITICAL_THRESHOLD
        ? 'critical'
        : 'warning';
    const sellPercent = severity === 'critical' ? 100 : 50;

    const trigger: ExitTrigger = {
      type: 'smart-money-exit' as ExitReason,
      reason: `Smart money reducing positions — ${context.smartMoneyExitPercent.toFixed(0)}% have exited`,
      severity,
      sellPercent,
      timestamp: Date.now(),
    };
    triggers.push(trigger);

    logger.info(
      `Smart money exit detected for ${position.tokenSymbol}: ` +
        `${context.smartMoneyExitPercent.toFixed(0)}% exited (severity: ${severity})`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 6: Check volume decline
  // -------------------------------------------------------------------------
  // Per AAP: "volume decline (volume-to-MC below 10%)"
  if (context.marketCap > 0) {
    const volumeToMcRatio = (context.volume24h / context.marketCap) * 100;

    if (volumeToMcRatio < VOLUME_MC_DECLINE_THRESHOLD) {
      const trigger: ExitTrigger = {
        type: 'volume-decline' as ExitReason,
        reason: `Volume/MC ratio declined to ${volumeToMcRatio.toFixed(1)}% (threshold: ${VOLUME_MC_DECLINE_THRESHOLD}%)`,
        severity: 'warning',
        sellPercent: 50,
        timestamp: Date.now(),
      };
      triggers.push(trigger);

      logger.info(
        `Volume decline detected for ${position.tokenSymbol}: ` +
          `Volume/MC ratio ${volumeToMcRatio.toFixed(1)}% < ${VOLUME_MC_DECLINE_THRESHOLD}%`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Build and return ExitCheckResult
  // -------------------------------------------------------------------------
  const hasExitSignal = triggers.length > 0;
  const hasCritical = triggers.some(
    (t: ExitTrigger) => t.severity === 'critical',
  );

  const highestSeverity: 'critical' | 'warning' | 'none' = hasCritical
    ? 'critical'
    : hasExitSignal
      ? 'warning'
      : 'none';

  const recommendedAction: 'CLOSE_ALL' | 'PARTIAL_EXIT' | 'HOLD' = hasCritical
    ? 'CLOSE_ALL'
    : hasExitSignal
      ? 'PARTIAL_EXIT'
      : 'HOLD';

  const result: ExitCheckResult = {
    tokenMint: position.tokenMint,
    hasExitSignal,
    triggers,
    highestSeverity,
    recommendedAction,
    timestamp: Date.now(),
  };

  if (hasExitSignal) {
    logger.info(
      `Exit signals for ${position.tokenSymbol}: ${triggers.length} trigger(s), ` +
        `severity: ${highestSeverity}, action: ${recommendedAction}`,
    );
  } else {
    logger.debug(
      `No exit signals for ${position.tokenSymbol} — HOLD`,
    );
  }

  return result;
}

// =============================================================================
// Export: checkAllPositions
// =============================================================================

/**
 * Batch checks all active positions for exit signals.
 *
 * Filters out fully closed positions (remainingPercent === 0) and checks
 * each remaining open position against its market context. Positions without
 * available market context are returned with a default HOLD recommendation.
 *
 * @param positions - Array of all tracked positions (open and closed)
 * @param contexts - Map of token mint address → current market context data
 * @returns Array of exit check results for all open positions
 *
 * @example
 * ```typescript
 * const results = checkAllPositions(allPositions, contextMap);
 * const exitAlerts = results.filter(r => r.hasExitSignal);
 * ```
 */
export function checkAllPositions(
  positions: PositionData[],
  contexts: Map<string, TokenContext>,
): ExitCheckResult[] {
  logger.debug(
    `Checking exit signals for ${positions.length} position(s)`,
  );

  return positions
    .filter((p: PositionData) => p.remainingPercent > 0)
    .map((position: PositionData): ExitCheckResult => {
      const context = contexts.get(position.tokenMint);

      if (!context) {
        logger.debug(
          `No market context available for ${position.tokenSymbol} (${position.tokenMint}) — skipping exit check`,
        );

        return {
          tokenMint: position.tokenMint,
          hasExitSignal: false,
          triggers: [],
          highestSeverity: 'none' as const,
          recommendedAction: 'HOLD' as const,
          timestamp: Date.now(),
        };
      }

      return checkExitSignals(position, context);
    });
}

// =============================================================================
// Export: shouldActivateTrailingStop
// =============================================================================

/**
 * Determines whether the trailing stop should be activated for a position.
 *
 * The trailing stop activates when ALL take-profit ladder levels have been
 * triggered and the position still has remaining size. Once active, the
 * trailing stop tracks the highest price and triggers a sell when the price
 * drops by the configured trailing stop percentage.
 *
 * @param position - Position data with TP level statuses
 * @returns `true` if trailing stop should be activated, `false` otherwise
 *
 * @example
 * ```typescript
 * if (shouldActivateTrailingStop(position)) {
 *   position.trailingStopActive = true;
 *   position.trailingStopHighPrice = context.currentPrice;
 * }
 * ```
 */
export function shouldActivateTrailingStop(position: PositionData): boolean {
  // Already active — no need to re-activate
  if (position.trailingStopActive) {
    return false;
  }

  // No TP levels configured — cannot determine activation condition
  if (position.tpLevels.length === 0) {
    return false;
  }

  // All TP levels must be triggered AND position must still be open
  const allTpTriggered = position.tpLevels.every(
    (tp: TpLevelConfig) => tp.triggered,
  );

  return allTpTriggered && position.remainingPercent > 0;
}

// =============================================================================
// Export: getDefaultTpLevels
// =============================================================================

/**
 * Creates take-profit level configurations based on the selected trading profile.
 *
 * Profiles:
 * - **ladder** (default): 50% at 2×, 25% at 5×, 25% at 10× entry price
 * - **day-trade**: +15%, +30%, +60% from entry price, with -12% stop-loss
 * - **swing-trade**: +40%, +100%, +200%, +500% from entry price, with -18% stop-loss
 *
 * The `entryPrice` parameter is accepted for API consistency but the returned
 * levels use multipliers (relative to entry), not absolute price targets.
 *
 * @param entryPrice - Entry price of the position (for API consistency)
 * @param profile - Trading profile: 'ladder' (default), 'day-trade', or 'swing-trade'
 * @returns Array of TpLevelConfig objects with multipliers and sell percentages
 *
 * @example
 * ```typescript
 * const ladderLevels = getDefaultTpLevels(0.001, 'ladder');
 * // Returns: [
 * //   { multiplier: 2, sellPercent: 50, triggered: false },
 * //   { multiplier: 5, sellPercent: 25, triggered: false },
 * //   { multiplier: 10, sellPercent: 25, triggered: false },
 * // ]
 *
 * const dayTradeLevels = getDefaultTpLevels(0.001, 'day-trade');
 * // Returns: [
 * //   { multiplier: 1.15, sellPercent: 33, triggered: false },
 * //   { multiplier: 1.30, sellPercent: 33, triggered: false },
 * //   { multiplier: 1.60, sellPercent: 100, triggered: false },
 * // ]
 * ```
 */
export function getDefaultTpLevels(
  entryPrice: number,
  profile: 'ladder' | 'day-trade' | 'swing-trade' = 'ladder',
): TpLevelConfig[] {
  switch (profile) {
    case 'ladder': {
      return DEFAULT_EXIT_STRATEGY.LADDER.map(
        (level: { sellPercent: number; multiplier: number }): TpLevelConfig => ({
          multiplier: level.multiplier,
          sellPercent: level.sellPercent,
          triggered: false,
        }),
      );
    }

    case 'day-trade': {
      const tpLevels = DEFAULT_EXIT_STRATEGY.DAY_TRADE.takeProfitLevels;
      const stopLoss = DEFAULT_EXIT_STRATEGY.DAY_TRADE.stopLoss;
      const lastIndex = tpLevels.length - 1;

      logger.debug(
        `Generating day-trade TP levels: [${tpLevels.join(', ')}]%, SL: ${stopLoss}%`,
      );

      return tpLevels.map(
        (pct: number, i: number): TpLevelConfig => ({
          // Convert percentage to multiplier: +15% → 1.15×, +30% → 1.30×, +60% → 1.60×
          multiplier: 1 + pct / 100,
          // Last level sells all remaining; others divide equally
          sellPercent: i === lastIndex ? 100 : 33,
          triggered: false,
        }),
      );
    }

    case 'swing-trade': {
      const tpLevels = DEFAULT_EXIT_STRATEGY.SWING_TRADE.takeProfitLevels;
      const stopLoss = DEFAULT_EXIT_STRATEGY.SWING_TRADE.stopLoss;
      const lastIndex = tpLevels.length - 1;

      logger.debug(
        `Generating swing-trade TP levels: [${tpLevels.join(', ')}]%, SL: ${stopLoss}%`,
      );

      return tpLevels.map(
        (pct: number, i: number): TpLevelConfig => ({
          // Convert percentage to multiplier: +40% → 1.40×, +100% → 2.0×, etc.
          multiplier: 1 + pct / 100,
          // Last level sells all remaining; others sell 25% each
          sellPercent: i === lastIndex ? 100 : 25,
          triggered: false,
        }),
      );
    }

    default: {
      // Fallback to ladder profile for any unrecognized profile string
      return getDefaultTpLevels(entryPrice, 'ladder');
    }
  }
}
