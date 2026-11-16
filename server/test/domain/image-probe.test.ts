/**
 * Suite for the header reader that stands in for an image-processing dependency: the format and the
 * canvas size come from magic bytes and from the format's own header structures, with no decoder and
 * no pixel inspection anywhere in the build.
 *
 * Every synthetic case below is a header of a few dozen bytes — a signature plus the field that
 * carries the geometry — because that is the whole claim being proved: the module answers "which
 * format, and how large" from the bytes a file opens with, so a PNG that carries no `IDAT`, no CRC
 * and no `IEND` is still measured. The committed screenshots are then read at the dimensions
 * `fixtures/generate-fixtures.mjs` captured them at, which is what makes the table authoritative
 * rather than a second copy of a number. `MAX_LONG_EDGE_PX` arrives from `@trade-read/shared`, so the
 * one fixture that must break the bound is measured against the bound the server enforces.
 *
 * The JPEG frame-header offsets asserted here are the module's own: measured from the position of
 * the two-byte segment length, the sample-precision byte sits at +2, the height at +3 and the width
 * at +5.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_LONG_EDGE_PX,
  type AcceptedImageMimeType,
} from '@trade-read/shared';

import { probeImage, sniffContentType } from '../../src/domain/image-probe.js';
import {
  SCREENSHOT_STEMS,
  notAnImagePdfAttachment,
  screenshotBytes,
  type ScreenshotStem,
} from '../helpers/fixtures.js';

/** PNG's eight-byte signature, which occupies bytes 0–7 of every PNG. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The `IHDR` data length: width, height, bit depth, colour type, compression, filter, interlace. */
const PNG_IHDR_DATA_LENGTH = 13;

/** The byte that prefixes every JPEG marker. */
const JPEG_MARKER_PREFIX = 0xff;

/** Start Of Image, the two-byte marker every JPEG stream opens with. */
const JPEG_SOI_MARKER = 0xd8;

/** A length-bearing segment before the frame header, so the reader has to walk markers. */
const JPEG_APP0_MARKER = 0xe0;

/** Baseline frame header. */
const JPEG_SOF0_MARKER = 0xc0;

/** Progressive frame header: a different member of the same frame-marker set. */
const JPEG_SOF2_MARKER = 0xc2;

/** Bytes in the synthetic JPEG header: SOI, one `APP0` segment and one `SOF` segment. */
const JPEG_HEADER_BYTES = 17;

/** The `APP0` segment length, counting its own two bytes: its payload is the two bytes at 6–7. */
const JPEG_APP0_SEGMENT_LENGTH = 4;

/** The `SOF` segment length, counting its own two bytes: precision at 12, height at 13, width at 15. */
const JPEG_SOF_SEGMENT_LENGTH = 17;

/**
 * Offset of `VP8X`'s Canvas Width Minus One: three little-endian bytes holding the width minus one,
 * immediately after the four bytes of flags and reserved bits.
 */
const WEBP_VP8X_CANVAS_WIDTH_MINUS_ONE_OFFSET = 24;

/** Bytes in a WebP header that carries a `VP8X` canvas size: RIFF, form type, chunk header, payload. */
const WEBP_VP8X_HEADER_BYTES = 30;

/** Bytes in a WebP header carrying a `VP8L` or `VP8 ` chunk: the size fits in ten payload bytes. */
const WEBP_COMPRESSED_HEADER_BYTES = 30;

/** The `VP8L` signature byte, always `2F`. */
const WEBP_VP8L_SIGNATURE = 0x2f;

/** `VP8 ` Start Code, which proves the chunk really is a key-frame header. */
const WEBP_VP8_SYNC_CODE = [0x9d, 0x01, 0x2a] as const;

/** The fixture whose long edge must exceed the bound; that is its only reason to exist. */
const OVERSIZE_STEM: ScreenshotStem = 'oversize-long-edge';

/**
 * The authoritative size of each committed screenshot, from the capture table in
 * `fixtures/generate-fixtures.mjs`, and checked against the bytes themselves by the suite below.
 *
 * Typed as a `Record<ScreenshotStem, …>` so a stem added to, removed from or misspelled against
 * `SCREENSHOT_STEMS` is a compile error rather than a case that silently stops running.
 */
