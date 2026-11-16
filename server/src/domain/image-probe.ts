import type { AcceptedImageMimeType } from '@trade-read/shared';

/**
 * The format and canvas size of a submitted image, read from its own header bytes.
 *
 * This module is the substitute for an image-processing dependency: the build carries none, so
 * recognition and geometry have to come from the file's header structures rather than from a
 * decoder. Nothing here allocates a bitmap, decodes a pixel or inspects pixel statistics — the
 * work is a handful of byte comparisons and a few integer reads per file, whatever the image's
 * byte size.
 *
 * Two properties callers depend on:
 *
 * - The format is sniffed from magic bytes, never from the `Content-Type` a client declared, so a
 *   PDF sent as `image/png` is recognised for what it is.
 * - Every function is total. An unsupported format, a truncated header, a segment length the
 *   format does not allow, a zero dimension or a dimension outside the safe-integer range yields
 *   `null`; no input throws. The caller turns that verdict into an error code, and the route layer
 *   therefore never has to handle a raw parser exception.
 *
 * Whether an image holds a readable chart is deliberately not decided here: that is the model's
 * `r` field on the extraction answer. This module answers "which format, and how large" only.
 */

/** PNG's eight-byte signature, the first field of the format's specification. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The three bytes every JPEG stream opens with: the SOI marker (`FF D8`) followed by the `FF`
 * that prefixes the first real marker.
 */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/** Container tags of a WebP file: the RIFF form type at offset 0 and the `WEBP` form at offset 8. */
const RIFF_TAG = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50] as const;

/** The chunk identifiers that can carry a WebP canvas size: extended, lossless and lossy. */
const VP8X_CHUNK = [0x56, 0x50, 0x38, 0x58] as const;
const VP8L_CHUNK = [0x56, 0x50, 0x38, 0x4c] as const;
const VP8_LOSSY_CHUNK = [0x56, 0x50, 0x38, 0x20] as const;

// PNG offsets. The signature is eight bytes, then the first chunk as `length` (four bytes), `type`
// (four bytes) and data. `IHDR` is the mandatory first chunk and its data is exactly 13 bytes, so
// its width and height sit at fixed offsets.

/** Where the first chunk's length field starts. */
const PNG_FIRST_CHUNK_OFFSET = PNG_SIGNATURE.length;

/** `IHDR` chunk data length: width, height, bit depth, colour type, compression, filter, interlace. */
const PNG_IHDR_DATA_LENGTH = 13;

/** Where the first chunk's four-byte type field starts. */
const PNG_CHUNK_TYPE_OFFSET = PNG_FIRST_CHUNK_OFFSET + 4;

/** `IHDR` Width: big-endian uint32, the first field of the chunk data. */
const PNG_WIDTH_OFFSET = PNG_CHUNK_TYPE_OFFSET + 4;

/** `IHDR` Height: big-endian uint32, the second field of the chunk data. */
const PNG_HEIGHT_OFFSET = PNG_WIDTH_OFFSET + 4;

// JPEG offsets. Every segment is `FF`, one marker byte, then a two-byte big-endian length that
// counts its own two bytes. A frame header (SOF) then carries one byte of sample precision,
// followed by the two-byte height and two-byte width.

/** Bytes consumed by the SOI marker before the first segment starts. */
const JPEG_SOI_LENGTH = 2;

/** The byte every JPEG marker is prefixed with, which may repeat as fill. */
const JPEG_MARKER_PREFIX = 0xff;

/** The shortest legal segment length, being the length field itself. */
const JPEG_SEGMENT_LENGTH_BYTES = 2;

/** Start Of Scan: entropy-coded data begins, so no frame header follows. */
const JPEG_START_OF_SCAN = 0xda;

/** End Of Image: the stream ends without a frame header. */
const JPEG_END_OF_IMAGE = 0xd9;

/** Frame header sample precision, one byte after the segment length. */
const JPEG_SOF_PRECISION_OFFSET = JPEG_SEGMENT_LENGTH_BYTES;

/** Frame header height: big-endian uint16 after the precision byte. */
const JPEG_SOF_HEIGHT_OFFSET = JPEG_SOF_PRECISION_OFFSET + 1;

/** Frame header width: big-endian uint16 after the height. */
const JPEG_SOF_WIDTH_OFFSET = JPEG_SOF_HEIGHT_OFFSET + 2;

// WebP offsets. `RIFF` (four bytes) and the file size (four bytes LE) are followed by the `WEBP`
// form type (four bytes), then by the first chunk as `fourCC` (four bytes) and `chunk size`
// (four bytes LE), so the first chunk's payload starts at offset 20.

