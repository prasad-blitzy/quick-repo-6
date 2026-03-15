/**
 * Health Check Route Handler — `GET /api/health`
 *
 * Dependency status check endpoint that tests PostgreSQL connectivity (via
 * `SELECT 1`), Redis connectivity (via `PING`), and external API source
 * status from the `api_sources` table. Returns an overall system status
 * indicator and individual check details with latency measurements.
 *
 * Consumers:
 *  - `apps/web/src/components/HealthIndicator.tsx` — Green/yellow/red dot
 *  - Load balancers and monitoring systems polling for uptime
 *  - `apps/api/src/routes/index.ts` — mounted as `/api/health`
 *
 * Design decisions:
 *  - Each health check (database, Redis, API sources) runs independently
 *    within its own try/catch block. If one dependency is down, the remaining
 *    checks still execute (graceful degradation per AAP Rule 0.7.4).
 *  - Latency is measured in milliseconds for database and Redis checks to
 *    provide operational insight into connection performance.
 *  - The overall status uses a three-tier model:
 *      • `healthy`   — Both DB and Redis up, zero API source errors
 *      • `degraded`  — Partial failures (one infra down or API source errors)
 *      • `unhealthy` — Both DB and Redis are down
 *  - HTTP 200 for healthy/degraded (endpoint is reachable, partial service),
 *    HTTP 503 for unhealthy (critical infrastructure failure).
 *  - This endpoint is excluded from pino-http auto-logging in the request
 *    logger middleware to reduce noise from frequent health check polling.
 *
 * @module routes/health
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { apiSources } from "../db/schema/index.js";
import { createLogger } from "../lib/logger.js";
import { connection } from "../queues/index.js";

// ---------------------------------------------------------------------------
// Logger — Structured logging with module context
// ---------------------------------------------------------------------------

/**
 * Child logger scoped to the health routes module.
 * All log entries include `{ module: "routes:health" }` for structured
 * filtering in log aggregation tools.
 */
const logger = createLogger("routes:health");

// ---------------------------------------------------------------------------
// Router Instance
// ---------------------------------------------------------------------------

/**
 * Express Router instance mounting the `GET /health` endpoint.
 *
 * This router is consumed by `apps/api/src/routes/index.ts` and mounted
 * under the `/api` prefix, making the full endpoint path `/api/health`.
 */
export const healthRouter: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// TypeScript Interfaces — Health Check Response Shape
// ---------------------------------------------------------------------------

/**
 * Represents the health status of an individual infrastructure dependency
 * (database or Redis). Includes optional latency measurement and error
 * description for failed checks.
 */
interface HealthCheck {
  /** Whether the dependency is reachable: `"up"` or `"down"`. */
  status: "up" | "down";
  /** Round-trip latency in milliseconds. Present only when status is `"up"`. */
  latencyMs?: number;
  /** Human-readable error message. Present only when status is `"down"`. */
  error?: string;
}

/**
 * Full health check response returned by the `GET /api/health` endpoint.
 * Includes overall status, individual dependency checks, process uptime,
 * and the current server timestamp.
 */
