/**
 * The live provider check: the one suite in this build that reaches the real OpenRouter provider.
 *
 * It is collected solely by `server/vitest.live.config.ts` and run solely by `npm run test:live`.
 * `server/vitest.config.ts` excludes `test/live/**` and selects the replay provider, so this file is
 * never part of `npm test`: the offline suites must pass with no credential and no network, while
 * this one must fail loudly instead of skipping when there is nothing real to check. There is no
 * skip, no retry annotation and no conditional test here — a failure is a real failure.
 *
 * It owns the live halves of two success criteria (AAP §0.6.6):
 *
 * - criterion 3: every provider answer a real run parses is exactly one line, and the stored
 *   `modelUsage.synthesisCompletionTokens` is at most `MAX_TOKENS_SYNTHESIS`;
 * - criterion 10: a three-image submission repeated three times, each run finishing inside
 *   `ANALYSIS_BUDGET_MS`, reporting the observed maximum latency and the observed maximum token
 *   count. Maxima, never a percentile: three runs cannot support a distribution, so no mean, p95 or
 *   other statistic is computed anywhere below.
 *
 * The committed screenshots are rendered pages rather than genuine trading-platform captures. The
 * offline suites therefore prove behaviour and wiring, while legibility of a real chart read by a
 * real model is proven here and nowhere else. Nothing below asserts an expected price, side, timing,
 * confidence or summary: a real model reading a real chart may legitimately return `NO_TRADE`/`WAIT`,
 * and that is a pass (rule 5).
 *
 * Two shapes are this suite's own. The recorder observes the provider's answers through the adapter's
 * transport seam and keeps the answer text and completion count alone — never a request body, a
 * header, a credential or an image payload — so no failure message can echo one. And the run
 * accounting treats an answer that breaks the one-line rule as permitted only when the adapter
 * retried that call, which is the mechanism the product itself uses (D11).
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ANALYSIS_BUDGET_MS,
  API_BASE_PATH,
  MAX_IMAGES,
  MAX_LONG_EDGE_PX,
  MAX_TOKENS_EXTRACTION,
  MAX_TOKENS_SYNTHESIS,
  type AnalysisDocument,
  type AnalysisListResponse,
} from '@trade-read/shared';

import {
  type OpenRouterTransport,
  readEnvelope,
} from '../../src/adapters/openrouter/openrouter-client.js';
import { createOpenRouterVisionProvider } from '../../src/adapters/openrouter/openrouter-vision-provider.js';
import { loadConfig, type ServerConfig } from '../../src/config/env.js';
import { analysisDocumentSchema } from '../../src/domain/schemas.js';
import { createLogger } from '../../src/observability/logger.js';
import { buildTestApp, type TestApp } from '../helpers/build-test-app.js';
import { screenshotAttachment, type ScreenshotStem } from '../helpers/fixtures.js';
import { createTempDataDir, type TempDataDir } from '../helpers/temp-data-dir.js';

/**
 * The readable screenshot fixtures one live submission carries, in submission order.
 *
 * Three images rather than one is the submission criterion 10 describes: it makes the analysis span
 * several extraction calls plus the synthesis under one deadline, which is the only shape in which a
 * per-call timeout could hide. They are the footprint, GEX and volume-profile pages, so the model is
 * asked to read three different chart kinds into one read — the combination the request names.
 */
const LIVE_IMAGE_STEMS: readonly ScreenshotStem[] = [
  'footprint-es-5m',
  'gex-es-levels',
  'volume-profile-es',
];

/**
 * Submissions per live run.
 *
 * A property of this check rather than a bound of the product, which is why it is declared here and
 * not in the shared limits module: it exists so the reported latency and token maxima rest on more
 * than one observation.
 */
const RUN_COUNT = 3;

/**
 * The runtime's own `fetch`, captured once at module load and before anything is injected.
 *
 * The recorder below calls this, so what the provider sends is what the network receives; the seam
 * replaces the naming of the transport only, never the request.
 */
const realFetch = globalThis.fetch.bind(globalThis);

/** Which of the two calls one captured answer belongs to. `unknown` is a finding, not a third role. */
type CapturedRole = 'extraction' | 'synthesis' | 'unknown';

