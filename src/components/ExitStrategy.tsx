/**
 * src/components/ExitStrategy.tsx — Exit Signal Display Component
 *
 * Visualises the active TP/SL (Take-Profit / Stop-Loss) ladder for tracked
 * positions, the current price position relative to entry and targets, and
 * any triggered exit alerts.
 *
 * Per AAP §0.5.1 Group 11:
 *   "Shows active TP/SL ladder for tracked positions; visualizes current
 *    price position relative to entry and targets; highlights triggered alerts"
 *
 * Per AAP §0.5.1 Group 5 — Exit Strategy:
 *   "Ladder strategy: Sell 50% at 2×, 25% at 5×, 25% at 10×, let remainder
 *    ride with trailing stop. Day-trade TP/SL: +15%/+30%/+60%, SL -12%.
 *    Swing trade: +40%/+100%/+200%/+500%, SL -18%."
 *
 * State management:
 *   Reads the Zustand position-store via `usePositionStoreHook` from
 *   `src/store/index.ts` and the settings-store for active TP/SL profile.
 *
 * @module components/ExitStrategy
 */

import { h, type FunctionComponent } from 'preact';
import { useMemo } from 'preact/hooks';
import { usePositionStoreHook } from '../store/index';
import type {
  Position,
  TpLevel,
  PartialExit,
  ExitAlert,
} from '../store/position-store';

// =============================================================================
// Constants
// =============================================================================

/** Colour mapping for PnL display */
const PNL_COLORS = {
  positive: '#22c55e',
  negative: '#ef4444',
  neutral: '#94a3b8',
} as const;

/** Severity badge colours for exit alerts */
const ALERT_SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Formats a percentage value with sign and fixed decimals.
 */
