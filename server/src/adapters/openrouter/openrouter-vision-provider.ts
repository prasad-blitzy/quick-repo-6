/**
 * The production implementation of the model boundary: the two request builders that turn a
 * submission into the chat-completions calls a vision model answers.
 *
 * The two calls differ only in the evidence they carry. An extraction call holds the built-in
 * extraction instructions, the one image being read as a base64 image part, and the operator's
 * instrument and context as labelled data; a synthesis call holds the built-in synthesis
 * instructions and every reading, each labelled with the id of the image it came from, with the
 * operator's values labelled beneath them. The instruction text is always the first part of the
 * message and always comes from `adapters/prompts/prompt-library.ts`, so no request field, header or
 * query parameter of any kind can add to it, replace it or suppress it.
 *
 * Three things deliberately do not live here. The HTTP request — its URL, its headers, its
 * `stream: false`, the abort signal armed from the remaining budget — belongs to
 * `openrouter-client.ts`, which is the only module in the build that opens a connection. The
 * one-line conformance check and the single silent retry belong to the same client, so an answer
 * that is malformed or outside the vocabulary is judged once, in one place, whoever asked for it.
 * The completion ceilings belong to the shared limits module, and the slug to configuration; this
 * module reads neither from its caller.
 *
 * What it does here is hand the caller's schema to the client unchanged and return the object the
 * client already validated, so the domain never receives an answer that failed the schema. A
 * failure leaves this boundary as a domain `AppError`, mapped by `error-map.ts`: a refused
 * credential is a configuration fault, a spent quota and a provider rate limit are the codes the
 * shared table holds for them, an unknown slug names the configured one, and a spent analysis
 * budget is a timeout.
 *
 * The credential is used for exactly one thing here — deciding whether a call may be attempted at
 * all — and neither it, nor the configured base, nor anything derived from the image bytes is ever
 * passed to the logger. The only values the log lines carry are the ones `openrouter-client.ts`
 * already limits itself to: the call role, the completion tokens, the outcome and, on a rejected
 * answer, the answer text alone.
 */

import { MAX_TOKENS_EXTRACTION, MAX_TOKENS_SYNTHESIS } from '@trade-read/shared';

import type { ServerConfig } from '../../config/env.js';
import { AppError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';
import type {
  ExtractionRequest,
  ExtractionResult,
  ImageFrame,
  SynthesisRequest,
  SynthesisResult,
  VisionProvider,
} from '../../ports/vision-provider.js';
import { getExtractionPrompt, getSynthesisPrompt } from '../prompts/prompt-library.js';
import { renderSubmittedData, renderSynthesisData } from '../prompts/render-input.js';

import { mapProviderFailure } from './error-map.js';
import {
  type ChatContentPart,
  type ChatMessage,
  createOpenRouterClient,
  type OpenRouterCompletionRequest,
  type OpenRouterTransport,
  type ValidatedAnswer,
} from './openrouter-client.js';

/** The scheme every image part's URL starts with, as the provider's content contract defines it. */
const DATA_URL_PREFIX = 'data:';

/** The separator between a data URL's media type and its base64 payload. */
const BASE64_SEGMENT = ';base64,';

/** The role a rendered instruction takes: it speaks to the model, never as the model. */
const INSTRUCTION_ROLE = 'user';

/**
 * Everything the production adapter needs, and nothing it could read the environment for.
 *
 * The configuration is the resolved server configuration — the credential, the base, the optional
 * attribution values and the one slug — so this module holds no default of its own. The logger is
 * required rather than optional because a provider call's outcome and cost are recorded for every
 * call the product makes. The transport is the seam a test replaces to capture an outgoing request
 * with no socket open.
 */
export interface OpenRouterVisionProviderDeps {
  /** The resolved server configuration: the credential, the base, the attribution values, the slug. */
  readonly config: ServerConfig;

  /** Where a call's outcome, duration and token count are recorded. */
  readonly logger: Logger;

  /** Replaces the runtime's own HTTP call, so a captured request can be asserted offline. */
  readonly transport?: OpenRouterTransport;
}

/**
 * Builds the production provider for one resolved configuration.
 *
 * The client is constructed once, here, so every call of the returned provider runs under the same
 * credential, base, slug and attribution headers; nothing a request carries can change them. The
 * returned object is the port itself: two methods, each applying the built-in instructions and each
 * returning an answer that already satisfies the schema the caller supplied.
 *
 * @param deps - The resolved configuration, the logger and the optional transport seam.
 * @returns The model boundary backed by the configured provider.
 */
export function createOpenRouterVisionProvider(
  deps: OpenRouterVisionProviderDeps,
): VisionProvider {
  const client = createOpenRouterClient(deps.config, {
    logger: deps.logger,
    transport: deps.transport,
  });

  /**
   * Sends one requested call and returns its validated answer.
   *
   * A missing credential is refused before any request is built, which is what lets the server
   * start, answer health and report the absence instead of failing at boot. Every other failure is
   * handed to `mapProviderFailure`, which returns an `AppError` by identity and turns anything else
   * — an aborted call, a failed connection, an unexpected throw — into the code the shared error
   * table holds for it, so no failure escapes this boundary as a raw runtime error.
   */
  async function complete<T>(
    request: OpenRouterCompletionRequest<T>,
  ): Promise<ValidatedAnswer<T>> {
    if (!hasCredential(deps.config)) {
      throw AppError.providerNotConfigured();
    }

    try {
      return await client.complete(request);
    } catch (error) {
      throw mapProviderFailure(error, { model: deps.config.model });
    }
  }

  return {
    /**
     * Reads one image into price levels.
     *
     * The answer's readability flag is reported as the port defines it: an image the model found no
     * chart in is `false`, which is a normal outcome for a submitted screenshot rather than an
     * error. The completion figure is the provider's own, absent when it reported none, so the
     * caller — not this module — decides how to account for a missing count.
     */
    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const answer = await complete({
        messages: buildExtractionMessages(request),
        maxTokens: MAX_TOKENS_EXTRACTION,
        schema: request.schema,
        role: 'extraction',
        remainingMs: request.remainingMs,
        signal: request.signal,
      });

      return {
        answer: answer.value,
        readable: answer.value.r === 'OK',
        completionTokens: answer.completionTokens ?? undefined,
        callCount: answer.callCount,
      };
    },

    /** Synthesises the trade read from every reading the extraction calls produced. */
    async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
      const answer = await complete({
        messages: buildSynthesisMessages(request),
        maxTokens: MAX_TOKENS_SYNTHESIS,
        schema: request.schema,
        role: 'synthesis',
        remainingMs: request.remainingMs,
        signal: request.signal,
      });

      return {
        answer: answer.value,
        completionTokens: answer.completionTokens ?? undefined,
        callCount: answer.callCount,
      };
    },
  };
}

