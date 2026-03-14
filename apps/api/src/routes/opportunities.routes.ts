/**
 * Trade Opportunities Route Handler
 *
 * Express route handler for `GET /api/opportunities` — a filterable, sortable,
 * paginated endpoint that queries the `trade_opportunities` table via Drizzle ORM
 * with a LEFT JOIN to `news_articles` for contextual article data.
 *
 * Supported query parameters:
 *  - **page** (number, default 1)          — Page number for pagination
 *  - **limit** (number, default 20, max 100) — Items per page
 *  - **sortBy** (string, default 'created_at') — Sort column: 'created_at' or 'confidence'
 *  - **sortOrder** ('asc'|'desc', default 'desc') — Sort direction
 *  - **status** (string)    — Filter by opportunity status (active, closed, expired, cancelled)
 *  - **market** (string)    — Filter by market segment (us_stock, indian_equity, crypto, social)
 *  - **direction** (string) — Filter by trade direction (long, short)
 *  - **timeframe** (string) — Filter by timeframe (intraday, swing, position)
 *  - **minConfidence** (number) — Minimum confidence threshold (0.00–1.00)
 *  - **symbol** (string)    — Filter by trading symbol (e.g., "AAPL", "BTC/USDT")
 *
 * All query parameters are validated via the `opportunitiesFilterSchema` Zod schema
 * from `@trading-intelligence/utils`. Invalid parameters return HTTP 400 with a
 * structured `VALIDATION_ERROR` response.
 *
 * CRITICAL design decisions (AAP compliance):
 *  - Price fields (entry_price, stop_loss, take_profit) remain as strings —
 *    NEVER converted to JavaScript numbers (AAP Rule 0.7.2: numeric(12,4) precision)
 *  - Confidence scores remain as strings from Drizzle's numeric(3,2) mapping
 *  - Minimum confidence comparison uses string-based `gte()` for numeric(3,2) field
 *  - All local import paths use `.js` extension for NodeNext ESM resolution
 *  - No `any` types; strict TypeScript mode compliance throughout
 *
 * Integration:
 *  - Consumed by `apps/api/src/routes/index.ts` — mounted under `/api` prefix
 *  - Frontend consumer: `apps/web/src/hooks/useOpportunities.ts`
 *  - Database: `trade_opportunities` table with composite indexes on
 *    (created_at, market, status) and (symbol, status)
 *
 * @module routes/opportunities
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { Router as IRouter } from "express";
import { eq, desc, asc, and, gte, count, type SQL } from "drizzle-orm";

import { db } from "../db/index.js";
import { tradeOpportunities, newsArticles } from "../db/schema/index.js";
import { createLogger } from "../lib/logger.js";
import { opportunitiesFilterSchema } from "@trading-intelligence/utils";

// ---------------------------------------------------------------------------
// Logger — Namespaced child logger for structured debug output
// ---------------------------------------------------------------------------

/**
 * Pino child logger bound with `{ module: "routes:opportunities" }` context.
 * Used for structured debug logging of paginated opportunities queries
 * including page, limit, filter parameters, and total result count.
 */
const logger = createLogger("routes:opportunities");

// ---------------------------------------------------------------------------
// Router Instance
// ---------------------------------------------------------------------------

/**
 * Express Router instance for trade opportunities endpoints.
 *
 * Exposes:
 *  - `GET /opportunities` — Paginated, filterable, sortable opportunities list
 *
 * Mounted by `routes/index.ts` under the `/api` prefix, making the full
 * endpoint path `GET /api/opportunities`.
 */
export const opportunitiesRouter: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /opportunities — Paginated, Filterable Trade Opportunities
// ---------------------------------------------------------------------------

/**
 * Handles `GET /opportunities` requests with the following pipeline:
 *
 *  1. Parse and validate query parameters via Zod `opportunitiesFilterSchema`
 *  2. Build dynamic WHERE conditions from validated filter values
 *  3. Execute COUNT(*) query with filters for pagination metadata
 *  4. Determine sort column and direction
 *  5. Execute paginated SELECT with LEFT JOIN to news_articles
 *  6. Return data array with pagination metadata envelope
 *
 * The LEFT JOIN to `news_articles` provides article context (id, title, url,
 * source) alongside each trade opportunity, enabling the React dashboard to
 * display the source article that triggered the recommendation.
 *
 * Error handling: All unexpected errors are forwarded to Express's global
 * error handler via `next(error)`. Validation errors return HTTP 400 directly.
 */
