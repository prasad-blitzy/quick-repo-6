/**
 * Contract suite for one submission: `POST {API_BASE_PATH}/analyses` answers `200` with the analysis
 * document the shared contract declares, assembled from the levels two submitted screenshots reported.
 *
 * Two screenshots go out in one gesture — a footprint chart and a gamma-exposure ladder, the
 * "combination of kinds" case and the same pair the end-to-end spec drops — and the answer comes from
 * the committed recordings, so the whole path runs offline: the production request builders, the
 * one-line conformance check, the domain mapping, the invariant passes, the document builder and the
 * filesystem store, with no credential and no socket.
 *
 * Rows this file proves (AAP §0.6.1, §0.6.6):
 *
 * - The document rows: `analysisId`, ISO-8601 UTC `createdAt`, the echoed `instrument` and `context`,
 *   `images[]` with its sniffed geometry and status, `levels[]` restricted to the twelve-value
 *   taxonomy, `recommendation` with three level references and no price field of any kind,
 *   server-built `rationale[]`, server-authored `assumptions[]`, `modelUsage` and `disclaimer`.
 * - The CORS row: each admitted client origin is echoed and a foreign origin is not.
 * - The no-authentication row: a submission carrying no `Authorization` header still succeeds.
 * - The no-deduplication row: two identical submissions are two analyses with two ids.
 * - Criterion 5: every response validates against `analysisDocumentSchema`.
 * - Criterion 4: no price is invented — every price a read displays resolves to `levels[]` by exact
 *   equality, and the recommendation itself carries none.
 *
 * Decisions honoured: D1 (no identity, so an unauthenticated call is the design and an id is always
 * server-minted), D4 (every bound, enum, code map, sentence and path comes from `@trade-read/shared`
 * rather than a literal here), D6 (a price matches a level by exact numeric equality, and the stored
 * price is the number the model reported), D10 (the rationale and the assumptions are the server's),
 * D14 (`promptVersion` is read from the prompt library, never restated), and §0.4.5 (the configured
 * credential reaches no response body).
 */

import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  CLIENT_DEV_ORIGINS,
  CONFIDENCE_CODE_TO_CONFIDENCE,
  CONTEXT_MAX_CHARS,
  DISCLAIMER,
  EXTRACTION_CODES,
  EXTRACTION_CODE_TO_LEVEL_TYPE,
  IMAGE_STATUSES,
  INSTRUMENT_MAX_CHARS,
  LEVEL_TYPES,
  MAX_LONG_EDGE_PX,
  MAX_TOKENS_SYNTHESIS,
  SIDE_CODE_TO_SIDE,
  SIDES,
  SUMMARY_MAX_CHARS,
  TIMINGS,
  type AnalysisDocument,
  type AnalysisImage,
  type AnalysisListResponse,
  type ConfidenceCode,
  type ExtractionCode,
  type Level,
  type Recommendation,
  type SynthesisSideCode,
  type SynthesisTimingCode,
} from '@trade-read/shared';

import { getPromptVersion } from '../../src/adapters/prompts/prompt-library.js';
import { analysisDocumentSchema } from '../../src/domain/schemas.js';
import { buildTestApp, type BuildTestAppOptions, type TestApp } from '../helpers/build-test-app.js';
import {
  type ScreenshotStem,
  screenshotAttachment,
  screenshotBytes,
} from '../helpers/fixtures.js';
import {
  type RecordedChatCompletion,
  recordedAnswerLine,
  recordedCompletionTokens,
  recordedExtraction,
  recordedSynthesis,
} from '../helpers/recorded.js';

// The submission this suite drives: the two screenshots, in the order they are dropped, each with
// the recorded extraction its file stem names. The stems are named once and collected into the
// submission order below, so the request this file sends and the answers it expects cannot drift
// apart; `satisfies` keeps each one checked against the fixtures helper's own union, so a renamed
// fixture is a compile error here rather than a missing one at runtime.
const FOOTPRINT_STEM = 'footprint-es-5m' satisfies ScreenshotStem;

const GEX_STEM = 'gex-es-levels' satisfies ScreenshotStem;

