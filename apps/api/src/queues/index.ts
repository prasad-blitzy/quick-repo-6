/**
 * Queue Registry and Barrel Export — Trading Intelligence API
 *
 * This is the FOUNDATIONAL queue infrastructure barrel module that ties all
 * three independent BullMQ queues into a unified lifecycle:
 *
 * 1. **`news-polling`** — Repeatable 5-minute cron job for multi-source news
 *    ingestion from Finnhub, RSS feeds, CoinGecko, CryptoCompare, Binance,
 *    Alpha Vantage, NSE India, and Reddit.
 * 2. **`analysis`** — Four-stage LangGraph AI pipeline processing
 *    (Filter → Sentiment → Trade Detection → Recommendation) with priority
 *    support for breaking news articles.
 * 3. **`notifications`** — Telegram trade alert dispatch to subscribers
 *    matching market, confidence, and timeframe preferences.
 *
 * Responsibilities:
 * - Provides `initQueues()` — Initializes all 3 queues, sets up the news
 *   polling cron job, and returns a `Queue[]` array for Bull Board adapter
 *   registration at `/admin/queues`.
 * - Provides `closeQueues()` — Gracefully shuts down all queues and the
 *   shared Redis connection during SIGTERM/SIGINT handling.
 * - Re-exports the shared Redis connection from `./connection.ts` (extracted
 *   to a separate module to break circular dependencies between queue files
 *   and this barrel).
 * - Re-exports all queue instances, enqueue helper functions, and job data
 *   types for convenient single-import access by consumers.
 *
 * Architecture:
 * - Each queue is defined in its own module (AAP Rule 0.7.6 — three SEPARATE
 *   queues with independent worker instances).
 * - The shared ioredis connection is created in `./connection.ts` with
 *   `maxRetriesPerRequest: null` as required by BullMQ for blocking commands.
 * - This module only orchestrates lifecycle and provides barrel re-exports.
 *
 * @module queues/index
 * @see {@link https://docs.bullmq.io/guide/queues} BullMQ Queue Documentation
 * @see {@link https://docs.bullmq.io/guide/connections} BullMQ Connection Docs
 */

import type { Queue } from "bullmq";

import { createLogger } from "../lib/logger.js";
import { connection } from "./connection.js";
import {
  newsPollingQueue,
  setupNewsPollingCron,
} from "./news-polling.queue.js";
import { analysisQueue } from "./analysis.queue.js";
import { notificationsQueue } from "./notifications.queue.js";

// ---------------------------------------------------------------------------
// Logger — Queue registry observability
// ---------------------------------------------------------------------------

/**
 * Child logger scoped to the queue registry module.
 * All log entries include `{ module: "queues" }` for structured filtering
 * in log aggregation tools (ELK, Datadog, CloudWatch).
 */
const logger = createLogger("queues");

// ---------------------------------------------------------------------------
// Queue Initialization — Called from apps/api/src/index.ts bootstrap
// ---------------------------------------------------------------------------

/**
 * Initializes all three BullMQ queues and registers the news polling cron job.
 *
 * This function is called once during Express server bootstrap in
 * `apps/api/src/index.ts`. It returns an array of all Queue instances for
 * Bull Board adapter registration, enabling the queue monitoring dashboard
 * at `/admin/queues`.
 *
 * The queues themselves are already instantiated at module import time (they
 * are created in their respective modules when first imported). This function
 * primarily handles:
 * 1. Registering the repeatable news polling cron job via `setupNewsPollingCron()`
 * 2. Logging initialization status for operational observability
 * 3. Returning the Queue[] array for Bull Board
 *
 * The cron setup is intentionally fire-and-forget: `setupNewsPollingCron()`
 * returns a Promise that is caught independently so that a Redis failure
 * during cron registration does not block server startup. The cron will be
 * retried on the next server restart.
 *
 * @returns Array of all 3 BullMQ Queue instances for Bull Board adapter
 *          registration via `BullMQAdapter`.
 *
 * @example
 * ```typescript
 * import { initQueues } from "./queues/index.js";
 * import { createBullBoard } from "@bull-board/api";
 * import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
 *
 * const queues = initQueues();
 * createBullBoard({
 *   queues: queues.map((q) => new BullMQAdapter(q)),
 *   // ...
 * });
 * ```
 */
