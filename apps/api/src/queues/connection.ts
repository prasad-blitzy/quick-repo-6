/**
 * Redis Connection Factory for BullMQ Queues — Trading Intelligence API
 *
 * Creates and exports a shared ioredis Redis connection instance used by ALL
 * BullMQ queues and workers throughout the application. This module was
 * intentionally extracted from `queues/index.ts` to **break a circular
 * dependency**: `index.ts` imports individual queue definition files
 * (news-polling, analysis, notifications), and those queue files need the
 * Redis connection to construct their `Queue` instances. Having both import
 * directions in a single file would create a circular dependency under ESM.
 *
 * CRITICAL — BullMQ Connection Requirements:
 * - `maxRetriesPerRequest: null` is **MANDATORY** for BullMQ. BullMQ uses
 *   blocking Redis commands (BRPOPLPUSH / XREADGROUP) that can timeout.
 *   Without disabling the per-request retry limit, ioredis throws
 *   "Max retries per request exceeded" errors that crash BullMQ workers.
 * - `enableReadyCheck: false` skips the Redis READY handshake for faster
 *   connection establishment — an optional optimization.
 *
 * Connection lifecycle events (connect, error, close) are logged via a
 * Pino child logger with `{ module: "redis" }` context for structured
 * observability.
 *
 * @module queues/connection
 * @see {@link https://docs.bullmq.io/guide/connections} BullMQ Connection Docs
 * @see {@link https://github.com/redis/ioredis} ioredis Documentation
 */

import { Redis as IORedis } from "ioredis";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Redis connection observability
// ---------------------------------------------------------------------------

/**
 * Child logger scoped to the Redis connection module.
 * All log entries include `{ module: "redis" }` for structured filtering.
 */
const logger = createLogger("redis");

// ---------------------------------------------------------------------------
// Shared Redis Connection Instance
// ---------------------------------------------------------------------------

/**
 * Shared ioredis connection instance for all BullMQ queues and workers.
 *
 * This single connection is passed to every `Queue` and `Worker` constructor
 * via BullMQ's `connection` option. BullMQ internally creates additional
 * connections as needed (e.g., one for blocking commands per worker), but
 * shares this instance for non-blocking operations and metadata commands.
 *
 * Configuration:
 * - **URL**: Sourced from `env.REDIS_URL` (Zod-validated, defaults to
 *   `"redis://localhost:6379"` for local Docker Redis 7 development).
 * - **maxRetriesPerRequest: null**: Disables ioredis per-command retry limit.
 *   MANDATORY for BullMQ — blocking commands have no natural retry ceiling.
 * - **enableReadyCheck: false**: Skips the Redis READY check for faster
 *   initial connection. Safe for BullMQ which handles its own readiness.
 *
 * Exposed lifecycle methods:
 * - `on(event, handler)` — Attach event listeners (connect, error, close, etc.)
 * - `quit()` — Graceful shutdown: waits for pending commands then disconnects
 * - `disconnect()` — Immediate disconnect without waiting for pending commands
 */
export const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ---------------------------------------------------------------------------
// Connection Event Handlers — Observability
// ---------------------------------------------------------------------------

/**
 * Log successful Redis connection establishment.
 * Fires when the ioredis client connects to the Redis server.
 */
connection.on("connect", () => {
  logger.info("Redis connection established for BullMQ queues");
});

/**
 * Log Redis connection errors with full error context.
 * Fires on socket errors, authentication failures, or protocol errors.
 * ioredis automatically reconnects by default; this handler provides
 * observability into transient connection issues.
 */
connection.on("error", (error: Error) => {
  logger.error({ error }, "Redis connection error");
});

/**
 * Log Redis connection closure.
 * Fires when the connection is closed (either by `quit()`, `disconnect()`,
 * or an unexpected server-side disconnection). Logged as a warning since
 * unexpected closures may indicate infrastructure issues.
 */
connection.on("close", () => {
  logger.warn("Redis connection closed");
});
