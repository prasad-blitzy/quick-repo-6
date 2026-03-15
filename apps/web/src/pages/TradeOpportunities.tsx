/**
 * Trade Opportunities Board Page — `apps/web/src/pages/TradeOpportunities.tsx`
 *
 * Route-level page component for the trade opportunities board at `/opportunities`.
 * Displays a filterable, sortable card grid of trade opportunities (LONG/SHORT
 * recommendations) with comprehensive filter controls and responsive layout.
 *
 * Features:
 * - Market, status, direction, timeframe, and confidence threshold filters
 * - Sortable by date, confidence, risk:reward, or symbol
 * - Responsive card grid (1 → 2 → 3 columns via globals.css `.card-grid`)
 * - 30-second polling for automatic data refresh (AAP §0.6.2 — no WebSocket)
 * - Loading, error, and empty states with accessible ARIA markup
 * - Pagination controls with previous/next navigation
 *
 * Architecture:
 * - Composes `useOpportunities` hook for paginated + filtered data fetching
 * - Composes `FilterBar` component for market, sort, and search controls
 * - Extended page-specific filters (status, direction, timeframe, confidence)
 *   passed via FilterBar's `children` prop slot
 * - Dark theme CSS custom properties from `globals.css`
 * - TypeScript strict mode: no `any`, `exactOptionalPropertyTypes` enabled
 *
 * CRITICAL — Financial Precision (AAP Rule 0.7.2):
 * Price fields (`entryPrice`, `stopLoss`, `takeProfit`, `riskRewardRatio`) are
 * `string` in TradeOpportunity. They are displayed as-is via TradeCard — NEVER
 * passed through `parseFloat()`, `Number()`, or `.toFixed()`.
 *
 * @module apps/web/src/pages/TradeOpportunities
 */

import { useCallback, type ChangeEvent } from 'react';
import clsx from 'clsx';

import { useOpportunities } from '../hooks/useOpportunities';
import TradeCard from '../components/TradeCard';
import FilterBar from '../components/FilterBar';
import type { OpportunityStatus, Direction, Timeframe } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sort column options for the FilterBar's sort-by dropdown.
 * Maps query parameter values to human-readable labels.
 */
const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'createdAt', label: 'Date' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'riskRewardRatio', label: 'Risk:Reward' },
  { value: 'symbol', label: 'Symbol' },
];

/**
 * Polling interval in milliseconds for automatic data refresh.
 * Per AAP §0.6.2: polling-based refresh only — NO WebSocket.
 */
const POLLING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Inline Styles — layout patterns not covered by globals.css utility classes
//
// FilterBar.tsx already uses static style objects for its layout, so this
// pattern is established in the codebase. These are static constants
// allocated once — not re-created on every render.
// ---------------------------------------------------------------------------

/**
 * Page header layout: horizontal space-between with bottom-aligned items.
 * The `.page-header` class from globals.css provides only `margin-bottom`;
 * this adds the flexbox layout for title + total count alignment.
 */
const pageHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
};

/**
 * Filter bar wrapper: bottom margin for visual separation from the
 * content area below (card grid, error/loading/empty states).
 */
const filterAreaStyle: React.CSSProperties = {
  marginBlockEnd: 'var(--spacing-6)',
};

/**
 * Error banner: danger-tinted panel with horizontal layout.
 * Matches the error pattern described in AAP Phase 6.
 */
const errorBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--spacing-4)',
  padding: 'var(--spacing-4)',
  backgroundColor: 'var(--color-danger-bg)',
  border: '1px solid var(--color-danger)',
  borderRadius: 'var(--radius-lg)',
  color: 'var(--color-danger)',
  marginBlockEnd: 'var(--spacing-6)',
};

/** Loading container: centred layout with generous vertical padding. */
const loadingContainerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  padding: 'var(--spacing-12) var(--spacing-4)',
  color: 'var(--color-text-secondary)',
};

/**
 * Pagination control bar: centred row with top divider line.
 * Per AAP Phase 6 pagination controls specification.
 */
const paginationStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 'var(--spacing-4)',
  marginBlockStart: 'var(--spacing-6)',
  paddingBlockStart: 'var(--spacing-4)',
  borderBlockStart: '1px solid var(--color-border)',
};

/**
 * Confidence filter container: vertical stack with label above slider.
 * Used inside FilterBar's children slot for the confidence threshold control.
 */
const confidenceFilterStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-1)',
  minWidth: '140px',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Trade Opportunities board page component.
 *
 * Renders a filterable, sortable card grid of AI-generated trade
 * opportunities. Data fetching, filtering, sorting, and pagination are
 * fully delegated to the `useOpportunities` hook. This component
 * orchestrates the UI layout and delegates state changes to the hook.
 *
 * Rendered inside DashboardLayout via App.tsx route configuration.
 *
 * @returns The rendered trade opportunities page.
 */
export default function TradeOpportunities() {
  // -----------------------------------------------------------------------
  // Data & State — delegated to useOpportunities hook
  // -----------------------------------------------------------------------

  const {
    opportunities,
    pagination,
    loading,
    error,
    refetch,
    filters,
    setPage,
    setMarket,
    setStatus,
    setDirection,
    setMinConfidence,
    setTimeframe,
    setSortBy,
    setSortOrder,
  } = useOpportunities({ pollingInterval: POLLING_INTERVAL_MS });

  // -----------------------------------------------------------------------
  // Event Handlers — memoised with useCallback for stable references
  // -----------------------------------------------------------------------

  /**
   * Handles status filter dropdown changes.
   * Converts the string value back to an OpportunityStatus or null.
   * Empty string value selects "All Status" (no filter).
   */
  const handleStatusChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>): void => {
      const val = e.target.value;
      setStatus(val === '' ? null : (val as OpportunityStatus));
    },
    [setStatus],
  );

  /**
   * Handles direction filter dropdown changes.
   * Converts the string value back to a Direction or null.
   * Empty string value selects "All Directions" (no filter).
   */
  const handleDirectionChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>): void => {
      const val = e.target.value;
      setDirection(val === '' ? null : (val as Direction));
    },
    [setDirection],
  );

  /**
   * Handles timeframe filter dropdown changes.
   * Converts the string value back to a Timeframe or null.
   * Empty string value selects "All Timeframes" (no filter).
   */
  const handleTimeframeChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>): void => {
      const val = e.target.value;
      setTimeframe(val === '' ? null : (val as Timeframe));
    },
    [setTimeframe],
  );

  /**
   * Handles confidence threshold slider changes.
   * Converts the UI range (0–100 integer) to the API range (0.00–1.00).
   * Setting the slider to 0 clears the filter (null = "Any").
   */
  const handleConfidenceChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const val = parseInt(e.target.value, 10);
      setMinConfidence(val === 0 ? null : val / 100);
    },
    [setMinConfidence],
  );

  /**
   * Stub handler for FilterBar search input.
   * The opportunities API endpoint does not currently support free-text
   * search. This handler satisfies the FilterBar's required prop contract.
   */
  const handleSearchChange = useCallback((): void => {
    /* Search not implemented for the opportunities endpoint */
  }, []);

  /**
   * Navigates to the previous page.
   * Guarded: only fires when current page is greater than 1.
   */
  const handlePreviousPage = useCallback((): void => {
    if (pagination !== null && pagination.page > 1) {
      setPage(pagination.page - 1);
    }
  }, [pagination, setPage]);

  /**
   * Navigates to the next page.
   * Guarded: only fires when current page is less than totalPages.
   */
  const handleNextPage = useCallback((): void => {
    if (pagination !== null && pagination.page < pagination.totalPages) {
      setPage(pagination.page + 1);
    }
  }, [pagination, setPage]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <section aria-label="Trade Opportunities">
      {/* ── Page Header ──────────────────────────────────────────── */}
      <div className="page-header" style={pageHeaderStyle}>
        <div>
          <h1 className="page-title">📊 Trade Opportunities</h1>
          <p className={clsx('text-secondary', 'text-sm')}>
            AI-generated trade recommendations with confidence scores
          </p>
        </div>
        {pagination !== null && (
          <span className={clsx('text-xs', 'text-secondary')}>
            {pagination.total} opportunities found
          </span>
        )}
      </div>

      {/* ── Filter Bar with Extended Controls ─────────────────────── */}
      <div style={filterAreaStyle}>
        <FilterBar
          market={filters.market}
          onMarketChange={setMarket}
          sortBy={filters.sortBy}
          onSortByChange={setSortBy}
          sortOrder={filters.sortOrder}
          onSortOrderChange={setSortOrder}
          search=""
          onSearchChange={handleSearchChange}
          sortOptions={SORT_OPTIONS}
        >
          {/* Status filter dropdown */}
          <select
            value={filters.status ?? ''}
            onChange={handleStatusChange}
            className="filter-select"
            aria-label="Filter by status"
          >
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>

          {/* Direction filter dropdown — emoji indicators per AAP Rule 0.7.5 */}
          <select
            value={filters.direction ?? ''}
            onChange={handleDirectionChange}
            className="filter-select"
            aria-label="Filter by direction"
          >
            <option value="">All Directions</option>
            <option value="long">🟢 Long</option>
            <option value="short">🔴 Short</option>
          </select>

          {/* Timeframe filter dropdown */}
          <select
            value={filters.timeframe ?? ''}
            onChange={handleTimeframeChange}
            className="filter-select"
            aria-label="Filter by timeframe"
          >
            <option value="">All Timeframes</option>
            <option value="intraday">Intraday</option>
            <option value="swing">Swing</option>
            <option value="position">Positional</option>
          </select>

          {/* Confidence threshold slider — converts 0–100 (UI) ↔ 0.00–1.00 (API) */}
          <div style={confidenceFilterStyle}>
            <label className={clsx('filter-label', 'text-xs', 'text-secondary')}>
              Min Confidence:{' '}
              {filters.minConfidence !== null
                ? `${Math.round(filters.minConfidence * 100)}%`
                : 'Any'}
            </label>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={
                filters.minConfidence !== null
                  ? Math.round(filters.minConfidence * 100)
                  : 0
              }
              onChange={handleConfidenceChange}
              className="confidence-slider"
              aria-label="Minimum confidence threshold"
            />
          </div>
        </FilterBar>
      </div>

      {/* ── Error State ──────────────────────────────────────────── */}
      {error !== null && (
        <div style={errorBannerStyle} role="alert">
          <p>Failed to load opportunities: {error}</p>
          <button
            className="btn btn-outline"
            onClick={refetch}
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Loading State (initial fetch only) ───────────────────── */}
      {loading && opportunities.length === 0 && (
        <div style={loadingContainerStyle} aria-live="polite">
          <div className="animate-pulse">Loading opportunities…</div>
        </div>
      )}

      {/* ── Opportunities Card Grid ──────────────────────────────── */}
      {opportunities.length > 0 && (
        <div className="card-grid">
          {opportunities.map((opportunity) => (
            <TradeCard key={opportunity.id} opportunity={opportunity} />
          ))}
        </div>
      )}

      {/* ── Empty State ──────────────────────────────────────────── */}
      {!loading && opportunities.length === 0 && error === null && (
        <div className="empty-state">
          <p className="text-secondary">
            No trade opportunities match your filters
          </p>
          <p className={clsx('text-xs', 'text-secondary')}>
            Try adjusting your filters or check back later
          </p>
        </div>
      )}

      {/* ── Pagination Controls ──────────────────────────────────── */}
      {pagination !== null && pagination.totalPages > 1 && (
        <nav style={paginationStyle} aria-label="Pagination">
          <button
            className="btn btn-outline"
            disabled={pagination.page <= 1}
            onClick={handlePreviousPage}
            type="button"
          >
            ← Previous
          </button>
          <span className={clsx('text-sm', 'text-secondary')}>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            className="btn btn-outline"
            disabled={pagination.page >= pagination.totalPages}
            onClick={handleNextPage}
            type="button"
          >
            Next →
          </button>
        </nav>
      )}
    </section>
  );
}