/**
 * One provider answer as the recorder observed it.
 *
 * The four fields are the measurement: which call it was, the ceiling the request declared, the
 * answer text the provider returned and the completion count it charged. The request that produced
 * them — its body, its headers, its credential and its encoded image part — is deliberately absent,
 * because a measurement that also stored the request would put all three into a failure message.
 */
interface CapturedCall {
  /** The role inferred from the declared ceiling, or `unknown` when the ceiling is not a known one. */
  readonly role: CapturedRole;
  /** The request's `max_tokens`, or `MISSING_CEILING` when the body carried no usable one. */
  readonly maxTokens: number;
  /** The answer text, or `null` when the response carried none (an error body, or an empty one). */
  readonly answer: string | null;
  /** `usage.completion_tokens` as the provider reported it, or `null` when it reported none. */
  readonly completionTokens: number | null;
}

/** The ceiling recorded when an outgoing request declares none, which is itself a finding. */
const MISSING_CEILING = -1;

/** Longest answer excerpt any failure message echoes, so a report stays readable. */
const MAX_ANSWER_ECHO_CHARS = 200;

/** Every provider answer captured since the current run started, in the order they arrived. */
const captured: CapturedCall[] = [];

/** The most any failure message may echo of one answer is {@link MAX_ANSWER_ECHO_CHARS}. */
function answerEcho(answer: string | null): string {
  return answer === null ? 'no answer text' : answer.trim().slice(0, MAX_ANSWER_ECHO_CHARS);
}

/** True for a plain object: the shape a parsed request or response body may take. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `max_tokens` one outgoing request declares.
 *
 * The body is parsed only when it is a string, because that is all this adapter ever sends; anything
 * else yields {@link MISSING_CEILING} rather than a guess. The ceiling is how the recorder names the
 * call, so it is the one request field ever read — and it is never retained.
 */
function requestCeilingOf(body: unknown): number {
  if (typeof body !== 'string') {
    return MISSING_CEILING;
  }

  try {
    const parsed: unknown = JSON.parse(body);
    const ceiling = isJsonObject(parsed) ? parsed['max_tokens'] : undefined;

    return typeof ceiling === 'number' && Number.isFinite(ceiling) ? ceiling : MISSING_CEILING;
  } catch {
    // A body that will not parse is recorded as an unknown ceiling and reported by the assertion,
    // never thrown from inside the transport: a measuring instrument must not alter the call.
    return MISSING_CEILING;
  }
}

/**
 * Which call a request with this ceiling is.
 *
 * The ceilings come from the shared limits module, so the two roles are recognised by the product's
 * own constants rather than by copies of them; a third value means the adapter changed its cost bound
 * and is reported as `unknown`.
 */
function roleForCeiling(maxTokens: number): CapturedRole {
  if (maxTokens === MAX_TOKENS_SYNTHESIS) {
    return 'synthesis';
  }

  return maxTokens === MAX_TOKENS_EXTRACTION ? 'extraction' : 'unknown';
}

/** One response's answer text and completion count, read without consuming the response itself. */
interface ObservedEnvelope {
  readonly answer: string | null;
  readonly completionTokens: number | null;
}

/**
 * Reads the answer and completion count out of one response, through the build's own envelope reader.
 *
 * The copy is read so the response the adapter receives is untouched; the reading itself is
 * `readEnvelope` rather than a second interpretation of the provider's shape (D4). A body that is not
 * JSON — a provider error envelope, or something this build has never seen — yields an empty
 * observation, which reaches the assertions as a null answer instead of a decode failure.
 */
async function observeEnvelope(response: Response): Promise<ObservedEnvelope> {
  try {
    const body: unknown = await response.clone().json();
    const envelope = readEnvelope(body);

    return { answer: envelope.content, completionTokens: envelope.completionTokens };
  } catch {
    return { answer: null, completionTokens: null };
  }
}

/**
 * The transport the provider runs on: the real network, plus one measurement per attempt.
 *
 * The response is returned to the adapter untouched and unread, which is what keeps this a recorder
 * rather than a second client. A retry is a second attempt of the same `complete` call, so it is
 * captured as its own entry — that is how the assertions below can tell a retried answer from an
 * accepted one.
 */
const recordingTransport: OpenRouterTransport = async (url, init) => {
  const maxTokens = requestCeilingOf(init.body);
  const response = await realFetch(url, init);
  const observed = await observeEnvelope(response);

  captured.push({
    role: roleForCeiling(maxTokens),
    maxTokens,
    answer: observed.answer,
    completionTokens: observed.completionTokens,
  });

  return response;
};

