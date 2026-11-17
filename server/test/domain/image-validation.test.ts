/**
 * Suite for the upload bounds: the image count, the per-file and total byte bounds and the pixel
 * bound that `server/src/domain/image-validation.ts` enforces between the multipart parser and the
 * first provider call.
 *
 * Two things are proved here, and neither of them is arithmetic:
 *
 * - **The order.** AAP §0.3.1 fixes it — count, then sniffed content type, then per-file bytes, then
 *   total bytes, then long edge — and a request carries exactly one rejection, so the order decides
 *   which code an operator sees. The order cases break two bounds in one submission and assert the
 *   earlier one wins, which is the only way to tell a sequenced implementation from one that happens
 *   to check the same five things.
 * - **The vocabulary.** Every rejection is an `AppError` whose code, status and sentence come from
 *   `@trade-read/shared` (decision D4: one implementation each). Nothing here restates a bound, a
 *   code or a sentence; they are imported, so this suite cannot drift from the table the routes
 *   answer with.
 *
 * What this suite does not prove: whether an image holds a readable chart. That is the model's `r`
 * outcome, and an image can pass every bound below and still come back unreadable.
 *
 * The synthetic parts are deliberately tiny — a PNG header of twenty-four bytes followed by zero
 * padding — because a header is all the bounds read: no decoder, no pixel and no `IDAT` data exist in
 * this build. Only the byte-bound cases need real byte counts, so they pad inside the case that
 * needs it and nothing multi-megabyte is committed to `fixtures/`.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_LONG_EDGE_PX,
  MAX_TOTAL_BYTES,
  type ErrorCode,
} from '@trade-read/shared';

import { AppError } from '../../src/domain/errors.js';
import {
  validateImages,
  type SubmittedImage,
  type ValidatedImage,
} from '../../src/domain/image-validation.js';
import {
  notAnImagePdfAttachment,
  screenshotAttachment,
  type ScreenshotStem,
} from '../helpers/fixtures.js';

/** PNG's eight-byte signature, which occupies bytes 0–7 of every PNG. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The `IHDR` data length: width, height, bit depth, colour type, compression, filter, interlace. */
const PNG_IHDR_DATA_LENGTH = 13;

/**
 * Bytes in the smallest header the PNG reader accepts: signature at 0–7, the first chunk's length at
 * 8–11, its `IHDR` type at 12–15, the big-endian width at 16–19 and the height at 20–23.
 */
const PNG_HEADER_BYTES = 24;

/** The fixture whose long edge must exceed the pixel bound; that is its only reason to exist. */
const OVERSIZE_STEM: ScreenshotStem = 'oversize-long-edge';

/**
 * The committed screenshots that pass every bound.
 *
 * Listed rather than derived from `SCREENSHOT_STEMS` so the oversize fixture cannot leak into a case
 * that is not about the pixel bound, and written as a tuple so each entry is a known stem.
 */
const READABLE_STEMS = [
  'footprint-es-5m',
  'gex-es-levels',
  'dom-ladder-es',
  'volume-profile-es',
  'blank-uniform',
] as const satisfies readonly ScreenshotStem[];

/** A screenshot that passes every bound, for a case that needs one and does not care which. */
const READING_STEM: ScreenshotStem = 'footprint-es-5m';

/**
 * The authoritative size of the two screenshots this suite submits together, from the capture table
 * in `fixtures/generate-fixtures.mjs` — the same table `server/test/domain/image-probe.test.ts`
 * checks against the bytes themselves. Typed against those two stems so a renamed or misspelled stem
 * is a compile error rather than a case that stops asserting.
 */
const FIXTURE_DIMENSIONS: Readonly<
  Record<
    'dom-ladder-es' | 'gex-es-levels',
    { readonly width: number; readonly height: number }
  >
> = {
  'dom-ladder-es': { width: 1600, height: 1000 },
  'gex-es-levels': { width: 1440, height: 900 },
};

/** Byte count of each part of the total-size case: nine tenths of the per-file bound. */
const TOTAL_CASE_PART_BYTES = Math.floor(MAX_IMAGE_BYTES * 0.9);

