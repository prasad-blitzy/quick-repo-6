/**
 * Callback Query Handlers — Telegram Bot Preference Configuration
 *
 * Processes all inline keyboard button presses (callback queries) from
 * the Telegram bot /settings menus. When a user taps a button, Telegram
 * sends a callback query whose `data` field encodes the action. This
 * module parses that data, dispatches to the appropriate sub-handler,
 * updates the user's preferences in the `user_settings` database table,
 * answers the callback query (dismisses the spinner), and edits the
 * original message to reflect the updated toggle/selection state.
 *
 * Routing logic:
 *  - `market:<id>`       → toggles a market in/out of user.markets[]
 *  - `timeframe:<id>`    → toggles a timeframe in/out of user.timeframes[]
 *  - `confidence:<val>`  → sets user.minConfidence to the chosen value
 *  - `settings:markets`  → navigates to the market sub-keyboard
 *  - `settings:timeframes` → navigates to the timeframe sub-keyboard
 *  - `settings:confidence` → navigates to the confidence sub-keyboard
 *  - `settings:back`     → navigates back to the main settings menu
 *
 * Integration:
 *  - Registered by `apps/api/src/bot/index.ts` via
 *    `bot.on("callback_query:data", handleCallbackQuery)`
 *
 * @module bot/callbacks
 */

import { type Context } from "grammy";
import { eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { userSettings } from "../db/schema/user-settings.js";
import { createLogger } from "../lib/logger.js";
import {
  CALLBACK_PREFIXES,
  buildMarketKeyboard,
  buildTimeframeKeyboard,
  buildConfidenceKeyboard,
  buildSettingsKeyboard,
} from "./keyboards.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Child logger with `{ module: "bot:callbacks" }` context binding. */
const logger = createLogger("bot:callbacks");

// ---------------------------------------------------------------------------
// Main Callback Query Handler (exported)
// ---------------------------------------------------------------------------

/**
 * Primary callback query dispatcher.
 *
 * Reads `ctx.callbackQuery.data`, determines the action by matching
 * known prefixes from {@link CALLBACK_PREFIXES}, and delegates to the
 * corresponding private sub-handler. Unknown actions receive a generic
 * "Unknown action" answer. All Telegram API errors and database failures
 * are caught, logged, and answered with a user-facing error message.
 *
 * @param ctx - grammY callback query context providing access to
 *              `callbackQuery.data`, `answerCallbackQuery()`,
 *              `editMessageReplyMarkup()`, and `editMessageText()`.
 */
export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery("Unknown action");
    return;
  }

  const chatId = ctx.callbackQuery?.message?.chat.id?.toString();
  if (!chatId) {
    await ctx.answerCallbackQuery("Unable to identify user");
    return;
  }

  try {
    if (data.startsWith(CALLBACK_PREFIXES.MARKET_TOGGLE)) {
      await handleMarketToggle(ctx, chatId, data);
    } else if (data.startsWith(CALLBACK_PREFIXES.TIMEFRAME_TOGGLE)) {
      await handleTimeframeToggle(ctx, chatId, data);
    } else if (data.startsWith(CALLBACK_PREFIXES.CONFIDENCE_SET)) {
      await handleConfidenceSet(ctx, chatId, data);
    } else if (data === "settings:markets") {
      await showMarketKeyboard(ctx, chatId);
    } else if (data === "settings:timeframes") {
      await showTimeframeKeyboard(ctx, chatId);
    } else if (data === "settings:confidence") {
      await showConfidenceKeyboard(ctx, chatId);
    } else if (data === CALLBACK_PREFIXES.BACK_TO_SETTINGS) {
      await showMainSettings(ctx);
    } else {
      await ctx.answerCallbackQuery("Unknown action");
    }
  } catch (error: unknown) {
    logger.error({ error, chatId, data }, "Error handling callback query");
    await ctx.answerCallbackQuery("An error occurred. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Toggle Handlers (private)
// ---------------------------------------------------------------------------

/**
 * Toggles a market in/out of the user's `markets` preference array.
 *
 * Workflow:
 *  1. Parse market ID from callback data by stripping the prefix.
 *  2. Fetch the user's current settings by Telegram chat ID.
 *  3. If the market is already in the array, remove it; otherwise add it.
 *  4. Persist the updated array (with fresh `updatedAt`) to the DB.
 *  5. Answer the callback query with the toggle status message.
 *  6. Edit the inline keyboard to reflect the new ✓/✗ toggle states.
 *
 * @param ctx    - grammY context for answering and editing the message.
 * @param chatId - Stringified Telegram chat ID for DB lookup.
 * @param data   - Full callback data string (e.g. "market:us_stock").
 */
async function handleMarketToggle(
  ctx: Context,
  chatId: string,
  data: string,
): Promise<void> {
  const marketId = data.replace(CALLBACK_PREFIXES.MARKET_TOGGLE, "");

  // Fetch current user settings
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.telegramChatId, chatId))
    .limit(1);

  const user = rows[0];
  if (!user) {
    await ctx.answerCallbackQuery("User not found. Please /start first.");
    return;
  }

  // Toggle market in the array
  const currentMarkets: string[] = user.markets ?? [];
  const updatedMarkets: string[] = currentMarkets.includes(marketId)
    ? currentMarkets.filter((m) => m !== marketId)
    : [...currentMarkets, marketId];

  // Persist to database
  await db
    .update(userSettings)
    .set({ markets: updatedMarkets, updatedAt: new Date() })
    .where(eq(userSettings.telegramChatId, chatId));

  // Answer callback and edit keyboard to show new toggle state
  const status = updatedMarkets.includes(marketId) ? "enabled" : "disabled";
  await ctx.answerCallbackQuery(`${marketId} ${status}`);
  await ctx.editMessageReplyMarkup({
    reply_markup: buildMarketKeyboard(updatedMarkets),
  });

  logger.debug({ chatId, marketId, updatedMarkets }, "Market preference toggled");
}

