/**
 * /settings Command Handler — Telegram Bot Preference Configuration
 *
 * Exports the `handleSettings` async function that serves as the handler for
 * the `/settings` Telegram bot command. When invoked, it:
 *
 *  1. Extracts the Telegram chat ID from the grammY context
 *  2. Queries the `user_settings` database table via Drizzle ORM to fetch the
 *     current user's notification preferences (markets, timeframes, confidence)
 *  3. If the user is not registered, prompts them to run `/start` first
 *  4. If registered, builds a MarkdownV2-formatted summary of their current
 *     preferences and attaches the main settings inline keyboard (Markets,
 *     Timeframes, Confidence) for interactive preference configuration
 *
 * This handler is registered in `apps/api/src/bot/index.ts` via:
 * ```ts
 * bot.command("settings", handleSettings);
 * ```
 *
 * The inline keyboard buttons trigger callback queries that are routed to
 * `apps/api/src/bot/callbacks.ts` for sub-menu navigation and preference
 * toggling.
 *
 * @module bot/commands/settings
 * @see {@link ../keyboards.ts} Inline keyboard builders
 * @see {@link ../callbacks.ts} Callback query handlers for keyboard actions
 */

import { type Context } from "grammy";
import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { userSettings } from "../../db/schema/user-settings.js";
import { createLogger } from "../../lib/logger.js";
import { buildSettingsKeyboard } from "../keyboards.js";

// ---------------------------------------------------------------------------
// Logger — Namespaced child logger for /settings command events
// ---------------------------------------------------------------------------

/**
 * Pino child logger bound with `{ module: "bot:settings" }` context.
 * Used for structured logging of all events within this command handler:
 *  - debug: successful settings display confirmations
 *  - warn: missing chat ID detections
 *  - error: command handling failures with stack context
 */
const logger = createLogger("bot:settings");

// ---------------------------------------------------------------------------
// MarkdownV2 Escape Utility (module-private)
// ---------------------------------------------------------------------------

/**
 * Escapes all Telegram MarkdownV2 special characters in the given text by
 * prepending each occurrence with a backslash (`\`).
 *
 * Per the Telegram Bot API MarkdownV2 specification, the following characters
 * must be escaped outside of code/pre entities:
 *   `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`,
 *   `|`, `{`, `}`, `.`, `!`, `\`
 *
 * This function is applied to DYNAMIC content only (user data fetched from
 * the database such as market names, confidence values). Static MarkdownV2
 * formatting (e.g., `*Settings*` for bold) is manually escaped at write time.
 *
 * @param text - The raw text string to escape.
 * @returns The escaped string safe for embedding in MarkdownV2 messages.
 *
 * @example
 * ```ts
 * escapeMarkdownV2("us_stock, crypto");  // "us\\_stock, crypto"
 * escapeMarkdownV2("0.70");              // "0\\.70"
 * ```
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// /settings Command Handler
// ---------------------------------------------------------------------------

/**
 * Handles the `/settings` Telegram bot command.
 *
 * Workflow:
 *  1. Extracts the chat ID from `ctx.chat?.id` and converts to string
 *  2. If no chat ID is present, warns and replies with a plain-text error
 *  3. Queries the `user_settings` table for a record matching the chat ID
 *  4. If no user record exists, replies with a MarkdownV2 prompt to use `/start`
 *  5. If the user exists, builds a settings summary showing their current
 *     markets, timeframes, and minimum confidence threshold
 *  6. Sends the summary with an inline keyboard for preference navigation
 *
 * Error handling:
 *  - All database and Telegram API errors are caught, logged with full
 *    context, and a plain-text fallback reply is sent to the user
 *  - Uses `unknown` error type with `instanceof Error` type guard per
 *    AAP Rule 0.7.1 (no `any` types)
 *
 * @param ctx - grammY Context providing access to the Telegram message,
 *              chat metadata, and reply methods.
 */