/**
 * What is wrong with one answer judged as a single line of JSON, or `null` when nothing is.
 *
 * This restates the contract the server enforces, so a provider that has started writing prose, a
 * fence or two lines is caught by the suite that watches the real answers rather than only by the
 * offline fixtures. It judges the text alone; a schema or vocabulary violation is the adapter's
 * check, and this suite asserts the document it produced instead.
 */
function oneLineViolationOf(answer: string | null): string | null {
  if (answer === null) {
    return 'the response carried no answer text';
  }

  if (answer.includes('\n')) {
    return 'the answer spans more than one line';
  }

  if (answer.includes('\r')) {
    return 'the answer carries a carriage return';
  }

  if (answer.includes('```')) {
    return 'the answer carries a code fence';
  }

  const trimmed = answer.trim();

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return 'the answer is not one bare JSON object';
  }

  try {
    JSON.parse(trimmed);
  } catch {
    return 'the answer is not valid JSON';
  }

  return null;
}

/**
 * The configuration this run resolved, through the build's only environment reader.
 *
 * Nothing below reads the environment: the credential, the base, the attribution values and the slug
 * arrive here exactly as they would for an operator running the server, so the live check exercises
 * the configuration path rather than a second copy of it (D3, D4).
 */
const config: ServerConfig = loadConfig();

/** Every line the provider adapter logged, captured so the secrecy check can read them. */
const providerLogLines: string[] = [];

/**
 * The provider's own writer.
 *
 * `createOpenRouterVisionProvider` requires a logger and the test-app helper exposes none — it keeps
 * only the lines the application itself wrote — so this suite passes the build's single writer and
 * holds its lines here. Using `createLogger` rather than a hand-written sink keeps the logger's
 * redaction pass in the path: a credential-shaped value emitted by the adapter is redacted here
 * exactly as it would be in production.
 */
const providerLogger = createLogger({
  write: (line: string): void => {
    providerLogLines.push(line);
  },
});

/** The data directory this run owns, created in `beforeAll` and removed in `afterAll`. */
let temp: TempDataDir | undefined;

/** The application under test, built in `beforeAll` over the live provider. */
let liveAppUnderTest: TestApp | undefined;

/** The application under test, or a failure naming the hook that should have built it. */
function app(): TestApp {
  if (liveAppUnderTest === undefined) {
    throw new Error(
      'the live suite has no application: its beforeAll hook did not run to completion, so no ' +
        'submission can be judged',
    );
  }

  return liveAppUnderTest;
}

/**
 * The document a response body holds, or a failure naming every issue the shared schema reports.
 *
 * Validation is the schema the server itself applies before returning or persisting a document, so a
 * divergence between what a real run produced and what the contract allows fails here with the
 * schema's own issues rather than an assertion about a field.
 */
function readDocument(body: unknown, label: string): AnalysisDocument {
  const parsed = analysisDocumentSchema.safeParse(body);

  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues
    .map((issue) => `${issue.path.map((segment) => String(segment)).join('.')}: ${issue.message}`)
    .join('; ');

  expect.fail(`${label} did not hold a document the shared schema accepts: ${issues}`);
}

/**
 * Builds one application over the real provider.
 *
 * The provider is constructed with the resolved configuration, the build's writer and the recording
 * transport, so every attempt of every call of this run is measured. The app is then composed by the
 * same helper the offline suites use, with the credential, the base and the slug pinned to what
 * `loadConfig` resolved and `STUB_PROVIDER` explicitly unset, so the replay adapter cannot be selected
 * even when the surround shell exports the variable.
 */
beforeAll(async () => {
  temp = await createTempDataDir('live-');

  const provider = createOpenRouterVisionProvider({
    config,
    logger: providerLogger,
    transport: recordingTransport,
  });

  liveAppUnderTest = await buildTestApp({
    config: {
      OPENROUTER_API_KEY: config.openRouterApiKey ?? undefined,
      OPENROUTER_BASE_URL: config.openRouterBaseUrl,
      OPENROUTER_MODEL: config.model,
      STUB_PROVIDER: undefined,
      DATA_DIR: temp.dataDir,
    },
    visionProvider: provider,
    dataDir: temp.dataDir,
  });
});

