/**
 * src/components/ExitStrategy.tsx — Exit Signal & TP/SL Ladder Display
 *
 * Visualizes the active TP/SL (Take-Profit / Stop-Loss) ladder for a tracked
 * token position, the current price position relative to entry and targets,
 * and any triggered exit alerts.
 *
 * Per AAP §0.5.1 Group 11:
 *   "Shows active TP/SL ladder for tracked positions; visualizes current
 *    price position relative to entry and targets; highlights triggered alerts"
 *
 * Per AAP §0.1.2:
 *   "The ladder strategy: Sell 50% at 2×, 25% at 5×, 25% at 10×, let
 *    remainder ride with trailing stop."
 *
 * Per AAP §0.4.4 (State Management Integration):
 *   ExitStrategy reads from `position-store` (positions, TP/SL levels,
 *   exit alerts) via `usePositionStoreHook`.
 *
 * State management:
 *   Reads the Zustand position-store reactively via `usePositionStoreHook`
 *   from `src/store/index.ts`. The component re-renders whenever the selected
 *   position's state changes (price update, TP trigger, new alert, etc.).
 *
 * @module components/ExitStrategy
 */

import { h } from 'preact';
import type { FunctionComponent } from 'preact';
import { useMemo } from 'preact/hooks';

import { usePositionStoreHook } from '../store/index';
import type {
  Position,
  TpLevel,
  PartialExit,
  ExitAlert,
} from '../store/index';

import type { ExitReason } from '../signals/types';

import { formatPercent, formatPrice, formatTimeAgo } from '../utils/formatting';

// =============================================================================
// Props Interface
// =============================================================================

/**
 * Props for the ExitStrategy component.
 *
 * @property tokenMint — Solana token mint address identifying the position
 *   to display. The component reads the position from the Zustand store
 *   keyed by this mint address. If no position exists for this mint,
 *   the component renders nothing (returns null).
 */
