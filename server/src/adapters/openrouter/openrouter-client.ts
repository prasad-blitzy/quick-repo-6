/**
 * The one module in the server that opens a network connection.
 *
 * Every model byte the product sends leaves through `complete`: one chat-completions request to the
 * base the configuration resolved, one bearer credential, the attribution headers the operator set,
 * the configured slug and one completion ceiling per call. Nothing above this file knows a host, a
 * path, an HTTP status or a provider payload, and nothing beside it under `server/src` performs
 * network I/O - the egress guard suite proves that by reading the source.
 *
 * Two decisions live here alone:
 *
 * - The one-line answer contract is decided by `conformance.ts`, and an answer that breaks it is
 *   retried exactly once, silently, before `502 ANALYSIS_FAILED` is raised. A provider failure is
 *   never retried: `error-map.ts` maps it straight through, because a refused credential, a spent
 *   quota, an unknown slug, a provider timeout and a rate limit all have the same answer on the
 *   next attempt, which is the one the operator is told.
 * - The provider's vocabulary stops here. A status, a response body and an abort become the
 *   domain's `AppError`, so the routes above see only the shared error table.
 *
 * The credential is read from the configuration and placed in one header. It appears in no
 * message, no log line and no export of this module, and this module records nothing at all: the
 * caller owns observability, and every diagnostic it could want is already on the error it
 * receives.
 */

import type { z } from 'zod';

import type { ServerConfig } from '../../config/env.js';
import { AppError } from '../../domain/errors.js';
import { type ConformanceReason, type ConformanceResult, parseConformingAnswer } from './conformance.js';
import { mapProviderFailure, mapProviderStatus } from './error-map.js';

/**
 * One part of a message whose content is a list rather than a string.
 *
 * The instruction text travels as a `text` part and an image as a base64 `data:` URL in an
 * `image_url` part, which is the whole of the request vocabulary this build uses. No other part
 * type is declared, so no caller can attach a tool, a function or a file and turn the request into
 * something the prompts do not describe.
 */
export type OpenRouterContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/**
 * One message of a chat-completions request.
 *
 * The role set is the two the prompts need. There is deliberately no `system`-equivalent
 * passthrough beyond the fixed prompt the adapter renders, and no field that could carry a second
 * instruction set: the prompts are the system's, and a request cannot add to, replace or suppress
 * them.
 */
export interface OpenRouterChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string | readonly OpenRouterContentPart[];
}

/**
 * One call this client makes: what to send, the ceiling it must stay under, and how to validate
 * the answer.
 *
 * The schema travels as a value so the client can validate the answer without importing a domain
 * schema, which is what keeps the adapter layer free of the vocabulary the domain owns. The signal
 * is the analysis deadline's, so the remaining budget bounds this call and its one retry together.
 */
export interface OpenRouterCompletionRequest<T> {
  /** The messages to send, in order. The instruction text always comes first. */
  readonly messages: readonly OpenRouterChatMessage[];
  /** This call's `max_tokens` ceiling, from the shared limits module and never from a request. */
  readonly maxTokens: number;
  /** The schema the answer must satisfy before it is returned. */
  readonly schema: z.ZodType<T>;
  /** The deadline's signal for this call; an abort is answered as `504 ANALYSIS_TIMEOUT`. */
  readonly signal: AbortSignal;
}

/** One accepted answer: the parsed value, and the completion tokens the provider charged. */
export interface OpenRouterCompletion<T> {
  /** The answer, already validated by the schema the call supplied. */
  readonly value: T;
  /**
   * `usage.completion_tokens` for the accepted call, or `0` when the provider reported no usable
   * count. It is the figure the document's `synthesisCompletionTokens` is built from.
   */
  readonly completionTokens: number;
}

/** The model boundary of the HTTP layer: one method, one call, one answer. */
export interface OpenRouterClient {
  /**
   * Sends one chat-completions request and returns its validated answer.
   *
   * @throws AppError `PROVIDER_NOT_CONFIGURED` when no credential is configured, the mapped
   *   provider failure for a refused or failed request, `ANALYSIS_TIMEOUT` for a spent budget, and
   *   `ANALYSIS_FAILED` when two consecutive answers break the one-line contract.
   */
  complete<T>(request: OpenRouterCompletionRequest<T>): Promise<OpenRouterCompletion<T>>;
}