/**
 * Releases the application and its data directory, unconditionally.
 *
 * Both are optional-chained because either hook can fail before its value exists, and a run that
 * fails must still leave no directory behind.
 */
afterAll(async () => {
  await liveAppUnderTest?.cleanup();
  await temp?.cleanup();
});

/** One run's observation, from which the report and the reported maxima are computed. */
interface RunSample {
  /** The run's ordinal, so a reported maximum names the run it came from. */
  readonly run: number;
  /** Wall-clock milliseconds around the submission, provider work included. */
  readonly latencyMs: number;
  /** The figure the stored document records as the synthesis cost (D14). */
  readonly synthesisCompletionTokens: number;
  /** How many price levels the run extracted across every image. */
  readonly levelCount: number;
  /** How many submitted images the model could read at all. */
  readonly analyzedImageCount: number;
  /** Every provider attempt the run issued, conformance retries included. */
  readonly callCount: number;
  /** Whether any call of the run took the one silent retry. */
  readonly retried: boolean;
}

/** Every completed run of this check, in order. */
const samples: RunSample[] = [];

/** Every document a run produced, so the cases after the loop assert on what was stored. */
const documents: AnalysisDocument[] = [];

/**
 * The one report line this suite prints.
 *
 * It reports the observed maximum and minimum of each measurement with the run each came from, never
 * a percentile, mean or p95: with three runs a distribution is not available, and stating one would
 * present a sample as if it described the provider. The line carries no credential, no request body
 * and no image payload — only counts, token figures and durations.
 */
function reportLine(runs: readonly RunSample[]): string {
  const slowest = runs.reduce((worst, sample) =>
    sample.latencyMs > worst.latencyMs ? sample : worst,
  );
  const fastest = runs.reduce((quickest, sample) =>
    sample.latencyMs < quickest.latencyMs ? sample : quickest,
  );
  const heaviest = runs.reduce((most, sample) =>
    sample.synthesisCompletionTokens > most.synthesisCompletionTokens ? sample : most,
  );
  const retriedRuns = runs.filter((sample) => sample.retried).length;
  const perRun = runs
    .map(
      (sample) =>
        `#${String(sample.run)}: ${String(sample.levelCount)} levels, ` +
        `${String(sample.analyzedImageCount)} analysed images, ` +
        `${String(sample.synthesisCompletionTokens)} tokens, ${String(sample.callCount)} calls`,
    )
    .join('; ');

  return (
    `live check passed: ${String(runs.length)} runs of ${String(LIVE_IMAGE_STEMS.length)} images; ` +
    `max latency ${String(Math.round(slowest.latencyMs))} ms (run ${String(slowest.run)}), ` +
    `min latency ${String(Math.round(fastest.latencyMs))} ms, ` +
    `against ANALYSIS_BUDGET_MS=${String(ANALYSIS_BUDGET_MS)} ms; ` +
    `max synthesisCompletionTokens ${String(heaviest.synthesisCompletionTokens)} ` +
    `(run ${String(heaviest.run)}), against MAX_TOKENS_SYNTHESIS=${String(MAX_TOKENS_SYNTHESIS)}; ` +
    `per run ${perRun}; conformance retries observed: ${String(retriedRuns)}; ` +
    `maxima are reported rather than percentiles because ${String(runs.length)} runs cannot ` +
    'support a distribution.'
  );
}

describe('the live run is possible at all — §0.6.6 #3 and #10', () => {
  it('has a real credential, the real adapter and a submission inside the image cap', () => {
    expect(
      config.providerConfigured,
      'the live check needs a real OPENROUTER_API_KEY (export it or put it in .env and run ' +
        '`npm run test:live`); the offline suites need no key — use `npm run test:server`',
    ).toBe(true);

    expect(
      config.stubProvider,
      'STUB_PROVIDER must be unset for the live check, because the replay adapter would answer ' +
        'every call locally and the run would prove nothing',
    ).toBe(false);

    expect(
      LIVE_IMAGE_STEMS.length,
      `this check submits ${String(LIVE_IMAGE_STEMS.length)} images, which must fit inside ` +
        `MAX_IMAGES (${String(MAX_IMAGES)})`,
    ).toBeLessThanOrEqual(MAX_IMAGES);
  });
});

