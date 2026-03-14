/**
 * User Settings and Notification Preference Type Definitions
 *
 * Types for the Trading Intelligence Application's user preference system.
 * These types map directly to the `user_settings` database table and are
 * consumed by:
 *   - `apps/api/src/bot/commands/` (Telegram bot /start, /settings handlers)
 *   - `apps/api/src/bot/keyboards.ts` (inline keyboard preference UI)
 *   - `apps/api/src/bot/callbacks.ts` (callback query handlers)
 *   - `apps/api/src/services/notifier/index.ts` (subscriber matching engine)
 *   - `apps/api/src/routes/settings.routes.ts` (REST API CRUD)
 *   - `apps/web/src/pages/Settings.tsx` (dashboard settings page)
 *
 * Design constraints (AAP Rules):
 * - No `any` type — `unknown` used for flexible fields (Rule 0.7.1)
 * - Array fields for multi-select preferences (markets, timeframes)
 * - Confidence threshold range 0.00–1.00 matching `numeric(3,2)` (Rule 0.7.2)
 * - Telegram chat ID stored as `string` for BigInt compatibility
 * - All date fields use ISO 8601 `string` for JSON serialization
 * - Compiles under TypeScript strict mode with `exactOptionalPropertyTypes`
 */

import type { Market } from './news.js';
import type { Timeframe } from './trade.js';

// ---------------------------------------------------------------------------
// NotificationPreference Interface
// ---------------------------------------------------------------------------

/**
 * Encapsulates the filter criteria that determine which trade alerts a user
 * receives via Telegram.
 *
 * When a new trade opportunity is generated, the notification service
 * (`apps/api/src/services/notifier/index.ts`) compares each subscriber's
 * preferences against the opportunity attributes. A notification is sent
 * only when ALL criteria match (AAP Rule 0.7.5):
 *
 * - The opportunity's `market` is in the user's `markets` array
 * - The opportunity's `confidence` >= the user's `minConfidence`
 * - The opportunity's `timeframe` is in the user's `timeframes` array
 */
export interface NotificationPreference {
  /**
   * Markets the user wants alerts for.
   * Empty array means no market filter (receive all markets).
   */
  markets: Market[];

  /**
   * Minimum confidence threshold (0.00–1.00).
   * Only opportunities with `confidence >= minConfidence` trigger alerts.
   * Default: `0.7` (70% confidence).
   */
  minConfidence: number;

  /**
   * Trade timeframes the user wants alerts for.
   * Empty array means no timeframe filter (receive all timeframes).
   */
  timeframes: Timeframe[];
}

// ---------------------------------------------------------------------------
// UserSettings Interface
// ---------------------------------------------------------------------------

/**
 * Represents a registered user's configuration and notification preferences.
 *
 * Maps directly to the `user_settings` database table. A user record is
 * created when the Telegram bot receives the `/start` command from a new
 * user, initialising default preferences.
 *
 * Key invariants:
 * - `telegramChatId` is unique — one row per Telegram user/chat
 * - `isActive` controls whether the user receives any notifications
 * - `preferences` is stored as PostgreSQL `jsonb`
 * - Default preferences: all markets, minConfidence 0.7, all timeframes
 */
export interface UserSettings {
  /** UUID v4 primary key. */
  id: string;

  /**
   * Telegram chat ID as a string for BigInt compatibility.
   * Unique constraint in the database — one user per chat.
   * Used for fast subscriber lookup during notification dispatch.
   */
  telegramChatId: string;

  /**
   * Telegram display name (first_name or username).
   * Updated on each `/start` or `/settings` interaction.
   */
  username: string;

  /** Whether this user is currently active and receiving notifications. */
  isActive: boolean;

  /**
   * Notification filter preferences controlling which trade alerts
   * are sent to this user. Stored as PostgreSQL `jsonb`.
   */
  preferences: NotificationPreference;

  /** ISO 8601 timestamp of when the user record was created. */
  createdAt: string;

  /** ISO 8601 timestamp of the last user record update. */
  updatedAt: string;
}