/** How many such parts the total-size case submits. */
const TOTAL_CASE_PARTS = 3;

/** The name of the part whose bytes cross the total bound, and therefore the name in the message. */
const TOTAL_CASE_CROSSING_FILE_NAME = `total-${TOTAL_CASE_PARTS}.png`;

/**
 * A part as the route hands it to the domain, plus the content type a client claimed for it.
 *
 * `SubmittedImage` deliberately declares no content type — the server sniffs the magic bytes — so the
 * claim is carried as an extra property on an object that is still assignable to `SubmittedImage`.
 * That is what lets a case hand over a PNG labelled `image/jpeg` and prove the claim is ignored.
 */
type Attachment = SubmittedImage & { readonly declaredContentType?: string };

/**
 * A PNG header declaring `width` × `height`, with none of the data a real PNG carries.
 *
 * This is the whole claim the bounds make about an image: the geometry sits in the fixed-offset
 * header, so twenty-four bytes are enough to be measured and rejected. A buffer this short could not
 * be drawn, which is the point — nothing in the path decodes it.
 */
function pngHeaderWithDimensions(width: number, height: number): Buffer {
  const header = Buffer.alloc(PNG_HEADER_BYTES);
  Buffer.from([...PNG_SIGNATURE]).copy(header, 0);
  header.writeUInt32BE(PNG_IHDR_DATA_LENGTH, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/**
 * The same header followed by zero padding, so a part can be a chosen number of bytes long while
 * still being an image whose geometry the reader can produce.
 */
function padToSize(bytes: Buffer, size: number): Buffer {
  if (size < bytes.length) {
    throw new Error(
      `Cannot pad ${bytes.length} bytes down to ${size}: padding only ever grows a part.`,
    );
  }

  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 0)]);
}

/** One submitted part, optionally carrying the content type its client declared for it. */
function attachment(
  fileName: string,
  bytes: Uint8Array,
  declaredContentType?: string,
): Attachment {
  return declaredContentType === undefined
    ? { fileName, bytes }
    : { fileName, bytes, declaredContentType };
}

/** A committed screenshot as a submitted part, declaring the type its fixture records. */
function screenshotPart(
  stem: ScreenshotStem,
  fileName?: string,
  declaredContentType?: string,
): Attachment {
  const part = screenshotAttachment(stem, fileName);
  return attachment(part.fileName, part.bytes, declaredContentType ?? part.contentType);
}

/** The wrong-type fixture as a submitted part. */
function pdfPart(fileName?: string): Attachment {
  const part = notAnImagePdfAttachment(fileName);
  return attachment(part.fileName, part.bytes, part.contentType);
}

/**
 * `count` committed screenshots that pass every bound, each under a distinct name so a case can name
 * the part it expects a message to blame.
 */
function readableScreenshots(count: number): SubmittedImage[] {
  return Array.from({ length: count }, (_unused, index) => {
    const stem = READABLE_STEMS[index % READABLE_STEMS.length];

    if (stem === undefined) {
      throw new Error(`No readable screenshot stem at position ${index}.`);
    }

    return screenshotPart(stem, `chart-${index + 1}.png`);
  });
}

/**
 * Runs `run` and returns the `AppError` it threw. A call that throws nothing, or throws something
 * that is not an `AppError`, fails loudly: a rejection case must not pass on an unrelated throw.
 */
function catchCode(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }

    throw new Error(`The rejection threw a value that is not an AppError: ${String(error)}`);
  }

  throw new Error('The rejection accepted a submission the upload bound requires it to refuse.');
}

/**
 * Asserts the whole shared-error contract for one rejection and returns the error.
 *
 * Decision D4: the code, the status and the sentence have one implementation in
 * `@trade-read/shared`, and this assertion reads all three from there rather than restating them.
 * `offendingFileName` is the name the message must blame, through the `fileName` field and through
 * the sentence the error appends to the shared one; the two count rejections carry no file name,
 * because no file was inspected to reach them.
 */
