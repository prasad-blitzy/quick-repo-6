/**
 * News Polling Worker — Trading Intelligence API
 *
 * BullMQ Worker that processes jobs from the `news-polling` queue, triggered
 * every 5 minutes via a repeatable cron job. This is the **entry point** of
 * the entire trading intelligence pipeline:
 *
 *   1. Invokes the news-fetcher orchestrator to fetch articles from ALL
 *      enabled API sources (Finnhub, RSS, Reddit, CoinGecko, CryptoCompare,
 *      Binance, Alpha Vantage, NSE India) in parallel.
 *   2. Stores articles with URL-based deduplication — duplicates from
 *      different polling cycles are silently skipped via PostgreSQL
 *      `ON CONFLICT (url) DO NOTHING` (AAP Rule 0.7.4).
 *   3. Queries for unanalyzed articles and enqueues each to the `analysis`
 *      queue for AI processing through the LangGraph pipeline.
 *
 * Critical design constraints (AAP Rules 0.7.4, 0.7.6):
 * - **Concurrency = 1**: Only one polling cycle runs at a time to prevent
 *   duplicate API calls, wasted rate-limit budget, and deduplication races.
 * - **Three separate workers**: This file defines ONLY the news-polling worker.
 *   Analysis and notification workers are separate modules.
 * - **Error isolation**: Fetch/storage failures re-throw for BullMQ retry;
 *   enqueue failures are caught and logged — articles remain in DB with
 *   `is_analyzed = false` and are picked up on the next cycle.
 * - **Exponential backoff retry**: Configured on the queue's defaultJobOptions
 *   (3 attempts, exponential starting at 5 000 ms).
 *
 * @module queues/workers/news-polling.worker
 * @see {@link https://docs.bullmq.io/guide/workers} BullMQ Worker Docs
 */

// ---------------------------------------------------------------------------
// External Dependencies
// ---------------------------------------------------------------------------

import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Internal Dependencies — Queue Infrastructure
// ---------------------------------------------------------------------------

import { connection } from "../connection.js";
import { enqueueForAnalysis } from "../analysis.queue.js";

// ---------------------------------------------------------------------------
// Internal Dependencies — Configuration
// ---------------------------------------------------------------------------

import { QUEUE_NAMES } from "../../config/constants.js";

// ---------------------------------------------------------------------------
// Internal Dependencies — Services
// ---------------------------------------------------------------------------

import { fetchAllNews, storeArticles } from "../../services/news-fetcher/index.js";

// ---------------------------------------------------------------------------
// Internal Dependencies — Database
// ---------------------------------------------------------------------------

import { db } from "../../db/index.js";
import { newsArticles } from "../../db/schema/news-articles.js";

// ---------------------------------------------------------------------------
// Internal Dependencies — Logging
// ---------------------------------------------------------------------------

