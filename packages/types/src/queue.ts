/**
 * BullMQ Queue Job Payload Type Definitions
 *
 * Defines TypeScript interfaces for all BullMQ queue job payloads used in the
 * Trading Intelligence Application. These types ensure type-safe job enqueuing
 * and processing across the three distinct queues:
 *
 *   1. `news-polling`   — Triggers periodic news ingestion from data sources
 *   2. `analysis`       — Processes articles through the LangGraph AI pipeline
 *   3. `notifications`  — Delivers matched trade alerts via Telegram
 *
 * Consumers:
 *   - `apps/api/src/queues/*.queue.ts`          — Queue definitions (typed `add()`)
 *   - `apps/api/src/queues/workers/*.worker.ts`  — Worker handlers (typed `job.data`)
 *
 * Design constraints (AAP Rules):
 *   - Three separate queues with independent workers (Rule 0.7.6)
 *   - Breaking news uses priority 1 (highest) for analysis and notifications (Rule 0.7.6)
 *   - No `any` type — strict mode with `exactOptionalPropertyTypes` (Rule 0.7.1)
 *   - ESM imports with `.js` extension (Rule 0.7.1)
 *   - No runtime code — interfaces only (erased at compile time)
 *
 * @module @trading-intelligence/types/queue
 */

import { Market } from './news.js';

// ---------------------------------------------------------------------------
// News Polling Queue Payload
// ---------------------------------------------------------------------------

/**
 * Job payload for the `news-polling` BullMQ queue.
 *
 * The news-polling queue runs on a repeatable 5-minute cron interval
 * (AAP Section 0.5.1 Group 7). Each job triggers a polling cycle that
 * fetches articles from registered data sources, deduplicates by URL,
 * stores new articles in the database, and enqueues them for analysis.
 *
 * Both fields are optional — a bare `{}` payload triggers a full polling
 * cycle across all active sources and all markets.
 *
 * @example
 * ```typescript
 * // Poll all sources and markets (default cron behavior)
 * await newsPollingQueue.add('poll', {});
 *
 * // Poll only Finnhub and CoinGecko
 * await newsPollingQueue.add('poll', { sources: ['finnhub', 'coingecko'] });
 *
 * // Poll only crypto market sources
 * await newsPollingQueue.add('poll', { market: Market.CRYPTO });
 * ```
 */
export interface NewsPollingPayload {
  /**
   * Optional list of specific source identifiers to poll.
   *
   * When provided, only the named sources are fetched (e.g., `['finnhub', 'coingecko']`).
   * When omitted (`undefined`), all active sources registered in the `api_sources`
   * table are polled.
   */
  sources?: string[];

  /**
   * Optional market category filter for this polling cycle.
   *
   * When provided, only sources covering the specified market are polled.
   * When omitted (`undefined`), all markets (US stocks, Indian equities,
   * crypto, social) are polled.
   */
  market?: Market;
}

// ---------------------------------------------------------------------------
// Analysis Queue Payload
// ---------------------------------------------------------------------------

/**
 * Job payload for the `analysis` BullMQ queue.
 *
 * Each job processes a single news article through the four-stage LangGraph
 * analysis pipeline: Filter → Sentiment → Trade Detection → Recommendation.
 * Conditional short-circuiting routes only ~25% of articles to the expensive
 * recommendation model, achieving ~75% LLM cost reduction (AAP Section 0.1.1).
 *
 * The analysis worker should limit concurrency to respect OpenRouter rate
 * limits (AAP Rule 0.7.6).
 *
 * @example
 * ```typescript
 * // Enqueue a normal-priority article for analysis
 * await analysisQueue.add('analyze', { articleId: 'uuid-here' });
 *
 * // Enqueue a breaking news article with highest priority
 * await analysisQueue.add('analyze', { articleId: 'uuid-here', priority: 1 });
 * ```
 */
export interface AnalysisPayload {
  /**
   * UUID of the news article to analyze.
   *
   * References `news_articles.id` in the database. The analysis worker
   * retrieves the full article record by this ID and runs it through
   * the LangGraph pipeline.
   */
  articleId: string;

  /**
   * Optional BullMQ job priority level.
   *
   * - `1` = breaking news (highest priority, processed first)
   * - Higher numbers = lower priority
   *
   * When omitted, BullMQ uses default priority (FIFO ordering).
   * Per AAP Rule 0.7.6: breaking news alerts use priority 1.
   */
  priority?: number;
}

// ---------------------------------------------------------------------------
// Notification Queue Payload
// ---------------------------------------------------------------------------

/**
 * Job payload for the `notifications` BullMQ queue.
 *
 * Each job triggers the delivery of trade alert notifications for a single
 * trade opportunity. The notification worker matches the opportunity against
 * subscriber preferences (market, minimum confidence, timeframes) from the
 * `user_settings` table and sends MarkdownV2-formatted Telegram messages
 * to each matching user.
 *
 * The notification queue supports priority levels, with breaking news alerts
 * at priority 1 (highest) per AAP Rule 0.7.6.
 *
 * @example
 * ```typescript
 * // Enqueue a normal notification
 * await notificationsQueue.add('notify', { opportunityId: 'uuid-here' });
 *
 * // Enqueue a breaking news notification with highest priority
 * await notificationsQueue.add('notify', { opportunityId: 'uuid-here', priority: 1 });
 * ```
 */
export interface NotificationPayload {
  /**
   * UUID of the trade opportunity to notify subscribers about.
   *
   * References `trade_opportunities.id` in the database. The notification
   * worker retrieves the full opportunity record by this ID, matches it
   * against user preferences, and sends formatted alerts via Telegram.
   */
  opportunityId: string;

  /**
   * Optional BullMQ job priority level.
   *
   * - `1` = breaking news alert (highest priority, sent first)
   * - Higher numbers = lower priority
   *
   * When omitted, BullMQ uses default priority (FIFO ordering).
   * Per AAP Rule 0.7.6: "notification queue must support priority levels,
   * with breaking news alerts at priority 1 (highest)".
   */
  priority?: number;
}
