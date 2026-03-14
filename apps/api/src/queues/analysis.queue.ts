/**
 * Analysis Processing Queue Definition — Trading Intelligence API
 *
 * Defines the BullMQ `analysis` queue for processing news articles through
 * the four-stage LangGraph AI analysis pipeline:
 *   Filter → Sentiment → Trade Detection → Recommendation
 *
 * This queue receives article IDs from the news-polling worker and dispatches
 * them for AI processing with configurable concurrency. Only ~25% of articles
 * survive the filtering stage and reach the expensive recommendation model,
 * achieving ~75% LLM cost reduction through the tiered pipeline architecture.
 *
 * Key configuration (AAP Rule 0.7.6):
 * - **Priority support** — Breaking news articles get priority 1 (highest);
 *   normal articles get priority 10. BullMQ processes lower-priority-number
 *   jobs first, ensuring breaking news is analyzed before routine articles.
 * - **3 retry attempts** — Exponential backoff starting at 5 000 ms to handle
 *   transient OpenRouter API failures (HTTP 429 rate limits, network blips,
 *   temporary model overloads).
 * - **Pipeline analytics** — Keeps 500 completed and 500 failed jobs for
 *   LangGraph pipeline performance monitoring and LLM failure debugging
 *   via Bull Board dashboard.
 *
 * Concurrency note: Worker concurrency is configured at the WORKER level
 * (via `ANALYSIS_CONCURRENCY` env var, default 3) to respect OpenRouter
 * rate limits. This module only defines the queue and its default job options.
 *
 * @module queues/analysis.queue
 * @see {@link https://docs.bullmq.io/} BullMQ documentation
 */

import { Queue, type ConnectionOptions } from "bullmq";
import { connection } from "./connection.js";
import { QUEUE_NAMES, DEFAULTS } from "../config/constants.js";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Scoped child logger for analysis queue events
// ---------------------------------------------------------------------------

/**
 * Child logger with `{ module: "queue:analysis" }` context binding.
 * Used for structured logging of queue initialization and enqueue events.
 */
const logger = createLogger("queue:analysis");

// ---------------------------------------------------------------------------
// Analysis Job Data Interface
// ---------------------------------------------------------------------------

/**
 * Payload structure for AI analysis pipeline jobs.
 *
 * The analysis worker receives this data, fetches the full article from the
 * database, and runs it through the four-stage LangGraph pipeline:
 * 1. **Filter** (DeepSeek V3.2) — Binary relevance classification.
 * 2. **Sentiment** (Claude Haiku 4.5) — Nuanced sentiment analysis with
 *    negative news 2–3x weighting.
 * 3. **Trade Detection** (Claude Haiku 4.5) — Identifies actionable
 *    trade opportunities from the article.
 * 4. **Recommendation** (Claude Sonnet 4.6) — Generates structured trade
 *    recommendations with entry, stop-loss, and take-profit targets.
 *
 * @property articleId — UUID of the news article to analyze.
 * @property isBreakingNews — When `true`, the job is enqueued with
 *   `BREAKING_NEWS_PRIORITY` (1) instead of `NORMAL_PRIORITY` (10),
 *   ensuring it is analyzed ahead of routine articles.
 */
export interface AnalysisJobData {
  /** UUID of the news article to process through the analysis pipeline. */
  articleId: string;
  /** Whether this article is breaking news (priority 1). */
  isBreakingNews?: boolean;
}

// ---------------------------------------------------------------------------
// BullMQ Queue Instance
// ---------------------------------------------------------------------------

/**
 * BullMQ queue instance for AI analysis pipeline processing.
 *
 * Configuration rationale:
 * - `attempts: DEFAULTS.MAX_RETRY_ATTEMPTS` (3) — Standard retry count
 *   for LLM API calls. OpenRouter transient failures (rate limits, model
 *   overloads) typically resolve within 3 retry cycles.
 * - `backoff.type: "exponential"` with `delay: DEFAULTS.RETRY_BACKOFF_DELAY`
 *   (5000) — Exponential retry schedule: 5 s → 10 s → 20 s. Gives
 *   OpenRouter rate limits time to reset between attempts.
 * - `removeOnComplete.count: 500` — Retain completed jobs for pipeline
 *   analytics (success rate, duration, token usage) via Bull Board dashboard.
 * - `removeOnFail.count: 500` — Retain failed jobs for debugging LLM
 *   failures (hallucinations, parsing errors, model downtime).
 * - `priority: DEFAULTS.NORMAL_PRIORITY` (10) — Default priority for
 *   standard articles. Breaking news jobs override this to 1.
 */
export const analysisQueue = new Queue<AnalysisJobData, unknown, string>(
  QUEUE_NAMES.ANALYSIS,
  {
    // Type assertion resolves ioredis version mismatch between project ioredis
    // and BullMQ's internal ioredis dependency under exactOptionalPropertyTypes.
    // Both versions are wire-compatible at runtime.
    connection: connection as unknown as ConnectionOptions,
    defaultJobOptions: {
      attempts: DEFAULTS.MAX_RETRY_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: DEFAULTS.RETRY_BACKOFF_DELAY,
      },
      removeOnComplete: {
        count: 500,
      },
      removeOnFail: {
        count: 500,
      },
      priority: DEFAULTS.NORMAL_PRIORITY,
    },
  },
);

// ---------------------------------------------------------------------------
// Enqueue Helper Function
// ---------------------------------------------------------------------------

/**
 * Enqueues a news article for AI analysis through the LangGraph pipeline.
 *
 * This function is called by the news-polling worker after deduplicating and
 * storing new articles in the database. Each enqueued article will go through
 * the four-stage pipeline with conditional short-circuiting — articles that
 * fail the filter stage (~75%) are discarded before reaching the expensive
 * recommendation model.
 *
 * Breaking news articles receive priority 1 (highest), bypassing the normal
 * priority-10 queue ordering to ensure time-sensitive market-moving events
 * are analyzed first.
 *
 * @param articleId — UUID of the news article to analyze.
 * @param isBreakingNews — When `true`, the job receives priority 1
 *   (highest), bypassing the normal priority-10 queue ordering.
 *   Defaults to `false`.
 */
export async function enqueueForAnalysis(
  articleId: string,
  isBreakingNews = false,
): Promise<void> {
  const jobData: AnalysisJobData = { articleId, isBreakingNews };

  const priority = isBreakingNews
    ? DEFAULTS.BREAKING_NEWS_PRIORITY
    : DEFAULTS.NORMAL_PRIORITY;

  await analysisQueue.add("analyze-article", jobData, { priority });

  logger.debug(
    { articleId, isBreakingNews, priority },
    "Article enqueued for analysis",
  );
}