opportunitiesRouter.get(
  "/opportunities",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // -----------------------------------------------------------------------
      // Step 1: Parse and validate query parameters
      // -----------------------------------------------------------------------
      // The Zod schema coerces string query params to numbers where needed,
      // applies defaults (page=1, limit=20, sortOrder='desc'), and validates
      // enum values against the exact PostgreSQL enum definitions.
      const parsed = opportunitiesFilterSchema.safeParse(req.query);

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
        sortBy,
        sortOrder,
        market,
        direction,
        status,
        timeframe,
        minConfidence,
        symbol,
      } = parsed.data;

      // -----------------------------------------------------------------------
      // Step 2: Build dynamic WHERE conditions
      // -----------------------------------------------------------------------
      // The Zod schema validates enum values to match the exact lowercase
      // PostgreSQL enum values (us_stock, indian_equity, crypto, social, etc.),
      // so no uppercase-to-lowercase mapping is needed. Each filter condition
      // is only appended when the corresponding query parameter is present.
      const conditions: SQL[] = [];

      if (status !== undefined) {
        conditions.push(eq(tradeOpportunities.status, status));
      }

      if (market !== undefined) {
        conditions.push(eq(tradeOpportunities.market, market));
      }

      if (direction !== undefined) {
        conditions.push(eq(tradeOpportunities.direction, direction));
      }

      if (timeframe !== undefined) {
        conditions.push(eq(tradeOpportunities.timeframe, timeframe));
      }

      // Minimum confidence comparison uses string-based gte() because
      // Drizzle maps PostgreSQL numeric(3,2) columns to TypeScript strings
      // to preserve decimal precision (AAP Rule 0.7.2). String comparison
      // works correctly for numeric strings in PostgreSQL.
      if (minConfidence !== undefined) {
        conditions.push(
          gte(tradeOpportunities.confidence, String(minConfidence)),
        );
      }

      if (symbol !== undefined) {
        conditions.push(eq(tradeOpportunities.symbol, symbol));
      }

      // Compose all conditions with AND. If no filters are applied,
      // whereClause is undefined — Drizzle omits the WHERE clause entirely.
      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // -----------------------------------------------------------------------
      // Step 3: Get total count for pagination metadata
      // -----------------------------------------------------------------------
      // Executes a separate COUNT(*) query with the same WHERE conditions.
      // This is necessary for calculating totalPages in the response envelope.
      // The count query uses the composite index on (created_at, market, status).
      const [totalResult] = await db
        .select({ count: count() })
        .from(tradeOpportunities)
        .where(whereClause);

      // noUncheckedIndexedAccess: totalResult may be undefined if table is empty
      const total = totalResult?.count ?? 0;

      // -----------------------------------------------------------------------
      // Step 4: Determine sort column and direction
      // -----------------------------------------------------------------------
      // Supports two sort columns:
      //  - 'confidence' → tradeOpportunities.confidence (numeric(3,2) string)
      //  - 'created_at' (default) → tradeOpportunities.createdAt (timestamp)
      const sortColumn =
        sortBy === "confidence"
          ? tradeOpportunities.confidence
          : tradeOpportunities.createdAt;

      const orderDirection = sortOrder === "asc" ? asc : desc;

      // -----------------------------------------------------------------------
      // Step 5: Execute paginated query with LEFT JOIN to news_articles
      // -----------------------------------------------------------------------
      // The LEFT JOIN provides article context alongside each opportunity.
      // When an opportunity's article has been deleted, the article fields
      // will be null — this is expected behavior for LEFT JOIN.
      //
      // CRITICAL: Price fields (entryPrice, stopLoss, takeProfit) and
      // confidence are returned as strings by Drizzle's numeric() mapping.
      // They must NOT be converted to JavaScript numbers to preserve
      // financial decimal precision (AAP Rule 0.7.2).
      const offset = (page - 1) * limit;

      const data = await db
        .select({
          opportunity: tradeOpportunities,
          article: {
            id: newsArticles.id,
            title: newsArticles.title,
            url: newsArticles.url,
            source: newsArticles.source,
          },
        })
        .from(tradeOpportunities)
        .leftJoin(
          newsArticles,
          eq(tradeOpportunities.articleId, newsArticles.id),
        )
        .where(whereClause)
        .orderBy(orderDirection(sortColumn))
        .limit(limit)
        .offset(offset);

      // -----------------------------------------------------------------------
      // Step 6: Return paginated response envelope
      // -----------------------------------------------------------------------
      // Number(total) ensures the count is a JavaScript number regardless
      // of whether the pg driver returns it as a string or number.
      const totalPages = Math.ceil(Number(total) / limit);

      res.json({
        data,
        pagination: {
          page,
          limit,
          total: Number(total),
          totalPages,
        },
      });

      // Structured debug log for observability — includes filter parameters
      // and total count for monitoring query patterns and result set sizes.
      logger.debug(
        { page, limit, market, status, total },
        "Opportunities queried",
      );
    } catch (error: unknown) {
      // Forward all unexpected errors to the global Express error handler
      // middleware (apps/api/src/middleware/error-handler.ts) which logs
      // the error with Pino and returns a structured 500 response.
      next(error);
    }
  },
);
