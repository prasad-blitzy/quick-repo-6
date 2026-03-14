/**
 * User Settings and Notification Preference Type Definitions
 *
 * Types for the Trading Intelligence Application's user preference system.
 * These types map directly to the `user_settings` database table and are
 * consumed by:
 *   - `apps/api/src/bot/commands/` — Telegram bot `/start`, `/settings` handlers
 *   - `apps/api/src/bot/keyboards.ts` — Inline keyboard preference UI
 *   - `apps/api/src/bot/callbacks.ts` — Callback query handlers
 *   - `apps/api/src/services/notifier/index.ts` — Subscriber matching engine
 *   - `apps/api/src/routes/settings.routes.ts` — REST API CRUD
 *   - `apps/web/src/pages/Settings.tsx` — Dashboard settings page
 *
 * Design constraints (AAP Rules):
 * - No `any` type — specific types for every field (Rule 0.7.1)
 * - Array fields for multi-select preferences (markets, timeframes)
 * - Confidence threshold range 0.00–1.00 matching `numeric(3,2)` (Rule 0.7.2)
 * - Telegram chat ID stored as `string` for BigInt compatibility
 * - Nullable fields use `string | null` union, NOT optional `?:` syntax
 * - All date fields use ISO 8601 `string` for JSON serialization, not `Date`
 * - Compiles under TypeScript strict mode with `exactOptionalPropertyTypes`
 * - ESM imports use `.js` extension (Rule 0.7.1)
 *
 * @module @trading-intelligence/types/user
 */

import type { Market } from './news.js';
import type { Timeframe } from './trade.js';

// ---------------------------------------------------------------------------
// UserSettings Interface
// ---------------------------------------------------------------------------

/**
 * Represents a registered user's complete configuration and notification
 * preferences, mapping directly to the `user_settings` database table.
 *
 * A user record is created when the Telegram bot receives the `/start`
 * command from a new user, initialising default preferences (all markets,
 * minConfidence 0.70, all timeframes, isActive true).
 *
 * Key invariants:
 * - `telegramChatId` is unique — one row per Telegram user/chat
 *   (per AAP Section 0.4.3: `(telegram_chat_id)` UNIQUE index).
 * - `isActive` controls whether the user receives any notifications.
 * - `markets` and `timeframes` are stored as PostgreSQL array columns,
 *   enabling efficient subscriber matching queries during notification
 *   dispatch (AAP Rule 0.7.5).
 * - `minConfidence` is a threshold (not a financial price), so `number`
 *   is acceptable (range 0.00–1.00, database `numeric(3,2)`).
 * - `username` is always present in the database row but may be `null`
 *   when the Telegram user has not set a username.
 */
export interface UserSettings {
  /** UUID v4 primary key. */
  id: string;

  /**
   * Telegram chat ID as a string for BigInt compatibility.
   *
   * Telegram chat IDs can be very large integers that exceed
   * JavaScript's `Number.MAX_SAFE_INTEGER`, so they are stored
   * as strings for safety. Has a UNIQUE index in the database
   * for fast subscriber lookup during notification dispatch.
   */
  telegramChatId: string;

  /**
   * Telegram username, or `null` if the user has not set one.
   *
   * This is a nullable field (always present, but may be `null`),
   * NOT an optional field. The distinction matters under
   * `exactOptionalPropertyTypes: true`. Updated on each `/start`
   * or `/settings` interaction with the Telegram bot.
   */
  username: string | null;

  /**
   * Array of markets the user wants trade alerts for.
   *
   * Maps to a PostgreSQL `text[]` column. The notification service
   * compares each trade opportunity's market against this array to
   * determine if the user should receive an alert.
   * An empty array is not expected in normal operation — the `/start`
   * command defaults to all markets.
   */
  markets: Market[];

  /**
   * Minimum confidence threshold for trade alerts (0.00–1.00).
   *
   * Only trade opportunities with `confidence >= minConfidence`
   * trigger a notification for this user. Stored as PostgreSQL
   * `numeric(3,2)`. Default value is 0.70 (70% confidence).
   *
   * This is a threshold score, NOT a financial price, so `number`
   * is appropriate here (AAP Rule 0.7.2 applies only to prices).
   */
  minConfidence: number;

  /**
   * Array of trade timeframes the user is interested in.
   *
   * Maps to a PostgreSQL `text[]` column. The notification service
   * compares each trade opportunity's timeframe against this array
   * to determine if the user should receive an alert.
   */
  timeframes: Timeframe[];

  /**
   * Whether this user is currently active and receiving notifications.
   *
   * Set to `true` when the user registers via `/start`. Can be toggled
   * via `/settings` command or the web dashboard. When `false`, no
   * trade alerts are sent regardless of other preference filters.
   */
  isActive: boolean;

  /** ISO 8601 timestamp of when the user record was created. */
  createdAt: string;

  /** ISO 8601 timestamp of the last user record update. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// NotificationPreference Interface
// ---------------------------------------------------------------------------

/**
 * Lightweight projection of {@link UserSettings} used by the notification
 * matching engine during trade alert dispatch.
 *
 * When a new trade opportunity is generated by the LangGraph analysis
 * pipeline, the notification worker (`apps/api/src/queues/workers/
 * notifications.worker.ts`) queries all active users and uses these
 * fields to determine if a trade opportunity matches their preferences.
 *
 * A notification is sent only when ALL criteria match (AAP Rule 0.7.5):
 * 1. The opportunity's `market` is in the subscriber's `markets` array.
 * 2. The opportunity's `confidence` >= the subscriber's `minConfidence`.
 * 3. The opportunity's `timeframe` is in the subscriber's `timeframes` array.
 *
 * This interface exists separately from UserSettings to provide a minimal
 * data contract for the subscriber matching engine — it omits fields like
 * `id`, `username`, `isActive`, and timestamps that are not needed during
 * the matching process.
 */
export interface NotificationPreference {
  /**
   * Telegram chat ID for sending the alert message.
   *
   * This is the primary delivery target — the grammY bot uses
   * `bot.api.sendMessage(telegramChatId, ...)` to dispatch the
   * formatted MarkdownV2 trade alert.
   */
  telegramChatId: string;

  /**
   * Markets the subscriber wants alerts for.
   *
   * The notification service checks: `preference.markets.includes(opportunity.market)`.
   * Empty array semantics are implementation-defined by the notification service.
   */
  markets: Market[];

  /**
   * Minimum confidence threshold (0.00–1.00).
   *
   * Only opportunities with `confidence >= minConfidence` trigger an alert.
   * Default: 0.70 (70% confidence).
   */
  minConfidence: number;

  /**
   * Trade timeframes the subscriber wants alerts for.
   *
   * The notification service checks: `preference.timeframes.includes(opportunity.timeframe)`.
   * Empty array semantics are implementation-defined by the notification service.
   */
  timeframes: Timeframe[];
}
