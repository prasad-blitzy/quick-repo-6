import { ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@trade-read/shared';

/**
 * The server's one error type: a code from the closed table in `@trade-read/shared`, the HTTP
 * status that code is answered with, and the sentence the shared table holds for it.
 *
 * Every module that can fail imports this file, and this file imports nothing but the shared
 * contract. That keeps it a pure primitive — no express, no multer, `node:fs`, `fetch`, logger or
 * prompt text enters the import graph — so the routes, the adapters and the store can raise an
 * error without dragging their own dependencies into a caller that only wanted a code.
 *
 * The vocabulary itself lives in `shared/src/errors.ts` and is never restated here: a message is
 * always `ERROR_MESSAGES[code]`, a status is always `ERROR_STATUS[code]`. The client renders its
 * own wording for the same code, so a sentence invented here would be a second, drifting answer
 * to the same failure. What this file may add to a sentence is a sanitised file name or the
 * configured model slug; never a stack trace, a filesystem path, a provider payload or a
 * credential, because the message travels in the response body.
 */

/** A path separator in either the POSIX (`/`) or the Windows (`\`) form. */
const DIRECTORY_SEPARATOR = /[\\/]+/;

/** C0 controls, DEL, C1 controls and the two line separators a log reader may split on. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Any run of whitespace, collapsed so a tab or a newline cannot reshape a sentence. */
const WHITESPACE_RUN = /\s+/g;

/** Leading dots, which would let a crafted name read as a relative path segment. */
const LEADING_DOTS = /^\.+/;

/** The double quote, stripped from a name that is rendered inside a pair of them. */
const DOUBLE_QUOTE = /"/g;

/** Everything a rendered model slug may not contain; a slug is letters, digits and `. _ : / -`. */
const NON_SLUG_CHARS = /[^A-Za-z0-9._:/-]/g;

/** A credential issued by the model gateway, redacted from any text this module renders. */
const CREDENTIAL_PATTERN = /sk-or-[A-Za-z0-9._-]+/g;

/** What a credential-shaped run is replaced with. */
const REDACTED = '[redacted]';

/** Longest file name rendered into a message, counted in code points. */
const MAX_FILE_NAME_CHARS = 120;

/** Longest model slug rendered into a message, counted in code points. */
const MAX_SLUG_CHARS = 100;

/**
 * Caps a rendered value at `maxCodePoints`. Counting code points rather than UTF-16 units means a
 * surrogate pair is never split into two lone halves by the cut.
 */
function capCodePoints(value: string, maxCodePoints: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= maxCodePoints
    ? value
    : codePoints.slice(0, maxCodePoints).join('');
}

/**
 * Renders a submitted file name safely for a sentence and for a log line.
 *
 * The name arrives from the client, so it is treated as hostile input:
 *
 * - only the last path segment survives, so a name carrying `../`, a POSIX path or a Windows path
 *   can neither look like a filesystem path nor escape the analysis it belongs to;
 * - control characters and newlines are removed, so the name cannot forge or split a log line;
 * - whitespace is collapsed and the leading dots are dropped, so a crafted name cannot read as a
 *   relative path segment;
 * - the double quote is dropped, so the name cannot break out of the quoting it is rendered in;
 * - a credential-shaped run is redacted, so a file named after a key cannot put one into a body or
 *   a log line that a leak scan greps;
 * - the result is capped at {@link MAX_FILE_NAME_CHARS} code points.
 *
 * A value that is not a string renders as the empty string. Every consumer — the error handler's
 * response body and the store's audit lines — reuses this function rather than sanitising a name
 * of its own, so there is one answer to what a rendered file name looks like.
 */
export function sanitizeFileName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const segments = value.split(DIRECTORY_SEPARATOR);
  const lastSegment = segments[segments.length - 1] ?? '';

  const cleaned = lastSegment
    .replace(CONTROL_CHARS, ' ')
    .replace(DOUBLE_QUOTE, '')
    .replace(CREDENTIAL_PATTERN, REDACTED)
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .replace(LEADING_DOTS, '')
    .trim();

  return capCodePoints(cleaned, MAX_FILE_NAME_CHARS).trim();
}

/**
 * Renders the model slug safely. Unlike a file name it keeps its `/`, because a slug is
 * `vendor/model` and dropping the vendor would hide which model was configured.
 *
 * The slug comes from server configuration rather than from a request, so this is defence in
 * depth: it admits only the characters a slug is written with, and it redacts a credential-shaped
 * run, so a key pasted into `OPENROUTER_MODEL` can never reach a response body.
 */
function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const cleaned = value
    .replace(NON_SLUG_CHARS, '')
    .replace(CREDENTIAL_PATTERN, REDACTED);

  return capCodePoints(cleaned, MAX_SLUG_CHARS);
}

/**
 * Builds the message for a code: the shared sentence first, then the sanitised file name and the
 * sanitised slug when the code carries one. The shared sentence stays the prefix, so a consumer
 * can match on it, and nothing local to the server is ever appended beyond those two values.
 */
function composeMessage(code: ErrorCode, fileName: string, slug: string): string {
  const sentences = [ERROR_MESSAGES[code]];

  if (fileName !== '') {
    sentences.push(`Offending file: "${fileName}".`);
  }

  if (slug !== '') {
    sentences.push(`Model: "${slug}".`);
  }

  return sentences.join(' ');
}

