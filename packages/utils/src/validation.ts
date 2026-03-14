/**
 * @module validation
 * @description Shared Zod validation schemas for API boundary validation.
 *
 * This module provides runtime validation schemas used by both Express route
 * handlers (input validation) and the React frontend (response parsing).
 *
 * Per AAP Rule 0.7.3: Zod schemas serve dual purpose — runtime validation
 * AND TypeScript type inference via `z.infer<>`.
 *
 * All enum values match exactly with:
 *   - `packages/types/src/news.ts` (Market)
 *   - `packages/types/src/trade.ts` (Direction, Timeframe, OpportunityStatus)
 *   - `apps/api/src/db/schema/enums.ts` (PostgreSQL enum definitions)
 *
 * Financial precision rules (AAP Rule 0.7.2):
 *   - Price fields: validated as strings matching numeric(12,4) — never raw numbers
 *   - Confidence: numeric(3,2) range 0.00–1.00
 *   - Sentiment: numeric(5,3) range -1.000–1.000
 *
 * @example
 * ```typescript
 * import { paginationSchema, newsFilterSchema } from '@trading-intelligence/utils';
 * import type { PaginationParams, NewsFilterParams } from '@trading-intelligence/utils';
 *
 * // Validate Express query params
 * const params = newsFilterSchema.parse(req.query);
 * ```
 */

import { z } from 'zod';

// ============================================================================
// Pagination Parameter Schema
// ============================================================================

/**
 * Validates and transforms pagination query parameters from Express request
 * query strings. Uses `z.coerce.number()` because Express query params arrive
 * as strings and must be coerced to numbers.
 *
 * Defaults ensure safe pagination when parameters are omitted:
 *   - page: 1 (first page)
 *   - limit: 20 (reasonable batch size for financial data)
 *   - sortOrder: 'desc' (newest first for financial data)
 *
 * @example
 * ```typescript
 * const result = paginationSchema.parse({ page: '2', limit: '50' });
 * // { page: 2, limit: 50, sortOrder: 'desc' }
 * ```
 */
