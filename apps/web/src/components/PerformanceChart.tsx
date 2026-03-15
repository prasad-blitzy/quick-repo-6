/**
 * Performance Chart Visualization — `apps/web/src/components/PerformanceChart.tsx`
 *
 * Recharts-based performance visualization component for the Trading Intelligence
 * dashboard. Displays win/loss ratio over time using grouped bar charts, and an
 * optional per-market breakdown section showing wins, losses, and win rate.
 *
 * Consumed by: `apps/web/src/pages/Performance.tsx`
 *
 * Design constraints:
 * - Dark theme: chart colors match globals.css CSS custom property values
 * - Financial precision (AAP Rule 0.7.2): P&L values stored as strings;
 *   parsed to numbers only for chart rendering
 * - TypeScript strict mode (AAP Rule 0.7.1): no `any` types
 * - ESM-first (AAP Rule 0.7.1): import/export syntax
 * - Recharts ^2.15.x (AAP Section 0.3.1)
 *
 * @module apps/web/src/components/PerformanceChart
 */

import clsx from 'clsx';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { TradePerformance, Market } from '../types';

// ---------------------------------------------------------------------------
// Chart Color Constants (matching globals.css hex values)
// ---------------------------------------------------------------------------

/**
 * Recharts does not reliably resolve CSS custom properties in all prop
 * contexts (e.g., `fill`, `stroke`). We define hex constants here that
 * mirror the values from `:root` in `globals.css` so that chart elements
 * render correctly in every browser.
 */
const CHART_COLORS = {
  /** var(--color-success) — wins, positive P&L */
  success: '#22c55e',
  /** var(--color-danger) — losses, negative P&L */
  danger: '#ef4444',
  /** var(--color-accent) — neutral / cumulative metrics */
  accent: '#6366f1',
  /** var(--color-border) — grid lines */
  grid: '#2a2a3e',
  /** var(--color-text-secondary) — axis labels */
  text: '#a0a0b8',
  /** var(--color-surface) — tooltip background */
  surface: '#1a1a2e',
  /** var(--color-border) — tooltip border */
  border: '#2a2a3e',
  /** var(--color-text-primary) — tooltip text */
  textPrimary: '#e8e8f0',
} as const;

// ---------------------------------------------------------------------------
// Data Interfaces
// ---------------------------------------------------------------------------

/**
 * A single data point for the main win/loss bar chart (X-axis = date).
 *
 * `pnl` is a numeric representation of cumulative P&L — the parent page
 * is responsible for parsing the `TradePerformance.pnlAmount` string
 * into a number before passing it here (AAP Rule 0.7.2).
 */
export interface PerformanceDataPoint {
  /** Date label for the X-axis (e.g., "2026-03-01" or "Mar 1"). */
  date: string;
  /** Count of winning trades in this period. */
  wins: number;
  /** Count of losing trades in this period. */
  losses: number;
  /** Cumulative P&L as a number (parsed from string for chart rendering). */
  pnl: number;
}

/**
 * Per-market performance breakdown data used for the optional second
 * section of the chart component. The `market` field is typed to the
 * shared {@link Market} enum for type-safe filtering and grouping.
 */
export interface MarketBreakdown {
  /** Market category from the shared Market enum. */
  market: Market;
  /** Human-readable display label (e.g., "US Stocks", "Crypto"). */
  label: string;
  /** Count of winning trades in this market. */
  wins: number;
  /** Count of losing trades in this market. */
  losses: number;
  /** Total number of trades in this market. */
  totalTrades: number;
  /** Win rate expressed as a percentage (0–100). */
  winRate: number;
}

/**
 * Utility type that picks the fields from {@link TradePerformance} relevant
 * to chart data transformation. The parent page maps raw `TradePerformance`
 * records into {@link PerformanceDataPoint} arrays by aggregating these fields
 * over date buckets.
 *
 * This type ensures compile-time alignment between the shared domain model
 * and the chart component's data contract.
 */
export type ChartRelevantPerformanceFields = Pick<
  TradePerformance,
  'isWin' | 'pnlAmount' | 'createdAt'
>;

// ---------------------------------------------------------------------------
// Props Interface
// ---------------------------------------------------------------------------

/**
 * Props accepted by the {@link PerformanceChart} component.
 */
interface PerformanceChartProps {
  /** Array of data points for the main win/loss bar chart. */
  data: PerformanceDataPoint[];
  /** Optional per-market performance breakdown. */
  marketBreakdown?: MarketBreakdown[] | undefined;
  /** Optional chart title rendered as an `<h3>`. */
  title?: string | undefined;
  /** Optional additional CSS class(es) for the card container. */
  className?: string | undefined;
}

// ---------------------------------------------------------------------------
// Custom Dark-Themed Tooltip
// ---------------------------------------------------------------------------

/** Shape of a single tooltip payload entry provided by recharts. */
interface TooltipPayloadEntry {
  value: number;
  name: string;
  color: string;
}

/**
 * Custom tooltip component that renders with the application's dark theme
 * instead of the default recharts white tooltip.
 */
