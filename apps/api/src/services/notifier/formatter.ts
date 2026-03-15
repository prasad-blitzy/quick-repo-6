/**
 * MarkdownV2 Trade Alert Message Formatter for Telegram
 *
 * Pure utility module that formats trade opportunity data into properly
 * escaped Telegram MarkdownV2 messages with emoji direction indicators,
 * bold text formatting, and inline code blocks for price values.
 *
 * This module has NO side effects, NO database access, and NO external
 * dependencies — it operates solely on the data passed as arguments.
 *
 * @see https://core.telegram.org/bots/api#markdownv2-style
 * @module formatter
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for a single Telegram message (hard API limit). */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Maximum reasoning text length (pre-escaping) before truncation.
 * Escaping at most doubles the character count (every character could be
 * a special character), so 500 raw chars → ≤1000 escaped chars, leaving
 * ample room for the rest of the message template (~300 chars).
 */
const MAX_REASONING_LENGTH = 500;

// ---------------------------------------------------------------------------
// Exported Interface
// ---------------------------------------------------------------------------

/**
 * Input data for formatting a trade alert message.
 *
 * All price and numeric fields are represented as `string` to preserve
 * decimal precision per AAP Rule 0.7.2. Values come directly from
 * PostgreSQL `numeric` columns which Drizzle ORM returns as strings.
 */
export interface TradeAlertData {
  /** Trading symbol, e.g. "AAPL", "BTC", "RELIANCE" */
  symbol: string;

  /** Market identifier from PostgreSQL enum: "us_stock" | "indian_equity" | "crypto" | "social" */
  market: string;

  /** Trade direction from PostgreSQL enum: "long" | "short" */
  direction: string;

  /** Confidence score as decimal string, e.g. "0.85" (numeric(3,2)) */
  confidence: string;

  /** Entry price as decimal string, e.g. "185.5000" (numeric(12,4)) */
  entryPrice: string;

  /** Stop-loss price as decimal string (numeric(12,4)) */
  stopLoss: string;

  /** Take-profit price as decimal string (numeric(12,4)) */
  takeProfit: string;

  /** Trading timeframe from PostgreSQL enum: "intraday" | "swing" | "position" */
  timeframe: string;

  /** LLM-generated reasoning text explaining the trade recommendation */
  reasoning: string;

  /** Risk-reward ratio as decimal string, e.g. "2.50" (numeric(5,2)), or null if not calculated */
  riskRewardRatio: string | null;
}

// ---------------------------------------------------------------------------
// Escaping Utilities
// ---------------------------------------------------------------------------

/**
 * Escapes all Telegram MarkdownV2 special characters in **plain text**.
 *
 * Per the Telegram Bot API MarkdownV2 specification, the following 19
 * characters must be preceded by a backslash (`\`) when they appear in
 * plain text (i.e. outside any formatting entity such as bold, italic,
 * inline code, etc.):
 *
 *   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 *
 * The same escaping is also safe to apply inside bold (`*…*`) and italic
 * (`_…_`) entities — those entities require the same set of characters
 * to be escaped. Do **not** use this function for text inside inline code
 * blocks; use {@link escapeInlineCode} instead.
 *
 * @param text - Raw text to escape for MarkdownV2 plain-text context
 * @returns Escaped text safe for MarkdownV2 outside inline code blocks
 */
