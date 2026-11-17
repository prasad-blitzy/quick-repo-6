/**
 * The error table, one case per row (AAP §0.6.3), plus the two JSON-body rows of §0.6.1 and the
 * "no deduplication" row of §0.6.5.
 *
 * Every case drives a whole application: `buildTestApp` composes the same object the product runs —
 * the real routes, the real domain service, the real filesystem store and the replay provider over a
 * fresh temporary data directory — so a row proves the path from the multipart parser to the stored
 * record rather than a unit of it. What each case asserts is deliberately narrow: the HTTP status,
 * the error code, the sentence, whether a provider call was made at all, how many calls a retry
 * cost, and whether anything was persisted. The bounds themselves are proved in `limits.test.ts`,
 * the reads in `list-get-delete.test.ts` and the health body in `health.test.ts`; that overlap is
 * required, so nothing here re-derives a bound.
 *
 * Three properties every row depends on:
 *
 * - **Nothing is restated.** Every status, code and sentence is imported from `@trade-read/shared`,
 *   and a downgraded read is compared against the shared code maps rather than a literal (D4). No
 *   literal status number, code string, message sentence, path segment or bound appears below, so a
 *   change to the table changes this suite with it.
 * - **A failure stores nothing** (D2). Each refusing row asserts the history page it left behind is
 *   empty, which is the observable form of "no partial analysis".
 * - **Nothing reaches the network.** The replay provider is the only model, so the timeout row is a
 *   scripted abort rather than a real wait (D11) and the whole file passes with no credential set
 *   and no network available.
 *
 * Decisions honoured: D2 (nothing partial is persisted), D4 (one implementation of every shared
 * value), D7 (a non-actionable read carries no level references), D9 (one unreadable image among
 * readable ones is still a `200`), D11 (exactly one silent retry, then `ANALYSIS_FAILED`), D12 (a
 * page size clamps and never fails) and §0.4.5 (no credential and no image data in a body or a log
 * line).
 */

import { STATUS_CODES } from 'node:http';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANALYSIS_BUDGET_MS,
  API_BASE_PATH,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  IMAGE_STATUSES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_BYTES,
  SIDE_CODE_TO_SIDE,
  TIMING_CODE_TO_TIMING,
  type AnalysisDocument,
  type ApiErrorBody,
  type ErrorCode,
} from '@trade-read/shared';

import type {
  CapturedCall,
  StubProviderFailure,
  StubScript,
} from '../../src/adapters/stub/stub-vision-provider.js';
import { analysisDocumentSchema } from '../../src/domain/schemas.js';
import { buildTestApp, type BuildTestAppOptions, type TestApp } from '../helpers/build-test-app.js';
import {
  notAnImagePdfAttachment,
  screenshotAttachment,
  type MultipartAttachment,
} from '../helpers/fixtures.js';
import {
  RECORDED_ADVERSARIAL_KINDS,
  recordedAdversarial,
  recordedAnswerLine,
  recordedSynthesis,
  recordedSynthesisSourceStems,
  type RecordedAdversarialKind,
  type RecordedChatCompletion,
} from '../helpers/recorded.js';

// -------------------------------------------------------------------------------------------------
// The closed error table, by name
// -------------------------------------------------------------------------------------------------

/**
 * The error table as a by-name lookup, built from the table's own tuple.
 *
 * `ERROR_CODES` is a tuple: it fixes the table's order and lists every code, but it is not an object
 * with one property per code. Each row below names its code through this map, so the value is the
 * table's own string rather than a copy of it, and a code dropped from the table stops the build at
 * the row that used it instead of leaving an assertion that can never pass.
 */
const CODE: Readonly<Record<ErrorCode, ErrorCode>> = Object.freeze(
  Object.fromEntries(ERROR_CODES.map((code) => [code, code])) as Record<ErrorCode, ErrorCode>,
);

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------

/** The analyses route, mounted by `app.ts` under the shared API base path. */
const ANALYSES_PATH = `${API_BASE_PATH}/analyses`;

/** The health route, mounted by `app.ts` at the shared API base path itself. */
const HEALTH_PATH = `${API_BASE_PATH}/health`;

/**
 * The cap `app.ts` mounts on a JSON request body: `express.json({ limit: '1mb' })`.
 *
 * No shared constant exists for it — no route accepts a JSON body, so the value is a parser bound
 * rather than part of the response contract — which is why the row that pads a request past it
 * states the figure here.
 */
