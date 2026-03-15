/**
 * Notification Dispatch Worker — Trading Intelligence API
 *
 * BullMQ Worker that processes jobs from the `notifications` queue. When the
 * LangGraph analysis pipeline produces a trade recommendation, the analysis
 * worker enqueues a notification job. This worker then:
 *
 *  1. Receives the trade opportunity ID from the job data
 *  2. Invokes the subscriber matching engine to find users whose preference
 *     filters (market, min_confidence, timeframes) match the opportunity
 *  3. Formats a MarkdownV2-escaped Telegram alert message (once per opportunity)
 *  4. Sends the alert to each matched subscriber via the grammY Telegram bot
 *  5. Records delivery status (sent/failed) in the `notification_logs` table
 *
 * Architecture decisions:
 *  - **Sequential sending** — Messages are sent one-at-a-time within a job
 *    (for loop, NOT Promise.all) to respect Telegram's 30 msgs/sec global
 *    rate limit. With a default concurrency of 5 parallel workers, each
 *    processing subscribers sequentially, the system naturally stays under
 *    the rate limit.
 *  - **Per-subscriber error isolation** — Each send attempt is wrapped in
 *    its own try/catch. One subscriber's delivery failure does not block
 *    notifications to other subscribers in the same job.
 *  - **Duplicate prevention** — The `findMatchingSubscribers()` function
 *    filters out users who have already been notified for the same
 *    opportunity (via `notification_logs` table lookup).
 *  - **Breaking news priority** — Jobs enqueued with `isBreakingNews: true`
 *    have BullMQ priority 1 (highest), ensuring they are processed before
 *    standard priority-10 notifications.
 *
 * Critical rules enforced:
 *  - AAP Rule 0.7.6 — Three SEPARATE worker instances; this is the
 *    dedicated `notifications` worker.
 *  - AAP Rule 0.7.6 — Configurable concurrency via `NOTIFICATION_CONCURRENCY`
 *    env var (default: 5).
 *  - AAP Rule 0.7.6 — Exponential backoff retry inherited from queue's
 *    `defaultJobOptions`.
 *  - AAP Rule 0.7.5 — MarkdownV2 parse mode for all Telegram messages.
 *  - AAP Rule 0.7.5 — Subscriber preference matching (market, confidence,
 *    timeframes) before sending.
 *  - AAP Rule 0.7.1 — ESM-first (all imports use `.js` extension), strict
 *    mode, no `any` types.
 *
 * @module queues/workers/notifications.worker
 * @see {@link https://docs.bullmq.io/guide/workers} BullMQ Worker docs
 * @see {@link https://core.telegram.org/bots/api#sendmessage} Telegram API
 */

import { Worker, type Job, type ConnectionOptions } from "bullmq";