describe('a real model answers inside the budget, in one line — §0.6.6 #3 and #10', () => {
  it(`submits ${String(LIVE_IMAGE_STEMS.length)} images ${String(RUN_COUNT)} times with nothing typed`, async () => {
    for (let run = 1; run <= RUN_COUNT; run += 1) {
      const runLabel = `run ${String(run)}/${String(RUN_COUNT)}`;

      captured.length = 0;

      // One extraction per image plus the synthesis is what an analysis owes the operator, retries
      // aside; it is the baseline the recorder's accounting below is measured against.
      const acceptedCallCount = LIVE_IMAGE_STEMS.length + 1;

      const startedAt = performance.now();
      const submission = request(app().app).post(`${API_BASE_PATH}/analyses`);

      // The drop-and-submit path with nothing typed: no instrument, no context, no prompt field.
      for (const stem of LIVE_IMAGE_STEMS) {
        const attachment = screenshotAttachment(stem);
        submission.attach('images', attachment.bytes, {
          filename: attachment.fileName,
          contentType: attachment.contentType,
        });
      }

      const response = await submission;
      const elapsedMs = performance.now() - startedAt;

      // Only the error body's own two fields: a success body is the whole document, and a failure
      // body carries no stack, no path and no credential.
      expect(
        response.status,
        `${runLabel} answered ${String(response.status)} with code ` +
          `${String(response.body?.code)}: ${String(response.body?.message)}`,
      ).toBe(200);

      expect(
        elapsedMs,
        `${runLabel} took ${String(Math.round(elapsedMs))} ms, over ANALYSIS_BUDGET_MS ` +
          `(${String(ANALYSIS_BUDGET_MS)} ms); one shared deadline must cover every provider call`,
      ).toBeLessThanOrEqual(ANALYSIS_BUDGET_MS);

      const document = readDocument(response.body, `${runLabel}'s response`);
      documents.push(document);

      // Recorder sanity: an observation of nothing would let every assertion below pass vacuously.
      expect(
        captured.length,
        `${runLabel} recorded no provider call: the recorder observed nothing and this run would ` +
          'pass without having reached the provider',
      ).toBeGreaterThan(0);

      expect(
        captured.length,
        `${runLabel} recorded ${String(captured.length)} provider attempts, fewer than the ` +
          `${String(acceptedCallCount)} that one extraction per image plus the synthesis requires`,
      ).toBeGreaterThanOrEqual(acceptedCallCount);

      const unknownCeilings = captured.filter((call) => call.role === 'unknown');
      expect(
        unknownCeilings.map((call) => call.maxTokens),
        `${runLabel} sent ${String(unknownCeilings.length)} request(s) whose max_tokens is neither ` +
          `MAX_TOKENS_EXTRACTION (${String(MAX_TOKENS_EXTRACTION)}) nor MAX_TOKENS_SYNTHESIS ` +
          `(${String(MAX_TOKENS_SYNTHESIS)}): the adapter's declared cost bound has changed`,
      ).toEqual([]);

      const extractionAttempts = captured.filter((call) => call.role === 'extraction').length;
      expect(
        extractionAttempts,
        `${runLabel} issued ${String(extractionAttempts)} extraction attempts but records ` +
          `imageCallCount=${String(document.modelUsage.imageCallCount)}; the recorder and the ` +
          'product must agree on what the provider charged',
      ).toBe(document.modelUsage.imageCallCount);

      const synthesisAttempts = captured.filter((call) => call.role === 'synthesis').length;
      expect(
        synthesisAttempts,
        `${runLabel} issued ${String(synthesisAttempts)} synthesis attempts for one analysis, ` +
          'which cannot be fewer than one',
      ).toBeGreaterThanOrEqual(1);

      // Conformance accounting. An answer that breaks the one-line rule may only be one the adapter
      // rejected and immediately retried (D11), so the number of violations can never exceed the
      // retries taken, and every violation must be followed by another attempt of the same call.
      const retries = captured.length - acceptedCallCount;
      const violations = captured
        .map((call, index) => ({ call, index, violation: oneLineViolationOf(call.answer) }))
        .filter((entry) => entry.violation !== null);
      const firstViolation = violations[0];

      expect(
        violations.length,
        `${runLabel} recorded ${String(violations.length)} answer(s) that are not one line of JSON ` +
          `while taking only ${String(retries)} retr${retries === 1 ? 'y' : 'ies'}, so an ` +
          `unconforming answer was accepted; first offender: ` +
          `${
            firstViolation === undefined
              ? 'none'
              : `${String(firstViolation.violation)} — answer begins "${answerEcho(firstViolation.call.answer)}"`
          }`,
      ).toBeLessThanOrEqual(retries);

      expect(
        captured.length - violations.length,
        `${runLabel} accepted fewer answers than one per call (${String(acceptedCallCount)}), so ` +
          'the document cannot be resting on a reading for every submitted image',
      ).toBeGreaterThanOrEqual(acceptedCallCount);

      for (const violation of violations) {
        const retry = captured[violation.index + 1];
        expect(
          retry === undefined ? 'nothing' : retry.role,
          `${runLabel} accepted an answer that broke the one-line rule (${String(
            violation.violation,
          )}; answer begins "${answerEcho(violation.call.answer)}"), because the next attempt is ` +
            'not another call of the same role',
        ).toBe(violation.call.role);
      }

      // Criterion 3, the cost half: the stored figure is the provider's own usage for the accepted
      // synthesis answer, and it cannot exceed the ceiling the request declared.
      const recordedTokens = document.modelUsage.synthesisCompletionTokens;
      expect(
        recordedTokens,
        `${runLabel} recorded synthesisCompletionTokens=${String(recordedTokens)}, over ` +
          `MAX_TOKENS_SYNTHESIS (${String(MAX_TOKENS_SYNTHESIS)}); when the provider reported no ` +
          'usage this figure is the documented estimate',
      ).toBeLessThanOrEqual(MAX_TOKENS_SYNTHESIS);

      expect(
        recordedTokens,
        `${runLabel} recorded a negative synthesisCompletionTokens (${String(recordedTokens)})`,
      ).toBeGreaterThanOrEqual(0);

      // The accepted synthesis answer is the last synthesis attempt: a retry is always re-posted
      // immediately, so anything earlier of that role is an answer the adapter rejected.
      const acceptedSynthesis = [...captured].reverse().find((call) => call.role === 'synthesis');
      if (acceptedSynthesis?.completionTokens !== null && acceptedSynthesis?.completionTokens !== undefined) {
        expect(
          recordedTokens,
          `${runLabel} recorded synthesisCompletionTokens=${String(recordedTokens)} but the provider ` +
            `reported usage.completion_tokens=${String(acceptedSynthesis.completionTokens)} for the ` +
            'accepted synthesis call',
        ).toBe(acceptedSynthesis.completionTokens);
      }

      // The document's own invariants, all structural: no expected price, side or timing appears here.
      expect(
        document.modelUsage.provider,
        `${runLabel} recorded provider "${String(document.modelUsage.provider)}"; the build has one`,
      ).toBe('openrouter');

      expect(
        document.modelUsage.model,
        `${runLabel} recorded model "${String(document.modelUsage.model)}" but the configured slug ` +
          `is "${config.model}"`,
      ).toBe(config.model);

      expect(
        document.modelUsage.promptVersion,
        `${runLabel} recorded promptVersion "${String(
          document.modelUsage.promptVersion,
        )}", which does not name both built-in instruction versions as ` +
          '`extraction@<version>;synthesis@<version>`',
      ).toMatch(/\bextraction@.+;synthesis@.+/u);

      expect(
        document.images.length,
        `${runLabel} recorded ${String(document.images.length)} images for the ` +
          `${String(LIVE_IMAGE_STEMS.length)} submitted`,
      ).toBe(LIVE_IMAGE_STEMS.length);

      for (const image of document.images) {
        expect(
          Math.max(image.width, image.height),
          `${runLabel} stored ${image.fileName} at ${String(image.width)}x${String(
            image.height,
          )}, whose long edge is over MAX_LONG_EDGE_PX (${String(MAX_LONG_EDGE_PX)})`,
        ).toBeLessThanOrEqual(MAX_LONG_EDGE_PX);
      }

      expect(
        document.modelUsage.imageCallCount,
        `${runLabel} recorded imageCallCount=${String(document.modelUsage.imageCallCount)}, fewer ` +
          `than one extraction per submitted image (${String(LIVE_IMAGE_STEMS.length)})`,
      ).toBeGreaterThanOrEqual(LIVE_IMAGE_STEMS.length);

      // A `200` cannot come from images that were all unreadable — that is `422 NO_READABLE_IMAGES` —
      // so an empty level table would mean the document was assembled without any evidence.
      expect(
        document.levels.length,
        `${runLabel} answered 200 with no levels: a submission whose images were all unreadable is ` +
          'refused with NO_READABLE_IMAGES, so an empty level table means evidence went missing',
      ).toBeGreaterThan(0);

      const levelIds = new Set(document.levels.map((level) => level.levelId));
      const citedLevelIds = [
        document.recommendation.triggerLevelId,
        document.recommendation.entryLevelId,
        document.recommendation.invalidationLevelId,
        ...document.recommendation.targetLevelIds,
      ].filter((levelId) => levelId !== null);

      for (const levelId of citedLevelIds) {
        expect(
          levelIds.has(levelId),
          `${runLabel} cited level ${levelId} in its recommendation, but levels[] holds no such id`,
        ).toBe(true);
      }

      const imageIds = new Set(document.images.map((image) => image.imageId));
      for (const evidence of document.rationale) {
        expect(
          imageIds.has(evidence.imageId),
          `${runLabel} cited image ${evidence.imageId} in its evidence, but images[] holds no such id`,
        ).toBe(true);

        for (const levelId of evidence.levelIds) {
          expect(
            levelIds.has(levelId),
            `${runLabel} cited level ${levelId} in its evidence, but levels[] holds no such id`,
          ).toBe(true);
        }
      }

      // Rule 1: a price exists only on a level, so the recommendation has no price under any name.
      expect(
        Object.keys(document.recommendation).includes('price'),
        `${runLabel} returned a recommendation carrying a price; prices live only in levels[]`,
      ).toBe(false);

      // D7: the trigger is the entry level, and a non-actionable read references no level at all.
      const { recommendation } = document;
      if (recommendation.side === 'NO_TRADE') {
        expect(
          recommendation.timing,
          `${runLabel} returned NO_TRADE with timing ${recommendation.timing}; a read that cannot ` +
            'be acted on is always NO_TRADE with WAIT',
        ).toBe('WAIT');

        expect(
          [
            recommendation.triggerLevelId,
            recommendation.entryLevelId,
            recommendation.invalidationLevelId,
          ],
          `${runLabel} returned NO_TRADE/WAIT while still naming level references`,
        ).toEqual([null, null, null]);

        expect(
          recommendation.targetLevelIds,
          `${runLabel} returned NO_TRADE/WAIT while still naming targets`,
        ).toHaveLength(0);
      } else {
        expect(
          recommendation.entryLevelId,
          `${runLabel} returned ${recommendation.side} with no entry level, so nothing the operator ` +
            'was told to act on exists in levels[]',
        ).not.toBeNull();

        expect(
          recommendation.triggerLevelId,
          `${runLabel} named trigger ${String(recommendation.triggerLevelId)} and entry ` +
            `${String(recommendation.entryLevelId)}; the trigger is the entry level`,
        ).toBe(recommendation.entryLevelId);
      }

      expect(
        document.disclaimer.length,
        `${runLabel} stored an empty disclaimer, which every recommendation surface renders`,
      ).toBeGreaterThan(0);

      samples.push({
        run,
        latencyMs: elapsedMs,
        synthesisCompletionTokens: recordedTokens,
        levelCount: document.levels.length,
        analyzedImageCount: document.images.filter((image) => image.status === 'ANALYZED').length,
        callCount: captured.length,
        retried: captured.length > acceptedCallCount,
      });
    }

    console.info(reportLine(samples));
  });
});

