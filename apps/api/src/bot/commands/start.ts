/**
 * /start Command Handler — User Registration
 *
 * Handles the `/start` Telegram bot command by creating a new subscriber
 * record in the `user_settings` database table with default notification
 * preferences. Registration is idempotent — re-running `/start` silently
 * skips the insert (via PostgreSQL `ON CONFLICT DO NOTHING`) and re-sends
 * the welcome message so returning users see the introduction again.
 *
 * Default preferences on registration:
 *  - Markets: all enabled (us_stock, indian_equity, crypto)
 *  - Min confidence: 0.70 (70% threshold)
 *  - Timeframes: all enabled (intraday, swing, position)
 *  - Active: true (notifications immediately enabled)
 *
 * This handler is registered in `apps/api/src/bot/index.ts` via:
 * ```ts
 * bot.command("start", handleStart);
 * ```
 *
 * @module bot/commands/start
 */

import { type Context } from "grammy";

import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/user-settings.js";
import { createLogger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Child logger namespaced to the /start command handler.
 * All log entries include `{ module: "bot:start" }` for structured filtering.
 */
const logger = createLogger("bot:start");

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

/**
 * Handles the `/start` Telegram bot command.
 *
 * Workflow:
 *  1. Extract the Telegram chat ID and username from the grammY context.
 *  2. Guard against missing chat ID (edge case: channel posts, webhook
 *     misconfiguration).
 *  3. Insert a new `user_settings` row with default preferences.
 *     - Uses `onConflictDoNothing()` for idempotent registration —
 *       if the user already exists (unique `telegram_chat_id`), the insert
 *       is silently skipped without error.
 *  4. Send a MarkdownV2-formatted welcome message describing features.
 *  5. On failure, log the error and reply with a plain-text error message.
 *
 * @param ctx — grammY Context providing chat metadata and reply methods.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  const username = ctx.from?.username ?? ctx.from?.first_name ?? "Unknown";

  // Guard: bail out if we cannot identify the chat (shouldn't happen in
  // normal private-chat scenarios, but protects against edge cases).
  if (!chatId) {
    logger.warn("Received /start without chat ID");
    await ctx.reply("Unable to identify your chat. Please try again.");
    return;
  }

  try {
    // ------------------------------------------------------------------
    // Idempotent user registration
    // ------------------------------------------------------------------
    // Insert a new subscriber with default preferences. The UNIQUE
    // constraint on `telegram_chat_id` means a duplicate `/start`
    // invocation triggers `ON CONFLICT DO NOTHING` — no error, no
    // duplicate row. The welcome message is still sent so returning
    // users see the introduction again.
    await db
      .insert(userSettings)
      .values({
        telegramChatId: chatId,
        username: username,
        markets: ["us_stock", "indian_equity", "crypto"],
        minConfidence: "0.70",
        timeframes: ["intraday", "swing", "position"],
        isActive: true,
      })
      .onConflictDoNothing();

    logger.info({ chatId, username }, "User registered via /start");

    // ------------------------------------------------------------------
    // Welcome message (MarkdownV2)
    // ------------------------------------------------------------------
    // CRITICAL — AAP Rule 0.7.5: All special MarkdownV2 characters must
    // be escaped with `\`. In TypeScript string literals, `\\` produces
    // a single `\` character in the runtime string.
    //
    // Characters requiring escape per Telegram Bot API MarkdownV2 spec:
    //   _ * [ ] ( ) ~ ` > # + - = | { } . !
    const welcomeMessage = [
      "🤖 *Welcome to Trading Intelligence Bot\\!*",
      "",
      "I analyze financial news from 30\\+ sources across:",
      "📈 US Stocks \\(Finnhub, CNBC, MarketWatch\\)",
      "🇮🇳 Indian Equities \\(Economic Times, NSE\\)",
      "₿ Cryptocurrency \\(CoinGecko, CryptoCompare\\)",
      "💬 Social Sentiment \\(Reddit\\)",
      "",
      "When I detect trade opportunities, I\\'ll send you alerts with:",
      "🟢 LONG or 🔴 SHORT recommendations",
      "Entry, stop\\-loss, and take\\-profit prices",
      "Confidence scores and risk\\-reward ratios",
      "",
      "Use /settings to configure your preferences",
      "Use /status to check system health",
    ].join("\n");

    await ctx.reply(welcomeMessage, { parse_mode: "MarkdownV2" });
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), chatId },
      "Error handling /start command",
    );
    await ctx.reply(
      "An error occurred during registration. Please try again.",
    );
  }
}