export function initQueues(): Queue[] {
  logger.info("Initializing BullMQ queues...");

  // Register the repeatable 5-minute cron job for news polling.
  // This is async but handled as fire-and-forget: errors are caught and
  // logged without blocking synchronous queue initialization. The cron
  // setup is idempotent — it removes stale schedules before re-registering.
  setupNewsPollingCron().catch((error: unknown) => {
    logger.error({ error }, "Failed to setup news polling cron job");
  });

  logger.info(
    "All 3 queues initialized: news-polling, analysis, notifications",
  );

  // Return array of Queue instances for Bull Board BullMQAdapter registration.
  // BullMQ Queue<T, R, N> instances are assignable to Queue (default generics).
  return [newsPollingQueue, analysisQueue, notificationsQueue];
}

// ---------------------------------------------------------------------------
// Graceful Shutdown — Called from apps/api/src/index.ts SIGTERM/SIGINT handler
// ---------------------------------------------------------------------------

/**
 * Gracefully shuts down all BullMQ queues and the shared Redis connection.
 *
 * Shutdown sequence:
 * 1. Close all 3 queues in parallel via `Promise.all()` — this drains
 *    pending commands and prevents new jobs from being enqueued.
 * 2. Close the shared ioredis connection via `connection.quit()` — this
 *    sends a QUIT command to Redis and waits for acknowledgment.
 * 3. On error, falls back to `connection.disconnect()` which forcibly
 *    terminates the TCP socket without waiting for pending responses.
 *
 * This function is designed to be called from the process signal handler
 * in `apps/api/src/index.ts` during SIGTERM (container shutdown) or
 * SIGINT (Ctrl+C in development).
 *
 * @example
 * ```typescript
 * import { closeQueues } from "./queues/index.js";
 *
 * process.on("SIGTERM", async () => {
 *   await closeQueues();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeQueues(): Promise<void> {
  logger.info("Closing BullMQ queues and Redis connection...");

  try {
    // Step 1: Close all 3 queues in parallel.
    // Queue.close() prevents the queue from accepting new jobs and waits
    // for any pending Redis commands to complete.
    await Promise.all([
      newsPollingQueue.close(),
      analysisQueue.close(),
      notificationsQueue.close(),
    ]);
    logger.info("All queues closed");

    // Step 2: Gracefully close the Redis connection.
    // connection.quit() sends the Redis QUIT command, waits for the server
    // acknowledgment, then cleanly disconnects. This is the preferred
    // shutdown method.
    await connection.quit();
    logger.info("Redis connection closed gracefully");
  } catch (error: unknown) {
    logger.error({ error }, "Error during queue shutdown");

    // Fallback: Force disconnect the Redis connection if quit() fails.
    // disconnect() immediately destroys the TCP socket without waiting
    // for pending commands. This prevents the process from hanging during
    // shutdown if Redis is unresponsive.
    connection.disconnect();
    logger.warn("Redis connection force-disconnected after shutdown error");
  }
}

// ---------------------------------------------------------------------------
// Re-exports — Convenience barrel for consumers
// ---------------------------------------------------------------------------
// These re-exports allow consumers to import everything they need from
// `"./queues/index.js"` without knowing the internal module structure.
// Values are re-exported for runtime use; types use `export type` per
// TypeScript's verbatimModuleSyntax requirement.

/**
 * Shared ioredis Redis connection instance configured for BullMQ.
 * @see {@link ./connection.ts} for connection configuration details.
 */
export { connection };

/**
 * News polling BullMQ Queue instance.
 * @see {@link ./news-polling.queue.ts} for queue configuration.
 */
export { newsPollingQueue };

/**
 * Analysis BullMQ Queue instance.
 * @see {@link ./analysis.queue.ts} for queue configuration.
 */
export { analysisQueue };

/**
 * Helper function to enqueue a news article for AI analysis pipeline processing.
 */
export { enqueueForAnalysis } from "./analysis.queue.js";

/**
 * TypeScript interface for analysis queue job payloads.
 * Contains `articleId` (UUID) and optional `isBreakingNews` flag.
 */
export type { AnalysisJobData } from "./analysis.queue.js";

/**
 * Notifications BullMQ Queue instance.
 * @see {@link ./notifications.queue.ts} for queue configuration.
 */
export { notificationsQueue };

/**
 * Helper function to enqueue a trade alert notification for Telegram dispatch.
 */
export { enqueueNotification } from "./notifications.queue.js";

/**
 * TypeScript interface for notification queue job payloads.
 * Contains `opportunityId` (UUID) and optional `isBreakingNews` flag.
 */
export type { NotificationJobData } from "./notifications.queue.js";
