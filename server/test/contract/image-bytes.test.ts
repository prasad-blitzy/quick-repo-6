/**
 * Suite for the retained-bytes route, `GET {API_BASE_PATH}/analyses/:id/images/:imageId`.
 *
 * Why the route exists at all (AAP §0.3.1, D3): it is the one addition to the request's endpoint
 * list, because the analysis surface has to re-display a stored screenshot beside the evidence that
 * cites it — without a read path the bytes the store retains would serve nothing. It is served from
 * `AnalysisRepository.readImage`, so it inherits the id guard and the deletion semantics of the
 * document rather than owning a second set of them.
 *
 * The rows this file proves:
 *
 * - AAP §0.6.1, "stored image bytes are readable": `200` with the stored bytes and the content type
 *   they were stored with, and `NOT_FOUND` for an id that matches no stored record.
 * - AAP §0.6.3, unknown and malformed ids: the shared `NOT_FOUND` body, no stack trace and no
 *   filesystem path in it, and never the internal-error status a leaked failure would produce.
 * - AAP §0.6.6 criterion 8, at the byte level: a deletion leaves neither the document nor the bytes.
 *
 * Decisions honoured:
 *
 * - D1 (identity and trust): this route's only defence is the id guard, which runs before any path
 *   is built, so a crafted id is answered exactly like a record that was never stored. No
 *   authentication exists, so no request here sends an `Authorization` header and no response
 *   carries one back.
 * - D2 (audit of writes): the bytes are on disk before the document that cites them and a deletion
 *   removes the document and then the bytes — which is why a read after the delete finds nothing.
 * - D3 (data reach): the route forwards the repository's `readImage`, so this suite drives the real
 *   filesystem store over a real temporary data directory instead of a mock of either.
 * - D4 (shared components): the base path, the error codes, statuses and sentences and the accepted
 *   content types are imported from `@trade-read/shared`, and the content type asserted on a
 *   response is read back off the stored document, so no MIME literal is restated here.
 *
 * Nothing here needs a credential or a network. `buildTestApp` composes the real application with
 * the replay provider over a fresh temporary data directory, and clears `OPENROUTER_API_KEY`; the
 * image bytes are read from the committed screenshot fixtures at run time and never written into
 * this file, so it carries no binary or encoded payload of its own (AAP §0.4.5).
 */
import { randomUUID } from 'node:crypto';

import request, { type Response as SuperagentResponse } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  API_BASE_PATH,
  type AnalysisDocument,
  type AnalysisImage,
  type ApiErrorBody,
  ERROR_CODES,
  type ErrorCode,
  ERROR_MESSAGES,
  ERROR_STATUS,
  type ImageStatus,
} from '@trade-read/shared';

import { buildTestApp, type TestApp } from '../helpers/build-test-app.js';
import {
  type MultipartAttachment,
  type ScreenshotStem,
  screenshotAttachment,
  screenshotBytes,
} from '../helpers/fixtures.js';

// -------------------------------------------------------------------------------------------------
// Route shape, statuses and vocabulary.
//
// The shared package carries the API base path and the failure table, and nothing about the two
// segments the router owns or about the statuses a success answers with, so those are named once
// here beside the base path they extend and no test builds a path, a status or a code of its own.
// Values shared does carry — the accepted content types, the codes, their statuses and their
// sentences — are imported and never restated.
// -------------------------------------------------------------------------------------------------

/** The path segment the analysis router is mounted on, inside the shared API base path. */
const ANALYSES_SEGMENT = 'analyses';

/** The sub-path that carries one image's stored bytes. */
const IMAGES_SEGMENT = 'images';

/** The one multipart field the API accepts image parts under. */
const IMAGE_FILE_FIELD = 'images';

/**
 * The status a successful read or a successful create answers with.
 *
 * `ERROR_STATUS` holds the failure table only, so the one success status this suite needs is named
 * here rather than written at each assertion.
 */
const RESPONSE_OK_STATUS = 200;

/** The status a successful removal answers with; absent from the failure table for the same reason. */
const DELETE_SUCCESS_STATUS = 204;

/**
 * The code this route answers an id it will not serve with.
 *
 * The shared table declares its codes as a tuple rather than as an object with a property per code,
 * so the single code is named once here with the shared `ErrorCode` union as its type: a code that
 * shared renamed or removed would fail this line at compile time, and every assertion below reads
 * its status and its sentence back out of the shared records.
 */
