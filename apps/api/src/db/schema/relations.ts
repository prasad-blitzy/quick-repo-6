/**
 * Drizzle ORM Relation Definitions
 *
 * Defines table relationships using the `relations()` function from `drizzle-orm`.
 * These relation definitions are SEPARATE from the actual foreign key constraints
 * defined in the individual table schema files — they enable Drizzle's relational
 * query API for type-safe eager loading:
 *
 *   ```typescript
 *   const articles = await db.query.newsArticles.findMany({
 *     with: { tradeOpportunities: true, analysisLogs: true },
 *   });
 *   ```
 *
 * Relationship graph (from AAP Section 0.4.3):
 *
 *   news_articles ─┬── 1:N ──▸ trade_opportunities ─┬── 1:1 ──▸ trade_performance
 *                  │                                 └── 1:N ──▸ notification_logs
 *                  └── 1:N ──▸ analysis_logs
 *
 *   user_settings ──── 1:N ──▸ notification_logs
 *
 * Convention:
 *  - `one()` is defined on the side that holds the FK column, using `fields`
 *    (the local FK columns) and `references` (the target PK columns).
 *  - `many()` is defined on the inverse (parent) side with no FK specification.
 *  - The `api_sources` table has NO relations — it's a standalone lookup table.
 *
 * @module relations
 */

import { relations } from "drizzle-orm";

import { newsArticles } from "./news-articles.js";
import { tradeOpportunities } from "./trade-opportunities.js";
import { tradePerformance } from "./trade-performance.js";
import { userSettings } from "./user-settings.js";
import { analysisLogs } from "./analysis-logs.js";
import { notificationLogs } from "./notification-logs.js";

// ---------------------------------------------------------------------------
// news_articles Relations
// ---------------------------------------------------------------------------

/**
 * Relations for the `news_articles` table.
 *
 * A news article is the root entity in the data pipeline. Each article can:
 *  - Generate multiple trade opportunities (across different symbols/timeframes)
 *  - Produce multiple analysis log entries (one per LangGraph pipeline step:
 *    filter → sentiment → trade_detect → recommend)
 */
export const newsArticlesRelations = relations(newsArticles, ({ many }) => ({
  /**
   * One article → many trade opportunities.
   * A single article may contain information about multiple assets or be
   * analyzed across multiple timeframes, each producing a distinct opportunity.
   */
  tradeOpportunities: many(tradeOpportunities),

  /**
   * One article → many analysis logs.
   * Each pipeline step (filter, sentiment, trade_detect, recommend) creates
   * its own log entry. An article may have 1–4 log entries depending on how
   * far it progresses through the conditional pipeline.
   */
  analysisLogs: many(analysisLogs),
}));

// ---------------------------------------------------------------------------
// trade_opportunities Relations
// ---------------------------------------------------------------------------

/**
 * Relations for the `trade_opportunities` table.
 *
 * A trade opportunity connects to:
 *  - Its source news article (many-to-one via articleId FK)
 *  - Its performance tracking record (one-to-one via tradePerformance.opportunityId)
 *  - All notification logs generated from it (one-to-many)
 */
export const tradeOpportunitiesRelations = relations(
  tradeOpportunities,
  ({ one, many }) => ({
    /**
     * Many opportunities → one article.
     * FK: trade_opportunities.article_id → news_articles.id
     * Each opportunity is derived from exactly one source news article.
     */
    article: one(newsArticles, {
      fields: [tradeOpportunities.articleId],
      references: [newsArticles.id],
    }),

    /**
     * One opportunity → one performance record.
     * The FK physically lives on trade_performance.opportunity_id, but we
     * define this relation on the opportunity side using the opportunity's PK
     * as the field and the performance table's FK column as the reference.
     * This allows queries like:
     *   db.query.tradeOpportunities.findFirst({ with: { performance: true } })
     */
    performance: one(tradePerformance, {
      fields: [tradeOpportunities.id],
      references: [tradePerformance.opportunityId],
    }),

    /**
     * One opportunity → many notification logs.
     * A single trade opportunity triggers Telegram alerts to all matching
     * subscribers, each producing a separate notification log entry.
     */
    notificationLogs: many(notificationLogs),
  }),
);

// ---------------------------------------------------------------------------
// trade_performance Relations
// ---------------------------------------------------------------------------

/**
 * Relations for the `trade_performance` table.
 *
 * A performance record tracks the actual execution outcome (entry price,
 * exit price, P&L) for exactly one trade opportunity. The UNIQUE constraint
 * on `opportunity_id` enforces the one-to-one relationship at the DB level.
 */
export const tradePerformanceRelations = relations(
  tradePerformance,
  ({ one }) => ({
    /**
     * One performance → one opportunity.
     * FK: trade_performance.opportunity_id → trade_opportunities.id (UNIQUE)
     * This is the owning side of the one-to-one relationship.
     */
    opportunity: one(tradeOpportunities, {
      fields: [tradePerformance.opportunityId],
      references: [tradeOpportunities.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// user_settings Relations
// ---------------------------------------------------------------------------

/**
 * Relations for the `user_settings` table.
 *
 * Each Telegram subscriber (user) may receive many trade alert notifications.
 * The notification logs track delivery status for each alert sent to the user.
 */
export const userSettingsRelations = relations(userSettings, ({ many }) => ({
  /**
   * One user → many notification logs.
   * Tracks all Telegram trade alerts dispatched to this subscriber,
   * including delivery status (pending, sent, failed, skipped).
   */
  notificationLogs: many(notificationLogs),
}));

// ---------------------------------------------------------------------------
// analysis_logs Relations
// ---------------------------------------------------------------------------

/**
 * Relations for the `analysis_logs` table.
 *
 * Each analysis log entry records one LangGraph pipeline step execution
 * (filter, sentiment, trade_detect, or recommend) for a specific article.
 */
export const analysisLogsRelations = relations(analysisLogs, ({ one }) => ({
  /**
   * Many analysis logs → one article.
   * FK: analysis_logs.article_id → news_articles.id
   * Multiple log entries (one per pipeline step) reference the same article.
   */
  article: one(newsArticles, {
    fields: [analysisLogs.articleId],
    references: [newsArticles.id],
  }),
}));

// ---------------------------------------------------------------------------
// notification_logs Relations
// ---------------------------------------------------------------------------

/**
 * Relations for the `notification_logs` table.
 *
 * Each notification log entry records the delivery attempt of one trade alert
 * to one user. It connects to both the triggering trade opportunity and the
 * target subscriber.
 */
export const notificationLogsRelations = relations(
  notificationLogs,
  ({ one }) => ({
    /**
     * Many notification logs → one trade opportunity.
     * FK: notification_logs.opportunity_id → trade_opportunities.id
     * Links each notification to the trade alert that triggered it.
     */
    opportunity: one(tradeOpportunities, {
      fields: [notificationLogs.opportunityId],
      references: [tradeOpportunities.id],
    }),

    /**
     * Many notification logs → one user.
     * FK: notification_logs.user_id → user_settings.id
     * Links each notification to the Telegram subscriber who received it.
     */
    user: one(userSettings, {
      fields: [notificationLogs.userId],
      references: [userSettings.id],
    }),
  }),
);
