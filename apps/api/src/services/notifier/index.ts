/**
 * Subscriber Matching Engine — Notification Service
 *
 * This module implements the subscriber matching engine for the Trading
 * Intelligence notification pipeline. It serves as the bridge between
 * AI-generated trade opportunities and Telegram alert delivery.
 *
 * Core responsibilities:
 *  1. Fetch a trade opportunity record by ID from the database
 *  2. Query active users whose preference filters (market, min_confidence,
 *     timeframes) match the opportunity's attributes (AAP Rule 0.7.5)
 *  3. Filter out users who have already been notified for this opportunity
 *     (duplicate prevention per AAP Section 0.4.3)
 *  4. Return the matched subscriber list along with full opportunity data
 *  5. Provide a helper to log notification delivery status
 *
 * Matching logic uses PostgreSQL's `@>` array containment operator for
 * market and timeframe preference checks, and numeric `<=` comparison
 * for the confidence threshold gate.
 *
 * Consumers:
 *  - `apps/api/src/queues/workers/notifications.worker.ts`
 *    → Calls `findMatchingSubscribers(opportunityId)` to get matched users
 *    → For each match, calls formatter and sends via grammY bot
 *    → Calls `logNotification()` to record delivery status
 *
 * @module services/notifier
 */

import { eq, and, sql } from "drizzle-orm";