const NOT_FOUND_CODE: ErrorCode = 'NOT_FOUND';

/**
 * The code an unexpected throw would produce. It is referenced only so the suite can prove that
 * status never answers a malformed id (AAP §0.6.3, D1).
 */
const INTERNAL_ERROR_CODE: ErrorCode = 'INTERNAL_ERROR';

/** The one status this route answers with for every id it will not serve. */
const NOT_FOUND_STATUS = ERROR_STATUS[NOT_FOUND_CODE];

/**
 * The status a leaked failure would produce, asserted against explicitly so a `500` can never pass
 * as the expected `NOT_FOUND`.
 */
const INTERNAL_ERROR_STATUS = ERROR_STATUS[INTERNAL_ERROR_CODE];

/** The shared accepted-type list, widened to strings so a stored content type can be looked up in it. */
const ACCEPTED_CONTENT_TYPES: ReadonlyArray<string> = ACCEPTED_IMAGE_MIME_TYPES;

/** The exact key set of a failure body: nothing beyond the code and the sentence. */
const ERROR_BODY_KEYS = ['code', 'message'] as const;

/** A stack frame as JSON renders it, which no response body may contain (AAP §0.6.3). */
const STACK_FRAME_PATTERN = /\n\s+at\s/;

/** A directory name that appears only in a body that leaked a resolved filesystem path (D1). */
const DEPENDENCY_DIRECTORY = 'node_modules';

/** One readable footprint screenshot: levels, a current price, and an `OK` extraction. */
const FOOTPRINT_SCREENSHOT: ScreenshotStem = 'footprint-es-5m';

/** A second readable screenshot of a different kind, so a submission can hold two distinct images. */
const GEX_SCREENSHOT: ScreenshotStem = 'gex-es-levels';

/** A screenshot the extraction reports as `BLANK`, whose levels are discarded but whose bytes remain. */
const BLANK_SCREENSHOT: ScreenshotStem = 'blank-uniform';

/** The status of an image the extraction could not read, from the contract's own image statuses. */
const UNREADABLE_STATUS: ImageStatus = 'UNREADABLE';

// -------------------------------------------------------------------------------------------------
// Request helpers.
// -------------------------------------------------------------------------------------------------

/** One response whose body is kept as the exact bytes the server wrote. */
interface BinaryResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bytes: Buffer;
}

/** One response whose body has not been narrowed yet. */
interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The parser that hands supertest the raw response body.
 *
 * Supertest's node transport parses with the response's own content type, so a stored PNG would
 * arrive as decoded text or as an empty value. A custom parser replaces that step with the received
 * chunks, which is what lets an assertion compare real bytes. `.buffer(true)` on the request is what
 * keeps the stream in binary mode: without it superagent applies a text encoding and the chunks
 * arrive as strings, so the concatenation below would not hold image bytes.
 *
 * The parameter types are the ones supertest declares for a node parser, whose `res` is the response
 * stream itself; the declared `body` is passed through unchanged as a `Buffer`.
 */
const collectRawBody = (
  res: SuperagentResponse,
  callback: (error: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];

  res.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  res.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
  res.on('error', (error: Error) => {
    callback(error, Buffer.alloc(0));
  });
};

/** The URL of the collection, and of one analysis below it. */
function analysesUrl(...segments: ReadonlyArray<string>): string {
  const encoded = segments.map((segment) => encodeURIComponent(segment));

  return [API_BASE_PATH, ANALYSES_SEGMENT, ...encoded].join('/');
}

/**
 * The URL of one image's stored bytes.
 *
 * Each id is encoded as a whole segment, so a value that carries a separator or a traversal
 * sequence travels as one path parameter and is refused by the route's id guard rather than matched
 * as a deeper path — which is exactly the hostile input this suite submits.
 */
function imageBytesUrl(analysisId: string, imageId: string): string {
  return `${analysesUrl(analysisId)}/${IMAGES_SEGMENT}/${encodeURIComponent(imageId)}`;
}

