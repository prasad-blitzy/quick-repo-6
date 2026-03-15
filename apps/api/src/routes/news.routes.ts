/**
 * News Feed Route Handler — GET /api/news
 *
 * Provides a paginated, filterable news feed endpoint that queries the
 * `news_articles` table via Drizzle ORM. Supports filtering by market
 * segment, source name, analysis status, and date range with configurable
 * sort direction on publishedAt.
 *
 * Query Parameters (validated by newsFilterSchema from @trading-intelligence/utils):
 *  - page:       number (default 1) — Page number (1-indexed)
 *  - limit:      number (default 20, max 100) — Items per page
 *  - sortOrder:  'asc' | 'desc' (default 'desc') — Sort on publishedAt
 *  - market:     'US' | 'INDIA' | 'CRYPTO' | 'SOCIAL' or 'us_stock' | 'indian_equity' | 'crypto' | 'social' (optional)
 *  - source:     string (optional) — Filter by news source name
 *  - isAnalyzed: boolean (optional) — Filter by analysis pipeline status
 *  - from:       ISO 8601 datetime (optional) — Start of date range (inclusive)
 *  - to:         ISO 8601 datetime (optional) — End of date range (inclusive)
 *
 * Response Shape:
 * ```json
 * {
 *   "data": NewsArticle[],
 *   "pagination": { "page": number, "limit": number, "total": number, "totalPages": number }
 * }
 * ```
 *
 * Error Response (400 — Validation Error):
 * ```json
 * {
 *   "error": { "message": string, "code": "VALIDATION_ERROR", "details": ZodFlattenedError }
 * }
 * ```
 *
 * Integration:
 *  - Consumed by: apps/api/src/routes/index.ts — mounted at /api prefix
 *  - Frontend consumer: apps/web/src/hooks/useNews.ts
 *
 * @module routes/news
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  eq,
  desc,
  asc,
  and,
  gte,
  lte,
  sql,
  count,
  type SQL,
} from "drizzle-orm";

import { db } from "../db/index.js";
import { newsArticles } from "../db/schema/index.js";
import { createLogger } from "../lib/logger.js";
import { newsFilterSchema } from "@trading-intelligence/utils";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "routes:news" }` context.
 * All log entries from this module include the "routes:news" identifier
 * for structured filtering in log aggregation tools.
 */
const logger = createLogger("routes:news");

// ---------------------------------------------------------------------------
// Market Value Mapping
// ---------------------------------------------------------------------------

/**
 * Maps uppercase API-facing market identifiers to their lowercase PostgreSQL
 * enum equivalents stored in the `news_articles.market` column.
 *
 * Ensures a consistent API contract across all endpoints — the performance
 * endpoint already accepts uppercase values (US, INDIA, CRYPTO, SOCIAL), and
 * this map brings the news endpoint into alignment.
 *
 * The `as const` assertion preserves literal types for TypeScript exhaustive
 * coverage verification.
 */
const MARKET_DB_MAP: Record<string, string> = {
  US: "us_stock",
  INDIA: "indian_equity",
  CRYPTO: "crypto",
  SOCIAL: "social",
};

// ---------------------------------------------------------------------------
// Router Instance
// ---------------------------------------------------------------------------

/**
 * Express Router for news feed endpoints.
 * Exported as a named constant for mounting in the route aggregator
 * (`apps/api/src/routes/index.ts`), typically under the `/api` prefix.
 *
 * Routes:
 *  - GET /news — Paginated, filterable news feed
 */
export const newsRouter: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// GET /news — Paginated News Feed
// ---------------------------------------------------------------------------

/**
 * Handles GET /news requests with pagination, filtering, and sorting.
 *
 * Processing pipeline:
 *  1. Validates query parameters with Zod (`newsFilterSchema.safeParse`)
 *  2. Builds dynamic WHERE conditions from validated filter params
 *  3. Executes a count query for pagination metadata
 *  4. Executes a paginated SELECT with configurable sort direction
 *  5. Returns `{ data, pagination }` response envelope
 *
 * All errors are caught and forwarded to the global error handler via `next()`.
 */