function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}): React.JSX.Element | null {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--spacing-3)',
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-text-primary)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <p style={{ fontWeight: 600, marginBlockEnd: 4 }}>{label}</p>
      {payload.map((entry, idx) => (
        <p key={idx} style={{ color: entry.color, margin: 0 }}>
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market Breakdown Stats Grid
// ---------------------------------------------------------------------------

/**
 * Renders a grid of per-market performance statistics when the
 * `marketBreakdown` prop is provided.
 */
function MarketBreakdownGrid({
  breakdown,
}: {
  breakdown: MarketBreakdown[];
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 'var(--spacing-3)',
        marginBlockStart: 'var(--spacing-4)',
      }}
    >
      {breakdown.map((item) => (
        <div
          key={item.label}
          style={{
            backgroundColor: 'var(--color-background)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--spacing-3)',
            border: '1px solid var(--color-border)',
          }}
        >
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginBlockEnd: 'var(--spacing-2)',
            }}
          >
            {item.label}
          </p>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-secondary)',
              marginBlockEnd: 'var(--spacing-1)',
            }}
          >
            <span>
              W:{' '}
              <span style={{ color: CHART_COLORS.success }}>{item.wins}</span>
            </span>
            <span>
              L:{' '}
              <span style={{ color: CHART_COLORS.danger }}>{item.losses}</span>
            </span>
            <span>Total: {item.totalTrades}</span>
          </div>

          {/* Win-rate progress bar */}
          <div
            style={{
              height: 6,
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'var(--color-border)',
              overflow: 'hidden',
              marginBlockStart: 'var(--spacing-1)',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(item.winRate, 100)}%`,
                backgroundColor:
                  item.winRate >= 50
                    ? CHART_COLORS.success
                    : CHART_COLORS.danger,
                borderRadius: 'var(--radius-full)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <p
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-secondary)',
              marginBlockStart: 'var(--spacing-1)',
              textAlign: 'right',
            }}
          >
            {item.winRate.toFixed(1)}% win rate
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Recharts-based performance visualization component.
 *
 * Renders:
 * 1. A grouped bar chart of wins vs losses over time.
 * 2. An optional market breakdown stats grid with win-rate progress bars.
 *
 * All chart colors use hex constants that match the CSS custom property
 * values defined in `globals.css`.
 *
 * @example
 * ```tsx
 * <PerformanceChart
 *   data={[
 *     { date: 'Mar 1', wins: 5, losses: 2, pnl: 320 },
 *     { date: 'Mar 2', wins: 3, losses: 4, pnl: -150 },
 *   ]}
 *   title="Trade Performance"
 * />
 * ```
 */
export default function PerformanceChart({
  data,
  marketBreakdown,
  title,
  className,
}: PerformanceChartProps): React.JSX.Element {
  // -----------------------------------------------------------------------
  // Empty state
  // -----------------------------------------------------------------------
  if (data.length === 0) {
    return (
      <div className={clsx('card', className)}>
        {title !== undefined && title !== '' && (
          <h3
            style={{
              fontSize: 'var(--font-size-xl)',
              fontWeight: 'var(--font-weight-semibold)',
              marginBlockEnd: 'var(--spacing-4)',
              color: 'var(--color-text-primary)',
            }}
          >
            {title}
          </h3>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 200,
            color: 'var(--color-text-tertiary)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          No performance data available
        </div>

        {/* Render market breakdown even when the main chart has no data */}
        {marketBreakdown !== undefined && marketBreakdown.length > 0 && (
          <MarketBreakdownGrid breakdown={marketBreakdown} />
        )}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Data-present render
  // -----------------------------------------------------------------------
  return (
    <div className={clsx('card', className)}>
      {/* Optional chart title */}
      {title !== undefined && title !== '' && (
        <h3
          style={{
            fontSize: 'var(--font-size-xl)',
            fontWeight: 'var(--font-weight-semibold)',
            marginBlockEnd: 'var(--spacing-4)',
            color: 'var(--color-text-primary)',
          }}
        >
          {title}
        </h3>
      )}

      {/* Main win/loss bar chart */}
      <ResponsiveContainer width="100%" height={350}>
        <BarChart data={data}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={CHART_COLORS.grid}
          />
          <XAxis
            dataKey="date"
            stroke={CHART_COLORS.text}
            tick={{ fill: CHART_COLORS.text, fontSize: 12 }}
          />
          <YAxis
            stroke={CHART_COLORS.text}
            tick={{ fill: CHART_COLORS.text, fontSize: 12 }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ color: CHART_COLORS.textPrimary }}
          />
          <Bar
            dataKey="wins"
            name="Wins"
            fill={CHART_COLORS.success}
            radius={[4, 4, 0, 0]}
          />
          <Bar
            dataKey="losses"
            name="Losses"
            fill={CHART_COLORS.danger}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>

      {/* Optional market breakdown section */}
      {marketBreakdown !== undefined && marketBreakdown.length > 0 && (
        <>
          <hr
            style={{
              border: 'none',
              borderBlockStart: '1px solid var(--color-border)',
              marginBlock: 'var(--spacing-4)',
            }}
          />
          <h4
            style={{
              fontSize: 'var(--font-size-lg)',
              fontWeight: 'var(--font-weight-semibold)',
              color: 'var(--color-text-primary)',
              marginBlockEnd: 'var(--spacing-2)',
            }}
          >
            Performance by Market
          </h4>
          <MarketBreakdownGrid breakdown={marketBreakdown} />
        </>
      )}
    </div>
  );
}
