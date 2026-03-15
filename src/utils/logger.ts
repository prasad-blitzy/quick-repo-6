/**
 * src/utils/logger.ts — Structured Logging Utility
 *
 * Provides a structured logging system for the GMGN Signal Bot Chrome Extension
 * with support for log levels, context tags, production no-ops, and optional
 * forwarding to the service worker for aggregated logging.
 *
 * Works in all three Chrome Extension contexts:
 * - Service worker (background.ts): Direct console logging
 * - Content script (content.ts): Console logging + optional service worker forwarding
 * - Page context (injected.ts): Console logging only (chrome.runtime unavailable)
 *
 * Per AAP Section 0.5.1 Group 12:
 * "Structured logging utility; log levels (DEBUG, INFO, WARN, ERROR);
 *  context tags for source identification (e.g., [signal-engine], [birdeye-api]);
 *  no-op in production builds; optional forwarding to service worker for
 *  aggregated logging"
 *
 * @module utils/logger
 */

// ---------------------------------------------------------------------------
// Log Level Enum
// ---------------------------------------------------------------------------

/**
 * Enumeration of log severity levels.
 *
 * Numeric values enable comparison-based filtering — a logger configured at
 * level WARN will emit WARN and ERROR messages but suppress DEBUG and INFO.
 *
 * @example
 * ```typescript
 * const engineLogger = createLogger('signal-engine', { level: LogLevel.WARN });
 * engineLogger.debug('this is suppressed');  // no output
 * engineLogger.warn('this is shown');         // output
 * ```
 */
export enum LogLevel {
  /** Detailed diagnostic information for development debugging */
  DEBUG = 0,
  /** General operational information about normal application flow */
  INFO = 1,
  /** Potentially harmful situations that deserve attention */
  WARN = 2,
  /** Error events that might still allow the application to continue */
  ERROR = 3,
}

// ---------------------------------------------------------------------------
// Logger Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Configuration options for a Logger instance.
 *
 * @property level - Minimum log level for this logger. Messages below this
 *   level are silently suppressed. Defaults to DEBUG in development, WARN in
 *   production.
 * @property context - Context tag string used in log prefixes for source
 *   identification (e.g., 'signal-engine', 'birdeye-api', 'websocket').
 * @property forwardToBackground - When true, log messages are also forwarded
 *   to the service worker via chrome.runtime.sendMessage for aggregated
 *   logging. Only effective when chrome.runtime is available (content scripts).
 *   Defaults to false.
 */
export interface LoggerConfig {
  level: LogLevel;
  context: string;
  forwardToBackground: boolean;
}

// ---------------------------------------------------------------------------
// Logger Interface
// ---------------------------------------------------------------------------

/**
 * Interface for a structured logger instance.
 *
 * Each method accepts a message string and optional additional data arguments
 * that are passed through to the underlying console method for structured
 * inspection in DevTools.
 */
export interface Logger {
  /**
   * Log a DEBUG-level message. Suppressed in production builds.
   * @param message - Primary log message string
   * @param data - Additional data to log (objects, arrays, errors, etc.)
   */
  debug(message: string, ...data: unknown[]): void;

  /**
   * Log an INFO-level message. Suppressed in production builds.
   * @param message - Primary log message string
   * @param data - Additional data to log
   */
  info(message: string, ...data: unknown[]): void;

  /**
   * Log a WARN-level message. Always active, even in production.
   * @param message - Primary log message string
   * @param data - Additional data to log
   */
  warn(message: string, ...data: unknown[]): void;