describe('every live analysis is durable and listed newest first — §0.6.6 #8', () => {
  it('serves each stored analysis back and lists them in creation order', async () => {
    expect(
      documents.length,
      `this case needs the ${String(RUN_COUNT)} documents the run above stores; it recorded ` +
        `${String(documents.length)}, so the run that produces them did not complete`,
    ).toBe(RUN_COUNT);

    // A second store instance over the same directory holds no cache, so it is the restart case: what
    // it finds is what actually reached the disk.
    const restarted = app().newRepository();

    for (const document of documents) {
      const loaded = await request(app().app).get(
        `${API_BASE_PATH}/analyses/${document.analysisId}`,
      );

      expect(
        loaded.status,
        `GET of the stored analysis ${document.analysisId} answered ${String(loaded.status)} with ` +
          `code ${String(loaded.body?.code)}`,
      ).toBe(200);

      expect(
        loaded.body?.analysisId,
        `the stored document at ${document.analysisId} named ${String(loaded.body?.analysisId)}`,
      ).toBe(document.analysisId);

      const reread = readDocument(loaded.body, `the stored analysis ${document.analysisId}`);

      expect(
        reread.createdAt,
        `the stored analysis ${document.analysisId} was re-read with a different creation instant`,
      ).toBe(document.createdAt);

      const reloaded = await restarted.findById(document.analysisId);
      expect(
        reloaded?.analysisId,
        `a fresh repository instance over the same data directory did not find ` +
          `${document.analysisId}, so the analysis did not survive the restart it models`,
      ).toBe(document.analysisId);
    }

    const page = await request(app().app).get(`${API_BASE_PATH}/analyses`);

    expect(
      page.status,
      `the history page answered ${String(page.status)} with code ${String(page.body?.code)}`,
    ).toBe(200);

    const listed: AnalysisDocument[] = (page.body as AnalysisListResponse).items;

    expect(
      Array.isArray(listed),
      'the history page did not answer an items array',
    ).toBe(true);

    expect(
      listed.length,
      `the history page listed ${String(listed.length)} analyses, fewer than the ` +
        `${String(RUN_COUNT)} runs this check stored`,
    ).toBeGreaterThanOrEqual(RUN_COUNT);

    const listedIds = new Set(listed.map((item) => item.analysisId));
    for (const document of documents) {
      expect(
        listedIds.has(document.analysisId),
        `the history page does not list ${document.analysisId}, which this run stored`,
      ).toBe(true);
    }

    const creationInstants = listed.map((item) => Date.parse(item.createdAt));

    expect(
      creationInstants.every((instant) => Number.isFinite(instant)),
      'the history page carries a createdAt that is not an ISO-8601 instant',
    ).toBe(true);

    for (let index = 1; index < creationInstants.length; index += 1) {
      const newer = creationInstants[index - 1] ?? 0;
      const older = creationInstants[index] ?? 0;

      expect(
        newer,
        `the history page is not newest first: entry ${String(index)} was created at ` +
          `${new Date(newer).toISOString()}, before the entry at index ${String(index - 1)} ` +
          `(${new Date(older).toISOString()})`,
      ).toBeGreaterThanOrEqual(older);
    }
  });
});

