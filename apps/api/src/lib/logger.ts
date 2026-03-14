/**
 * Pino Logger Factory — Foundational Logging Module
 *
 * Creates a root Pino v10 structured logger instance and exports a
 * `createLogger(name)` factory function that produces child loggers with
 * `{ module: name }` context binding. Every backend module imports this file
 * to create its own namespaced child logger.
 *
 * Behavior by environment:
 * - **Production**: Structured JSON output to stdout (no transport), consumed
 *   by log aggregation tools (ELK, Datadog, CloudWatch).
 * - **Development**: Human-readable colorized output via `pino-pretty`
 *   worker-thread transport (non-blocking formatting).
 * - **Test**: Structured JSON to stdout at the configured level.
 *
 * Log levels (Pino numeric values):
 *   fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10
 *
 * @module lib/logger
 * @see {@link https://github.com/pinojs/pino} Pino v10 documentation
 */

import pino, { type Logger } from "pino";
import { env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Transport Configuration — Development vs Production
// ---------------------------------------------------------------------------

/**
 * Whether the application is running in development mode.
 * Controls pino-pretty transport activation and other dev-only behaviors.
 */
const isDev: boolean = env.NODE_ENV === "development";

/**
 * Pino transport stream configured for the current environment.
 *
 * - In development: Uses `pino.transport()` to load `pino-pretty` in a
 *   dedicated worker thread, preventing log formatting from blocking the
 *   main event loop. Options configure colorized output with system-locale
 *   timestamps and suppressed `pid`/`hostname` fields for cleaner dev output.
 *
 * - In production/test: `undefined` — Pino writes structured JSON directly
 *   to stdout with zero overhead, which is the correct behavior for
 *   production environments where logs are consumed by aggregation pipelines.
 *
 * NOTE: `pino-pretty` is a devDependency and is never loaded in production.
 * The dynamic `pino.transport({ target: "pino-pretty" })` call ensures the
 * module is only resolved when explicitly requested in development mode.
 */
const transport = isDev
  ? pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    })
  : undefined;

// ---------------------------------------------------------------------------
// Root Logger Instance
// ---------------------------------------------------------------------------

/**
 * Root Pino logger instance configured with environment-driven log level
 * and optional development transport.
 *
 * The `level` property controls the minimum severity that gets logged.
 * Pino silently drops all log calls below the configured level for maximum
 * performance — there is zero serialization cost for suppressed levels.
 *
 * When `transport` is `undefined` (production), Pino uses its default stdout
 * destination with JSON serialization. When a transport stream is provided
 * (development), log entries are piped to the worker-thread formatter.
 */
const rootLogger: Logger = pino(
  {
    level: env.LOG_LEVEL,
  },
  transport,
);

// ---------------------------------------------------------------------------
// Factory Function — Child Logger Creation
// ---------------------------------------------------------------------------

/**
 * Creates a namespaced child logger bound with `{ module: name }` context.
 *
 * Child loggers inherit the root logger's level and transport configuration.
 * The `module` field is automatically included in every log entry produced
 * by the returned child logger, enabling structured filtering by component
 * in log aggregation tools.
 *
 * Pino child loggers are extremely lightweight — they share the parent's
 * serializers, transport, and internal state. Creating one per module has
 * negligible runtime overhead.
 *
 * @param name — Module identifier that appears as `"module"` in log entries.
 *               Convention: lowercase kebab-case (e.g., `"news-fetcher"`,
 *               `"telegram-bot"`, `"worker:analysis"`).
 * @returns A Pino Logger instance bound with `{ module: name }`.
 *
 * @example
 * ```typescript
 * import { createLogger } from "../lib/logger.js";
 *
 * const log = createLogger("finnhub");
 * log.info({ category: "general" }, "Fetching news");
 * // Production output:
 * // {"level":30,"time":1710316205000,"module":"finnhub","category":"general","msg":"Fetching news"}
 * ```
 */
export function createLogger(name: string): Logger {
  return rootLogger.child({ module: name });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Root logger instance exported for direct use where a child logger is not
 * appropriate — specifically for `pino-http` middleware configuration, which
 * requires the root logger instance rather than a child.
 *
 * For all other use cases, prefer `createLogger(name)` to get a namespaced
 * child logger with structured `module` context.
 */
export { rootLogger as logger };

/**
 * Re-exported Pino Logger type for consumers that need to annotate their
 * logger variables with the correct type.
 *
 * @example
 * ```typescript
 * import { createLogger, type Logger } from "../lib/logger.js";
 *
 * class MyService {
 *   private readonly log: Logger;
 *   constructor() {
 *     this.log = createLogger("my-service");
 *   }
 * }
 * ```
 */
export type { Logger };