/**
 * Performs one GET and keeps the body as bytes.
 *
 * The body is checked rather than assumed: a response this suite cannot read as bytes is a failure
 * of the route under test, so it is reported here with the status that produced it instead of
 * surfacing later as an obscure comparison against `undefined`.
 */
async function getBytes(app: TestApp['app'], url: string): Promise<BinaryResponse> {
  const response = await request(app).get(url).buffer(true).parse(collectRawBody);
  const body: unknown = response.body;

  if (!Buffer.isBuffer(body)) {
    throw new Error(
      `The image-bytes route answered status ${response.status} with a body that is not a byte sequence.`,
    );
  }

  return { status: response.status, headers: response.headers, bytes: body };
}

/** Performs one GET with supertest's own JSON parsing, for the failure bodies. */
async function getJson(app: TestApp['app'], url: string): Promise<JsonResponse> {
  const response = await request(app).get(url);
  const body: unknown = response.body;

  return { status: response.status, body };
}

/**
 * Submits image parts and returns the stored document.
 *
 * The attachments are the fixtures helper's own values, so the part's name, its declared content
 * type and its bytes are the committed file's — the server sniffs the bytes regardless of the claim.
 */
async function createAnalysis(
  testApp: TestApp,
  attachments: ReadonlyArray<MultipartAttachment>,
): Promise<AnalysisDocument> {
  const pending = request(testApp.app).post(analysesUrl());

  for (const attachment of attachments) {
    pending.attach(IMAGE_FILE_FIELD, attachment.bytes, {
      filename: attachment.fileName,
      contentType: attachment.contentType,
    });
  }

  const response = await pending;

  expect(response.status).toBe(RESPONSE_OK_STATUS);

  const document: AnalysisDocument = response.body;

  expect(document.images).toHaveLength(attachments.length);

  return document;
}

/**
 * The image at one index of a stored document.
 *
 * The index is checked because the document's `images[]` is what this suite indexes by, and a
 * missing entry should name the document rather than fail a later assertion with `undefined`.
 */
function imageAt(document: AnalysisDocument, index: number): AnalysisImage {
  const image = document.images[index];

  if (image === undefined) {
    throw new Error(
      `Analysis ${document.analysisId} cites ${document.images.length} images, so index ${index} does not exist.`,
    );
  }

  return image;
}

/** Narrows a failure body to the shared error shape, refusing anything that is not an object. */
function errorBodyOf(response: JsonResponse): ApiErrorBody {
  const { body } = response;

  if (typeof body !== 'object' || body === null) {
    throw new Error(`Expected a JSON failure body, received ${JSON.stringify(body)}.`);
  }

  return body as ApiErrorBody;
}

/**
 * True when a byte sequence contains something other than printable ASCII, which no base64 text can.
 *
 * A body encoded as base64 would be entirely printable ASCII, so this is how the suite shows the
 * response carries image bytes without ever encoding anything itself.
 */
function holdsNonTextBytes(bytes: Buffer): boolean {
  return bytes.some((value) => value < 0x20 || value > 0x7e);
}

/**
 * Asserts the shared `NOT_FOUND` answer, including the two things a leaked failure would add: a
 * filesystem path or a stack frame, and the internal-error status.
 */
function expectNotFoundAnswer(response: JsonResponse, dataDir: string): void {
  const error = errorBodyOf(response);

  expect(response.status).toBe(NOT_FOUND_STATUS);
  expect(response.status).not.toBe(INTERNAL_ERROR_STATUS);
  // The code belongs to the closed table, and it is the one this route answers with.
  expect(ERROR_CODES).toContain(error.code);
  expect(error.code).toBe(NOT_FOUND_CODE);
  expect(error.message).toBe(ERROR_MESSAGES[NOT_FOUND_CODE]);
  expect(Object.keys(error).sort()).toEqual([...ERROR_BODY_KEYS]);
  expect(error.message).not.toContain(dataDir);
  expect(error.message).not.toContain(DEPENDENCY_DIRECTORY);
  expect(JSON.stringify(error)).not.toMatch(STACK_FRAME_PATTERN);
}

// -------------------------------------------------------------------------------------------------
// One application per test, released whatever the test did.
// -------------------------------------------------------------------------------------------------

/** The application the current test drives; `null` between tests. */
let currentApp: TestApp | null = null;