import { connection } from "../index.js";
import type { NotificationJobData } from "../notifications.queue.js";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import {
  findMatchingSubscribers,
  logNotification,
} from "../../services/notifier/index.js";
import {
  formatTradeAlert,
  type TradeAlertData,
} from "../../services/notifier/formatter.js";
import { bot } from "../../bot/index.js";
import { createLogger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Dedicated child logger for the notifications worker
// ---------------------------------------------------------------------------

/**
 * Pino child logger bound with `{ module: "worker:notifications" }` context.
 * All log entries from this worker include the module identifier for
 * structured filtering in log aggregation tools.
 *
 * This is a DEDICATED logger for the notifications worker — NOT shared
 * with other workers (each worker module creates its own child logger).
 */
const logger = createLogger("worker:notifications");

// ---------------------------------------------------------------------------
// Job Processor Function
// ---------------------------------------------------------------------------

/**
 * Processes a single notification dispatch job from the `notifications` queue.
 *
 * Processing pipeline:
 *  1. Extract `opportunityId` and `isBreakingNews` from job data
 *  2. Call `findMatchingSubscribers()` to fetch the opportunity and match
 *     subscribers whose preferences align
 *  3. Handle early returns: opportunity not found → warn; no subscribers → info
 *  4. Build `TradeAlertData` from the opportunity record
 *  5. Format the MarkdownV2 alert message ONCE (reused for all subscribers)
 *  6. Send to each subscriber sequentially via `bot.api.sendMessage()`
 *  7. Log delivery status (`sent` or `failed`) to `notification_logs` table
 *
 * Error handling strategy:
 *  - Each subscriber send is independently try/caught — one failure does not
 *    block delivery to remaining subscribers.
 *  - Failed `logNotification()` calls are caught and logged separately to
 *    prevent a logging failure from escalating into a job failure.
 *  - The function throws only on unrecoverable errors (e.g., database down
 *    during `findMatchingSubscribers()`), allowing BullMQ's retry mechanism
 *    (exponential backoff) to handle transient failures.
 *
 * @param job — BullMQ Job instance with `NotificationJobData` payload
 */
async function processNotificationJob(
  job: Job<NotificationJobData>,
): Promise<void> {
  const { opportunityId, isBreakingNews } = job.data;

  logger.info(
    { jobId: job.id, opportunityId, isBreakingNews },
    "Processing notification job",
  );

  // -------------------------------------------------------------------------
  // Guard: Skip notification delivery when Telegram bot is not configured.
  // This allows the analysis pipeline to function without Telegram.
  // -------------------------------------------------------------------------
  if (!bot) {
    logger.warn(
      { jobId: job.id, opportunityId },
      "Telegram bot not configured (TELEGRAM_BOT_TOKEN not set) — skipping notification delivery",
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Step 1: Find matching subscribers using the notifier service
  // -------------------------------------------------------------------------
  // findMatchingSubscribers:
  //  - Fetches the trade opportunity by ID from trade_opportunities table
  //  - Queries user_settings for active users matching market, min_confidence,
  //    and timeframe preferences
  //  - Filters out users already notified (via notification_logs table)
  //  - Returns MatchResult | null
  const matchResult = await findMatchingSubscribers(opportunityId);

  if (!matchResult) {
    logger.warn(
      { opportunityId },
      "Trade opportunity not found — skipping notification",
    );
    return;
  }

  if (matchResult.subscribers.length === 0) {
    logger.info(
      { opportunityId },
      "No matching subscribers for this opportunity",
    );
    return;
  }

  logger.info(
    { opportunityId, subscriberCount: matchResult.subscribers.length },
    "Found matching subscribers",
  );

  // -------------------------------------------------------------------------
  // Step 2: Build TradeAlertData from the opportunity record
  // -------------------------------------------------------------------------
  // All numeric fields are strings (PostgreSQL numeric → Drizzle ORM string)
  // to preserve financial decimal precision per AAP Rule 0.7.2.
  const alertData: TradeAlertData = {
    symbol: matchResult.opportunity.symbol,
    market: matchResult.opportunity.market,
    direction: matchResult.opportunity.direction,
    confidence: matchResult.opportunity.confidence,
    entryPrice: matchResult.opportunity.entryPrice,
    stopLoss: matchResult.opportunity.stopLoss,
    takeProfit: matchResult.opportunity.takeProfit,
    timeframe: matchResult.opportunity.timeframe,
    reasoning: matchResult.opportunity.reasoning,
    riskRewardRatio: matchResult.opportunity.riskRewardRatio,
  };

  // -------------------------------------------------------------------------
  // Step 3: Format the MarkdownV2 alert message ONCE
  // -------------------------------------------------------------------------
  // The same formatted message is sent to all matched subscribers. Formatting
  // once avoids redundant computation. The formatter handles MarkdownV2
  // character escaping, emoji direction indicators (🟢/🔴), inline code
  // blocks for prices, and reasoning truncation.
  const formattedMessage = formatTradeAlert(alertData);

  // -------------------------------------------------------------------------
  // Step 4: Send to each matched subscriber sequentially
  // -------------------------------------------------------------------------
  // Sequential sending (for loop) respects Telegram's 30 msgs/sec rate limit.
  // With default concurrency of 5 workers each sending sequentially, the
  // aggregate throughput stays well under the limit.
  let sentCount = 0;
  let failedCount = 0;

  for (const subscriber of matchResult.subscribers) {
    try {
      // Send via grammY bot with MarkdownV2 parse mode (AAP Rule 0.7.5)
      const sentMessage = await bot.api.sendMessage(
        subscriber.telegramChatId,
        formattedMessage,
        { parse_mode: "MarkdownV2" },
      );

      // Log successful delivery to notification_logs table
      await logNotification(
        opportunityId,
        subscriber.userId,
        "sent",
        sentMessage.message_id,
      );

      sentCount++;

      logger.debug(
        {
          opportunityId,
          chatId: subscriber.telegramChatId,
          messageId: sentMessage.message_id,
        },
        "Trade alert sent successfully",
      );
    } catch (error: unknown) {
      failedCount++;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown send error";

      // Log failed delivery to notification_logs table.
      // The logNotification call itself is wrapped in .catch() to prevent
      // a logging failure from escalating into a job-level failure.
      await logNotification(
        opportunityId,
        subscriber.userId,
        "failed",
        undefined,
        errorMessage,
      ).catch((logErr: unknown) => {
        logger.error({ logErr }, "Failed to log notification failure");
      });

      logger.error(
        {
          opportunityId,
          chatId: subscriber.telegramChatId,
          error: errorMessage,
        },
        "Failed to send trade alert",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Log job completion metrics
  // -------------------------------------------------------------------------
  logger.info(
    {
      opportunityId,
      sentCount,
      failedCount,
      totalSubscribers: matchResult.subscribers.length,
    },
    "Notification job completed",
  );
}

// ---------------------------------------------------------------------------
// Worker Instance — Processes jobs from the "notifications" queue
// ---------------------------------------------------------------------------

/**
 * BullMQ Worker instance for the `notifications` queue.
 *
 * Configuration:
 *  - **Queue name**: `QUEUE_NAMES.NOTIFICATIONS` → `"notifications"`
 *  - **Processor**: `processNotificationJob` — async function defined above
 *  - **Connection**: Shared ioredis connection from `../index.js`, cast to
 *    `ConnectionOptions` to resolve ioredis version mismatch between the
 *    project dependency and BullMQ's internal ioredis types. Both versions
 *    are wire-compatible at runtime.
 *  - **Concurrency**: `env.NOTIFICATION_CONCURRENCY` (default: 5) — controls
 *    how many notification jobs are processed in parallel (AAP Rule 0.7.6).
 *
 * The Worker automatically creates internal Redis connections for blocking
 * operations (`BRPOPLPUSH`). The shared connection is used for non-blocking
 * commands (status checks, job data retrieval).
 *
 * Exported for:
 *  - `apps/api/src/index.ts` — Graceful shutdown via `notificationsWorker.close()`
 *  - Bull Board — Worker status monitoring
 */
export const notificationsWorker = new Worker<NotificationJobData>(
  QUEUE_NAMES.NOTIFICATIONS,
  processNotificationJob,
  {
    // Type assertion resolves ioredis version mismatch between project ioredis
    // and BullMQ's internal ioredis dependency under exactOptionalPropertyTypes.
    // Both versions are wire-compatible at runtime.
    connection: connection as unknown as ConnectionOptions,
    concurrency: env.NOTIFICATION_CONCURRENCY ?? 5,
  },
);

// ---------------------------------------------------------------------------
// Worker Event Handlers — Observability
// ---------------------------------------------------------------------------

/**
 * Logs successful job completion with job ID and opportunity ID.
 * Fires after `processNotificationJob()` resolves without throwing.
 */
notificationsWorker.on(
  "completed",
  (job: Job<NotificationJobData>) => {
    logger.info(
      { jobId: job.id, opportunityId: job.data.opportunityId },
      "Notification job completed successfully",
    );
  },
);

/**
 * Logs job failure with job ID, opportunity ID, and error details.
 * Fires when `processNotificationJob()` throws or rejects.
 *
 * The `job` parameter may be `undefined` if the failure occurred before
 * the job could be retrieved from Redis (e.g., deserialization error).
 * The `prev` parameter is the previous job state string (unused here).
 */
notificationsWorker.on(
  "failed",
  (job: Job<NotificationJobData> | undefined, error: Error) => {
    logger.error(
      {
        jobId: job?.id,
        opportunityId: job?.data?.opportunityId,
        error: error.message,
      },
      "Notification job failed",
    );
  },
);

/**
 * Logs worker-level errors (Redis connection failures, internal BullMQ
 * errors, etc.). These are NOT job-specific — they affect the entire
 * worker's ability to process jobs.
 */
notificationsWorker.on("error", (error: Error) => {
  logger.error(
    { error: error.message },
    "Notifications worker error",
  );
});
