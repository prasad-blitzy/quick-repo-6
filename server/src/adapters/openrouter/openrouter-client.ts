/**
 * The one module in the server that opens a network connection.
 *
 * Every model byte the product sends leaves through this file: one chat-completions request per
 * call, sent to the base the configuration resolved, carrying one bearer credential, the
 * attribution headers the operator set, the configured slug and the caller's completion ceiling.
 * Nothing above the adapter layer knows a host, a path, an HTTP status or a provider payload, and
 * the egress-guard suite proves by reading the source that no second module performs network I/O.
 *
 * Three things live here and nowhere else:
 *
 * - the request itself — the URL, the headers and the body — and the only `fetch` call site in the
 *   build;
 * - the one silent retry, and only of an answer that broke the one-line contract. A refused
 *   credential, a spent quota, an unknown slug, a provider timeout and a rate limit are never
 *   retried, because each has the same answer on a second attempt as on the first and the operator
 *   is told the cause instead (D11);
 * - the wiring of a call's remaining budget to an abort signal, so the single analysis deadline
 *   bounds the call rather than a per-call timeout that could never hold a total (D11).
 *
 * `readEnvelope` and `callWithConformance` are exported because the replay adapter under
 * `adapters/stub/` drives them directly: it feeds recorded provider bodies through the same
 * envelope reading, the same conformance check, the same retry policy and the same error map, so
 * the offline suites exercise the production interpretation of a model answer instead of a second
 * copy of it (D4). Neither function touches HTTP, a URL, a header or the credential, which is what
 * lets them run with no transport at all.
 *
 * The credential is held in one field and placed in one header. It reaches no message, no log line
 * and no return value of this module, and no log call site below is given a header, a request body,
 * a prompt or an image. The raw answer text of a conformance failure is the one content-bearing
 * value a line may carry — without it a malformed answer cannot be diagnosed — and it travels in
 * the `message` field alone.
 */

import { ANALYSIS_BUDGET_MS } from '@trade-read/shared';
import type { z } from 'zod';

import { AppError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

import { type ConformanceReason, parseConformingAnswer } from './conformance.js';
import { mapProviderFailure, mapProviderStatus } from './error-map.js';

/** The request path every model call uses, appended to the configured base. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** The only content type this build sends. */
const JSON_CONTENT_TYPE = 'application/json';

/** The header the credential travels in, as the provider's contract defines it. */
const AUTHORIZATION_HEADER = 'Authorization';

/** The credential's prefix inside that header. */
const BEARER_PREFIX = 'Bearer ';

/** Optional attribution headers, sent only when the configuration supplies a value. */
const REFERER_HEADER = 'HTTP-Referer';
const APP_TITLE_HEADER = 'X-Title';

/**
 * Calls per answer: the call itself and the single silent retry the request defines.
 *
 * Two is a limit rather than a loop count. An answer that breaks the contract twice is the
 * `502 ANALYSIS_FAILED` the operator is told about, and a third attempt would spend the analysis
 * budget on a provider that has already failed the same way twice.
 */
const MAX_ATTEMPTS = 2;

/** Longest provider response body kept as a diagnostic, in characters. */
const MAX_PROVIDER_MESSAGE_CHARS = 200;

/** Trailing slashes on a configured base, which would otherwise double the request separator. */
const TRAILING_SLASHES = /\/+$/;

/** A value made of nothing but whitespace: an unset optional attribution header. */
const BLANK = /^\s*$/;

/** The role of one model call, as the analysis document records it (D14). */
export type CallRole = 'extraction' | 'synthesis';

/** One part of a message whose content is a list rather than a single string. */
export type ChatContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/**
 * One message of a chat-completions request.
 *
 * The instruction text always comes first and the operator's values follow it as labelled data, so
 * a message is a list of parts. Only the two roles a rendered instruction can take are declared:
 * there is no assistant or tool role, and no field that could carry a second instruction set.
 */
export interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: ReadonlyArray<ChatContentPart>;
}

/**
 * The part of a chat-completions response body this build reads.
 *
 * `content` is the answer text, `finishReason` the provider's completion flag — which is how a
 * `max_tokens` truncation arrives — and `completionTokens` the figure the analysis document
 * records as its cost (D14). Each is `null` when the provider reported nothing usable, so the
 * conformance check sees an empty answer rather than a fabricated one.
 */