const FIXTURE_DIMENSIONS: Record<
  ScreenshotStem,
  { readonly width: number; readonly height: number }
> = {
  'footprint-es-5m': { width: 1440, height: 900 },
  'gex-es-levels': { width: 1440, height: 900 },
  'dom-ladder-es': { width: 1600, height: 1000 },
  'volume-profile-es': { width: 1280, height: 960 },
  'blank-uniform': { width: 800, height: 600 },
  'oversize-long-edge': { width: 3000, height: 3000 },
};

/**
 * A PNG header: the signature at 0–7, the first chunk's length at 8–11 and its type at 12–15, then
 * `IHDR`'s big-endian width at 16–19 and height at 20–23.
 *
 * The 13-byte data length and the `IHDR` type are the last bytes the reader needs, so the buffer
 * stops there: no `IDAT`, CRC or `IEND` byte exists, which is what shows the size is read rather
 * than decoded.
 */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([...PNG_SIGNATURE]).copy(header, 0);
  header.writeUInt32BE(PNG_IHDR_DATA_LENGTH, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/**
 * A PNG cut short inside its `IHDR` data: signature, length and type are complete, the width has
 * only two of its four bytes, so no geometry can be read even though the format is unmistakable.
 */
function halfWrittenIhdr(): Buffer {
  return Buffer.concat([
    Buffer.from([...PNG_SIGNATURE]),
    Buffer.from([0x00, 0x00, 0x00, PNG_IHDR_DATA_LENGTH]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.from([0x05, 0xa0]),
  ]);
}

/**
 * A JPEG header: `FF D8` (SOI) and the `FF` that prefixes the next marker at 0–2, an `APP0` segment
 * whose length at 4–5 counts itself so its two payload bytes sit at 6–7, then a frame header at 8
 * whose length at 10–11 counts itself, the sample-precision byte at 12, the big-endian height at
 * 13–14 and the big-endian width at 15–16.
 *
 * The `APP0` segment is there so the reader has to walk markers: a suite that only ever handed it a
 * frame header could not tell a marker walk apart from a fixed-offset read.
 */
function jpegHeader(frameMarker: number, width: number, height: number): Buffer {
  const header = Buffer.alloc(JPEG_HEADER_BYTES);
  header[0] = JPEG_MARKER_PREFIX;
  header[1] = JPEG_SOI_MARKER;
  header[2] = JPEG_MARKER_PREFIX;
  header[3] = JPEG_APP0_MARKER;
  header.writeUInt16BE(JPEG_APP0_SEGMENT_LENGTH, 4);
  header[6] = 0x4a;
  header[7] = 0x46;
  header[8] = JPEG_MARKER_PREFIX;
  header[9] = frameMarker;
  header.writeUInt16BE(JPEG_SOF_SEGMENT_LENGTH, 10);
  header[12] = 8;
  header.writeUInt16BE(height, 13);
  header.writeUInt16BE(width, 15);
  return header;
}

/** A JPEG whose frame header declares a segment length far past the end of the buffer. */
function jpegSofOverrunningItsSegment(): Buffer {
  return Buffer.from([
    JPEG_MARKER_PREFIX,
    JPEG_SOI_MARKER,
    JPEG_MARKER_PREFIX,
    JPEG_SOF0_MARKER,
    0x00, // declared segment length, high byte
    0x40, // declared segment length, low byte: 64 bytes, far past this seven-byte buffer
    8, // sample precision, the last byte present, so no height or width can be read
  ]);
}

/** A JPEG whose `APP0` segment length points past the end of the buffer. */
function jpegAppSegmentOverrunningItsLength(): Buffer {
  return Buffer.from([
    JPEG_MARKER_PREFIX,
    JPEG_SOI_MARKER,
    JPEG_MARKER_PREFIX,
    JPEG_APP0_MARKER,
    0x00, // declared segment length, high byte
    0x40, // declared segment length, low byte: 64 bytes, far past this eight-byte buffer
    0x00,
    0x00,
  ]);
}

/** Writes a 24-bit little-endian value, the packing `VP8X` uses for a canvas dimension minus one. */
function writeUint24LE(target: Buffer, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
}

/**
 * A WebP header carrying a `VP8X` chunk: `RIFF` at 0–3, the file size at 4–7, `WEBP` at 8–11, the
 * chunk fourCC at 12–15 and its size (4 flag bytes + 3 width + 3 height) at 16–19. The flags and
 * reserved bits occupy 20–23, then Canvas Width Minus One is 24-bit little-endian at 24–26 and
 * Canvas Height Minus One at 27–29.
 */
function webpVp8xHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(WEBP_VP8X_HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(header.length - 8, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8X', 12, 'latin1');
  header.writeUInt32LE(10, 16);
  writeUint24LE(header, WEBP_VP8X_CANVAS_WIDTH_MINUS_ONE_OFFSET, width - 1);
  writeUint24LE(header, WEBP_VP8X_CANVAS_WIDTH_MINUS_ONE_OFFSET + 3, height - 1);
  return header;
}

/**
 * A WebP header carrying a `VP8L` (lossless) chunk: the chunk header as above, the signature byte
 * `2F` at 20, then one 32-bit little-endian word at 21–24 whose low 14 bits hold width minus one
 * and whose next 14 bits hold height minus one.
 */
function webpVp8lHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(WEBP_COMPRESSED_HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(header.length - 8, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8L', 12, 'latin1');
  header.writeUInt32LE(5, 16);
  header[20] = WEBP_VP8L_SIGNATURE;
  header.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return header;
}

/**
 * A WebP header carrying a `VP8 ` (lossy) chunk: the chunk header as above, a three-byte frame tag
 * at 20–22, the Start Code `9D 01 2A` at 23–25, then 14 bits of width at 26–27 and 14 bits of
 * height at 28–29, each little-endian with two bits of scaling above it.
 */
function webpVp8Header(width: number, height: number): Buffer {
  const header = Buffer.alloc(WEBP_COMPRESSED_HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(header.length - 8, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8 ', 12, 'latin1');
  header.writeUInt32LE(10, 16);
  header[23] = WEBP_VP8_SYNC_CODE[0];
  header[24] = WEBP_VP8_SYNC_CODE[1];
  header[25] = WEBP_VP8_SYNC_CODE[2];
  header.writeUInt16LE(width, 26);
  header.writeUInt16LE(height, 28);
  return header;
}

/** One input the header reader must refuse, with the format its magic bytes still announce. */
interface UnreadableCase {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly sniffed: AcceptedImageMimeType | null;
}

/** Every way an image can be too short, too wrong or too truncated to answer with a geometry. */
const UNREADABLE_CASES: readonly UnreadableCase[] = [
  { label: 'an empty buffer', bytes: Buffer.alloc(0), sniffed: null },
  { label: 'four arbitrary bytes', bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef]), sniffed: null },
  {
    label: 'the PNG signature alone',
    bytes: Buffer.from([...PNG_SIGNATURE]),
    sniffed: 'image/png',
  },
  {
    label: 'the PNG signature plus a half-written IHDR',
    bytes: halfWrittenIhdr(),
    sniffed: 'image/png',
  },
  {
    label: 'a PNG that declares a zero width',
    bytes: pngHeader(0, 900),
    sniffed: 'image/png',
  },
  {
    label: 'a VP8X chunk whose declared length runs past the end of the buffer',
    bytes: webpVp8xHeader(1024, 768).subarray(0, 25),
    sniffed: 'image/webp',
  },
  {
    label: 'a JPEG frame header whose segment length overruns the buffer',
    bytes: jpegSofOverrunningItsSegment(),
    sniffed: 'image/jpeg',
  },
  {
    label: 'a JPEG APP0 segment whose length points past the end of the buffer',
    bytes: jpegAppSegmentOverrunningItsLength(),
    sniffed: 'image/jpeg',
  },
];

/**
 * A JPEG header whose `APP0` segment is long enough that the frame header sits 36 bytes in, so only
 * a marker walk can find it and no fixed offset can be the reason the geometry is right.
 */
function jpegHeaderWithLongAppSegment(width: number, height: number): Buffer {
  const appPayloadBytes = 30;
  const appSegmentLength = appPayloadBytes + 2;
  const frameOffset = 4 + appSegmentLength;
  const header = Buffer.alloc(frameOffset + 9);

  header[0] = JPEG_MARKER_PREFIX;
  header[1] = JPEG_SOI_MARKER;
  header[2] = JPEG_MARKER_PREFIX;
  header[3] = JPEG_APP0_MARKER;
  header.writeUInt16BE(appSegmentLength, 4);

  header[frameOffset] = JPEG_MARKER_PREFIX;
  header[frameOffset + 1] = JPEG_SOF2_MARKER;
  header.writeUInt16BE(JPEG_SOF_SEGMENT_LENGTH, frameOffset + 2);
  header[frameOffset + 4] = 8;
  header.writeUInt16BE(height, frameOffset + 5);
  header.writeUInt16BE(width, frameOffset + 7);

  return header;
}

describe('sniffContentType', () => {
  it('reports the format from the magic bytes alone, with no file name or declared type in reach', () => {
    const headers: ReadonlyArray<{
      readonly label: string;
      readonly bytes: Uint8Array;
      readonly expected: AcceptedImageMimeType;
    }> = [
      { label: 'a PNG header', bytes: pngHeader(1440, 900), expected: 'image/png' },
      {
        label: 'a JPEG header',
        bytes: jpegHeader(JPEG_SOF0_MARKER, 1200, 800),
        expected: 'image/jpeg',
      },
      { label: 'a VP8X WebP header', bytes: webpVp8xHeader(1023, 767), expected: 'image/webp' },
      { label: 'a VP8L WebP header', bytes: webpVp8lHeader(1023, 767), expected: 'image/webp' },
      { label: 'a VP8 WebP header', bytes: webpVp8Header(1920, 1080), expected: 'image/webp' },
    ];

    for (const { label, bytes, expected } of headers) {
      const sniffed = sniffContentType(bytes);

      expect(sniffed, label).toBe(expected);
      // The answer is a member of the closed accepted set, so the type this module reports can never
      // be one the upload surface would refuse on its own account.
      expect(ACCEPTED_IMAGE_MIME_TYPES, label).toContain(sniffed);
      // The same bytes cannot be announced as one format here and another by the geometry probe.
      expect(probeImage(bytes)?.contentType, label).toBe(sniffed);
    }
  });

  it('reports null for an image format the upload surface does not accept', () => {
    const refused: ReadonlyArray<{ readonly label: string; readonly bytes: Uint8Array }> = [
      { label: 'a GIF89a header', bytes: Buffer.from('GIF89a', 'latin1') },
      { label: 'a BMP header', bytes: Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]) },
      { label: 'a PDF header', bytes: Buffer.from('%PDF-1.4', 'latin1') },
      {
        label: 'a RIFF container that is not a WebP',
        bytes: Buffer.from('RIFF\u0024\u0000\u0000\u0000WAVE', 'latin1'),
      },
    ];

    for (const { label, bytes } of refused) {
      expect(sniffContentType(bytes), label).toBeNull();
      expect(probeImage(bytes), label).toBeNull();
    }
  });
});

describe('probeImage: PNG', () => {
  it('reads width and height from the IHDR chunk without decoding any pixel data', () => {
    const header = pngHeader(1440, 900);

    expect(sniffContentType(header)).toBe('image/png');
    expect(probeImage(header)).toEqual({ contentType: 'image/png', width: 1440, height: 900 });
    // The buffer ends inside the header: no image data, no CRC and no terminator are present, so the
    // geometry cannot have come from a decoder.
    expect(header.length).toBe(24);
    expect(header.includes('IDAT')).toBe(false);
    expect(header.includes('IEND')).toBe(false);
  });
});

describe('probeImage: JPEG', () => {
  it('walks past the APP0 segment to the SOF0 frame header', () => {
    const header = jpegHeader(JPEG_SOF0_MARKER, 1200, 800);

    expect(sniffContentType(header)).toBe('image/jpeg');
    expect(probeImage(header)).toEqual({ contentType: 'image/jpeg', width: 1200, height: 800 });
  });

  it('finds a progressive SOF2 frame header further along, so the marker walk is what reads the size', () => {
    const header = jpegHeaderWithLongAppSegment(1200, 800);

    // The frame header starts 36 bytes in, so a reader seeking a fixed offset would land inside the
    // APP0 payload and report nothing.
    expect(header[36]).toBe(JPEG_MARKER_PREFIX);
    expect(header[37]).toBe(JPEG_SOF2_MARKER);
    expect(sniffContentType(header)).toBe('image/jpeg');
    expect(probeImage(header)).toEqual({ contentType: 'image/jpeg', width: 1200, height: 800 });
  });
});

describe('probeImage: WebP', () => {
  it('adds one to the VP8X canvas dimensions held minus one', () => {
    // 1023x767 is deliberately not a round pair, so an off-by-one in either field cannot pass.
    const header = webpVp8xHeader(1023, 767);

    expect(sniffContentType(header)).toBe('image/webp');
    expect(probeImage(header)).toEqual({ contentType: 'image/webp', width: 1023, height: 767 });
  });

  it('unpacks the VP8L width-minus-one and height-minus-one fields', () => {
    const header = webpVp8lHeader(1023, 767);

    expect(header[20]).toBe(WEBP_VP8L_SIGNATURE);
    expect(sniffContentType(header)).toBe('image/webp');
    expect(probeImage(header)).toEqual({ contentType: 'image/webp', width: 1023, height: 767 });
  });

  it('reads the VP8 lossy frame dimensions after the start code', () => {
    const header = webpVp8Header(1920, 1080);

    expect(header.subarray(23, 26)).toEqual(Buffer.from([...WEBP_VP8_SYNC_CODE]));
    expect(sniffContentType(header)).toBe('image/webp');
    expect(probeImage(header)).toEqual({ contentType: 'image/webp', width: 1920, height: 1080 });
  });
});

describe('probeImage: committed fixtures', () => {
  it('holds one size for every screenshot the fixture set publishes, and no other', () => {
    expect(Object.keys(FIXTURE_DIMENSIONS).sort()).toEqual([...SCREENSHOT_STEMS].sort());
  });

  it.each([...SCREENSHOT_STEMS])(
    'reads the committed screenshot %s at its captured size',
    (stem) => {
      const expected = FIXTURE_DIMENSIONS[stem];
      const probed = probeImage(screenshotBytes(stem));

      expect(probed).toEqual({
        contentType: 'image/png',
        width: expected.width,
        height: expected.height,
      });

      const longEdge = Math.max(expected.width, expected.height);
      if (stem === OVERSIZE_STEM) {
        // This is the fixture's whole reason to exist: the server's dimension bound must refuse it.
        expect(longEdge).toBeGreaterThan(MAX_LONG_EDGE_PX);
      } else {
        expect(longEdge).toBeLessThanOrEqual(MAX_LONG_EDGE_PX);
      }
    },
  );
});

describe('probeImage: unreadable input', () => {
  it('refuses a genuine PDF for what it is instead of guessing a geometry', () => {
    const attachment = notAnImagePdfAttachment();

    expect(attachment.bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(sniffContentType(attachment.bytes)).toBeNull();
    expect(probeImage(attachment.bytes)).toBeNull();
  });

  it.each(UNREADABLE_CASES)('returns null for $label instead of throwing', ({ bytes, sniffed }) => {
    // What the magic bytes still announce is asserted too: refuting a geometry is not the same as
    // forgetting the format, and the validation layer turns the two into different error codes.
    expect(sniffContentType(bytes)).toBe(sniffed);
    expect(probeImage(bytes)).toBeNull();
    expect(() => probeImage(bytes)).not.toThrow();
    expect(() => sniffContentType(bytes)).not.toThrow();
  });
});

