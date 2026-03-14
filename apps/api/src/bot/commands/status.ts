/**
 * /status Command Handler — Telegram Bot System Health Summary
 *
 * Exports a single async handler function `handleStatus` for the Telegram
 * `/status` bot command. When invoked by a user, it concurrently queries:
 *
 *  1. **BullMQ Queue Job Counts** — Waiting, active, completed, failed, and
 *     delayed job counts for all 3 queues (news-polling, analysis, notifications).
 *  2. **API Source Health** — Name, enabled/disabled status, and consecutive
 *     error count for each registered external data source from the `api_sources`
 *     PostgreSQL table.
 *
 * The gathered data is formatted into a MarkdownV2-compliant Telegram message
 * with emoji status indicators:
 *  - 🟢 Healthy — Queue has zero failed jobs / API source enabled with low errors
 *  - 🟡 Warning — Queue has failed jobs / API source enabled but high error count (>5)
 *  - 🔴 Down — API source is disabled
 *
 * Registered in `apps/api/src/bot/index.ts` via:
 * ```ts
 * bot.command("status", handleStatus);
 * ```
 *
 * @module bot/commands/status
 * @see AAP Rule 0.7.5 — MarkdownV2 character escaping requirements
 * @see AAP Rule 0.7.4 — Graceful degradation on component failure
 */

import { type Context } from "grammy";
import { type Queue } from "bullmq";

import { db } from "../../db/index.js";
import { apiSources } from "../../db/schema/api-sources.js";
import { createLogger } from "../../lib/logger.js";
import {
  newsPollingQueue,
  analysisQueue,
  notificationsQueue,
} from "../../queues/index.js";

// ---------------------------------------------------------------------------
// Logger — Scoped to bot:status command
// ---------------------------------------------------------------------------

/**
 * Child logger with `{ module: "bot:status" }` context binding.
 * All log entries from this module include the module field for structured
 * filtering in log aggregation tools.
 */
const logger = createLogger("bot:status");

// ---------------------------------------------------------------------------
// MarkdownV2 Escape Utility (module-private)
// ---------------------------------------------------------------------------

/**
 * Escapes all special characters required by Telegram's MarkdownV2 parse mode.
 *
 * Per the Telegram Bot API specification, the following characters must be
 * escaped with a preceding backslash when used outside of MarkdownV2 entity
 * syntax: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`,
 * `=`, `|`, `{`, `}`, `.`, `!`, `\`
 *
 * @param text — Raw text string to escape for MarkdownV2
 * @returns The input string with all special characters backslash-escaped
 *
 * @see AAP Rule 0.7.5 — MarkdownV2 escaping requirements
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// Queue Counts Interface and Helper
// ---------------------------------------------------------------------------

/**
 * Typed representation of BullMQ queue job state counts.
 * Each field corresponds to a BullMQ job lifecycle state.
 */
interface QueueCounts {
  /** Jobs waiting to be picked up by a worker */
  waiting: number;
  /** Jobs currently being processed by a worker */
  active: number;
  /** Jobs that completed successfully */
  completed: number;
  /** Jobs that exhausted all retry attempts */
  failed: number;
  /** Jobs scheduled for future processing */
  delayed: number;
}

/**
 * Retrieves job state counts from a BullMQ Queue instance.
 *
 * Uses the BullMQ `queue.getJobCounts()` API to query Redis for the number
 * of jobs in each lifecycle state. Returns a typed `QueueCounts` object with
 * nullish coalescing to ensure all fields default to 0.
 *
 * **Graceful degradation** (AAP Rule 0.7.4): If the queue is unreachable
 * (e.g., Redis connection down), the function catches the error silently and
 * returns zeroed counts rather than propagating the exception. This ensures
 * the `/status` command can still display partial results for other components.
 *
 * @param queue — Any BullMQ Queue instance (news-polling, analysis, or notifications)
 * @returns Job counts per state, or all zeros if the queue is unreachable
 */
