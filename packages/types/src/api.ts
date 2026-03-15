/**
 * REST API Contract Type Definitions
 *
 * Defines TypeScript interfaces for all REST API request/response contracts
 * used by the Express backend (apps/api) and React frontend (apps/web).
 * These generic types enforce a consistent API envelope pattern across all endpoints.
 *
 * @module @trading-intelligence/types/api
 */

// ---------------------------------------------------------------------------
// API Response Envelope
// ---------------------------------------------------------------------------

/**
 * Standard API response wrapper for all successful and failed responses.
 *
 * Every REST endpoint returns data wrapped in this envelope so that consumers
 * can uniformly check `success` before accessing the `data` payload.
 *
 * @typeParam T - The type of the response payload contained in `data`.
 *
 * @example
 * ```typescript
 * // Successful response
 * const res: ApiResponse<NewsArticle[]> = {
 *   success: true,
 *   data: articles,
 *   message: 'Fetched 25 articles',
 * };
 *
 * // Error response (success = false)
 * const err: ApiResponse<null> = {
 *   success: false,
 *   data: null,
 *   error: 'Invalid market parameter',
 * };
 * ```
 */
export interface ApiResponse<T> {
  /** Indicates whether the request completed successfully. */
  success: boolean;

  /** The response payload. Type varies per endpoint. */
  data: T;

  /**
   * Error description string, present when `success` is `false`.
   * Omitted (property absent) on successful responses.
   */
  error?: string;

  /**
   * Optional human-readable informational message.
   * May be present on both success and error responses.
   */
  message?: string;
}

// ---------------------------------------------------------------------------
// Pagination Types
// ---------------------------------------------------------------------------

/**
 * Metadata describing the current pagination state.
 *
 * Included in every paginated response so the client knows the current page,
 * total item count, and how many pages are available.
 */
export interface PaginationMeta {
  /** Current page number (1-indexed). */
  page: number;

  /** Maximum number of items returned per page. */
  limit: number;

  /** Total number of items across all pages. */
  total: number;

  /** Total number of pages (computed as `Math.ceil(total / limit)`). */
  totalPages: number;
}

/**
 * Generic paginated response wrapping an array of items with pagination metadata.
 *
 * Used by endpoints that return lists (news feed, trade opportunities, etc.).
 *
 * @typeParam T - The type of each item in the `data` array.
 *
 * @example
 * ```typescript
 * const page: PaginatedResponse<TradeOpportunity> = {
 *   data: opportunities,
 *   pagination: { page: 1, limit: 20, total: 142, totalPages: 8 },
 * };
 * ```
 */
export interface PaginatedResponse<T> {
  /** Array of items for the current page. */
  data: T[];

  /** Pagination metadata for navigating the result set. */
  pagination: PaginationMeta;
}

// ---------------------------------------------------------------------------
// Pagination Request Parameters
// ---------------------------------------------------------------------------

/**
 * Query parameters accepted by paginated list endpoints.
 *
 * Clients send these as query string parameters; the backend parses and
 * validates them before constructing the database query.
 *
 * @example
 * ```typescript
 * // GET /api/opportunities?page=2&limit=20&sortBy=confidence&sortOrder=desc
 * const params: PaginationParams = {
 *   page: 2,
 *   limit: 20,
 *   sortBy: 'confidence',
 *   sortOrder: 'desc',
 * };
 * ```
 */
export interface PaginationParams {
  /** Requested page number (1-indexed). */
  page: number;

  /** Number of items to return per page. */
  limit: number;

  /**
   * Column name to sort the results by.
   * Omitted when the default sort order is acceptable.
   */
  sortBy?: string;

  /**
   * Sort direction — ascending or descending.
   * Restricted to the literal union `'asc' | 'desc'`.
   * Omitted when the default sort direction is acceptable.
   */
  sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Error Response Type
// ---------------------------------------------------------------------------

/**
 * Dedicated error response type returned by the global Express error handler.
 *
 * `success` is typed as the literal `false` (not `boolean`) so that
 * discriminated union narrowing works correctly in consuming code.
 *
 * @example
 * ```typescript
 * const error: ApiErrorResponse = {
 *   success: false,
 *   error: 'Not Found',
 *   message: 'Article with the given ID does not exist.',
 *   statusCode: 404,
 * };
 * ```
 */
export interface ApiErrorResponse {
  /** Always `false` for error responses. Typed as literal `false` for narrowing. */
  success: false;

  /** Machine-readable error description. Always present on errors. */
  error: string;

  /**
   * Optional human-readable error message providing additional context.
   * Omitted when no extra detail is available.
   */
  message?: string;

  /** HTTP status code mirrored in the response body for client convenience. */
  statusCode: number;
}
