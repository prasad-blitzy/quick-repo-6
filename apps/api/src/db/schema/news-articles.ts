/**
 * News Articles Table Schema
 *
 * Defines the `news_articles` PostgreSQL table using Drizzle ORM `pg-core`.
 * This is the primary data ingestion table where all fetched news articles
 * from 30+ sources (Finnhub, RSS feeds, CoinGecko, CryptoCompare, Reddit,
 * Binance, Alpha Vantage, NSE India) are stored.
 *
 * Key design decisions:
 *  - URL-based deduplication via UNIQUE index (AAP Rule 0.7.4):
 *    The polling worker uses INSERT ... ON CONFLICT (url) DO NOTHING to
 *    silently skip duplicate articles across polling cycles.
 *  - Sentiment scores use numeric(5,3) for millisentiment precision
 *    in the range -1.000 to +1.000 (AAP Rule 0.7.2).
 *  - PostgreSQL enum for market type ensures type safety at the database level.
 *  - JSONB metadata column for source-specific flexible fields.
 *  - Text array for symbol tagging (e.g., ["AAPL", "MSFT"]).
 *
 * Indexes (from AAP Section 0.4.3):
 *  1. (url) UNIQUE       — URL-based deduplication (MOST CRITICAL)
 *  2. (published_at, source) — Time-range queries filtered by source
 *  3. (is_analyzed)       — Quick lookup of unanalyzed articles
 *
 * Consumers:
 *  - news-polling.worker.ts  → INSERT with ON CONFLICT DO NOTHING
 *  - analysis.worker.ts      → SELECT WHERE is_analyzed = false, UPDATE after pipeline
 *  - analyzer/index.ts       → Reads article content for LangGraph pipeline input
 *  - news.routes.ts          → GET /api/news with pagination and filtering
 *  - relations.ts            → one-to-many to trade_opportunities and analysis_logs
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { marketEnum } from "./enums.js";

// ---------------------------------------------------------------------------
// Table Definition
// ---------------------------------------------------------------------------

/**
 * The `news_articles` table stores all fetched financial news articles.
 *
 * Articles are deduplicated by URL using a UNIQUE constraint. The news-polling
 * worker uses Drizzle's `onConflictDoNothing({ target: newsArticles.url })`
 * to silently skip duplicates from different polling cycles (AAP Rule 0.7.4).
 *
 * The `is_analyzed` flag tracks pipeline processing status — the analysis queue
 * worker queries for articles where `is_analyzed = false` and processes them
 * through the four-stage LangGraph pipeline:
 *   filter → sentiment → trade detection → recommendation
 */
export const newsArticles = pgTable(
  "news_articles",
  {
    /** Unique article identifier (UUID v4, auto-generated) */
    id: uuid("id").defaultRandom().primaryKey(),

    /** Article headline / title */
    title: text("title").notNull(),

    /**
     * Article URL — the deduplication key for the entire ingestion system.
     * A UNIQUE index on this column ensures that duplicate articles from
     * different polling cycles are silently rejected via ON CONFLICT DO NOTHING.
     */
    url: text("url").notNull(),

    /**
     * Source name identifying where the article was fetched from.
     * Examples: "Finnhub", "Economic Times RSS", "Reddit", "CoinGecko",
     * "CryptoCompare", "Binance", "Alpha Vantage", "NSE India"
     */
    source: text("source").notNull(),

    /**
     * Market category using the PostgreSQL enum type from enums.ts.
     * Values: us_stock, indian_equity, crypto, social
     */
    market: marketEnum("market").notNull(),

    /**
     * Full article content body.
     * May be null if only title/summary are available from the source API.
     */
    content: text("content"),

    /**
     * Article summary — either extracted from the source API response
     * or generated during the analysis pipeline processing.
     */
    summary: text("summary"),

    /**
     * Array of related trading symbols.
     * Examples: ["AAPL", "MSFT"], ["RELIANCE.NS", "TCS.NS"], ["BTC", "ETH"]
     * Defaults to an empty PostgreSQL text array using native SQL casting.
     */
    symbols: text("symbols").array().default(sql`'{}'::text[]`),

    /** When the article was originally published by the source */
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),

    /**
     * Whether the article has been processed by the LangGraph analysis pipeline.
     * Defaults to false; set to true after the analysis worker completes
     * all applicable pipeline stages. Indexed for efficient querying.
     */
    isAnalyzed: boolean("is_analyzed").notNull().default(false),

    /**
     * Pipeline-computed sentiment score.
     * Range: -1.000 (very negative) to +1.000 (very positive).
     * Uses numeric(5,3) for millisentiment precision (AAP Rule 0.7.2).
     * Null until the article passes through the sentiment analysis stage.
     */
    sentimentScore: numeric("sentiment_score", { precision: 5, scale: 3 }),

    /**
     * Source-specific metadata stored as JSONB.
     * May include: image URLs, author name, category tags, raw API response
     * fields, related article IDs, or any other source-specific data that
     * doesn't warrant its own column.
     */
    metadata: jsonb("metadata"),

    /** When the article record was first stored in the database */
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /** Last update timestamp (e.g., when analysis results are written back) */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    /**
     * UNIQUE index on URL for deduplication (AAP Rule 0.7.4).
     * This is the MOST CRITICAL index in the entire system — it ensures
     * that duplicate articles from different polling cycles are silently
     * skipped via INSERT ... ON CONFLICT (url) DO NOTHING.
     */
    uniqueIndex("idx_news_articles_url").on(table.url),

    /**
     * Composite index for efficient time-range queries filtered by source.
     * Used by GET /api/news for the paginated, filterable news feed dashboard.
     * Supports queries like: WHERE published_at BETWEEN ? AND ? AND source = ?
     */
    index("idx_news_articles_published_source").on(
      table.publishedAt,
      table.source,
    ),

    /**
     * Index for quickly finding unanalyzed articles.
     * Used by the analysis queue worker to efficiently query articles
     * pending LangGraph pipeline processing (WHERE is_analyzed = false).
     */
    index("idx_news_articles_is_analyzed").on(table.isAnalyzed),
  ],
);

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------

/**
 * Type for SELECT query results — represents a complete news article row
 * from the database with all columns populated (including auto-generated
 * fields like id, createdAt, updatedAt).
 */
export type NewsArticle = typeof newsArticles.$inferSelect;

/**
 * Type for INSERT values — represents the data needed to create a new
 * news article record. Auto-generated columns (id, createdAt, updatedAt)
 * and columns with defaults (isAnalyzed, symbols) are optional.
 */
export type NewNewsArticle = typeof newsArticles.$inferInsert;
