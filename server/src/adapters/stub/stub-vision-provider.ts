/**
 * The offline implementation of the model boundary: recorded provider responses, replayed.
 *
 * It is the second implementation of the `VisionProvider` port, and `STUB_PROVIDER=1` selects it. Its
 * purpose is to let the whole product run — and be proven — with no model credential and no network,
 * while the interpretation of a model answer stays the production one (D4). What it replaces is the
 * transport and nothing else:
 *
 * - the outgoing messages come from the production builders in `adapters/openrouter/`, which apply
 *   the built-in, versioned instruction texts from `adapters/prompts/`;
 * - the recorded body is read by the production envelope reader;
 * - the one-line conformance check, the schema the caller supplied and the single silent retry are
 *   the production client's, so a recording that breaks the contract earns the same retry and ends
 *   in the same `502 ANALYSIS_FAILED` a live answer would;
 * - a scripted provider failure is translated by the production error map, so a refused credential,
 *   a spent quota, an unsupported slug, a provider timeout and a transport failure each arrive as
 *   the one code the shared error table holds for them.
 *
 * `fixtures/recorded/` is its only source of answers, and it reaches nothing else: no socket, no
 * environment, no clock, no instruction text of its own. An extraction call replays the recording
 * named by the submitted image's file stem, and a synthesis call replays the recording its
 * constructor named — the long read by default — so a submission's answer is a function of its
 * inputs and a suite can state which recording produced which reading.
 *
 * Every request that is actually issued is kept on `calls`, in order. The capture happens at the
 * point of issue rather than once per adapter call, which is what makes a retry visible: two entries
 * of the same role mean the first answer broke the one-line contract. A suite reads that list to
 * assert the built-in instruction text, the completion ceiling, the slug and the image part that
 * travelled — the four facts about an outgoing request that a replay on its own would never show.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_TOKENS_EXTRACTION, MAX_TOKENS_SYNTHESIS } from '@trade-read/shared';
import type { z } from 'zod';

import { AppError } from '../../domain/errors.js';
import { createLogger, type Logger } from '../../observability/logger.js';
import type {
  ExtractionAnswer,
  ExtractionRequest,
  ExtractionResult,
  SynthesisAnswer,
  SynthesisRequest,
  SynthesisResult,
  VisionProvider,
} from '../../ports/vision-provider.js';
import { mapProviderFailure, mapProviderStatus } from '../openrouter/error-map.js';
import {
  buildExtractionMessages,
  buildSynthesisMessages,
} from '../openrouter/openrouter-vision-provider.js';
import {
  type CallRole,
  callWithConformance,
  type ChatMessage,
  type ProviderEnvelope,
  readEnvelope,
  type ValidatedAnswer,
} from '../openrouter/openrouter-client.js';

/**
 * The slug a capture reports when the caller configures none.
 *
 * It is the vision-capable model this build documents as its default, so a capture taken from an
 * unconfigured replay provider is what a capture from the default configuration would be.
 */
export const STUB_DEFAULT_MODEL = 'google/gemini-2.5-flash';

/**
 * The recordings replayed when the caller names no fixture directory.
 *
 * Resolved from this module's own URL rather than from the process working directory, because the
 * API is started from the server package and a relative path would resolve somewhere else. The path
 * below holds in both trees: `server/src/adapters/stub` in the source tree and
 * `server/dist/adapters/stub` in the built one each sit three directories below the repository root,
 * so `fixtures/recorded/` is four levels up from this file either way.
 */
const DEFAULT_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../fixtures/recorded/', import.meta.url),
);

/**
 * The synthesis recording replayed when the caller names none.
 *
 * It is the baseline `LONG`/`RETEST` read the contract suites assert: the answer whose entry,
 * invalidation and targets all resolve to extracted levels of the footprint and GEX recordings, so a
 * replay with no scripted scenario still produces a complete, directional recommendation.
 */
const DEFAULT_SYNTHESIS_SCRIPT = 'synthesis-long';

/** The completion flag a replay reports when a scripted answer does not set one. */
const DEFAULT_FINISH_REASON = 'stop';

