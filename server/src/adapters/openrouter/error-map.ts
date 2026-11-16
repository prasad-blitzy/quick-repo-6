/**
 * The single translation of a provider failure into the server's own error.
 *
 * `server/src/adapters/openrouter/` is the only part of the build that talks to a model, so a
 * provider's vocabulary — an HTTP status, a response body, an aborted request — arrives here and
 * nowhere else. This module turns it into the domain's `AppError`, which means the routes above
 * never see a provider status, and the operator is never told more than the shared error table
 * holds. D4 splits that mapping between exactly two owners: this file for provider failure →
 * `AppError`, and `server/src/routes/error-handler.ts` for `AppError` → HTTP body.
 *
 * Everything returned here is terminal (D11). The one failure this build ever retries is a
 * conformance failure, and it is retried inside `openrouter-client.ts`, never here: an
 * authentication or permission refusal, a quota refusal, an unsupported model, a provider timeout,
 * a rate limit and an abort all map straight through, and no code this module returns may be one a
 * caller would treat as retryable.
 *
 * The code, its HTTP status and its sentence all come from `@trade-read/shared` through the
 * `AppError` factories, so neither a status number nor a user-facing sentence is written here and
 * the table keeps exactly one definition. The only value of the caller's that can reach an
 * operator is the configured model slug, and only on the one row where it is the answer the
 * operator needs: a refusal of the slug itself. It is a configuration value, never a credential —
 * the credential appears in no message, no argument and no export of this module, and the provider
 * base URL appears in none of them either.
 *
 * It performs no I/O, holds no state, opens no connection and writes no log line. It is therefore a
 * leaf, and the adapter that raises these errors can import it without a cycle.
 */

import { AppError, isAppError } from '../../domain/errors.js';

/** The provider refused the credential, or does not accept it. */
const STATUS_UNAUTHORIZED = 401;

/** The credential is understood but not permitted to do this. The same fault, the same answer. */
const STATUS_FORBIDDEN = 403;

/** The account behind the credential cannot pay for the call. */
const STATUS_PAYMENT_REQUIRED = 402;

/** The slug is unknown, or has no endpoint that accepts an image. */
const STATUS_NOT_FOUND = 404;

/** The provider gave up waiting for the request. */
const STATUS_REQUEST_TIMEOUT = 408;

/** The account is being used faster than its allowance. */
const STATUS_TOO_MANY_REQUESTS = 429;

/** The `name` an explicitly cancelled request carries. */
const ABORT_ERROR_NAME = 'AbortError';

/**
 * The `name` a spent deadline carries.
 *
 * `server/src/domain/deadline.ts` builds its single abort reason with `name = 'TimeoutError'`, and
 * `fetch` rejects with its signal's reason, so `TimeoutError` — not `AbortError` — is the name the
 * thirty-second budget actually arrives under (D11). Recognising only `AbortError` would turn a
 * spent budget into `ANALYSIS_FAILED` and lose the timeout the request defines for it. The name is
 * also the one an `AbortSignal.timeout()` rejection carries, so a single check covers both ways a
 * deadline fires.
 */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/** The code a Node abort error carries when it is raised without the conventional name. */
const ABORT_ERROR_CODE = 'ABORT_ERR';

/** Longest diagnostic kept from a provider message, in characters. */
const MAX_DETAIL_CHARS = 200;

/** What a credential-shaped or payload-shaped run is replaced with. */
const REDACTED = '[redacted]';

/**
 * C0 controls, DEL, the C1 block and the two line separators a log reader splits on. A provider
 * body is multi-line JSON, and a newline carried into a diagnostic would forge or split a log line
 * that a reader parses field by field.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Any run of whitespace, collapsed so a multi-line body renders as one line. */
const WHITESPACE_RUN = /\s+/g;

