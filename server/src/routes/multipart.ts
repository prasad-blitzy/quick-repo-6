import multer from 'multer';

import type { Request, RequestHandler } from 'express';

import { MAX_IMAGES, MAX_TOTAL_BYTES } from '@trade-read/shared';

import { AppError } from '../domain/errors.js';

/**
 * The multipart parsing boundary of the analysis routes: multer configured for in-memory parsing,
 * plus the field filter that decides which submitted parts the domain may ever see.
 *
 * This module parses and shapes a request; it decides nothing about a submission's content. The
 * count, sniffed content type, per-file size, total size and long-edge checks all live in
 * `../domain/image-validation.js` and keep their fixed order there, so nothing here may pre-empt or
 * reorder them. Two consequences follow, and both are deliberate:
 *
 * - The declared `Content-Type` of a part is never inspected. A client controls it, so
 *   `UNSUPPORTED_IMAGE_TYPE` has to be decided from the received bytes by `../domain/image-probe.js`;
 *   rejecting a part here on its declared type would mask that code and answer the wrong one.
 * - The per-file byte bound is not applied here either. A part above it but below the memory guard
 *   below must still reach the domain and fail there, which is what keeps the order above observable.
 *
 * No prompt text is built, read or accepted here. `pickKnownFields` returns only the two optional
 * text parts, so a field named `prompt`, `system`, `instructions` or anything else is dropped without
 * an error — silently, because the error table is closed and defines no code for a stray field. That
 * silence is what makes the rule that the instruction text cannot be reached by a request provable:
 * the request has no path to it.
 *
 * This module reads no environment, touches no header and writes no log line, so the model
 * credential cannot pass through it.
 */

/** The one file part the API accepts. A file part under any other name is refused by multer. */
export const IMAGES_FIELD = 'images';

/**
 * Every multipart part this API reads. Any other part is dropped before the domain sees the request.
 *
 * Declared for the field filter and for the suites that assert the absence of a prompt parameter:
 * `instrument` and `context` are the only text parts `pickKnownFields` returns, and `images` is the
 * only file part the accepted-file field lists.
 */
export const KNOWN_FIELDS = ['images', 'instrument', 'context'] as const;

/**
 * The optional text parts of a submission. Both are submitted data: they are appended to the
 * built-in instruction text as labelled values and never as instructions, and both are clamped to
 * their character bound in the domain service rather than here, so this module neither truncates nor
 * rejects either one.
 */
const TEXT_FIELDS = ['instrument', 'context'] as const;

/**
 * How many image files multer has accepted so far for each request.
 *
 * Keyed by the request rather than held in a counter, so two simultaneous submissions each count
 * their own parts: a shared counter would let one submission's files exhaust another's allowance.
 * An entry lives as long as the request it is keyed by and is collected with it, so there is nothing
 * to reset and no growth across the process's lifetime.
 */
const acceptedImageCounts = new WeakMap<Request, number>();

/**
 * Stops a submission that carries more than {@link MAX_IMAGES} image parts, and accepts every part
 * below that bound without looking at it.
 *
 * The rejection raises `AppError.tooManyImages()` — the one code this module may raise — so the
 * error handler answers `400 TOO_MANY_IMAGES` through the same mapping as every other domain
 * failure. Multer's own two caps (the `files` limit and the array form's maximum count) also refuse
 * a seventh part, and the error handler maps both of their errors to that same code, so the bound
 * holds whichever check fires first.
 *
 * The part's declared type and its file name are not read here: the sniffed type is the domain's
 * decision, and a name only ever reaches a message through the domain's sanitiser.
 */
function countAcceptedImages(
  req: Request,
  _file: Express.Multer.File,
  callback: multer.FileFilterCallback,
): void {
  const accepted = acceptedImageCounts.get(req) ?? 0;

  if (accepted >= MAX_IMAGES) {
    callback(AppError.tooManyImages());
    return;
  }

  acceptedImageCounts.set(req, accepted + 1);
  callback(null, true);
}