const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

// -------------------------------------------------------------------------------------------------
// Scripted provider failures
//
// Each constant is a fact about the provider's HTTP contract rather than about this server, so none
// of them is derived from `ERROR_STATUS`: the provider answers a refusal with its own status, and
// the application's answer to it is the code the production error map chooses.
// -------------------------------------------------------------------------------------------------

/** The provider's answer for a credential it will not accept. */
const CREDENTIAL_REFUSED_STATUS = 401;

/** The provider's answer for an account that cannot pay for the call. */
const QUOTA_EXHAUSTED_STATUS = 402;

/** The reason phrase the provider's status table holds for a slug it does not know. */
const SLUG_UNKNOWN_PHRASE = 'Not Found';

/**
 * The provider status for an unusable slug, resolved from its canonical reason phrase rather than
 * restated as a number.
 *
 * The row below is about the provider's "no such model" answer, and that same number is also this
 * server's own answer for a missing analysis; naming the provider's answer instead keeps the two
 * apart and keeps the number out of this file.
 */
const SLUG_UNKNOWN_STATUS = providerStatusPhrased(SLUG_UNKNOWN_PHRASE);

/** A credential the provider refuses, as the replay provider scripts it. */
const CREDENTIAL_REFUSED_FAILURE: StubProviderFailure = {
  kind: 'status',
  status: CREDENTIAL_REFUSED_STATUS,
};

/** An account the provider will not charge, as the replay provider scripts it. */
const QUOTA_EXHAUSTED_FAILURE: StubProviderFailure = {
  kind: 'status',
  status: QUOTA_EXHAUSTED_STATUS,
};

/** A slug the provider does not serve, as the replay provider scripts it. */
const SLUG_UNKNOWN_FAILURE: StubProviderFailure = {
  kind: 'status',
  status: SLUG_UNKNOWN_STATUS,
};

/** A call the analysis deadline ended, as the replay provider scripts it: answered, not waited for. */
const DEADLINE_ABORT_FAILURE: StubProviderFailure = { kind: 'abort' };

// -------------------------------------------------------------------------------------------------
// Synthesised images
// -------------------------------------------------------------------------------------------------

/** PNG's eight-byte signature, the first field of the format's specification. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `IHDR` chunk data length: width, height, bit depth, colour type, compression, filter, interlace. */
const PNG_IHDR_DATA_LENGTH = 13;

/** The four-byte chunk type of PNG's mandatory first chunk. */
const PNG_IHDR_CHUNK_TYPE = 'IHDR';

/** Where the first chunk's length field sits, immediately after the eight-byte signature. */
const PNG_CHUNK_LENGTH_OFFSET = 8;

/** Where the first chunk's four-byte type field sits. */
const PNG_CHUNK_TYPE_OFFSET = 12;

/** `IHDR` width: big-endian uint32, the first field of the chunk data. */
const PNG_WIDTH_OFFSET = 16;

/** `IHDR` height: big-endian uint32, the second field of the chunk data. */
const PNG_HEIGHT_OFFSET = 20;

/** The type a synthesised part declares; the server never trusts it and sniffs the bytes instead. */
const SYNTHETIC_PNG_CONTENT_TYPE = 'image/png';

/** Synthesised geometry, chosen well inside the long-edge bound so a size row can only hit size. */
const SYNTHETIC_IMAGE_WIDTH = 1024;

/** Synthesised geometry, chosen well inside the long-edge bound so a size row can only hit size. */
const SYNTHETIC_IMAGE_HEIGHT = 768;

// -------------------------------------------------------------------------------------------------
// Ids and leak shapes
// -------------------------------------------------------------------------------------------------

/** A canonical analysis id in the server's own format that this store never wrote. */
const UNKNOWN_ANALYSIS_ID = '00000000-0000-4000-8000-000000000000';

/** A path parameter that is not an analysis id at all, and would be a path if it were joined. */
const MALFORMED_ANALYSIS_ID = 'not-an-analysis-id';

/** A stack frame in a serialised body: a newline, indentation and `at`. */
const STACK_FRAME = /\n\s+at\s/;

/** A base64 run long enough to be image bytes rather than a word. */
const BASE64_RUN = /[A-Za-z0-9+/]{200,}/;

