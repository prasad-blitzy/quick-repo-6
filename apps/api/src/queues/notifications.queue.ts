/**
 * Notification Dispatch Queue Definition — Trading Intelligence API
 *
 * Defines the BullMQ `notifications` queue for dispatching trade alert
 * notifications to Telegram subscribers. When the analysis pipeline produces
 * a trade recommendation, a notification job is enqueued here. The
 * notification worker then matches the opportunity against user preferences
 * and sends MarkdownV2-formatted alerts via the grammY Telegram bot.
 *
 * Key configuration (AAP Rule 0.7.6):
 * - **Priority support** — Breaking news alerts get priority 1 (highest);
 *   normal notifications get priority 10. BullMQ processes lower-priority-
 *   number jobs first, ensuring breaking news reaches subscribers immediately.
 * - **5 retry attempts** — Higher than the default 3 used by other queues,
 *   because notification delivery is critical and transient Telegram API
 *   failures (429 rate limits, network blips) should be retried aggressively.
 * - **Exponential backoff** — Retries at 5 s, 10 s, 20 s, 40 s, 80 s to
 *   give the Telegram API rate limits time to reset between attempts.
 * - **Audit trail** — Keeps 1 000 completed and 500 failed jobs for
 *   notification delivery auditing via Bull Board.
 *
 * Rate limiting note: Telegram Bot API allows 30 messages/second. Rate
 * limiting is enforced at the WORKER level (via Bottleneck or BullMQ
 * concurrency), not here. This module only defines the queue and its
 * default job options.
 *
 * @module queues/notifications.queue
 * @see {@link https://docs.bullmq.io/} BullMQ documentation
 */

import { Queue } from "bullmq";
import { connection } from "./connection.js";
import { QUEUE_NAMES, DEFAULTS } from "../config/constants.js";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Scoped child logger for notification queue events
// ---------------------------------------------------------------------------

/**
 * Child logger with `{ module: "queue:notifications" }` context binding.
 * Used for structured logging of queue initialization and enqueue events.
 */
const logger = createLogger("queue:notifications");

// ---------------------------------------------------------------------------
// Notification Job Data Interface
// ---------------------------------------------------------------------------

/**
 * Payload structure for notification dispatch jobs.
 *
 * The notification worker receives this data, fetches the full trade
 * opportunity from the database, matches it against subscriber preferences
 * (market, minimum confidence, timeframes), and dispatches MarkdownV2-
 * formatted Telegram alerts to each matching user.
 *
 * @property opportunityId — UUID of the trade opportunity to notify about.
 * @property isBreakingNews — When `true`, the job is enqueued with
 *   `BREAKING_NEWS_PRIORITY` (1) instead of `NORMAL_PRIORITY` (10),
 *   ensuring it is processed ahead of regular notifications.
 */
export interface NotificationJobData {
  /** UUID of the trade opportunity that triggered this notification. */
  opportunityId: string;
  /** Whether this notification is for breaking news (priority 1). */
  isBreakingNews?: boolean;
}

// ---------------------------------------------------------------------------
// BullMQ Queue Instance
// ---------------------------------------------------------------------------

/**
 * BullMQ queue instance for trade alert notification dispatch.
 *
 * Configuration rationale:
 * - `attempts: 5` — Notification delivery is critical; more retries than
 *   the standard 3 to handle transient Telegram API failures (HTTP 429,
 *   network timeouts, temporary outages).
 * - `backoff.type: "exponential"` with `delay: 5000` — Exponential retry
 *   schedule: 5 s → 10 s → 20 s → 40 s → 80 s. Gives Telegram rate limits
 *   time to reset between attempts.
 * - `removeOnComplete.count: 1000` — Retain completed jobs for notification
 *   delivery auditing via Bull Board dashboard.
 * - `removeOnFail.count: 500` — Retain failed jobs for debugging delivery
 *   issues (e.g., invalid chat IDs, bot blocked by user).
 * - `priority: DEFAULTS.NORMAL_PRIORITY` (10) — Default priority for
 *   standard notifications. Breaking news jobs override this to 1.
 */
export const notificationsQueue = new Queue<NotificationJobData>(
  QUEUE_NAMES.NOTIFICATIONS,
  {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: DEFAULTS.RETRY_BACKOFF_DELAY,
      },
      removeOnComplete: {
        count: 1000,
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
 * Enqueues a trade alert notification for dispatch to Telegram subscribers.
 *
 * This function is called by the analysis worker when the LangGraph pipeline
 * produces a trade recommendation. The notification worker will:
 * 1. Fetch the trade opportunity from the database by `opportunityId`.
 * 2. Query all users whose preference filters (market, min_confidence,
 *    timeframes) match the opportunity attributes.
 * 3. Format a MarkdownV2 trade alert message with emoji indicators
 *    (🟢 LONG / 🔴 SHORT).
 * 4. Send the formatted message to each matching subscriber via the
 *    grammY Telegram bot `bot.api.sendMessage()`.
 *
 * @param opportunityId — UUID of the trade opportunity to notify about.
 * @param isBreakingNews — When `true`, the job receives priority 1
 *   (highest), bypassing the normal priority-10 queue ordering.
 *   Defaults to `false`.
 */
export async function enqueueNotification(
  opportunityId: string,
  isBreakingNews = false,
): Promise<void> {
  const jobData: NotificationJobData = { opportunityId, isBreakingNews };

  const priority = isBreakingNews
    ? DEFAULTS.BREAKING_NEWS_PRIORITY
    : DEFAULTS.NORMAL_PRIORITY;

  await notificationsQueue.add("send-trade-alert", jobData, { priority });

  logger.debug(
    { opportunityId, isBreakingNews, priority },
    "Trade alert notification enqueued",
  );
}