/** The prefix every recorded extraction envelope's file name carries. */
const EXTRACTION_PREFIX = 'extraction-';

/** The prefix every recorded synthesis envelope's file name carries. */
const SYNTHESIS_PREFIX = 'synthesis-';

/** The extension every recorded envelope carries. */
const ENVELOPE_EXTENSION = '.json';

/** The prefix a recording of each call role may be named with, used when a name omits it. */
const ROLE_PREFIX: Readonly<Record<CallRole, string>> = {
  extraction: EXTRACTION_PREFIX,
  synthesis: SYNTHESIS_PREFIX,
};

/** The `name` a spent deadline carries, which `isAbortError` recognises as a timeout. */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/** A path separator in the POSIX (`/`) or the Windows (`\`) form. */
const DIRECTORY_SEPARATORS = /[\\/]+/;

/** A leading drive letter, which names a file outside the recordings wherever this runs. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * What a file stem may contain to become a file name: letters, digits, dots, underscores and
 * hyphens, starting with a letter or a digit. A submitted name that would need something else — a
 * leading dot, a space, a separator that survived the split — names no recording, and is refused
 * rather than rewritten into a different image's envelope.
 */
const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The logger an unconfigured provider runs with: it emits nothing, so a replay writes no line. */
const SILENT_LOGGER: Logger = createLogger({ write: () => undefined });

/**
 * A recorded answer: the name of a recording resolved under the fixture directory, or an answer
 * supplied literally.
 *
 * A name may carry a sub-directory of the fixture directory (`adversarial/fenced`), with or without
 * the `.json` extension and with or without this call role's `extraction-`/`synthesis-` prefix.
 */
export type StubScript = string | StubAnswerScript;

/** One answer supplied literally, for a case no recorded envelope covers. */
export interface StubAnswerScript {
  /** The raw model answer: one line of JSON, or deliberately malformed text for a failure case. */
  readonly content: string;

  /** The provider's completion flag; `'stop'` by default, `'length'` to simulate a truncation. */
  readonly finishReason?: string;

  /**
   * The `usage.completion_tokens` figure the replay reports.
   *
   * Absent by default, so the usage-absent path (D14) is the one a scripted answer exercises unless
   * a case asks for a figure; a supplied figure is reported as given and never estimated here.
   */
  readonly completionTokens?: number;
}

/**
 * A provider failure to raise instead of replaying an answer.
 *
 * Every kind is terminal, and none is retried: the retry a conformance failure earns belongs to the
 * production client, and a refused credential, a spent quota, an unsupported slug, a timeout and a
 * transport failure are not faults a second attempt can fix (D11).
 */
export type StubProviderFailure =
  /** A non-2xx provider status: it becomes `PROVIDER_NOT_CONFIGURED`, `PROVIDER_QUOTA_EXCEEDED`,
   * `PROVIDER_MODEL_UNSUPPORTED`, `ANALYSIS_TIMEOUT` or `ANALYSIS_FAILED`, by the production map. */
  | { readonly kind: 'status'; readonly status: number }
  /** A call aborted at the analysis deadline: it becomes `ANALYSIS_TIMEOUT`. */
  | { readonly kind: 'abort' }
  /** A transport that could not complete: it becomes `ANALYSIS_FAILED`. */
  | { readonly kind: 'network' };

/**
 * Everything this adapter can be pointed at; every member is optional.
 *
 * With none supplied it replays the committed recordings from the directory beside the repository,
 * answers the synthesis call with the long read, reports the documented default slug and logs
 * nothing — which is the configuration the application runs under when `STUB_PROVIDER=1` is set.
 */
export interface StubVisionProviderOptions {
  /** The slug a capture reports; {@link STUB_DEFAULT_MODEL} by default. */
  readonly model?: string;

  /** Where a replayed call's outcome is recorded; a logger that emits nothing by default. */
  readonly logger?: Logger;

  /** The directory holding the recordings; the committed `fixtures/recorded` by default. */
  readonly fixturesDir?: string;

