/**
 * Suite for the read and delete routes of the analysis surface: the route-layer evidence for
 * AAP §0.6.1 (the history page, one stored analysis, a removal), §0.6.3 (an unknown or malformed id
 * is answered with the error table's not-found refusal and no stack or filesystem path) and §0.6.6
 * criterion 8 (what was created is still returned and still listed, and a removal leaves neither
 * document nor bytes).
 *
 * Three boundaries are pinned here, each over HTTP against the composed application the helpers
 * build rather than against a piece of it:
 *
 * - The page. The history page holds exactly the documents the store retained, newest first, and an
 *   empty store is an empty array rather than a failure. The page size a caller names is honoured;
 *   the cap and the fall-backs for a bad value belong to the limits suite, which owns that row.
 * - Identity (D1). An analysis id arrives from a URL and becomes a directory name, so every id is
 *   pattern-checked before a path is built. A crafted id — a traversal, a NUL escape, a plain word,
 *   a long run of digits — is answered exactly as a record that was never stored, so a caller can
 *   neither tell the two apart nor learn the store's layout by probing. No request in this suite
 *   carries an `Authorization` header, because no authentication exists.
 * - Removal (D2). A delete answers no-content with no body and takes the document and the retained
 *   image bytes together, so no document outlives the evidence it cites. The bytes are read once
 *   before the delete, which is what makes "both are gone" observed rather than assumed.
 *
 * The document's own shape is not re-proved here: the create suite owns the full contract, and this
 * file only asserts the fields a page and a lookup must carry through unchanged.
 *
 * Everything runs offline. The helper composes the application over the replay provider and a fresh
 * temporary data directory, so no credential, no network and no environment variable is involved,
 * and every failure status, code and sentence asserted on the wire is read from the shared error
 * table (D4) rather than restated as a literal here.
 */
import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  INSTRUMENT_MAX_CHARS,
  type AnalysisDocument,
  type AnalysisListResponse,
  type ApiErrorBody,
  type ErrorCode,
} from '@trade-read/shared';

import { buildTestApp, type TestApp } from '../helpers/build-test-app.js';
import { screenshotAttachment } from '../helpers/fixtures.js';

/**
 * The resource segment the analysis routes are mounted on, relative to the shared API base path.
 *
 * The base path itself comes from the shared package; the resource segments below are the router's
 * own and are named once here so every request in this file is built from one place.
 */
const ANALYSES_SEGMENT = '/analyses';

/** The sub-resource segment that serves one analysis's retained image bytes. */
const IMAGES_SEGMENT = '/images';

/**
 * The one committed screenshot every submission in this suite carries.
 *
 * The replay provider answers an extraction call by the submitted file's stem, so one readable
 * screenshot yields a complete document. What this suite varies is how many analyses exist, not what
 * they contain.
 */
const READABLE_SCREENSHOT = screenshotAttachment('footprint-es-5m');

/** Instruments the ordering cases submit, distinct so a page's order is visible in the response. */
const EARLIER_INSTRUMENT = 'ES-earlier';

const LATER_INSTRUMENT = 'ES-later';

/**
 * The one code every refusal in this suite carries.
 *
 * The shared package models its codes as a closed tuple rather than as a map, so the member cannot be
 * reached by key and is named once here, typed as that tuple's own element: a name the table does not
 * hold stops the build. Everything else about a refusal is read from the tables — the status via
 * {@link ERROR_STATUS} and the sentence via {@link ERROR_MESSAGES} — so no status number and no
 * sentence is restated in this file (D4).
 */
const NOT_FOUND: ErrorCode = 'NOT_FOUND';

/**
 * An analysis id of the shape this system generates — a lowercase RFC 4122 version-4 UUID — that was
 * never stored.
 *
 * It is deliberately a value the id guard admits, so the refusal it earns is a genuine miss in the
 * store rather than a refusal by the pattern, and the two kinds of refusal are asserted separately.
 */
const NEVER_STORED_ANALYSIS_ID = '3f7a1c58-2d94-4b6e-8f13-5c9d0a7e4b28';

/**
 * Path segments a caller may put where an analysis or image id belongs, each already URL-encoded as
 * a hostile caller would send it.
 *
 * None of them is text this system generated, so the guard must refuse each one before any path is
 * built: a traversal that would escape `DATA_DIR` if it were joined, a NUL escape, a plain word and
 * a long run of digits. A refusal that named a path, threw a stack or answered as an internal
 * failure would turn the unauthenticated API into a filesystem probe, which is why this case exists.
 */
const MALFORMED_ID_SEGMENTS: readonly string[] = [
  'not-an-analysis-id',
  `${'..%2F'.repeat(6)}etc%2Fpasswd`,
  '%00',
  '0'.repeat(64),
];