/**
 * The messages of one extraction call: the built-in instructions, the image, then the operator's
 * values.
 *
 * The instruction text is the first part of the single message, and the image follows it as a data
 * URL carrying the content type sniffed from the bytes themselves, so the provider is told what the
 * bytes are rather than what a client claimed. The operator's instrument and context come last, as
 * the labelled, framed data `render-input.ts` produces; when neither is present that renderer
 * returns the empty string and no empty part is appended.
 *
 * Exported because the replay adapter under `adapters/stub/` builds the request it captures with
 * this same function: the two implementations of the port must not be able to disagree about what
 * an extraction request holds, and one builder is the only way to keep them from drifting (D4).
 */
export function buildExtractionMessages(request: ExtractionRequest): ReadonlyArray<ChatMessage> {
  const parts: ChatContentPart[] = [
    { type: 'text', text: getExtractionPrompt() },
    { type: 'image_url', image_url: { url: imageDataUrl(request.image) } },
  ];

  const submitted = renderSubmittedData({
    instrument: request.instrument,
    context: request.context,
  });

  if (submitted !== '') {
    parts.push({ type: 'text', text: submitted });
  }

  return [{ role: INSTRUCTION_ROLE, content: parts }];
}

/**
 * The messages of the one synthesis call: the built-in instructions, then every reading labelled by
 * its image id and the operator's values beneath them.
 *
 * Each reading is rendered as the one line of compact JSON the extraction schema already accepted,
 * reproduced character for character, so the model reads back exactly the prices and codes it
 * produced rather than a re-worded summary of them. The renderer labels the readings and frames the
 * whole block as data, and returns the empty string only when there is nothing at all to send.
 *
 * Exported for the same reason as {@link buildExtractionMessages}: the replay adapter captures the
 * synthesis request it answers, and it builds that request here rather than holding a second copy of
 * the message shape (D4).
 */
export function buildSynthesisMessages(request: SynthesisRequest): ReadonlyArray<ChatMessage> {
  const parts: ChatContentPart[] = [{ type: 'text', text: getSynthesisPrompt() }];

  const evidence = renderSynthesisData({
    extractions: request.extractions.map((extraction) => ({
      imageId: extraction.imageId,
      line: JSON.stringify(extraction.answer),
    })),
    instrument: request.instrument,
    context: request.context,
  });

  if (evidence !== '') {
    parts.push({ type: 'text', text: evidence });
  }

  return [{ role: INSTRUCTION_ROLE, content: parts }];
}

/**
 * One image as an inline data URL.
 *
 * The frame carries the bytes themselves and the content type sniffed from them, so the encoding is
 * this adapter's work and nothing above it handles base64. The result is held only for the length of
 * the call it belongs to: it is never logged, never returned and never persisted.
 */
function imageDataUrl(image: ImageFrame): string {
  const payload = Buffer.from(image.bytes).toString('base64');

  return `${DATA_URL_PREFIX}${image.contentType}${BASE64_SEGMENT}${payload}`;
}

/**
 * Whether a credential is configured, judged on presence alone.
 *
 * Configuration resolves an unset or blank value to `null`, and a value that carries only whitespace
 * cannot be a usable credential either, so both are treated as absent: the provider is not
 * configured and the call is refused before a request is built.
 */
function hasCredential(config: ServerConfig): boolean {
  return config.openRouterApiKey !== null && config.openRouterApiKey.trim() !== '';
}
