/**
 * grammY Bot Initialization and Middleware Setup
 *
 * This is the MAIN ENTRY POINT for the Telegram bot in the Trading Intelligence
 * Application. It creates the grammY `Bot` instance using `TELEGRAM_BOT_TOKEN`
 * from the validated environment configuration, registers all middleware (global
 * error handler), command handlers (`/start`, `/settings`, `/status`), and the
 * callback query handler for inline keyboard interactions.
 *
 * Exports:
 *  - `bot` — The Bot instance, used by:
 *    - `apps/api/src/index.ts` for graceful shutdown via `bot.stop()`
 *    - `apps/api/src/queues/workers/notifications.worker.ts` for sending
 *      trade alerts via `bot.api.sendMessage()`
 *  - `startBot()` — Async function that registers the bot command menu with
 *    Telegram and initiates long polling. Called during application bootstrap
 *    in `apps/api/src/index.ts`.
 *
 * Long polling vs webhook:
 *  Long polling is used for simplicity — it does not require a public HTTPS
 *  endpoint. grammY manages the polling loop internally with automatic
 *  reconnection. For production at extreme scale, webhooks would be more
 *  efficient, but long polling is sufficient for this application's throughput.
 *
 * Error handling strategy:
 *  `bot.catch()` installs a global error boundary that logs all middleware
 *  errors structurally via Pino without re-throwing, keeping the bot alive.
 *  The floating promise from `bot.start()` also has a `.catch()` handler to
 *  prevent unhandled promise rejections from crashing the Node.js process.
 *
 * @module bot/index
 * @see {@link https://grammy.dev/} grammY documentation
 * @see AAP Section 0.5.1 Group 8 — Telegram Bot implementation requirements
 */

import { Bot } from "grammy";

import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { handleStart } from "./commands/start.js";
import { handleSettings } from "./commands/settings.js";
import { handleStatus } from "./commands/status.js";
import { handleCallbackQuery } from "./callbacks.js";

// ---------------------------------------------------------------------------
// Logger — Namespaced child logger for bot lifecycle events
// ---------------------------------------------------------------------------

/**
 * Pino child logger bound with `{ module: "telegram-bot" }` context.
 * Used for structured logging of all bot lifecycle events:
 *  - info: bot startup, successful initialization
 *  - error: middleware errors, long polling failures, shutdown errors
 */
const logger = createLogger("telegram-bot");

// ---------------------------------------------------------------------------
// Bot Instance — Exported for external use (shutdown + message sending)
// ---------------------------------------------------------------------------

/**
 * The grammY Bot instance initialized with the validated Telegram Bot API token,
 * or `null` when `TELEGRAM_BOT_TOKEN` is not configured.
 *
 * When the token is present, this instance is the central communication point
 * with the Telegram Bot API. It is exported as a named export for use by:
 *
 *  - **`apps/api/src/index.ts`** — Calls `stopBot()` during graceful shutdown
 *    to cleanly terminate the long polling loop and allow in-progress handlers
 *    to complete.
 *
 *  - **`apps/api/src/queues/workers/notifications.worker.ts`** — Calls
 *    `bot.api.sendMessage(chatId, text, options)` to deliver MarkdownV2-formatted
 *    trade alert notifications to subscribed Telegram users.
 *
 * When the token is absent (`null`), all bot functionality is gracefully
 * disabled — the REST API, queue processing, and AI pipeline continue
 * operating independently. This decouples API-only deployments from Telegram
 * bot availability.
 *
 * The token is sourced from `env.TELEGRAM_BOT_TOKEN`, which is validated at
 * startup by the Zod schema in `apps/api/src/config/env.ts` (optional,
 * `z.string().min(1).optional()`).
 */
export const bot: Bot | null = env.TELEGRAM_BOT_TOKEN
  ? new Bot(env.TELEGRAM_BOT_TOKEN)
  : null;

// ---------------------------------------------------------------------------
// Handler Registration — Only when bot is initialized (token present)
// ---------------------------------------------------------------------------
// All command handlers, callback query handlers, and the global error boundary
// are registered only when the bot instance exists. When TELEGRAM_BOT_TOKEN is
// not set, no handlers are registered and no Telegram interactions occur.

