/**
 * BullMQ Queue Job Payload Type Definitions
 *
 * Types for the Trading Intelligence Application's three BullMQ job queues:
 *   1. `news-polling`   — Triggers periodic news ingestion from all sources
 *   2. `analysis`       — Processes individual articles through the LangGraph pipeline
 *   3. `notifications`  — Sends matched trade alerts to Telegram subscribers
 *
 * These types are consumed by:
 *   - `apps/api/src/queues/*.queue.ts` (queue definitions with typed `add()`)
 *   - `apps/api/src/queues/workers/*.worker.ts` (worker handlers with typed `job.data`)
 *   - `apps/api/src/services/news-fetcher/index.ts` (produces polling job results)
 *   - `apps/api/src/services/analyzer/index.ts` (produces analysis job results)
 *   - `apps/api/src/services/notifier/index.ts` (produces notification jobs)
 *
 * Design constraints (AAP Rules):
 * - No `any` type — `unknown` used for flexible fields (Rule 0.7.1)
 * - Queue names defined as string literal constants matching
 *   `apps/api/src/config/constants.ts` definitions (Rule 0.7.6)
 * - Job priorities: breaking news = priority 1 (highest) (Rule 0.7.6)
 * - All date fields use ISO 8601 `string` for JSON serialization
 * - Compiles under TypeScript strict mode with `exactOptionalPropertyTypes`
 */

import type { Market } from './news.js';
import type { Direction, Timeframe } from './trade.js';

// ---------------------------------------------------------------------------
// Queue Name Constants
// ---------------------------------------------------------------------------

/**
 * String literal type union for all queue names in the system.
 * Matches the queue name constants in `apps/api/src/config/constants.ts`.
 */
export type QueueName = 'news-polling' | 'analysis' | 'notifications';

// ---------------------------------------------------------------------------
// News Polling Job Payload
// ---------------------------------------------------------------------------

/**
 * Job payload for the `news-polling` queue.
 *
 * This queue uses a BullMQ repeatable cron job (every 5 minutes) to trigger
 * periodic news fetching from all registered data sources.
 *
 * The worker (`news-polling.worker.ts`) fetches articles from all active
 * sources, deduplicates by URL, stores new articles in the database, and
 * enqueues each new article to the `analysis` queue.
 */
export interface NewsPollingJobData {
  /**
   * Optional list of specific markets to poll.
   * When omitted or empty, all active markets are polled.
   */
  markets: Market[] | null;

  /**
   * Optional list of specific source IDs to poll.
   * When omitted or null, all active sources are polled.
   */
  sourceIds: string[] | null;

  /**
   * Whether this is a manual (ad-hoc) trigger vs. the scheduled cron.
   * Manual triggers bypass the deduplication time window.
   */
  isManual: boolean;

  /** ISO 8601 timestamp of when this polling job was created. */
  triggeredAt: string;
}

/**
 * Result summary returned by the news polling worker after processing.
 */
export interface NewsPollingJobResult {
  /** Total articles fetched from all sources (before deduplication). */
  totalFetched: number;

  /** Number of genuinely new articles stored in the database. */
  newArticles: number;

  /** Number of duplicate articles skipped (already exist by URL). */
  duplicatesSkipped: number;

  /** Number of source-level errors encountered during fetching. */
  errors: number;

  /** Per-source fetch summary for monitoring. */
  sourceSummary: Array<{
    sourceId: string;
    sourceName: string;
    fetched: number;
    stored: number;
    errored: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Analysis Job Payload
// ---------------------------------------------------------------------------

/**
 * Job payload for the `analysis` queue.
 *
 * Each job processes a single news article through the four-stage LangGraph
 * pipeline: Filter → Sentiment → Trade Detection → Recommendation.
 *
 * The worker (`analysis.worker.ts`) invokes the compiled LangGraph graph,
 * stores pipeline results in the database, and enqueues notification jobs
 * when trade opportunities are detected.
 */
export interface AnalysisJobData {
  /** UUID of the news article to analyze. */
  articleId: string;

  /** Article title — passed directly to avoid a DB read in the worker. */
  title: string;

  /** Article content/summary — passed directly for LLM consumption. */
  content: string;

  /** Market classification — used for model prompt context. */
  market: Market;

  /** Detected ticker symbols from the article. */
  symbols: string[];

  /**
   * Job priority level.
   * - `1` = breaking news (highest priority, per AAP Rule 0.7.6)
   * - `2` = normal priority
   * - `3` = low priority (backfill / re-analysis)
   */
  priority: number;
}

/**
 * Result summary returned by the analysis worker after pipeline completion.
 */
export interface AnalysisJobResult {
  /** UUID of the analyzed article. */
  articleId: string;

  /** Whether the article passed the relevance filter (stage 1). */
  isRelevant: boolean;

  /**
   * Sentiment score from stage 2, or `null` if filtered out.
   * Range: -1.000 to 1.000 (PostgreSQL `numeric(5,3)`).
   */
  sentimentScore: number | null;

  /** Whether a trade opportunity was detected (stage 3). */
  tradeDetected: boolean;

  /**
   * UUID of the created trade opportunity, or `null` if none.
   * Present only when the article progressed through all 4 stages.
   */
  opportunityId: string | null;

  /** Total LLM tokens consumed across all pipeline stages. */
  totalTokens: number;

  /** Total estimated cost in USD across all pipeline stages. */
  totalCost: number;

  /** Which pipeline stage the article reached before termination. */
  finalStage: 'filter' | 'sentiment' | 'trade-detect' | 'recommend';
}

// ---------------------------------------------------------------------------
// Notification Job Payload
// ---------------------------------------------------------------------------

/**
 * Job payload for the `notifications` queue.
 *
 * Each job sends a single trade alert to a single Telegram subscriber.
 * The notification service creates one job per matching subscriber when
 * a new trade opportunity is generated.
 */
export interface NotificationJobData {
  /** UUID of the trade opportunity triggering this notification. */
  opportunityId: string;

  /** Telegram chat ID of the recipient user. */
  telegramChatId: string;

  /** UUID of the recipient user (for logging). */
  userId: string;

  /** Ticker symbol for the alert header. */
  symbol: string;

  /** Trade direction for emoji selection (🟢 LONG / 🔴 SHORT). */
  direction: Direction;

  /** Market classification for context in the alert message. */
  market: Market;

  /** Pipeline confidence score for display in the alert. */
  confidence: number;

  /** Recommended entry price as string (numeric precision). */
  entryPrice: string;

  /** Stop loss price as string (numeric precision). */
  stopLoss: string;

  /** Take profit price as string (numeric precision). */
  takeProfit: string;

  /** Recommended timeframe for the trade. */
  timeframe: Timeframe;

  /** LLM-generated reasoning excerpt for the alert body. */
  reasoning: string;

  /**
   * Job priority level.
   * - `1` = breaking news alert (highest priority, per AAP Rule 0.7.6)
   * - `2` = normal alert
   */
  priority: number;
}

/**
 * Result returned by the notification worker after sending.
 */
export interface NotificationJobResult {
  /** UUID of the trade opportunity. */
  opportunityId: string;

  /** Telegram chat ID of the recipient. */
  telegramChatId: string;

  /** Whether the Telegram message was sent successfully. */
  delivered: boolean;

  /** Telegram message ID returned on success, or `null` on failure. */
  messageId: number | null;

  /**
   * Error message if delivery failed, or `null` on success.
   * Logged to `notification_logs` table for monitoring.
   */
  errorMessage: string | null;

  /** ISO 8601 timestamp of when the delivery attempt was made. */
  deliveredAt: string;
}