  /**
   * The script one image stem replays, keyed by the stem of the submitted file name.
   *
   * A stem with no entry replays `extraction-<stem>`, so only an image whose recording has to be
   * overridden needs an entry here. A sequence is consumed one entry per attempt, and its final
   * entry answers every further attempt.
   */
  readonly extractionScripts?: Readonly<Record<string, StubScript | readonly StubScript[]>>;

  /**
   * The recording the synthesis call replays: a name such as `synthesis-short`,
   * `adversarial/two-line`, or an answer supplied literally.
   *
   * {@link DEFAULT_SYNTHESIS_SCRIPT} by default. A sequence is consumed one entry per attempt, which
   * is how "fails, then succeeds" and "fails twice" are scripted; its final entry answers every
   * further attempt.
   */
  readonly synthesisScript?: StubScript | readonly StubScript[];

  /**
   * A failure to raise instead of replaying, for both call roles.
   *
   * Unset by default. When set, the recording is not read at all and the failure travels the
   * production error map, so the case proves the status table rather than a bypass of it.
   */
  readonly providerFailure?: StubProviderFailure;
}

/**
 * One request this adapter issued, captured where it was issued.
 *
 * The messages, ceiling and slug are the values the production builders produced, so a suite can
 * assert what a live call would have sent without a socket being opened.
 */
export interface CapturedCall {
  /** Which call this was. */
  readonly role: CallRole;

  /** The slug the capture reports, from {@link StubVisionProviderOptions.model}. */
  readonly model: string;

  /** This call's completion ceiling: the extraction or the synthesis limit, from the shared table. */
  readonly maxTokens: number;

  /** The message list the production builder produced for this call, as sent. */
  readonly messages: readonly ChatMessage[];

  /**
   * The analysis the call belongs to, when the caller attached one to the request.
   *
   * The port's request types carry no analysis id, so this is present only for a caller that puts
   * one on the object it passes; it never decides anything about the replay.
   */
  readonly analysisId?: string;
}

/**
 * The replay provider: the port, backed by recordings, with the capture of every request it issued.
 *
 * The constructor fixes the slug its captures report, the logger an outcome is recorded with, the
 * directory recordings are read from and how each call role is scripted; nothing a request carries
 * can change them, so a submission cannot make this adapter answer from another recording than the
 * one its file stem and configured script name. The only state that grows is the capture, which
 * `resetCalls` clears.
 *
 * A recording is read on the first call that needs it and cached by absolute path afterwards, so
 * importing this module costs no disk work and a suite that makes the same call twice reads a file
 * once. The capture is appended on every issue regardless of the cache: the cache shortens the disk
 * work, and it must never shorten the record of what was asked for.
 */
export class StubVisionProvider implements VisionProvider {
  /** The slug a capture reports: the configured one, or {@link STUB_DEFAULT_MODEL}. */
  private readonly model: string;

  /** Where a replayed outcome and an unavailable recording are recorded. */
  private readonly logger: Logger;

  /** The resolved directory every recording name is resolved inside. */
  private readonly fixturesDir: string;

  /** The per-stem overrides; empty when the recordings' own names are enough. */
  private readonly extractionScripts: Readonly<Record<string, StubScript | readonly StubScript[]>>;

  /** How the synthesis call is scripted; `undefined` replays the default recording. */
  private readonly synthesisScript: StubScript | readonly StubScript[] | undefined;

  /** The failure raised instead of replaying, when a case scripts one. */
  private readonly providerFailure: StubProviderFailure | undefined;

  /** Every request issued so far, in issue order. */
  private readonly captured: CapturedCall[] = [];

  /** Recordings already read, by absolute path, so a repeated call reads the disk once. */
  private readonly envelopes = new Map<string, ProviderEnvelope>();

