/**
 * The enforced bounds: the suite behind the AAP §0.6.4 rows for the images-per-submission count, the
 * per-image byte bound, the total byte bound, the long-edge bound and the history page size, together
 * with the D12 clamps asserted at AAP §0.6.1 for `instrument`, `context` and the list's `limit`.
 *
 * Every case drives the composed application `buildTestApp` returns — the production store over a
 * temporary data directory and the replay provider — so no socket is opened and no credential is
 * needed. Each case asserts the HTTP outcome only, never which layer produced it (AAP §0.3.1): the
 * parser's file-count cap and memory guard and the domain's content-type, byte, total and dimension
 * checks are all free to fire first, so a case states the arithmetic that keeps its own bound the only
 * one able to.
 *
 * Three properties are asserted on every rejection: the code's own status and the code itself from the
 * shared table (D4), a provider that was never called, and a store that holds nothing afterwards (D2).
 * The clamps are the opposite shape — a submission past the character bounds succeeds with the value
 * shortened rather than refused, because the error table defines no code for it (D12).
 *
 * The over-bound payloads are synthesised in memory by `pngBufferOfSize`: a real PNG signature and
 * `IHDR` header declaring in-bound dimensions, padded past the byte bound under test. The server never
 * decodes an image, so the header is all it reads of one, and no multi-megabyte binary is committed.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  API_BASE_PATH,
  CONTEXT_MAX_CHARS,
  DISCLAIMER,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  INSTRUMENT_MAX_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_LONG_EDGE_PX,
  MAX_TOTAL_BYTES,
  type AnalysisDocument,
  type AnalysisListResponse,
  type ApiErrorBody,
  type ErrorCode,
} from '@trade-read/shared';

import { buildTestApp, type TestApp } from '../helpers/build-test-app.js';
import { screenshotAttachment, type MultipartAttachment } from '../helpers/fixtures.js';

/**
 * The shared error codes, addressed by name without a code string being written here: the record is
 * keyed by the table's own values, so a code renamed, added or removed in `@trade-read/shared` moves
 * with it and this suite cannot assert a code the API no longer answers with.
 */
const CODE: Readonly<Record<ErrorCode, ErrorCode>> = Object.fromEntries(
  ERROR_CODES.map((code) => [code, code]),
) as Readonly<Record<ErrorCode, ErrorCode>>;

/**
 * The status a successful request answers with. The shared table holds failure statuses only, so this
 * is the one status this suite reads from outside it.
 */
const HTTP_OK = 200;

/**
 * Bytes added past a byte bound, so a synthesised payload is over it rather than exactly on it. A
 * padding margin and nothing else: every bound itself is read from the shared limit that declares it.
 */
const PADDING_BYTES = 1024;

/** How far past a character cap the submitted text reaches, so the clamp has something to remove. */
const CLAMP_MARGIN_CHARS = 32;

/** How many parts the total-byte case submits: enough parts, each in bound, to break the sum. */
const TOTAL_CASE_PARTS = 3;

/**
 * How many analyses the history case seeds beyond the page cap, so a capped page is a truncation of a
 * larger history rather than the whole of it.
 */
const SEED_EXTRA_ANALYSES = 5;

/**
 * The time the seeding case is given. It issues one full submission per history row — the honest path,
 * with no document fabricated — so its cost grows with HISTORY_LIMIT_MAX, and the margin keeps a slower,
 * shared host from turning a correct case into a timeout.
 */
const SEEDING_TIMEOUT_MS = 90_000;

// PNG's first chunk, as the server's header reader (server/src/domain/image-probe.ts) reads it: an
// eight-byte signature, the first chunk's four-byte length and four-byte type, then the `IHDR` data.
// The offsets below are derived from those field widths rather than restated as numbers, so a payload
// built here is laid out by the same rules the reader applies.

/** PNG's eight-byte signature, the prefix of every payload this suite synthesises. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The chunk type of PNG's mandatory first chunk. */
const PNG_IHDR_CHUNK_TYPE = 'IHDR';

/** Widths of the first chunk's length field, its type field, and one declared dimension. */
const PNG_CHUNK_LENGTH_BYTES = 4;
const PNG_CHUNK_TYPE_BYTES = 4;
const PNG_DIMENSION_BYTES = 4;