/**
 * A run long enough to be an opaque secret: a key's body, a session token, or base64 of image
 * bytes. Twenty characters is an order of magnitude longer than any word a provider error sentence
 * uses and far shorter than any credential, which is why the model slugs and slugs a provider names
 * in its own messages survive it. Hyphens and dots are deliberately absent from the class: a slug
 * is written with them, so a slug cannot be swallowed whole, while a key's body is drawn from this
 * alphabet and is. The pass is defence in depth — a diagnostic never reaches a response body, and
 * the logger redacts the same shapes again.
 */
const LONG_OPAQUE_RUN = /[A-Za-z0-9_+/=]{20,}/g;

/** Truncation mark appended to a diagnostic that was over {@link MAX_DETAIL_CHARS}. */
const TRUNCATION_MARK = '…';

/**
 * What a caller knows about the failure that this module cannot see.
 *
 * Both members are diagnostic or configuration values: neither is ever placed in a response body by
 * this module beyond the slug of the model-unsupported row, and neither may ever hold a credential.
 */
export interface ProviderFailureContext {
  /**
   * The configured model slug — for example a `vendor/model` pair — used for the one row whose
   * message names it. Never the credential, and never the base URL.
   */
  readonly model: string;

  /**
   * The provider's own message for the failure, if the caller took one from the response body. It
   * is optional, it is treated as hostile text, and it is kept only as a bounded diagnostic for the
   * log: it never overrides the shared sentence and never reaches a caller of the API.
   */
  readonly providerMessage?: string;
}

/**
 * Maps a non-2xx provider HTTP status to the application's `AppError`.
 *
 * The rows, in the order they matter:
 *
 * - `401` and `403` → `PROVIDER_NOT_CONFIGURED`. A credential the provider will not accept is a
 *   configuration fault rather than a transient one, and the operator's next step is to fix the
 *   configuration.
 * - `402` → `PROVIDER_QUOTA_EXCEEDED`. The account cannot pay for the call.
 * - `404` → `PROVIDER_MODEL_UNSUPPORTED`, carrying the configured slug, because the provider answers
 *   `404` both for a slug it does not know and for a slug with no endpoint that accepts an image,
 *   and which slug was tried is the whole of what the operator can act on. This is the only row
 *   whose message names a configured value.
 * - `408` and `429` → `ANALYSIS_TIMEOUT`. A provider-side timeout and a rate limit have one answer
 *   for this attempt, and the table holds one code for both.
 * - Everything else → `ANALYSIS_FAILED`: `400`, `422`, the `5xx` family, an abort reported as a
 *   status, a status that is negative, fractional or not a number at all. That fallback is what
 *   keeps the `{ code, message }` body shape true for a failure nobody anticipated.
 *
 * The function is total: it returns an error for every number it can be given and never throws.
 */
export function mapProviderStatus(
  status: number,
  context: ProviderFailureContext,
): AppError {
  switch (status) {
    case STATUS_UNAUTHORIZED:
    case STATUS_FORBIDDEN:
      return AppError.providerNotConfigured();

    case STATUS_PAYMENT_REQUIRED:
      return AppError.providerQuotaExceeded();

    case STATUS_NOT_FOUND:
      return AppError.providerModelUnsupported(modelOf(context));

    case STATUS_REQUEST_TIMEOUT:
    case STATUS_TOO_MANY_REQUESTS:
      return AppError.analysisTimeout();

    default:
      return AppError.analysisFailed(boundedDetail(providerMessageOf(context)));
  }
}

