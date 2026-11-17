/**
 * The offline implementation of the model boundary: recorded provider responses, replayed.
 *
 * This adapter is not a mock bolted onto a suite. It is the second implementation of the port,
 * selected by configuration, and it answers with whole recorded chat-completions envelopes —
 * `choices[0].message.content`, `finish_reason` and `usage` — so every layer that reads a model
 * answer runs exactly as it does in production: the envelope reader, the one-line conformance
 * check, the schema the caller supplied, the single silent retry and the mapping of a failure to a
 * domain error are the production ones, driven from here rather than copied. A recorded answer that
 * breaks the contract therefore produces the same one retry and the same `502 ANALYSIS_FAILED` a
 * live answer would.
 *
 * The two calls choose their recording differently, because that is what the two calls know. An
 * extraction call reads one image, so its recording is the one belonging to that image's file name:
 * `extraction-<stem>.json`, where the stem is the file name without its extension. A synthesis call
 * reads the whole set of readings, so its recording is named by the caller — `synthesis-<name>.json`
 * — and defaults to the long script the product's calibration is recorded against.
 *
 * Every request handed to this adapter is kept, in arrival order, on the returned provider's `calls`
 * view, so a suite can assert what the domain actually asked for: which image, in which order, and
 * which of the operator's values travelled with it. The capture is a snapshot on every read, so a
 * caller can neither rewrite what was recorded nor watch it change under an assertion.
 *
 * It performs no network I/O, reads no environment, holds no clock and writes nothing. Both the
 * fixture directory and the synthesis script are injected, so a suite can point it at its own
 * recordings; the default directory is derived from this module's own location rather than from the
 * process working directory, because the API is started from the server package, not the repository
 * root. A recording that is missing, will not parse or carries no answer text fails as a domain
 * error naming the file, never as a raw filesystem or parser error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { z } from 'zod';

import { AppError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';
import type {
  ExtractionAnswer,
  ExtractionRequest,
  ExtractionResult,
  SynthesisAnswer,
  SynthesisRequest,
  SynthesisResult,
  VisionProvider,
} from '../../ports/vision-provider.js';
import {
  callWithConformance,
  type ProviderEnvelope,
  readEnvelope,
  type ValidatedAnswer,
} from '../openrouter/openrouter-client.js';

/**
 * The recordings replayed when the caller names no directory.
 *
 * Resolved from this module's own URL, so it holds in both trees: `server/src/adapters/stub` in the
 * source tree and `server/dist/adapters/stub` in the built one each sit three directories below the
 * repository root, which puts `fixtures/recorded/` four levels up from this file either way. The
 * process working directory is deliberately not consulted: the server is started from its own
 * package, where a relative path would resolve somewhere else.
 */
const DEFAULT_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../fixtures/recorded/', import.meta.url),
);

/** The synthesis script replayed when the caller names none. */
const DEFAULT_SYNTHESIS_SCRIPT = 'long';

/** The prefix every recorded extraction envelope's file name carries. */
const EXTRACTION_PREFIX = 'extraction-';

/** The prefix every recorded synthesis envelope's file name carries. */
const SYNTHESIS_PREFIX = 'synthesis-';

/** The extension every recorded envelope carries. */
const ENVELOPE_EXTENSION = '.json';

/** A path separator in either the POSIX (`/`) or the Windows (`\`) form. */
const DIRECTORY_SEPARATORS = /[\\/]+/;

/**
 * What a file stem may contain to be turned into a file name: letters, digits, dots, underscores and
 * hyphens, starting with a letter or a digit. A submitted name that would need anything else —
 * a leading dot, a space, a separator that survived the split, a NUL — names no recording this
 * adapter can find, and is refused rather than sanitised into a different image's envelope.
 */
const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Everything this adapter can be pointed at.
 *
 * Every member is optional: with none supplied it replays the committed recordings from the
 * directory beside the repository, with the long synthesis script.
 */
export interface StubVisionProviderOptions {
  /** Directory holding the recorded envelopes; the committed `fixtures/recorded` by default. */
  readonly fixturesDir?: string;

  /**
   * Which synthesis recording to replay: a script name (`long`, `short`) or a file below the fixture
   * directory (`synthesis-no-trade.json`, `adversarial/fenced`). The long script by default.
   */
  readonly synthesisEnvelope?: string;

  /** Where a replayed call's outcome is recorded, exactly as the production adapter would. */
  readonly logger?: Logger;
}