/** The five single-byte `IHDR` fields after the dimensions: depth, colour, compression, filter, interlace. */
const PNG_IHDR_TRAILER_BYTES = 5;

/** The `IHDR` data length the header reader requires exactly. */
const PNG_IHDR_DATA_LENGTH = PNG_DIMENSION_BYTES * 2 + PNG_IHDR_TRAILER_BYTES;

/** Where the first chunk's length field starts, which is immediately after the signature. */
const PNG_CHUNK_LENGTH_OFFSET = PNG_SIGNATURE.length;

/** Where the first chunk's type field starts. */
const PNG_CHUNK_TYPE_OFFSET = PNG_CHUNK_LENGTH_OFFSET + PNG_CHUNK_LENGTH_BYTES;

/** Where `IHDR` width starts, and where height follows it. */
const PNG_WIDTH_OFFSET = PNG_CHUNK_TYPE_OFFSET + PNG_CHUNK_TYPE_BYTES;
const PNG_HEIGHT_OFFSET = PNG_WIDTH_OFFSET + PNG_DIMENSION_BYTES;

/** The shortest payload this suite can build: the signature, the chunk header, and both dimensions. */
const PNG_HEADER_LENGTH = PNG_HEIGHT_OFFSET + PNG_DIMENSION_BYTES;

/** The two fields of a response every case here reads, taken structurally so no library type is restated. */
interface ResponseBody<TBody> {
  readonly status: number;
  readonly body: TBody;
}

/** The replay provider of a stub-built app, taken from the helper's own return type. */
type ReplayProvider = NonNullable<TestApp['stub']>;

/**
 * A buffer of exactly `byteLength` bytes whose header is a PNG signature plus an `IHDR` chunk
 * declaring `width` by `height`, padded with zeros.
 *
 * The padding stands in for image data: the server reads an image's format and geometry from its
 * header and never decodes a pixel, so a payload built this way exercises the byte and pixel bounds
 * with no large fixture on disk.
 *
 * @param byteLength - The exact total length the payload must have.
 * @param width - The canvas width the header declares.
 * @param height - The canvas height the header declares.
 * @returns The synthesised bytes, laid out the way the server's header reader expects them.
 * @throws If `byteLength` leaves no room for the header this helper writes.
 */
function pngBufferOfSize(byteLength: number, width: number, height: number): Buffer {
  if (byteLength < PNG_HEADER_LENGTH) {
    throw new Error(
      `A synthesised PNG needs at least ${PNG_HEADER_LENGTH} bytes for its header; received ${byteLength}.`,
    );
  }

  const buffer = Buffer.alloc(byteLength);
  Buffer.from(PNG_SIGNATURE).copy(buffer, 0);
  buffer.writeUInt32BE(PNG_IHDR_DATA_LENGTH, PNG_CHUNK_LENGTH_OFFSET);
  buffer.write(PNG_IHDR_CHUNK_TYPE, PNG_CHUNK_TYPE_OFFSET, 'latin1');
  buffer.writeUInt32BE(width, PNG_WIDTH_OFFSET);
  buffer.writeUInt32BE(height, PNG_HEIGHT_OFFSET);

  return buffer;
}

/**
 * One synthesised payload as a multipart part, declaring dimensions at the pixel bound rather than
 * past it, so the pixel bound is never what a byte-bound case trips over.
 */
function synthesisedImage(fileName: string, byteLength: number): MultipartAttachment {
  return {
    fileName,
    // The declared type is never consulted — the server sniffs the magic bytes — but it must not be
    // the thing that fails first, so the part declares the type its header actually is.
    contentType: ACCEPTED_IMAGE_MIME_TYPES[0],
    bytes: pngBufferOfSize(byteLength, MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX),
  };
}

/** The name of the `index`-th part of a case, so the parts and the assertions that name one agree. */
function partFileName(prefix: string, index: number): string {
  return `${prefix}-${index + 1}.png`;
}