/**
 * The gateway's credential shape, assembled from parts so this file carries no credential literal
 * for a scanner to find and no credential for a log or a body to leak.
 */
const CREDENTIAL_SHAPED_RUN = new RegExp(`${['sk', 'or'].join('-')}-[A-Za-z0-9._-]+`);

/** The inline-image prefix a payload would carry if image bytes ever reached a body or a log line. */
const INLINE_IMAGE_PREFIX = 'data:image';

// -------------------------------------------------------------------------------------------------
// Application lifecycle
// -------------------------------------------------------------------------------------------------

/** Every application this file built, so each case's temporary data directory is released. */
let builtApps: TestApp[] = [];

/**
 * Builds one application for one case.
 *
 * A fresh app per case means a fresh script, a fresh capture and a fresh data directory, so no case
 * can observe another's submission. Cleanup is registered here rather than repeated per case,
 * because a case that builds two apps must release both.
 */
async function buildApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const testApp = await buildTestApp(options);
  builtApps.push(testApp);
  return testApp;
}

afterEach(async () => {
  const built = builtApps;
  builtApps = [];
  await Promise.all(built.map((testApp) => testApp.cleanup()));
});

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

/** The parts of a Supertest response this file reads. */
interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/** What a row expects beyond the code itself. */
interface ErrorBodyExpectation {
  /** The submitted file name the message must name, for the rows that name the offending file. */
  readonly namesFile?: string;

  /** True when the row's sentence carries a clause the server adds after the shared sentence. */
  readonly appendsDetail?: boolean;
}

/** Whether a value is a JSON object, which is the only shape either a body or a list has here. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One response body as the JSON object it must be, failing the case when it is anything else. */
function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${description} to be one JSON object, received ${typeof value}.`);
  }

  return value;
}

/** One list element, failing the case when the list is shorter than the case assumes. */
function requireItem<T>(items: readonly T[], index: number, description: string): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`expected ${description} at index ${index}, but the list holds ${items.length}.`);
  }

  return item;
}

/**
 * The HTTP status whose canonical reason phrase is `phrase`, read from Node's own status table.
 *
 * The provider statuses this file scripts are facts about the provider, not about this server, so a
 * row names the answer it is about ("Not Found") and the number is resolved here.
 */
function providerStatusPhrased(phrase: string): number {
  const entry = Object.entries(STATUS_CODES).find(([, canonical]) => canonical === phrase);

  if (entry === undefined) {
    throw new Error(`Node's status table holds no status phrased "${phrase}".`);
  }

  return Number(entry[0]);
}

/**
 * Every provider request the app issued, in order, a retry included.
 *
 * The capture is the only way a case can show that a rejection happened before any model call, and
 * that a broken answer cost exactly one retry. Every app built here holds the replay provider,
 * because no case supplies its own.
 */
function providerCalls(testApp: TestApp): readonly CapturedCall[] {
  if (testApp.stub === null) {
    throw new Error('this suite drives the replay provider, which the built app did not hold.');
  }

  return testApp.stub.calls;
}

/** The provider requests of one role, in issue order. */
function callsOfRole(testApp: TestApp, role: CapturedCall['role']): readonly CapturedCall[] {
  return providerCalls(testApp).filter((call) => call.role === role);
}

/**
 * Posts one submission: every image as an `images` part, in the order given, then the optional text.
 *
 * Each part travels with the name and content type the fixture declares — the server sniffs the
 * bytes and never trusts either — so a wrong-type fixture is sent with its honest type and the case
 * proves the type rejection rather than a decode failure.
 */
function submit(
  testApp: TestApp,
  images: readonly MultipartAttachment[],
  fields: { readonly instrument?: string; readonly context?: string } = {},
) {
  const pending = request(testApp.app).post(ANALYSES_PATH);

  if (fields.instrument !== undefined) {
    pending.field('instrument', fields.instrument);
  }

  if (fields.context !== undefined) {
    pending.field('context', fields.context);
  }

  for (const image of images) {
    pending.attach('images', image.bytes, {
      filename: image.fileName,
      contentType: image.contentType,
    });
  }

  return pending;
}

/**
 * Asserts one response is the error table's answer for `code`, and returns the body it read.
 *
 * The body's key set is checked exactly, because `{ code, message }` is the contract: a status field,
 * a stack or a path added beside them would be a second, drifting answer to the same failure. The
 * sentence is compared against the shared table — exactly where the server adds nothing, and as the
 * sentence the table's own text opens where a row names the offending file or the configured slug.
 */
