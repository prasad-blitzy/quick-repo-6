/**
 * The client's only reader of an error body and its only implementation of
 * error-code-to-behaviour mapping.
 *
 * The vocabulary and the user-facing sentences belong to the shared error table; this module
 * decides what an error body means for the interface — which sentence is shown, whether a
 * resubmit control is offered, whether the failure is rendered beside the queued files, and
 * whether the user leaves for history — so no component restates a message or invents a rule.
 */

import { ERROR_CODES, ERROR_MESSAGES } from '@trade-read/shared';
import type { ApiErrorBody, ErrorCode } from '@trade-read/shared';

/**
 * Which codes offer a resubmit control. A complete record, so a code added to the vocabulary
 * stops the build here rather than defaulting silently: every validation and provider failure is
 * worth re-posting the same queue, while a missing analysis cannot be recovered by retrying.
 */
const RESUBMITTABLE: Record<ErrorCode, boolean> = {
  NO_IMAGES: true,
  TOO_MANY_IMAGES: true,
  UNSUPPORTED_IMAGE_TYPE: true,
  IMAGE_TOO_LARGE: true,
  IMAGE_TOO_LARGE_DIMENSIONS: true,
  NO_READABLE_IMAGES: true,
  PROVIDER_NOT_CONFIGURED: true,
  PROVIDER_QUOTA_EXCEEDED: true,
  PROVIDER_MODEL_UNSUPPORTED: true,
  ANALYSIS_TIMEOUT: true,
  ANALYSIS_FAILED: true,
  NOT_FOUND: false,
  INTERNAL_ERROR: true,
};

/**
 * Which codes reject the submitted files rather than the request as a whole. Only these are
 * rendered beside the queue in the upload surface, so a provider failure never reads as a
 * per-file rejection.
 */
const PER_FILE_VALIDATION: Record<ErrorCode, boolean> = {
  NO_IMAGES: true,
  TOO_MANY_IMAGES: true,
  UNSUPPORTED_IMAGE_TYPE: true,
  IMAGE_TOO_LARGE: true,
  IMAGE_TOO_LARGE_DIMENSIONS: true,
  NO_READABLE_IMAGES: true,
  PROVIDER_NOT_CONFIGURED: false,
  PROVIDER_QUOTA_EXCEEDED: false,
  PROVIDER_MODEL_UNSUPPORTED: false,
  ANALYSIS_TIMEOUT: false,
  ANALYSIS_FAILED: false,
  NOT_FOUND: false,
  INTERNAL_ERROR: false,
};

/**
 * Which codes mean the stored analysis is gone, so history is the only useful destination
 * instead of a retry of the read that asked for it.
 */
const RETURNS_TO_HISTORY: Record<ErrorCode, boolean> = {
  NO_IMAGES: false,
  TOO_MANY_IMAGES: false,
  UNSUPPORTED_IMAGE_TYPE: false,
  IMAGE_TOO_LARGE: false,
  IMAGE_TOO_LARGE_DIMENSIONS: false,
  NO_READABLE_IMAGES: false,
  PROVIDER_NOT_CONFIGURED: false,
  PROVIDER_QUOTA_EXCEEDED: false,
  PROVIDER_MODEL_UNSUPPORTED: false,
  ANALYSIS_TIMEOUT: false,
  ANALYSIS_FAILED: false,
  NOT_FOUND: true,
  INTERNAL_ERROR: false,
};

/**
 * Reads one flag for a code. An answer outside the vocabulary is treated exactly as the fallback
 * code is, so a future or hostile server cannot make a helper answer with a missing value.
 */
function flagFor(table: Record<ErrorCode, boolean>, code: ErrorCode): boolean {
  return Object.hasOwn(table, code) ? table[code] : table.INTERNAL_ERROR;
}

/**
 * The single sentence a code shows, rendered by components/error-notice.tsx in place of the
 * pending state. The sentence is returned as the shared table holds it, never rewritten here.
 */
export function messageForCode(code: ErrorCode): string {
  return Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : ERROR_MESSAGES.INTERNAL_ERROR;
}

/** Whether components/error-notice.tsx offers a control that re-posts the queued images. */
export function shouldOfferResubmit(code: ErrorCode): boolean {
  return flagFor(RESUBMITTABLE, code);
}

/** Whether features/upload/upload-surface.tsx shows the failure beside the queued files. */
export function isPerFileValidationCode(code: ErrorCode): boolean {
  return flagFor(PER_FILE_VALIDATION, code);
}

/** Whether features/analysis/analysis-surface.tsx leaves for the history surface. */
export function shouldReturnToHistory(code: ErrorCode): boolean {
  return flagFor(RETURNS_TO_HISTORY, code);
}

/**
 * Whether a value names one of the codes the shared error table lists, so a body cannot smuggle
 * in a code the interface has no behaviour for. Membership is decided by the table itself rather
 * than by a second list kept here, so the vocabulary has one source.
 */
function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The body an unreadable failure resolves to: the fallback code with the table's sentence for it,
 * never a sentence assembled from bytes that could not be understood.
 */
function fallbackErrorBody(): ApiErrorBody {
  return { code: 'INTERNAL_ERROR', message: messageForCode('INTERNAL_ERROR') };
}

/**
 * The client's only reader of an error body: turns the text of a failed response into the code the
 * interface acts on and the one sentence it shows.
 *
 * A body is used only when it is a JSON object whose `code` is one the shared error table lists —
 * anything else, whether an HTML page from a proxy, an empty body, a bare value, an array, or a
 * missing, non-string or unknown code, resolves to the fallback body so a caller always receives a
 * code the mapping above can act on. The server's own sentence is kept when it carries text,
 * because a rejection names the file it refused and that sentence belongs beside the queued files;
 * when it is absent or blank, the table's sentence for the same code is used, so no surface shows
 * an empty message.
 *
 * This is the only place a response body is interpreted: api/analysis-api.ts hands the failed
 * body's text here and builds its `ApiError` from the returned code rather than reading the body a
 * second time. The function is pure and total — it reads the string it is given, reaches no
 * network, storage, timer or document, and answers with a body for every input instead of
 * throwing.
 */
export function parseErrorBody(bodyText: string): ApiErrorBody {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fallbackErrorBody();
    }

    const { code, message } = parsed as { code?: unknown; message?: unknown };
    if (!isErrorCode(code)) {
      return fallbackErrorBody();
    }

    const sentence = typeof message === 'string' ? message.trim() : '';
    return { code, message: sentence === '' ? messageForCode(code) : sentence };
  } catch {
    return fallbackErrorBody();
  }
}
