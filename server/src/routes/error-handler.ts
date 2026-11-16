import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import multer from 'multer';

import type { ApiErrorBody } from '@trade-read/shared';

import { AppError, isAppError } from '../domain/errors.js';

/**
 * The error handler: the single place a thrown value becomes an HTTP response.
 *
 * Express identifies an error handler by the arity of the function it is given, so the export below
 * keeps all four parameters — `(err, req, res, next)` — even though the request itself is not read. A
 * parameter dropped as unused would turn this file into ordinary middleware that is never reached on
 * a failure, and every error would fall through to Express's default HTML page instead of the shared
 * error body.
 *
 * Every response written here is exactly `{ code, message }` from the shared contract: `code` belongs
 * to the closed `ERROR_CODES` table, `status` comes from `ERROR_STATUS`, and `message` comes from
 * `ERROR_MESSAGES`. All three travel on the `AppError` the mapping below produces, so this file never
 * chooses a status and never writes a sentence of its own; a literal `400` or a locally worded
 * sentence here would be a second, drifting answer to a failure the table already names.
 *
 * What reaches a caller is deliberately narrow: no stack, no filesystem path, no header, no request
 * body and no credential. An unexpected throw becomes `500 INTERNAL_ERROR` with the table's generic
 * sentence, and the thrown value is attached as the error's non-enumerable `cause`, which a logger can
 * read and `JSON.stringify` cannot. `INTERNAL_ERROR` is the fallback that keeps the body shape true,
 * not a thirteenth trigger: every condition the table covers is mapped to its own code below.
 *
 * Three failure families are translated here rather than in the routes, because this is the only place
 * that sees them:
 *
 * - a thrown `AppError` passes through with its own code, status and sentence;
 * - a `multer.MulterError` raised while parsing the multipart body describes a submission that never
 *   produced a usable image set, so its codes map onto the image-rejection rows of the error table;
 * - a body-parser failure — a JSON payload past the `express.json` cap, or an unparseable one — is
 *   `400 NO_IMAGES`, because a request carrying a JSON body carries no image file and no route accepts
 *   a JSON body. That mapping is what keeps the row a 400 instead of a 500, and `app.ts` cannot make
 *   it: the parser's failure is thrown past the routes and lands here.
 *
 * The handler writes no log line. The domain service, the provider client and the store each emit
 * their own structured event for the failures they raise, and a second line here would have to be
 * built from a thrown value that may carry a path or a credential — the one thing this file must not
 * reproduce.
 */

/**
 * The `type` body-parser stamps on a payload it refused for exceeding the configured cap.
 *
 * `express.json` is mounted by `app.ts` with a 1 MiB limit, and its refusal arrives here as a thrown
 * `http-errors` object carrying this discriminant and a 413 status.
 */
const PAYLOAD_TOO_LARGE = 'entity.too.large';

/** The `type` body-parser stamps on a body it could not parse at all. */
const BODY_PARSE_FAILED = 'entity.parse.failed';

/**
 * The status a payload-too-large failure carries. It is read as an incoming discriminant, never used
 * as the status of a response this file writes.
 */
const PAYLOAD_TOO_LARGE_STATUS = 413;

/**
 * Read through, rather than narrowing by class, the parse failures body-parser throws. Its error
 * classes ship inside Express and are not part of the surface this server depends on, so the two
 * fields that identify the failure are read structurally instead of by importing `body-parser`.
 */
interface ParseFailure {
  readonly type?: unknown;
  readonly status?: unknown;
}

/** Whether a thrown value is an object, so its fields can be read without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a thrown value is a body-parser failure: a payload past the cap, recognised by its `type`
 * or by the 413 status `http-errors` attaches, or a body it could not parse.
 */
function isParseFailure(error: unknown): error is ParseFailure {
  if (!isRecord(error)) {
    return false;
  }

  const { type, status } = error;

  if (type === PAYLOAD_TOO_LARGE || type === BODY_PARSE_FAILED) {
    return true;
  }

  return status === PAYLOAD_TOO_LARGE_STATUS;
}

/** Whether a thrown value is multer's own parse error rather than a failure raised by this server. */
function isMulterError(error: unknown): error is multer.MulterError {
  return error instanceof multer.MulterError;
}

/**
 * Maps a multer parse failure onto the closed table.
 *
 * A seventh file and a file part under an unexpected field name are both "too many files" as the
 * operator reads them, so they take the image-count row. A part past multer's per-part memory guard
 * takes the byte row. Every other multer code — a field-key, field-value or field-count overflow, a
 * missing field name — describes a multipart body this API could not read as an image submission at
 * all, so it takes the row that asks for at least one image file; none of them earns an invented code.
 *
 * The byte row is raised with no file name because multer's error carries the form field, never the
 * submitted file's name. Rendering the field name as though it were a file would name the wrong thing,
 * so an empty name is passed and the row's own sentence — which already states both byte bounds —
 * stands alone. The domain's per-file and total checks do know the name and name it there.
 */
function fromMulterError(error: multer.MulterError): AppError {
  switch (error.code) {
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return AppError.tooManyImages();
    case 'LIMIT_FILE_SIZE':
      return AppError.imageTooLarge('');
    default:
      return AppError.noImages();
  }
}

/**
 * Reduces any thrown value to the `AppError` whose code, status and sentence answer it.
 *
 * The order matters: an `AppError` is recognised first, so a code raised by the domain keeps its own
 * status instead of being flattened into a generic one. A multer failure is recognised by its class
 * and a parse failure by its fields; everything else — a plain `Error`, a rejected promise, a value
 * that is not an error at all — becomes the `INTERNAL_ERROR` fallback, with the thrown value kept as
 * `cause` so a diagnostic is available without a byte of it reaching the response.
 */
function toHttpError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (isMulterError(error)) {
    return fromMulterError(error);
  }

  if (isParseFailure(error)) {
    return AppError.noImages();
  }

  return AppError.internal(error);
}

/**
 * Answers every failure the app did not handle with the shared `{ code, message }` body.
 *
 * `app.ts` mounts this handler after the routers, so it sees a rejection forwarded by Express 5's
 * async handling, an error passed to `next(...)` by a route or a parser, and a synchronous throw
 * alike.
 *
 * A response already on the wire is never interrupted: once headers have been sent, the only correct
 * move is to hand the failure back to Express, which ends the connection. Writing a second body there
 * would throw over the first one and lose the original failure.
 *
 * @param error - Whatever was thrown or forwarded; narrowed by {@link toHttpError}.
 * @param _req - Unused, and kept only because Express identifies an error handler by arity.
 * @param response - The response to answer on, when nothing has been written to it yet.
 * @param next - The chain's continuation, called only for a response already in flight.
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const httpError = toHttpError(error);

  const body: ApiErrorBody = {
    code: httpError.code,
    message: httpError.message,
  };

  response.status(httpError.status).json(body);
};