function expectRejection(
  run: () => unknown,
  code: ErrorCode,
  offendingFileName?: string,
): AppError {
  const error = catchCode(run);

  expect(ERROR_CODES.includes(error.code)).toBe(true);
  expect(error.code).toBe(code);
  expect(error.status).toBe(ERROR_STATUS[code]);
  expect(error.message.startsWith(ERROR_MESSAGES[code])).toBe(true);

  if (offendingFileName === undefined) {
    expect(error.fileName).toBeUndefined();
    expect(error.message).toBe(ERROR_MESSAGES[code]);
  } else {
    expect(error.fileName).toBe(offendingFileName);
    expect(error.message).toContain(offendingFileName);
  }

  return error;
}

/** Names of the parts a validated submission is made of, in the order the domain returned them. */
function fileNames(images: ReadonlyArray<ValidatedImage>): string[] {
  return images.map((image) => image.fileName);
}

/** The one image a single-part case returns, failing loudly when the domain returned another count. */
function onlyValidated(images: ReadonlyArray<ValidatedImage>): ValidatedImage {
  const [image] = images;

  if (images.length !== 1 || image === undefined) {
    throw new Error(`Expected exactly one validated image, received ${images.length}.`);
  }

  return image;
}

/** The image at `index`, failing loudly rather than letting an assertion read an absent element. */
function validatedAt(images: ReadonlyArray<ValidatedImage>, index: number): ValidatedImage {
  const image = images[index];

  if (image === undefined) {
    throw new Error(`Expected a validated image at position ${index}, received ${images.length}.`);
  }

  return image;
}