export async function handleSettings(ctx: Context): Promise<void> {
  // -------------------------------------------------------------------------
  // Step 1 — Extract and validate chat ID
  // -------------------------------------------------------------------------
  const chatId = ctx.chat?.id?.toString();

  if (!chatId) {
    logger.warn("Received /settings without chat ID");
    await ctx.reply("Unable to identify your chat. Please try again.");
    return;
  }

  try {
    // -----------------------------------------------------------------------
    // Step 2 — Check if user is registered by querying user_settings
    // -----------------------------------------------------------------------
    // Uses Drizzle ORM's select().from().where().limit() chain with the eq()
    // operator to find the user by their Telegram chat ID. The limit(1)
    // ensures at most one row is returned.
    //
    // With `noUncheckedIndexedAccess`, the destructured `user` is typed as
    // `UserSettings | undefined`, requiring the explicit `if (!user)` check.
    const [user] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.telegramChatId, chatId))
      .limit(1);

    if (!user) {
      // User not registered — prompt them to use /start first
      // CRITICAL: Escape `.` and `!` for MarkdownV2 compliance (AAP Rule 0.7.5)
      await ctx.reply(
        "You're not registered yet\\. Please use /start first\\!",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    // -----------------------------------------------------------------------
    // Step 3 — Build inline keyboard for settings navigation
    // -----------------------------------------------------------------------
    // Returns an InlineKeyboard with 3 buttons:
    //   📈 Markets    → callback "settings:markets"
    //   ⏱ Timeframes → callback "settings:timeframes"
    //   🎯 Confidence → callback "settings:confidence"
    const keyboard = buildSettingsKeyboard();

    // -----------------------------------------------------------------------
    // Step 4 — Format current settings summary with MarkdownV2
    // -----------------------------------------------------------------------
    // user.markets is string[] (notNull, default [])
    // user.timeframes is string[] (notNull, default [])
    // user.minConfidence is string (notNull, default "0.70")
    //
    // Defensive ?? [] / ?? "0.70" handles any unexpected null/undefined values
    // that could arise from DB migration edge cases or schema changes.
    const marketsDisplay = (user.markets ?? []).join(", ") || "None";
    const timeframesDisplay = (user.timeframes ?? []).join(", ") || "None";
    const confidenceDisplay = user.minConfidence ?? "0.70";

    // CRITICAL: Escape ALL MarkdownV2 special characters in dynamic content
    // to prevent Telegram API parse errors (AAP Rule 0.7.5).
    // Characters like `_` in "us_stock" and `.` in "0.70" are escaped.
    const escapedMarkets = escapeMarkdownV2(marketsDisplay);
    const escapedTimeframes = escapeMarkdownV2(timeframesDisplay);
    const escapedConfidence = escapeMarkdownV2(confidenceDisplay);

    // Build the message using array join for readability.
    // Static MarkdownV2 formatting (*bold*) is written manually.
    // Dynamic values are pre-escaped via escapeMarkdownV2().
    const settingsMessage = [
      "⚙️ *Settings*",
      "",
      `📈 *Markets:* ${escapedMarkets}`,
      `⏱ *Timeframes:* ${escapedTimeframes}`,
      `🎯 *Min Confidence:* ${escapedConfidence}`,
      "",
      "Choose a category to configure:",
    ].join("\n");

    // -----------------------------------------------------------------------
    // Step 5 — Send formatted settings message with inline keyboard
    // -----------------------------------------------------------------------
    await ctx.reply(settingsMessage, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });

    logger.debug(
      { chatId, markets: user.markets, timeframes: user.timeframes },
      "Settings displayed",
    );
  } catch (error: unknown) {
    // -----------------------------------------------------------------------
    // Error handling — log and send plain-text fallback reply
    // -----------------------------------------------------------------------
    // Uses `unknown` type with `instanceof Error` type guard per AAP Rule 0.7.1.
    // Plain text reply (no MarkdownV2) to avoid double-failure if parsing fails.
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        chatId,
      },
      "Error handling /settings command",
    );
    await ctx.reply("An error occurred. Please try again.");
  }
}
