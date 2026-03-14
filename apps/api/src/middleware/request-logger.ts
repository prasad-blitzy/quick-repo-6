/**
 * HTTP Request/Response Logging Middleware — pino-http Integration
 *
 * Creates and exports a pre-configured `pino-http` middleware instance that
 * automatically logs every HTTP request and response with structured JSON
 * output. Each request receives a unique UUID-based request ID (or reuses an
 * incoming `x-request-id` header for distributed tracing), and downstream
 * route handlers get access to `req.log` — a Pino child logger with the
 * request ID bound as context.
 *
 * Configuration highlights:
 * - **Request IDs**: UUID v4 via `node:crypto.randomUUID()`, falls back to
 *   existing `x-request-id` header for reverse-proxy / distributed tracing.
 * - **Log level mapping**: 2xx/3xx → info, 4xx → warn, 5xx/errors → error.
 * - **Serializers**: Request logs include only `id`, `method`, `url` (headers
 *   and body are stripped to prevent logging sensitive data like auth tokens).
 *   Response logs include only `statusCode`.
 * - **Health check silence**: `/api/health` is excluded from auto-logging to
 *   reduce noise from load balancer probes.
 * - **Root logger**: Uses the application's root Pino logger instance so
 *   pino-http can create per-request child loggers that inherit the global
 *   transport and level configuration.
 *
 * @module middleware/request-logger
 * @see {@link https://github.com/pinojs/pino-http} pino-http v10 documentation
 * @see {@link ../lib/logger.ts} Root Pino logger factory
 */

import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pino from "pino";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Request/Response Serializer Types
// ---------------------------------------------------------------------------

/**
 * Shape of the serialized request object received by the `req` serializer.
 *
 * When `wrapSerializers` is enabled (default in pino-http), the standard
 * pino-std-serializers are applied first, producing this shape before the
 * custom serializer receives it. We explicitly type it to avoid `any`.
 */
interface SerializedReq {
  readonly id?: string | number;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
}

/**
 * Shape of the serialized response object received by the `res` serializer.
 */
interface SerializedRes {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

// ---------------------------------------------------------------------------
// pino-http Middleware Instance
// ---------------------------------------------------------------------------

/**
 * Pre-configured pino-http middleware for Express.
 *
 * Register in the Express middleware chain AFTER `express.json()` and
 * `express.urlencoded()`, and BEFORE route handlers:
 *
 * ```typescript
 * import { requestLogger } from "./middleware/request-logger.js";
 * app.use(requestLogger);
 * ```
 *
 * After this middleware runs, every downstream handler has access to
 * `req.log` — a Pino child logger with the request ID context bound.
 * Route handlers can use `req.log.info({ data }, "message")` for
 * request-scoped structured logging.
 */
export const requestLogger = pinoHttp<IncomingMessage, ServerResponse>({
  /**
   * Root Pino logger instance. pino-http creates per-request child loggers
   * from this root, inheriting its level and transport configuration.
   * MUST be the root logger — not a child logger.
   */
  logger,

  /**
   * Generates or reuses a unique request ID for each incoming HTTP request.
   *
   * Priority:
   * 1. Reuse existing `x-request-id` header (set by reverse proxy or
   *    upstream service for distributed tracing correlation).
   * 2. Generate a new UUID v4 using Node.js built-in `crypto.randomUUID()`.
   *
   * The generated ID is also set as the `x-request-id` response header so
   * callers can correlate their request with server-side log entries.
   */
  genReqId: (req: IncomingMessage, res: ServerResponse) => {
    // Check for an existing request ID from upstream (reverse proxy, gateway)
    const headerValue = req.headers["x-request-id"];
    const existingId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (existingId) {
      return existingId;
    }

    // Generate a new cryptographically random UUID v4
    const id = randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },

  /**
   * Maps HTTP response status codes to Pino log levels:
   *
   * - 2xx / 3xx (success/redirect) → `info`
   * - 4xx (client error)           → `warn`
   * - 5xx (server error) or error  → `error`
   *
   * This ensures that client errors are visible at warning level without
   * cluttering error-level alerts, while server errors always surface at
   * error level for monitoring and alerting pipelines.
   *
   * Return type is explicitly annotated as `pino.LevelWithSilent` to prevent
   * TypeScript from inferring custom levels from the string union, which would
   * create a generic mismatch with the root logger's `Logger<never>` type.
   */
  customLogLevel: (
    _req: IncomingMessage,
    res: ServerResponse,
    err?: Error,
  ): pino.LevelWithSilent => {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      return "warn";
    }
    if (res.statusCode >= 500 || err) {
      return "error";
    }
    return "info";
  },

  /**
   * Custom serializers that strip sensitive data from request/response logs.
   *
   * - Request: Only includes `id`, `method`, `url`. Headers (which may
   *   contain Authorization tokens, cookies, API keys) and body (which may
   *   contain PII or credentials) are explicitly excluded.
   * - Response: Only includes `statusCode`. Response headers and body are
   *   excluded for compactness and security.
   */
  serializers: {
    req(raw: SerializedReq) {
      return {
        id: raw.id,
        method: raw.method,
        url: raw.url,
      };
    },
    res(raw: SerializedRes) {
      return {
        statusCode: raw.statusCode,
      };
    },
  },

  /**
   * Human-readable success message format for completed requests.
   * Includes HTTP method, URL, and status code for quick log scanning.
   */
  customSuccessMessage: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    return `${req.method ?? "UNKNOWN"} ${req.url ?? "/"} completed with ${String(res.statusCode)}`;
  },

  /**
   * Human-readable error message format for failed requests.
   * Includes HTTP method, URL, and status code for quick log scanning.
   */
  customErrorMessage: (
    req: IncomingMessage,
    res: ServerResponse,
    _error: Error,
  ) => {
    return `${req.method ?? "UNKNOWN"} ${req.url ?? "/"} errored with ${String(res.statusCode)}`;
  },

  /**
   * Auto-logging configuration with health check endpoint exclusion.
   *
   * Health check endpoints (`/api/health`) are polled frequently by load
   * balancers, Kubernetes probes, and monitoring tools. Logging every probe
   * creates excessive noise that buries meaningful application logs.
   * Excluding them keeps logs focused on real application traffic.
   */
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === "/api/health",
  },
});