/** The optional values a factory may attach to an error. */
interface AppErrorInit {
  /** Offending multipart file name, sanitised before it is stored or rendered. */
  readonly fileName?: string;
  /** Configured model slug, rendered only for `PROVIDER_MODEL_UNSUPPORTED`. */
  readonly slug?: string;
  /**
   * Internal diagnostic — a conformance reason, a provider status, the thrown value itself. It is
   * kept for the logger and is never rendered into the message nor serialised into a body.
   */
  readonly cause?: unknown;
}

/**
 * The error every layer of the server raises, with one factory per code of the closed table.
 *
 * The factories exist so that no route, adapter or store writes a code, a status or a sentence of
 * its own: a caller picks the factory that describes the failure and everything else — the
 * status, the sentence, what is safe to expose — is decided here.
 *
 * Two of the factories take a value that reaches the operator: the file name of an image
 * rejection, because the request requires a rejection to name the offending file, and the
 * configured slug of a model-unsupported failure, because the operator has to know which slug was
 * tried. Both are sanitised by this module. Neither a stack nor a filesystem path is ever part of a
 * message, and the `cause` a factory may attach stays non-enumerable, so it is available to the
 * logger and invisible to `JSON.stringify`.
 */
export class AppError extends Error {
  /** The code from the closed table. The response body's `code` field is this value. */
  readonly code: ErrorCode;

  /** The HTTP status this code is answered with, read from the shared table, never a literal. */
  readonly status: number;

  /**
   * The sanitised name of the file an image rejection is about, set only by the three image
   * rejection factories and `undefined` for every other code, so the error handler can name the
   * offending part without parsing the message back apart.
   */
  readonly fileName: string | undefined;

  private constructor(code: ErrorCode, init: AppErrorInit = {}) {
    const fileName = sanitizeFileName(init.fileName);
    const slug = sanitizeSlug(init.slug);

    super(
      composeMessage(code, fileName, slug),
      init.cause === undefined ? undefined : { cause: init.cause },
    );

    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fileName = fileName === '' ? undefined : fileName;
  }

  /** No image file was attached to the submission. */
  static noImages(): AppError {
    return new AppError('NO_IMAGES');
  }

  /** More than the permitted number of image files was attached. */
  static tooManyImages(): AppError {
    return new AppError('TOO_MANY_IMAGES');
  }

  /**
   * A file is not PNG, JPEG or WebP. `fileName` is the offending part's submitted name, which is
   * sanitised before it is rendered and stored.
   */
  static unsupportedImageType(fileName: string): AppError {
    return new AppError('UNSUPPORTED_IMAGE_TYPE', { fileName });
  }

  /** A single file, or the submission in total, is past its byte bound. */
  static imageTooLarge(fileName: string): AppError {
    return new AppError('IMAGE_TOO_LARGE', { fileName });
  }

  /** An image whose long edge exceeds the pixel bound. */
  static imageTooLargeDimensions(fileName: string): AppError {
    return new AppError('IMAGE_TOO_LARGE_DIMENSIONS', { fileName });
  }

  /** Every submitted image came back unreadable, so there is nothing to recommend from. */
  static noReadableImages(): AppError {
    return new AppError('NO_READABLE_IMAGES');
  }

  /** No model credential is configured; the server still runs and still answers. */
  static providerNotConfigured(): AppError {
    return new AppError('PROVIDER_NOT_CONFIGURED');
  }

  /** The provider refused the request for insufficient credits. */
  static providerQuotaExceeded(): AppError {
    return new AppError('PROVIDER_QUOTA_EXCEEDED');
  }

  /**
   * The configured slug is unknown or has no image-capable endpoint. `slug` is the configured
   * value, never the credential, so the operator can see which model was tried.
   */
  static providerModelUnsupported(slug: string): AppError {
    return new AppError('PROVIDER_MODEL_UNSUPPORTED', { slug });
  }

  /**
   * The provider timed out, was rate limited, or the shared analysis budget expired. One factory
   * serves all three because the operator's answer is the same and the request defines no code
   * that distinguishes them.
   */
  static analysisTimeout(): AppError {
    return new AppError('ANALYSIS_TIMEOUT');
  }

  /**
   * The provider answered something unusable — malformed, truncated, or outside the vocabulary —
   * twice in a row. `detail` is the conformance reason for the log; the body keeps the shared
   * sentence, because the provider's raw text is never exposed to a caller.
   */
  static analysisFailed(detail?: string): AppError {
    return new AppError('ANALYSIS_FAILED', { cause: detail });
  }

  /** No analysis exists under that id. There is no authorisation code: the API has no identity. */
  static notFound(): AppError {
    return new AppError('NOT_FOUND');
  }

  /**
   * The fallback for an unexpected throw: a 500 with the generic sentence, carrying the thrown
   * value as `cause` for the logger only. The original message is deliberately not copied into the
   * response, which is what keeps a driver's diagnostic or a filesystem path out of a body.
   */
  static internal(cause?: unknown): AppError {
    return new AppError('INTERNAL_ERROR', { cause });
  }
}

/**
 * Narrows an unknown value to {@link AppError}, so a catch clause can rethrow a domain error
 * unchanged and wrap anything else.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Coerces whatever was thrown into an {@link AppError}: an `AppError` comes back as itself, so its
 * code and status survive, and anything else becomes `500 INTERNAL_ERROR` with the original value
 * attached as `cause`. Callers use this instead of probing a thrown value by hand, which is what
 * keeps an unexpected throw from turning into a leaked message or a missing status.
 */
export function toAppError(value: unknown): AppError {
  return isAppError(value) ? value : AppError.internal(value);
}