/**
 * Toggles a timeframe in/out of the user's `timeframes` preference array.
 *
 * Follows the same toggle pattern as {@link handleMarketToggle}: fetch
 * current preferences, add/remove the timeframe, persist, answer, and
 * rebuild the keyboard.
 *
 * @param ctx    - grammY context.
 * @param chatId - Stringified Telegram chat ID.
 * @param data   - Full callback data string (e.g. "timeframe:swing").
 */
async function handleTimeframeToggle(
  ctx: Context,
  chatId: string,
  data: string,
): Promise<void> {
  const timeframeId = data.replace(CALLBACK_PREFIXES.TIMEFRAME_TOGGLE, "");

  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.telegramChatId, chatId))
    .limit(1);

  const user = rows[0];
  if (!user) {
    await ctx.answerCallbackQuery("User not found. Please /start first.");
    return;
  }

  const currentTimeframes: string[] = user.timeframes ?? [];
  const updatedTimeframes: string[] = currentTimeframes.includes(timeframeId)
    ? currentTimeframes.filter((t) => t !== timeframeId)
    : [...currentTimeframes, timeframeId];

  await db
    .update(userSettings)
    .set({ timeframes: updatedTimeframes, updatedAt: new Date() })
    .where(eq(userSettings.telegramChatId, chatId));

  const status = updatedTimeframes.includes(timeframeId) ? "enabled" : "disabled";
  await ctx.answerCallbackQuery(`${timeframeId} ${status}`);
  await ctx.editMessageReplyMarkup({
    reply_markup: buildTimeframeKeyboard(updatedTimeframes),
  });

  logger.debug(
    { chatId, timeframeId, updatedTimeframes },
    "Timeframe preference toggled",
  );
}