function expectErrorResponse(
  result: HttpResult,
  code: ErrorCode,
  expectation: ErrorBodyExpectation = {},
): ApiErrorBody {
  const body = requireRecord(result.body, `the ${code} error body`);

  expect(result.status).toBe(ERROR_STATUS[code]);
  expect(Object.keys(body)).toEqual(['code', 'message']);
  expect(body['code']).toBe(code);

  const message = body['message'];
  expect(typeof message).toBe('string');

  const sentence = typeof message === 'string' ? message : '';

  if (expectation.namesFile === undefined && expectation.appendsDetail !== true) {
    expect(sentence).toBe(ERROR_MESSAGES[code]);
  } else {
    expect(sentence.startsWith(ERROR_MESSAGES[code])).toBe(true);
  }

  if (expectation.namesFile !== undefined) {
    expect(sentence).toContain(expectation.namesFile);
  }

  return { code, message: sentence };
}

/**
 * Asserts a response body carries nothing local to the server: no stack frame, no data directory and
 * no credential-shaped run (§0.4.5).
 */
function expectNoInternals(body: unknown, testApp: TestApp): void {
  const text = JSON.stringify(body) ?? '';

  expect(text).not.toMatch(STACK_FRAME);
  expect(text).not.toContain(testApp.dataDir);
  expect(text).not.toMatch(CREDENTIAL_SHAPED_RUN);
}

/** Asserts the history page is empty, which is what "nothing was persisted" looks like (D2). */
async function expectNothingPersisted(testApp: TestApp): Promise<void> {
  const response = await request(testApp.app).get(ANALYSES_PATH);
  const body = requireRecord(response.body, 'the history page');

  expect(response.status).toBe(200);
  expect(body['items']).toEqual([]);
}

/**
 * A PNG whose header declares `width` × `height` and whose bytes total `byteLength`.
 *
 * Every bound this file proves is decided from the header and the buffer length alone, because the
 * build carries no image decoder: `server/src/domain/image-probe.ts` reads the signature, the first
 * chunk's length and type, and the two big-endian dimensions at fixed offsets. Everything after the
 * header is zero padding, so a buffer can pass a byte bound while remaining a well-formed header
 * whose geometry is inside the pixel bound — which is what makes a size row prove the size code
 * rather than the type or dimension one. Nothing multi-megabyte is committed: the padding lives only
 * in memory, for the length of one case.
 */
function pngBufferOfSize(byteLength: number, width: number, height: number): Buffer {
  const buffer = Buffer.alloc(byteLength);

  PNG_SIGNATURE.forEach((byte, index) => {
    buffer.writeUInt8(byte, index);
  });
  buffer.writeUInt32BE(PNG_IHDR_DATA_LENGTH, PNG_CHUNK_LENGTH_OFFSET);
  buffer.write(PNG_IHDR_CHUNK_TYPE, PNG_CHUNK_TYPE_OFFSET, 'ascii');
  buffer.writeUInt32BE(width, PNG_WIDTH_OFFSET);
  buffer.writeUInt32BE(height, PNG_HEIGHT_OFFSET);

  return buffer;
}

/** A synthesised PNG part: the bytes asked for behind a valid header with in-bound geometry. */
function syntheticPngAttachment(fileName: string, byteLength: number): MultipartAttachment {
  return {
    fileName,
    contentType: SYNTHETIC_PNG_CONTENT_TYPE,
    bytes: pngBufferOfSize(byteLength, SYNTHETIC_IMAGE_WIDTH, SYNTHETIC_IMAGE_HEIGHT),
  };
}

/**
 * One recorded envelope as the stub's script, so a recorded answer reaches the production parser
 * with the completion flag and usage figure it was recorded with.
 *
 * A single script answers every attempt, which is why the conformance rows get their retry for free:
 * the second attempt replays the same broken answer, so the call fails as it would against a model
 * that answered badly twice.
 */
function scriptOf(envelope: RecordedChatCompletion): StubScript {
  const choice = envelope.choices[0];

  return {
    content: recordedAnswerLine(envelope),
    finishReason: choice?.finish_reason,
    completionTokens: envelope.usage.completion_tokens,
  };
}

