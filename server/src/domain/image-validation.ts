import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_LONG_EDGE_PX,
  MAX_TOTAL_BYTES,
  type AcceptedImageMimeType,
} from '@trade-read/shared';
import { AppError, sanitizeFileName } from './errors.js';
import { probeImage } from './image-probe.js';

/**
 * Every upload bound the request declares, enforced on the parsed buffers before a provider call
 * can be made.
 *
 * The route layer parses the multipart body and passes the parts through; the bounds themselves are
 * decided here, so multer's own limits stay a memory guard rather than the control. Each bound has
 * one error code, and the rejection names the offending file, because the operator needs to know
 * which screenshot to fix.
 *
 * Two properties this module deliberately does not have: it never decides whether an image holds a
 * readable chart — that is the model's `r` field on the extraction answer, and an image can pass
 * here and still come back unreadable — and it never compares submissions to each other, since two
 * identical submissions are two analyses.
 */

/** One uploaded part exactly as the route hands it to the domain, with no multer type attached. */
export interface SubmittedImage {
  /**
   * The name the multipart part claimed. Untrusted: it is normalised by
   * {@link validateImages} before it reaches an error message or a stored document.
   */
  fileName: string;
  /** The received bytes, exactly as parsed. Never mutated, never re-encoded, never decoded. */
  bytes: Uint8Array;
}

/** A part that passed every bound, carrying the geometry and format sniffed from its own bytes. */
export interface ValidatedImage extends SubmittedImage {
  /** The format read from the magic bytes, never the type the client declared. */
  contentType: AcceptedImageMimeType;
  /** Canvas width in pixels, as recorded in the image header. */
  width: number;
  /** Canvas height in pixels, as recorded in the image header. */
  height: number;
  /** The received buffer's length, unchanged from what arrived. */
  byteSize: number;
}

/** Prefix of the substitute name for a part that arrived without a usable name. */
const DEFAULT_FILE_NAME_PREFIX = 'image-';

/**
 * Enforces every upload bound and returns the validated parts.
 *
 * The order of the stages below is contractual (AAP §0.3.1): a request carries one rejection, so
 * moving a check changes which code that request receives. The stages are therefore sequential over
 * the whole submission rather than per file, and each one runs only once the previous one passed
 * for every file:
 *
 * 1. **Count** — zero parts is `NO_IMAGES`, more than {@link MAX_IMAGES} is `TOO_MANY_IMAGES`. No
 *    part is inspected when the count is wrong, so seven over-size files report the count.
 * 2. **Sniffed content type** — {@link probeImage} reads the magic bytes of each part. Bytes that are
 *    not an accepted format, or a header too damaged to yield a geometry, are
 *    `UNSUPPORTED_IMAGE_TYPE` naming that file. This stage precedes the size stages, so a PDF
 *    submitted beside an over-size PNG reports the type, and a part's declared `Content-Type` is
 *    never consulted.
 * 3. **Per-file size** — a part past {@link MAX_IMAGE_BYTES} is `IMAGE_TOO_LARGE`.
 * 4. **Total size** — the sum past {@link MAX_TOTAL_BYTES} is `IMAGE_TOO_LARGE`, which is a separate
 *    stage from stage 3 because three 9 MiB parts break the total while breaking no per-file bound.
 * 5. **Long edge** — a part past {@link MAX_LONG_EDGE_PX} on its longer side is
 *    `IMAGE_TOO_LARGE_DIMENSIONS`. The client downscales first as a courtesy; this stage is the
 *    control, because it re-reads the geometry from the received bytes.
 *
 * Every failure is an {@link AppError} carrying the code of the bound that was broken and, apart
 * from the count rejections, the normalised name of the offending part.
 */
export function validateImages(images: ReadonlyArray<SubmittedImage>): ValidatedImage[] {
  assertImageCount(images);

  const named = images.map((image, position) => ({
    fileName: normaliseFileName(image.fileName, position),
    bytes: image.bytes,
  }));

  const validated = named.map(readImage);

  assertPerFileSize(validated);
  assertTotalSize(validated);
  assertLongEdge(validated);

  return validated;
}

/** Stage 1: how many parts arrived, and nothing about their content. */
function assertImageCount(images: ReadonlyArray<SubmittedImage>): void {
  if (images.length === 0) {
    throw AppError.noImages();
  }

  if (images.length > MAX_IMAGES) {
    throw AppError.tooManyImages();
  }
}

/** Stage 2 for one part: its sniffed format plus the geometry its header records. */
function readImage(part: SubmittedImage): ValidatedImage {
  const bytes = asByteArray(part.bytes);
  const probe = bytes === null ? null : probeImage(bytes);

  if (bytes === null || probe === null) {
    throw AppError.unsupportedImageType(part.fileName);
  }

  return {
    fileName: part.fileName,
    bytes,
    contentType: probe.contentType,
    width: probe.width,
    height: probe.height,
    byteSize: bytes.byteLength,
  };
}

/** Stage 3: each part against its own byte bound, in submission order. */
function assertPerFileSize(images: ReadonlyArray<ValidatedImage>): void {
  for (const image of images) {
    if (image.byteSize > MAX_IMAGE_BYTES) {
      throw AppError.imageTooLarge(image.fileName);
    }
  }
}

/**
 * Stage 4: the submission in total against its byte bound.
 *
 * The parts are added in submission order and the name reported is the one whose bytes crossed the
 * bound, because the sentence for `IMAGE_TOO_LARGE` states both the per-file and the total bound and
 * the operator still needs to know which screenshot to drop.
 */
function assertTotalSize(images: ReadonlyArray<ValidatedImage>): void {
  let totalBytes = 0;

  for (const image of images) {
    totalBytes += image.byteSize;

    if (totalBytes > MAX_TOTAL_BYTES) {
      throw AppError.imageTooLarge(image.fileName);
    }
  }
}

/** Stage 5: each part's longer side against the pixel bound, in submission order. */
function assertLongEdge(images: ReadonlyArray<ValidatedImage>): void {
  for (const image of images) {
    if (Math.max(image.width, image.height) > MAX_LONG_EDGE_PX) {
      throw AppError.imageTooLargeDimensions(image.fileName);
    }
  }
}

/**
 * Renders the name a part is known by from here on: the submitted name, sanitised, or `image-<n>`
 * with `n` counting from one in submission order when the submitted name is empty or sanitises down
 * to nothing.
 *
 * The name reaches error messages and the stored document, so it is sanitised before either of them
 * exists rather than at each of those sites. `n` is one-based so a name reads the way a person
 * counts the screenshots they dropped.
 */
function normaliseFileName(fileName: unknown, position: number): string {
  const sanitised = sanitizeFileName(fileName);

  return sanitised === '' ? `${DEFAULT_FILE_NAME_PREFIX}${position + 1}` : sanitised;
}

/**
 * Narrows a part's bytes to a `Uint8Array` — which a Node `Buffer` satisfies — and rejects
 * anything else. The route always hands over parsed bytes; this keeps a caller that hands over
 * something else on the same 400 path as a file that is not an image, rather than letting a
 * `TypeError` from the header reader surface as an internal failure.
 */
function asByteArray(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}
