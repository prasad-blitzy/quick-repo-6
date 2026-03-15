/**
 * Application Entry Point — `apps/api/src/index.ts`
 *
 * Bootstraps the complete Trading Intelligence backend:
 *  1. Express HTTP server with middleware chain
 *  2. REST API routes (news, opportunities, performance, settings, health)
 *  3. Bull Board queue monitoring dashboard at `/admin/queues`
 *  4. BullMQ job queues (news-polling, analysis, notifications)
 *  5. grammY Telegram bot in long polling mode
 *  6. Graceful shutdown handlers for SIGTERM / SIGINT
 *
 * Middleware chain order (per Express best practices):
 *  - `helmet()` — Security headers (FIRST — applied to every response)
 *  - `corsMiddleware` — CORS for frontend origin
 *  - `express.json()` — JSON body parsing (limit 1 MB)
 *  - `express.urlencoded()` — URL-encoded form parsing
 *  - `requestLogger` — pino-http request/response logging
 *  - `apiRouter` — All REST API routes under `/api`
 *  - Bull Board — Queue dashboard at `/admin/queues`
 *  - `errorHandler` — Global error handler (LAST — 4-arg Express error handler)
 *
 * Per AAP §0.5.1 Group 9:
 *   "CREATE: `apps/api/src/index.ts` — Express app bootstrap, middleware
 *    chain, route mounting, bot start, queue initialization"
 *
 * Per AAP §0.4.2:
 *   "Express routes query the PostgreSQL database via Drizzle ORM"
 *   "Bull Board queue dashboard at `/admin/queues`"
 *   "Health checks with dependency status"
 *
 * Per AAP §0.7.1:
 *   TypeScript strict mode — compiles under `strict: true` with no `any`.
 *
 * @module apps/api/src/index
 */

import express, { type Express } from "express";
import helmet from "helmet";

import { env } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/request-logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { apiRouter } from "./routes/index.js";
import { initQueues, closeQueues } from "./queues/index.js";
import { bot, startBot } from "./bot/index.js";
import { closeDatabase } from "./db/index.js";

// ---------------------------------------------------------------------------
// Bull Board — Dynamic imports for ESM compatibility
// ---------------------------------------------------------------------------
// @bull-board packages use CJS exports with ESM wrappers. Import them
// dynamically to ensure correct module resolution under NodeNext.

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

// ---------------------------------------------------------------------------
// Logger — Application lifecycle logger
// ---------------------------------------------------------------------------

/**
 * Child logger scoped to the application entry point.
 * Used for server startup, shutdown, and fatal error logging.
 */
const logger = createLogger("server");

// ---------------------------------------------------------------------------
// Express Application Setup
// ---------------------------------------------------------------------------

/**
 * The Express application instance.
 *
 * The middleware chain is registered in a specific order that follows
 * Express best practices and security recommendations:
 * 1. Security middleware first (helmet, CORS)
 * 2. Body parsers next (JSON, URL-encoded)
 * 3. Request logging middleware
 * 4. Route handlers
 * 5. Error handler last (must be 4-arg for Express to recognize it)
 */
const app: Express = express();

// ---------------------------------------------------------------------------
// Middleware Chain — Registered in strict order
// ---------------------------------------------------------------------------

// 1. Security headers — helmet sets X-Content-Type-Options, X-Frame-Options,
//    Strict-Transport-Security, and other security-critical response headers.
//    Must be FIRST so every response (including error responses) gets secured.
app.use(helmet());

// 2. CORS — Configured for the frontend origin (FRONTEND_URL env var).
//    Handles preflight OPTIONS requests and sets Access-Control-Allow-* headers.
app.use(corsMiddleware);

// 3. JSON body parser — Parses `application/json` request bodies with a 1 MB
//    size limit to prevent denial-of-service from oversized payloads.
app.use(express.json({ limit: "1mb" }));

// 4. URL-encoded body parser — Parses `application/x-www-form-urlencoded`
//    request bodies. `extended: true` allows rich objects and arrays.
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 5. Request/response logging — pino-http logs every request with a unique
//    request ID, method, URL, status code, and response time. Health check
//    requests (`/api/health`) are excluded from logging to reduce noise.
app.use(requestLogger);

// ---------------------------------------------------------------------------
// API Routes — All REST endpoints under /api
// ---------------------------------------------------------------------------

// The apiRouter from `routes/index.ts` mounts all sub-routers under the
// `/api` prefix. No additional prefix is needed here.
app.use(apiRouter);

// ---------------------------------------------------------------------------
// Bull Board — Queue Monitoring Dashboard at /admin/queues
// ---------------------------------------------------------------------------