newsRouter.get(
  "/news",
  async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // -------------------------------------------------------------------
      // Step 1: Normalize market query parameter and validate via Zod
      // -------------------------------------------------------------------
      // Pre-process the market query parameter to accept both uppercase
      // API values (US, INDIA, CRYPTO, SOCIAL) and lowercase DB enum
      // values (us_stock, indian_equity, crypto, social). This ensures
      // a consistent API contract across all endpoints — the performance
      // endpoint already accepts uppercase values, and this normalization
      // brings the news endpoint into alignment.
      const normalizedQuery = { ...req.query };
      if (
        typeof normalizedQuery.market === "string" &&
        MARKET_DB_MAP[normalizedQuery.market] !== undefined
      ) {
        normalizedQuery.market = MARKET_DB_MAP[normalizedQuery.market];
      }

      // newsFilterSchema extends paginationSchema with news-specific filters.
      // safeParse returns { success, data } or { success: false, error }.
      const parsed = newsFilterSchema.safeParse(normalizedQuery);

      if (!parsed.success) {
        res.status(400).json({
          error: {
            message: "Invalid query parameters",
            code: "VALIDATION_ERROR",
            details: parsed.error.flatten(),
          },
        });
        return;
      }

      const {
        page,
        limit,
        sortOrder,
        market,
        source,
        isAnalyzed,
        from,
        to,
      } = parsed.data;

      // -------------------------------------------------------------------
      // Step 2: Build dynamic WHERE conditions
      // -------------------------------------------------------------------
      // Each filter is optional — conditions are collected into an array
      // and composed with AND. When no conditions exist, a raw sql`TRUE`
      // expression is used as the WHERE clause to keep the query structure
      // consistent across both code paths.
      //
      // NOTE: Uppercase market values (US, INDIA, CRYPTO, SOCIAL) are
      // pre-normalized to lowercase DB enum values in Step 1 above via
      // MARKET_DB_MAP, so the validated `market` value is always a
      // lowercase DB enum string at this point.
      const conditions: SQL[] = [];

      if (market !== undefined) {
        conditions.push(eq(newsArticles.market, market));
      }

      if (source !== undefined) {
        conditions.push(eq(newsArticles.source, source));
      }

      if (isAnalyzed !== undefined) {
        conditions.push(eq(newsArticles.isAnalyzed, isAnalyzed));
      }

      if (from !== undefined) {
        // gte = greater than or equal — inclusive start of date range
        conditions.push(gte(newsArticles.publishedAt, new Date(from)));
      }

      if (to !== undefined) {
        // lte = less than or equal — inclusive end of date range
        conditions.push(lte(newsArticles.publishedAt, new Date(to)));
      }

      // Compose conditions with AND, or use sql`TRUE` when no filters
      // are applied. The sql tagged template ensures the WHERE clause is
      // always a valid SQL expression.
      const whereClause =
        conditions.length > 0 ? and(...conditions) : sql`TRUE`;

      // -------------------------------------------------------------------
      // Step 3: Execute total count query for pagination metadata
      // -------------------------------------------------------------------
      // Separate count query ensures accurate pagination totals regardless
      // of LIMIT/OFFSET applied to the data query.
      const countResult = await db
        .select({ count: count() })
        .from(newsArticles)
        .where(whereClause);

      // With noUncheckedIndexedAccess enabled, countResult[0] is
      // { count: number } | undefined — handle the undefined case safely
      const total = countResult[0]?.count ?? 0;

      // -------------------------------------------------------------------
      // Step 4: Execute paginated data query with sort direction
      // -------------------------------------------------------------------
      // Offset-based pagination: (page - 1) * limit
      // Default sort is publishedAt DESC (newest first) when sortOrder
      // is not specified (Zod default is 'desc').
      const offset = (page - 1) * limit;
      const orderDirection = sortOrder === "asc" ? asc : desc;

      const data = await db
        .select()
        .from(newsArticles)
        .where(whereClause)
        .orderBy(orderDirection(newsArticles.publishedAt))
        .limit(limit)
        .offset(offset);

      // -------------------------------------------------------------------
      // Step 5: Build and send paginated response
      // -------------------------------------------------------------------
      const totalCount = Number(total);
      const totalPages =
        totalCount > 0 ? Math.ceil(totalCount / limit) : 0;

      res.json({
        success: true,
        data: {
          data,
          pagination: {
            page,
            limit,
            total: totalCount,
            totalPages,
          },
        },
      });

      // Structured debug log for observability — includes filter context
      // and result count for monitoring query patterns
      logger.debug(
        { page, limit, market, total: totalCount },
        "News feed queried",
      );
    } catch (error: unknown) {
      // Forward all errors to the global Express error handler middleware
      // defined in apps/api/src/middleware/error-handler.ts
      next(error);
    }
  },
);