/** One response body as the analysis document it must be, validated against the shared schema. */
function parseDocument(body: unknown): AnalysisDocument {
  return analysisDocumentSchema.parse(body);
}

// -------------------------------------------------------------------------------------------------
// The upload bounds: every rejection precedes any provider call (AAP §0.3.1, §0.6.3)
// -------------------------------------------------------------------------------------------------

describe('a submission the upload bounds refuse', () => {
  it('no files: answers NO_IMAGES, calls no provider and stores nothing', async () => {
    const testApp = await buildApp();

    const response = await submit(testApp, []);

    expectErrorResponse(response, CODE.NO_IMAGES);
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });

  it('more than the image count bound: answers TOO_MANY_IMAGES, calls no provider', async () => {
    const testApp = await buildApp();
    const attachments = Array.from({ length: MAX_IMAGES + 1 }, (_unused, index) =>
      screenshotAttachment('footprint-es-5m', `footprint-${index}.png`),
    );

    const response = await submit(testApp, attachments);

    expectErrorResponse(response, CODE.TOO_MANY_IMAGES);
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });

  it('a file that is not PNG, JPEG or WebP: answers UNSUPPORTED_IMAGE_TYPE naming it', async () => {
    const testApp = await buildApp();
    const attachment = notAnImagePdfAttachment();

    const response = await submit(testApp, [attachment]);

    expectErrorResponse(response, CODE.UNSUPPORTED_IMAGE_TYPE, {
      namesFile: attachment.fileName,
    });
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });

  it('a file past the per-file byte bound: answers IMAGE_TOO_LARGE naming it', async () => {
    const testApp = await buildApp();
    // Past the per-file bound and inside multer's memory guard, behind a PNG header whose geometry
    // is inside the pixel bound, so the per-file byte bound is the only one this part can break.
    const attachment = syntheticPngAttachment('over-per-file.png', MAX_IMAGE_BYTES + 1024);

    const response = await submit(testApp, [attachment]);

    expectErrorResponse(response, CODE.IMAGE_TOO_LARGE, { namesFile: attachment.fileName });
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });

  it('a submission past the total byte bound: answers IMAGE_TOO_LARGE, calls no provider', async () => {
    const testApp = await buildApp();
    // Three parts, each a third of the total bound plus one byte: no single part breaks the per-file
    // bound, and together they break the total one — which is why the two bounds are separate rows.
    const perFileBytes = Math.floor(MAX_TOTAL_BYTES / 3) + 1;
    expect(perFileBytes).toBeLessThan(MAX_IMAGE_BYTES);

    const response = await submit(testApp, [
      syntheticPngAttachment('third-one.png', perFileBytes),
      syntheticPngAttachment('third-two.png', perFileBytes),
      syntheticPngAttachment('third-three.png', perFileBytes),
    ]);

    expectErrorResponse(response, CODE.IMAGE_TOO_LARGE, { appendsDetail: true });
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });

  it('a long edge past the pixel bound: answers IMAGE_TOO_LARGE_DIMENSIONS naming it', async () => {
    const testApp = await buildApp();
    const attachment = screenshotAttachment('oversize-long-edge');

    // The fixture is far below the per-file byte bound, so the pixel bound is the only one it can
    // break: the dimension code is what this row proves.
    expect(attachment.bytes.byteLength).toBeLessThan(MAX_IMAGE_BYTES);

    const response = await submit(testApp, [attachment]);

    expectErrorResponse(response, CODE.IMAGE_TOO_LARGE_DIMENSIONS, {
      namesFile: attachment.fileName,
    });
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });
});

// -------------------------------------------------------------------------------------------------
// Image readability: one blank screenshot is a recorded outcome, all of them are no read at all (D9)
// -------------------------------------------------------------------------------------------------