/** One extraction call this adapter was given, with the recording it answered from. */
export interface StubExtractionCall {
  /** The role, so a capture can be read in arrival order across both call kinds. */
  readonly role: 'extraction';

  /** The request as the domain built it: the image, the operator's values, the budget, the schema. */
  readonly request: ExtractionRequest;

  /** Absolute path of the recording that answered this call. */
  readonly envelopePath: string;
}

/** One synthesis call this adapter was given, with the recording it answered from. */
export interface StubSynthesisCall {
  /** The role, so a capture can be read in arrival order across both call kinds. */
  readonly role: 'synthesis';

  /** The request as the domain built it: every reading, the operator's values, the budget, the schema. */
  readonly request: SynthesisRequest;

  /** Absolute path of the recording that answered this call. */
  readonly envelopePath: string;
}

/** One replayed call: the role, the request that asked for it and the recording that answered it. */
export type StubVisionProviderCall = StubExtractionCall | StubSynthesisCall;

/**
 * The replay provider: the port itself plus the capture of everything it was asked for.
 *
 * The capture is an addition to the returned object only. The port `VisionProvider` is unchanged, so
 * a caller that only knows the boundary compiles against it exactly as it does against the
 * production adapter.
 */
export interface StubVisionProvider extends VisionProvider {
  /** Every request this provider was given, in arrival order, as a snapshot of the capture. */
  readonly calls: readonly StubVisionProviderCall[];
}

/**
 * Builds the replay provider.
 *
 * @param options - The fixture directory, the synthesis script and the logging seam; see
 *   {@link StubVisionProviderOptions}.
 * @returns The model boundary backed by recorded envelopes, with its capture of every request.
 */
export function createStubVisionProvider(
  options: StubVisionProviderOptions = {},
): StubVisionProvider {
  const fixturesDir =
    options.fixturesDir === undefined
      ? DEFAULT_FIXTURES_DIR
      : resolvePath(options.fixturesDir);
  const script = options.synthesisEnvelope ?? DEFAULT_SYNTHESIS_SCRIPT;
  const calls: StubVisionProviderCall[] = [];

  /**
   * Reads one recorded envelope and judges it with the production conformance policy.
   *
   * The envelope is read once, before the attempt loop, because replaying a recording twice must
   * answer with the same recorded text: a contract-breaking recording then fails both attempts and
   * ends the analysis, which is the behaviour a suite asserts. A recording that cannot be read is
   * refused before any attempt, naming the file.
   */
  async function replay<T>(
    envelopePath: string,
    schema: z.ZodType<T>,
    role: 'extraction' | 'synthesis',
  ): Promise<ValidatedAnswer<T>> {
    const envelope = readRecordedEnvelope(envelopePath);

    return callWithConformance<T>({
      send: () => Promise.resolve(envelope),
      schema,
      role,
      logger: options.logger,
    });
  }

  return {
    get calls(): readonly StubVisionProviderCall[] {
      return [...calls];
    },

    /**
     * Replays the recording that belongs to the image's file name.
     *
     * The recording is chosen by the stem of the submitted file name — `chart-es-5m.png` reads
     * `extraction-chart-es-5m.json` — so the same submission always answers with the same reading,
     * and a suite can state which image produced which levels. The readability flag is the port's
     * own definition of it: an image whose recording reports no chart is `false`, a normal outcome
     * rather than a failure.
     */
    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const envelopePath = extractionEnvelopePath(fixturesDir, request.image.fileName);
      calls.push({ role: 'extraction', request, envelopePath });

      const answer = await replay<ExtractionAnswer>(envelopePath, request.schema, 'extraction');

      return {
        answer: answer.value,
        readable: answer.value.r === 'OK',
        completionTokens: answer.completionTokens ?? undefined,
        callCount: answer.callCount,
      };
    },

    /**
     * Replays the synthesis recording this provider was built with.
     *
     * One recording answers every synthesis call, so a suite scripted with the short read, a
     * downgraded read or one of the contract-breaking answers gets exactly that answer regardless of
     * how many images were submitted.
     */
    async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
      const envelopePath = synthesisEnvelopePath(fixturesDir, script);
      calls.push({ role: 'synthesis', request, envelopePath });

      const answer = await replay<SynthesisAnswer>(envelopePath, request.schema, 'synthesis');

      return {
        answer: answer.value,
        completionTokens: answer.completionTokens ?? undefined,
        callCount: answer.callCount,
      };
    },
  };
}