/**
 * Sets the user's minimum confidence threshold.
 *
 * Unlike the toggle handlers, this replaces the current value rather than
 * toggling it. The confidence value is stored as a `numeric(3,2)` string
 * in the database (e.g. "0.70") to preserve decimal precision per
 * AAP Rule §0.7.2.
 *
 * @param ctx    - grammY context.
 * @param chatId - Stringified Telegram chat ID.
 * @param data   - Full callback data string (e.g. "confidence:0.80").
 */
async function handleConfidenceSet(
  ctx: Context,
  chatId: string,
  data: string,
): Promise<void> {
  const confidence = data.replace(CALLBACK_PREFIXES.CONFIDENCE_SET, "");

  await db
    .update(userSettings)
    .set({ minConfidence: confidence, updatedAt: new Date() })
    .where(eq(userSettings.telegramChatId, chatId));

  await ctx.answerCallbackQuery(`Confidence threshold set to ${confidence}`);
  await ctx.editMessageReplyMarkup({
    reply_markup: buildConfidenceKeyboard(confidence),
  });

  logger.debug({ chatId, confidence }, "Confidence threshold updated");
}

// ---------------------------------------------------------------------------
// Navigation Handlers — Show Sub-Keyboards (private)
// ---------------------------------------------------------------------------

/**
 * Displays the market selection sub-keyboard.
 *
 * Fetches the user's current market selections from the database and
 * renders the keyboard with ✓/✗ indicators. Replaces the current
 * message text with the market selection header.
 *
 * @param ctx    - grammY context.
 * @param chatId - Stringified Telegram chat ID.
 */
async function showMarketKeyboard(
  ctx: Context,
  chatId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.telegramChatId, chatId))
    .limit(1);

  const markets: string[] = rows[0]?.markets ?? [];
  await ctx.editMessageText(
    "📈 *Select Markets*\nToggle markets for notifications:",
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildMarketKeyboard(markets),
    },
  );
  await ctx.answerCallbackQuery();
}

/**
 * Displays the timeframe selection sub-keyboard.
 *
 * Fetches the user's current timeframe selections from the database and
 * renders the keyboard with ✓/✗ indicators. Replaces the current
 * message text with the timeframe selection header.
 *
 * @param ctx    - grammY context.
 * @param chatId - Stringified Telegram chat ID.
 */
async function showTimeframeKeyboard(
  ctx: Context,
  chatId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.telegramChatId, chatId))
    .limit(1);

  const timeframes: string[] = rows[0]?.timeframes ?? [];
  await ctx.editMessageText(
    "⏱ *Select Timeframes*\nToggle timeframes for notifications:",
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildTimeframeKeyboard(timeframes),
    },
  );
  await ctx.answerCallbackQuery();
}

/**
 * Displays the confidence threshold selection sub-keyboard.
 *
 * Fetches the user's current confidence level from the database and
 * highlights the active threshold. Replaces the current message text
 * with the confidence selection header.
 *
 * @param ctx    - grammY context.
 * @param chatId - Stringified Telegram chat ID.
 */
async function showConfidenceKeyboard(
  ctx: Context,
  chatId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.telegramChatId, chatId))
    .limit(1);

  const confidence: string = rows[0]?.minConfidence ?? "0.70";
  await ctx.editMessageText(
    "🎯 *Confidence Threshold*\nSelect minimum confidence for alerts:",
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildConfidenceKeyboard(confidence),
    },
  );
  await ctx.answerCallbackQuery();
}

/**
 * Navigates back to the top-level settings menu.
 *
 * Replaces the current message with the main settings header and the
 * three-category navigation keyboard (Markets, Timeframes, Confidence).
 *
 * @param ctx - grammY context.
 */
async function showMainSettings(ctx: Context): Promise<void> {
  await ctx.editMessageText(
    "⚙️ *Settings*\nConfigure your notification preferences:",
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildSettingsKeyboard(),
    },
  );
  await ctx.answerCallbackQuery();
}
