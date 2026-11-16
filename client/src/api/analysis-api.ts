/**
 * The client's only path to the API.
 *
 * Every request the interface makes leaves through this module and none other: it is the single
 * place in `client/src` that calls `fetch`, and the single place a failed response becomes the typed
 * `ApiError` the surfaces catch. A route change, a new error code or a URL-shape change is therefore
 * made here once instead of in each feature.
 *
 * Every URL is relative and derived from the shared `API_BASE_PATH`, because the dev server proxies
 * that prefix to the API (`client/vite.config.ts`). An absolute URL would bypass the proxy and
 * address a host the client may not talk to.
 *
 * Nothing here retries. A failed submission is re-posted only by the operator, through
 * `components/error-notice.tsx`, so a timeout or a provider failure never sends the same screenshots
 * twice behind their back.
 */

import {
  API_BASE_PATH,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
} from '@trade-read/shared';
import type {
  AnalysisDocument,
  AnalysisListResponse,
  ErrorCode,
  HealthResponse,
} from '@trade-read/shared';

import { messageForCode, parseErrorBody } from './errors';

/**
 * The API base path with any trailing slash removed, so a segment is joined with exactly one `/`.
 * Normalised once here rather than at each call site; the imported constant is never mutated.
 */
const BASE = API_BASE_PATH.replace(/\/+$/, '');

/**
 * The only header any request of this module sets. `createAnalysis` deliberately sets no content
 * type: for a `FormData` body the browser must add `multipart/form-data` with the boundary it
 * generates, and a hand-set value without that boundary leaves the server unable to parse the parts.
 */
const ACCEPT_JSON: Readonly<Record<string, string>> = { accept: 'application/json' };

/**
 * The one error shape the client handles.
 *
 * Every failure in this module — a non-2xx answer, a body that cannot be read, a body that is not
 * the shape it claims, or a `fetch` that rejects — is thrown as an `ApiError`, so a surface has
 * exactly one catch shape: `code` selects the sentence and the offered control through
 * `api/errors.ts`, and `status` carries the HTTP status, or `0` when no response arrived at all.
 *
 * The class lives here rather than in `api/errors.ts` on purpose. That module is imported by the
 * surfaces for their message mapping and stays free of the transport; defining the error there and
 * the transport here would make the two imports circular.
 */
export class ApiError extends Error {
  /** The vocabulary code `api/errors.ts` maps to one sentence and one offered control. */
  readonly code: ErrorCode;

  /** The HTTP status of the failed response, or `0` when the request never reached a server. */
  readonly status: number;

  /**
   * @param code - A code from the shared error table.
   * @param status - The HTTP status, or `0` for a request that produced no response.
   * @param message - The sentence the interface shows: the server's own when it sent one, and the
   *   shared sentence for `code` otherwise. No caller has to invent a sentence.
   * @param options - Carries `cause` only, so the original rejection stays reachable for diagnosis
   *   while the message remains the one the operator reads.
   */
  constructor(
    code: ErrorCode,
    status: number,
    message: string = messageForCode(code),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Whether a parsed body is a plain object, so reading a field from it cannot throw. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The structural check on a returned document: an identifier and a list of images. The full schema
 * belongs to the shared contract and is enforced by the server on every response, so this checks
 * only enough to know a document arrived rather than an error page, a bare value or a partial body.
 */
function isAnalysisDocument(value: unknown): value is AnalysisDocument {
  return (
    isRecord(value) && typeof value.analysisId === 'string' && Array.isArray(value.images)
  );
}

/** The structural check on a history page: a list, possibly empty, which is a valid answer. */
function isAnalysisListResponse(value: unknown): value is AnalysisListResponse {
  return isRecord(value) && Array.isArray(value.items);
}

/**
 * The structural check on the health report. The three contract fields are checked and nothing else
 * is read, so a report can never carry a value the shared contract does not declare.
 */
function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    isRecord(value) &&
    value.status === 'ok' &&
    typeof value.providerConfigured === 'boolean' &&
    typeof value.model === 'string'
  );
}

/** One answer, already read: its status and its body as text. */
interface RawResponse {
  readonly status: number;
  readonly bodyText: string;
}