/**
 * The recording that belongs to one submitted image: `extraction-<stem>.json` in the fixture
 * directory, where the stem is the file name without its extension.
 *
 * Only the last path segment of the submitted name is used, so a name carrying a directory can never
 * place the recording somewhere else, and the stem is checked against the characters a recording's
 * name is written with before a path is built from it.
 */
function extractionEnvelopePath(fixturesDir: string, fileName: string): string {
  return join(fixturesDir, `${EXTRACTION_PREFIX}${imageStemOf(fileName)}${ENVELOPE_EXTENSION}`);
}

/**
 * The stem of a submitted file name: its last path segment with the final extension removed.
 *
 * A name with nothing usable left — an empty name, a name that is only an extension, one carrying a
 * character no recording's name uses — is refused as a domain error naming the file, because the
 * alternative is silently reading a different image's recording.
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
 * The synthesis recording the given script names.
 *
 * The script may be written the way a suite names a recording (`synthesis-short.json`,
 * `adversarial/fenced`) or the way the product names a scenario (`long`), and both resolve to a file
 * below the fixture directory: the name as given is tried first, then the same stem with the
 * envelope prefix. The name is refused outright when it is absolute, carries a backslash, or holds
 * an empty, `.` or `..` segment, so a script can never read outside the recordings.
 */
function synthesisEnvelopePath(fixturesDir: string, script: string): string {
  const { directory, stem } = parseScriptName(script);

  const candidates = [join(fixturesDir, directory, `${stem}${ENVELOPE_EXTENSION}`)];
  if (!stem.startsWith(SYNTHESIS_PREFIX)) {
    candidates.push(join(fixturesDir, directory, `${SYNTHESIS_PREFIX}${stem}${ENVELOPE_EXTENSION}`));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw AppError.analysisFailed(
    `the synthesis envelope script "${script}" names no recorded envelope; tried ` +
      candidates.map((candidate) => `"${candidate}"`).join(', '),
  );
}

/** A script name split into the directory it points at and the file stem it names. */
interface ScriptName {
  /** The directory part of the script, empty when it names a file in the fixture directory itself. */
  readonly directory: string;

  /** The file stem, with any envelope extension already removed. */
  readonly stem: string;
}

/**
 * Splits a script name into the directory part and the file stem, refusing anything that could read
 * outside the recordings: an absolute path, a backslash, or a segment that is empty, `.` or `..`
 * would each name somewhere other than a recording beside its siblings.
 */
function parseScriptName(script: string): ScriptName {
  const trimmed = script.trim();
  const segments = trimmed.split('/');
  const unsafe =
    trimmed === '' ||
    trimmed.startsWith('/') ||
    trimmed.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');

  if (unsafe) {
    throw AppError.analysisFailed(
      `the synthesis envelope script "${script}" must name a file below the recorded fixtures ` +
        'directory',
    );
  }

  const fileName = segments[segments.length - 1] ?? '';
  const stem = fileName.endsWith(ENVELOPE_EXTENSION)
    ? fileName.slice(0, fileName.length - ENVELOPE_EXTENSION.length)
    : fileName;

  if (stem === '') {
    throw AppError.analysisFailed(
      `the synthesis envelope script "${script}" names no file, so no recorded envelope can be read`,
    );
  }

  return { directory: segments.slice(0, -1).join('/'), stem };
}

/**
 * Reads one recorded envelope as the provider envelope the layers above understand.
 *
 * The body is parsed as `unknown` and read by the production envelope reader, so the recorded file
 * is interpreted exactly as a provider response would be: the answer text, the completion flag and
 * the completion-token count come from the same place, and a body of an unexpected shape yields no
 * answer rather than a `TypeError`. A missing file, a body that is not JSON and a body carrying no
 * answer text each fail as a domain error naming the file; the underlying error's message is
 * reported and its stack is not.
 */
function readRecordedEnvelope(envelopePath: string): ProviderEnvelope {
  let raw: string;

  try {
    raw = readFileSync(envelopePath, 'utf8');
  } catch (error) {
    throw AppError.analysisFailed(
      `the recorded provider envelope "${envelopePath}" could not be read: ${reasonOf(error)}`,
    );
  }

  let body: unknown;

  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw AppError.analysisFailed(
      `the recorded provider envelope "${envelopePath}" is not valid JSON: ${reasonOf(error)}`,
    );
  }

  const envelope = readEnvelope(body);

  if (envelope.content === null) {
    throw AppError.analysisFailed(
      `the recorded provider envelope "${envelopePath}" carries no answer text at ` +
        'choices[0].message.content',
    );
  }

  return envelope;
}

/** The message of a thrown value, or its rendering when it is not an error at all. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