interface ExitStrategyProps {
  tokenMint: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Converts a machine-readable exit reason code into a human-friendly label
 * with an emoji indicator for display in the alerts and exit history sections.
 *
 * Uses the `ExitReason` union type from `src/signals/types.ts` to ensure
 * exhaustive coverage of all possible exit reason values.
 *
 * @param reason — The exit reason code
 * @returns A formatted label string with emoji prefix
 */
function formatExitReason(reason: ExitReason): string {
  const labels: Record<ExitReason, string> = {
    'tp-ladder': '🎯 Take Profit',
    'stop-loss': '🛑 Stop Loss',
    'trailing-stop': '📉 Trailing Stop',
    'dev-sell': '⚠️ Dev Selling',
    'smart-money-exit': '🐋 Smart Money Exit',
    'volume-decline': '📊 Volume Decline',
    'manual': '👤 Manual Exit',
  };
  return labels[reason] ?? reason;
}

/**
 * Determines the CSS class for a P&L color hint value.
 *
 * @param colorHint — Semantic color hint from formatPercent
 * @returns CSS class name for the color
 */
function pnlColorClass(colorHint: 'positive' | 'negative' | 'neutral'): string {
  switch (colorHint) {
    case 'positive':
      return 'exit-pnl-positive';
    case 'negative':
      return 'exit-pnl-negative';
    default:
      return 'exit-pnl-neutral';
  }
}

/**
 * Computes the vertical position (as a percentage from bottom) for a price
 * level on the ladder visualization. This maps the price into a 0-100%
 * range where:
 *   - 0% = the stop-loss price (bottom of ladder)
 *   - 100% = the highest TP level target price (top of ladder)
 *
 * Used to proportionally position the "current price" indicator
 * within the visual ladder.
 *
 * @param price — The price to position
 * @param bottomPrice — The lowest price in the range (stop-loss)
 * @param topPrice — The highest price in the range (max TP target)
 * @returns Percentage (0-100) from bottom, clamped to bounds
 */
function computeLadderPosition(
  price: number,
  bottomPrice: number,
  topPrice: number,
): number {
  if (topPrice <= bottomPrice || topPrice <= 0) return 0;
  const range = topPrice - bottomPrice;
  const offset = price - bottomPrice;
  const pct = (offset / range) * 100;
  return Math.max(0, Math.min(100, pct));
}

// =============================================================================
// ExitStrategy Component
// =============================================================================

/**
 * Renders the exit strategy panel for a single tracked position.
 *
 * Displays:
 * 1. **Position Summary** — token symbol, status badge, remaining position %,
 *    and unrealized P&L percentage with color coding.
 * 2. **TP/SL Ladder** — vertical ladder showing all take-profit levels (from
 *    highest to lowest multiplier), entry price line, stop-loss line, and
 *    the current price indicator positioned proportionally.
 * 3. **Trailing Stop** — when active, shows the trailing stop high-water mark
 *    and the computed trailing stop trigger price.
 * 4. **Active Alerts** — exit alerts (dev-sell, smart-money-exit, volume-decline,
 *    etc.) with severity coloring (critical = red, warning = yellow).
 * 5. **Exit History** — past partial exits showing reason, exit price,
 *    percentage sold, and realized P&L per exit.
 *
 * Returns `null` when no position exists for the given token mint.
 *
 * @param props.tokenMint — Solana token mint address for the tracked position
 */
const ExitStrategy: FunctionComponent<ExitStrategyProps> = ({ tokenMint }) => {
  // ---------------------------------------------------------------------------
  // Store Binding — reactive position data
  // ---------------------------------------------------------------------------

  const position = usePositionStoreHook(
    (state) => state.positions[tokenMint],
  );

  // ---------------------------------------------------------------------------
  // Null Guard — return nothing if no position exists for this mint
  // ---------------------------------------------------------------------------

  if (!position) {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Memoized Computed Values
  // ---------------------------------------------------------------------------

  const computed = useMemo(() => {
    // Current price multiplier relative to entry
    const currentMultiplier =
      position.entryPrice > 0
        ? position.currentPrice / position.entryPrice
        : 0;

    // Stop-loss price is pre-computed on the Position object
    const stopLossPrice = position.stopLossPrice;

    // Trailing stop trigger price: highPrice adjusted by trailingStopPercent
    // trailingStopPercent is negative (e.g., -15 means 15% below the high)
    const trailingStopTriggerPrice = position.trailingStopActive
      ? position.trailingStopHighPrice *
        (1 + position.trailingStopPercent / 100)
      : null;

    // Unrealized P&L formatted with sign and color hint
    const pnl = formatPercent(position.unrealizedPnlPercent);

    // TP levels sorted highest-to-lowest for top-down ladder display
    const tpLevelsSorted = [...position.tpLevels].sort(
      (a, b) => b.multiplier - a.multiplier,
    );

    // Determine the price range for ladder positioning
    const maxTpPrice =
      tpLevelsSorted.length > 0 ? tpLevelsSorted[0].targetPrice : 0;
    const ladderBottom = stopLossPrice;
    const ladderTop = maxTpPrice;

    // Current price position as percentage on the ladder (0% = SL, 100% = max TP)
    const currentPricePosition = computeLadderPosition(
      position.currentPrice,
      ladderBottom,
      ladderTop,
    );

    return {
      currentMultiplier,
      stopLossPrice,
      trailingStopTriggerPrice,
      pnl,
      tpLevelsSorted,
      currentPricePosition,
      ladderBottom,
      ladderTop,
    };
  }, [position]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="exit-strategy" role="region" aria-label="Exit strategy">
      {/* ================================================================= */}
      {/* Position Summary Header                                           */}
      {/* ================================================================= */}
      <div class="exit-summary">
        <div class="exit-summary-top">
          <span class="exit-token-symbol">{position.tokenSymbol}</span>
          <span
            class={`exit-status-badge exit-status-${position.status}`}
            aria-label={`Position status: ${position.status}`}
          >
            {position.status}
          </span>
        </div>

        <div class="exit-summary-metrics">
          <div class="exit-metric">
            <span class="exit-metric-label">P&L</span>
            <span
              class={`exit-metric-value ${pnlColorClass(computed.pnl.colorHint)}`}
            >
              {computed.pnl.text}
            </span>
          </div>
          <div class="exit-metric">
            <span class="exit-metric-label">Remaining</span>
            <span class="exit-metric-value">
              {position.remainingPercent.toFixed(0)}%
            </span>
          </div>
          <div class="exit-metric">
            <span class="exit-metric-label">Current</span>
            <span class="exit-metric-value">
              {formatPrice(position.currentPrice)}
            </span>
          </div>
          <div class="exit-metric">
            <span class="exit-metric-label">Multiplier</span>
            <span
              class={`exit-metric-value ${
                computed.currentMultiplier >= 1
                  ? 'exit-pnl-positive'
                  : 'exit-pnl-negative'
              }`}
            >
              {computed.currentMultiplier.toFixed(2)}×
            </span>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* TP/SL Ladder Visualization                                        */}
      {/* ================================================================= */}
      <div
        class="exit-ladder"
        role="list"
        aria-label="Take-profit and stop-loss ladder"
      >
        {/* TP levels from highest to lowest multiplier */}
        {computed.tpLevelsSorted.map((level: TpLevel) => (
          <div
            class={`ladder-level ladder-level-tp ${
              level.triggered ? 'ladder-level-triggered' : ''
            }`}
            role="listitem"
            key={level.multiplier}
            aria-label={`Take profit ${level.multiplier}× — sell ${level.sellPercent}%${
              level.triggered ? ', triggered' : ''
            }`}
          >
            <span class="level-indicator" aria-hidden="true">
              {level.triggered ? '✅' : '⏳'}
            </span>
            <span class="level-label">
              TP {level.multiplier}× ({level.sellPercent}%)
            </span>
            <span class="level-price">
              {formatPrice(level.targetPrice)}
            </span>
            {level.triggered && (
              <span class="triggered-badge">✓ Sold</span>
            )}
            {level.triggered && level.triggeredAt !== null && (
              <span class="level-time">
                {formatTimeAgo(level.triggeredAt)}
              </span>
            )}
          </div>
        ))}

        {/* Current price indicator — positioned proportionally on the ladder */}
        <div
          class="ladder-level ladder-level-current"
          role="listitem"
          aria-label={`Current price: ${formatPrice(
            position.currentPrice,
          )} (${computed.currentMultiplier.toFixed(2)}×)`}
          style={{
            '--ladder-position': `${computed.currentPricePosition}%`,
          }}
        >
          <span class="level-indicator" aria-hidden="true">
            ▶
          </span>
          <span class="level-label">
            Now: {formatPrice(position.currentPrice)} (
            {computed.currentMultiplier.toFixed(2)}×)
          </span>
        </div>

        {/* Entry price line */}
        <div
          class="ladder-level ladder-level-entry"
          role="listitem"
          aria-label={`Entry price: ${formatPrice(position.entryPrice)}`}
        >
          <span class="level-indicator" aria-hidden="true">
            📍
          </span>
          <span class="level-label">
            Entry: {formatPrice(position.entryPrice)}
          </span>
        </div>

        {/* Stop-loss line */}
        <div
          class={`ladder-level ladder-level-sl`}
          role="listitem"
          aria-label={`Stop loss: ${formatPrice(computed.stopLossPrice)} (${position.stopLossPercent}%)`}
        >
          <span class="level-indicator" aria-hidden="true">
            🛑
          </span>
          <span class="level-label">
            SL: {formatPrice(computed.stopLossPrice)} (
            {position.stopLossPercent}%)
          </span>
        </div>
      </div>

      {/* ================================================================= */}
      {/* Trailing Stop (shown only when active)                            */}
      {/* ================================================================= */}
      {position.trailingStopActive && computed.trailingStopTriggerPrice !== null && (
        <div
          class="exit-trailing-stop"
          aria-label="Trailing stop information"
        >
          <div class="exit-trailing-header">
            <span class="exit-trailing-icon" aria-hidden="true">
              📉
            </span>
            <span class="exit-trailing-title">Trailing Stop</span>
          </div>
          <div class="exit-trailing-details">
            <div class="exit-trailing-detail">
              <span class="exit-trailing-label">High</span>
              <span class="exit-trailing-value">
                {formatPrice(position.trailingStopHighPrice)}
              </span>
            </div>
            <div class="exit-trailing-detail">
              <span class="exit-trailing-label">Trigger</span>
              <span class="exit-trailing-value">
                {formatPrice(computed.trailingStopTriggerPrice)}
              </span>
            </div>
            <div class="exit-trailing-detail">
              <span class="exit-trailing-label">Distance</span>
              <span class="exit-trailing-value">
                {Math.abs(position.trailingStopPercent).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* Active Alerts                                                     */}
      {/* ================================================================= */}
      {position.activeAlerts.length > 0 && (
        <div
          class="exit-alerts"
          role="log"
          aria-label="Active exit alerts"
        >
          <div class="exit-alerts-header">
            <span aria-hidden="true">⚠</span>
            <span>Active Alerts</span>
          </div>
          {position.activeAlerts.map((alert: ExitAlert, idx: number) => (
            <div
              class={`exit-alert exit-alert-${alert.severity}`}
              role="alert"
              key={`${alert.type}-${alert.timestamp}-${idx}`}
              aria-label={`${alert.severity} alert: ${alert.message}`}
            >
              <span class="exit-alert-type">
                {formatExitReason(alert.type as ExitReason)}
              </span>
              <span class="exit-alert-message">{alert.message}</span>
              <span class="exit-alert-time">
                {formatTimeAgo(alert.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ================================================================= */}
      {/* Exit History                                                      */}
      {/* ================================================================= */}
      {position.exitHistory.length > 0 && (
        <div
          class="exit-history"
          role="list"
          aria-label="Exit history"
        >
          <div class="exit-history-header">
            <span aria-hidden="true">📜</span>
            <span>Exit History</span>
          </div>
          {position.exitHistory.map(
            (exit: PartialExit, idx: number) => {
              const exitPnl = formatPercent(exit.realizedPnlPercent);
              return (
                <div
                  class="exit-history-row"
                  role="listitem"
                  key={`${exit.timestamp}-${idx}`}
                  aria-label={`Exit: ${exit.exitPercent}% at ${formatPrice(exit.exitPrice)}`}
                >
                  <span class="exit-history-reason">
                    {formatExitReason(exit.reason as ExitReason)}
                  </span>
                  <span class="exit-history-percent">
                    {exit.exitPercent}%
                  </span>
                  <span class="exit-history-price">
                    {formatPrice(exit.exitPrice)}
                  </span>
                  <span
                    class={`exit-history-pnl ${pnlColorClass(exitPnl.colorHint)}`}
                  >
                    {exitPnl.text}
                  </span>
                  <span class="exit-history-time">
                    {formatTimeAgo(exit.timestamp)}
                  </span>
                </div>
              );
            },
          )}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Exports
// =============================================================================

export { ExitStrategy };
