/**
 * Trade Performance Table Schema
 *
 * Defines the `trade_performance` PostgreSQL table using Drizzle ORM `pg-core`.
 * This table tracks the actual performance outcome of each trade opportunity —
 * comparing recommended prices against actual execution prices and computing
 * profit-and-loss (P&L) metrics.
 *
 * Key design decisions:
 *  - One-to-one relationship with `trade_opportunities` enforced via a UNIQUE
 *    constraint on `opportunity_id`. Each trade opportunity has at most one
 *    performance record.
 *  - All price fields (`actual_entry`, `actual_exit`, `pnl_amount`) use
 *    PostgreSQL `numeric(12,4)` — NEVER floating-point — to avoid precision
 *    errors in financial calculations (AAP Rule 0.7.2). This supports values
 *    up to 99,999,999.9999 with 4 decimal places.
 *  - P&L percentage uses `numeric(8,4)` for higher precision on percentage
 *    tracking, supporting values up to 9,999.9999%.
 *  - Nullable price/P&L columns reflect the trade lifecycle: a performance
 *    record may be created when entry is recorded but exit has not yet occurred.
 *
 * Lifecycle:
 *  1. Created when a trade is entered — `actual_entry` is set, others nullable
 *  2. Updated when the trade is closed — `actual_exit`, `pnl_amount`,
 *     `pnl_percentage`, `is_winner`, and `closed_at` are populated
 *
 * Consumers:
 *  - performance.routes.ts   → GET /api/performance (dashboard aggregation)
 *  - relations.ts            → one-to-one relation with trade_opportunities
 *  - Performance dashboard   → win/loss ratio, cumulative P&L, average returns
 */

import {
  pgTable,
  uuid,
  numeric,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

import { tradeOpportunities } from "./trade-opportunities.js";

// ---------------------------------------------------------------------------
// Table Definition
// ---------------------------------------------------------------------------

/**
 * The `trade_performance` table stores the actual execution and P&L outcome
 * for each trade opportunity that was acted upon.
 *
 * Each trade opportunity can have at most one performance record, enforced
 * by the UNIQUE constraint on `opportunity_id`. This one-to-one relationship
 * is separate from the opportunities table to keep the hot-path query for
 * active opportunities lightweight while allowing detailed performance
 * analysis queries to join when needed.
 */
export const tradePerformance = pgTable("trade_performance", {
  /** Unique performance record identifier (UUID v4, auto-generated) */
  id: uuid("id").defaultRandom().primaryKey(),

  /**
   * Foreign key to the trade opportunity this performance record tracks.
   * UNIQUE constraint enforces one-to-one: each opportunity has at most
   * one performance record.
   * NOT NULL because a performance record is meaningless without a
   * corresponding opportunity.
   */
  opportunityId: uuid("opportunity_id")
    .notNull()
    .unique()
    .references(() => tradeOpportunities.id),

  /**
   * Actual entry price at which the position was opened.
   * Uses numeric(12,4) per AAP Rule 0.7.2 — NEVER floating-point.
   * Nullable because the record may be pre-created before entry execution.
   *
   * Drizzle returns this as `string` in TypeScript to preserve decimal
   * precision. Consumers must parse explicitly for arithmetic operations.
   */
  actualEntry: numeric("actual_entry", { precision: 12, scale: 4 }),

  /**
   * Actual exit price at which the position was closed.
   * Uses numeric(12,4) per AAP Rule 0.7.2 — NEVER floating-point.
   * Nullable because the trade may still be open.
   */
  actualExit: numeric("actual_exit", { precision: 12, scale: 4 }),

  /**
   * Absolute profit/loss amount in the asset's currency units.
   * Positive values indicate profit, negative values indicate loss.
   * Uses numeric(12,4) per AAP Rule 0.7.2 — supports amounts up to
   * 99,999,999.9999.
   * Nullable until the trade is closed and P&L is computed.
   */
  pnlAmount: numeric("pnl_amount", { precision: 12, scale: 4 }),

  /**
   * Percentage profit/loss relative to the entry price.
   * Example: 5.2500 represents a 5.25% gain; -3.1000 represents a 3.10% loss.
   * Uses numeric(8,4) for higher precision on percentages, supporting
   * values up to 9,999.9999%.
   * Nullable until the trade is closed and P&L is computed.
   */
  pnlPercentage: numeric("pnl_percentage", { precision: 8, scale: 4 }),

  /**
   * Boolean outcome flag: true if the trade was profitable (P&L > 0),
   * false if it was a loss (P&L <= 0).
   * Nullable until the trade is closed and outcome is determined.
   * Used for win/loss ratio aggregation on the performance dashboard.
   */
  isWinner: boolean("is_winner"),

  /**
   * Timestamp when the trade was closed (position exited).
   * Nullable because the trade may still be open.
   * Uses timezone-aware timestamp for consistent cross-timezone reporting.
   */
  closedAt: timestamp("closed_at", { withTimezone: true }),

  /**
   * When this performance record was first created in the database.
   * Auto-populated with the current timestamp on insert.
   */
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),

  /**
   * Last update timestamp for this performance record.
   * Updated when exit price, P&L, or outcome fields are populated.
   * Auto-populated with the current timestamp on insert.
   */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------

/**
 * Type for SELECT query results — represents a complete trade performance row
 * from the database with all columns populated (including auto-generated
 * fields like id, createdAt, updatedAt).
 *
 * Note: Drizzle returns `numeric` columns as `string | null` in TypeScript
 * to preserve decimal precision. Consumers must parse these values explicitly
 * when arithmetic operations are needed (e.g., `parseFloat(row.pnlAmount)`
 * for display, or use a decimal library for financial calculations).
 */
export type TradePerformance = typeof tradePerformance.$inferSelect;

/**
 * Type for INSERT values — represents the data needed to create a new
 * trade performance record. Auto-generated columns (id, createdAt, updatedAt)
 * are optional. Nullable columns (actualEntry, actualExit, pnlAmount,
 * pnlPercentage, isWinner, closedAt) are also optional.
 *
 * Required fields: opportunityId (the FK to trade_opportunities).
 */
export type NewTradePerformance = typeof tradePerformance.$inferInsert;