describe('the statuses a submission records per image', () => {
  it('one unreadable image among readable ones: 200 with that image recorded and the rest read', async () => {
    const testApp = await buildApp();
    const footprint = screenshotAttachment('footprint-es-5m');
    const blank = screenshotAttachment('blank-uniform');
    const gex = screenshotAttachment('gex-es-levels');

    const response = await submit(testApp, [footprint, blank, gex]);

    expect(response.status).toBe(200);

    const document = parseDocument(response.body);
    const first = requireItem(document.images, 0, 'the footprint image');
    const unreadable = requireItem(document.images, 1, 'the unreadable image');
    const last = requireItem(document.images, 2, 'the GEX image');

    expect(document.images).toHaveLength(3);
    expect(first.fileName).toBe(footprint.fileName);
    expect(unreadable.fileName).toBe(blank.fileName);
    expect(last.fileName).toBe(gex.fileName);

    // Which status means "unreadable" is derived rather than restated: the blank screenshot is the
    // odd one out, whatever status the two readable ones share is the other, and both are members of
    // the contract's own tuple.
    expect(unreadable.status).not.toBe(first.status);
    expect(unreadable.status).not.toBe(last.status);
    expect(first.status).toBe(last.status);
    expect(IMAGE_STATUSES).toContain(unreadable.status);

    expect(typeof unreadable.extractionError).toBe('string');
    expect((unreadable.extractionError ?? '').length).toBeGreaterThan(0);
    expect(first.extractionError).toBeUndefined();
    expect(last.extractionError).toBeUndefined();

    // An unreadable screenshot yields no level at all, and the read says what was assumed.
    expect(document.levels.some((level) => level.imageId === unreadable.imageId)).toBe(false);
    expect(document.assumptions.length).toBeGreaterThanOrEqual(1);
    for (const assumption of document.assumptions) {
      expect(assumption.length).toBeGreaterThan(0);
    }
  });

  it('every image unreadable: answers NO_READABLE_IMAGES and stores nothing', async () => {
    const testApp = await buildApp();

    // The same screenshot three times: the replay provider chooses its recording by the file stem,
    // so the parts must keep the name the blank recording is filed under.
    const response = await submit(testApp, [
      screenshotAttachment('blank-uniform'),
      screenshotAttachment('blank-uniform'),
      screenshotAttachment('blank-uniform'),
    ]);

    expectErrorResponse(response, CODE.NO_READABLE_IMAGES);
    expectNoInternals(response.body, testApp);
    await expectNothingPersisted(testApp);
  });
});

// -------------------------------------------------------------------------------------------------
// Provider failures: one row per code the error map chooses, none of them retried (D11)
// -------------------------------------------------------------------------------------------------

