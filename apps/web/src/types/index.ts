/**
 * Frontend Type Definitions Barrel — `apps/web/src/types/index.ts`
 *
 * Single import point for all type needs within the React frontend.
 * Re-exports every shared type from the `@trading-intelligence/types`
 * workspace package and defines frontend-specific extensions (component
 * prop types, hook return types, UI state types) that are NOT needed by
 * the backend.
 *
 * Usage in frontend components and hooks:
 * ```typescript
 * import type {
 *   Market,
 *   NewsArticle,
 *   ApiHookResult,
 *   FilterState,
 * } from '../types';
 * ```
 *
 * @module apps/web/src/types
 */

// ============================================================
// Re-export all shared types from the workspace package
// ============================================================

/**
 * Re-exports every type from the monorepo's shared types package:
 *
 * - **News domain**: `Market`, `NewsArticle`, `NewsSource`
 * - **Trade domain**: `Direction`, `Timeframe`, `OpportunityStatus`,
 *   `TradeOpportunity`, `TradePerformance`
 * - **User domain**: `UserSettings`, `NotificationPreference`
 * - **API contracts**: `ApiResponse<T>`, `PaginatedResponse<T>`,
 *   `PaginationMeta`, `PaginationParams`, `ApiErrorResponse`
 * - **Queue payloads**: `NewsPollingPayload`, `AnalysisPayload`,
 *   `NotificationPayload`
 *
 * CRITICAL: Uses the workspace package name `@trading-intelligence/types`
 * (resolved via `"@trading-intelligence/types": "workspace:*"` in
 * `apps/web/package.json`), NOT a relative path.
 */
export * from '@trading-intelligence/types';

// ============================================================
// Import shared enums needed by frontend-specific type definitions
// ============================================================

import type {
  Market,
  Direction,
  Timeframe,
  OpportunityStatus,
} from '@trading-intelligence/types';

// ============================================================
// Frontend-specific type definitions
// ============================================================

// ---------------------------------------------------------------------------
// Generic Hook Return Type
// ---------------------------------------------------------------------------

/**
 * Generic return type for custom data-fetching hooks.
 *
 * Consumed by `useApi`, `useNews`, `useOpportunities`, and any other
 * SWR-pattern hooks in the frontend. Provides a uniform contract so
 * components can destructure `{ data, loading, error, refetch }` from
 * any data hook.
 *
 * @typeParam T - The type of the fetched data payload.
 *
 * @example
 * ```typescript
 * const { data, loading, error, refetch } = useNews(filters);
 * if (loading) return <Spinner />;
 * if (error) return <ErrorBanner message={error} />;
 * return <NewsList articles={data} onRefresh={refetch} />;
 * ```
 */
export interface ApiHookResult<T> {
  /** The fetched data payload — `null` while loading or when an error occurs. */
  data: T | null;

  /** `true` while a network request is in flight; `false` otherwise. */
  loading: boolean;

  /** Human-readable error message string, or `null` when there is no error. */
  error: string | null;

  /** Callback that re-triggers the data fetch (e.g., pull-to-refresh). */
  refetch: () => void;
}

// ---------------------------------------------------------------------------
// Filter State Types
// ---------------------------------------------------------------------------

/**
 * Base UI state for the filter bar component used across News Feed and
 * Trade Opportunities pages.
 *
 * Every page-specific filter interface extends this base to inherit
 * market selection, sort control, and free-text search capabilities.
 *
 * Consumed by: `FilterBar.tsx`, `NewsFeed.tsx`, `TradeOpportunities.tsx`.
 */
export interface FilterState {
  /**
   * Selected market category filter.
   * `null` means "all markets" — no market constraint applied.
   */
  market: Market | null;

  /**
   * Column or field name to sort results by.
   * Examples: `'publishedAt'`, `'confidence'`, `'createdAt'`.
   */
  sortBy: string;

  /**
   * Sort direction — ascending or descending.
   * Matches the `PaginationParams.sortOrder` literal union.
   */
  sortOrder: 'asc' | 'desc';

  /**
   * Free-text search query string.
   * Empty string `''` means no search filter applied.
   */
  search: string;
}

/**
 * Extended filter state specific to the News Feed page.
 *
 * Adds date range, source, and analysis status filters on top of the
 * base `FilterState` fields. Corresponds to query parameters accepted
 * by `GET /api/news`.
 *
 * Consumed by: `NewsFeed.tsx`, `useNews.ts`.
 */
export interface NewsFilters extends FilterState {
  /**
   * ISO 8601 date string for the start of the date range filter.
   * `null` means no lower bound — includes all historical articles.
   */
  dateFrom: string | null;

