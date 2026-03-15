/**
 * Trade Opportunities Data Hook — `apps/web/src/hooks/useOpportunities.ts`
 *
 * Custom React hook that wraps the generic `useApi` hook specifically for
 * the `GET /api/opportunities` endpoint. Provides:
 *
 * - **Filterable trade opportunities** — market, status, direction,
 *   confidence threshold, and timeframe filters with individual setter
 *   functions for each filter dimension
 * - **Sortable results** — configurable sort field and direction
 * - **Pagination** — page navigation with automatic reset to page 1
 *   when any filter changes
 * - **Polling-based refresh** — configurable auto-refresh interval
 *   (default 30 seconds) per AAP §0.6.2 (no WebSocket)
 * - **Referentially stable callbacks** — all setter functions are
 *   memoised with `useCallback` to prevent unnecessary child re-renders
 *
 * Consumed by: `apps/web/src/pages/TradeOpportunities.tsx`
 *
 * @module apps/web/src/hooks/useOpportunities
 */

import { useState, useCallback } from 'react';

import { useApi } from './useApi';
import type {
  TradeOpportunity,
  PaginatedResponse,
  PaginationMeta,
  Market,
  OpportunityStatus,
  Direction,
  Timeframe,
} from '../types';

// ---------------------------------------------------------------------------
// Hook Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Configuration parameters accepted by the `useOpportunities` hook.
 *
 * All fields are optional — sensible defaults are applied when omitted:
 * - `page` defaults to `1`
 * - `limit` defaults to `20`
 * - `pollingInterval` defaults to `30_000` ms (30 seconds)
 *
 * @example
 * ```typescript
 * const result = useOpportunities({ page: 1, limit: 10, pollingInterval: 60_000 });
 * ```
 */
export interface UseOpportunitiesParams {
  /** Initial page number (1-indexed). Defaults to `1`. */
  page?: number;

  /** Number of items per page. Defaults to `20`. */
  limit?: number;

  /**
   * Auto-refresh polling interval in milliseconds.
   * Defaults to `30_000` (30 seconds).
   * Set to `0` to disable polling.
   */
  pollingInterval?: number;
}

// ---------------------------------------------------------------------------
// Filter State Interface
// ---------------------------------------------------------------------------

/**
 * Internal filter state managed by the hook.
 *
 * Each filter dimension is nullable — `null` means "no filter applied"
 * (i.e., show all values for that dimension). Only non-null filter
 * values are sent as query parameters to the backend.
 *
 * Sort fields are always present with sensible defaults:
 * - `sortBy` defaults to `'createdAt'`
 * - `sortOrder` defaults to `'desc'` (newest first)
 *
 * @example
 * ```typescript
 * const defaultFilters: OpportunityFilterState = {
 *   market: null,
 *   status: null,
 *   direction: null,
 *   minConfidence: null,
 *   timeframe: null,
 *   sortBy: 'createdAt',
 *   sortOrder: 'desc',
 * };
 * ```
 */
export interface OpportunityFilterState {
  /** Market category filter. `null` = all markets. */
  market: Market | null;

  /** Opportunity lifecycle status filter. `null` = all statuses. */
  status: OpportunityStatus | null;

  /** Trade direction filter (LONG/SHORT). `null` = both directions. */
  direction: Direction | null;

  /**
   * Minimum confidence score threshold (range 0.00–1.00).
   * Only opportunities with `confidence >= minConfidence` are returned.
   * `null` = no minimum — all confidence levels.
   *
   * This is a threshold score, NOT a financial price, so `number`
   * is appropriate here (AAP Rule 0.7.2 applies only to prices).
   */
  minConfidence: number | null;

  /** Trade timeframe filter (INTRADAY, SWING, POSITION). `null` = all timeframes. */
  timeframe: Timeframe | null;

  /**
   * Column name to sort results by.
   * Examples: `'createdAt'`, `'confidence'`, `'symbol'`.
   * Default: `'createdAt'`.
   */
  sortBy: string;