/**
 * The transport seam: the one place a request reaches the network.
 *
 * It is the runtime's built-in `fetch` unless a test supplies its own, which is how an outgoing
 * request is captured and asserted without a socket. The type is narrowed to the two arguments
 * this module uses, so a substitute has nothing more to implement than the call it replaces.
 */
export type OpenRouterTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Options of {@link createOpenRouterClient}; every member is a seam with a production default. */
export interface CreateOpenRouterClientOptions {
  /** Replaces the built-in `fetch`; omitted, the runtime's own is used. */
  readonly transport?: OpenRouterTransport;
}

/** The path every model call uses, appended to the configured base. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** The only content type this build sends. */
const JSON_CONTENT_TYPE = 'application/json';

/** The header the credential travels in, as the provider's contract defines it. */
const AUTHORIZATION_HEADER = 'authorization';

/** The credential's prefix inside that header. */
const BEARER_PREFIX = 'Bearer ';

/** Optional attribution headers, sent only when the configuration supplies a value. */
const REFERER_HEADER = 'HTTP-Referer';
const APP_TITLE_HEADER = 'X-Title';

/**
 * Calls per answer: the call itself and the single silent retry the request defines.
 *
 * Two is a limit, not a loop count: an answer that breaks the contract twice is the
 * `502 ANALYSIS_FAILED` the operator is told about, and a third attempt would spend the analysis
 * budget on a provider that has already failed the same way twice.
 */
const MAX_ATTEMPTS = 2;

/** Longest provider response body kept as a diagnostic, in characters. */
const MAX_PROVIDER_MESSAGE_CHARS = 2_000;

/** The completion-token figure when the provider reported none. */
const NO_COMPLETION_TOKENS = 0;

/**
 * The built-in `fetch`, behind the transport type.
 *
 * Naming it here rather than calling it directly at the request site is what makes the request
 * capturable in a test without a socket, and it keeps the single network call in this one place.
 */
const RUNTIME_TRANSPORT: OpenRouterTransport = (url, init) => fetch(url, init);

/**
 * Build the client for one configuration.
 *
 * The configuration is captured rather than read per call, so a request cannot change the slug,
 * the base or the credential it runs under, and `providerConfigured` is decided once from the
 * same object the health route reports.
 */
export function createOpenRouterClient(
  config: ServerConfig,
  options: CreateOpenRouterClientOptions = {},
): OpenRouterClient {
  const transport = options.transport ?? RUNTIME_TRANSPORT;

  return {
    async complete<T>(
      request: OpenRouterCompletionRequest<T>,
    ): Promise<OpenRouterCompletion<T>> {
      const credential = config.openRouterApiKey;

      if (credential === null) {
        throw AppError.providerNotConfigured();
      }

      if (request.signal.aborted) {
        throw AppError.analysisTimeout();
      }

      let lastReason: ConformanceReason | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const outcome = await postCompletion(
          transport,
          config,
          credential,
          request,
        );

        if (outcome.conformance.ok) {
          return {
            value: outcome.conformance.value,
            completionTokens: outcome.completionTokens,
          };
        }

        lastReason = outcome.conformance.reason;
      }

      // Both attempts broke the one-line contract. The reason is the diagnostic the caller logs;
      // the response body keeps the shared sentence, because the model's raw text is never
      // exposed to a caller.
      throw AppError.analysisFailed(
        `the model answer broke the one-line contract on both attempts; last reason ${lastReason ?? 'EMPTY'}`,
      );
    },
  };
}

/** One call's result: the conformance verdict, and the tokens charged for it. */
interface CompletionOutcome<T> {
  readonly conformance: ConformanceResult<T>;
  readonly completionTokens: number;
}