  /**
   * Log an ERROR-level message. Always active, even in production.
   * @param message - Primary log message string
   * @param data - Additional data to log
   */
  error(message: string, ...data: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Determines whether the current build is a production build.
 *
 * Uses Vite/WXT's `import.meta.env.PROD` flag which is statically replaced
 * at build time. Falls back to `import.meta.env.MODE === 'production'` for
 * additional safety. If neither is available (e.g., raw Node.js test
 * environment), returns false (development mode assumed).
 */
function isProduction(): boolean {
  try {
    // Vite/WXT statically replaces import.meta.env.PROD at build time
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      if (import.meta.env.PROD === true) {
        return true;
      }
      if (import.meta.env.MODE === 'production') {
        return true;
      }
    }
  } catch {
    // import.meta may not be available in all environments during testing
  }
  return false;
}

/**
 * Checks whether `chrome.runtime.sendMessage` is available in the current
 * execution context.
 *
 * Returns false in:
 * - Page context (injected script) where chrome.runtime does not exist
 * - Invalidated extension contexts (after extension update/uninstall)
 * - Environments without the Chrome Extension API (e.g., plain Node.js)
 */
function isChromeRuntimeAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      chrome !== null &&
      typeof chrome.runtime !== 'undefined' &&
      chrome.runtime !== null &&
      typeof chrome.runtime.sendMessage === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Formats a log level into its human-readable string label.
 *
 * @param level - The LogLevel enum value
 * @returns Uppercase string label (e.g., 'DEBUG', 'INFO', 'WARN', 'ERROR')
 */
function levelToString(level: LogLevel): string {
  switch (level) {
    case LogLevel.DEBUG:
      return 'DEBUG';
    case LogLevel.INFO:
      return 'INFO';
    case LogLevel.WARN:
      return 'WARN';
    case LogLevel.ERROR:
      return 'ERROR';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Builds the formatted log prefix string containing timestamp, level, and
 * context tag.
 *
 * Format: `[ISO-8601] [LEVEL] [context]`
 * Example: `[2026-03-13T12:00:00.000Z] [INFO] [signal-engine]`
 *
 * @param level - The log severity level
 * @param context - The logger's context tag (e.g., 'signal-engine')
 * @returns Formatted prefix string
 */
function buildPrefix(level: LogLevel, context: string): string {
  const timestamp = new Date().toISOString();
  const levelStr = levelToString(level);
  return `[${timestamp}] [${levelStr}] [${context}]`;
}

/**
 * Forwards a log message to the service worker via chrome.runtime.sendMessage.
 *
 * Sends a LOG_FORWARD message matching the discriminated union message type
 * defined in src/utils/messaging.ts. Errors are silently caught to prevent
 * logging failures from disrupting application logic.
 *
 * @param level - The log severity level
 * @param context - The logger's context tag
 * @param message - The log message string
 * @param data - Optional additional data arguments
 */
function forwardToServiceWorker(
  level: LogLevel,
  context: string,
  message: string,
  data: unknown[],
): void {
  if (!isChromeRuntimeAvailable()) {
    return;
  }

  try {
    // Serialize data safely — some data may not be serializable
    const safeData = data.length > 0 ? safeSerialize(data) : undefined;

    chrome.runtime.sendMessage({
      type: 'LOG_FORWARD',
      payload: {
        level: levelToString(level),
        context,
        message,
        data: safeData,
      },
    }).catch(() => {
      // Silently ignore forwarding failures — the service worker may be
      // inactive or the extension context may be invalidated.
    });
  } catch {
    // Silently ignore any synchronous errors (e.g., extension context invalidated)
  }
}

/**
 * Safely serializes data for transmission via chrome.runtime.sendMessage.
 *
 * Handles non-serializable values (functions, circular references, Errors)
 * by converting them to string representations.
 *
 * @param data - Array of data items to serialize
 * @returns Serialized array safe for structured cloning
 */
function safeSerialize(data: unknown[]): unknown[] {
  return data.map((item) => {
    if (item === null || item === undefined) {
      return item;
    }
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (typeof item === 'function') {
      return `[Function: ${item.name || 'anonymous'}]`;
    }
    if (typeof item === 'symbol') {
      return item.toString();
    }
    if (typeof item === 'bigint') {
      return item.toString();
    }
    // For objects, attempt a safe clone check by catching circular refs
    if (typeof item === 'object') {
      try {
        // Verify the object is structured-clone-safe by trying JSON round-trip
        JSON.stringify(item);
        return item;
      } catch {
        return String(item);
      }
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Logger Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new Logger instance with the specified context tag and options.
 *
 * Each logger instance prefixes all messages with a structured format:
 * `[ISO-8601] [LEVEL] [context] message`
 *
 * In production builds (detected via `import.meta.env.PROD`), the `debug()`
 * and `info()` methods become no-ops to prevent console flooding in end-user
 * browsers. The `warn()` and `error()` methods always remain active to ensure
 * critical issues are visible.
 *
 * @param context - Context tag for source identification (e.g., 'signal-engine',
 *   'birdeye-api', 'websocket', 'content-script')
 * @param options - Optional partial configuration overrides. Unspecified fields
 *   use sensible defaults (level: DEBUG in dev / WARN in prod,
 *   forwardToBackground: false)
 * @returns A Logger instance with debug, info, warn, and error methods
 *
 * @example
 * ```typescript
 * // Module-specific logger
 * const log = createLogger('signal-engine');
 * log.info('Token scored', { mint: 'ABC123', score: 85 });
 * // Output: [2026-03-13T12:00:00.000Z] [INFO] [signal-engine] Token scored { mint: 'ABC123', score: 85 }
 *
 * // With forwarding to service worker
 * const contentLog = createLogger('content-script', { forwardToBackground: true });
 * contentLog.warn('Connection lost');
 * // Logs to console AND forwards to service worker
 * ```
 */
export function createLogger(
  context: string,
  options?: Partial<LoggerConfig>,
): Logger {
  const isProd = isProduction();

  const config: LoggerConfig = {
    level: options?.level ?? (isProd ? LogLevel.WARN : LogLevel.DEBUG),
    context: options?.context ?? context,
    forwardToBackground: options?.forwardToBackground ?? false,
  };

  /**
   * Internal log handler shared by all severity methods.
   *
   * @param level - Target log level for this message
   * @param consoleFn - The console method to invoke (console.debug/info/warn/error)
   * @param message - The log message string
   * @param data - Additional data arguments
   */
  function log(
    level: LogLevel,
    consoleFn: (...args: unknown[]) => void,
    message: string,
    data: unknown[],
  ): void {
    // Production no-op: suppress DEBUG and INFO in production builds
    if (isProd && level < LogLevel.WARN) {
      return;
    }

    // Level-based filtering: suppress messages below configured minimum level
    if (level < config.level) {
      return;
    }

    const prefix = buildPrefix(level, config.context);

    // Invoke the appropriate console method with prefix + message + data
    if (data.length > 0) {
      consoleFn(`${prefix} ${message}`, ...data);
    } else {
      consoleFn(`${prefix} ${message}`);
    }

    // Optionally forward to service worker for aggregated logging
    if (config.forwardToBackground) {
      forwardToServiceWorker(level, config.context, message, data);
    }
  }

  return {
    debug(message: string, ...data: unknown[]): void {
      log(LogLevel.DEBUG, console.debug, message, data);
    },

    info(message: string, ...data: unknown[]): void {
      log(LogLevel.INFO, console.info, message, data);
    },

    warn(message: string, ...data: unknown[]): void {
      log(LogLevel.WARN, console.warn, message, data);
    },

    error(message: string, ...data: unknown[]): void {
      log(LogLevel.ERROR, console.error, message, data);
    },
  };
}

// ---------------------------------------------------------------------------
// Default Logger Instance
// ---------------------------------------------------------------------------

/**
 * Pre-configured default logger for general application use.
 *
 * Uses the 'app' context tag with default configuration:
 * - Level: DEBUG in development, WARN in production
 * - Forward to background: disabled
 *
 * Import this for quick logging without creating a dedicated logger:
 * ```typescript
 * import { logger } from '@/utils/logger';
 * logger.info('Application initialized');
 * ```
 *
 * For module-specific logging, prefer creating a dedicated logger via
 * `createLogger('your-module-name')` for better source identification.
 */
export const logger: Logger = createLogger('app');