  /**
   * Sort direction — ascending or descending.
   * Default: `'desc'` (newest first).
   */
  sortOrder: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Hook Return Type
// ---------------------------------------------------------------------------

/**
 * Return value of the `useOpportunities` hook.
 *
 * Provides the fetched data, loading/error states, pagination metadata,
 * the current filter state (read-only), and individual setter functions
 * for each filter dimension and pagination control.
 *
 * @example
 * ```typescript
 * const {
 *   opportunities,
 *   pagination,
 *   loading,
 *   error,
 *   refetch,
 *   filters,
 *   setPage,
 *   setMarket,
 *   setDirection,
 * } = useOpportunities({ limit: 10 });
 * ```
 */
export interface UseOpportunitiesReturn {
  /** Array of trade opportunities for the current page. */
  opportunities: TradeOpportunity[];

  /** Pagination metadata (page, limit, total, totalPages). `null` before first load. */
  pagination: PaginationMeta | null;

  /** `true` while a network request is in-flight. */
  loading: boolean;

  /** Human-readable error message, or `null` when there is no error. */
  error: string | null;

  /** Callback to manually re-trigger the data fetch. */
  refetch: () => void;

  /** Current filter state (read-only snapshot). */
  filters: OpportunityFilterState;

  /** Navigate to a specific page number (1-indexed). */
  setPage: (page: number) => void;

  /** Set market filter. Pass `null` to clear (show all markets). */
  setMarket: (market: Market | null) => void;

  /** Set opportunity status filter. Pass `null` to clear. */
  setStatus: (status: OpportunityStatus | null) => void;

  /** Set trade direction filter. Pass `null` to clear. */
  setDirection: (direction: Direction | null) => void;

  /** Set minimum confidence threshold. Pass `null` to clear. */
  setMinConfidence: (confidence: number | null) => void;

  /** Set timeframe filter. Pass `null` to clear. */
  setTimeframe: (timeframe: Timeframe | null) => void;

  /** Set the column name to sort by (e.g., `'confidence'`, `'createdAt'`). */
  setSortBy: (field: string) => void;