/**
 * Sends one request and judges its answer against the contract.
 *
 * A non-2xx status is mapped to the domain error here rather than returned, so an unusable
 * response never reaches the conformance check, and a thrown or aborted transport is mapped to the
 * same vocabulary. The returned verdict never carries an unvalidated object: a schema violation and
 * a malformed line are one class of failure to the caller, which retries once and then fails.
 */
async function postCompletion<T>(
  transport: OpenRouterTransport,
  config: ServerConfig,
  credential: string,
  request: OpenRouterCompletionRequest<T>,
): Promise<CompletionOutcome<T>> {
  try {
    const response = await transport(
      `${config.openRouterBaseUrl}${CHAT_COMPLETIONS_PATH}`,
      {
        method: 'POST',
        headers: buildHeaders(config, credential),
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          stream: false,
        }),
        signal: request.signal,
      },
    );

    if (!response.ok) {
      throw mapProviderStatus(response.status, {
        model: config.model,
        providerMessage: await providerMessageOf(response),
      });
    }

    const body: unknown = await response.json();
    const choice = firstChoice(body);

    return {
      conformance: parseConformingAnswer(
        answerTextOf(choice),
        finishReasonOf(choice),
        request.schema,
      ),
      completionTokens: completionTokensOf(body),
    };
  } catch (error) {
    // `mapProviderFailure` returns an `AppError` by identity, so the status mapping above and a
    // domain error raised inside this call both keep the code they already carry.
    throw mapProviderFailure(error, { model: config.model });
  }
}

/**
 * The headers of one request.
 *
 * The credential is placed in exactly one header and nothing else on the request can reach it. The
 * attribution headers are the operator's, sent only when the configuration holds a value, so an
 * unset optional variable leaves no empty header behind.
 */
function buildHeaders(
  config: ServerConfig,
  credential: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': JSON_CONTENT_TYPE,
    [AUTHORIZATION_HEADER]: `${BEARER_PREFIX}${credential}`,
  };

  if (config.openRouterReferer !== null) {
    headers[REFERER_HEADER] = config.openRouterReferer;
  }

  if (config.openRouterAppTitle !== null) {
    headers[APP_TITLE_HEADER] = config.openRouterAppTitle;
  }

  return headers;
}

/**
 * The provider's own message for a failed request, bounded and kept as a log diagnostic only.
 *
 * The body is hostile text: it is read defensively, truncated here and sanitised again by
 * `error-map.ts`, and it never reaches a response body. A body that cannot be read at all is
 * simply absent rather than a second failure.
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
 * The first choice of a chat-completions body, or `null` when the body holds none.
 *
 * The body is read as `unknown` on purpose: the provider's shape is not this module's to trust,
 * and a body that carries no choice has to reach the conformance check as an empty answer - which
 * is a failure it retries once - rather than throw an unhelpful `TypeError`.
 */
function firstChoice(body: unknown): Record<string, unknown> | null {
  const choices = asRecord(body)?.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  return asRecord(choices[0]);
}

/**
 * The answer text of one choice.
 *
 * A content string is the shape every model in use returns. A content list of `text` parts is read
 * by joining its text, so a provider that splits an answer across parts still reaches the
 * one-line check with its text intact; anything else yields the empty answer the check rejects.
 */
function answerTextOf(choice: Record<string, unknown> | null): string {
  const content = asRecord(choice?.['message'])?.['content'];

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      const text = asRecord(part)?.['text'];

      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** The provider's completion flag for one choice, or `null` when it reported none. */
function finishReasonOf(choice: Record<string, unknown> | null): string | null {
  const reason = choice?.['finish_reason'];

  return typeof reason === 'string' ? reason : null;
}

/**
 * The completion-token count of one body.
 *
 * A count that is absent, negative, fractional or not a number becomes `0` rather than an error:
 * the figure feeds a document field and a log line, and neither is worth failing an otherwise
 * usable analysis over.
 */
function completionTokensOf(body: unknown): number {
  const tokens = asRecord(asRecord(body)?.['usage'])?.['completion_tokens'];

  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
    ? Math.trunc(tokens)
    : NO_COMPLETION_TOKENS;
}

/** A value read as an object with string keys, or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