export interface ProviderEnvelope {
  /** The answer text, or `null` when the body carried no string content. */
  readonly content: string | null;
  /** The provider's completion flag, or `null` when it reported none. */
  readonly finishReason: string | null;
  /** `usage.completion_tokens`, or `null` when absent or unusable. Never estimated here (D14). */
  readonly completionTokens: number | null;
}

/**
 * The transport seam: the one place a request reaches the network.
 *
 * The runtime's own `fetch` satisfies it, and a test substitutes its own to capture the outgoing
 * request with no socket. The signature is narrowed to the two arguments this module uses, so a
 * substitute has nothing more to implement than the call it replaces.
 */
export type OpenRouterTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Everything one client needs; the credential and the slug come from configuration. */
export interface OpenRouterClientOptions {
  /**
   * The bearer credential. Empty means no credential is configured: the server still starts and
   * still answers health, and every model call raises `503 PROVIDER_NOT_CONFIGURED`.
   */
  readonly apiKey: string;
  /** The provider base the request path is appended to, for example a versioned API root. */
  readonly baseUrl: string;
  /** The one vision-capable slug both calls use, reported by the health route as configuration. */
  readonly model: string;
  /** Optional attribution referer, sent only when set to something other than whitespace. */
  readonly referer?: string;
  /** Optional attribution application title, sent only when set to something other than whitespace. */
  readonly appTitle?: string;
  /** Where a call's outcome is recorded; omitted, the client records nothing. */
  readonly logger?: Logger;
  /** Replaces the runtime's `fetch`; that seam is how a captured request is asserted offline. */
  readonly fetch?: OpenRouterTransport;
}

/**
 * One call this client makes: what to send, the ceiling it must stay under, how to validate the
 * answer and how much of the analysis budget is left.
 *
 * The schema travels as a value so the client validates the answer without importing a domain
 * schema, which keeps the adapter layer free of the vocabulary the domain owns.
 */
export interface OpenRouterCompletionRequest<T> {
  /** The messages to send, in order. The instruction text always comes first. */
  readonly messages: ReadonlyArray<ChatMessage>;
  /** This call's `max_tokens` ceiling, from the shared limits module and never from a request. */
  readonly maxTokens: number;
  /** The schema the answer must satisfy before it is returned. */
  readonly schema: z.ZodType<T>;
  /** Which call this is, recorded on the log lines and the document's usage block. */
  readonly role: CallRole;
  /**
   * The budget remaining on the shared analysis deadline when the call starts. The call aborts at
   * it and a spent budget issues no request at all (D11).
   */
  readonly remainingMs: number;
  /** The deadline's own signal, combined with the remaining budget when the call is sent. */
  readonly signal?: AbortSignal;
  /** The analysis the call belongs to, so a log line can be tied to a submission. */
  readonly analysisId?: string;
}

/** What a caller supplies to {@link callWithConformance}: one send per attempt, and the schema. */
export interface CallWithConformanceOptions<T> {
  /**
   * Performs one complete request and returns its envelope. It is called once, and a second time
   * only if the first answer broke the one-line contract: the retry has to re-post, because
   * re-reading the same malformed text could never fix it.
   */
  readonly send: () => Promise<ProviderEnvelope>;
  /** The schema the answer must satisfy; a violation is a conformance failure like any other. */
  readonly schema: z.ZodType<T>;
  /** Which call this is, recorded on the log lines. */
  readonly role: CallRole;
  /** Where outcomes are recorded; omitted, nothing is logged. */
  readonly logger?: Logger;
  /** The analysis the call belongs to. */
  readonly analysisId?: string;
  /**
   * The configured slug, used only to render the one provider-failure message that names it
   * (`PROVIDER_MODEL_UNSUPPORTED`). Never a credential.
   */
  readonly model?: string;
}

/**
 * One accepted answer: the validated value, the tokens the provider charged and the number of
 * calls it took.
 *
 * `callCount` includes the retry, because `imageCallCount` in the analysis document measures what
 * the provider actually charged (D14). `completionTokens` is the provider's own figure and is
 * `null` when it reported none; the estimation fallback belongs to the service that assembles the
 * document, not here.
 */