  /**
   * ISO 8601 date string for the end of the date range filter.
   * `null` means no upper bound — includes articles up to present.
   */
  dateTo: string | null;

  /**
   * News source name to filter by (e.g., `'finnhub'`, `'coingecko'`).
   * `null` means all sources.
   */
  source: string | null;

  /**
   * Filter by whether the article has been processed by the AI pipeline.
   * `null` means show both analyzed and unanalyzed articles.
   */
  isAnalyzed: boolean | null;
}

/**
 * Extended filter state specific to the Trade Opportunities page.
 *
 * Adds opportunity lifecycle status, trade direction, confidence threshold,
 * and timeframe filters on top of the base `FilterState` fields.
 * Corresponds to query parameters accepted by `GET /api/opportunities`.
 *
 * Consumed by: `TradeOpportunities.tsx`, `useOpportunities.ts`.
 */
export interface OpportunityFilters extends FilterState {
  /**
   * Opportunity lifecycle status filter (ACTIVE, CLOSED, EXPIRED, CANCELLED).
   * `null` means all statuses.
   */
  status: OpportunityStatus | null;

  /**
   * Trade direction filter (LONG or SHORT).
   * `null` means both directions.
   */
  direction: Direction | null;

  /**
   * Minimum confidence score threshold (range 0.00–1.00).
   * Only opportunities with `confidence >= minConfidence` are shown.
   * `null` means no minimum — all confidence levels displayed.
   *
   * This is a threshold score, NOT a financial price, so `number`
   * is appropriate here (AAP Rule 0.7.2 applies only to prices).
   */
  minConfidence: number | null;

  /**
   * Trade timeframe filter (INTRADAY, SWING, POSITIONAL).
   * `null` means all timeframes.
   */
  timeframe: Timeframe | null;
}

/**
 * Filter state for the Performance dashboard page.
 *
 * Provides date range and market category filters for historical
 * performance queries. Does NOT extend `FilterState` because the
 * performance page uses chart-based visualization rather than a
 * sortable/searchable list.
 *
 * Corresponds to query parameters accepted by `GET /api/performance`.
 *
 * Consumed by: `Performance.tsx`.
 */
export interface PerformanceFilters {
  /**
   * ISO 8601 date string for the start of the performance period.
   * `null` means no lower bound — includes all historical records.
   */
  dateFrom: string | null;

  /**
   * ISO 8601 date string for the end of the performance period.
   * `null` means no upper bound — includes records up to present.
   */
  dateTo: string | null;

  /**
   * Market category to filter performance data by.
   * `null` means aggregate performance across all markets.
   */
  market: Market | null;
}

// ---------------------------------------------------------------------------
// UI Component Types
// ---------------------------------------------------------------------------

/**
 * String literal union type for system health status levels.
 *
 * Maps to the visual health indicator dot in the dashboard header:
 * - `'healthy'`   → green dot — all services operational
 * - `'degraded'`  → yellow dot — partial service availability
 * - `'unhealthy'` → red dot — critical service failure
 */
export type HealthStatusLevel = 'healthy' | 'degraded' | 'unhealthy';

/**
 * System health status returned by the `GET /api/health` endpoint
 * and consumed by the `HealthIndicator.tsx` component.
 *
 * Provides top-level service availability flags and a timestamp for
 * the last health check execution.
 *
 * Consumed by: `HealthIndicator.tsx`, `DashboardLayout.tsx`.
 */
export interface HealthStatus {
  /** Overall system health assessment. */
  status: HealthStatusLevel;

  /** `true` if the PostgreSQL database is reachable and responsive. */
  postgres: boolean;

  /** `true` if the Redis instance (BullMQ backing store) is reachable. */
  redis: boolean;

  /** ISO 8601 timestamp of when this health check was performed. */
  lastChecked: string;
}

/**
 * Navigation item descriptor for the sidebar navigation component.
 *
 * Each entry maps to a route in the React Router configuration and
 * is rendered as a clickable link with a label and optional icon.
 *
 * Consumed by: `Sidebar.tsx`, `DashboardLayout.tsx`.
 */
export interface SidebarNavItem {
  /** Route path (e.g., `'/'`, `'/opportunities'`, `'/performance'`). */
  path: string;

  /** Display label shown in the sidebar (e.g., `'News Feed'`). */
  label: string;

  /**
   * Optional icon identifier or SVG string for visual decoration.
   * When absent, the sidebar renders the label without an icon.
   */
  icon?: string;
}