describe('validateImages', () => {
  describe('stage 1: how many parts arrived', () => {
    it('rejects a submission that carries no image at all', () => {
      expectRejection(() => validateImages([]), 'NO_IMAGES');
    });

    it('accepts exactly the permitted count and refuses the next part on count alone', () => {
      const atBound = readableScreenshots(MAX_IMAGES);
      expect(atBound).toHaveLength(MAX_IMAGES);

      const validated = validateImages(atBound);
      expect(validated).toHaveLength(MAX_IMAGES);
      expect(fileNames(validated)).toEqual(atBound.map((part) => part.fileName));

      const overBound = readableScreenshots(MAX_IMAGES + 1);
      expect(overBound).toHaveLength(MAX_IMAGES + 1);
      expectRejection(() => validateImages(overBound), 'TOO_MANY_IMAGES');
    });
  });

  describe('stage 2: the format sniffed from the bytes', () => {
    it('rejects a file whose bytes are not an accepted image type, and names it', () => {
      const pdf = pdfPart();

      expectRejection(() => validateImages([pdf]), 'UNSUPPORTED_IMAGE_TYPE', pdf.fileName);
    });

    it('rejects a wrong-typed file that declares itself a PNG', () => {
      // No declared type is ever consulted, so the same PDF labelled `image/png` is still refused for
      // what its bytes are — the §0.1.1 requirement that the content type be re-sniffed, not trusted.
      const disguised = attachment('disguised-as-png.png', pdfPart().bytes, 'image/png');

      expectRejection(
        () => validateImages([disguised]),
        'UNSUPPORTED_IMAGE_TYPE',
        'disguised-as-png.png',
      );
    });
  });

  describe('stage 3: each part against the per-file byte bound', () => {
    it('accepts a part exactly at the byte bound and rejects the part one byte over it', () => {
      // The module compares `byteSize > MAX_IMAGE_BYTES`, so the bound itself is on the accepted side:
      // exactly MAX_IMAGE_BYTES passes, and a single byte more does not.
      const atBound = attachment(
        'at-bound.png',
        padToSize(pngHeaderWithDimensions(1440, 900), MAX_IMAGE_BYTES),
      );
      const overBound = attachment(
        'one-byte-over.png',
        padToSize(pngHeaderWithDimensions(1440, 900), MAX_IMAGE_BYTES + 1),
      );

      const validated = onlyValidated(validateImages([atBound]));
      expect(validated.byteSize).toBe(MAX_IMAGE_BYTES);
      expect(validated.width).toBe(1440);
      expect(validated.height).toBe(900);

      expectRejection(() => validateImages([overBound]), 'IMAGE_TOO_LARGE', 'one-byte-over.png');
    });
  });

  describe('stage 4: the submission against the total byte bound', () => {
    it('rejects a submission whose parts each fit the per-file bound while their total does not', () => {
      // Both facts are established before the call, so this case cannot be firing on a per-file bound.
      expect(TOTAL_CASE_PART_BYTES).toBeLessThan(MAX_IMAGE_BYTES);
      expect(TOTAL_CASE_PART_BYTES * TOTAL_CASE_PARTS).toBeGreaterThan(MAX_TOTAL_BYTES);
      expect(TOTAL_CASE_PART_BYTES * (TOTAL_CASE_PARTS - 1)).toBeLessThanOrEqual(MAX_TOTAL_BYTES);

      const parts = Array.from({ length: TOTAL_CASE_PARTS }, (_unused, index) =>
        attachment(
          `total-${index + 1}.png`,
          padToSize(pngHeaderWithDimensions(1440, 900), TOTAL_CASE_PART_BYTES),
        ),
      );

      // The name reported is the part whose bytes crossed the bound, which is the last one here.
      expectRejection(() => validateImages(parts), 'IMAGE_TOO_LARGE', TOTAL_CASE_CROSSING_FILE_NAME);
    });
  });

  describe('stage 5: each part against the pixel bound', () => {
    it('rejects the oversize screenshot on its long edge, which cannot be its byte size', () => {
      const oversize = screenshotPart(OVERSIZE_STEM);

      // The fixture is far below the byte bound, so the long edge is the only bound left to break.
      expect(oversize.bytes.byteLength).toBeLessThan(MAX_IMAGE_BYTES);

      expectRejection(
        () => validateImages([oversize]),
        'IMAGE_TOO_LARGE_DIMENSIONS',
        oversize.fileName,
      );
    });

    it('accepts a part whose long edge is exactly at the pixel bound', () => {
      // The module compares `Math.max(width, height) > MAX_LONG_EDGE_PX`, so the bound itself passes.
      const atBound = attachment('at-bound.png', pngHeaderWithDimensions(MAX_LONG_EDGE_PX, 1200));

      const validated = onlyValidated(validateImages([atBound]));
      expect(validated.width).toBe(MAX_LONG_EDGE_PX);
      expect(validated.height).toBe(1200);
      expect(Math.max(validated.width, validated.height)).toBe(MAX_LONG_EDGE_PX);
    });
  });

  describe('the order of the stages', () => {
    it('reports the format of a wrong-typed file before its size', () => {
      const pdf = notAnImagePdfAttachment();
      const padded = padToSize(pdf.bytes, MAX_IMAGE_BYTES + 1);

      // Both bounds are broken by this part; the type stage runs first, so its code is the one seen.
      expect(padded.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);

      const part = attachment(pdf.fileName, padded, 'application/pdf');
      expectRejection(() => validateImages([part]), 'UNSUPPORTED_IMAGE_TYPE', pdf.fileName);
    });

    it('reports a part over the per-file byte bound before its dimensions', () => {
      const header = pngHeaderWithDimensions(3000, 3000);

      // The header on its own breaks the pixel bound, which is what makes this case about the order:
      // padded past the byte bound, the same part must report the size code instead.
      expectRejection(
        () => validateImages([attachment('oversize-canvas.png', header)]),
        'IMAGE_TOO_LARGE_DIMENSIONS',
        'oversize-canvas.png',
      );

      const padded = attachment('oversize-canvas.png', padToSize(header, MAX_IMAGE_BYTES + 1));
      expect(padded.bytes.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);
      expectRejection(() => validateImages([padded]), 'IMAGE_TOO_LARGE', 'oversize-canvas.png');
    });

    it('reports the count before it looks at any file', () => {
      const parts = [pdfPart('wrong-type.pdf'), ...readableScreenshots(MAX_IMAGES)];
      expect(parts).toHaveLength(MAX_IMAGES + 1);

      // The first part is not an image at all; the count stage never inspects it.
      expectRejection(() => validateImages(parts), 'TOO_MANY_IMAGES');
    });

    it('reports the pixel bound only after every part has passed the earlier bounds', () => {
      const oversize = screenshotPart(OVERSIZE_STEM, 'oversize.png');
      const readable = screenshotPart(READING_STEM, 'readable.png');
      const mixed = [readable, oversize];

      // Two parts, both accepted formats and both far inside both byte bounds, so only the pixel
      // bound is left to fire — and it fires last.
      for (const part of mixed) {
        expect(part.declaredContentType).toBe('image/png');
        expect(part.bytes.byteLength).toBeLessThan(MAX_IMAGE_BYTES);
      }

      expectRejection(() => validateImages(mixed), 'IMAGE_TOO_LARGE_DIMENSIONS', oversize.fileName);

      const bothReadable = [
        screenshotPart('dom-ladder-es', 'dom-ladder-es.png'),
        screenshotPart('gex-es-levels', 'gex-es-levels.png'),
      ];
      expect(validateImages(bothReadable)).toHaveLength(2);
    });
  });

  describe('the accepted submission', () => {
    it('keeps submission order and returns the type sniffed from the bytes, not the declared one', () => {
      const submitted = [
        screenshotPart('dom-ladder-es', 'dom-ladder-es.png', 'image/jpeg'),
        screenshotPart('gex-es-levels', 'gex-es-levels.png', 'image/jpeg'),
      ];

      const validated = validateImages(submitted);

      expect(fileNames(validated)).toEqual(['dom-ladder-es.png', 'gex-es-levels.png']);
      expect(validated.map((image) => image.contentType)).toEqual(['image/png', 'image/png']);

      const stems = ['dom-ladder-es', 'gex-es-levels'] as const;

      for (const [index, stem] of stems.entries()) {
        const image = validatedAt(validated, index);
        const expected = FIXTURE_DIMENSIONS[stem];

        // The claim was `image/jpeg` on a PNG; only the magic bytes are believed.
        expect(image.contentType).toBe('image/png');
        expect(image.contentType).not.toBe('image/jpeg');
        expect(ACCEPTED_IMAGE_MIME_TYPES.includes(image.contentType)).toBe(true);
        expect(image.width).toBe(expected.width);
        expect(image.height).toBe(expected.height);
        expect(image.byteSize).toBe(submitted[index]?.bytes.byteLength);
      }
    });
  });

  describe('the shared error table', () => {
    it('answers each bound with the code, status and sentence the shared table holds', () => {
      const overSize = (): Attachment =>
        attachment(
          'twelve-over.png',
          padToSize(pngHeaderWithDimensions(1440, 900), MAX_IMAGE_BYTES + 1),
        );

      const cases: ReadonlyArray<{
        readonly code: ErrorCode;
        readonly offendingFileName?: string;
        readonly run: () => unknown;
      }> = [
        { code: 'NO_IMAGES', run: () => validateImages([]) },
        {
          code: 'TOO_MANY_IMAGES',
          run: () => validateImages(readableScreenshots(MAX_IMAGES + 1)),
        },
        {
          code: 'UNSUPPORTED_IMAGE_TYPE',
          offendingFileName: 'not-an-image.pdf',
          run: () => validateImages([pdfPart()]),
        },
        {
          code: 'IMAGE_TOO_LARGE',
          offendingFileName: 'twelve-over.png',
          run: () => validateImages([overSize()]),
        },
        {
          code: 'IMAGE_TOO_LARGE_DIMENSIONS',
          offendingFileName: 'twelve-tall.png',
          run: () =>
            validateImages([
              attachment('twelve-tall.png', pngHeaderWithDimensions(MAX_LONG_EDGE_PX + 1, 1000)),
            ]),
        },
      ];

      // One row per upload bound, so a code that stopped firing fails here instead of going quiet.
      expect(new Set(cases.map((entry) => entry.code)).size).toBe(cases.length);

      for (const { code, offendingFileName, run } of cases) {
        const error = expectRejection(run, code, offendingFileName);

        expect(error.name).toBe('AppError');
        expect(error.status).toBe(ERROR_STATUS[code]);
        // One line, so no stack travels with the body the route renders from it.
        expect(error.message.split('\n')).toHaveLength(1);
      }
    });
  });
});