async function getQueueCounts(queue: Queue): Promise<QueueCounts> {
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch {
    // Graceful degradation — return zeros if queue/Redis is unreachable.
    // The status message will show all zeros which the operator can interpret
    // as "queue data unavailable" rather than crashing the entire command.
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }
}

// ---------------------------------------------------------------------------
// API Source Status Interface and Helper
// ---------------------------------------------------------------------------

/**
 * Lightweight projection of an `api_sources` row for status display.
 * Contains only the fields needed for the system health summary.
 */
interface ApiSourceInfo {
  /** Human-readable source name (e.g., "Finnhub", "CoinGecko") */
  name: string;
  /** Whether this source is currently active/enabled for polling */
  isActive: boolean;
  /** Consecutive error count — high values indicate degraded health */
  errorCount: number;
}

/**
 * Queries the `api_sources` table for all registered external data sources
 * and returns a lightweight projection of name, active status, and error count.
 *
 * Uses Drizzle ORM's typed `select().from()` API to retrieve only the columns
 * needed for the status display, minimizing data transfer from PostgreSQL.
 *
 * **Graceful degradation** (AAP Rule 0.7.4): If the database is unreachable,
 * returns an empty array rather than throwing. The formatter will display a
 * "⚠️ Unable to fetch API source status" warning in the status message.
 *
 * @returns Array of API source info objects, or empty array if DB is unreachable
 */