/**
 * Performs exactly one request and resolves with its status and body text, or throws `ApiError`.
 *
 * One `fetch` per call, with no retry, no backoff and no timer: the resubmit control is the only
 * path that repeats a request, and a person presses it. A rejection — offline, a DNS failure, an
 * abort — becomes `ApiError('INTERNAL_ERROR', 0)` with the original kept as `cause`, so the
 * interface shows the sentence it has for an unreadable outcome instead of a bare `TypeError`.
 *
 * The body is always read as text, never through `Response.json()`. A failed response's text goes to
 * `api/errors.ts`, the single reader of an error body: it answers the server's code and sentence
 * when the body carries a code from the shared vocabulary and the fallback code and sentence
 * otherwise, so a raw HTML error page, an unknown code or an empty body cannot reach the interface.
 * Reading text also keeps the `204` a delete answers with readable instead of throwing.
 *
 * @param url - The relative API URL, derived from `API_BASE_PATH`.
 * @param init - The request method and headers; a `FormData` body where one applies.
 * @returns The response status and its body as text.
 */
async function send(url: string, init: RequestInit = {}): Promise<RawResponse> {
  let response: Response;
  let bodyText: string;

  try {
    response = await fetch(url, init);
    bodyText = await response.text();
  } catch (cause) {
    throw new ApiError('INTERNAL_ERROR', 0, undefined, { cause });
  }

  if (!response.ok) {
    const { code, message } = parseErrorBody(bodyText);
    throw new ApiError(code, response.status, message);
  }

  return { status: response.status, bodyText };
}

/**
 * Performs one request through {@link send} and resolves with its parsed JSON body.
 *
 * A body that does not parse becomes `ApiError('INTERNAL_ERROR', status)`, so a truncated or
 * non-JSON success answer is a handled failure rather than a `SyntaxError` escaping into a surface.
 * An empty body — the no-content answer a delete sends — resolves as `undefined` without a parse
 * being attempted.
 *
 * @param url - The relative API URL, derived from `API_BASE_PATH`.
 * @param init - The request method and headers; a `FormData` body where one applies.
 * @returns The parsed body, unvalidated: each caller applies the structural check it needs.
 */
async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const { status, bodyText } = await send(url, init);

  if (bodyText.trim() === '') {
    return undefined as unknown as T;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch (cause) {
    throw new ApiError('INTERNAL_ERROR', status, undefined, { cause });
  }

  return parsed as T;
}

/**
 * The page size actually requested: the shared default when the argument is absent, not a number or
 * not finite, floored, then clamped to at least `1` and at most `HISTORY_LIMIT_MAX`.
 *
 * The clamp mirrors the server's own rule — a value past the cap is clamped rather than rejected,
 * and a bad value falls back to the default — so the client sends a page size the server would have
 * derived for itself, and both bounds come from the shared constants rather than from here.
 *
 * @param limit - The caller's preferred page size; anything unusable falls back to the default.
 * @returns A page size the API accepts.
 */
function resolveLimit(limit?: number): number {
  const requested = Math.floor(limit ?? HISTORY_LIMIT_DEFAULT);

  if (!Number.isFinite(requested)) {
    return HISTORY_LIMIT_DEFAULT;
  }

  return Math.min(Math.max(requested, 1), HISTORY_LIMIT_MAX);
}

/**
 * Submits the queued screenshots and resolves with the completed analysis.
 *
 * `POST {API base path}/analyses`, `multipart/form-data`. The form data is built by
 * `features/upload/use-image-queue.ts` and carries only the images and the optional instrument and
 * context fields; this module appends nothing to it, so no request content can influence the
 * built-in instructions the server applies.
 *
 * One request and no retry: the queue is re-posted only when the operator presses resubmit, so
 * nothing here sends the same images twice on its own.
 *
 * Fails as `ApiError` carrying the server's code — a validation refusal, a provider failure, a
 * timeout — or `INTERNAL_ERROR` when the response is not a document.
 *
 * @param formData - The images and the optional text fields to submit.
 * @returns The stored analysis document, including the recommendation and the level list.
 */
export async function createAnalysis(formData: FormData): Promise<AnalysisDocument> {
  // No content type header: the browser sets `multipart/form-data` with the boundary it generates.
  const body = await requestJson<unknown>(`${BASE}/analyses`, {
    method: 'POST',
    headers: ACCEPT_JSON,
    body: formData,
  });

  if (!isAnalysisDocument(body)) {
    // The server validates every document it sends, so a body that is not one is a broken contract
    // rather than a partial result, and it surfaces as the fallback code instead of a half-filled view.
    throw new ApiError('INTERNAL_ERROR', 200);
  }

  return body;
}