export interface ValidatedAnswer<T> {
  /** The answer, already validated by the schema the call supplied. */
  readonly value: T;
  /** `usage.completion_tokens` for the accepted call, or `null` when the provider reported none. */
  readonly completionTokens: number | null;
  /** Calls issued for this answer, the one silent retry included. Always at least one. */
  readonly callCount: number;
}

/**
 * The configuration the client runs under, structurally.
 *
 * It is declared here rather than imported from `config/env.js` so the adapter depends on the four
 * values it needs and not on the module that parses the environment: a resolved configuration
 * satisfies this interface as it stands. The names are the configuration's own, so the mapping in
 * {@link createOpenRouterClient} is checkable by eye.
 */
export interface OpenRouterConfiguration {
  /** The model credential configuration resolved; `null` when unset, so no provider is configured. */
  readonly openRouterApiKey: string | null;
  /** `OPENROUTER_BASE_URL` resolved, with trailing slashes already stripped by configuration. */
  readonly openRouterBaseUrl: string;
  /** `OPENROUTER_REFERER` resolved; `null` when unset. */
  readonly openRouterReferer: string | null;
  /** `OPENROUTER_APP_TITLE` resolved; `null` when unset. */
  readonly openRouterAppTitle: string | null;
  /** `OPENROUTER_MODEL` resolved. */
  readonly model: string;
}

/** Options of {@link createOpenRouterClient}; both members are seams a test may replace. */
export interface CreateOpenRouterClientOptions {
  /** Replaces the runtime's `fetch`, so an outgoing request can be captured offline. */
  readonly transport?: OpenRouterTransport;
  /** Where a call's outcome is recorded. */
  readonly logger?: Logger;
}

/**
 * Reads the envelope of one chat-completions response body.
 *
 * The body is read as `unknown` on purpose: the provider's shape is not this module's to trust, so
 * every level is narrowed before it is used and a body of an unexpected shape yields an empty
 * envelope rather than a `TypeError`. An empty envelope reaches the conformance check as `EMPTY`,
 * which is a failure the caller retries once and then reports — the outcome a malformed body
 * deserves, and one that keeps the response contract of every route above intact.
 *
 * Content is read as a string only. A body that sends its answer as a list of content parts is
 * treated as carrying no answer rather than having its parts joined: joining guesses at the shape
 * of an answer this build never asks for, and a guess that produced a parseable line would hide the
 * provider's deviation.
 *
 * The function is total and pure: it holds no state, performs no I/O, and returns for every input,
 * `null` and a primitive included. It computes no token count either; the provider's own figure is
 * reported or `null` is, and the estimation fallback belongs to the analysis service (D14).
 *
 * @param body - The parsed response body, of any shape.
 * @returns The answer text, completion flag and completion-token count the body holds.
 */
export function readEnvelope(body: unknown): ProviderEnvelope {
  const choice = firstChoice(body);

  return {
    content: contentOf(choice),
    finishReason: finishReasonOf(choice),
    completionTokens: completionTokensOf(body),
  };
}

/**
 * The first choice of a chat-completions body, or `null` when the body holds none.
 *
 * A body with no `choices` array — a provider error envelope a gateway answered `200` with, or a
 * schema this build has never seen — yields `null`, and the readers below treat that as an absent
 * answer.
 */
function firstChoice(body: unknown): Record<string, unknown> | null {
  const choices = asRecord(body)?.['choices'];

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  return asRecord(choices[0]);
}

/** The answer text of one choice: a string, or `null` for anything else, a content list included. */
function contentOf(choice: Record<string, unknown> | null): string | null {
  const content = asRecord(choice?.['message'])?.['content'];

  return typeof content === 'string' ? content : null;
}

/** The provider's completion flag for one choice, or `null` when it reported none. */
function finishReasonOf(choice: Record<string, unknown> | null): string | null {
  const reason = choice?.['finish_reason'];

  return typeof reason === 'string' ? reason : null;
}

/**
 * The completion-token count of one body.
 *
 * A non-negative finite number is the provider's own figure, truncated to an integer. A count that
 * is absent, negative, fractional beyond that, infinite or not a number at all yields `null`, which
 * is the signal a caller uses to fall back to its estimate — this module never invents a number.
 */
function completionTokensOf(body: unknown): number | null {
  const tokens = asRecord(asRecord(body)?.['usage'])?.['completion_tokens'];

  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
    ? Math.trunc(tokens)
    : null;
}