async function getApiSourceStatus(): Promise<ApiSourceInfo[]> {
  try {
    const sources = await db
      .select({
        name: apiSources.name,
        isActive: apiSources.isActive,
        errorCount: apiSources.errorCount,
      })
      .from(apiSources);
    return sources;
  } catch {
    // Graceful degradation — return empty array if DB query fails.
    // This allows the status command to still display queue information
    // even when the database is temporarily unavailable.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Status Message Formatters
// ---------------------------------------------------------------------------

/**
 * Formats a single queue's status line with emoji indicator and job counts.
 *
 * Status indicators:
 *  - 🟢 Green — Queue is healthy (zero failed jobs)
 *  - 🟡 Yellow — Queue has one or more failed jobs requiring attention
 *
 * All dynamic values are escaped for MarkdownV2 compliance.
 *
 * @param name — Human-readable queue name (e.g., "News Polling")
 * @param counts — Job state counts for this queue
 * @returns A single MarkdownV2-safe line for the status message
 */
function formatQueueLine(name: string, counts: QueueCounts): string {
  const statusEmoji = counts.failed > 0 ? "🟡" : "🟢";
  const escapedName = escapeMarkdownV2(name);
  const escapedWaiting = escapeMarkdownV2(String(counts.waiting));
  const escapedActive = escapeMarkdownV2(String(counts.active));
  const escapedCompleted = escapeMarkdownV2(String(counts.completed));
  const escapedFailed = escapeMarkdownV2(String(counts.failed));

  return `  ${statusEmoji} ${escapedName}: ${escapedWaiting} waiting, ${escapedActive} active, ${escapedCompleted} done, ${escapedFailed} failed`;
}

/**
 * Assembles the complete MarkdownV2-formatted system status message.
 *
 * The message structure:
 * ```
 * 📊 *System Status*
 *
 * *Queues:*
 *   🟢 News Polling: 0 waiting, 0 active, 42 done, 0 failed
 *   🟢 Analysis: 2 waiting, 1 active, 38 done, 0 failed
 *   🟡 Notifications: 0 waiting, 0 active, 35 done, 3 failed
 *
 * *API Sources:*
 *   🟢 Finnhub (errors: 0)
 *   🟡 CoinGecko (errors: 7)
 *   🔴 Alpha Vantage (errors: 25)
 * ```
 *
 * @param newsPolling — Job counts for the news-polling queue
 * @param analysis — Job counts for the analysis queue
 * @param notifications — Job counts for the notifications queue
 * @param sources — API source health information from the database
 * @returns Complete MarkdownV2-formatted status message string
 */
function formatStatusMessage(
  newsPolling: QueueCounts,
  analysis: QueueCounts,
  notifications: QueueCounts,
  sources: ApiSourceInfo[],
): string {
  const lines: string[] = [];

  // Header
  lines.push("📊 *System Status*");
  lines.push("");

  // Queue status section
  lines.push("*Queues:*");
  lines.push(formatQueueLine("News Polling", newsPolling));
  lines.push(formatQueueLine("Analysis", analysis));
  lines.push(formatQueueLine("Notifications", notifications));
  lines.push("");

  // API sources section
  lines.push("*API Sources:*");
  if (sources.length === 0) {
    lines.push("  ⚠️ Unable to fetch API source status");
  } else {
    for (const source of sources) {
      // Emoji status indicators:
      // 🟢 — Enabled and healthy (error count <= 5)
      // 🟡 — Enabled but degraded (error count > 5)
      // 🔴 — Disabled / inactive
      const statusEmoji = source.isActive
        ? source.errorCount > 5
          ? "🟡"
          : "🟢"
        : "🔴";

      const escapedName = escapeMarkdownV2(source.name);
      const escapedErrors = escapeMarkdownV2(String(source.errorCount));
      lines.push(
        `  ${statusEmoji} ${escapedName} \\(errors: ${escapedErrors}\\)`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Exported Command Handler
// ---------------------------------------------------------------------------

/**
 * Handles the `/status` Telegram bot command.
 *
 * This is the ONLY export from this module. It is registered in the grammY
 * bot initialization via `bot.command("status", handleStatus)`.
 *
 * Execution flow:
 * 1. Extracts the chat ID from the grammY context for logging
 * 2. Validates chat ID presence (early return if missing)
 * 3. Concurrently fetches queue job counts and API source health via `Promise.all()`
 * 4. Formats the gathered data into a MarkdownV2 status message
 * 5. Sends the formatted message to the user with `parse_mode: "MarkdownV2"`
 *
 * Error handling:
 * - Missing chat ID → Warning log + plain text reply, early return
 * - Component failure (queue/DB) → Graceful degradation in helpers (zeros/empty)
 * - Top-level error → Error log + plain text fallback reply
 *
 * @param ctx — grammY Context object for the incoming /status command
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();

  if (!chatId) {
    logger.warn("Received /status without chat ID");
    await ctx.reply("Unable to identify your chat. Please try again.");
    return;
  }

  try {
    // Gather all status data concurrently for minimum response latency.
    // Each helper has its own try/catch for graceful degradation — a failure
    // in one component (e.g., Redis down) does not prevent displaying data
    // from other components (e.g., API source health from PostgreSQL).
    const [newsPollingCounts, analysisCounts, notificationCounts, sources] =
      await Promise.all([
        getQueueCounts(newsPollingQueue),
        getQueueCounts(analysisQueue),
        getQueueCounts(notificationsQueue),
        getApiSourceStatus(),
      ]);

    // Assemble the complete status message with all gathered data
    const statusMessage = formatStatusMessage(
      newsPollingCounts,
      analysisCounts,
      notificationCounts,
      sources,
    );

    // Send the formatted message with MarkdownV2 parse mode for proper
    // rendering of bold text, emoji indicators, and escaped special characters
    await ctx.reply(statusMessage, { parse_mode: "MarkdownV2" });

    logger.debug({ chatId }, "Status displayed");
  } catch (error: unknown) {
    // Top-level error handler for unexpected failures that bypass the
    // individual component graceful degradation (e.g., grammY API errors,
    // network failures during reply, or unexpected deserialization issues).
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        chatId,
      },
      "Error handling /status command",
    );
    await ctx.reply(
      "An error occurred fetching system status. Please try again.",
    );
  }
}