function formatPnl(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Formats a USD price with appropriate decimal places for memecoins.
 */
function formatPrice(price: number): string {
  if (price === 0) return '$0.00';
  if (price < 0.00001) return `$${price.toExponential(2)}`;
  if (price < 0.01) return `$${price.toFixed(6)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

/**
 * Computes the visual progress percentage of the current price between
 * the entry price and the next un-triggered TP level (or the last TP level
 * if all are triggered).
 */
function computeProgressPercent(position: Position): number {
  if (position.entryPrice <= 0) return 0;

  const currentMultiplier = position.currentPrice / position.entryPrice;
  const untriggeredLevels = position.tpLevels.filter((tp) => !tp.triggered);
  const nextTarget = untriggeredLevels.length > 0
    ? untriggeredLevels[0].multiplier
    : position.tpLevels[position.tpLevels.length - 1]?.multiplier ?? 2;

  // Map 1× (entry) to 0%, nextTarget× to 100%
  const progress = ((currentMultiplier - 1) / (nextTarget - 1)) * 100;
  return Math.max(0, Math.min(100, progress));
}

/**
 * Returns the human-readable reason label for an exit type.
 */
function exitReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    'tp-ladder': '🎯 Take Profit',
    'stop-loss': '🛑 Stop Loss',
    'trailing-stop': '📉 Trailing Stop',
    'dev-sell': '⚠️ Dev Sell',
    'smart-money-exit': '🧠 Smart Money Exit',
    'volume-decline': '📊 Volume Decline',
    'manual': '✋ Manual',
  };
  return labels[reason] ?? reason;
}

/**
 * Returns a human-readable time-ago string from a timestamp.
 */
function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// =============================================================================
// Sub-Components
// =============================================================================

/**
 * Individual TP level row showing multiplier target, sell percentage,
 * target price, and triggered status.
 */
const TpLevelRow: FunctionComponent<{
  level: TpLevel;
  index: number;
}> = ({ level, index }) => {
  const statusClass = level.triggered ? 'exit-tp-triggered' : 'exit-tp-pending';
  const statusIcon = level.triggered ? '✅' : '⏳';

  return (
    <div
      class={`exit-tp-row ${statusClass}`}
      role="listitem"
      aria-label={`TP level ${index + 1}: sell ${level.sellPercent}% at ${level.multiplier}×${
        level.triggered ? ' (triggered)' : ''
      }`}
    >
      <span class="exit-tp-icon" aria-hidden="true">{statusIcon}</span>
      <span class="exit-tp-sell">{level.sellPercent}%</span>
      <span class="exit-tp-multiplier">at {level.multiplier}×</span>
      <span class="exit-tp-price">{formatPrice(level.targetPrice)}</span>
      {level.triggered && level.triggeredAt && (
        <span class="exit-tp-time">{timeAgo(level.triggeredAt)}</span>
      )}
    </div>
  );
};

/**
 * Partial exit history row showing past exits with reason and PnL.
 */
const ExitHistoryRow: FunctionComponent<{
  exit: PartialExit;
  index: number;
}> = ({ exit, index }) => (
  <div class="exit-history-row" role="listitem" aria-label={`Exit ${index + 1}`}>
    <span class="exit-history-reason">{exitReasonLabel(exit.reason)}</span>
    <span class="exit-history-percent">{exit.exitPercent}%</span>
    <span class="exit-history-price">{formatPrice(exit.exitPrice)}</span>
    <span
      class="exit-history-pnl"
      style={{ color: exit.realizedPnlPercent >= 0 ? PNL_COLORS.positive : PNL_COLORS.negative }}
    >
      {formatPnl(exit.realizedPnlPercent)}
    </span>
  </div>
);

/**
 * Exit alert badge displaying the alert message with severity colour.
 */
const AlertBadge: FunctionComponent<{
  alert: ExitAlert;
}> = ({ alert }) => (
  <div
    class="exit-alert-badge"
    style={{ borderColor: ALERT_SEVERITY_COLORS[alert.severity] ?? '#94a3b8' }}
    role="alert"
    aria-label={`${alert.severity} alert: ${alert.message}`}
  >
    <span class="exit-alert-type">{exitReasonLabel(alert.type)}</span>
    <span class="exit-alert-message">{alert.message}</span>
    <span class="exit-alert-time">{timeAgo(alert.timestamp)}</span>
  </div>
);

/**
 * Visual progress bar showing current price position between entry and
 * the next TP target.
 */
const PriceProgressBar: FunctionComponent<{
  position: Position;
}> = ({ position }) => {
  const progress = useMemo(() => computeProgressPercent(position), [position]);
  const currentMultiplier = useMemo(() => {
    if (position.entryPrice <= 0) return 0;
    return position.currentPrice / position.entryPrice;
  }, [position.currentPrice, position.entryPrice]);

  return (
    <div class="exit-progress-container" role="meter" aria-label="Price progress to next target">
      <div class="exit-progress-bar">
        <div
          class="exit-progress-fill"
          style={{
            width: `${progress}%`,
            backgroundColor: currentMultiplier >= 1 ? PNL_COLORS.positive : PNL_COLORS.negative,
          }}
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <div class="exit-progress-labels">
        <span class="exit-progress-entry">Entry: {formatPrice(position.entryPrice)}</span>
        <span class="exit-progress-current">
          Now: {formatPrice(position.currentPrice)} ({currentMultiplier.toFixed(2)}×)
        </span>
      </div>
    </div>
  );
};

// =============================================================================
// ExitStrategy Props
// =============================================================================

/**
 * Props for the ExitStrategy component.
 */
export interface ExitStrategyProps {
  /** Token mint address to display exit strategy for (shows specific position) */
  tokenMint?: string;
  /** Maximum number of positions to display when tokenMint is not specified */
  maxPositions?: number;
}

// =============================================================================
// ExitStrategy Component
// =============================================================================

/**
 * Exit strategy display component showing active TP/SL ladders, current price
 * position, and triggered exit alerts for tracked memecoin positions.
 *
 * When `tokenMint` is provided, shows detailed view for a single position.
 * When omitted, shows a summary list of all open positions with their
 * exit status.
 */
const ExitStrategy: FunctionComponent<ExitStrategyProps> = ({
  tokenMint,
  maxPositions = 5,
}) => {
  // ---------------------------------------------------------------------------
  // Store Bindings
  // ---------------------------------------------------------------------------

  const getPosition = usePositionStoreHook((s) => s.getPosition);
  const getOpenPositions = usePositionStoreHook((s) => s.getOpenPositions);

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  const positions: Position[] = useMemo(() => {
    if (tokenMint) {
      const pos = getPosition(tokenMint);
      return pos ? [pos] : [];
    }
    return getOpenPositions().slice(0, maxPositions);
  }, [tokenMint, maxPositions, getPosition, getOpenPositions]);

  // ---------------------------------------------------------------------------
  // Empty State
  // ---------------------------------------------------------------------------

  if (positions.length === 0) {
    return (
      <div class="exit-empty" role="status" aria-label="No active positions">
        <span class="exit-empty-icon" aria-hidden="true">📭</span>
        <span class="exit-empty-text">No active positions to track</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="exit-strategy" role="region" aria-label="Exit strategy">
      {positions.map((position) => (
        <div
          key={position.tokenMint}
          class="exit-position-card"
          role="article"
          aria-label={`Exit strategy for ${position.tokenSymbol}`}
        >
          {/* Position Header */}
          <div class="exit-position-header">
            <span class="exit-token-symbol">{position.tokenSymbol}</span>
            <span
              class="exit-pnl"
              style={{
                color: position.unrealizedPnlPercent >= 0
                  ? PNL_COLORS.positive
                  : PNL_COLORS.negative,
              }}
            >
              {formatPnl(position.unrealizedPnlPercent)}
            </span>
            <span class="exit-remaining">
              {position.remainingPercent}% remaining
            </span>
          </div>

          {/* Price Progress Bar */}
          <PriceProgressBar position={position} />

          {/* Stop Loss Level */}
          <div class="exit-sl-row">
            <span class="exit-sl-label">🛑 Stop Loss:</span>
            <span class="exit-sl-price">{formatPrice(position.stopLossPrice)}</span>
            <span class="exit-sl-percent">({position.stopLossPercent}%)</span>
          </div>

          {/* Trailing Stop (if active) */}
          {position.trailingStopActive && (
            <div class="exit-trailing-row">
              <span class="exit-trailing-label">📉 Trailing Stop:</span>
              <span class="exit-trailing-high">
                High: {formatPrice(position.trailingStopHighPrice)}
              </span>
              <span class="exit-trailing-pct">{position.trailingStopPercent}% drop</span>
            </div>
          )}

          {/* TP Ladder */}
          <div class="exit-tp-ladder" role="list" aria-label="Take profit ladder">
            <span class="exit-tp-title">Take Profit Ladder:</span>
            {position.tpLevels.map((level, idx) => (
              <TpLevelRow key={idx} level={level} index={idx} />
            ))}
          </div>

          {/* Active Alerts */}
          {position.activeAlerts.length > 0 && (
            <div class="exit-alerts" role="log" aria-label="Active exit alerts">
              <span class="exit-alerts-title">⚠️ Alerts:</span>
              {position.activeAlerts.map((alert, idx) => (
                <AlertBadge key={idx} alert={alert} />
              ))}
            </div>
          )}

          {/* Exit History */}
          {position.exitHistory.length > 0 && (
            <div class="exit-history" role="list" aria-label="Exit history">
              <span class="exit-history-title">📜 Exit History:</span>
              {position.exitHistory.map((exit, idx) => (
                <ExitHistoryRow key={idx} exit={exit} index={idx} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export { ExitStrategy };