if (bot) {
  /**
   * grammY's global error boundary.
   * Intercepts all unhandled errors thrown by middleware and logs them
   * structurally using Pino without re-throwing, keeping the bot alive.
   */
  bot.catch((err) => {
    const ctx = err.ctx;
    const error = err.error;
    logger.error(
      {
        update_id: ctx.update.update_id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Bot error occurred",
    );
  });

  // -------------------------------------------------------------------------
  // Command Handler Registration — Ordered by user interaction frequency
  // -------------------------------------------------------------------------

  /**
   * `/start` — User registration command.
   * Creates a new subscriber in the `user_settings` database table with default
   * notification preferences (all markets, 70% confidence, all timeframes).
   * Idempotent — re-running `/start` is safe (ON CONFLICT DO NOTHING).
   */
  bot.command("start", handleStart);

  /**
   * `/settings` — Preference configuration command.
   * Displays the user's current notification preferences and presents an inline
   * keyboard for interactive configuration of markets, timeframes, and confidence
   * threshold.
   */
  bot.command("settings", handleSettings);

  /**
   * `/status` — System health summary command.
   * Queries BullMQ queue job counts and API source health from the database,
   * then sends a MarkdownV2-formatted status report with emoji indicators
   * (🟢 healthy, 🟡 warning, 🔴 down).
   */
  bot.command("status", handleStatus);

  // -------------------------------------------------------------------------
  // Callback Query Handler — Inline keyboard button presses
  // -------------------------------------------------------------------------

  /**
   * Handles ALL inline keyboard callback queries with a data payload.
   *
   * The `"callback_query:data"` filter string matches Telegram callback queries
   * that carry a data field (i.e., button presses from inline keyboards). The
   * handler in `./callbacks.js` parses the callback data prefix and routes to
   * the appropriate sub-handler:
   *  - `market:<id>` → Toggle market preference
   *  - `timeframe:<id>` → Toggle timeframe preference
   *  - `confidence:<val>` → Set confidence threshold
   *  - `settings:markets` → Navigate to market sub-keyboard
   *  - `settings:timeframes` → Navigate to timeframe sub-keyboard
   *  - `settings:confidence` → Navigate to confidence sub-keyboard
   *  - `settings:back` → Navigate back to main settings menu
   */
  bot.on("callback_query:data", handleCallbackQuery);
}

// ---------------------------------------------------------------------------
// Bot Startup Function — Exported for application bootstrap
// ---------------------------------------------------------------------------

/**
 * Registers the bot's command menu with Telegram and starts long polling.
 *
 * This function is called by `apps/api/src/index.ts` during server bootstrap,
 * after Express middleware is configured and database connections are established.
 *
 * Workflow:
 *  1. Logs the startup intent at info level.
 *  2. Calls `bot.api.setMyCommands()` to register the command menu with Telegram.
 *     This makes command descriptions visible when users type `/` in the chat —
 *     Telegram displays a menu of available commands with their descriptions.
 *  3. Calls `bot.start()` to initiate long polling. This call is intentionally
 *     NOT awaited because `bot.start()` returns a Promise that resolves only
 *     when `bot.stop()` is called (i.e., it runs indefinitely). The `.catch()`
 *     handler on the floating promise prevents unhandled promise rejections.
 *  4. The `onStart` callback fires once the bot has successfully connected to
 *     the Telegram API and retrieved its own bot info. It logs the bot's
 *     username and numeric ID for verification.
 *
 * IMPORTANT: `bot.start()` is non-blocking — it initiates the polling loop
 * internally and returns immediately. The bot continues receiving and processing
 * Telegram updates while Express handles HTTP requests on the same Node.js
 * event loop.
 *
 * @returns Resolves once the command menu is registered. Long polling continues
 *          running in the background.
 */
export async function startBot(): Promise<void> {
  // -------------------------------------------------------------------------
  // Guard: Skip bot startup when TELEGRAM_BOT_TOKEN is not configured.
  // This allows the REST API to operate independently of the Telegram bot.
  // -------------------------------------------------------------------------
  if (!bot) {
    logger.warn(
      "TELEGRAM_BOT_TOKEN not set — Telegram bot disabled. " +
        "REST API, queues, and AI pipeline will operate without Telegram notifications.",
    );
    return;
  }

  logger.info("Starting Telegram bot in long polling mode...");

  // -------------------------------------------------------------------------
  // Step 1 — Register command menu with Telegram
  // -------------------------------------------------------------------------
  // This call updates the Telegram client's command suggestion menu that
  // appears when users type "/" in the chat. Three commands are registered:
  //   /start    — User registration
  //   /settings — Notification preference configuration
  //   /status   — System health summary
  await bot.api.setMyCommands([
    { command: "start", description: "Start the bot and register" },
    { command: "settings", description: "Configure notification preferences" },
    { command: "status", description: "View system status" },
  ]);

  // -------------------------------------------------------------------------
  // Step 2 — Start long polling (non-blocking)
  // -------------------------------------------------------------------------
  // `bot.start()` returns a Promise<void> that resolves ONLY when `bot.stop()`
  // is called. We intentionally do NOT await it — the polling loop runs in
  // the background alongside Express.
  //
  // The `.catch()` handler ensures that any fatal error during long polling
  // (e.g., invalid token, network failure that exhausts retries) is logged
  // rather than causing an unhandled promise rejection that would crash the
  // Node.js process.
  //
  // The `onStart` callback fires once grammY has successfully connected to
  // the Telegram Bot API and retrieved the bot's own information via `getMe`.
  // This confirms the bot token is valid and the bot is ready to receive
  // updates.
  bot
    .start({
      onStart: (botInfo) => {
        logger.info(
          { username: botInfo.username, id: botInfo.id },
          "Telegram bot started successfully",
        );
      },
    })
    .catch((error: unknown) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Bot long polling encountered a fatal error",
      );
    });
}

// ---------------------------------------------------------------------------
// Bot Stop Function — Exported for graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Stops the Telegram bot's long polling loop gracefully.
 *
 * When the bot is not initialized (token absent), this function is a no-op.
 * Called by `apps/api/src/index.ts` during the graceful shutdown sequence
 * (SIGTERM / SIGINT handlers).
 */
export function stopBot(): void {
  if (bot) {
    bot.stop();
  }
}