describe('the live path keeps the credential and the image payload out — §0.6.6 #9', () => {
  it('leaves no credential in a log line and no credential or payload in a document', () => {
    const secret = config.openRouterApiKey ?? '';

    expect(
      secret.length,
      'the live check resolved no credential, so every secrecy assertion below would pass vacuously',
    ).toBeGreaterThan(0);

    // Both writers are read: the application's, which the helper captured, and the provider
    // adapter's, which this suite gave the build's own writer. A leak from either is a leak.
    const logText = [...app().logLines, ...providerLogLines].join('\n');

    expect(
      logText.includes(secret),
      'a log line carries the model credential; a credential must never be logged, and its value is ' +
        'not printed here',
    ).toBe(false);

    expect(
      logText.includes('sk-or-'),
      'a log line carries a gateway credential prefix, so a credential-shaped value was emitted',
    ).toBe(false);

    expect(
      /base64/u.test(logText),
      'a log line carries the word base64, so an encoded image payload reached the log',
    ).toBe(false);

    expect(
      /data:image\//u.test(logText),
      'a log line carries an inline image data URL, so image bytes reached the log',
    ).toBe(false);

    // Counts only: the loop reports which document, never its contents.
    for (const [index, document] of documents.entries()) {
      const serialised = JSON.stringify(document);

      expect(
        serialised.includes(secret),
        `the document of run ${String(index + 1)} carries the model credential`,
      ).toBe(false);

      expect(
        serialised.includes('sk-or-'),
        `the document of run ${String(index + 1)} carries a gateway credential prefix`,
      ).toBe(false);

      expect(
        /data:image\//u.test(serialised),
        `the document of run ${String(index + 1)} carries an inline image payload`,
      ).toBe(false);
    }

    expect(
      providerLogLines.length,
      'the provider adapter logged nothing at all, so the log assertions above covered no line it wrote',
    ).toBeGreaterThan(0);
  });
});

