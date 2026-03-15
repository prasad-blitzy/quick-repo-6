/**
 * Database Schema Barrel Export
 *
 * Central entry point that re-exports all Drizzle ORM schema definitions from
 * a single module. This barrel export is consumed by:
 *
 *  1. `apps/api/src/db/index.ts`     — `import * as schema from "./schema/index.js"`
 *     Passes the unified schema namespace to `drizzle()` to enable the relational
 *     query API (`db.query.newsArticles.findMany({ with: { ... } })`).
 *
 *  2. `apps/api/drizzle.config.ts`   — `schema: "./src/db/schema/index.ts"`
 *     Used by `drizzle-kit` for migration generation and schema introspection.
 *
 *  3. Various services, routes, and workers that import specific table references
 *     (e.g., `import { newsArticles, tradeOpportunities } from "../db/schema/index.js"`)
 *     for type-safe Drizzle ORM queries.
 *
 * Re-exported modules (9 total):
 *  - enums.ts              → marketEnum, directionEnum, statusEnum, timeframeEnum, pipelineStepEnum
 *  - news-articles.ts      → newsArticles table, NewsArticle, NewNewsArticle types
 *  - trade-opportunities.ts → tradeOpportunities table, TradeOpportunity, NewTradeOpportunity types
 *  - trade-performance.ts  → tradePerformance table, TradePerformance, NewTradePerformance types
 *  - user-settings.ts      → userSettings table, UserSettings, NewUserSettings types
 *  - api-sources.ts        → apiSources table, ApiSource, NewApiSource types
 *  - analysis-logs.ts      → analysisLogs table, AnalysisLog, NewAnalysisLog types
 *  - notification-logs.ts  → notificationLogs table, NotificationLog, NewNotificationLog types
 *  - relations.ts          → all Drizzle ORM relation definitions for type-safe eager loading
 *
 * IMPORTANT: All import paths use `.js` extensions as required by TypeScript's
 * NodeNext module resolution strategy (AAP Rule 0.7.1). TypeScript resolves
 * these to the corresponding `.ts` source files during compilation.
 *
 * @module schema
 */

// ---------------------------------------------------------------------------
// PostgreSQL Enum Definitions
// ---------------------------------------------------------------------------
// Exports: marketEnum, directionEnum, statusEnum, timeframeEnum, pipelineStepEnum
export * from "./enums.js";

// ---------------------------------------------------------------------------
// Table Schema Definitions
// ---------------------------------------------------------------------------
// Each module exports the Drizzle pgTable definition and inferred TypeScript
// types for SELECT ($inferSelect) and INSERT ($inferInsert) operations.

// Exports: newsArticles, NewsArticle, NewNewsArticle
export * from "./news-articles.js";

// Exports: tradeOpportunities, TradeOpportunity, NewTradeOpportunity
export * from "./trade-opportunities.js";

// Exports: tradePerformance, TradePerformance, NewTradePerformance
export * from "./trade-performance.js";

// Exports: userSettings, UserSettings, NewUserSettings
export * from "./user-settings.js";

// Exports: apiSources, ApiSource, NewApiSource
export * from "./api-sources.js";

// Exports: analysisLogs, AnalysisLog, NewAnalysisLog
export * from "./analysis-logs.js";

// Exports: notificationLogs, NotificationLog, NewNotificationLog
export * from "./notification-logs.js";

// ---------------------------------------------------------------------------
// Drizzle ORM Relation Definitions
// ---------------------------------------------------------------------------
// Exports: newsArticlesRelations, tradeOpportunitiesRelations,
//          tradePerformanceRelations, userSettingsRelations,
//          analysisLogsRelations, notificationLogsRelations
export * from "./relations.js";