import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/user-settings.js";
import { tradeOpportunities } from "../../db/schema/trade-opportunities.js";
import { notificationLogs } from "../../db/schema/notification-logs.js";
import { createLogger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Child logger scoped to the notifier module.
 * All log entries include `{ module: "notifier" }` for structured filtering.
 */
const logger = createLogger("notifier");

// ---------------------------------------------------------------------------
// Exported Interfaces
// ---------------------------------------------------------------------------

/**
 * Represents a single subscriber matched for notification delivery.
 *
 * Contains the minimum information needed by the notification worker
 * to send a Telegram message: the database user ID (for logging),
 * the Telegram chat ID (for message delivery), and the optional
 * username (for display in logs and admin dashboards).
 */
export interface MatchedSubscriber {
  /** UUID primary key from the `user_settings` table */
  userId: string;
  /** Telegram chat ID for sending the alert message via `bot.api.sendMessage()` */
  telegramChatId: string;
  /** Telegram username — may be null if the user has not set one */
  username: string | null;
}

/**
 * Complete result of the subscriber matching operation.
 *
 * Contains the full trade opportunity data (for message formatting)
 * and the filtered list of subscribers who should receive the alert.
 * The `subscribers` array excludes users who have already been notified
 * for this specific opportunity (duplicate prevention).
 */
export interface MatchResult {
  /** Trade opportunity details extracted from the database record */
  opportunity: {
    id: string;
    symbol: string;
    market: string;
    direction: string;
    confidence: string;
    entryPrice: string;
    stopLoss: string;
    takeProfit: string;
    timeframe: string;
    reasoning: string;
    riskRewardRatio: string | null;
  };
  /** Users whose preferences match and who have NOT been notified yet */
  subscribers: MatchedSubscriber[];
}

// ---------------------------------------------------------------------------
// findMatchingSubscribers — Primary Matching Function
// ---------------------------------------------------------------------------

/**
 * Finds all active subscribers whose notification preferences match the
 * given trade opportunity's attributes, excluding users who have already
 * been notified for this opportunity.
 *
 * Matching criteria (all must be satisfied — AAP Rule 0.7.5):
 *  - `user_settings.is_active = true`
 *  - `user_settings.markets @> ARRAY[opportunity.market]` (array containment)
 *  - `user_settings.timeframes @> ARRAY[opportunity.timeframe]` (array containment)
 *  - `user_settings.min_confidence <= opportunity.confidence` (threshold gate)
 *
 * The function also queries `notification_logs` to identify users who have
 * already been notified for this opportunity (duplicate prevention per
 * AAP Section 0.4.3) and removes them from the result set.
 *
 * @param opportunityId — UUID of the trade opportunity to match against
 * @returns A `MatchResult` containing opportunity data and matched subscribers,
 *          or `null` if the opportunity ID is not found in the database
 *
 * @example
 * ```typescript
 * const result = await findMatchingSubscribers("550e8400-e29b-41d4-a716-446655440000");
 * if (result) {
 *   for (const sub of result.subscribers) {
 *     await bot.api.sendMessage(sub.telegramChatId, formattedAlert, { parse_mode: "MarkdownV2" });
 *     await logNotification(result.opportunity.id, sub.userId, "sent", messageId);
 *   }
 * }
 * ```
 */
export async function findMatchingSubscribers(
  opportunityId: string,
): Promise<MatchResult | null> {
  // -------------------------------------------------------------------------
  // Step 1: Fetch the trade opportunity by ID
  // -------------------------------------------------------------------------
  const opportunityRows = await db
    .select()
    .from(tradeOpportunities)
    .where(eq(tradeOpportunities.id, opportunityId))
    .limit(1);

  const opportunity = opportunityRows[0];

  if (!opportunity) {
    logger.warn(
      { opportunityId },
      "Trade opportunity not found — cannot match subscribers",
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 2: Query active users whose preferences match the opportunity
  // -------------------------------------------------------------------------
  // Uses PostgreSQL @> array containment operator for market and timeframe
  // checks, and numeric <= comparison for the confidence threshold gate.
  // All filtered columns (markets, timeframes, minConfidence, isActive) are
  // NOT NULL in the schema, so no null-handling is required.
  const matchingUsers = await db
    .select({
      userId: userSettings.id,
      telegramChatId: userSettings.telegramChatId,
      username: userSettings.username,
    })
    .from(userSettings)
    .where(
      and(
        eq(userSettings.isActive, true),
        sql`${userSettings.markets} @> ARRAY[${opportunity.market}]::text[]`,
        sql`${userSettings.timeframes} @> ARRAY[${opportunity.timeframe}]::text[]`,
        sql`${userSettings.minConfidence} <= ${opportunity.confidence}`,
      ),
    );

  // -------------------------------------------------------------------------
  // Step 3: Filter out already-notified users (duplicate prevention)
  // -------------------------------------------------------------------------
  // Per AAP Section 0.4.3: The composite index on (opportunity_id, user_id)
  // enables efficient duplicate-notification prevention. We query all
  // existing notification log entries for this opportunity and exclude
  // those user IDs from the final subscriber list.
  const alreadyNotified = await db
    .select({ userId: notificationLogs.userId })
    .from(notificationLogs)
    .where(eq(notificationLogs.opportunityId, opportunityId));

  const alreadyNotifiedIds = new Set(
    alreadyNotified.map((entry) => entry.userId),
  );

  const newSubscribers: MatchedSubscriber[] = matchingUsers.filter(
    (user) => !alreadyNotifiedIds.has(user.userId),
  );

  // -------------------------------------------------------------------------
  // Step 4: Log matching results for observability
  // -------------------------------------------------------------------------
  logger.info(
    {
      opportunityId,
      symbol: opportunity.symbol,
      market: opportunity.market,
      totalMatched: matchingUsers.length,
      newSubscribers: newSubscribers.length,
      alreadyNotified: alreadyNotifiedIds.size,
    },
    "Subscriber matching complete",
  );

  // -------------------------------------------------------------------------
  // Step 5: Return the MatchResult with opportunity data and subscribers
  // -------------------------------------------------------------------------
  return {
    opportunity: {
      id: opportunity.id,
      symbol: opportunity.symbol,
      market: opportunity.market,
      direction: opportunity.direction,
      confidence: opportunity.confidence,
      entryPrice: opportunity.entryPrice,
      stopLoss: opportunity.stopLoss,
      takeProfit: opportunity.takeProfit,
      timeframe: opportunity.timeframe,
      reasoning: opportunity.reasoning,
      riskRewardRatio: opportunity.riskRewardRatio,
    },
    subscribers: newSubscribers,
  };
}

// ---------------------------------------------------------------------------
// logNotification — Delivery Status Logging Helper
// ---------------------------------------------------------------------------

/**
 * Records the delivery status of a notification in the `notification_logs`
 * table. Called by the notification worker after each Telegram send attempt.
 *
 * This function handles both successful deliveries (status = "sent" with
 * a Telegram message ID) and failures (status = "failed" with an error
 * message). The `sentAt` timestamp is only populated for successful sends.
 *
 * @param opportunityId — UUID of the trade opportunity that triggered the notification
 * @param userId — UUID of the user (from `user_settings.id`) who was targeted
 * @param status — Delivery status: "pending", "sent", "failed", or "skipped"
 * @param telegramMessageId — Telegram Bot API message ID (only on successful send)
 * @param error — Error message string (only on failed delivery)
 *
 * @example
 * ```typescript
 * // Successful delivery
 * await logNotification(opportunityId, userId, "sent", message.message_id);
 *
 * // Failed delivery
 * await logNotification(opportunityId, userId, "failed", undefined, err.message);
 * ```
 */
export async function logNotification(
  opportunityId: string,
  userId: string,
  status: string,
  telegramMessageId?: number,
  error?: string,
): Promise<void> {
  await db.insert(notificationLogs).values({
    opportunityId,
    userId,
    status,
    telegramMessageId: telegramMessageId ?? null,
    error: error ?? null,
    sentAt: status === "sent" ? new Date() : null,
  });

  logger.info(
    { opportunityId, userId, status },
    "Notification logged",
  );
}
