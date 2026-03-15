/**
 * Historical Performance Dashboard Page — `apps/web/src/pages/Performance.tsx`
 *
 * Route-level page component for `/performance` that displays trading
 * performance visualisations: summary statistics, win/loss charts,
 * cumulative P&L, per-market breakdowns, and accuracy trends over time.
 *
 * Architecture:
 * - No component library — custom page styled with dark-theme CSS
 *   custom properties from `globals.css`.
 * - Polling-based refresh (AAP §0.6.2) via the `useApi` hook at 60 s
 *   interval — no WebSocket.
 * - Financial precision (AAP Rule 0.7.2): all P&L string values are
 *   displayed as-is without `parseFloat`.
 * - TypeScript strict mode (AAP Rule 0.7.1): no `any` types.
 * - React 19.x automatic JSX runtime — no `import React` required.
 *
 * Consumed by: `App.tsx` route configuration (rendered inside
 * `DashboardLayout`).
 *
 * @module apps/web/src/pages/Performance
 */

import { useState, useMemo } from 'react';
import clsx from 'clsx';

import { useApi } from '../hooks/useApi';
import PerformanceChart from '../components/PerformanceChart';
import type { TradePerformance, Market, PaginatedResponse } from '../types';

// ---------------------------------------------------------------------------
// Local Type Definitions — API Response Shape
// ---------------------------------------------------------------------------

/**
 * Aggregate summary statistics for the performance dashboard header.
 *
 * All monetary values are `string` to preserve PostgreSQL `numeric(12,4)`
 * precision (AAP Rule 0.7.2). They must NEVER be converted via
 * `parseFloat` for display — render them as-is.
 */
interface PerformanceSummary {
  /** Total number of closed trades in the selected period. */
  totalTrades: number;
  /** Number of winning trades (P&L > 0). */
  wins: number;
  /** Number of losing trades (P&L ≤ 0). */
  losses: number;
  /** Win rate ratio in range 0.00–1.00 (multiply by 100 for %). */
  winRate: number;
  /** Cumulative P&L as a string — financial precision (AAP Rule 0.7.2). */
  totalPnl: string;
  /** Average P&L per trade as a string. */
  averagePnl: string;
  /** Best single-trade P&L as a string. */
  bestTrade: string;
  /** Worst single-trade P&L as a string. */
  worstTrade: string;
  /** Human-readable average hold time (e.g., "2d 4h"). */
  averageHoldTime: string;
}

/**
 * A single data point for the win/loss time-series chart.
 *
 * `pnl` is a numeric value (already parsed from the string representation)
 * because Recharts requires number types for chart rendering.
 */
interface PerformanceDataPoint {
  /** Date label for the X-axis (e.g., "2026-03-01"). */
  date: string;
  /** Count of winning trades in this bucket. */
  wins: number;
  /** Count of losing trades in this bucket. */
  losses: number;
  /** Cumulative P&L as a number — pre-parsed for chart rendering. */
  pnl: number;
}

/**
 * Per-market performance breakdown from the API.
 *
 * `winRate` arrives in 0.00–1.00 range from the API.
 * The PerformanceChart component expects 0–100, so we transform
 * via `useMemo` before passing to the chart.
 */
interface MarketBreakdown {
  /** Market identifier (one of the Market enum values). */
  market: string;
  /** Count of winning trades in this market. */
  wins: number;
  /** Count of losing trades in this market. */
  losses: number;
  /** Total closed trades in this market. */
  totalTrades: number;
  /** Win rate ratio in range 0.00–1.00. */
  winRate: number;
}

/**
 * Full API response envelope for `GET /api/performance`.
 *
 * `recentTrades` is typed via `PaginatedResponse<TradePerformance>['data']`
 * to ensure compile-time alignment with the paginated API contract while
 * allowing the performance endpoint to embed the array directly.
 */
interface PerformanceResponse {
  /** Aggregate summary statistics. */
  summary: PerformanceSummary;
  /** Time-series data for the win/loss bar chart. */
  chartData: PerformanceDataPoint[];
  /** Per-market performance breakdown. */
  marketBreakdown: MarketBreakdown[];
  /** Most recent closed trades (array extracted from paginated response shape). */
  recentTrades: PaginatedResponse<TradePerformance>['data'];
}

// ---------------------------------------------------------------------------
// Market Display Labels
// ---------------------------------------------------------------------------