/**
 * Runs one call and its one silent retry.
 *
 * Each attempt posts the request again through `send` and judges the answer with
 * `parseConformingAnswer`, so a code fence, a second line, surrounding prose, invalid JSON, a
 * truncation flagged by the provider and a schema or vocabulary violation are one class of failure:
 * the answer is not exactly one line of JSON matching the schema the call supplied. That failure
 * earns exactly one silent retry, and a second one ends the analysis as `502 ANALYSIS_FAILED` with
 * nothing partial returned.
 *
 * Every other failure is terminal on the first attempt. A `send` that throws is mapped by
 * `mapProviderFailure` and rethrown without a retry: a refused credential, a spent quota, an
 * unknown slug, a provider timeout, a rate limit and a network error are not faults a second
 * attempt can fix, and each already carries the code the operator needs (D11).
 *
 * @param options - The transport-free send, the schema, the role and the logging seams.
 * @returns The validated value with its completion tokens and the calls it took.
 * @throws AppError The mapped provider failure for a thrown send, or `ANALYSIS_FAILED` when two
 *   consecutive answers break the one-line contract.
 */
export async function callWithConformance<T>(
  options: CallWithConformanceOptions<T>,
): Promise<ValidatedAnswer<T>> {
  const startedAt = Date.now();
  let lastReason: ConformanceReason | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const envelope = await sendEnvelope(options);
    const result = parseConformingAnswer(
      envelope.content,
      envelope.finishReason,
      options.schema,
    );

    if (result.ok) {
      options.logger?.duration(
        {
          event: 'provider_call',
          analysisId: options.analysisId,
          role: options.role,
          tokens: envelope.completionTokens ?? undefined,
          outcome: 'ok',
        },
        startedAt,
      );

      return {
        value: result.value,
        completionTokens: envelope.completionTokens,
        callCount: attempt,
      };
    }

    lastReason = result.reason;
    recordConformanceFailure(options, result.reason, result.message, result.raw, attempt);
  }

  // Both attempts broke the one-line contract. The reason is the diagnostic the log line carries;
  // the message stays the shared sentence, because the provider's raw text never reaches a caller.
  throw AppError.analysisFailed(
    `the model answer broke the one-line contract on both attempts; last reason ${lastReason ?? 'EMPTY'}`,
  );
}

/**
 * One attempt's envelope, with a thrown send mapped onto the shared error table.
 *
 * The mapping happens here rather than in the caller so the retry loop sees only two outcomes: an
 * envelope to judge, or a domain error that ends the call. `mapProviderFailure` returns an
 * `AppError` by identity, so a status mapped inside `send`, or a domain error raised there, keeps
 * the code it already carries instead of being flattened into a generic failure.
 */
async function sendEnvelope<T>(
  options: CallWithConformanceOptions<T>,
): Promise<ProviderEnvelope> {
  try {
    return await options.send();
  } catch (error) {
    throw mapProviderFailure(error, { model: options.model ?? '' });
  }
}

/**
 * Records one rejected answer.
 *
 * The raw answer text travels in `message` and nowhere else: a malformed answer cannot be
 * diagnosed without it, and it is the only content-bearing value any log line of this module is
 * given. The request body, the headers, the prompt text, the credential and the image bytes are
 * never passed to the logger from here, and the logger's own field set has no slot that could hold
 * them.
 *
 * The failure being retried is recorded at `warn`, because it is not yet a failure of the analysis —
 * it is the silent retry the contract allows — and the second failure is recorded at `error`, since
 * the analysis ends there.
 */
function recordConformanceFailure<T>(
  options: CallWithConformanceOptions<T>,
  reason: ConformanceReason,
  message: string,
  raw: string,
  attempt: number,
): void {
  const line = {
    event: 'provider_conformance_failed',
    analysisId: options.analysisId,
    role: options.role,
    reason,
    message: `${message} Raw answer: ${raw}`,
  };

  if (attempt < MAX_ATTEMPTS) {
    options.logger?.warn(line);
    return;
  }

  options.logger?.error(line);
}

/**
 * The runtime's own `fetch`, behind the transport type.
 *
 * Naming it once, here, is what keeps this module the only network call site in the build while
 * still letting a test replace the transport: a request is captured by supplying `fetch` to the
 * constructor, and every attempt — the retry included — goes through whatever was supplied.
 */