/**
 * The document fields a page entry must carry.
 *
 * Typed as keys of the shared document, so a field renamed in the contract is a compile error here
 * instead of an assertion that silently stops covering it. The full document contract — every field,
 * every level, every rationale entry — is proved by the create suite; repeating it on the page would
 * make a failure here say "list" when the defect is the document.
 */
const LISTED_DOCUMENT_FIELDS: ReadonlyArray<keyof AnalysisDocument> = [
  'analysisId',
  'createdAt',
  'images',
  'levels',
  'recommendation',
  'disclaimer',
];

/**
 * The status a successful submission and a successful read are answered with (AAP §0.3.1).
 *
 * The shared package's status table holds the failure rows only, so the success statuses are named
 * once here and asserted through these names rather than repeated as bare numbers at each call.
 */
const OK_STATUS = 200;

/** The status a completed removal is answered with, carrying no body (AAP §0.3.1). */
const NO_CONTENT_STATUS = 204;

/** The application one case drives: built afresh per case and released afterwards. */
let testApp: TestApp;

beforeEach(async () => {
  testApp = await buildTestApp();
});

afterEach(async () => {
  await testApp.cleanup();
});

/** The path of the history page. */
function analysesPath(): string {
  return `${API_BASE_PATH}${ANALYSES_SEGMENT}`;
}

/** The path of one stored analysis. */
function analysisPath(analysisId: string): string {
  return `${analysesPath()}/${analysisId}`;
}

/** The path of the bytes of one image stored with one analysis. */
function imageBytesPath(analysisId: string, imageId: string): string {
  return `${analysisPath(analysisId)}${IMAGES_SEGMENT}/${imageId}`;
}

/**
 * Posts one submission and returns the document the server answered with.
 *
 * The instrument is asserted to fit the shared cap before it is sent: the domain clamps a longer
 * value rather than rejecting it, and two analyses whose instruments were truncated to the same text
 * would make the ordering case below indistinguishable from a store defect.
 */
async function createAnalysis(instrument: string): Promise<AnalysisDocument> {
  expect(instrument.length).toBeLessThanOrEqual(INSTRUMENT_MAX_CHARS);

  const response = await request(testApp.app)
    .post(analysesPath())
    .attach('images', READABLE_SCREENSHOT.bytes, {
      filename: READABLE_SCREENSHOT.fileName,
      contentType: READABLE_SCREENSHOT.contentType,
    })
    .field('instrument', instrument);

  expect(response.status, 'the submission must be accepted before a read can be exercised').toBe(
    OK_STATUS,
  );

  return response.body as AnalysisDocument;
}

/** The entries of a history page, read through the shared response type. */
function listItems(response: SupertestResponse): AnalysisDocument[] {
  return (response.body as AnalysisListResponse).items;
}

/**
 * The entry at `index` of a list this suite asked for, narrowed from the possibly-absent element
 * `noUncheckedIndexedAccess` reports, so every later read of it is a value rather than a check.
 */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`expected an entry at position ${index}, but the list held ${items.length}.`);
  }

  return item;
}

/**
 * The analysis a newest-first page must lead with, given two creations.
 *
 * The later instant wins. Two analyses can complete inside one millisecond, and the store then
 * orders them by id descending, which is its documented tie-break; stating that here keeps the
 * expectation decidable on any host instead of depending on the clock's resolution.
 */
function newestOf(first: AnalysisDocument, second: AnalysisDocument): AnalysisDocument {
  if (first.createdAt !== second.createdAt) {
    return first.createdAt > second.createdAt ? first : second;
  }

  return first.analysisId > second.analysisId ? first : second;
}

/** The creation {@link newestOf} does not pick. */
function olderOf(first: AnalysisDocument, second: AnalysisDocument): AnalysisDocument {
  return newestOf(first, second) === first ? second : first;
}

/**
 * Asserts one refusal is the shared table's not-found row and nothing else.
 *
 * The body is exactly `{ code, message }` from the shared contract, with the status and the sentence
 * read from the shared tables and the code constrained by them (D4). The refusal is the whole answer:
 * a crafted id is never a success that reveals what exists and never an internal failure whose body
 * could carry a path or a stack (AAP §0.6.3). The message must name neither the data directory the
 * record would have lived in nor a frame of a stack trace, which keeps an unauthenticated caller from
 * learning the store's layout by probing (D1).
 */