  /**
   * @param options - The slug, the logging seam, the recording directory and the two scripts; see
   *   {@link StubVisionProviderOptions}. Every member is optional, so a provider built with no
   *   argument replays the committed recordings with the documented default slug.
   */
  constructor(options: StubVisionProviderOptions = {}) {
    this.model = options.model ?? STUB_DEFAULT_MODEL;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.fixturesDir = resolvePath(options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    this.extractionScripts = options.extractionScripts ?? {};
    this.synthesisScript = options.synthesisScript;
    this.providerFailure = options.providerFailure;
  }

  /**
   * Every request issued so far, in order, a retry included.
   *
   * The list is copied on every read, so a caller can neither rewrite what was captured nor watch it
   * change under an assertion.
   */
  get calls(): readonly CapturedCall[] {
    return [...this.captured];
  }

  /** Clears the capture between assertions in one suite; the recording cache is left intact. */
  resetCalls(): void {
    this.captured.length = 0;
  }

  /**
   * Reads one image into price levels, from the recording its file stem names.
   *
   * The answer is judged, retried and validated by the production client, and the readability flag
   * is the port's own definition of it: an image whose recording reports no chart is `false`, which
   * is a normal outcome for a submitted screenshot rather than a failure.
   */
  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    assertBudgetRemains(request.remainingMs, request.signal);

    const stem = imageStemOf(request.image.fileName);
    const defaultRecording = `${EXTRACTION_PREFIX}${stem}`;
    const override = this.extractionScripts[stem];

    const answer = await this.replay<ExtractionAnswer>({
      schema: request.schema,
      role: 'extraction',
      maxTokens: MAX_TOKENS_EXTRACTION,
      messages: buildExtractionMessages(request),
      analysisId: analysisIdOf(request),
      scriptFor: (attempt) => scriptAt(attempt, override ?? defaultRecording, defaultRecording),
    });

    return {
      answer: answer.value,
      readable: answer.value.r === 'OK',
      completionTokens: answer.completionTokens ?? undefined,
      callCount: answer.callCount,
    };
  }

  /** Synthesises the trade read from every reading, from the recording the constructor named. */
  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    assertBudgetRemains(request.remainingMs, request.signal);

    const script = this.synthesisScript ?? DEFAULT_SYNTHESIS_SCRIPT;

    const answer = await this.replay<SynthesisAnswer>({
      schema: request.schema,
      role: 'synthesis',
      maxTokens: MAX_TOKENS_SYNTHESIS,
      messages: buildSynthesisMessages(request),
      analysisId: analysisIdOf(request),
      scriptFor: (attempt) => scriptAt(attempt, script, DEFAULT_SYNTHESIS_SCRIPT),
    });

    return {
      // The readings this call was given are the only images the read can rest on, so a recording's
      // stand-in citations are replaced by them before the domain reads `src` as evidence.
      answer: {
        ...answer.value,
        src: citeSubmittedSources(
          answer.value.src,
          request.extractions.map((extraction) => extraction.imageId),
        ),
      },
      completionTokens: answer.completionTokens ?? undefined,
      callCount: answer.callCount,
    };
  }

  /**
   * Issues one call through the production conformance policy and returns its validated answer.
   *
   * The production client owns the retry, so this method owns no loop: `send` is called once, and a
   * second time only when the first answer broke the one-line contract. That is why the capture is
   * appended inside `send` rather than once beside the call — a request is captured when it is
   * issued, so the retry appears as a second entry of the same role and a suite that expects one
   * retry counts two entries.
   *
   * A scripted failure is raised from `send` for the same reason: that is the path a provider
   * failure takes in production. The client maps it, and no failure of that kind is retried.
   */
  private async replay<T>(call: ReplayRequest<T>): Promise<ValidatedAnswer<T>> {
    let attempt = 0;

    return callWithConformance<T>({
      send: async () => {
        attempt += 1;
        this.captured.push({
          role: call.role,
          model: this.model,
          maxTokens: call.maxTokens,
          messages: call.messages,
          analysisId: call.analysisId,
        });

        if (this.providerFailure !== undefined) {
          throw failureAsError(this.providerFailure, this.model);
        }

        return await this.recording(call.scriptFor(attempt), call.role);
      },
      schema: call.schema,
      role: call.role,
      logger: this.logger,
      analysisId: call.analysisId,
      model: this.model,
    });
  }

  /** The envelope one script names: the recording it resolves to, or an answer supplied literally. */
  private async recording(script: StubScript, role: CallRole): Promise<ProviderEnvelope> {
    return typeof script === 'string'
      ? await this.loadRecording(script, role)
      : inlineEnvelope(script);
  }

  /**
   * The recording a script name resolves to, read on first use and served from the cache after that.
   *
   * A name is tried as given and then with this role's prefix, so `short`, `synthesis-short` and
   * `synthesis-short.json` all name one recording. A name that resolves to no readable file is
   * reported on one log line naming every path tried, and raised as `ANALYSIS_FAILED`: a missing
   * recording is a broken fixture rather than an answer, and the response contract must not change
   * because a file is absent. The paths stay on the log line and in the error's cause, never in a
   * response body.
   */
  private async loadRecording(name: string, role: CallRole): Promise<ProviderEnvelope> {
    const tried: string[] = [];

    for (const segments of recordingCandidates(name, role)) {
      const absolutePath = join(this.fixturesDir, ...segments);
      const cached = this.envelopes.get(absolutePath);

      if (cached !== undefined) {
        return cached;
      }

      let raw: string;

      try {
        raw = await readFile(absolutePath, 'utf8');
      } catch (error) {
        tried.push(`${absolutePath} (${reasonOf(error)})`);
        continue;
      }

      const envelope = parseRecording(raw, absolutePath);
      this.envelopes.set(absolutePath, envelope);

      return envelope;
    }

    const detail =
      `no recorded envelope could be read for the ${role} script "${name}"; ` +
      `tried ${tried.join('; ')}`;

    this.logger.error({
      event: 'stub_recording_unavailable',
      role,
      outcome: 'recording_unavailable',
      message: detail,
    });

    throw AppError.analysisFailed(detail);
  }
}