/**
 * True for the error a deadline or a cancelled signal raises.
 *
 * The check reads the value rather than testing its prototype, so it holds for a `DOMException` from
 * another realm, for a plain `Error` whose `name` was set, and for Node's abort error, none of which
 * share a prototype across a boundary. It recognises both abort names on purpose: an explicit
 * cancellation raises `AbortError`, while a spent analysis budget raises `TimeoutError` (see
 * {@link TIMEOUT_ERROR_NAME}). It is a defensive narrow over `unknown` — `null`, `undefined`, a
 * primitive, a function and an object without those fields are all simply `false`, and it never
 * throws.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { name, code } = error as { readonly name?: unknown; readonly code?: unknown };

  return (
    name === ABORT_ERROR_NAME ||
    name === TIMEOUT_ERROR_NAME ||
    code === ABORT_ERROR_CODE
  );
}

/**
 * Maps a thrown provider call failure to the application's `AppError`.
 *
 * - An abort — the deadline expiring, or a caller cancelling — → `ANALYSIS_TIMEOUT`, which is the
 *   path the thirty-second budget takes.
 * - An `AppError` → returned by identity, never re-wrapped. A second wrap would lose the code the
 *   first mapping chose, and a specific `PROVIDER_MODEL_UNSUPPORTED` would silently become a generic
 *   `ANALYSIS_FAILED`; this branch is what keeps a mapped error mapped.
 * - Anything else, a `TypeError` from a failed connection included → `ANALYSIS_FAILED`, with a
 *   bounded, redacted description of what was thrown kept as the diagnostic. A thrown value that
 *   carries no text at all falls back to the provider message the caller recorded, so the failure
 *   is still diagnosable from the log.
 *
 * The function is total: every thrown value, including `null`, a primitive and an object that is
 * not an error at all, produces an `AppError`.
 */
export function mapProviderFailure(
  error: unknown,
  context: ProviderFailureContext,
): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (isAbortError(error)) {
    return AppError.analysisTimeout();
  }

  const detail = describeThrown(error) ?? boundedDetail(providerMessageOf(context));

  return AppError.analysisFailed(detail);
}

/**
 * The configured slug to render, or the empty string when the caller passed none.
 *
 * The parameter is typed, so this matters only for a caller reaching the module from plain
 * JavaScript — and it earns its line, because a throw inside a catch block would replace a mapped
 * provider failure with an unmapped one.
 */
function modelOf(context: ProviderFailureContext): string {
  return typeof context?.model === 'string' ? context.model : '';
}

/** The provider's own message for the failure, if the caller recorded one. */
function providerMessageOf(context: ProviderFailureContext): string | undefined {
  return typeof context?.providerMessage === 'string'
    ? context.providerMessage
    : undefined;
}

/**
 * Renders a thrown value as a one-line diagnostic.
 *
 * The description is what a reader of the log needs and no more: an error's name and message, or a
 * thrown string, or the `message` of a thrown object. Anything without text yields no detail at
 * all, which leaves the shared sentence as the only text the error carries.
 */
function describeThrown(error: unknown): string | undefined {
  if (error instanceof Error) {
    return boundedDetail(`${error.name}: ${error.message}`);
  }

  if (typeof error === 'string') {
    return boundedDetail(error);
  }

  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === 'string') {
      return boundedDetail(message);
    }
  }

  return undefined;
}

/**
 * Prepares a provider-supplied string for use as a diagnostic.
 *
 * The value is hostile: it comes from a response body, so it may carry newlines that would forge a
 * log line, control characters that would corrupt one, an opaque secret, or a length no reader
 * wants. Control characters become spaces, whitespace collapses, an opaque run is replaced, and the
 * result is capped at {@link MAX_DETAIL_CHARS} characters. A value that is not a string, or that is
 * empty once cleaned, yields `undefined` rather than an empty diagnostic.
 *
 * The result travels as the `AppError`'s cause, which is non-enumerable and is never rendered into
 * the message, so this text cannot reach a response body — and when in doubt the mapping drops it
 * entirely rather than risk a leak.
 */
function boundedDetail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const cleaned = value
    .replace(CONTROL_CHARS, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .replace(LONG_OPAQUE_RUN, REDACTED)
    .trim();

  if (cleaned === '') {
    return undefined;
  }

  return cleaned.length <= MAX_DETAIL_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_DETAIL_CHARS)}${TRUNCATION_MARK}`;
}