/** The first chunk's four-byte identifier. */
const WEBP_CHUNK_TYPE_OFFSET = 12;

/** The first chunk's payload. */
const WEBP_CHUNK_DATA_OFFSET = WEBP_CHUNK_TYPE_OFFSET + 8;

/** `VP8X` flags and reserved bytes, then Canvas Width Minus One as 24-bit little-endian. */
const WEBP_VP8X_WIDTH_OFFSET = WEBP_CHUNK_DATA_OFFSET + 4;

/** `VP8X` Canvas Height Minus One, immediately after the three width bytes. */
const WEBP_VP8X_HEIGHT_OFFSET = WEBP_VP8X_WIDTH_OFFSET + 3;

/** `VP8 ` Start Code `9D 01 2A`, after the three-byte frame tag. */
const WEBP_VP8_SYNC_OFFSET = WEBP_CHUNK_DATA_OFFSET + 3;

/** `VP8 ` width: 14 bits of width and 2 bits of horizontal scale, little-endian. */
const WEBP_VP8_WIDTH_OFFSET = WEBP_CHUNK_DATA_OFFSET + 6;

/** `VP8 ` height: the same packing, two bytes after the width. */
const WEBP_VP8_HEIGHT_OFFSET = WEBP_VP8_WIDTH_OFFSET + 2;

/** `VP8L` signature byte, which is always `2F`. */
const WEBP_VP8L_SIGNATURE_OFFSET = WEBP_CHUNK_DATA_OFFSET;

/** `VP8L` packed dimension bits: width-1, height-1, alpha flag and version. */
const WEBP_VP8L_BITS_OFFSET = WEBP_VP8L_SIGNATURE_OFFSET + 1;

/** The value the `VP8L` signature byte must hold. */
const VP8L_SIGNATURE = 0x2f;

/** `VP8 ` Start Code, whose presence proves the chunk really is a key frame header. */
const VP8_SYNC_CODE = [0x9d, 0x01, 0x2a] as const;

/** Mask of a 14-bit WebP dimension field. */
const FOURTEEN_BIT_MASK = 0x3fff;

/** Everything {@link probeImage} reports about one image. */
export interface ProbedImage {
  /** The format sniffed from the bytes, never the type the client declared. */
  readonly contentType: AcceptedImageMimeType;
  /** Canvas width in pixels, as recorded in the header. */
  readonly width: number;
  /** Canvas height in pixels, as recorded in the header. */
  readonly height: number;
}

/** Width and height as one of the format readers reports them. */
interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Identifies an image's format from its magic bytes.
 *
 * Only the three types the upload surface accepts are recognised — PNG, JPEG and WebP. Every other
 * format, including GIF, BMP, TIFF, HEIC, SVG and PDF, returns `null`, because the accepted set is
 * a closed union rather than "anything an image decoder might open".
 *
 * The signature comparison is what makes a forged or mislabelled upload detectable: the caller
 * passes the received bytes and never the multipart part's declared `Content-Type`.
 */
export function sniffContentType(bytes: Uint8Array): AcceptedImageMimeType | null {
  if (matchesAt(bytes, 0, PNG_SIGNATURE)) {
    return 'image/png';
  }

  if (matchesAt(bytes, 0, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }

  if (matchesAt(bytes, 0, RIFF_TAG) && matchesAt(bytes, 8, WEBP_TAG)) {
    return 'image/webp';
  }

  return null;
}

/**
 * Reads an image's format and canvas size from its header bytes.
 *
 * Returns `null` when the format is not one of the accepted three, when the header is too short or
 * malformed for its own format, or when a dimension is zero or outside the safe-integer range. A
 * non-positive or absurd dimension means the header cannot be trusted, so it is treated as
 * unreadable rather than reported as a geometry the upload bound would then accept.
 *
 * The reported long edge is not compared against the upload bound here: the caller applies that
 * bound, so this module's answer stays a pure description of the bytes.
 */
export function probeImage(bytes: Uint8Array): ProbedImage | null {
  const contentType = sniffContentType(bytes);

  if (contentType === null) {
    return null;
  }

  const dimensions = readDimensions(contentType, bytes);

  if (dimensions === null) {
    return null;
  }

  if (!isPlausibleDimension(dimensions.width) || !isPlausibleDimension(dimensions.height)) {
    return null;
  }

  return { contentType, width: dimensions.width, height: dimensions.height };
}

/** Dispatches to the reader of the format the magic bytes already identified. */
function readDimensions(
  contentType: AcceptedImageMimeType,
  bytes: Uint8Array,
): ImageDimensions | null {
  if (contentType === 'image/png') {
    return readPngDimensions(bytes);
  }

  if (contentType === 'image/jpeg') {
    return readJpegDimensions(bytes);
  }

  return readWebpDimensions(bytes);
}

/** The four-byte chunk type of PNG's mandatory first chunk. */
const PNG_IHDR_CHUNK_TYPE = [0x49, 0x48, 0x44, 0x52] as const;

/**
 * `IHDR` — Image Header: the mandatory first chunk, whose 13 bytes of data hold Width and Height
 * as big-endian uint32 values. The length field begins at offset 8, the chunk type at 12, the width
 * at 16 and the height at 20.
 */
function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const chunkLength = readUint32BE(bytes, PNG_FIRST_CHUNK_OFFSET);

  if (chunkLength !== PNG_IHDR_DATA_LENGTH) {
    return null;
  }

  if (!matchesAt(bytes, PNG_CHUNK_TYPE_OFFSET, PNG_IHDR_CHUNK_TYPE)) {
    return null;
  }

  const width = readUint32BE(bytes, PNG_WIDTH_OFFSET);
  const height = readUint32BE(bytes, PNG_HEIGHT_OFFSET);

  if (width === null || height === null) {
    return null;
  }

  return { width, height };
}