/** Human-readable labels for the market filter dropdown options. */
const MARKET_LABELS: Record<string, string> = {
  us_stock: '🇺🇸 US Stocks',
  indian_equity: '🇮🇳 India',
  crypto: '₿ Crypto',
  social: '💬 Social',
};

/**
 * Returns a human-readable label for a market identifier.
 * Falls back to the raw identifier when no label is configured.
 */
function getMarketLabel(market: string): string {
  return MARKET_LABELS[market] ?? market;
}

// ---------------------------------------------------------------------------
// Performance Page Component
// ---------------------------------------------------------------------------

/**
 * Historical performance dashboard page.
 *
 * Displays:
 * 1. Summary statistics grid (6 KPI cards)
 * 2. Date-range and market filter controls
 * 3. Win/loss distribution chart (via PerformanceChart)
 * 4. Per-market breakdown cards
 *
 * @returns The rendered Performance page element.
 */
export default function Performance(): React.JSX.Element {
  // -------------------------------------------------------------------------
  // Filter State
  // -------------------------------------------------------------------------

  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [marketFilter, setMarketFilter] = useState<Market | null>(null);

  // -------------------------------------------------------------------------
  // Data Fetching — 60 s polling interval
  // -------------------------------------------------------------------------

  const params = useMemo(
    () => ({
      ...(dateFrom !== '' ? { dateFrom } : {}),
      ...(dateTo !== '' ? { dateTo } : {}),
      ...(marketFilter !== null ? { market: marketFilter } : {}),
    }),
    [dateFrom, dateTo, marketFilter],
  );

  const { data, loading, error, refetch } = useApi<PerformanceResponse>(
    '/performance',
    {
      params,
      pollingInterval: 60_000,
    },
  );

  // -------------------------------------------------------------------------
  // Chart Data Transform — adapt API MarketBreakdown → PerformanceChart props
  // -------------------------------------------------------------------------

  /**
   * The PerformanceChart component's `MarketBreakdown` type expects:
   *   - `market: Market` (enum)
   *   - `label: string`
   *   - `winRate` in 0–100 range
   *
   * The API returns `market: string` and `winRate` in 0–1 range.
   * This memo bridges the two by adding the `label` field and scaling
   * `winRate` to a percentage.
   */
  const chartMarketBreakdown = useMemo(() => {
    if (!data?.marketBreakdown || data.marketBreakdown.length === 0) {
      return undefined;
    }
    return data.marketBreakdown.map((mb) => ({
      market: mb.market as Market,
      label: getMarketLabel(mb.market),
      wins: mb.wins,
      losses: mb.losses,
      totalTrades: mb.totalTrades,
      winRate: mb.winRate * 100,
    }));
  }, [data?.marketBreakdown]);

  // -------------------------------------------------------------------------
  // Render — Error State
  // -------------------------------------------------------------------------

  if (error !== null) {
    return (
      <section>
        <div className="page-header">
          <h1 className="page-title">📈 Performance</h1>
          <p className="text-secondary text-sm">
            Historical trading performance and analytics
          </p>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="empty-state">
            <div className="empty-state-icon">⚠️</div>
            <p className="empty-state-title">Failed to Load Performance Data</p>
            <p className="empty-state-description">{error}</p>
            <button
              type="button"
              className="btn btn-outline"
              onClick={refetch}
              style={{ marginBlockStart: 'var(--spacing-4)' }}
            >
              Retry
            </button>
          </div>
        </div>
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // Render — Loading State
  // -------------------------------------------------------------------------

  if (loading && data === null) {
    return (
      <section>
        <div className="page-header">
          <h1 className="page-title">📈 Performance</h1>
          <p className="text-secondary text-sm">
            Historical trading performance and analytics
          </p>
        </div>
        {/* Skeleton stat cards */}
        <div className="stats-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="stat-card animate-pulse">
              <span
                className="stat-label"
                style={{ width: '60%', height: '0.75rem', display: 'block' }}
              >
                &nbsp;
              </span>
              <span
                className="stat-value"
                style={{ width: '40%', height: '1.5rem', display: 'block' }}
              >
                &nbsp;
              </span>
            </div>
          ))}
        </div>
        {/* Skeleton chart */}
        <div
          className="card animate-pulse"
          style={{ height: 400, marginBlockEnd: 'var(--spacing-6)' }}
        >
          &nbsp;
        </div>
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // Render — Empty State (data loaded but nothing to show)
  // -------------------------------------------------------------------------

  const hasData =
    data !== null &&
    (data.summary.totalTrades > 0 ||
      data.chartData.length > 0 ||
      data.marketBreakdown.length > 0);

  // -------------------------------------------------------------------------
  // Render — Main Dashboard
  // -------------------------------------------------------------------------

  return (
    <section>
      {/* Page Header */}
      <div className="page-header">
        <h1 className="page-title">📈 Performance</h1>
        <p className="text-secondary text-sm">
          Historical trading performance and analytics
        </p>
      </div>

      {/* Filter Controls */}
      <div className="performance-filters">
        <div className="filter-group">
          <label className="filter-label text-xs text-secondary" htmlFor="perf-date-from">
            From
          </label>
          <input
            id="perf-date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); }}
            className="filter-input"
          />
        </div>
        <div className="filter-group">
          <label className="filter-label text-xs text-secondary" htmlFor="perf-date-to">
            To
          </label>
          <input
            id="perf-date-to"
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); }}
            className="filter-input"
          />
        </div>
        <div className="filter-group">
          <label className="filter-label text-xs text-secondary" htmlFor="perf-market">
            Market
          </label>
          <select
            id="perf-market"
            value={marketFilter ?? ''}
            onChange={(e) => {
              setMarketFilter(
                e.target.value === '' ? null : (e.target.value as Market),
              );
            }}
            className="filter-select"
          >
            <option value="">All Markets</option>
            <option value="us_stock">🇺🇸 US</option>
            <option value="indian_equity">🇮🇳 India</option>
            <option value="crypto">₿ Crypto</option>
          </select>
        </div>
      </div>

      {/* Summary Statistics Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Total Trades</span>
          <span className="stat-value font-mono">
            {data?.summary.totalTrades ?? 0}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Win Rate</span>
          <span
            className={clsx(
              'stat-value font-mono',
              (data?.summary.winRate ?? 0) >= 0.5
                ? 'text-success'
                : 'text-danger',
            )}
          >
            {data?.summary.winRate !== undefined
              ? `${(data.summary.winRate * 100).toFixed(1)}%`
              : '—'}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Total P&amp;L</span>
          <span
            className={clsx(
              'stat-value font-mono',
              data?.summary.totalPnl !== undefined &&
                data.summary.totalPnl !== '' &&
                !data.summary.totalPnl.startsWith('-')
                ? 'text-success'
                : 'text-danger',
            )}
          >
            {data?.summary.totalPnl ?? '—'}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Avg P&amp;L per Trade</span>
          <span className="stat-value font-mono">
            {data?.summary.averagePnl ?? '—'}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Best Trade</span>
          <span className="stat-value font-mono text-success">
            {data?.summary.bestTrade ?? '—'}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Worst Trade</span>
          <span className="stat-value font-mono text-danger">
            {data?.summary.worstTrade ?? '—'}
          </span>
        </div>
      </div>

      {/* Empty State — shown when filters return no data */}
      {!hasData && data !== null && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📊</div>
            <p className="empty-state-title">No Performance Data</p>
            <p className="empty-state-description">
              No closed trades found for the selected period. Performance
              data appears once trade opportunities are resolved.
            </p>
          </div>
        </div>
      )}

      {/* Win/Loss Distribution Chart */}
      {hasData && (
        <PerformanceChart
          data={data?.chartData ?? []}
          marketBreakdown={chartMarketBreakdown}
          title="Win/Loss Distribution Over Time"
        />
      )}

      {/* Per-Market Breakdown Grid */}
      {data?.marketBreakdown !== undefined &&
        data.marketBreakdown.length > 0 && (
          <div className="market-breakdown">
            <h2 className="section-title">Performance by Market</h2>
            <div className="market-breakdown-grid">
              {data.marketBreakdown.map((mb) => (
                <div key={mb.market} className="card market-card">
                  <h3 className="text-lg font-semibold">
                    {getMarketLabel(mb.market)}
                  </h3>
                  <div className="market-stats">
                    <div>
                      <span className="text-xs text-secondary">Trades</span>
                      <span className="font-mono">{mb.totalTrades}</span>
                    </div>
                    <div>
                      <span className="text-xs text-secondary">Wins</span>
                      <span className="font-mono text-success">{mb.wins}</span>
                    </div>
                    <div>
                      <span className="text-xs text-secondary">Losses</span>
                      <span className="font-mono text-danger">
                        {mb.losses}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-secondary">Win Rate</span>
                      <span
                        className={clsx(
                          'font-mono',
                          mb.winRate >= 0.5 ? 'text-success' : 'text-danger',
                        )}
                      >
                        {(mb.winRate * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
    </section>
  );
}