/** One call this adapter replays: what the production client needs, plus how the answer is chosen. */
interface ReplayRequest<T> {
  /** The schema the caller supplied, which the answer must satisfy before it is returned. */
  readonly schema: z.ZodType<T>;

  /** Which call this is, for the capture and the log lines. */
  readonly role: CallRole;

  /** The completion ceiling this role declares, from the shared limits table. */
  readonly maxTokens: number;

  /** The message list the production builder produced for this request. */
  readonly messages: ReadonlyArray<ChatMessage>;

  /** The analysis the call belongs to, when the caller attached one. */
  readonly analysisId: string | undefined;

  /** The scripted answer for one attempt, numbered from one. */
  readonly scriptFor: (attempt: number) => StubScript;
}

/**
 * Builds the replay provider for the composition root.
 *
 * `server/src/index.ts` builds whichever implementation of the port the configuration selects, and
 * this function is the one call it needs there. A suite constructs the class instead, because it has
 * options to pass.
 *
 * @param options - The slug, the logging seam, the recording directory and the two scripts.
 * @returns The replay provider, ready to answer from recordings.
 */
export function createStubVisionProvider(
  options: StubVisionProviderOptions = {},
): StubVisionProvider {
  return new StubVisionProvider(options);
}


/**
 * The scripted answer for one attempt.
 *
 * A single script answers every attempt. A sequence is consumed one entry per attempt, and its final
 * entry answers every attempt beyond its length — which is how "fails, then succeeds" (two entries)
 * and "fails twice" (one entry, or two equal entries) are written with no loop of this adapter's own.
 * An empty sequence falls back to the recording named beside it rather than throwing, because the
 * fallback is the same default a caller that named no script would get.
 */
function scriptAt(
  attempt: number,
  source: StubScript | readonly StubScript[],
  fallback: StubScript,
): StubScript {
  if (!isScriptSequence(source)) {
    return source;
  }

  const entry = source[Math.min(attempt - 1, source.length - 1)];

  return entry ?? fallback;
}

/** True for a sequence of scripts, narrowing to a list whose entries stay as wide as a single script. */
function isScriptSequence(
  source: StubScript | readonly StubScript[],
): source is readonly StubScript[] {
  return Array.isArray(source);
}

/** The envelope of an answer supplied literally, with the defaults a script omits filled in. */
function inlineEnvelope(script: StubAnswerScript): ProviderEnvelope {
  return {
    content: script.content,
    finishReason: script.finishReason ?? DEFAULT_FINISH_REASON,
    completionTokens: script.completionTokens ?? null,
  };
}