/**
 * Walks JPEG markers from the SOI to the first frame header.
 *
 * Each segment is `FF`, one marker byte, then a two-byte big-endian length; `FF` fill bytes and
 * the length-less markers are skipped without a length read. At a Start Of Frame marker the
 * segment data begins one byte past the length with the sample precision, so Height is the
 * big-endian uint16 immediately after that byte and Width the uint16 immediately after the height.
 * The walk stops at Start Of Scan, where entropy-coded data begins and no header follows.
 */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = JPEG_SOI_LENGTH;

  while (offset < bytes.length) {
    if (bytes[offset] !== JPEG_MARKER_PREFIX) {
      return null;
    }

    let markerOffset = offset + 1;
    let marker = bytes[markerOffset];

    while (marker === JPEG_MARKER_PREFIX) {
      markerOffset += 1;
      marker = bytes[markerOffset];
    }

    if (marker === undefined) {
      return null;
    }

    const segmentOffset = markerOffset + 1;

    if (marker === JPEG_START_OF_SCAN || marker === JPEG_END_OF_IMAGE) {
      return null;
    }

    if (isStandaloneJpegMarker(marker)) {
      offset = segmentOffset;
      continue;
    }

    const segmentLength = readUint16BE(bytes, segmentOffset);

    if (segmentLength === null || segmentLength < JPEG_SEGMENT_LENGTH_BYTES) {
      return null;
    }

    if (isJpegFrameMarker(marker)) {
      const width = readUint16BE(bytes, segmentOffset + JPEG_SOF_WIDTH_OFFSET);
      const height = readUint16BE(bytes, segmentOffset + JPEG_SOF_HEIGHT_OFFSET);

      if (width === null || height === null) {
        return null;
      }

      return { width, height };
    }

    offset = segmentOffset + segmentLength;
  }

  return null;
}

/**
 * A Start Of Frame marker carries the sample precision and the frame's dimensions. The set is
 * SOF0–SOF3, SOF5–SOF7, SOF9–SOF11 and SOF13–SOF15; `C4` (Huffman table), `C8` (reserved) and `CC`
 * (arithmetic coding conditioning) sit inside the range but are not frame headers.
 */
function isJpegFrameMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) {
    return false;
  }

  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Markers that carry no length field: TEM (`01`) and the RSTn / SOI / EOI block (`D0`–`D9`). */
function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/**
 * Reads the canvas size from a WebP chunk header.
 *
 * `VP8X` (extended) stores Canvas Width Minus One and Canvas Height Minus One as 24-bit
 * little-endian values after a four-byte field of flags and reserved bits. `VP8L` (lossless) starts
 * with the signature byte `2F`, then packs width-1 in the low 14 bits, height-1 in the next 14 bits
 * and the alpha flag and version above them, all little-endian. `VP8 ` (lossy) starts with a
 * three-byte frame tag, then the `9D 01 2A` Start Code, then 14 bits of width and 14 bits of height
 * each followed by two bits of scaling.
 */