const SUBMITTED_STEMS = [FOOTPRINT_STEM, GEX_STEM] as const;

type SubmittedStem = (typeof SUBMITTED_STEMS)[number];

/** The optional instrument label, well inside `INSTRUMENT_MAX_CHARS`. */
const INSTRUMENT = 'ES';

/** The optional free text, well inside `CONTEXT_MAX_CHARS`; echoed because it is within the caps. */
const CONTEXT = 'Five-minute footprint beside the gamma-exposure ladder for the same session.';

/** The route a submission is posted to, built from the shared mount point rather than spelled out. */
const ANALYSES_PATH = `${API_BASE_PATH}/analyses`;

/** The two statuses the contract admits, taken from the shared tuple so `ANALYZED` is not restated. */
const [ANALYZED] = IMAGE_STATUSES;

/** The two origins the API admits, taken from the shared tuple rather than written here (D1). */
const [FIRST_CLIENT_ORIGIN, SECOND_CLIENT_ORIGIN] = CLIENT_DEV_ORIGINS;

/** An origin that is not on the allowlist, which is what makes the refusal observable. */
const FOREIGN_ORIGIN = 'https://foreign.invalid';

/** The shape `createdAt` must have: an ISO-8601 instant in UTC, with or without a fraction. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A credential-shaped value that cannot match a real provider's key format, used only to prove the
 * configured key reaches no response body (§0.4.5).
 */
const SENTINEL_CREDENTIAL = 'test-credential-not-a-real-key';

/** The eight bytes that identify a PNG, so the fixture's geometry can be read from its IHDR chunk. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Offset of the IHDR width: the signature, the chunk length and the chunk type come first. */
const PNG_IHDR_WIDTH_OFFSET = 16;

/** Offset of the IHDR height, four bytes after the width. */
const PNG_IHDR_HEIGHT_OFFSET = 20;

/** One recorded extraction answer, typed to the fields this suite reads (the port's own three keys). */
interface RecordedExtractionAnswer {
  /** The `[price, code]` pairs in the order the recording reported them. */
  readonly l: ReadonlyArray<readonly [number, string]>;
  /** The observation, which this suite does not assert on beyond the store keeping it out of the API. */
  readonly o: string;
  /** `OK` or `BLANK`. */
  readonly r: string;
}

/**
 * One recorded synthesis answer, typed to the fields this suite reads.
 *
 * The three code fields carry the shared unions rather than `string`, because the schema the adapter
 * applied admitted exactly those and every expectation below indexes a shared map with them.
 */
interface RecordedSynthesisAnswer {
  readonly s: SynthesisSideCode;
  readonly t: SynthesisTimingCode;
  readonly e: number | null;
  readonly x: number | null;
  readonly k: readonly number[];
  readonly c: ConfidenceCode;
  readonly src: readonly string[];
  readonly w: string;
}

/** One `[price, code]` pair a recorded extraction reported, with the code already resolved. */
interface RecordedPair {
  /** The price the recording reported, exactly as it was written. */
  readonly price: number;
  /** The vocabulary code the recording labelled that price with. */
  readonly code: ExtractionCode;
}

/** Every application this file built, so a failed assertion still releases its data directory. */
const builtApps: TestApp[] = [];

afterEach(async () => {
  const apps = builtApps.splice(0);

  await Promise.all(apps.map((app) => app.cleanup()));
});

/**
 * Builds one application for one test and tracks it for teardown.
 *
 * Each test gets its own app, its own temporary data directory and its own replay provider, so a test
 * can neither see another test's stored analyses nor count its captured calls (D3).
 */
async function buildApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const testApp = await buildTestApp(options);
  builtApps.push(testApp);

  return testApp;
}

/**
 * Posts the two screenshots as one multipart submission, with the optional text fields filled in.
 *
 * The parts are attached in the order the operator would have dropped them, because submission order
 * is what the document records and what the extraction calls follow.
 */