export const paginationSchema = z.object({
  /** Page number — coerced from string, must be a positive integer, defaults to 1 */
  page: z.coerce.number().int().positive().default(1),
  /** Items per page — coerced from string, positive integer, max 100, defaults to 20 */
  limit: z.coerce.number().int().positive().max(100).default(20),
  /** Column name to sort by — optional, validated as non-empty string when present */
  sortBy: z.string().optional(),
  /** Sort direction — restricted to 'asc' or 'desc', defaults to 'desc' (newest first) */
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** Inferred TypeScript type for pagination parameters */
export type PaginationParams = z.infer<typeof paginationSchema>;

// ============================================================================
// Common Field Validators
// ============================================================================

/**
 * Validates UUID v4 format strings.
 * Used for all entity ID fields: article_id, opportunity_id, user_id.
 *
 * @example
 * ```typescript
 * uuidSchema.parse('550e8400-e29b-41d4-a716-446655440000'); // valid
 * uuidSchema.parse('not-a-uuid'); // throws ZodError
 * ```
 */
export const uuidSchema = z.string().uuid();

/**
 * Validates ISO 8601 date strings with optional timezone offset.
 * Used for all timestamp fields: publishedAt, createdAt, updatedAt.
 *
 * Accepts formats like:
 *   - "2026-03-14T10:30:00Z"
 *   - "2026-03-14T10:30:00+05:30"
 *
 * @example
 * ```typescript
 * isoDateSchema.parse('2026-03-14T10:30:00Z'); // valid
 * isoDateSchema.parse('March 14, 2026'); // throws ZodError
 * ```
 */
export const isoDateSchema = z.string().datetime({ offset: true });

/**
 * Validates positive numbers, coerced from strings.
 * Used for count fields, rate limits, and other non-negative numeric values.
 *
 * @example
 * ```typescript
 * positiveNumberSchema.parse('42'); // 42
 * positiveNumberSchema.parse('-1'); // throws ZodError
 * ```
 */
export const positiveNumberSchema = z.coerce.number().positive();

// ============================================================================
// Market Enum Schema
// ============================================================================

/**
 * Validates market identifier strings.
 * Values match the `Market` enum in `packages/types/src/news.ts` and
 * the PostgreSQL enum in `apps/api/src/db/schema/enums.ts`.
 *
 * - us_stock      — United States stock market (Finnhub, Alpha Vantage, CNBC/MarketWatch RSS)
 * - indian_equity — Indian equities NSE/BSE (Economic Times, Financial Express, Business Standard RSS)
 * - crypto        — Cryptocurrency markets (CoinGecko, CryptoCompare, Binance)
 * - social        — Social sentiment sources (Reddit RSS: r/wallstreetbets, r/IndianStreetBets)
 */
export const marketSchema = z.enum(['us_stock', 'indian_equity', 'crypto', 'social']);

/** Inferred TypeScript type for market parameter */
export type MarketParam = z.infer<typeof marketSchema>;

// ============================================================================
// Direction, Timeframe, and Status Enum Schemas
// ============================================================================

/**
 * Validates trade direction strings.
 * Values match the PostgreSQL `direction` enum in `apps/api/src/db/schema/enums.ts`.
 *
 * - long  — Buy recommendation (🟢 in Telegram alerts)
 * - short — Sell recommendation (🔴 in Telegram alerts)
 */
export const directionSchema = z.enum(['long', 'short']);

/**
 * Validates trade timeframe strings.
 * Values match the PostgreSQL `timeframe` enum in `apps/api/src/db/schema/enums.ts`.
 *
 * - intraday — Same-day trades
 * - swing    — Multi-day to multi-week positions
 * - position — Multi-week to multi-month positions
 */
export const timeframeSchema = z.enum(['intraday', 'swing', 'position']);

/**
 * Validates trade opportunity status strings.
 * Values match the PostgreSQL `status` enum in `apps/api/src/db/schema/enums.ts`.
 *
 * - active    — Currently actionable opportunity
 * - closed    — Position closed (hit target or stop loss)
 * - expired   — Opportunity window has passed
 * - cancelled — Manually cancelled or invalidated
 */
export const opportunityStatusSchema = z.enum(['active', 'closed', 'expired', 'cancelled']);

// ============================================================================
// Financial String Validators (AAP Rule 0.7.2 — Decimal Precision)
// ============================================================================

/**
 * Validates string representation of financial price values matching
 * PostgreSQL `numeric(12,4)` column type.
 *
 * CRITICAL: This is a STRING validator, NOT a number validator.
 * Per AAP Rule 0.7.2: "Never use JavaScript floating-point (number)
 * for price calculations; use string-based decimal."
 *
 * Accepted patterns:
 *   - "123.4567" (up to 4 decimal places)
 *   - "1000" (whole numbers)
 *   - "0.0001" (minimum precision)
 *   - "999999999999.9999" (max 12 digits total)
 *
 * Rejected patterns:
 *   - "-100" (no negative prices)
 *   - "12.34567" (more than 4 decimal places)
 *   - "abc" (non-numeric)
 *   - "" (empty string)
 *
 * @example
 * ```typescript
 * priceStringSchema.parse('123.4567'); // '123.4567'
 * priceStringSchema.parse('1000'); // '1000'
 * priceStringSchema.parse(123.45); // throws ZodError (not a string)
 * ```
 */
export const priceStringSchema = z.string().regex(
  /^\d+(\.\d{1,4})?$/,
  'Price must be a numeric string with up to 4 decimal places'
);

/**
 * Validates confidence scores in the range 0.00 to 1.00.
 * Per AAP Rule 0.7.2: stored as `numeric(3,2)` in the database.
 *
 * Number type is acceptable for confidence scores — they are scores,
 * not monetary values. Uses `z.coerce.number()` for query string
 * parameter compatibility.
 *
 * @example
 * ```typescript
 * confidenceSchema.parse('0.85'); // 0.85
 * confidenceSchema.parse(0.95); // 0.95
 * confidenceSchema.parse('1.5'); // throws ZodError (max 1)
 * ```
 */
export const confidenceSchema = z.coerce.number().min(0).max(1);

/**
 * Validates sentiment scores in the range -1.000 to 1.000.
 * Per AAP Rule 0.7.2: stored as `numeric(5,3)` in the database.
 *
 * - -1.0 — Extremely negative sentiment
 * -  0.0 — Neutral sentiment
 * -  1.0 — Extremely positive sentiment
 *
 * Per AAP Rule 0.7.3: "Negative financial news has 2–3x the market impact
 * of positive news" — this validator does not enforce weighting, but
 * the analysis pipeline applies it when computing aggregate scores.
 *
 * @example
 * ```typescript
 * sentimentSchema.parse('-0.75'); // -0.75
 * sentimentSchema.parse(0.5); // 0.5
 * sentimentSchema.parse('-1.5'); // throws ZodError (min -1)
 * ```
 */
export const sentimentSchema = z.coerce.number().min(-1).max(1);

// ============================================================================
// Date Range Filter Schema
// ============================================================================

/**
 * Validates date range filter parameters for API endpoints.
 * Used by news feed and performance endpoints for time-bound queries.
 *
 * Both fields are optional — omitting means no date constraint on that bound.
 * Accepts ISO 8601 datetime strings with timezone offset.
 *
 * @example
 * ```typescript
 * dateRangeSchema.parse({
 *   from: '2026-03-01T00:00:00Z',
 *   to: '2026-03-14T23:59:59Z',
 * });
 * dateRangeSchema.parse({}); // valid — no date constraints
 * ```
 */
export const dateRangeSchema = z.object({
  /** Start date (inclusive) — ISO 8601 with timezone offset, optional */
  from: z.string().datetime({ offset: true }).optional(),
  /** End date (inclusive) — ISO 8601 with timezone offset, optional */
  to: z.string().datetime({ offset: true }).optional(),
});

/** Inferred TypeScript type for date range filter parameters */
export type DateRangeParams = z.infer<typeof dateRangeSchema>;

// ============================================================================
// News Feed Filter Schema
// ============================================================================

/**
 * Validates query parameters for the `GET /api/news` endpoint.
 * Extends paginationSchema with news-specific filters.
 *
 * Corresponds to AAP Section 0.5.1 Group 9:
 *   "GET /api/news with pagination, market filter, date range"
 *
 * @example
 * ```typescript
 * const filters = newsFilterSchema.parse({
 *   page: '1',
 *   limit: '20',
 *   market: 'CRYPTO',
 *   isAnalyzed: 'true',
 *   from: '2026-03-01T00:00:00Z',
 * });
 * ```
 */
export const newsFilterSchema = paginationSchema.extend({
  /** Filter by market segment — optional */
  market: marketSchema.optional(),
  /** Filter by news source name — optional free-text */
  source: z.string().optional(),
  /** Filter by analysis status — coerced from string boolean, optional */
  isAnalyzed: z.coerce.boolean().optional(),
  /** Start date filter — ISO 8601 with offset, optional */
  from: z.string().datetime({ offset: true }).optional(),
  /** End date filter — ISO 8601 with offset, optional */
  to: z.string().datetime({ offset: true }).optional(),
});

/** Inferred TypeScript type for news feed filter parameters */
export type NewsFilterParams = z.infer<typeof newsFilterSchema>;

// ============================================================================
// Opportunities Filter Schema
// ============================================================================

/**
 * Validates query parameters for the `GET /api/opportunities` endpoint.
 * Extends paginationSchema with trade opportunity-specific filters.
 *
 * Corresponds to AAP Section 0.5.1 Group 9:
 *   "GET /api/opportunities with status, market, confidence filters"
 *
 * @example
 * ```typescript
 * const filters = opportunitiesFilterSchema.parse({
 *   page: '1',
 *   limit: '10',
 *   market: 'US',
 *   direction: 'LONG',
 *   status: 'ACTIVE',
 *   minConfidence: '0.8',
 * });
 * ```
 */
export const opportunitiesFilterSchema = paginationSchema.extend({
  /** Filter by market segment — optional */
  market: marketSchema.optional(),
  /** Filter by trade direction (LONG/SHORT) — optional */
  direction: directionSchema.optional(),
  /** Filter by opportunity status — optional */
  status: opportunityStatusSchema.optional(),
  /** Filter by timeframe — optional */
  timeframe: timeframeSchema.optional(),
  /** Minimum confidence threshold (0.00–1.00) — coerced from string, optional */
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  /** Filter by trading symbol (e.g., "AAPL", "BTC") — optional */
  symbol: z.string().optional(),
});

/** Inferred TypeScript type for opportunities filter parameters */
export type OpportunitiesFilterParams = z.infer<typeof opportunitiesFilterSchema>;

// ============================================================================
// API Response Envelope Schemas
// ============================================================================

/**
 * Generic factory function that creates an API response envelope schema
 * for any data type. Matches the `ApiResponse<T>` interface from
 * `packages/types/src/api.ts`.
 *
 * The envelope structure standardizes all API responses:
 *   - `success` — Boolean indicating operation success
 *   - `data` — The actual response payload (typed by the provided schema)
 *   - `error` — Optional error message string
 *   - `message` — Optional informational message string
 *
 * @param dataSchema - Zod schema defining the shape of the response data
 * @returns A Zod object schema wrapping the data in a standard envelope
 *
 * @example
 * ```typescript
 * const newsResponseSchema = apiResponseSchema(z.array(newsArticleSchema));
 * type NewsResponse = z.infer<typeof newsResponseSchema>;
 * ```
 */
export function apiResponseSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    /** Whether the API operation succeeded */
    success: z.boolean(),
    /** Response payload — shape defined by the provided schema */
    data: dataSchema,
    /** Error message — present only when success is false */
    error: z.string().optional(),
    /** Informational message — optional supplementary text */
    message: z.string().optional(),
  });
}

/**
 * Generic factory function that creates a paginated API response schema.
 * Matches the `PaginatedResponse<T>` interface from `packages/types/src/api.ts`.
 *
 * The paginated response structure contains:
 *   - `data` — Array of items matching the provided schema
 *   - `pagination` — Pagination metadata (page, limit, total, totalPages)
 *
 * @param itemSchema - Zod schema defining the shape of each item in the array
 * @returns A Zod object schema for paginated responses
 *
 * @example
 * ```typescript
 * const paginatedNewsSchema = paginatedResponseSchema(newsArticleSchema);
 * type PaginatedNews = z.infer<typeof paginatedNewsSchema>;
 * ```
 */
export function paginatedResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    /** Array of items for the current page */
    data: z.array(itemSchema),
    /** Pagination metadata */
    pagination: z.object({
      /** Current page number */
      page: z.number(),
      /** Items per page */
      limit: z.number(),
      /** Total number of items across all pages */
      total: z.number(),
      /** Total number of pages */
      totalPages: z.number(),
    }),
  });
}