const RUNTIME_TRANSPORT: OpenRouterTransport = (url, init) => globalThis.fetch(url, init);

/**
 * The configured OpenRouter client: one request per call, one silent retry, one abort signal.
 *
 * It is constructed once per process from the resolved configuration and holds no state that a
 * request can change, so a submission cannot alter the slug, the base or the credential it runs
 * under. Nothing here reads the environment; every value arrives through the constructor.
 */
export class OpenRouterClient {
  /** The bearer credential; empty when no provider is configured. */
  private readonly apiKey: string;

  /** The base the request path is appended to, with no trailing slash. */
  private readonly baseUrl: string;

  /** The one vision-capable slug both calls use. */
  private readonly model: string;

  /** Optional attribution referer, or `null` when the operator set none. */
  private readonly referer: string | null;

  /** Optional attribution application title, or `null` when the operator set none. */
  private readonly appTitle: string | null;

  /** Where a call's outcome is recorded, or `undefined` when nothing is. */
  private readonly logger: Logger | undefined;

  /** The transport: the runtime's `fetch`, or the substitute a test supplied. */
  private readonly transport: OpenRouterTransport;

  /**
   * @param options - The credential, the base, the slug, the optional attribution headers, and the
   *   logging and transport seams. Every member is copied, so a caller cannot change this client's
   *   configuration afterwards.
   */
  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = trimTrailingSlashes(options.baseUrl.trim());
    this.model = options.model.trim();
    this.referer = optionalHeaderValue(options.referer);
    this.appTitle = optionalHeaderValue(options.appTitle);
    this.logger = options.logger;
    this.transport = options.fetch ?? RUNTIME_TRANSPORT;
  }

  /**
   * Sends one chat-completions request and returns its validated answer.
   *
   * The request carries the configured slug, the messages the adapter built, the ceiling the caller
   * declared and `stream: false`, and nothing else: no provider-side JSON mode is requested or
   * relied on, because the conformance check already decides whether an answer is one line.
   *
   * The budget is wired before the request is built. A spent budget issues no request at all; an
   * available one arms a single signal from the deadline's own signal and the remaining
   * milliseconds, and that same signal serves the call and its one retry, so the retry consumes the
   * budget already spent rather than extending it.
   *
   * @param request - The messages, ceiling, schema, role, remaining budget and caller signal.
   * @returns The validated answer with its completion tokens and the calls it took.
   * @throws AppError `PROVIDER_NOT_CONFIGURED` when the client has no usable configuration,
   *   `ANALYSIS_TIMEOUT` when the budget is spent or the call is aborted, the mapped provider
   *   failure for a refused or failed request, and `ANALYSIS_FAILED` when two consecutive answers
   *   break the one-line contract.
   */
  async complete<T>(
    request: OpenRouterCompletionRequest<T>,
  ): Promise<ValidatedAnswer<T>> {
    // No credential, no base and no slug are one fault: the client cannot build a request the
    // provider could answer, and the server still starts and still reports health without them.
    if (this.apiKey === '' || this.baseUrl === '' || this.model === '') {
      throw AppError.providerNotConfigured();
    }

    if (request.signal?.aborted === true) {
      throw AppError.analysisTimeout();
    }

    const signal = this.signalFor(request.remainingMs, request.signal);

    return callWithConformance<T>({
      send: () => this.post(request, signal),
      schema: request.schema,
      role: request.role,
      logger: this.logger,
      analysisId: request.analysisId,
      model: this.model,
    });
  }

  /**
   * The signal one call runs under: the remaining budget, and the deadline's own signal when the
   * caller passed one.
   *
   * `AbortSignal.any` combines them without copying either, so whichever fires first aborts the
   * request, and the abort reaches `mapProviderFailure` as `ANALYSIS_TIMEOUT` — a spent budget never
   * surfaces as a raw `DOMException`. A budget that resolves to nothing throws before any timer is
   * armed, which is what makes a call that begins too late cost no request.
   */
  private signalFor(remainingMs: number, callerSignal: AbortSignal | undefined): AbortSignal {
    const budgetMs = budgetOf(remainingMs);

    if (budgetMs === 0) {
      throw AppError.analysisTimeout();
    }

    const budget = AbortSignal.timeout(budgetMs);

    return callerSignal === undefined
      ? budget
      : AbortSignal.any([callerSignal, budget]);
  }

  /**
   * Sends one request and reads its envelope.
   *
   * A non-2xx response is mapped to the domain error here rather than returned, so an unusable
   * response never reaches the conformance check: the provider's status decides the code the
   * operator sees, and the body it sent is kept only as a bounded diagnostic for the log. A `2xx`
   * whose body is not JSON is a failure too — an answer cannot be judged from a body that will not
   * parse — and a thrown or aborted transport is mapped by the caller's `mapProviderFailure`.
   */
  private async post<T>(
    request: OpenRouterCompletionRequest<T>,
    signal: AbortSignal,
  ): Promise<ProviderEnvelope> {
    const response = await this.transport(`${this.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        stream: false,
      }),
      signal,
    });

    if (!response.ok) {
      throw mapProviderStatus(response.status, {
        model: this.model,
        providerMessage: await providerMessageOf(response),
      });
    }

    return readEnvelope(await jsonBodyOf(response));
  }

  /**
   * The headers of one request.
   *
   * The credential is placed in exactly one header, which is the only place it is ever written. The
   * attribution headers are the operator's and are sent only when configured, so an unset optional
   * variable leaves no empty header behind.
   */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': JSON_CONTENT_TYPE,
      [AUTHORIZATION_HEADER]: `${BEARER_PREFIX}${this.apiKey}`,
    };

    if (this.referer !== null) {
      headers[REFERER_HEADER] = this.referer;
    }

    if (this.appTitle !== null) {
      headers[APP_TITLE_HEADER] = this.appTitle;
    }

    return headers;
  }
}

/**
 * Builds the client for one resolved configuration.
 *
 * This is the composition root's entry point: it maps the five configured values onto the client
 * and passes no environment of its own, so the client holds exactly what the configuration
 * resolved. A credential the configuration reports as absent becomes the empty string, which the
 * client answers as `503 PROVIDER_NOT_CONFIGURED` rather than with a request.
 *
 * @param config - The resolved server configuration.
 * @param options - The logging and transport seams; the production defaults are the runtime's.
 * @returns A client bound to that configuration.
 */
export function createOpenRouterClient(
  config: OpenRouterConfiguration,
  options: CreateOpenRouterClientOptions = {},
): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: config.openRouterApiKey ?? '',
    baseUrl: config.openRouterBaseUrl,
    model: config.model,
    referer: config.openRouterReferer ?? undefined,
    appTitle: config.openRouterAppTitle ?? undefined,
    logger: options.logger,
    fetch: options.transport,
  });
}

/**
 * The milliseconds a call may spend, from the budget the analysis deadline handed down.
 *
 * Zero means the budget is spent, and the caller issues no request at all. A finite remainder is
 * floored to whole milliseconds, raised to at least one — a timer of zero would abort before the
 * request was even sent — and capped at the analysis budget, so a remainder that could not bound
 * anything still leaves a bound in place. A figure that is not a finite number is treated as spent
 * rather than trusted.
 */
function budgetOf(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 0;
  }

  return Math.min(Math.max(1, Math.floor(remainingMs)), ANALYSIS_BUDGET_MS);
}

/** A configured base with its trailing slashes removed, so the request path adds exactly one. */
function trimTrailingSlashes(value: string): string {
  return value.replace(TRAILING_SLASHES, '');
}

/** A configured attribution header as sent, or `null` when it was unset or blank. */
function optionalHeaderValue(value: string | undefined): string | null {
  if (value === undefined || BLANK.test(value)) {
    return null;
  }

  return value.trim();
}

/**
 * The provider's own message for a failed request, bounded and kept as a log diagnostic only.
 *
 * The body is hostile text: it is read defensively, truncated here and sanitised again by
 * `error-map.ts`, and it never reaches a response body. A body that cannot be read at all is simply
 * absent rather than a second failure.
 */
async function providerMessageOf(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();

    return text.length === 0 ? undefined : text.slice(0, MAX_PROVIDER_MESSAGE_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * The parsed body of a response, or an application failure when it will not parse.
 *
 * A body that is not JSON cannot be judged by the conformance check, and a provider that answers a
 * success status with something else is not a fault a retry fixes, so this is terminal on the first
 * attempt.
 */
async function jsonBodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw AppError.analysisFailed('the provider response body was not valid JSON');
  }
}

/** A value read as an object with string keys, or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