interface HealthResponse {
  /** Overall system health status derived from individual checks. */
  status: "healthy" | "degraded" | "unhealthy";
  /** Individual health check results for each dependency. */
  checks: {
    /** PostgreSQL database connectivity status. */
    database: HealthCheck;
    /** Redis (BullMQ queue infrastructure) connectivity status. */
    redis: HealthCheck;
    /** External API source registry status from the `api_sources` table. */
    apiSources: {
      /** Total number of registered API sources. */
      total: number;
      /** Number of sources currently enabled (active). */
      enabled: number;
      /** Number of sources with non-zero error counts. */
      errored: number;
    };
  };
  /** Process uptime in seconds (from `process.uptime()`). */
  uptime: number;
  /** Current server timestamp in ISO 8601 format. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// GET /health — Dependency Status Check Endpoint
// ---------------------------------------------------------------------------

/**
 * Health check handler that probes PostgreSQL, Redis, and API source status.
 *
 * The handler runs all three checks independently — a failure in one check
 * does not prevent the others from executing. This ensures the response
 * always provides a complete picture of system health, even when individual
 * dependencies are degraded or offline.
 *
 * Response codes:
 *  - 200 — System is healthy or degraded (at least partially operational)
 *  - 503 — System is unhealthy (both DB and Redis are down)
 */
healthRouter.get(
  "/health",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Initialize all checks with default "down" / zero states.
      // Each check block will update its section independently.
      const checks: HealthResponse["checks"] = {
        database: { status: "down" },
        redis: { status: "down" },
        apiSources: { total: 0, enabled: 0, errored: 0 },
      };

      // -------------------------------------------------------------------
      // Check 1: PostgreSQL Connectivity
      // -------------------------------------------------------------------
      // Executes a lightweight `SELECT 1` query to verify the database
      // connection is alive and responsive. Measures round-trip latency.
      try {
        const dbStart = Date.now();
        await db.execute(sql`SELECT 1`);
        checks.database = {
          status: "up",
          latencyMs: Date.now() - dbStart,
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown database error";
        checks.database = { status: "down", error: message };
        logger.error({ error }, "Database health check failed");
      }

      // -------------------------------------------------------------------
      // Check 2: Redis Connectivity
      // -------------------------------------------------------------------
      // First checks the ioredis connection status property to avoid calling
      // `connection.ping()` on a disconnected/reconnecting client. With
      // `maxRetriesPerRequest: null` (required by BullMQ), ioredis queues
      // commands indefinitely when disconnected — a ping() call would hang
      // and never resolve, making the health endpoint unresponsive.
      //
      // Status values from ioredis:
      //   "ready"        — Connected and ready for commands
      //   "connect"      — TCP connection established, awaiting ready
      //   "reconnecting" — Lost connection, attempting to reconnect
      //   "connecting"   — Initial connection in progress
      //   "close"        — Connection closed (quit() called)
      //   "end"          — Connection destroyed (disconnect() called)
      //   "wait"         — Waiting (lazyConnect mode, not applicable here)
      //
      // Only attempt PING when status is "ready" — all other states indicate
      // the connection is not usable for commands.
      try {
        const redisStatus = connection.status;

        if (redisStatus !== "ready") {
          checks.redis = {
            status: "down",
            error: `Redis connection not ready (status: ${redisStatus})`,
          };
          logger.warn(
            { redisStatus },
            "Redis health check: connection not in ready state",
          );
        } else {
          const redisStart = Date.now();
          await connection.ping();
          checks.redis = {
            status: "up",
            latencyMs: Date.now() - redisStart,
          };
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown Redis error";
        checks.redis = { status: "down", error: message };
        logger.error({ error }, "Redis health check failed");
      }

      // -------------------------------------------------------------------
      // Check 3: API Source Status
      // -------------------------------------------------------------------
      // Queries the `api_sources` table to report how many external data
      // sources are registered, how many are enabled, and how many have
      // accumulated errors. This is a non-critical check — failure only
      // logs an error and leaves defaults (all zeros) in the response.
      try {
        const sources = await db.select().from(apiSources);
        const total = sources.length;
        const enabled = sources.filter(
          (s) => s.isActive === true,
        ).length;
        const errored = sources.filter(
          (s) => s.errorCount > 0,
        ).length;
        checks.apiSources = { total, enabled, errored };
      } catch (error: unknown) {
        logger.error({ error }, "API sources health check failed");
        // Leave apiSources at default zeros — this is a non-critical check.
        // The overall status is determined by database and Redis connectivity.
      }

      // -------------------------------------------------------------------
      // Determine Overall System Status
      // -------------------------------------------------------------------
      // Three-tier status model:
      //  • healthy   — Both DB + Redis up AND zero API source errors
      //  • degraded  — Partial failure (one infra down, or API source errors)
      //  • unhealthy — Both DB and Redis are down (critical failure)
      let overallStatus: HealthResponse["status"];

      if (
        checks.database.status === "up" &&
        checks.redis.status === "up"
      ) {
        // Both infrastructure dependencies are up.
        // Degrade to "degraded" if any API sources have errors.
        overallStatus =
          checks.apiSources.errored > 0 ? "degraded" : "healthy";
      } else if (
        checks.database.status === "up" ||
        checks.redis.status === "up"
      ) {
        // One of the two critical dependencies is down.
        overallStatus = "degraded";
      } else {
        // Both database and Redis are down — system cannot function.
        overallStatus = "unhealthy";
      }

      // -------------------------------------------------------------------
      // Build and Send Response
      // -------------------------------------------------------------------
      const response: HealthResponse = {
        status: overallStatus,
        checks,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };

      // HTTP 200 for healthy/degraded (endpoint is reachable, at least
      // partially operational). HTTP 503 for unhealthy (service unavailable).
      const httpStatus = overallStatus === "unhealthy" ? 503 : 200;

      // Wrap in ApiResponse<HealthStatus> envelope matching the frontend
      // HealthStatus type: { status, postgres: boolean, redis: boolean,
      // lastChecked: string }. The raw `checks` and `uptime` fields are
      // kept in the response body alongside the envelope for backwards
      // compatibility with any consumers that already use the raw shape.
      res.status(httpStatus).json({
        success: true,
        // Top-level status for direct access by health check consumers
        // and integration tests (e.g., body.status === "healthy").
        status: overallStatus,
        data: {
          status: overallStatus,
          postgres: checks.database.status === "up",
          redis: checks.redis.status === "up",
          lastChecked: response.timestamp,
        },
        // Retain detailed check information for advanced consumers
        checks: response.checks,
        uptime: response.uptime,
        timestamp: response.timestamp,
      });
    } catch (error: unknown) {
      // Catch-all for unexpected errors (e.g., serialization failures).
      // Forwards to the global Express error handler middleware.
      next(error);
    }
  },
);