async function submitTwoScreenshots(
  testApp: TestApp,
  origin?: string,
): Promise<SupertestResponse> {
  const footprintAttachment = screenshotAttachment(FOOTPRINT_STEM);
  const gexAttachment = screenshotAttachment(GEX_STEM);

  const submission = request(testApp.app).post(ANALYSES_PATH);

  if (origin !== undefined) {
    submission.set('Origin', origin);
  }

  return await submission
    .attach('images', footprintAttachment.bytes, {
      filename: footprintAttachment.fileName,
      contentType: footprintAttachment.contentType,
    })
    .attach('images', gexAttachment.bytes, {
      filename: gexAttachment.fileName,
      contentType: gexAttachment.contentType,
    })
    .field('instrument', INSTRUMENT)
    .field('context', CONTEXT);
}

/**
 * Submits once and returns the response together with the document it parsed to.
 *
 * The parse is the schema half of criterion 5: a response that does not satisfy the shared contract
 * fails here, before any assertion reads a field of it.
 */
async function createdDocument(
  testApp: TestApp,
): Promise<{ readonly response: SupertestResponse; readonly document: AnalysisDocument }> {
  const response = await submitTwoScreenshots(testApp);

  expect(response.status).toBe(200);

  return { response, document: analysisDocumentSchema.parse(response.body) };
}

/** One recorded answer line as the object it encodes, cast to the shape its own recording declares. */
function parsedAnswerLine<T>(envelope: RecordedChatCompletion, label: string): T {
  const line = recordedAnswerLine(envelope);
  const parsed: unknown = JSON.parse(line);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The recorded ${label} answer is not a single JSON object.`);
  }

  return parsed as T;
}

/** The extraction answer recorded for one screenshot. */
function recordedExtractionAnswer(stem: SubmittedStem): RecordedExtractionAnswer {
  return parsedAnswerLine<RecordedExtractionAnswer>(recordedExtraction(stem), `${stem} extraction`);
}

/** The synthesis answer recorded for the baseline directional read, which is the stub's default. */
function recordedLongAnswer(): RecordedSynthesisAnswer {
  return parsedAnswerLine<RecordedSynthesisAnswer>(recordedSynthesis('long'), 'synthesis-long');
}

/** One recorded code resolved to the shared vocabulary's code, failing loudly on an unknown one. */
function extractionCodeOf(code: string): ExtractionCode {
  const known = EXTRACTION_CODES.find((candidate) => candidate === code);

  if (known === undefined) {
    throw new Error(
      `A recorded extraction answer carries the code "${code}", which the shared vocabulary does not ` +
        'declare, so no level type can stand for it.',
    );
  }

  return known;
}

/** The pairs one screenshot's recording reported, in that recording's order. */
function recordedPairsFor(stem: SubmittedStem): readonly RecordedPair[] {
  return recordedExtractionAnswer(stem).l.map(([price, code]) => ({
    price,
    code: extractionCodeOf(code),
  }));
}

/** Every pair both recordings reported, each paired with the screenshot it came from. */
function recordedPairs(): ReadonlyArray<RecordedPair & { readonly stem: SubmittedStem }> {
  return SUBMITTED_STEMS.flatMap((stem) =>
    recordedPairsFor(stem).map((pair) => ({ ...pair, stem })),
  );
}

/** The screenshots that reported a price, which is how rule 3's two-image evidence is checked. */
function stemsCarrying(price: number | null): ReadonlySet<SubmittedStem> {
  const stems = new Set<SubmittedStem>();

  for (const pair of recordedPairs()) {
    if (pair.price === price) {
      stems.add(pair.stem);
    }
  }

  return stems;
}

/** One screenshot's width and height, read from the PNG header the fixture actually carries. */
function pngDimensionsOf(stem: SubmittedStem): { readonly width: number; readonly height: number } {
  const bytes = screenshotBytes(stem);
  const signed = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

  if (!signed || bytes.length < PNG_IHDR_HEIGHT_OFFSET + 4) {
    throw new Error(
      `The "${stem}" fixture is not a PNG carrying an IHDR chunk, so its recorded dimensions cannot ` +
        'be read from its own bytes.',
    );
  }

  return {
    width: bytes.readUInt32BE(PNG_IHDR_WIDTH_OFFSET),
    height: bytes.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET),
  };
}

/** One submitted screenshot as the document records it, failing the test when the record is absent. */
function imageFor(document: AnalysisDocument, fileName: string): AnalysisImage {
  const image = document.images.find((candidate) => candidate.fileName === fileName);

  if (image === undefined) {
    throw new Error(`The document records no submitted image named "${fileName}".`);
  }

  return image;
}

/** The levels the document holds, indexed by the id a recommendation cites. */
function levelsById(document: AnalysisDocument): ReadonlyMap<string, Level> {
  return new Map(document.levels.map((level) => [level.levelId, level]));
}

/** The level one reference names, failing the test when the reference is null or names nothing. */
function levelCited(
  document: AnalysisDocument,
  levelId: string | null,
  reference: string,
): Level {
  if (levelId === null) {
    throw new Error(`The recommendation's ${reference} must reference a level for this read.`);
  }

  const level = levelsById(document).get(levelId);

  if (level === undefined) {
    throw new Error(`The recommendation's ${reference} cites "${levelId}", which levels[] does not hold.`);
  }

  return level;
}

