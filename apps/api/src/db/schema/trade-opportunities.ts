/**
 * Trade Opportunities Table Schema
 *
 * Defines the `trade_opportunities` PostgreSQL table using Drizzle ORM `pg-core`.
 * This is a core business table that stores AI-generated trade recommendations
 * produced by the four-stage LangGraph analysis pipeline (filter → sentiment →
 * trade detection → recommendation).
 *
 * Each opportunity is linked to the source news article that triggered it
 * via a foreign key reference to `news_articles.id`.
 *
 * Key design decisions:
 *  - All price fields (entry_price, stop_loss, take_profit) use PostgreSQL
 *    `numeric(12,4)` — NEVER floating-point — to avoid precision errors in
 *    financial calculations (AAP Rule 0.7.2). This supports prices up to
 *    99,999,999.9999 with 4 decimal places.
 *  - Confidence score uses `numeric(3,2)` for range 0.00–1.00 (AAP Rule 0.7.2).
 *  - Risk-reward ratio uses `numeric(5,2)` for range 0.00–999.99.
 *  - PostgreSQL enums for market, direction, status, and timeframe enforce
 *    type constraints at the database level.
 *  - Status defaults to "active" for new opportunities.
 *  - Two composite indexes optimize the most frequent dashboard queries.
 *
 * Indexes (from AAP Section 0.4.3):
 *  1. (created_at, market, status) — Dashboard filtering and sorting
 *  2. (symbol, status)            — Per-symbol active opportunity lookup
 *
 * Consumers:
 *  - analyzer/nodes/recommend.ts     → Creates new trade opportunities from LLM output
 *  - analysis.worker.ts              → Inserts opportunities after pipeline completion
 *  - notifications.worker.ts         → Reads opportunities to match user preferences
 *  - opportunities.routes.ts         → GET /api/opportunities with filters
 *  - relations.ts                    → many-to-one news_articles, one-to-one trade_performance,
 *                                      one-to-many notification_logs
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { marketEnum, directionEnum, statusEnum, timeframeEnum } from "./enums.js";
import { newsArticles } from "./news-articles.js";

// ---------------------------------------------------------------------------
// Table Definition
// ---------------------------------------------------------------------------

/**
 * The `trade_opportunities` table stores all AI-generated trade recommendations.
 *
 * A trade opportunity is created when the LangGraph pipeline's recommendation
 * node (Claude Sonnet 4.6) produces a structured output with sufficient
 * confidence. The opportunity captures:
 *  - Asset identification (symbol + market)
 *  - Direction (LONG 🟢 / SHORT 🔴)
 *  - Price targets (entry, stop loss, take profit) with decimal precision
 *  - AI confidence score and reasoning
 *  - Timeframe and risk-reward ratio
 *
 * Lifecycle:
 *  1. Created as "active" when the analysis pipeline detects a trade
 *  2. Matched against user preferences for Telegram notification delivery
 *  3. Transitions to "closed" when price target or stop loss is hit
 *  4. Transitions to "expired" when the timeframe expires without resolution
 *  5. May be "cancelled" if manually invalidated by the system operator
 */