/**
 * Reads one stored analysis.
 *
 * `GET {API base path}/analyses/:analysisId`. The id is percent-encoded, so a value carrying `/`,
 * `?` or a fragment cannot change which resource is read: the server generates every id and refuses
 * one outside its pattern, and the client still never trusts an id it holds.
 *
 * Fails as `ApiError('NOT_FOUND', 404)` when the analysis is gone — the surfaces answer that by
 * returning to history, since no resubmit could recover it — or `INTERNAL_ERROR` when the response
 * is not a document.
 *
 * @param analysisId - The identifier of the stored analysis.
 * @returns The stored analysis document.
 */
export async function getAnalysis(analysisId: string): Promise<AnalysisDocument> {
  const body = await requestJson<unknown>(
    `${BASE}/analyses/${encodeURIComponent(analysisId)}`,
    { method: 'GET', headers: ACCEPT_JSON },
  );

  if (!isAnalysisDocument(body)) {
    throw new ApiError('INTERNAL_ERROR', 200);
  }

  return body;
}

/**
 * Lists stored analyses, newest first.
 *
 * `GET {API base path}/analyses?limit=N`. The page size is always sent: the caller's value clamped by
 * {@link resolveLimit}, which uses the shared default and cap rather than a number written here.
 *
 * An empty list is a valid answer and resolves as `{ items: [] }`. Fails as `ApiError` when the
 * request fails or the response is not a list.
 *
 * @param limit - The preferred page size; absent or unusable values use the shared default.
 * @returns The history page, its items ordered newest first.
 */
export async function listAnalyses(limit?: number): Promise<AnalysisListResponse> {
  const query = new URLSearchParams({ limit: String(resolveLimit(limit)) });
  const body = await requestJson<unknown>(`${BASE}/analyses?${query.toString()}`, {
    method: 'GET',
    headers: ACCEPT_JSON,
  });

  if (!isAnalysisListResponse(body)) {
    throw new ApiError('INTERNAL_ERROR', 200);
  }

  return body;
}

/**
 * Deletes one stored analysis and the image bytes it kept.
 *
 * `DELETE {API base path}/analyses/:analysisId`. The id is percent-encoded for the same reason as in
 * {@link getAnalysis}. Any 2xx is success: the response carries no content, so its body is drained
 * and never parsed, and `Response.json()` is never called on it.
 *
 * Fails as `ApiError('NOT_FOUND', 404)` when the analysis was already gone.
 *
 * @param analysisId - The identifier of the stored analysis to remove.
 */
export async function deleteAnalysis(analysisId: string): Promise<void> {
  await send(`${BASE}/analyses/${encodeURIComponent(analysisId)}`, {
    method: 'DELETE',
    headers: ACCEPT_JSON,
  });
}

/**
 * The relative URL a stored screenshot is read from, for use as an `<img src>` directly.
 *
 * `GET {API base path}/analyses/:analysisId/images/:imageId`. Pure and synchronous: no request is
 * made here, and the result carries no host, so the browser resolves it against the origin it is
 * already on and the dev server's proxy forwards it like every other call.
 *
 * Both ids are percent-encoded, so a crafted id can neither leave the analyses path nor address
 * another host: ids are server-generated, and the client still never trusts one.
 *
 * @param analysisId - The identifier of the analysis the image belongs to.
 * @param imageId - The identifier of the submitted image.
 * @returns A relative URL usable as an image source.
 */
export function analysisImageUrl(analysisId: string, imageId: string): string {
  return `${BASE}/analyses/${encodeURIComponent(analysisId)}/images/${encodeURIComponent(imageId)}`;
}

/**
 * Reports whether the API is up, whether a model credential is configured, and which model is set.
 *
 * `GET {API base path}/health`. This is the only source of `providerConfigured` and of the model slug
 * for the interface, and it can expose nothing else: the module reads no environment, sends no
 * credential and no header beyond the accept header, and returns only the three fields the shared
 * contract declares.
 *
 * A rejection means the provider state is unknown, not that the application is broken: callers treat
 * it as such and carry on, which is why this surfaces as `ApiError` instead of being swallowed.
 *
 * @returns The service report.
 */
export async function getHealth(): Promise<HealthResponse> {
  const body = await requestJson<unknown>(`${BASE}/health`, {
    method: 'GET',
    headers: ACCEPT_JSON,
  });

  if (!isHealthResponse(body)) {
    throw new ApiError('INTERNAL_ERROR', 200);
  }

  // Rebuilt from the three contract fields rather than passed through, so a value a surface holds
  // can never carry a field the contract does not declare.
  return {
    status: body.status,
    providerConfigured: body.providerConfigured,
    model: body.model,
  };
}