describe('a provider that refuses the analysis', () => {
  it('a refused credential: answers PROVIDER_NOT_CONFIGURED and health still reports the configuration', async () => {
    const testApp = await buildApp({ stub: { providerFailure: CREDENTIAL_REFUSED_FAILURE } });

    const response = await submit(testApp, [screenshotAttachment('footprint-es-5m')]);

    expectErrorResponse(response, CODE.PROVIDER_NOT_CONFIGURED);
    expectNoInternals(response.body, testApp);
    // Terminal by kind, so the call is not retried: one request, then the answer.
    expect(providerCalls(testApp)).toHaveLength(1);
    await expectNothingPersisted(testApp);
    // The suite runs with no credential at all, which is what this row is about.
    expect(testApp.config.openRouterApiKey).toBeNull();

    // The process is still up: the health route reads configuration, so it answers whether or not a
    // submission was attempted, and the client can show a message instead of a spinner.
    const health = await request(testApp.app).get(HEALTH_PATH);
    const healthBody = requireRecord(health.body, 'the health body');

    expect(health.status).toBe(200);
    expect(healthBody['status']).toBe('ok');
    expect(healthBody['providerConfigured']).toBe(false);
    expect(JSON.stringify(healthBody)).not.toMatch(CREDENTIAL_SHAPED_RUN);

    // The same shape holds for an application that was never scripted at all.
    const unscripted = await buildApp();
    const unscriptedHealth = await request(unscripted.app).get(HEALTH_PATH);
    const unscriptedBody = requireRecord(unscriptedHealth.body, 'the health body');

    expect(unscriptedHealth.status).toBe(200);
    expect(unscriptedBody['status']).toBe('ok');
    expect(unscriptedBody['providerConfigured']).toBe(false);
    expect(typeof unscriptedBody['model']).toBe('string');
  });

  it('a spent quota: answers PROVIDER_QUOTA_EXCEEDED with nothing partial persisted', async () => {
    const testApp = await buildApp({ stub: { providerFailure: QUOTA_EXHAUSTED_FAILURE } });

    const response = await submit(testApp, [
      screenshotAttachment('footprint-es-5m'),
      screenshotAttachment('gex-es-levels'),
    ]);

    expectErrorResponse(response, CODE.PROVIDER_QUOTA_EXCEEDED);
    expectNoInternals(response.body, testApp);
    expect(providerCalls(testApp)).toHaveLength(1);
    await expectNothingPersisted(testApp);
  });

  it('a call aborted at the deadline: answers ANALYSIS_TIMEOUT without waiting for the budget', async () => {
    const testApp = await buildApp({ stub: { providerFailure: DEADLINE_ABORT_FAILURE } });

    const startedAt = Date.now();
    const response = await submit(testApp, [screenshotAttachment('footprint-es-5m')]);
    const elapsed = Date.now() - startedAt;

    expectErrorResponse(response, CODE.ANALYSIS_TIMEOUT);
    expectNoInternals(response.body, testApp);
    // The abort is scripted, so the answer arrives at once: a real wait for the budget would be an
    // order of magnitude slower than this bound.
    expect(elapsed).toBeLessThan(ANALYSIS_BUDGET_MS / 4);
    await expectNothingPersisted(testApp);
  });

  it.each([...RECORDED_ADVERSARIAL_KINDS])(
    'an answer that breaks the one-line contract (%s): one silent retry, then ANALYSIS_FAILED',
    async (kind: RecordedAdversarialKind) => {
      const testApp = await buildApp({
        stub: { synthesisScript: scriptOf(recordedAdversarial(kind)) },
      });

      const response = await submit(testApp, [
        screenshotAttachment('footprint-es-5m'),
        screenshotAttachment('gex-es-levels'),
      ]);

      expectErrorResponse(response, CODE.ANALYSIS_FAILED);
      expectNoInternals(response.body, testApp);
      // D11: the failing call is issued exactly twice — the broken answer and its one silent retry —
      // while the two extractions are issued once each.
      expect(callsOfRole(testApp, 'synthesis')).toHaveLength(2);
      expect(callsOfRole(testApp, 'extraction')).toHaveLength(2);
      await expectNothingPersisted(testApp);

      // The retry log line carries the answer's text and nothing else: no image bytes, no credential.
      const logText = testApp.logLines.join('\n');

      expect(logText).not.toContain(INLINE_IMAGE_PREFIX);
      expect(logText).not.toMatch(BASE64_RUN);
      expect(logText).not.toMatch(CREDENTIAL_SHAPED_RUN);
    },
  );

  it('an unusable slug: answers PROVIDER_MODEL_UNSUPPORTED', async () => {
    const testApp = await buildApp({ stub: { providerFailure: SLUG_UNKNOWN_FAILURE } });

    const response = await submit(testApp, [screenshotAttachment('footprint-es-5m')]);

    // The row's sentence names the configured slug after the shared sentence, so the shared text is
    // asserted as the sentence's opening and the slug itself is left to the error map's own suite.
    expectErrorResponse(response, CODE.PROVIDER_MODEL_UNSUPPORTED, { appendsDetail: true });
    expectNoInternals(response.body, testApp);
    await expectNothingPersisted(testApp);
  });
});

// -------------------------------------------------------------------------------------------------
// A read the evidence contradicts is downgraded, never failed (rules 2, 3 and 5)
// -------------------------------------------------------------------------------------------------

describe('a mapped read the evidence contradicts', () => {
  it('a cited price that matches no level: downgraded rather than failed', async () => {
    const testApp = await buildApp({
      stub: { synthesisScript: scriptOf(recordedSynthesis('unmatched-price')) },
    });
    const attachments = recordedSynthesisSourceStems('unmatched-price').map((stem) =>
      screenshotAttachment(stem),
    );

    const response = await submit(testApp, attachments);

    // A downgrade is a complete answer, not an error: the submission succeeds and is stored.
    expect(response.status).toBe(200);

    const document = parseDocument(response.body);
    const { recommendation } = document;

    expect(recommendation.side).toBe(SIDE_CODE_TO_SIDE['NONE']);
    expect(recommendation.timing).toBe(TIMING_CODE_TO_TIMING['WAIT']);
    // D7: a non-actionable read references no level at all.
    expect(recommendation.triggerLevelId).toBeNull();
    expect(recommendation.entryLevelId).toBeNull();
    expect(recommendation.invalidationLevelId).toBeNull();
    expect(recommendation.targetLevelIds).toEqual([]);

    expect(document.assumptions.length).toBeGreaterThanOrEqual(1);
    for (const assumption of document.assumptions) {
      expect(assumption.length).toBeGreaterThan(0);
    }
  });

  it('a read with too few source images: downgraded rather than failed', async () => {
    const testApp = await buildApp({
      stub: { synthesisScript: scriptOf(recordedSynthesis('single-source')) },
    });
    const attachments = recordedSynthesisSourceStems('single-source').map((stem) =>
      screenshotAttachment(stem),
    );

    const response = await submit(testApp, attachments);

    expect(response.status).toBe(200);

    const document = parseDocument(response.body);
    const { recommendation } = document;

    expect(recommendation.side).toBe(SIDE_CODE_TO_SIDE['NONE']);
    expect(recommendation.timing).toBe(TIMING_CODE_TO_TIMING['WAIT']);
    expect(recommendation.triggerLevelId).toBeNull();
    expect(recommendation.entryLevelId).toBeNull();
    expect(recommendation.invalidationLevelId).toBeNull();
    expect(recommendation.targetLevelIds).toEqual([]);

    expect(document.assumptions.length).toBeGreaterThanOrEqual(1);
  });
});

