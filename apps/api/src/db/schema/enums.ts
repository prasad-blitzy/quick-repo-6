/**
 * Shared PostgreSQL Enum Definitions
 *
 * Defines all PostgreSQL ENUM types used across multiple database table schemas.
 * Each enum is created using Drizzle ORM's `pgEnum` function, which generates
 * both the SQL `CREATE TYPE "name" AS ENUM(...)` definition and a reusable
 * Drizzle column type factory for table definitions.
 *
 * These enums enforce type constraints at the PostgreSQL level — values are stored
 * as human-readable strings (not integers) in the database.
 *
 * Consumers:
 *  - news-articles.ts      → marketEnum
 *  - trade-opportunities.ts → marketEnum, directionEnum, statusEnum, timeframeEnum
 *  - analysis-logs.ts      → pipelineStepEnum
 *  - index.ts (barrel)     → re-exports all enums
 */

import { pgEnum } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// 1. Market Enum
// ---------------------------------------------------------------------------
/**
 * Categorizes the financial market segment for news articles and trade opportunities.
 *
 * PostgreSQL type: CREATE TYPE "market" AS ENUM('us_stock','indian_equity','crypto','social')
 *
 * Values:
 *  - us_stock      — US stock market (NYSE, NASDAQ)
 *  - indian_equity — Indian equity market (NSE, BSE)
 *  - crypto        — Cryptocurrency markets (BTC, ETH, altcoins)
 *  - social        — Social media sentiment sources (Reddit, forums)
 */
export const marketEnum = pgEnum("market", [
  "us_stock",
  "indian_equity",
  "crypto",
  "social",
]);

// ---------------------------------------------------------------------------
// 2. Direction Enum
// ---------------------------------------------------------------------------
/**
 * Trade direction recommendation indicating bullish or bearish conviction.
 *
 * PostgreSQL type: CREATE TYPE "direction" AS ENUM('long','short')
 *
 * Values:
 *  - long  — Buy / bullish recommendation (🟢 in Telegram alerts)
 *  - short — Sell / bearish recommendation (🔴 in Telegram alerts)
 */
export const directionEnum = pgEnum("direction", [
  "long",
  "short",
]);

// ---------------------------------------------------------------------------
// 3. Status Enum
// ---------------------------------------------------------------------------
/**
 * Lifecycle status of a trade opportunity.
 *
 * PostgreSQL type: CREATE TYPE "status" AS ENUM('active','closed','expired')
 *
 * Values:
 *  - active  — Currently valid trade recommendation awaiting resolution
 *  - closed  — Trade has been closed (hit target, hit stop, or manually closed)
 *  - expired — Trade opportunity expired without being acted upon (time-based)
 */
export const statusEnum = pgEnum("status", [
  "active",
  "closed",
  "expired",
]);

// ---------------------------------------------------------------------------
// 4. Timeframe Enum
// ---------------------------------------------------------------------------
/**
 * Trade holding period / timeframe for the recommended position.
 *
 * PostgreSQL type: CREATE TYPE "timeframe" AS ENUM('intraday','swing','position')
 *
 * Values:
 *  - intraday — Same-day trades (minutes to hours)
 *  - swing    — Multi-day trades (days to weeks)
 *  - position — Longer-term positions (weeks to months)
 */
export const timeframeEnum = pgEnum("timeframe", [
  "intraday",
  "swing",
  "position",
]);

// ---------------------------------------------------------------------------
// 5. Pipeline Step Enum
// ---------------------------------------------------------------------------
/**
 * Identifies a specific stage in the four-node LangGraph AI analysis pipeline.
 * Used by analysis_logs to track which step produced a given log entry, along
 * with its token usage and cost metrics.
 *
 * PostgreSQL type: CREATE TYPE "pipeline_step" AS ENUM('filter','sentiment','trade_detect','recommend')
 *
 * Values:
 *  - filter       — Binary relevance classification (DeepSeek V3.2)
 *  - sentiment    — Nuanced sentiment analysis (Claude Haiku 4.5)
 *  - trade_detect — Trade opportunity detection (Claude Haiku 4.5)
 *  - recommend    — Trade recommendation generation (Claude Sonnet 4.6)
 */
export const pipelineStepEnum = pgEnum("pipeline_step", [
  "filter",
  "sentiment",
  "trade_detect",
  "recommend",
]);