/**
 * One recorded body as the envelope the layers above understand.
 *
 * The body is parsed as `unknown` and read by the production envelope reader, so a recording is
 * interpreted exactly as a provider response would be: the answer text, the completion flag and the
 * completion-token figure all come from the same place. A body that will not parse, and a body
 * carrying no answer text, each fail as `ANALYSIS_FAILED` naming the file; the underlying message is
 * reported and its stack is not.
 *
 * The recorded line reaches the one-line conformance check unchanged, so a recording that breaks the
 * contract fails exactly as a live answer would. What the caller is handed is that same answer with
 * its `src` citations aligned to the submission, because a static recording cannot name the ids the
 * server mints (see `citeSubmittedSources`); the prices, the codes and the sentence stay as recorded,
 * and the domain resolves a proposed price by exact equality against the extracted levels (D6).
 */
function parseRecording(raw: string, absolutePath: string): ProviderEnvelope {
  let body: unknown;

  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw AppError.analysisFailed(
      `the recorded envelope "${absolutePath}" is not valid JSON: ${reasonOf(error)}`,
    );
  }

  const envelope = readEnvelope(body);

  if (envelope.content === null) {
    throw AppError.analysisFailed(
      `the recorded envelope "${absolutePath}" carries no answer text at choices[0].message.content`,
    );
  }

  return envelope;
}

/**
 * The files a script name may resolve to, in the order they are tried.
 *
 * A name is split into path segments and every segment is checked before a path is built, so a name
 * can never read outside the recordings: an absolute path, a drive letter, a backslash, or a segment
 * that is empty, `.` or `..` is refused outright. The name as given is tried first, then the same
 * stem with this role's prefix, so a suite may name a recording either way.
 */
function recordingCandidates(name: string, role: CallRole): ReadonlyArray<readonly string[]> {
  const trimmed = name.trim();
  const segments = trimmed.split('/');
  const unusable =
    trimmed === '' ||
    trimmed.startsWith('/') ||
    DRIVE_PREFIX.test(trimmed) ||
    trimmed.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');

  if (unusable) {
    throw AppError.analysisFailed(
      `the recorded envelope name "${name}" must name a file below the recorded fixtures directory`,
    );
  }

  const fileName = segments[segments.length - 1] ?? '';
  const directory = segments.slice(0, -1);
  const stem = fileName.endsWith(ENVELOPE_EXTENSION)
    ? fileName.slice(0, fileName.length - ENVELOPE_EXTENSION.length)
    : fileName;

  if (stem === '') {
    throw AppError.analysisFailed(
      `the recorded envelope name "${name}" carries no file stem, so no recording can be named by it`,
    );
  }

  const prefix = ROLE_PREFIX[role];
  const candidates: string[][] = [[...directory, `${stem}${ENVELOPE_EXTENSION}`]];

  if (!stem.startsWith(prefix)) {
    candidates.push([...directory, `${prefix}${stem}${ENVELOPE_EXTENSION}`]);
  }

  return candidates;
}

/**
 * The stem of a submitted file name: its last path segment with the final extension removed.
 *
 * Only the last segment is used, so a name carrying a directory cannot place the recording somewhere
 * else, and the stem is checked against the characters a recording's name is written with. A name
 * that leaves nothing usable is refused as `ANALYSIS_FAILED` naming the file, because the
 * alternative is replaying a different image's recording and reporting levels the submission never
 * showed.
 */
function imageStemOf(fileName: string): string {
  const segments = fileName.split(DIRECTORY_SEPARATORS);
  const base = segments[segments.length - 1] ?? '';
  const lastDot = base.lastIndexOf('.');
  const stem = lastDot > 0 ? base.slice(0, lastDot) : base;

  if (!STEM_PATTERN.test(stem)) {
    throw AppError.analysisFailed(
      `the image file name "${fileName}" leaves no usable stem, so no recorded extraction envelope ` +
        'can be named for it',
    );
  }

  return stem;
}