/** The longer edge a payload's own PNG header declares, read the way the server's probe reads it. */
function longEdgeOf(attachment: MultipartAttachment): number {
  const width = attachment.bytes.readUInt32BE(PNG_WIDTH_OFFSET);
  const height = attachment.bytes.readUInt32BE(PNG_HEIGHT_OFFSET);

  return Math.max(width, height);
}

/** The replay provider of a stub-built app; a `null` stub would mean the helper stopped wiring one. */
function replayProviderOf(app: TestApp): ReplayProvider {
  if (app.stub === null) {
    throw new Error('This suite builds every app against the replay provider, so `stub` cannot be null.');
  }

  return app.stub;
}

/**
 * Submits exactly these parts, with the optional text fields when a case supplies them.
 *
 * The parts are attached in order, because a submission's order is what the extraction calls follow
 * and what decides which part a total-size rejection names.
 *
 * @param app - The application to drive.
 * @param attachments - The image parts, in submission order.
 * @param fields - The optional `instrument` and `context` text parts.
 * @returns The response, its body typed as the caller's expectation.
 */
async function submit<TBody>(
  app: TestApp,
  attachments: readonly MultipartAttachment[],
  fields: { readonly instrument?: string; readonly context?: string } = {},
): Promise<ResponseBody<TBody>> {
  let submission = request(app.app).post(`${API_BASE_PATH}/analyses`);

  for (const attachment of attachments) {
    submission = submission.attach('images', attachment.bytes, {
      filename: attachment.fileName,
      contentType: attachment.contentType,
    });
  }

  if (fields.instrument !== undefined) {
    submission = submission.field('instrument', fields.instrument);
  }

  if (fields.context !== undefined) {
    submission = submission.field('context', fields.context);
  }

  const response = await submission;

  return response;
}

/**
 * Asserts one rejection: the status the shared table gives the code, the code itself, and the shared
 * sentence as the message's opening. The server may append what only it knows — the offending file's
 * name — so the sentence is asserted as a prefix here and the name by the case that cares about it.
 */
function expectRejection(response: ResponseBody<ApiErrorBody>, code: ErrorCode): ApiErrorBody {
  expect(response.status).toBe(ERROR_STATUS[code]);
  expect(response.body.code).toBe(code);
  expect(response.body.message.startsWith(ERROR_MESSAGES[code])).toBe(true);

  return response.body;
}

/** Asserts the store holds no analysis: a rejected submission writes neither document nor bytes (D2). */
async function expectNothingStored(app: TestApp): Promise<void> {
  const response = await request(app.app).get(`${API_BASE_PATH}/analyses`);

  expect(response.status).toBe(HTTP_OK);
  expect((response.body as AnalysisListResponse).items).toEqual([]);
}

/**
 * One history page, asserting the ordering the API promises: newest first, so `createdAt` never
 * increases down the list. Equal instants are allowed, because two submissions can complete inside the
 * same millisecond.
 *
 * @param app - The application to drive.
 * @param query - A query string such as `?limit=abc`, or nothing for the default page.
 * @returns The page, for the caller's own assertions about its length.
 */
async function historyPage(app: TestApp, query = ''): Promise<AnalysisListResponse> {
  const response = await request(app.app).get(`${API_BASE_PATH}/analyses${query}`);

  expect(response.status).toBe(HTTP_OK);

  const body = response.body as AnalysisListResponse;
  const instants = body.items.map((item) => Date.parse(item.createdAt));

  expect(instants).toEqual([...instants].sort((left, right) => right - left));

  return body;
}

/** The application under test for one case, rebuilt for every case so no store outlives its own test. */
let testApp: TestApp;

beforeEach(async () => {
  testApp = await buildTestApp();
});

afterEach(async () => {
  await testApp.cleanup();
});