/**
 * Builds the application for one test.
 *
 * Each test gets its own temporary data directory and its own store, so a document written by one
 * test cannot answer a read in another and a deletion is observed over real files.
 */
async function freshApp(): Promise<TestApp> {
  const built = await buildTestApp();
  currentApp = built;

  return built;
}

afterEach(async () => {
  const built = currentApp;
  currentApp = null;

  if (built !== null) {
    await built.cleanup();
  }
});

// -------------------------------------------------------------------------------------------------
// The stored bytes.
// -------------------------------------------------------------------------------------------------

describe('a stored screenshot served back through the image route', () => {
  it('returns the submitted bytes exactly, with the content type the document records', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [screenshotAttachment(FOOTPRINT_SCREENSHOT)]);
    const image = imageAt(document, 0);
    const expected = screenshotBytes(FOOTPRINT_SCREENSHOT);

    const response = await getBytes(
      testApp.app,
      imageBytesUrl(document.analysisId, image.imageId),
    );

    expect(response.status).toBe(RESPONSE_OK_STATUS);
    expect(ACCEPTED_CONTENT_TYPES).toContain(image.contentType);
    expect(response.headers['content-type']?.startsWith(image.contentType)).toBe(true);
    expect(response.bytes).toHaveLength(expected.length);
    expect(Buffer.compare(response.bytes, expected)).toBe(0);
  });

  it('keeps each image on its own id, so a two-image analysis returns both sets of bytes', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [
      screenshotAttachment(FOOTPRINT_SCREENSHOT),
      screenshotAttachment(GEX_SCREENSHOT),
    ]);
    const first = imageAt(document, 0);
    const second = imageAt(document, 1);
    const firstExpected = screenshotBytes(FOOTPRINT_SCREENSHOT);
    const secondExpected = screenshotBytes(GEX_SCREENSHOT);

    const firstResponse = await getBytes(
      testApp.app,
      imageBytesUrl(document.analysisId, first.imageId),
    );
    const secondResponse = await getBytes(
      testApp.app,
      imageBytesUrl(document.analysisId, second.imageId),
    );

    expect(firstResponse.status).toBe(RESPONSE_OK_STATUS);
    expect(secondResponse.status).toBe(RESPONSE_OK_STATUS);
    expect(firstResponse.headers['content-type']?.startsWith(first.contentType)).toBe(true);
    expect(secondResponse.headers['content-type']?.startsWith(second.contentType)).toBe(true);
    expect(Buffer.compare(firstResponse.bytes, firstExpected)).toBe(0);
    expect(Buffer.compare(secondResponse.bytes, secondExpected)).toBe(0);
    // The two images are different files, so a store that shared or concatenated their bytes would
    // fail here even though each individual comparison above happened to succeed.
    expect(Buffer.compare(firstResponse.bytes, secondResponse.bytes)).not.toBe(0);
  });

  it('still serves an image the extraction could not read', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [
      screenshotAttachment(FOOTPRINT_SCREENSHOT),
      screenshotAttachment(BLANK_SCREENSHOT),
    ]);
    const unreadable = document.images.filter((image) => image.status === UNREADABLE_STATUS);

    expect(unreadable).toHaveLength(1);

    const image = unreadable[0];

    if (image === undefined) {
      throw new Error('Expected one unreadable image in the stored document.');
    }

    const response = await getBytes(
      testApp.app,
      imageBytesUrl(document.analysisId, image.imageId),
    );

    expect(response.status).toBe(RESPONSE_OK_STATUS);
    expect(Buffer.compare(response.bytes, screenshotBytes(BLANK_SCREENSHOT))).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// The refusals.
// -------------------------------------------------------------------------------------------------

describe('an image route reached with an id that matches no stored record', () => {
  it('answers an unknown analysis id with the shared not-found body', async () => {
    const testApp = await freshApp();

    const response = await getJson(
      testApp.app,
      imageBytesUrl(randomUUID(), randomUUID()),
    );

    expectNotFoundAnswer(response, testApp.dataDir);
  });

  it('answers an image id the stored analysis does not cite with the same body', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [screenshotAttachment(FOOTPRINT_SCREENSHOT)]);
    const stored = imageAt(document, 0);
    const uncited = randomUUID();

    expect(uncited).not.toBe(stored.imageId);
    expect(
      document.images.some((image) => image.imageId === uncited),
    ).toBe(false);

    const response = await getJson(
      testApp.app,
      imageBytesUrl(document.analysisId, uncited),
    );

    expectNotFoundAnswer(response, testApp.dataDir);
  });
});