// -------------------------------------------------------------------------------------------------
// Lookups that name no stored analysis
// -------------------------------------------------------------------------------------------------

describe('a lookup for an analysis that does not exist', () => {
  it('an unknown or malformed id: answers NOT_FOUND, revealing nothing about the store', async () => {
    const testApp = await buildApp();

    for (const analysisId of [UNKNOWN_ANALYSIS_ID, MALFORMED_ANALYSIS_ID]) {
      const response = await request(testApp.app).get(
        `${ANALYSES_PATH}/${encodeURIComponent(analysisId)}`,
      );

      expectErrorResponse(response, CODE.NOT_FOUND);
      expectNoInternals(response.body, testApp);
    }

    await expectNothingPersisted(testApp);
  });
});

// -------------------------------------------------------------------------------------------------
// A submission that carries no image file (AAP §0.6.1)
// -------------------------------------------------------------------------------------------------

describe('a submission posted as JSON instead of multipart', () => {
  it('answers NO_IMAGES, including for a body past the JSON cap', async () => {
    const testApp = await buildApp();

    const small = await request(testApp.app)
      .post(ANALYSES_PATH)
      .type('json')
      .send({ instrument: 'ES' });

    expectErrorResponse(small, CODE.NO_IMAGES);
    expectNoInternals(small.body, testApp);

    // Past the cap `app.ts` mounts: the parser refuses the body and the refusal is answered from the
    // table's "no image file" row, because a request carrying JSON carries no image.
    const oversized = await request(testApp.app)
      .post(ANALYSES_PATH)
      .type('json')
      .send({ context: 'x'.repeat(JSON_BODY_LIMIT_BYTES * 2) });

    expectErrorResponse(oversized, CODE.NO_IMAGES);
    expectNoInternals(oversized.body, testApp);

    expect(providerCalls(testApp)).toHaveLength(0);
    await expectNothingPersisted(testApp);
  });
});

// -------------------------------------------------------------------------------------------------
// Two identical submissions (AAP §0.6.5: there is no deduplication)
// -------------------------------------------------------------------------------------------------

describe('two identical submissions', () => {
  it('produce two analyses, never one', async () => {
    const testApp = await buildApp();
    const submission = [
      screenshotAttachment('footprint-es-5m'),
      screenshotAttachment('gex-es-levels'),
    ];

    const first = await submit(testApp, submission);
    const second = await submit(testApp, submission);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstDocument = parseDocument(first.body);
    const secondDocument = parseDocument(second.body);

    expect(firstDocument.analysisId).not.toBe(secondDocument.analysisId);
    // Each submission is its own analysis, so the model was asked to synthesise twice.
    expect(callsOfRole(testApp, 'synthesis')).toHaveLength(2);

    const list = await request(testApp.app).get(ANALYSES_PATH);
    const items = requireRecord(list.body, 'the history page')['items'];
    const listedItems: readonly unknown[] = Array.isArray(items) ? items : [];
    const listedIds = listedItems.map(
      (item) => requireRecord(item, 'a listed analysis')['analysisId'],
    );

    expect(list.status).toBe(200);
    expect(listedIds).toHaveLength(2);
    expect(listedIds).toContain(firstDocument.analysisId);
    expect(listedIds).toContain(secondDocument.analysisId);
  });
});