/**
 * The configured multipart parser. Files are buffered in memory and never written to disk, so a
 * rejected submission leaves nothing behind and the received bytes are what the domain tests.
 *
 * `fileSize` is {@link MAX_TOTAL_BYTES} and is a memory guard, not the total-size rule: it bounds one
 * part during parsing so a single enormous upload cannot exhaust the process, while the rule itself
 * — the 10 MiB per-file bound and the 24 MiB bound on the sum of the buffers — is enforced on the
 * parsed buffers by the domain. The one overlap is accepted on purpose: a non-image larger than the
 * guard is answered with the size code before sniffing could name its type, because buffering it to
 * learn that would defeat the guard.
 *
 * `limits.fields` is deliberately absent. A field cap would turn a few stray text parts into a
 * parsing failure, where dropping them silently is the required behaviour; the field filter below is
 * what limits which parts the domain reads, and the parser keeps no opinion of its own so a submission
 * carrying an unknown field still succeeds.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_IMAGES,
    fileSize: MAX_TOTAL_BYTES,
  },
  fileFilter: countAcceptedImages,
});

/**
 * The upload middleware for `POST /api/v1/analyses`: the array form on the one accepted file part,
 * with its maximum count stated here as well as in the parser's limits.
 *
 * The array form is what refuses a file part under a name the API does not accept, and what refuses
 * a part past the maximum count when the parser's own limit has not fired first. On success the
 * parsed parts are on `req.files` and the text parts on `req.body`; a submission carrying no file at
 * all passes through untouched, so an empty submission reaches the domain and is answered from there
 * with `NO_IMAGES` rather than failing during parsing.
 */
export const uploadImages: RequestHandler = upload.array(IMAGES_FIELD, MAX_IMAGES);

/**
 * The optional text parts of a submission, each present only when the request carried it as text.
 *
 * Both are the submitted value exactly as received: this type says nothing about length, because the
 * character bounds are applied once in the domain service.
 */
export interface KnownTextFields {
  /** The submitted instrument, when the request carried one as text. */
  instrument?: string;

  /** The submitted free-text context, when the request carried one as text. */
  context?: string;
}

/**
 * Reads one text part from a parsed body, returning it only when the request submitted text.
 *
 * Multer stores a text part as a string and a repeated one as an array of strings, so a repeated
 * field yields its first element. Any other shape is dropped rather than coerced: a bracket-named
 * part such as `context[key]=value` parses into an object under that key, and a value this API cannot
 * read as text is not the text the caller submitted.
 */
function readTextPart(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const first: unknown = value[0];

    return typeof first === 'string' ? first : undefined;
  }

  return undefined;
}

/**
 * Keeps only the optional text parts of a parsed multipart body, dropping every other key without
 * an error.
 *
 * The body multer produces holds every text part the request carried, including ones this API does
 * not accept, so this is the filter that makes the built-in instruction text unreachable: a
 * `prompt`, `system` or `instructions` field, or any key a caller invents, is simply not returned.
 * No code is raised for it, because the error table is closed and dropping the value is the whole
 * intended behaviour.
 *
 * A value that is not text is dropped as well, and no value is truncated: the submitted strings are
 * returned as received, because the character bounds belong to the domain service, which clamps them
 * in the one place that behaviour lives.
 *
 * The returned object is fresh on every call and nothing on the request is mutated, so the caller
 * gets a value it may hold without the request outliving it.
 *
 * @param body - The parsed request body, typed as unknown because it arrives from the wire: anything
 * that is not a non-null object yields no text parts at all.
 * @returns The submitted `instrument` and `context`, each only when the request carried it as text.
 */
export function pickKnownFields(body: unknown): KnownTextFields {
  if (typeof body !== 'object' || body === null) {
    return {};
  }

  const parsed = body as Record<string, unknown>;
  const fields: KnownTextFields = {};

  for (const field of TEXT_FIELDS) {
    const value = readTextPart(parsed, field);

    if (value === undefined) {
      continue;
    }

    fields[field] = value;
  }

  return fields;
}