/** One hostile id and the sentence that names it in the test's title. */
interface HostileIdCase {
  readonly id: string;
  readonly label: string;
}

/**
 * Values a caller may put in a path segment to try to escape the data directory or to break the
 * route: a traversal sequence, a NUL byte and a very long junk id (D1).
 */
const HOSTILE_IDS: ReadonlyArray<HostileIdCase> = [
  { id: '../../etc/passwd', label: 'traversal sequence in' },
  { id: '\u0000', label: 'NUL byte in' },
  { id: 'a'.repeat(2048), label: 'over-long junk id in' },
];

describe('an image route reached with a malformed id', () => {
  it.each(HOSTILE_IDS)(
    'answers a $label either id position with the shared not-found body, never an internal error',
    async (hostile) => {
      const testApp = await freshApp();
      const document = await createAnalysis(testApp, [screenshotAttachment(FOOTPRINT_SCREENSHOT)]);
      const stored = imageAt(document, 0);

      const asAnalysisId = await getJson(
        testApp.app,
        imageBytesUrl(hostile.id, stored.imageId),
      );
      const asImageId = await getJson(
        testApp.app,
        imageBytesUrl(document.analysisId, hostile.id),
      );

      expectNotFoundAnswer(asAnalysisId, testApp.dataDir);
      expectNotFoundAnswer(asImageId, testApp.dataDir);
    },
  );
});

// -------------------------------------------------------------------------------------------------
// Deletion, and what a response must never carry.
// -------------------------------------------------------------------------------------------------

describe('an analysis removed through the delete route', () => {
  it('leaves neither the document nor the image bytes behind', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [screenshotAttachment(FOOTPRINT_SCREENSHOT)]);
    const image = imageAt(document, 0);
    const bytesUrl = imageBytesUrl(document.analysisId, image.imageId);

    const beforeDelete = await getBytes(testApp.app, bytesUrl);

    expect(beforeDelete.status).toBe(RESPONSE_OK_STATUS);

    const deletion = await request(testApp.app).delete(analysesUrl(document.analysisId));

    expect(deletion.status).toBe(DELETE_SUCCESS_STATUS);

    const bytesAfterDelete = await getJson(testApp.app, bytesUrl);
    const documentAfterDelete = await getJson(
      testApp.app,
      analysesUrl(document.analysisId),
    );

    expectNotFoundAnswer(bytesAfterDelete, testApp.dataDir);
    expectNotFoundAnswer(documentAfterDelete, testApp.dataDir);
  });

  it('answers a repeat deletion with the not-found body rather than a second success', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [screenshotAttachment(FOOTPRINT_SCREENSHOT)]);

    const first = await request(testApp.app).delete(analysesUrl(document.analysisId));
    const second = await request(testApp.app).delete(analysesUrl(document.analysisId));
    const body: unknown = second.body;

    expect(first.status).toBe(DELETE_SUCCESS_STATUS);
    expectNotFoundAnswer({ status: second.status, body }, testApp.dataDir);
  });
});

describe('a served screenshot', () => {
  it('carries no credential header and no encoded form of the image', async () => {
    const testApp = await freshApp();
    const document = await createAnalysis(testApp, [screenshotAttachment(FOOTPRINT_SCREENSHOT)]);
    const image = imageAt(document, 0);
    const expected = screenshotBytes(FOOTPRINT_SCREENSHOT);

    const response = await getBytes(
      testApp.app,
      imageBytesUrl(document.analysisId, image.imageId),
    );

    expect(Object.keys(response.headers)).not.toContain('authorization');
    // The body is the image itself: it begins with the fixture's own first byte, is the fixture's
    // exact length, and holds bytes outside printable ASCII — none of which a base64 encoding of it
    // would be, since that is longer and entirely printable.
    expect(response.bytes[0]).toBe(expected[0]);
    expect(response.bytes).toHaveLength(expected.length);
    expect(holdsNonTextBytes(response.bytes)).toBe(true);
    expect(Buffer.compare(response.bytes, expected)).toBe(0);
  });
});