/** A price the recorded answer must cite, failing the test when the recording carries none. */
function citedPrice(price: number | null, reference: string): number {
  if (price === null) {
    throw new Error(`The recorded baseline read must cite a ${reference} price, and the recording carries null.`);
  }

  return price;
}

/**
 * Every number inside a value, wherever it sits, so the recommendation can be shown to hold none.
 *
 * The document schema is strict, so an unexpected key on the recommendation already fails the parse;
 * this walk is the other half of rule 1, checking the fields the contract does declare carry no
 * number a caller could read as a price.
 */
function numericLeavesIn(value: unknown): readonly number[] {
  if (typeof value === 'number') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown) => numericLeavesIn(entry));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => numericLeavesIn(entry));
  }

  return [];
}

/** How many calls of one role the replay provider issued, a retry included. */
function stubCallCount(testApp: TestApp, role: 'extraction' | 'synthesis'): number {
  const stub = testApp.stub;

  if (stub === null) {
    throw new Error('This suite builds its application with the replay provider, which must be present.');
  }

  return stub.calls.filter((call) => call.role === role).length;
}

/** The recommendation a stored or freshly created document carries, for the assertions about it. */
function recommendationOf(document: AnalysisDocument): Recommendation {
  return document.recommendation;
}

describe(`POST ${ANALYSES_PATH} — the created analysis document`, () => {
  it('answers 200 with a document the shared schema accepts (criterion 5)', async () => {
    const testApp = await buildApp();

    const response = await submitTwoScreenshots(testApp);

    expect(response.status).toBe(200);
    expect(() => analysisDocumentSchema.parse(response.body)).not.toThrow();
  });

  it('mints an analysis id and stamps an ISO-8601 UTC completion instant', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    expect(typeof document.analysisId).toBe('string');
    expect(document.analysisId.trim().length).toBeGreaterThan(0);
    expect(document.createdAt).toMatch(ISO_UTC_PATTERN);
    expect(Number.isFinite(Date.parse(document.createdAt))).toBe(true);
  });

  it('echoes the submitted instrument and context, both inside their caps', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    expect(document.instrument).toBe(INSTRUMENT);
    expect(document.context).toBe(CONTEXT);
    // Counted in code points, which is how the service clamps: an over-long value would be shortened
    // rather than refused (D12), and this submission is inside both bounds so both arrive intact.
    expect(Array.from(document.instrument)).toHaveLength(Array.from(INSTRUMENT).length);
    expect(Array.from(document.instrument).length).toBeLessThanOrEqual(INSTRUMENT_MAX_CHARS);
    expect(Array.from(document.context).length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });

  it('records both screenshots in submission order with the geometry their own bytes carry', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    const submitted = SUBMITTED_STEMS.map((stem) => ({
      attachment: screenshotAttachment(stem),
      dimensions: pngDimensionsOf(stem),
    }));

    expect(document.images.map((image) => image.fileName)).toEqual(
      submitted.map((entry) => entry.attachment.fileName),
    );

    for (const entry of submitted) {
      const image = imageFor(document, entry.attachment.fileName);

      expect(IMAGE_STATUSES).toContain(image.status);
      expect(image.status).toBe(ANALYZED);
      // The type is what the server sniffed from the magic bytes, which for these fixtures is the type
      // the multipart part claimed; the two agreeing is what the comparison asserts.
      expect(image.contentType).toBe(entry.attachment.contentType);
      expect(image.byteSize).toBe(entry.attachment.bytes.length);
      expect(image.width).toBe(entry.dimensions.width);
      expect(image.height).toBe(entry.dimensions.height);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(MAX_LONG_EDGE_PX);
      // The reason travels only with the unreadable case, which the stored shape refuses on a read
      // image; the contract's discriminated union is what this asserts rather than the builder's style.
      expect(image).not.toHaveProperty('extractionError');
    }
  });

  it('reports one level per recorded price-and-code pair, mapped through the shared vocabulary', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    const pairs = recordedPairs();
    const recordedPrices = new Set(pairs.map((pair) => pair.price));
    const submittedImageIds = new Set(document.images.map((image) => image.imageId));

    expect(document.levels).toHaveLength(pairs.length);

    const levelIds = document.levels.map((level) => level.levelId);
    expect(new Set(levelIds).size).toBe(levelIds.length);
    expect(document.levels.filter((level) => !LEVEL_TYPES.includes(level.type))).toEqual([]);
    // D6: the stored price is the number the recording reported, never a rounded or rescaled copy.
    expect(document.levels.filter((level) => !recordedPrices.has(level.price))).toEqual([]);
    expect(document.levels.filter((level) => !submittedImageIds.has(level.imageId))).toEqual([]);

    // Each level must be the pair its own screenshot reported at that price, labelled with the type the
    // shared code map gives that pair's code — which is what proves the mapping ran in the server.
    const codeByImageAndPrice = new Map<string, ExtractionCode>();
    for (const stem of SUBMITTED_STEMS) {
      const imageId = imageFor(document, screenshotAttachment(stem).fileName).imageId;

      for (const pair of recordedPairsFor(stem)) {
        codeByImageAndPrice.set(`${imageId}|${pair.price}`, pair.code);
      }
    }

    const mismapped = document.levels.filter((level) => {
      const code = codeByImageAndPrice.get(`${level.imageId}|${level.price}`);

      return code === undefined || level.type !== EXTRACTION_CODE_TO_LEVEL_TYPE[code];
    });

    expect(mismapped).toEqual([]);
  });

  it('takes the side, confidence and sentence the recorded synthesis answered with', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    const answer = recordedLongAnswer();
    const recommendation = recommendationOf(document);

    expect(SIDES).toContain(recommendation.side);
    expect(recommendation.side).toBe(SIDE_CODE_TO_SIDE[answer.s]);
    // Rule 4's corrected timing belongs to the timing suite; here the recorded proposal must only land
    // in the public vocabulary rather than in the model's code space.
    expect(TIMINGS).toContain(recommendation.timing);
    expect(recommendation.confidence).toBe(CONFIDENCE_CODE_TO_CONFIDENCE[answer.c]);
    expect(recommendation.summary).toBe(answer.w);
    expect(Array.from(recommendation.summary).length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('resolves the entry, invalidation and target references to the cited prices exactly', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    const answer = recordedLongAnswer();
    const recommendation = recommendationOf(document);
    const recordedPrices = new Set(recordedPairs().map((pair) => pair.price));

    const entry = levelCited(document, recommendation.entryLevelId, 'entryLevelId');
    const invalidation = levelCited(
      document,
      recommendation.invalidationLevelId,
      'invalidationLevelId',
    );

    expect(entry.price).toBe(citedPrice(answer.e, 'entry'));
    expect(invalidation.price).toBe(citedPrice(answer.x, 'invalidation'));

    // A recorded target that matched no level is dropped rather than estimated (rule 6), so the
    // expectation is the recorded targets the two extractions actually carry, in cited order.
    const expectedTargetPrices = answer.k.filter((price) => recordedPrices.has(price));
    const targetPrices = recommendation.targetLevelIds.map(
      (levelId) => levelCited(document, levelId, 'targetLevelIds').price,
    );

    expect(targetPrices).toEqual(expectedTargetPrices);

    // The trigger is the price the timing was judged against, so it references the entry level (D7).
    expect(recommendation.triggerLevelId).toBe(recommendation.entryLevelId);
  });

  it('carries no price of its own in the recommendation (rule 1)', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    // Every price a read displays is reached through `levels[]`; the recommendation itself holds level
    // references and no number anywhere, which is the structural half of rule 1.
    expect(numericLeavesIn(recommendationOf(document))).toEqual([]);
    // The same walk finds the prices where they belong, so the assertion above is not vacuous.
    expect(numericLeavesIn(document.levels).length).toBeGreaterThan(0);
  });

  it('builds the evidence from the levels the read cites (D10)', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    const recommendation = recommendationOf(document);
    const levelIds = new Set(document.levels.map((level) => level.levelId));
    const imageIds = new Set(document.images.map((image) => image.imageId));

    expect(document.rationale.length).toBeGreaterThan(0);

    for (const entry of document.rationale) {
      expect(typeof entry.claim).toBe('string');
      expect(entry.claim.trim().length).toBeGreaterThan(0);
      expect(imageIds.has(entry.imageId)).toBe(true);
      expect(entry.levelIds.filter((levelId) => !levelIds.has(levelId))).toEqual([]);
    }

    const citedLevelIds = document.rationale.flatMap((entry) => entry.levelIds);

    // One entry per level and one mention per level, with no level cited twice.
    expect(new Set(citedLevelIds).size).toBe(citedLevelIds.length);

    const referencedLevelIds = [
      recommendation.entryLevelId,
      recommendation.invalidationLevelId,
      ...recommendation.targetLevelIds,
    ].filter((levelId): levelId is string => levelId !== null);

    expect(referencedLevelIds.filter((levelId) => !citedLevelIds.includes(levelId))).toEqual([]);
  });

  it('records the assumptions as sentences, possibly none', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    expect(Array.isArray(document.assumptions)).toBe(true);
    expect(
      document.assumptions.filter(
        (assumption) => typeof assumption !== 'string' || assumption.trim() === '',
      ),
    ).toEqual([]);
  });

  it('records the model, the instruction version it ran under and what the analysis cost (D14)', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    const usage = document.modelUsage;

    expect(usage.model).toBe(testApp.config.model);
    // The version is the prompt library's, read at request time; the suite never restates the string.
    expect(usage.promptVersion).toBe(getPromptVersion());
    // Two images, one extraction each and no retry: the count is the calls issued, which the replay
    // provider recorded, not merely the number of images submitted.
    expect(usage.imageCallCount).toBe(SUBMITTED_STEMS.length);
    expect(usage.imageCallCount).toBe(stubCallCount(testApp, 'extraction'));
    expect(stubCallCount(testApp, 'synthesis')).toBe(1);

    expect(Number.isInteger(usage.synthesisCompletionTokens)).toBe(true);
    expect(usage.synthesisCompletionTokens).toBeGreaterThan(0);
    expect(usage.synthesisCompletionTokens).toBeLessThanOrEqual(MAX_TOKENS_SYNTHESIS);
    expect(usage.synthesisCompletionTokens).toBe(recordedCompletionTokens(recordedSynthesis('long')));

    expect(Number.isFinite(usage.latencyMs)).toBe(true);
    expect(usage.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('names the one provider the shared contract admits', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    // The document's own provider is proven by the schema parse above: its field is a literal in the
    // shared schema, so a document naming any other provider cannot be persisted or returned. What this
    // case adds is that the literal is exclusive, without restating it here.
    expect(analysisDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      analysisDocumentSchema.safeParse({
        ...document,
        modelUsage: { ...document.modelUsage, provider: 'another-model-provider' },
      }).success,
    ).toBe(false);
  });

  it('carries the fixed disclaimer, byte for byte', async () => {
    const testApp = await buildApp();
    const { document } = await createdDocument(testApp);

    expect(document.disclaimer).toBe(DISCLAIMER);
  });
});