/**
 * Initializes BullMQ queues and registers the Bull Board Express adapter.
 *
 * `initQueues()` returns the array of all 3 BullMQ Queue instances which
 * are wrapped in `BullMQAdapter` for the Bull Board dashboard.
 *
 * The dashboard is mounted at `/admin/queues` — accessible in development
 * for debugging queue health, job counts, and failed jobs. In production,
 * consider adding authentication middleware before the Bull Board route.
 */
const queues = initQueues();

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: queues.map((q) => new BullMQAdapter(q)),
  serverAdapter,
});

app.use("/admin/queues", serverAdapter.getRouter());

// ---------------------------------------------------------------------------
// Error Handler — MUST be LAST middleware (Express 4-arg error handler)
// ---------------------------------------------------------------------------

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Server Bootstrap — HTTP Listen + Bot Start
// ---------------------------------------------------------------------------

/**
 * Starts the Express HTTP server and the Telegram bot.
 *
 * The server listens on `env.PORT` (default 3000). Once listening, the
 * Telegram bot is started in long polling mode (non-blocking — runs
 * alongside Express on the same event loop).
 *
 * If the bot fails to start (e.g., invalid token), the Express server
 * continues running — bot failure is non-fatal for the REST API.
 */
const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    `Trading Intelligence API server running on port ${env.PORT}`,
  );

  // Start the Telegram bot in the background (non-blocking long polling).
  // Bot startup failures are caught and logged — they do not crash the server.
  startBot().catch((error: unknown) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to start Telegram bot",
    );
  });
});

// ---------------------------------------------------------------------------
// Graceful Shutdown — SIGTERM / SIGINT handlers
// ---------------------------------------------------------------------------

/**
 * Graceful shutdown sequence triggered by SIGTERM (container shutdown) or
 * SIGINT (Ctrl+C in development).
 *
 * Shutdown order:
 * 1. Stop accepting new HTTP connections (server.close)
 * 2. Stop the Telegram bot long polling (bot.stop)
 * 3. Close all BullMQ queues and Redis connection (closeQueues)
 * 4. Close the PostgreSQL connection pool (closeDatabase)
 * 5. Exit the process
 *
 * Each step has independent error handling — a failure in one step does
 * not prevent the remaining steps from executing.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Received shutdown signal, starting graceful shutdown...");

  try {
    // Step 1: Stop accepting new HTTP connections and close existing ones
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    logger.info("HTTP server closed");
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error closing HTTP server",
    );
  }

  try {
    // Step 2: Stop the Telegram bot long polling loop
    bot.stop();
    logger.info("Telegram bot stopped");
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error stopping Telegram bot",
    );
  }

  try {
    // Step 3: Close all BullMQ queues and Redis connection
    await closeQueues();
    logger.info("BullMQ queues and Redis connection closed");
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error closing queues",
    );
  }

  try {
    // Step 4: Close the PostgreSQL connection pool
    await closeDatabase();
    logger.info("Database connections closed");
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error closing database connections",
    );
  }

  logger.info("Graceful shutdown complete");
  process.exit(0);
}

// Register shutdown handlers for both container orchestration (SIGTERM)
// and interactive development (SIGINT / Ctrl+C).
process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(() => process.exit(1));
});

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(() => process.exit(1));
});

// ---------------------------------------------------------------------------
// Unhandled Rejection / Exception Safety Nets
// ---------------------------------------------------------------------------

/**
 * Catches unhandled promise rejections that escape all try/catch blocks.
 * Logs the error structurally and allows the process to continue running.
 *
 * In Node.js 24.x, unhandled rejections throw by default. This handler
 * ensures they are logged before the process potentially terminates.
 */
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(
    { error: reason instanceof Error ? reason.message : String(reason) },
    "Unhandled promise rejection",
  );
});

/**
 * Catches uncaught exceptions from synchronous code paths.
 * Logs the error and initiates graceful shutdown — the process state
 * may be corrupted after an uncaught exception, so continuing is unsafe.
 */
process.on("uncaughtException", (error: Error) => {
  logger.fatal(
    { error: error.message, stack: error.stack },
    "Uncaught exception — initiating shutdown",
  );
  gracefulShutdown("uncaughtException").catch(() => process.exit(1));
});

// ---------------------------------------------------------------------------
// Export for testing
// ---------------------------------------------------------------------------

/**
 * The Express application instance exported for integration testing with
 * supertest. In production, this export is unused — the server is started
 * by the `app.listen()` call above.
 *
 * @example
 * ```typescript
 * import request from "supertest";
 * import { app } from "./index.js";
 *
 * const res = await request(app).get("/api/health");
 * expect(res.status).toBe(200);
 * ```
 */
export { app };
