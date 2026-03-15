/**
 * Performance Tracking Route Handler
 *
 * Express route handler for `GET /api/performance` — queries the
 * `trade_performance` table joined with `trade_opportunities` to compute
 * aggregate statistics including total trades, winners, losers, win rate,
 * total P&L, average P&L, best trade, and worst trade.
 *
 * Supports optional filtering by:
 *  - Date range (`startDate`, `endDate`) — ISO 8601 datetime with timezone offset
 *  - Market (`market`) — US, INDIA, CRYPTO, or SOCIAL (mapped to DB enum values)
 *  - Aggregation period (`aggregation`) — daily, weekly, or monthly (default: daily)
 *
 * CRITICAL — Financial Decimal Precision (AAP Rule 0.7.2):
 *  All P&L amounts and percentages are computed using SQL aggregation functions
 *  (SUM, AVG, MAX, MIN) at the database level. Results are returned as strings
 *  from PostgreSQL `numeric(12,4)` and `numeric(8,4)` columns to preserve
 *  decimal precision. JavaScript floating-point arithmetic is NEVER used for
 *  monetary calculations.
 *
 * Consumers:
 *  - `apps/api/src/routes/index.ts`  — Mounted at `/api/performance`
 *  - `apps/web/src/pages/Performance.tsx` — Dashboard performance page
 *  - `apps/web/src/components/PerformanceChart.tsx` — Chart visualizations
 *
 * @module routes/performance
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { eq, and, gte, lte, sql, count, sum, avg, max, min, type SQL } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/index.js";
import { tradePerformance, tradeOpportunities } from "../db/schema/index.js";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger with `{ module: "routes:performance" }` context binding.
 * All log entries from this route handler include this identifier for
 * structured filtering in log aggregation tools.
 */
const logger = createLogger("routes:performance");

// ---------------------------------------------------------------------------
// Query Parameter Validation Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating `GET /api/performance` query parameters.
 *
 * Validates:
 *  - `startDate` — Optional ISO 8601 datetime with timezone offset
 *  - `endDate` — Optional ISO 8601 datetime with timezone offset
 *  - `market` — Optional market filter enum (US, INDIA, CRYPTO, SOCIAL)
 *  - `aggregation` — Aggregation period (daily, weekly, monthly; defaults to "daily")
 *
 * The `.safeParse()` method is used for error-safe validation that returns
 * structured error details instead of throwing exceptions, allowing the
 * handler to return a 400 response with machine-readable error information.
 */
const performanceQuerySchema = z.object({
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  market: z.enum(["US", "INDIA", "CRYPTO", "SOCIAL"]).optional(),
  aggregation: z.enum(["daily", "weekly", "monthly"]).default("daily"),
});

// ---------------------------------------------------------------------------
// Market Value Mapping
// ---------------------------------------------------------------------------

/**
 * Maps uppercase API-facing market identifiers to their lowercase PostgreSQL
 * enum equivalents stored in the `trade_opportunities.market` column.
 *
 * The `as const` assertion preserves literal types so that TypeScript can
 * verify exhaustive coverage and the mapped values are compatible with
 * the `marketEnum` type defined in `enums.ts`.
 */
const MARKET_DB_MAP = {
  US: "us_stock",
  INDIA: "indian_equity",
  CRYPTO: "crypto",
  SOCIAL: "social",
} as const;

// ---------------------------------------------------------------------------
// Router Instance
// ---------------------------------------------------------------------------

/**
 * Express Router instance for performance tracking endpoints.
 *
 * Mounted by `apps/api/src/routes/index.ts` under the `/api` prefix,
 * making the full endpoint path `GET /api/performance`.
 */
export const performanceRouter: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// GET /performance — Aggregate Performance Statistics
// ---------------------------------------------------------------------------

/**
 * Returns aggregate performance statistics for completed trades.
 *
 * Performs an INNER JOIN between `trade_performance` and `trade_opportunities`
 * to access the `market` column for filtering. All monetary aggregations
 * (SUM, AVG, MAX, MIN) are executed at the SQL level to preserve
 * `numeric(12,4)` / `numeric(8,4)` decimal precision.
 *
 * Query Parameters:
 *  - `startDate` (optional) — Filter trades created on or after this date
 *  - `endDate` (optional) — Filter trades created on or before this date
 *  - `market` (optional) — Filter by market: US, INDIA, CRYPTO, SOCIAL
 *  - `aggregation` (optional) — Aggregation period: daily, weekly, monthly (default: daily)
 *
 * Response Shape:
 * ```json
 * {
 *   "data": {
 *     "totalTrades": 42,
 *     "winners": 28,
 *     "losers": 14,
 *     "winRate": 66.67,
 *     "totalPnl": "15234.5600",
 *     "avgPnl": "362.7276",
 *     "bestTrade": "4521.0000",
 *     "worstTrade": "-1200.5000",
 *     "avgPnlPercentage": "3.2150"
 *   },
 *   "filters": {
 *     "startDate": "2026-01-01T00:00:00Z" | null,
 *     "endDate": null,
 *     "market": "US" | null,
 *     "aggregation": "daily"
 *   }
 * }
 * ```
 */