describe(`the response surface around ${ANALYSES_PATH}`, () => {
  it('rests the recorded baseline read on prices both screenshots carry, so it survives the passes', () => {
    // A precondition rather than a behaviour: the document cases below assert a directional read, which
    // only exists if the recorded answer cites prices the two recordings carry and names two images.
    // Were the recordings to change, this fails here with the reason instead of the contract cases
    // below failing for a cause that looks like a mapping defect.
    const answer = recordedLongAnswer();

    for (const price of [answer.e, answer.x, ...answer.k]) {
      if (price !== null) {
        expect(stemsCarrying(price).size).toBeGreaterThan(0);
      }
    }

    expect(answer.e).not.toBeNull();
    expect(answer.x).not.toBeNull();

    const entryStems = stemsCarrying(answer.e);
    const invalidationStems = stemsCarrying(answer.x);

    // Rule 3's first half: the entry and the invalidation must be available from two distinct images.
    expect([...entryStems].some((stem) => !invalidationStems.has(stem))).toBe(true);
    // And its second half: the answer must name at least two source images, which the replay adapter
    // aligns onto the ids the submission generated before the domain reads them as evidence.
    expect(new Set(answer.src).size).toBeGreaterThanOrEqual(2);
  });

  it('returns the stored document from the read route unchanged', async () => {
    const testApp = await buildApp();
    const { response, document } = await createdDocument(testApp);

    const stored = await request(testApp.app).get(`${ANALYSES_PATH}/${document.analysisId}`);

    expect(stored.status).toBe(200);
    expect(stored.body).toEqual(response.body);
  });

  it('echoes the first admitted client origin on a submission', async () => {
    const testApp = await buildApp();

    const response = await submitTwoScreenshots(testApp, FIRST_CLIENT_ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(FIRST_CLIENT_ORIGIN);
  });

  it('echoes the second admitted client origin on a submission', async () => {
    const testApp = await buildApp();

    const response = await submitTwoScreenshots(testApp, SECOND_CLIENT_ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(SECOND_CLIENT_ORIGIN);
  });

  it('advertises no allow header to an origin outside the allowlist (D1)', async () => {
    const testApp = await buildApp();

    const response = await submitTwoScreenshots(testApp, FOREIGN_ORIGIN);

    // Declining to advertise the origin is the whole refusal: the browser then discards the response.
    expect(response.headers['access-control-allow-origin']).not.toBe(FOREIGN_ORIGIN);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts a submission that sets no Authorization header (D1)', async () => {
    const testApp = await buildApp();

    const response = await submitTwoScreenshots(testApp);
    const outgoing = response.request.req;
    const authorization =
      'getHeader' in outgoing ? outgoing.getHeader('authorization') : undefined;

    // No authentication exists, so nothing is sent and nothing is asked for.
    expect(authorization).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(analysisDocumentSchema.safeParse(response.body).success).toBe(true);
  });

  it('keeps two identical submissions apart instead of deduplicating them', async () => {
    const testApp = await buildApp();

    const first = await createdDocument(testApp);
    const second = await createdDocument(testApp);

    expect(first.document.analysisId).not.toBe(second.document.analysisId);

    const listResponse = await request(testApp.app).get(ANALYSES_PATH);
    const list: AnalysisListResponse = listResponse.body;
    const listedIds = list.items.map((item) => item.analysisId);

    expect(listResponse.status).toBe(200);
    expect(listedIds).toContain(first.document.analysisId);
    expect(listedIds).toContain(second.document.analysisId);

    // Each is retrievable on its own, so neither submission overwrote the other.
    const stored = await request(testApp.app).get(`${ANALYSES_PATH}/${second.document.analysisId}`);

    expect(stored.status).toBe(200);
    expect(stored.body).toEqual(second.response.body);
  });

  it('carries no configured credential into the response (§0.4.5)', async () => {
    const testApp = await buildApp({ config: { OPENROUTER_API_KEY: SENTINEL_CREDENTIAL } });

    const { response } = await createdDocument(testApp);
    const credential = testApp.config.openRouterApiKey;

    if (credential === null) {
      throw new Error('This case configures a key, so the resolved configuration must carry one.');
    }

    expect(credential).toBe(SENTINEL_CREDENTIAL);
    expect(JSON.stringify(response.body)).not.toContain(credential);
    expect(JSON.stringify(response.headers)).not.toContain(credential);
  });
});

