/**
 * Inline Keyboard Builders — Telegram Bot Preference Configuration UI
 *
 * Builds inline keyboards using grammY's InlineKeyboard class for the
 * /settings command. Users interact with these keyboards to configure
 * notification preferences (markets, timeframes, confidence threshold).
 *
 * Keyboards use toggle-style buttons showing ✓ (selected) / ✗ (unselected)
 * states. Each button encodes a callback_data string with a known prefix
 * so that callbacks.ts can parse and dispatch actions.
 *
 * Consumed by:
 *  - apps/api/src/bot/commands/settings.ts — initial settings menu
 *  - apps/api/src/bot/callbacks.ts — sub-keyboard rebuilds after toggles
 */

import { InlineKeyboard } from "grammy";

// ---------------------------------------------------------------------------
// Callback data prefix constants
// ---------------------------------------------------------------------------

/**
 * Prefixes for callback_data strings used across all inline keyboards.
 * Exported so that callbacks.ts can match incoming callback queries
 * against these prefixes to route actions appropriately.
 */
export const CALLBACK_PREFIXES = {
  /** Prefix for market toggle buttons — e.g. "market:us_stock" */
  MARKET_TOGGLE: "market:",
  /** Prefix for timeframe toggle buttons — e.g. "timeframe:swing" */
  TIMEFRAME_TOGGLE: "timeframe:",
  /** Prefix for confidence level selection — e.g. "confidence:0.70" */
  CONFIDENCE_SET: "confidence:",
  /** Fixed callback for the "Back to settings" navigation button */
  BACK_TO_SETTINGS: "settings:back",
} as const;

// ---------------------------------------------------------------------------
// Market definitions
// ---------------------------------------------------------------------------

/** Available markets with their display labels and persistent IDs. */
const MARKETS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "us_stock", label: "US Stocks" },
  { id: "indian_equity", label: "Indian Equity" },
  { id: "crypto", label: "Crypto" },
] as const;

// ---------------------------------------------------------------------------
// Timeframe definitions
// ---------------------------------------------------------------------------

/** Available timeframes with their display labels and persistent IDs. */
const TIMEFRAMES: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "intraday", label: "Intraday" },
  { id: "swing", label: "Swing" },
  { id: "position", label: "Positional" },
] as const;

// ---------------------------------------------------------------------------
// Confidence level definitions
// ---------------------------------------------------------------------------

/** Confidence threshold levels rendered as a single-row selector. */
const CONFIDENCE_LEVELS: readonly string[] = [
  "0.50",
  "0.60",
  "0.70",
  "0.80",
  "0.90",
] as const;

// ---------------------------------------------------------------------------
// Keyboard builder functions
// ---------------------------------------------------------------------------

/**
 * Builds the market selection keyboard.
 *
 * Each market is rendered as its own row with a ✓ / ✗ toggle prefix
 * indicating whether the market is currently selected. A "⬅️ Back" button
 * at the bottom returns the user to the main settings menu.
 *
 * @param selectedMarkets - Array of currently selected market IDs
 *   (e.g. ["us_stock", "crypto"]). IDs must match the `market` enum values
 *   stored in the `user_settings.markets` database column.
 * @returns An InlineKeyboard instance ready for use with ctx.reply or
 *   ctx.editMessageReplyMarkup.
 */
export function buildMarketKeyboard(selectedMarkets: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const market of MARKETS) {
    const isSelected = selectedMarkets.includes(market.id);
    const emoji = isSelected ? "✓" : "✗";
    keyboard
      .text(
        `${emoji} ${market.label}`,
        `${CALLBACK_PREFIXES.MARKET_TOGGLE}${market.id}`,
      )
      .row();
  }

  // Navigation: return to main settings menu
  keyboard.text("⬅️ Back", CALLBACK_PREFIXES.BACK_TO_SETTINGS);
  return keyboard;
}

/**
 * Builds the timeframe selection keyboard.
 *
 * Each timeframe is rendered as its own row with a ✓ / ✗ toggle prefix.
 * A "⬅️ Back" button at the bottom returns the user to the main settings menu.
 *
 * @param selectedTimeframes - Array of currently selected timeframe IDs
 *   (e.g. ["intraday", "swing"]). IDs must match the `timeframe` enum values
 *   stored in the `user_settings.timeframes` database column.
 * @returns An InlineKeyboard instance ready for use.
 */
export function buildTimeframeKeyboard(selectedTimeframes: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const tf of TIMEFRAMES) {
    const isSelected = selectedTimeframes.includes(tf.id);
    const emoji = isSelected ? "✓" : "✗";
    keyboard
      .text(
        `${emoji} ${tf.label}`,
        `${CALLBACK_PREFIXES.TIMEFRAME_TOGGLE}${tf.id}`,
      )
      .row();
  }

  // Navigation: return to main settings menu
  keyboard.text("⬅️ Back", CALLBACK_PREFIXES.BACK_TO_SETTINGS);
  return keyboard;
}

/**
 * Builds the confidence threshold selection keyboard.
 *
 * All five confidence levels are rendered in a single row for compact display.
 * The currently active level shows a ✓ prefix; others show the bare value.
 * A "⬅️ Back" button on a new row returns the user to the main settings menu.
 *
 * @param currentConfidence - Current threshold as a string
 *   (e.g. "0.70"). String comparison is used because the database stores
 *   confidence as `numeric(3,2)`.
 * @returns An InlineKeyboard instance ready for use.
 */
export function buildConfidenceKeyboard(currentConfidence: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const level of CONFIDENCE_LEVELS) {
    const isSelected = level === currentConfidence;
    const label = isSelected ? `✓ ${level}` : level;
    keyboard.text(label, `${CALLBACK_PREFIXES.CONFIDENCE_SET}${level}`);
  }

  // Back button on its own row beneath the confidence level row
  keyboard.row().text("⬅️ Back", CALLBACK_PREFIXES.BACK_TO_SETTINGS);
  return keyboard;
}

/**
 * Builds the top-level settings navigation keyboard.
 *
 * Presents three category buttons — Markets, Timeframes, and Confidence —
 * each on its own row. Pressing a button navigates to the corresponding
 * sub-keyboard where the user can toggle individual options.
 *
 * @returns An InlineKeyboard instance with the main settings menu.
 */
export function buildSettingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📈 Markets", "settings:markets")
    .row()
    .text("⏱ Timeframes", "settings:timeframes")
    .row()
    .text("🎯 Confidence", "settings:confidence");
}