export const tradeOpportunities = pgTable(
  "trade_opportunities",
  {
    /** Unique opportunity identifier (UUID v4, auto-generated) */
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Foreign key to the source news article that triggered this opportunity.
     * Establishes a many-to-one relationship: one article can generate
     * multiple opportunities across different symbols or timeframes.
     */
    articleId: uuid("article_id")
      .notNull()
      .references(() => newsArticles.id),

    /**
     * Trading symbol for the asset.
     * Format varies by market:
     *  - US stocks: "AAPL", "MSFT", "TSLA"
     *  - Indian equities: "RELIANCE.NS", "TCS.NS", "INFY.NS"
     *  - Crypto: "BTC/USDT", "ETH/USDT", "SOL/USDT"
     */
    symbol: text("symbol").notNull(),

    /**
     * Market category using the PostgreSQL enum type from enums.ts.
     * Values: us_stock, indian_equity, crypto, social
     */
    market: marketEnum("market").notNull(),

    /**
     * Trade direction recommendation.
     * Values: long (bullish 🟢) or short (bearish 🔴)
     * Used by the Telegram notification formatter for emoji indicators.
     */
    direction: directionEnum("direction").notNull(),

    /**
     * AI confidence score for this recommendation.
     * Range: 0.00 to 1.00 (100% confidence).
     * Uses numeric(3,2) for precision (AAP Rule 0.7.2).
     * Used for subscriber preference matching — users set a min_confidence threshold.
     */
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),

    /**
     * Recommended entry price for the position.
     * Uses numeric(12,4) — NEVER floating-point — per AAP Rule 0.7.2.
     * Supports prices up to 99,999,999.9999 with 4 decimal places.
     * Cross-validated against actual market data from API sources to prevent
     * LLM hallucinated price targets (anti-hallucination safeguard).
     */
    entryPrice: numeric("entry_price", { precision: 12, scale: 4 }).notNull(),

    /**
     * Stop loss price level — the risk threshold below/above which the
     * trade should be exited to limit losses.
     * Uses numeric(12,4) per AAP Rule 0.7.2.
     */
    stopLoss: numeric("stop_loss", { precision: 12, scale: 4 }).notNull(),

    /**
     * Take profit price target — the reward threshold at which the
     * trade should be closed to capture gains.
     * Uses numeric(12,4) per AAP Rule 0.7.2.
     */
    takeProfit: numeric("take_profit", { precision: 12, scale: 4 }).notNull(),

    /**
     * Trade holding period / timeframe for the recommended position.
     * Values: intraday (minutes–hours), swing (days–weeks), position (weeks–months)
     * Used for subscriber preference matching and expiry calculation.
     */
    timeframe: timeframeEnum("timeframe").notNull(),

    /**
     * AI-generated reasoning for the trade recommendation.
     * Contains the Claude Sonnet 4.6 model's structured analysis including:
     * catalysts, technical levels, risk factors, and conviction rationale.
     * Displayed in Telegram alerts and the React dashboard trade cards.
     */
    reasoning: text("reasoning").notNull(),

    /**
     * Opportunity lifecycle status.
     * Values: active, closed, expired, cancelled
     * Defaults to "active" on creation; transitions driven by:
     *  - Price target/stop loss hit → "closed"
     *  - Timeframe expiry → "expired"
     *  - Manual operator action → "cancelled"
     */
    status: statusEnum("status").notNull().default("active"),

    /**
     * Computed risk-to-reward ratio.
     * Example: 2.50 means the potential reward is 2.5x the potential risk.
     * Calculated as: |take_profit - entry_price| / |entry_price - stop_loss|
     * Uses numeric(5,2) for range 0.00 to 999.99.
     * Nullable because it may not always be computable (e.g., if stop_loss = entry_price).
     */
    riskRewardRatio: numeric("risk_reward_ratio", { precision: 5, scale: 2 }),

    /** When this trade opportunity was first created in the database */
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /** Last update timestamp (e.g., when status changes or price targets are refined) */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * When this opportunity expires based on its timeframe.
     * Nullable because expiry may not always be set (e.g., position trades).
     * The system periodically checks active opportunities past their expiry
     * and transitions them to "expired" status.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    /**
     * Composite index for dashboard filtering and sorting.
     * Optimizes the most common query pattern: GET /api/opportunities
     * WHERE market = ? AND status = ? ORDER BY created_at DESC
     */
    index("idx_trade_opportunities_created_market_status").on(
      table.createdAt,
      table.market,
      table.status,
    ),

    /**
     * Composite index for per-symbol active opportunity lookup.
     * Used to check if there's already an active opportunity for a given symbol
     * before creating a new one (prevents duplicate active recommendations).
     * Supports queries like: WHERE symbol = ? AND status = 'active'
     */
    index("idx_trade_opportunities_symbol_status").on(
      table.symbol,
      table.status,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------

/**
 * Type for SELECT query results — represents a complete trade opportunity row
 * from the database with all columns populated (including auto-generated
 * fields like id, createdAt, updatedAt).
 *
 * Note: Drizzle returns `numeric` columns as `string` in TypeScript to preserve
 * decimal precision. Consumers must parse these values explicitly when arithmetic
 * operations are needed (e.g., `parseFloat(row.entryPrice)` for display, or use
 * a decimal library for calculations).
 */
export type TradeOpportunity = typeof tradeOpportunities.$inferSelect;

/**
 * Type for INSERT values — represents the data needed to create a new
 * trade opportunity record. Auto-generated columns (id, createdAt, updatedAt)
 * and columns with defaults (status) are optional. Nullable columns
 * (riskRewardRatio, expiresAt) are also optional.
 */
export type NewTradeOpportunity = typeof tradeOpportunities.$inferInsert;