import { createLogger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Dedicated to this worker
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "worker:news-polling" }` context binding.
 * All log entries from this worker include this module identifier for
 * structured filtering in log aggregation tools.
 *
 * This is a DEDICATED logger for the news-polling worker — NOT shared
 * with the analysis or notification workers.
 */
const logger = createLogger("worker:news-polling");

// ---------------------------------------------------------------------------
// Job Processor Function
// ---------------------------------------------------------------------------

/**
 * Processes a single news polling job from the `news-polling` BullMQ queue.
 *
 * The polling job has an empty payload `{}` — the worker always fetches from
 * ALL enabled sources regardless of job data. This function orchestrates
 * the three-step ingestion pipeline:
 *
 * 1. **Fetch**: Calls `fetchAllNews()` which invokes all source-specific
 *    fetcher modules in parallel via `Promise.allSettled()`. Per-source
 *    failures are handled internally by the orchestrator (logged, error_count
 *    incremented on `api_sources`).
 *
 * 2. **Store**: Calls `storeArticles(articles)` which maps articles to
 *    Drizzle insert format and uses `onConflictDoNothing({ target: url })`
 *    for URL-based deduplication. Returns the count of newly inserted
 *    articles (duplicates silently skipped).
 *
 * 3. **Enqueue**: Queries for articles with `is_analyzed = false` and
 *    enqueues each to the analysis queue via `enqueueForAnalysis()`.
 *    Per-article enqueue errors are isolated — one failure does not
 *    block other articles from being enqueued.
 *
 * Error handling strategy:
 * - **Fetch failure**: Re-throw for BullMQ exponential backoff retry.
 * - **Storage failure**: Re-throw for BullMQ retry.
 * - **Enqueue failure**: Caught and logged — articles are safe in DB with
 *   `is_analyzed = false` and will be picked up on the next polling cycle.
 *
 * @param job - BullMQ Job instance from the news-polling queue.
 * @throws Re-throws fetch and storage errors to trigger BullMQ retry.
 */
async function processPollingJob(job: Job): Promise<void> {
  const startTime = Date.now();

  logger.info(
    { jobId: job.id, jobName: job.name },
    "Starting news polling cycle",
  );

  // -------------------------------------------------------------------------
  // Step 1: Fetch articles from all enabled sources
  // -------------------------------------------------------------------------
  // fetchAllNews() invokes ALL enabled fetcher modules in parallel via
  // Promise.allSettled(). Per-source failures are caught and logged internally
  // by the orchestrator — they never propagate here. A top-level error from
  // fetchAllNews() indicates a systemic issue (e.g., memory, event loop)
  // that warrants BullMQ retry.
  let articles: Awaited<ReturnType<typeof fetchAllNews>>;
  try {
    articles = await fetchAllNews();
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown fetch error";
    logger.error(
      { error: errorMessage, jobId: job.id },
      "Failed to fetch news from sources",
    );
    throw error; // Re-throw for BullMQ retry with exponential backoff
  }

  logger.info(
    { totalFetched: articles.length, jobId: job.id },
    "Fetched articles from all sources",
  );

  // Short-circuit: No articles fetched — nothing to store or enqueue
  if (articles.length === 0) {
    logger.info(
      { jobId: job.id },
      "No new articles fetched in this polling cycle",
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Step 2: Store articles with URL-based deduplication
  // -------------------------------------------------------------------------
  // storeArticles() maps NormalizedArticle[] to Drizzle insert format and
  // uses ON CONFLICT (url) DO NOTHING. Returns the count of NEWLY inserted
  // articles — duplicates are silently skipped per AAP Rule 0.7.4.
  let insertedCount: number;
  try {
    insertedCount = await storeArticles(articles);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown storage error";
    logger.error(
      { error: errorMessage, jobId: job.id },
      "Failed to store articles in database",
    );
    throw error; // Re-throw for BullMQ retry with exponential backoff
  }

  logger.info(
    {
      totalFetched: articles.length,
      newlyInserted: insertedCount,
      duplicatesSkipped: articles.length - insertedCount,
      jobId: job.id,
    },
    "Articles stored with URL-based deduplication",
  );

  // -------------------------------------------------------------------------
  // Step 3: Enqueue newly inserted (unanalyzed) articles for analysis
  // -------------------------------------------------------------------------
  // Query for articles where is_analyzed = false and enqueue each to the
  // analysis queue. This approach is more robust than tracking insert IDs
  // because it also picks up any articles from previous cycles that may
  // have failed to enqueue.
  //
  // CRITICAL: Enqueue errors are caught and logged but NOT re-thrown.
  // Articles are safely persisted in the database with is_analyzed = false.
  // They will be picked up on the next polling cycle since the query
  // always finds all unanalyzed articles, not just the newly inserted ones.
  if (insertedCount > 0) {
    try {
      const unanalyzedArticles = await db
        .select({ id: newsArticles.id })
        .from(newsArticles)
        .where(eq(newsArticles.isAnalyzed, false))
        .limit(insertedCount + 10); // Slightly more than inserted to catch edge cases

      let enqueuedCount = 0;

      for (const article of unanalyzedArticles) {
        try {
          await enqueueForAnalysis(article.id);
          enqueuedCount++;
        } catch (enqueueError: unknown) {
          // Per-article error isolation: one failure does not block others
          const errMsg =
            enqueueError instanceof Error
              ? enqueueError.message
              : "Unknown enqueue error";
          logger.error(
            { articleId: article.id, error: errMsg, jobId: job.id },
            "Failed to enqueue article for analysis — will retry next cycle",
          );
        }
      }

      logger.info(
        {
          enqueuedCount,
          totalUnanalyzed: unanalyzedArticles.length,
          jobId: job.id,
        },
        "Articles enqueued for analysis pipeline",
      );
    } catch (error: unknown) {
      // Entire enqueue phase failed (e.g., DB query error, Redis down)
      // Articles are safe in DB — they'll be picked up next cycle
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown enqueue phase error";
      logger.error(
        { error: errorMessage, jobId: job.id },
        "Failed to query/enqueue articles for analysis — will retry next cycle",
      );
      // Intentionally NOT re-thrown: articles are persisted, analysis
      // queueing failure is non-critical and self-healing on next cycle
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Log cycle completion with timing metrics
  // -------------------------------------------------------------------------
  const duration = Date.now() - startTime;
  logger.info(
    {
      durationMs: duration,
      totalFetched: articles.length,
      newlyInserted: insertedCount,
      duplicatesSkipped: articles.length - insertedCount,
      jobId: job.id,
    },
    "News polling cycle completed",
  );
}

// ---------------------------------------------------------------------------
// Worker Instance — News Polling
// ---------------------------------------------------------------------------

/**
 * BullMQ Worker instance for the `news-polling` queue.
 *
 * Configuration:
 * - **Queue name**: `QUEUE_NAMES.NEWS_POLLING` → `"news-polling"` — matches
 *   the queue defined in `news-polling.queue.ts` with 5-minute cron.
 * - **Processor**: `processPollingJob` — orchestrates fetch → store → enqueue.
 * - **Connection**: Shared ioredis connection from `connection.ts` with
 *   `maxRetriesPerRequest: null` for BullMQ compatibility.
 * - **Concurrency**: `1` — CRITICAL. Only one polling cycle should run at a
 *   time. Multiple concurrent polls would double API calls (burning rate-limit
 *   budget), create deduplication race conditions, and provide no benefit
 *   since all sources return the same data within a 5-minute window.
 *
 * BullMQ internally creates additional Redis connections for blocking
 * operations (BRPOPLPUSH/XREADGROUP); the shared connection is used for
 * non-blocking metadata commands.
 */
export const newsPollingWorker = new Worker(
  QUEUE_NAMES.NEWS_POLLING,
  processPollingJob,
  {
    // Type assertion resolves ioredis version mismatch between project ioredis
    // and BullMQ's internal ioredis dependency under exactOptionalPropertyTypes.
    // Both versions are wire-compatible at runtime.
    connection: connection as unknown as ConnectionOptions,
    concurrency: 1,
  },
);

// ---------------------------------------------------------------------------
// Worker Event Handlers — Observability
// ---------------------------------------------------------------------------

/**
 * Fires when a news polling job completes successfully.
 * Logs the job ID and name for pipeline monitoring and alerting.
 */
newsPollingWorker.on("completed", (job: Job) => {
  logger.info(
    { jobId: job.id, jobName: job.name },
    "News polling job completed successfully",
  );
});

/**
 * Fires when a news polling job fails after exhausting all retry attempts.
 * The `job` parameter may be `undefined` if the job was removed before
 * the failure was processed (edge case in BullMQ cleanup).
 */
newsPollingWorker.on("failed", (job: Job | undefined, error: Error) => {
  logger.error(
    {
      jobId: job?.id,
      jobName: job?.name,
      error: error.message,
      stack: error.stack,
    },
    "News polling job failed",
  );
});

/**
 * Fires on worker-level errors that are NOT tied to a specific job.
 * Typically Redis connection errors, worker initialization failures,
 * or unhandled exceptions in the worker's internal event loop.
 */
newsPollingWorker.on("error", (error: Error) => {
  logger.error(
    { error: error.message, stack: error.stack },
    "News polling worker error",
  );
});