  /** Set sort direction to `'asc'` or `'desc'`. */
  setSortOrder: (order: 'asc' | 'desc') => void;
}

// ---------------------------------------------------------------------------
// Default Filter State
// ---------------------------------------------------------------------------

/** Initial filter state with no active filters and default sorting. */
const DEFAULT_FILTER_STATE: OpportunityFilterState = {
  market: null,
  status: null,
  direction: null,
  minConfidence: null,
  timeframe: null,
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

/** Default items per page. */
const DEFAULT_LIMIT = 20;

/** Default polling interval in milliseconds (30 seconds). */
const DEFAULT_POLLING_INTERVAL = 30_000;

// ---------------------------------------------------------------------------
// Hook Implementation
// ---------------------------------------------------------------------------

/**
 * Custom hook for fetching and filtering trade opportunities.
 *
 * Composes the generic `useApi` hook by passing the `/opportunities`
 * endpoint URL, filter-derived query parameters, and a polling interval.
 * Internally manages page and filter state, resetting to page 1 whenever
 * a data filter changes (market, status, direction, confidence, timeframe).
 *
 * The hook does NOT modify financial price values — all prices flow through
 * as `string` types from the API to the consumer (AAP Rule 0.7.2).
 *
 * @param params - Optional configuration for initial page, page size, and polling interval.
 * @returns An object containing opportunities data, pagination, loading/error states,
 *          current filters, and setter functions for all filter dimensions.
 *
 * @example
 * ```tsx
 * function TradeOpportunitiesPage() {
 *   const {
 *     opportunities,
 *     pagination,
 *     loading,
 *     error,
 *     filters,
 *     setPage,
 *     setMarket,
 *     setDirection,
 *     setMinConfidence,
 *   } = useOpportunities({ limit: 20, pollingInterval: 30_000 });
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorBanner message={error} />;
 *
 *   return (
 *     <div>
 *       <FilterBar market={filters.market} onMarketChange={setMarket} />
 *       {opportunities.map(opp => <TradeCard key={opp.id} opportunity={opp} />)}
 *       <Pagination meta={pagination} onPageChange={setPage} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useOpportunities(
  params?: UseOpportunitiesParams,
): UseOpportunitiesReturn {
  // -----------------------------------------------------------------------
  // Internal state — page number and filter dimensions
  // -----------------------------------------------------------------------

  const [page, setPageState] = useState<number>(params?.page ?? 1);

  const [filters, setFilters] = useState<OpportunityFilterState>(
    DEFAULT_FILTER_STATE,
  );

  // Derived constants from params (or defaults)
  const limit = params?.limit ?? DEFAULT_LIMIT;
  const pollingInterval = params?.pollingInterval ?? DEFAULT_POLLING_INTERVAL;

  // -----------------------------------------------------------------------
  // Build query parameters — only include non-null filter values
  // -----------------------------------------------------------------------

  const queryParams: Record<string, string | number | boolean | undefined> = {
    page,
    limit,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  };

  // Conditionally add filter parameters when they are not null
  if (filters.market !== null) {
    queryParams['market'] = filters.market;
  }
  if (filters.status !== null) {
    queryParams['status'] = filters.status;
  }
  if (filters.direction !== null) {
    queryParams['direction'] = filters.direction;
  }
  if (filters.minConfidence !== null) {
    queryParams['minConfidence'] = filters.minConfidence;
  }
  if (filters.timeframe !== null) {
    queryParams['timeframe'] = filters.timeframe;
  }

  // -----------------------------------------------------------------------
  // Delegate to the generic useApi hook
  // -----------------------------------------------------------------------

  const { data, loading, error, refetch } = useApi<
    PaginatedResponse<TradeOpportunity>
  >('/opportunities', {
    params: queryParams,
    pollingInterval,
  });

  // -----------------------------------------------------------------------
  // Extract opportunities array and pagination metadata from response
  // -----------------------------------------------------------------------

  const opportunities: TradeOpportunity[] = data?.data ?? [];
  const pagination: PaginationMeta | null = data?.pagination ?? null;

  // -----------------------------------------------------------------------
  // Memoised page setter — stable reference across re-renders
  // -----------------------------------------------------------------------

  const setPage = useCallback((newPage: number): void => {
    setPageState(newPage);
  }, []);

  // -----------------------------------------------------------------------
  // Memoised filter setters — reset to page 1 on data filter changes
  //
  // Each data filter setter (market, status, direction, minConfidence,
  // timeframe) resets the page to 1 because changing a filter invalidates
  // the current pagination position. Sort setters do NOT reset the page
  // because re-sorting the same data set keeps the pagination meaningful.
  // -----------------------------------------------------------------------

  const setMarket = useCallback((market: Market | null): void => {
    setFilters((prev) => ({ ...prev, market }));
    setPageState(1);
  }, []);

  const setStatus = useCallback((status: OpportunityStatus | null): void => {
    setFilters((prev) => ({ ...prev, status }));
    setPageState(1);
  }, []);

  const setDirection = useCallback((direction: Direction | null): void => {
    setFilters((prev) => ({ ...prev, direction }));
    setPageState(1);
  }, []);

  const setMinConfidence = useCallback(
    (minConfidence: number | null): void => {
      setFilters((prev) => ({ ...prev, minConfidence }));
      setPageState(1);
    },
    [],
  );

  const setTimeframe = useCallback((timeframe: Timeframe | null): void => {
    setFilters((prev) => ({ ...prev, timeframe }));
    setPageState(1);
  }, []);

  const setSortBy = useCallback((sortBy: string): void => {
    setFilters((prev) => ({ ...prev, sortBy }));
  }, []);

  const setSortOrder = useCallback((sortOrder: 'asc' | 'desc'): void => {
    setFilters((prev) => ({ ...prev, sortOrder }));
  }, []);

  // -----------------------------------------------------------------------
  // Return the complete hook interface
  // -----------------------------------------------------------------------

  return {
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
  };
}