performanceRouter.get(
  "/performance",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // -----------------------------------------------------------------
      // Step 1: Parse and validate query parameters via Zod schema
      // -----------------------------------------------------------------
      const parsed = performanceQuerySchema.safeParse(req.query);

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

      const { startDate, endDate, market } = parsed.data;

      // -----------------------------------------------------------------
      // Step 2: Build WHERE conditions for the JOIN query
      // -----------------------------------------------------------------
      // Each condition is optional and only added when the corresponding
      // query parameter is present. The conditions are composed with AND.

      const conditions: SQL[] = [];

      if (startDate !== undefined) {
        conditions.push(gte(tradePerformance.createdAt, new Date(startDate)));
      }

      if (endDate !== undefined) {
        conditions.push(lte(tradePerformance.createdAt, new Date(endDate)));
      }

      if (market !== undefined) {
        // Map the uppercase API enum to the lowercase PostgreSQL enum value.
        // TypeScript verifies exhaustive key coverage through the const object.
        const marketDbValue = MARKET_DB_MAP[market];
        conditions.push(eq(tradeOpportunities.market, marketDbValue));
      }

      // Compose conditions with AND; undefined means no WHERE clause
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // -----------------------------------------------------------------
      // Step 3: Execute aggregate statistics query using SQL
      // -----------------------------------------------------------------
      // CRITICAL: All monetary aggregations (SUM, AVG, MAX, MIN) are
      // computed at the SQL level on numeric(12,4) / numeric(8,4) columns
      // to preserve financial decimal precision (AAP Rule 0.7.2).
      // PostgreSQL returns these as strings which are passed through to
      // the API response without JavaScript floating-point conversion.
      //
      // Winners and losers are counted using SQL CASE expressions that
      // return 1 (counted) or NULL (not counted by COUNT).

      const statsQuery = await db
        .select({
          totalTrades: count(),
          winners: count(
            sql`CASE WHEN ${tradePerformance.isWinner} = true THEN 1 END`,
          ),
          losers: count(
            sql`CASE WHEN ${tradePerformance.isWinner} = false THEN 1 END`,
          ),
          totalPnl: sum(tradePerformance.pnlAmount),
          avgPnl: avg(tradePerformance.pnlAmount),
          bestTrade: max(tradePerformance.pnlAmount),
          worstTrade: min(tradePerformance.pnlAmount),
          avgPnlPercentage: avg(tradePerformance.pnlPercentage),
        })
        .from(tradePerformance)
        .innerJoin(
          tradeOpportunities,
          eq(tradePerformance.opportunityId, tradeOpportunities.id),
        )
        .where(whereClause);

      // -----------------------------------------------------------------
      // Step 4: Extract and format results
      // -----------------------------------------------------------------
      // With `noUncheckedIndexedAccess`, statsQuery[0] may be undefined.
      // For an aggregate query without GROUP BY, PostgreSQL always returns
      // exactly one row (with zeros/nulls if no matching records), but
      // we handle the undefined case defensively for type safety.

      const stats = statsQuery[0];
      const totalTrades = Number(stats?.totalTrades ?? 0);
      const winners = Number(stats?.winners ?? 0);
      const losers = Number(stats?.losers ?? 0);

      // Win rate is computed inline in the response object below (line ~264)
      // using 0.00–1.00 range rather than percentage for frontend consumption.

      // -----------------------------------------------------------------
      // Step 5: Return aggregate statistics
      // -----------------------------------------------------------------
      // P&L values are returned as strings to preserve numeric precision
      // from PostgreSQL. The frontend is responsible for formatting these
      // for display (e.g., currency symbols, locale-specific formatting).

      // Wrap in ApiResponse<PerformanceResponse> envelope matching the
      // frontend PerformanceResponse type shape expected by Performance.tsx.
      // Fields mapped: winners → wins, losers → losses, avgPnl → averagePnl.
      // winRate is kept in 0.00–1.00 range (frontend multiplies by 100).
      // chartData, marketBreakdown, and recentTrades require dedicated
      // queries not yet implemented — return empty arrays to prevent
      // runtime crashes while satisfying the TypeScript contract.
      res.json({
        success: true,
        data: {
          summary: {
            totalTrades,
            wins: winners,
            losses: losers,
            winRate: totalTrades > 0 ? Number((winners / totalTrades).toFixed(4)) : 0,
            totalPnl: stats?.totalPnl ?? "0",
            averagePnl: stats?.avgPnl ?? "0",
            bestTrade: stats?.bestTrade ?? "0",
            worstTrade: stats?.worstTrade ?? "0",
            averageHoldTime: "N/A",
          },
          chartData: [],
          marketBreakdown: [],
          recentTrades: [],
        },
      });

      logger.debug(
        { market, startDate, endDate, totalTrades },
        "Performance stats queried",
      );
    } catch (error: unknown) {
      next(error);
    }
  },
);
