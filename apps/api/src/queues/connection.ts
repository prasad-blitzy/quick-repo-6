/**
 * Redis Connection Factory for BullMQ Queues — Trading Intelligence API
 *
 * Creates and exports a shared Redis connection configuration used by ALL
 * BullMQ queues and workers. This module was extracted from `queues/index.ts`
 * to break a circular dependency: `index.ts` imports individual queue files,
 * and those queue files need the Redis connection to instantiate their Queue
 * objects. Having both import directions in `index.ts` would create a
 * circular dependency under ESM.
 *
 * Architecture note: BullMQ Queue and Worker instances create their own
 * internal ioredis connections from the provided options. We export a Redis
 * client instance for lifecycle management (event monitoring, graceful
 * shutdown via `quit()`/`disconnect()`) and a plain connection options
 * object for Queue/Worker constructors to avoid ioredis version mismatch
 * issues with `exactOptionalPropertyTypes: true`.
 *
 * CRITICAL: The `maxRetriesPerRequest: null` option is MANDATORY for BullMQ.
 * BullMQ uses blocking Redis commands (BRPOPLPUSH) that can timeout. Without
 * this setting, ioredis throws "Max retries per request exceeded" errors
 * that crash BullMQ workers.
 *
 * @module queues/connection
 * @see {@link https://docs.bullmq.io/guide/connections} BullMQ connections
 */

import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Redis connection event logging
// ---------------------------------------------------------------------------

const logger = createLogger("redis");

// ---------------------------------------------------------------------------
// Parse Redis URL into components
// ---------------------------------------------------------------------------

/**
 * Parse the REDIS_URL into individual connection parameters.
 * Supports standard Redis URL format: redis://[:password@]host[:port][/db]
 */
function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password: string | undefined;
  db: number;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    password: parsed.password || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
  };
}

const redisParams = parseRedisUrl(env.REDIS_URL);

// ---------------------------------------------------------------------------
// Shared Redis Client Instance — Lifecycle Management
// ---------------------------------------------------------------------------

/**
 * Shared ioredis Redis client instance for lifecycle management.
 *
 * Used by `queues/index.ts` for:
 * - Connection event monitoring (connect, error, close)
 * - Graceful shutdown via `quit()` / `disconnect()`
 * - Health check connectivity verification
 *
 * NOT used directly by Queue/Worker constructors (see `connection` below).
 */
export const redisClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ---------------------------------------------------------------------------
// Connection Options for BullMQ Queue/Worker Constructors
// ---------------------------------------------------------------------------

/**
 * Plain connection options object for BullMQ Queue and Worker constructors.
 *
 * BullMQ accepts either an ioredis instance or a RedisOptions config object.
 * Using a plain object avoids type incompatibility between different ioredis
 * versions (the project may hoist a different version than BullMQ's internal
 * dependency), which causes TypeScript errors under `exactOptionalPropertyTypes`.
 *
 * - `maxRetriesPerRequest: null` — MANDATORY for BullMQ. Disables the
 *   per-command retry limit so blocking commands used internally do not
 *   trigger premature failures.
 */
export const connection = {
  host: redisParams.host,
  port: redisParams.port,
  ...(redisParams.password !== undefined ? { password: redisParams.password } : {}),
  ...(redisParams.db !== 0 ? { db: redisParams.db } : {}),
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

// ---------------------------------------------------------------------------
// Connection Event Handlers — Observability
// ---------------------------------------------------------------------------

redisClient.on("connect", () => {
  logger.info("Redis connection established for BullMQ queues");
});

redisClient.on("error", (error: Error) => {
  logger.error({ error }, "Redis connection error");
});

redisClient.on("close", () => {
  logger.warn("Redis connection closed");
});