function expectNotFound(response: SupertestResponse): void {
  const body = response.body as ApiErrorBody;

  expect(ERROR_CODES).toContain(body.code);
  expect(response.status).toBe(ERROR_STATUS[NOT_FOUND]);
  expect(body.code).toBe(NOT_FOUND);
  expect(body.message).toBe(ERROR_MESSAGES[NOT_FOUND]);
  expect(Object.keys(body)).toEqual(['code', 'message']);
  expect(body.message).not.toContain(testApp.dataDir);
  expect(body.message).not.toContain('node_modules');
  expect(JSON.stringify(body)).not.toMatch(/\n\s+at\s/);
}

/**
 * Asserts a page holds exactly the two creations it is given, newest first.
 *
 * The instruments are asserted as well as the ids, so the pair a page returns is visibly the pair the
 * case submitted rather than two documents that merely count to two.
 */
function expectNewestFirst(
  items: readonly AnalysisDocument[],
  earlier: AnalysisDocument,
  later: AnalysisDocument,
): void {
  const newest = newestOf(earlier, later);
  const older = olderOf(earlier, later);

  expect(items).toHaveLength(2);
  expect(itemAt(items, 0).analysisId).toBe(newest.analysisId);
  expect(itemAt(items, 1).analysisId).toBe(older.analysisId);
  expect(items.map((item) => item.instrument)).toEqual([newest.instrument, older.instrument]);
  expect(newest.instrument).not.toBe(older.instrument);
  expect(Date.parse(itemAt(items, 0).createdAt)).toBeGreaterThanOrEqual(
    Date.parse(itemAt(items, 1).createdAt),
  );
}

/**
 * Asserts the page holds one id and no other, reading the listing afresh on every call so the
 * assertion is about what the store answers now rather than about an earlier response.
 */
async function expectPageHoldsExactly(analysisIds: readonly string[]): Promise<void> {
  const response = await request(testApp.app).get(analysesPath());

  expect(response.status).toBe(OK_STATUS);
  expect(listItems(response).map((item) => item.analysisId).sort()).toEqual([...analysisIds].sort());
}

describe('the history page', () => {
  it('answers an empty items array when nothing has been stored', async () => {
    const response = await request(testApp.app).get(analysesPath());

    expect(response.status).toBe(OK_STATUS);
    expect(Object.keys(response.body as AnalysisListResponse)).toEqual(['items']);
    expect(listItems(response)).toEqual([]);
  });

  it("lists the newest analysis first and carries each document's top-level fields", async () => {
    const earlier = await createAnalysis(EARLIER_INSTRUMENT);
    const later = await createAnalysis(LATER_INSTRUMENT);

    const response = await request(testApp.app).get(analysesPath());

    expect(response.status).toBe(OK_STATUS);

    const items = listItems(response);

    expectNewestFirst(items, earlier, later);

    // The page carries documents rather than a projection of them, so the fields a caller opens an
    // analysis by travel on the page unchanged.
    for (const item of items) {
      expect(Object.keys(item)).toEqual(expect.arrayContaining([...LISTED_DOCUMENT_FIELDS]));
    }
  });

  it('honours the page size a caller names', async () => {
    const earlier = await createAnalysis(EARLIER_INSTRUMENT);
    const later = await createAnalysis(LATER_INSTRUMENT);

    const one = await request(testApp.app).get(analysesPath()).query({ limit: 1 });

    expect(one.status).toBe(OK_STATUS);
    expect(listItems(one)).toHaveLength(1);
    expect(itemAt(listItems(one), 0).analysisId).toBe(newestOf(earlier, later).analysisId);

    // A page at the documented default size and at the documented cap each hold everything stored,
    // so neither bound truncates a store this small. The cap itself, and the fall-backs for a value
    // that is not a page size, are proved by the limits suite, which owns that row.
    for (const limit of [HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX]) {
      const page = await request(testApp.app).get(analysesPath()).query({ limit });

      expect(page.status).toBe(OK_STATUS);
      expect(listItems(page)).toHaveLength(2);
    }
  });
});

describe('one stored analysis', () => {
  it('returns the document exactly as the submission created it', async () => {
    const created = await createAnalysis(EARLIER_INSTRUMENT);

    const response = await request(testApp.app).get(analysisPath(created.analysisId));

    expect(response.status).toBe(OK_STATUS);

    const fetched = response.body as AnalysisDocument;

    // The stored record is the creation response, not a second rendering of it: the document is
    // persisted verbatim, so a lookup reproduces it field for field.
    expect(fetched).toEqual(created);
    expect(fetched.analysisId).toBe(created.analysisId);
    expect(fetched.images).toEqual(created.images);
    expect(fetched.levels).toEqual(created.levels);
    expect(fetched.recommendation).toEqual(created.recommendation);
  });
});