/**
 * A scripted provider failure as the domain error the production map chooses.
 *
 * Each kind names the code it produces, so a case asserting the error table reads the same mapping a
 * live failure takes: a status goes through the status table (`PROVIDER_NOT_CONFIGURED` for a
 * refused credential, `PROVIDER_QUOTA_EXCEEDED` for a spent account, `PROVIDER_MODEL_UNSUPPORTED`
 * for an unusable slug, `ANALYSIS_TIMEOUT` for a provider-side timeout or a rate limit, and
 * `ANALYSIS_FAILED` for everything else), an abort is recognised by `isAbortError` as the deadline's
 * own expiry and becomes `ANALYSIS_TIMEOUT`, and a transport failure becomes `ANALYSIS_FAILED`. The
 * abort is built here as an ordinary error carrying the deadline's name rather than as a class of
 * its own, so the one recogniser in the build still decides what an abort is.
 */
function failureAsError(failure: StubProviderFailure, model: string): AppError {
  switch (failure.kind) {
    case 'status':
      return mapProviderStatus(failure.status, { model });

    case 'abort':
      return mapProviderFailure(abortedAtDeadline(), { model });

    case 'network':
      return mapProviderFailure(
        new TypeError('the scripted provider transport could not complete the call'),
        { model },
      );
  }
}

/**
 * The `src` a replayed read stands on, cited by the ids the synthesis call actually carried.
 *
 * A recording is a static file, so it cannot know the ids a submission mints: `synthesis-long.json`
 * cites the canonical ids its extraction envelopes were authored against. A real model answering
 * this request would cite the ids it was handed in the `image_id=` labels, and the domain reads
 * `src` as evidence — a directional read that names fewer than two images the analysis holds is
 * downgraded to `NO_TRADE` by rule 3, which would make every replayed read non-directional. So the
 * citations are substituted here, and nothing else is: the prices, the codes, the confidence and
 * the sentence stay exactly as recorded.
 *
 * The count of citations is preserved — capped at the number of readings — because that is the
 * evidence the recording asserts: a read that cites one image keeps citing one image, so the
 * single-source fixture still earns its downgrade, while a read that cites two keeps naming two
 * distinct images of a two-image submission. An answer whose citations are already ids of this
 * submission, and an answer citing nothing, are returned untouched.
 */
function citeSubmittedSources(
  recordedSources: readonly string[],
  submittedImageIds: readonly string[],
): string[] {
  if (recordedSources.length === 0 || submittedImageIds.length === 0) {
    return [...recordedSources];
  }

  const submitted = new Set(submittedImageIds);

  if (recordedSources.every((source) => submitted.has(source))) {
    return [...recordedSources];
  }

  return submittedImageIds.slice(0, Math.min(recordedSources.length, submittedImageIds.length));
}

/** The error a call aborted at the analysis deadline raises, carrying the name the deadline sets. */
function abortedAtDeadline(): Error {
  const error = new Error('the scripted provider call was aborted at the analysis deadline');
  error.name = TIMEOUT_ERROR_NAME;

  return error;
}

/**
 * Refuses a call whose budget is already spent, before a request is captured or an answer replayed.
 *
 * The production client does the same at the top of its own call: a spent budget issues no request,
 * and a caller's signal that is already aborted ends the call as `ANALYSIS_TIMEOUT` rather than as
 * an answer. The deadline belongs to the domain and is not this adapter's to keep; this only honours
 * the budget and the signal the caller handed over (D11). A remaining budget that is not a positive
 * number is treated as spent rather than trusted, which is what keeps a `NaN` from being read as
 * plenty of time left.
 */
function assertBudgetRemains(remainingMs: number, signal: AbortSignal): void {
  if (signal.aborted || !(remainingMs > 0)) {
    throw AppError.analysisTimeout();
  }
}

/**
 * The analysis a request belongs to, when the caller attached one.
 *
 * The port's request types declare no analysis id, so this reads the property defensively and
 * reports nothing when it is absent or is not a non-empty string. The value reaches a log line and a
 * capture; it never decides which recording answers a call.
 */
function analysisIdOf(request: object): string | undefined {
  const value = (request as { readonly analysisId?: unknown }).analysisId;

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The message of a thrown value, or its rendering when it is not an error. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
