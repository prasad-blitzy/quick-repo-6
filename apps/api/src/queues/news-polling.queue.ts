/**
 * News Polling Queue Definition — Trading Intelligence API
 *
 * Defines the BullMQ `news-polling` queue with a repeatable cron job that
 * triggers every 5 minutes (configurable via `NEWS_POLL_INTERVAL` env var).
 * This queue is responsible for scheduling automated news fetching cycles
 * from all configured data sources (Finnhub, RSS feeds, CoinGecko,
 * CryptoCompare, Binance, Alpha Vantage, NSE India, Reddit).
 *
 * Architecture:
 * - This file defines ONLY the `news-polling` queue (AAP Rule 0.7.6).
 * - The `analysis` and `notifications` queues are defined in separate modules.
 * - The companion worker (`workers/news-polling.worker.ts`) processes jobs
 *   from this queue by invoking the news fetcher orchestrator.
 *
 * Queue Configuration:
 * - **Name**: `"news-polling"` (from `QUEUE_NAMES.NEWS_POLLING`)
 * - **Retry**: 3 attempts with exponential backoff (5s → 10s → 20s)
 * - **Cleanup**: Retains last 100 completed + 200 failed jobs for Bull Board
 * - **Cron**: Repeatable job at `NEWS_POLL_INTERVAL` (default every 5 min)
 *
 * @module queues/news-polling.queue
 * @see {@link https://docs.bullmq.io/guide/queues} BullMQ Queue Documentation
 * @see {@link https://docs.bullmq.io/guide/jobs/repeatable} Repeatable Jobs
 */

import { Queue, type ConnectionOptions } from "bullmq";

import { connection } from "./connection.js";
import { QUEUE_NAMES, DEFAULTS } from "../config/constants.js";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Queue observability
// ---------------------------------------------------------------------------

/**
 * Child logger scoped to the news-polling queue module.
 * All log entries include `{ module: "queue:news-polling" }` for structured
 * filtering in log aggregation tools.
 */
const logger = createLogger("queue:news-polling");

// ---------------------------------------------------------------------------
// Queue Instance — News Polling
// ---------------------------------------------------------------------------

/**
 * BullMQ Queue instance for scheduling and managing news polling jobs.
 *
 * This queue is the entry point of the entire data ingestion pipeline:
 *   news-polling → analysis → notifications
 *
 * Default job options ensure resilience against transient failures
 * (network errors, API rate limits) via exponential backoff retry.
 * Job cleanup policies retain enough history for Bull Board monitoring
 * while preventing unbounded Redis memory growth.
 *
 * Configuration:
 * - `attempts`: 3 (from `DEFAULTS.MAX_RETRY_ATTEMPTS`)
 * - `backoff.type`: `"exponential"` — delays double each retry (5s, 10s, 20s)
 * - `backoff.delay`: 5000ms initial (from `DEFAULTS.RETRY_BACKOFF_DELAY`)
 * - `removeOnComplete.count`: 100 — keep last 100 successful jobs
 * - `removeOnFail.count`: 200 — keep last 200 failed jobs for debugging
 */
export const newsPollingQueue = new Queue(QUEUE_NAMES.NEWS_POLLING, {
  // The shared ioredis connection instance is cast to BullMQ's ConnectionOptions
  // to bridge a potential ioredis minor version mismatch between the direct
  // dependency and BullMQ's pinned peer. Both are functionally identical
  // ioredis v5 Redis instances; exactOptionalPropertyTypes causes structural
  // type incompatibility between different ioredis type declaration copies.
  connection: connection as ConnectionOptions,
  defaultJobOptions: {
    attempts: DEFAULTS.MAX_RETRY_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: DEFAULTS.RETRY_BACKOFF_DELAY,
    },
    removeOnComplete: {
      count: 100,
    },
    removeOnFail: {
      count: 200,
    },
  },
});

// ---------------------------------------------------------------------------
// Repeatable Cron Job Registration
// ---------------------------------------------------------------------------

/**
 * Registers the repeatable cron job for automated news polling.
 *
 * This function is designed to be **idempotent** — it first removes all
 * existing repeatable jobs on this queue before adding the new cron schedule.
 * This ensures safe behavior across server restarts: the cron interval is
 * always re-registered with the current `NEWS_POLL_INTERVAL` configuration,
 * and stale schedules from previous configurations are cleaned up.
 *
 * The repeatable job uses BullMQ's built-in cron scheduling via
 * `repeat.pattern`, which leverages Redis to ensure that only ONE instance
 * of the cron job runs at a time, even when multiple API server instances
 * are running behind a load balancer (cluster-safe).
 *
 * Job Details:
 * - **Name**: `"poll-all-sources"` — displayed in Bull Board dashboard
 * - **Payload**: Empty object `{}` — the worker independently fetches from
 *   all enabled API sources registered in the `api_sources` table
 * - **Pattern**: `env.NEWS_POLL_INTERVAL` (default: every 5 minutes cron)
 *
 * @throws If Redis connection is unavailable or queue operations fail.
 *         BullMQ will throw an ioredis connection error.
 *
 * @example
 * ```typescript
 * import { setupNewsPollingCron } from "./news-polling.queue.js";
 *
 * // During server bootstrap (called by initQueues()):
 * await setupNewsPollingCron();
 * // Logs: { module: "queue:news-polling", cronPattern: "... * * * *" }
 * //        "News polling cron job registered"
 * ```
 */
export async function setupNewsPollingCron(): Promise<void> {
  // Step 1: Remove any existing repeatable jobs to ensure idempotent registration.
  // This prevents duplicate cron schedules after server restarts or config changes.
  const existingJobs = await newsPollingQueue.getRepeatableJobs();

  for (const job of existingJobs) {
    await newsPollingQueue.removeRepeatableByKey(job.key);
  }

  // Step 2: Register the new repeatable cron job with the current configuration.
  // BullMQ stores the repeat metadata in Redis, so the job is automatically
  // re-enqueued at each cron tick without any server-side scheduling code.
  await newsPollingQueue.add(
    "poll-all-sources",
    {},
    {
      repeat: {
        pattern: env.NEWS_POLL_INTERVAL,
      },
    },
  );

  logger.info(
    { cronPattern: env.NEWS_POLL_INTERVAL },
    "News polling cron job registered",
  );
}