function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (matchesAt(bytes, WEBP_CHUNK_TYPE_OFFSET, VP8X_CHUNK)) {
    const width = readUint24LE(bytes, WEBP_VP8X_WIDTH_OFFSET);
    const height = readUint24LE(bytes, WEBP_VP8X_HEIGHT_OFFSET);

    if (width === null || height === null) {
      return null;
    }

    return { width: width + 1, height: height + 1 };
  }

  if (matchesAt(bytes, WEBP_CHUNK_TYPE_OFFSET, VP8L_CHUNK)) {
    if (bytes[WEBP_VP8L_SIGNATURE_OFFSET] !== VP8L_SIGNATURE) {
      return null;
    }

    const bits = readUint32LE(bytes, WEBP_VP8L_BITS_OFFSET);

    if (bits === null) {
      return null;
    }

    return {
      width: (bits & FOURTEEN_BIT_MASK) + 1,
      height: ((bits >>> 14) & FOURTEEN_BIT_MASK) + 1,
    };
  }

  if (matchesAt(bytes, WEBP_CHUNK_TYPE_OFFSET, VP8_LOSSY_CHUNK)) {
    if (!matchesAt(bytes, WEBP_VP8_SYNC_OFFSET, VP8_SYNC_CODE)) {
      return null;
    }

    const width = readUint16LE(bytes, WEBP_VP8_WIDTH_OFFSET);
    const height = readUint16LE(bytes, WEBP_VP8_HEIGHT_OFFSET);

    if (width === null || height === null) {
      return null;
    }

    return { width: width & FOURTEEN_BIT_MASK, height: height & FOURTEEN_BIT_MASK };
  }

  return null;
}

/**
 * Compares a run of bytes against an expected sequence.
 *
 * A negative offset, a run that reaches past the end of the buffer or any differing byte is
 * `false`, so callers need no separate bounds check before a signature comparison.
 */
function matchesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Reads one byte, or `null` when the offset falls outside the buffer.
 *
 * The buffer is indexed rather than cast: with `noUncheckedIndexedAccess` every read is
 * `number | undefined`, and each helper turns the `undefined` case into a `null` the caller already
 * has to handle. No non-null assertion appears in this module, so a short buffer can never be read
 * as if it were complete.
 */
function readUint8(bytes: Uint8Array, offset: number): number | null {
  return bytes[offset] ?? null;
}

/** Reads a big-endian uint16 from `offset`, or `null` when the two bytes are not all present. */
function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  const high = readUint8(bytes, offset);
  const low = readUint8(bytes, offset + 1);

  if (high === null || low === null) {
    return null;
  }

  return (high << 8) | low;
}

/** Reads a little-endian uint16 from `offset`, or `null` when the two bytes are not all present. */
function readUint16LE(bytes: Uint8Array, offset: number): number | null {
  const low = readUint8(bytes, offset);
  const high = readUint8(bytes, offset + 1);

  if (low === null || high === null) {
    return null;
  }

  return low | (high << 8);
}

/** Reads a little-endian uint24 from `offset`, or `null` when the three bytes are not all present. */
function readUint24LE(bytes: Uint8Array, offset: number): number | null {
  const low = readUint8(bytes, offset);
  const middle = readUint8(bytes, offset + 1);
  const high = readUint8(bytes, offset + 2);

  if (low === null || middle === null || high === null) {
    return null;
  }

  return low | (middle << 8) | (high << 16);
}

/** Reads a big-endian uint32 from `offset`, or `null` when the four bytes are not all present. */
function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  const byte0 = readUint8(bytes, offset);
  const byte1 = readUint8(bytes, offset + 1);
  const byte2 = readUint8(bytes, offset + 2);
  const byte3 = readUint8(bytes, offset + 3);

  if (byte0 === null || byte1 === null || byte2 === null || byte3 === null) {
    return null;
  }

  // `>>> 0` keeps a PNG width above 2^31 a positive number rather than a negative int32.
  return ((byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3) >>> 0;
}

/** Reads a little-endian uint32 from `offset`, or `null` when the four bytes are not all present. */
function readUint32LE(bytes: Uint8Array, offset: number): number | null {
  const byte0 = readUint8(bytes, offset);
  const byte1 = readUint8(bytes, offset + 1);
  const byte2 = readUint8(bytes, offset + 2);
  const byte3 = readUint8(bytes, offset + 3);

  if (byte0 === null || byte1 === null || byte2 === null || byte3 === null) {
    return null;
  }

  return (byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24)) >>> 0;
}

/**
 * A dimension is usable only as a positive integer a caller can compare and store. Zero means the
 * header cannot be trusted, and a value outside the safe-integer range means an arithmetic result
 * from it would be inexact, so both are treated as an unreadable header rather than a geometry.
 */
function isPlausibleDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