describe('the upload bounds are enforced before a provider call', () => {
  it('rejects a submission with no image part as NO_IMAGES, before any provider call', async () => {
    // A text field only: the request is a well-formed multipart submission with no image in it, which
    // is the empty-input case rather than a malformed request.
    const response = await submit<ApiErrorBody>(testApp, [], { instrument: 'ES' });

    const body = expectRejection(response, CODE.NO_IMAGES);

    // The count rejections name no file, because there is none to name.
    expect(body.message).toBe(ERROR_MESSAGES[CODE.NO_IMAGES]);
    expect(replayProviderOf(testApp).calls).toHaveLength(0);
    await expectNothingStored(testApp);
  });

  it(`rejects ${MAX_IMAGES + 1} image parts as TOO_MANY_IMAGES, before any provider call`, async () => {
    // Every part is a readable screenshot that is inside every other bound, so only the count can fire.
    const attachments = Array.from({ length: MAX_IMAGES + 1 }, (_unused, index) =>
      screenshotAttachment('footprint-es-5m', partFileName('chart', index)),
    );

    const response = await submit<ApiErrorBody>(testApp, attachments);

    const body = expectRejection(response, CODE.TOO_MANY_IMAGES);

    expect(body.message).toBe(ERROR_MESSAGES[CODE.TOO_MANY_IMAGES]);
    expect(replayProviderOf(testApp).calls).toHaveLength(0);
    await expectNothingStored(testApp);
  });

  it('rejects an image past MAX_IMAGE_BYTES as IMAGE_TOO_LARGE, naming the file', async () => {
    const overSize = synthesisedImage(partFileName('over-size', 0), MAX_IMAGE_BYTES + PADDING_BYTES);

    // Only the per-image byte bound can fire: one part, dimensions at the pixel bound, and a length
    // below the parser's memory guard, so the part reaches the domain's own size stage.
    expect(overSize.bytes.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    expect(overSize.bytes.length).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(longEdgeOf(overSize)).toBe(MAX_LONG_EDGE_PX);

    const response = await submit<ApiErrorBody>(testApp, [overSize]);

    const body = expectRejection(response, CODE.IMAGE_TOO_LARGE);

    expect(body.message).toContain(overSize.fileName);
    expect(replayProviderOf(testApp).calls).toHaveLength(0);
    await expectNothingStored(testApp);
  });

  it('rejects a submission past MAX_TOTAL_BYTES as IMAGE_TOO_LARGE', async () => {
    const perPartBytes = Math.floor(MAX_TOTAL_BYTES / TOTAL_CASE_PARTS) + PADDING_BYTES;
    const attachments = Array.from({ length: TOTAL_CASE_PARTS }, (_unused, index) =>
      synthesisedImage(partFileName('total-size', index), perPartBytes),
    );
    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0);

    // Only the total can fire: no part exceeds the per-image bound or the parser's memory guard, no
    // part exceeds the pixel bound, and the sum is past the total. The figures are asserted rather than
    // assumed, so the case cannot quietly stop being over the bound when a shared limit changes.
    for (const attachment of attachments) {
      expect(attachment.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
      expect(attachment.bytes.length).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
      expect(longEdgeOf(attachment)).toBe(MAX_LONG_EDGE_PX);
    }
    expect(totalBytes).toBeGreaterThan(MAX_TOTAL_BYTES);

    const response = await submit<ApiErrorBody>(testApp, attachments);

    const body = expectRejection(response, CODE.IMAGE_TOO_LARGE);

    // The parts are added in submission order, so the file named is the one whose bytes crossed.
    expect(body.message).toContain(partFileName('total-size', TOTAL_CASE_PARTS - 1));
    expect(replayProviderOf(testApp).calls).toHaveLength(0);
    await expectNothingStored(testApp);
  });

  it('rejects an image past MAX_LONG_EDGE_PX as IMAGE_TOO_LARGE_DIMENSIONS, naming the file', async () => {
    const oversize = screenshotAttachment('oversize-long-edge');

    // The fixture is far below MAX_IMAGE_BYTES on purpose, so the pixel bound is the only one that can
    // fire: size cannot answer first, and the edge that breaks the bound is read from the fixture's own
    // header rather than assumed.
    expect(oversize.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(longEdgeOf(oversize)).toBeGreaterThan(MAX_LONG_EDGE_PX);

    const response = await submit<ApiErrorBody>(testApp, [oversize]);

    const body = expectRejection(response, CODE.IMAGE_TOO_LARGE_DIMENSIONS);

    expect(body.message).toContain(oversize.fileName);
    expect(replayProviderOf(testApp).calls).toHaveLength(0);
    await expectNothingStored(testApp);
  });
});

describe('a submission inside the bounds is stored within them', () => {
  it('stores every image within MAX_IMAGE_BYTES and MAX_LONG_EDGE_PX', async () => {
    const attachments = [
      screenshotAttachment('footprint-es-5m'),
      screenshotAttachment('dom-ladder-es'),
    ];

    const response = await submit<AnalysisDocument>(testApp, attachments);

    expect(response.status).toBe(HTTP_OK);

    const document = response.body;
    const totalBytes = document.images.reduce((sum, image) => sum + image.byteSize, 0);

    expect(document.images).toHaveLength(attachments.length);

    for (const image of document.images) {
      expect(image.width).toBeLessThanOrEqual(MAX_LONG_EDGE_PX);
      expect(image.height).toBeLessThanOrEqual(MAX_LONG_EDGE_PX);
      expect(image.byteSize).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    }

    // The two fixtures are different images of different sizes, so the stored figures are two readings
    // rather than one repeated, and the total is a real sum of what was kept.
    expect(new Set(document.images.map((image) => image.byteSize)).size).toBe(document.images.length);
    expect(totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });
});

describe('the D12 clamps shorten a submission rather than reject it', () => {
  it('truncates instrument and context instead of rejecting the submission', async () => {
    const instrument = 'I'.repeat(INSTRUMENT_MAX_CHARS + CLAMP_MARGIN_CHARS);
    const context = 'c'.repeat(CONTEXT_MAX_CHARS + CLAMP_MARGIN_CHARS);

    const response = await submit<AnalysisDocument>(
      testApp,
      [screenshotAttachment('gex-es-levels')],
      { instrument, context },
    );

    expect(response.status).toBe(HTTP_OK);

    const document = response.body;

    expect(document.instrument).toHaveLength(INSTRUMENT_MAX_CHARS);
    expect(document.context).toHaveLength(CONTEXT_MAX_CHARS);

    // Truncation keeps a prefix of what was submitted rather than replacing it with something else.
    expect(instrument.startsWith(document.instrument)).toBe(true);
    expect(context.startsWith(document.context)).toBe(true);

    // The clamp did not swallow the submission: everything else is a complete analysis.
    expect(document.images).toHaveLength(1);
    expect(document.levels.length).toBeGreaterThan(0);
    expect(document.disclaimer).toBe(DISCLAIMER);
    expect(document.modelUsage.promptVersion).not.toBe('');
    expect(replayProviderOf(testApp).calls.length).toBeGreaterThan(0);

    // And it is a stored analysis, because the request was answered rather than refused.
    expect((await historyPage(testApp)).items).toHaveLength(1);
  });

  it(
    'caps a history page at HISTORY_LIMIT_MAX and falls back to HISTORY_LIMIT_DEFAULT',
    async () => {
      const attachment = screenshotAttachment('volume-profile-es');
      const seededCount = HISTORY_LIMIT_MAX + SEED_EXTRA_ANALYSES;

      // One submission per history row, through the product's own path: no document is fabricated and
      // no store is written behind the application's back.
      for (let seeded = 0; seeded < seededCount; seeded += 1) {
        const submission = await submit<AnalysisDocument>(testApp, [attachment]);

        expect(submission.status).toBe(HTTP_OK);
      }

      const capped = await historyPage(testApp, `?limit=${HISTORY_LIMIT_MAX + SEED_EXTRA_ANALYSES}`);

      expect(capped.items).toHaveLength(HISTORY_LIMIT_MAX);

      const absent = await historyPage(testApp);

      expect(absent.items).toHaveLength(HISTORY_LIMIT_DEFAULT);

      // A value that is not a run of digits, a run of zero, a negative number and an empty value all
      // fall back to the default: the error table defines no code for a bad query value, so clamping
      // is the whole behaviour.
      for (const query of ['?limit=abc', '?limit=0', '?limit=-5', '?limit=']) {
        const page = await historyPage(testApp, query);

        expect(page.items).toHaveLength(HISTORY_LIMIT_DEFAULT);
      }
    },
    SEEDING_TIMEOUT_MS,
  );
});

