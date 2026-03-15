/**
 * Global Express Error Handling Middleware
 *
 * Catches all unhandled errors from Express route handlers and middleware,
 * classifies them by type, logs them via Pino structured logging, and
 * returns consistent JSON error responses to the client.
 *
 * Error classification hierarchy (most specific first):
 * 1. ZodError        → 400 Bad Request  (VALIDATION_ERROR)
 * 2. Database errors  → 500 Internal     (DATABASE_ERROR)
 * 3. HTTP errors      → Custom status    (HTTP_ERROR)
 * 4. Generic errors   → 500 Internal     (INTERNAL_ERROR)
 *
 * CRITICAL: This middleware MUST be the LAST `app.use()` call in the
 * Express middleware chain. Express identifies error handlers by their
 * 4-argument function signature `(err, req, res, next)`.
 *
 * @module middleware/error-handler
 */

import type {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
} from "express";
import { ZodError } from "zod";
import { createLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger Instance
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "error-handler" }` context.
 * All log entries produced by this middleware include the module field,
 * enabling structured filtering in log aggregation tools.
 */
const logger = createLogger("error-handler");

// ---------------------------------------------------------------------------
// Error Response Interface
// ---------------------------------------------------------------------------

/**
 * Consistent shape for all JSON error responses returned by the API.
 *
 * - `message`: Human-readable error description (generic in production)
 * - `code`:    Machine-readable error code for client-side error handling
 * - `details`: Additional context — included ONLY for validation errors;
 *              NEVER included for database or internal errors (security)
 */
interface ErrorResponse {
  error: {
    message: string;
    code: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Type Guard Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether a value is a non-null object.
 * Used as the foundation for duck-type detection of database errors
 * and custom HTTP errors where the specific class is unknown.
 *
 * @param value - The value to check
 * @returns `true` if value is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Detects PostgreSQL / Drizzle ORM database errors via duck-typing.
 *
 * PostgreSQL errors propagated through the `pg` driver (and surfaced
 * by Drizzle ORM) carry a `code` property containing a 5-character
 * SQLSTATE error code that always starts with a digit.
 *
 * Common PostgreSQL error codes:
 * - `"23505"` — unique_violation (e.g., duplicate URL in news_articles)
 * - `"23503"` — foreign_key_violation
 * - `"42P01"` — undefined_table
 * - `"42703"` — undefined_column
 *
 * This approach avoids importing Drizzle internals, keeping the error
 * handler loosely coupled to the ORM layer.
 *
 * @param err - The error value to inspect
 * @returns `true` if the error looks like a PostgreSQL database error
 */
function isDatabaseError(err: unknown): boolean {
  if (!isRecord(err)) {
    return false;
  }
  const code: unknown = err["code"];
  return typeof code === "string" && /^\d/.test(code);
}

/**
 * Extracts an HTTP status code from an error object if one is present.
 *
 * Many HTTP error libraries (http-errors, Express itself, custom errors)
 * attach a numeric `statusCode` or `status` property to error objects.
 * This function checks both conventions and returns the first valid
 * numeric status code found.
 *
 * @param err - The error value to inspect
 * @returns The numeric HTTP status code, or `undefined` if none found
 */
function getHttpStatusCode(err: unknown): number | undefined {
  if (!isRecord(err)) {
    return undefined;
  }

  const statusCode: unknown = err["statusCode"];
  if (typeof statusCode === "number" && statusCode >= 100 && statusCode < 600) {
    return statusCode;
  }

  const status: unknown = err["status"];
  if (typeof status === "number" && status >= 100 && status < 600) {
    return status;
  }

  return undefined;
}

/**
 * Safely extracts a human-readable error message from an unknown error value.
 *
 * Handles Error instances, plain strings, and falls back to a generic
 * message for values that don't carry a recognizable message.
 *
 * @param err - The error value to extract a message from
 * @returns A string error message
 */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "An unexpected error occurred";
}

// ---------------------------------------------------------------------------
// Error Handler Middleware
// ---------------------------------------------------------------------------

/**
 * Global Express error handling middleware.
 *
 * MUST be registered as the LAST middleware via `app.use(errorHandler)`
 * after all route handlers and other middleware. Express identifies this
 * as an error handler by its 4-argument function signature.
 *
 * Classification order (most specific → least specific):
 *
 * 1. **ZodError** → 400 with `VALIDATION_ERROR` code and `err.flatten()`
 *    field-level details. Logged at `warn` level (client errors are not
 *    server faults).
 *
 * 2. **Database errors** → 500 with `DATABASE_ERROR` code. Detected via
 *    duck-typing (PostgreSQL SQLSTATE codes start with a digit). Internal
 *    details are logged but NEVER sent to the client.
 *
 * 3. **Custom HTTP errors** → Uses the `statusCode` or `status` property
 *    from the error object. Logged at `warn` for 4xx, `error` for 5xx.
 *
 * 4. **Generic errors** → 500 with `INTERNAL_ERROR` code. In development
 *    mode, the error message is included in the response for debugging.
 *    In production, only a generic message is returned.
 *
 * Safety guarantees:
 * - Checks `res.headersSent` before writing — delegates to Express
 *   default handler if headers are already in flight
 * - Wrapped in try/catch — the error handler itself never throws
 *
 * @param err   - The error value passed via `next(err)` or thrown in a handler
 * @param req   - Express Request object (used for `req.path` in log context)
 * @param res   - Express Response object (used to send JSON error responses)
 * @param _next - Express NextFunction (required for 4-arg arity detection;
 *                used only when headers are already sent)
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // -----------------------------------------------------------------------
  // Safety: If headers are already sent, delegate to Express default handler.
  // Writing to the response stream after headers are flushed would cause
  // a "Cannot set headers after they are sent to the client" error.
  // -----------------------------------------------------------------------
  if (res.headersSent) {
    _next(err);
    return;
  }

  try {
    // -------------------------------------------------------------------
    // 1. Zod Validation Errors → 400 Bad Request
    // -------------------------------------------------------------------
    // ZodError is thrown by `z.parse()` when input fails schema validation.
    // `err.flatten()` provides structured `{ fieldErrors, formErrors }`
    // output that clients can use to display per-field error messages.
    // Logged at `warn` level — validation failures are client-side issues,
    // not server faults.
    // -------------------------------------------------------------------
    if (err instanceof ZodError) {
      logger.warn({ err, path: req.path }, "Validation error");

      const response: ErrorResponse = {
        error: {
          message: "Validation error",
          code: "VALIDATION_ERROR",
          details: err.flatten(),
        },
      };
      res.status(400).json(response);
      return;
    }

    // -------------------------------------------------------------------
    // 2. Database Errors → 500 Internal Server Error
    // -------------------------------------------------------------------
    // PostgreSQL errors (via `pg` driver / Drizzle ORM) carry SQLSTATE
    // codes as string properties starting with a digit (e.g., "23505").
    // We detect these via duck-typing to avoid coupling to Drizzle internals.
    //
    // SECURITY: Database error details (table names, constraint names, SQL)
    // are logged server-side but NEVER sent to the client.
    // -------------------------------------------------------------------
    if (isDatabaseError(err)) {
      logger.error({ err, path: req.path }, "Database error");

      const response: ErrorResponse = {
        error: {
          message: "Internal server error",
          code: "DATABASE_ERROR",
        },
      };
      res.status(500).json(response);
      return;
    }

    // -------------------------------------------------------------------
    // 3. Custom HTTP Errors → Status from error object
    // -------------------------------------------------------------------
    // Many Express error libraries (http-errors, etc.) attach a numeric
    // `statusCode` or `status` property to error objects. When found, we
    // use it directly as the HTTP response status and include the error
    // message in the response body.
    //
    // Logging level is determined by the status code range:
    // - 4xx (client errors) → warn level
    // - 5xx (server errors) → error level
    // -------------------------------------------------------------------
    const httpStatus = getHttpStatusCode(err);
    if (httpStatus !== undefined) {
      const message = getErrorMessage(err);
      const isClientError = httpStatus >= 400 && httpStatus < 500;

      if (isClientError) {
        logger.warn({ err, path: req.path, statusCode: httpStatus }, "Client error");
      } else {
        logger.error({ err, path: req.path, statusCode: httpStatus }, "Server error");
      }

      const response: ErrorResponse = {
        error: {
          message,
          code: "HTTP_ERROR",
        },
      };
      res.status(httpStatus).json(response);
      return;
    }

    // -------------------------------------------------------------------
    // 4. Generic / Unknown Errors → 500 Internal Server Error
    // -------------------------------------------------------------------
    // Catch-all for any unclassified error. In development mode, the
    // actual error message is included in the response for debugging.
    // In production, only a generic message is returned to avoid leaking
    // internal implementation details.
    // -------------------------------------------------------------------
    logger.error({ err, path: req.path }, "Unhandled error");

    const isDevelopment = process.env["NODE_ENV"] === "development";
    const response: ErrorResponse = {
      error: {
        message: isDevelopment ? getErrorMessage(err) : "Internal server error",
        code: "INTERNAL_ERROR",
      },
    };
    res.status(500).json(response);
  } catch (handlerError: unknown) {
    // -----------------------------------------------------------------
    // Failsafe: The error handler itself must NEVER throw.
    // If something goes wrong inside the handler (e.g., logger failure,
    // serialization error), we log it and send a minimal 500 response.
    // -----------------------------------------------------------------
    logger.error(
      { err: handlerError, originalErr: String(err) },
      "Error handler internal failure",
    );

    res.status(500).json({
      error: {
        message: "Internal server error",
        code: "INTERNAL_ERROR",
      },
    });
  }
};