export function escapeMarkdownV2(text: string): string {
  // Character class breakdown:
  //   _        underscore
  //   *        asterisk
  //   \[       opening bracket (escaped in regex char class for safety)
  //   \]       closing bracket (must be escaped in regex char class)
  //   (  )     parentheses
  //   ~        tilde
  //   `        backtick
  //   >        greater-than
  //   #        hash
  //   +        plus
  //   =        equals
  //   |        pipe
  //   {  }     braces
  //   .        dot
  //   !        exclamation
  //   \\       backslash (escaped in regex char class)
  //   -        hyphen-minus (placed at the END to avoid range interpretation)
  return text.replace(/[_*\[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

/**
 * Escapes characters for text placed **inside** Telegram MarkdownV2
 * inline code blocks (`` `…` ``).
 *
 * Per the Telegram Bot API specification, inside inline code only
 * two characters need escaping:
 *   - backtick (`` ` ``) — would otherwise close the code span
 *   - backslash (`\`)    — the escape character itself
 *
 * @param text - Raw text to place inside inline-code delimiters
 * @returns Escaped text safe for MarkdownV2 inline code blocks
 */
export function escapeInlineCode(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Private Helpers
// ---------------------------------------------------------------------------

/**
 * Maps internal market enum values to human-readable display names.
 *
 * Falls back to the raw enum value for unknown markets so the message
 * is still useful even if a new market type is added later.
 *
 * @param market - Raw market enum string from the database
 * @returns Human-readable market label
 */
function getMarketDisplayName(market: string): string {
  const marketNames: Record<string, string> = {
    us_stock: "US Stock",
    indian_equity: "Indian Equity",
    crypto: "Crypto",
    social: "Social",
  };
  return marketNames[market] ?? market;
}

/**
 * Maps internal timeframe enum values to human-readable display names.
 *
 * Falls back to the raw enum value for unknown timeframes.
 *
 * @param timeframe - Raw timeframe enum string from the database
 * @returns Human-readable timeframe label
 */
function getTimeframeDisplayName(timeframe: string): string {
  const timeframeNames: Record<string, string> = {
    intraday: "Intraday",
    swing: "Swing",
    position: "Position",
  };
  return timeframeNames[timeframe] ?? timeframe;
}

/**
 * Truncates a string to the specified maximum length, appending an
 * ellipsis (`…`) if truncation occurs. The ellipsis is a single Unicode
 * character so it only adds 1 character, not 3.
 *
 * @param text      - Text to potentially truncate
 * @param maxLength - Maximum character length (pre-escaping)
 * @returns Original text if within limit, or truncated text with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}

// ---------------------------------------------------------------------------
// Primary Formatter
// ---------------------------------------------------------------------------

/**
 * Formats trade opportunity data into a Telegram MarkdownV2 message.
 *
 * Produces a properly escaped message with:
 * - 🟢 / 🔴 emoji indicators for LONG / SHORT direction (AAP Rule 0.7.5)
 * - Bold (`*…*`) formatting for direction label and trading symbol
 * - Inline code (`` `…` ``) blocks for all price values (AAP Rule 0.7.5)
 * - Human-readable market and timeframe labels
 * - Confidence displayed as a percentage
 * - Conditional risk-reward ratio (shown only when not null)
 * - Truncated reasoning to stay within Telegram's 4096-character limit
 *
 * ### Example Output (raw MarkdownV2)
 * ```
 * 🟢 *LONG* — *AAPL*
 * 📊 Market: US Stock
 * 📈 Confidence: 85%
 *
 * 💰 Entry: `185.5000`
 * 🛑 Stop Loss: `180.0000`
 * 🎯 Take Profit: `195.0000`
 * ⚖️ Risk/Reward: `1:2.50`
 *
 * ⏱ Timeframe: Swing
 *
 * 💡 *Reasoning:*
 * Apple reported strong quarterly earnings beating estimates\.\.\.
 * ```
 *
 * @param data - Trade alert data with all numeric fields as strings
 *               for decimal precision (AAP Rule 0.7.2)
 * @returns MarkdownV2-formatted string ready for
 *          `bot.api.sendMessage(chatId, msg, { parse_mode: "MarkdownV2" })`
 */
export function formatTradeAlert(data: TradeAlertData): string {
  // ------------------------------------------------------------------
  // 1. Derive display values
  // ------------------------------------------------------------------

  // Direction emoji: 🟢 for LONG, 🔴 for SHORT (AAP Rule 0.7.5)
  const directionEmoji: string = data.direction === "long" ? "🟢" : "🔴";
  const directionLabel: string = data.direction.toUpperCase();

  // Convert confidence decimal string to integer percentage: "0.85" → 85
  const confidencePercent: number = Math.round(
    parseFloat(data.confidence) * 100,
  );

  // Human-readable display names
  const marketDisplay: string = getMarketDisplayName(data.market);
  const timeframeDisplay: string = getTimeframeDisplayName(data.timeframe);

  // Truncate reasoning to prevent exceeding Telegram's 4096-char limit.
  // Escaping at most doubles the character count, so 500 → ≤1000 escaped.
  const truncatedReasoning: string = truncateText(
    data.reasoning,
    MAX_REASONING_LENGTH,
  );

  // ------------------------------------------------------------------
  // 2. Build message lines with proper MarkdownV2 escaping
  // ------------------------------------------------------------------
  const lines: string[] = [];

  // --- Header: emoji + bold direction + em-dash + bold symbol ----------
  // The em-dash (—, U+2014) is NOT a MarkdownV2 special character so it
  // does not require escaping in plain-text context.
  lines.push(
    `${directionEmoji} *${escapeMarkdownV2(directionLabel)}* — *${escapeMarkdownV2(data.symbol)}*`,
  );

  // --- Info lines (plain text, escaped) --------------------------------
  lines.push(
    `📊 Market: ${escapeMarkdownV2(marketDisplay)}`,
  );
  lines.push(
    `📈 Confidence: ${escapeMarkdownV2(String(confidencePercent) + "%")}`,
  );

  // --- Separator -------------------------------------------------------
  lines.push("");

  // --- Price lines with inline code blocks (AAP Rule 0.7.5) -----------
  // Inside backtick code spans only ` and \ need escaping.
  lines.push(
    `💰 Entry: \`${escapeInlineCode(data.entryPrice)}\``,
  );
  lines.push(
    `🛑 Stop Loss: \`${escapeInlineCode(data.stopLoss)}\``,
  );
  lines.push(
    `🎯 Take Profit: \`${escapeInlineCode(data.takeProfit)}\``,
  );

  // --- Risk-reward ratio (conditional — shown only when available) -----
  if (data.riskRewardRatio !== null) {
    lines.push(
      `⚖️ Risk/Reward: \`1:${escapeInlineCode(data.riskRewardRatio)}\``,
    );
  }

  // --- Separator -------------------------------------------------------
  lines.push("");

  // --- Timeframe (plain text, escaped) ---------------------------------
  lines.push(
    `⏱ Timeframe: ${escapeMarkdownV2(timeframeDisplay)}`,
  );

  // --- Separator -------------------------------------------------------
  lines.push("");

  // --- Reasoning section with bold header ------------------------------
  // "Reasoning:" inside bold uses escapeMarkdownV2 which is safe for bold
  // text as well (same characters need escaping per Telegram spec).
  lines.push(`💡 *${escapeMarkdownV2("Reasoning:")}*`);
  lines.push(escapeMarkdownV2(truncatedReasoning));

  // ------------------------------------------------------------------
  // 3. Assemble and enforce Telegram message length limit
  // ------------------------------------------------------------------
  let message: string = lines.join("\n");

  // Final safety guard: if the fully escaped message somehow exceeds the
  // Telegram hard limit (4096 chars), truncate the entire message. This
  // is a defensive measure — the reasoning pre-truncation should prevent
  // this from ever occurring in practice.
  if (message.length > TELEGRAM_MAX_LENGTH) {
    // Truncate and close with an escaped ellipsis so formatting remains
    // valid. We leave a small margin for the escaped dots.
    const truncated: string = message.slice(0, TELEGRAM_MAX_LENGTH - 4);
    message = truncated + "\\.\\.\\.";
  }

  return message;
}