describe('an id the store cannot answer for', () => {
  it('answers the not-found refusal for an id of the right shape that was never stored', async () => {
    const created = await createAnalysis(EARLIER_INSTRUMENT);

    const response = await request(testApp.app).get(analysisPath(NEVER_STORED_ANALYSIS_ID));

    expectNotFound(response);

    // A refused lookup changes nothing, and the analysis that does exist still answers.
    const stored = await request(testApp.app).get(analysisPath(created.analysisId));

    expect(stored.status).toBe(OK_STATUS);
    await expectPageHoldsExactly([created.analysisId]);
  });

  it.each([...MALFORMED_ID_SEGMENTS])(
    'answers the not-found refusal for the path segment %s',
    async (segment: string) => {
      const created = await createAnalysis(EARLIER_INSTRUMENT);

      const response = await request(testApp.app).get(`${analysesPath()}/${segment}`);

      // Never a success that reveals what exists, and never an internal failure carrying a path
      // or a stack.
      expectNotFound(response);
      await expectPageHoldsExactly([created.analysisId]);
    },
  );

  it('refuses a malformed id on the delete and the image-bytes routes the same way', async () => {
    const created = await createAnalysis(EARLIER_INSTRUMENT);
    const image = itemAt(created.images, 0);
    const plainWord = itemAt(MALFORMED_ID_SEGMENTS, 0);
    const traversal = itemAt(MALFORMED_ID_SEGMENTS, 1);
    const nulEscape = itemAt(MALFORMED_ID_SEGMENTS, 2);

    // The traversal names the analysis to delete, a malformed analysis id names the bytes to read,
    // and a malformed image id names the file to read inside a valid analysis: all three are refused
    // before any path is built, and each refusal is the same body a missing record earns.
    expectNotFound(await request(testApp.app).delete(`${analysesPath()}/${traversal}`));
    expectNotFound(await request(testApp.app).get(`${analysesPath()}/${nulEscape}`));
    expectNotFound(
      await request(testApp.app).get(imageBytesPath(created.analysisId, plainWord)),
    );

    // The refused delete removed nothing: the document and its bytes are still served.
    const document = await request(testApp.app).get(analysisPath(created.analysisId));

    expect(document.status).toBe(OK_STATUS);

    const bytes = await request(testApp.app).get(imageBytesPath(created.analysisId, image.imageId));

    expect(bytes.status).toBe(OK_STATUS);
    await expectPageHoldsExactly([created.analysisId]);
  });

  it('stores nothing when lookups are refused', async () => {
    const earlier = await createAnalysis(EARLIER_INSTRUMENT);
    const later = await createAnalysis(LATER_INSTRUMENT);

    for (const segment of MALFORMED_ID_SEGMENTS) {
      expectNotFound(await request(testApp.app).get(`${analysesPath()}/${segment}`));
      expectNotFound(await request(testApp.app).delete(`${analysesPath()}/${segment}`));
    }

    expectNotFound(await request(testApp.app).get(analysisPath(NEVER_STORED_ANALYSIS_ID)));
    expectNotFound(await request(testApp.app).delete(analysisPath(NEVER_STORED_ANALYSIS_ID)));

    // Exactly the two analyses this case created survive: a refused read or delete is not a write.
    await expectPageHoldsExactly([earlier.analysisId, later.analysisId]);
  });
});

describe('deleting one analysis', () => {
  it('removes the document and the retained image bytes together', async () => {
    const created = await createAnalysis(EARLIER_INSTRUMENT);
    const image = itemAt(created.images, 0);

    // Read the bytes once before the delete, so their absence afterwards is a change this case
    // observed rather than one it assumes (D2).
    const before = await request(testApp.app).get(imageBytesPath(created.analysisId, image.imageId));

    expect(before.status).toBe(OK_STATUS);
    expect(before.headers['content-type']).toContain(image.contentType);
    expect(Number(before.headers['content-length'])).toBe(image.byteSize);

    const deleted = await request(testApp.app).delete(analysisPath(created.analysisId));

    expect(deleted.status).toBe(NO_CONTENT_STATUS);
    expect(deleted.text).toBe('');
    expect(deleted.body).toEqual({});

    expectNotFound(await request(testApp.app).get(analysisPath(created.analysisId)));
    expectNotFound(
      await request(testApp.app).get(imageBytesPath(created.analysisId, image.imageId)),
    );

    const page = await request(testApp.app).get(analysesPath());

    expect(listItems(page)).toEqual([]);
  });

  it('answers the not-found refusal for an id that was never stored and keeps the page', async () => {
    const created = await createAnalysis(EARLIER_INSTRUMENT);

    expectNotFound(await request(testApp.app).delete(analysisPath(NEVER_STORED_ANALYSIS_ID)));

    await expectPageHoldsExactly([created.analysisId]);

    const stored = await request(testApp.app).get(analysisPath(created.analysisId));

    expect(stored.status).toBe(OK_STATUS);
  });
});
