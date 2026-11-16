/**
 * Suite for the upload feature's two pure image helpers: the size a decoded capture is drawn at,
 * and the advisory blank-frame hint the upload surface uses to annotate a thumbnail.
 *
 * Only `computeTargetSize` and `isBlankFrame` are exercised here. jsdom implements neither
 * `createImageBitmap` nor a real 2D canvas context, so `downscaleImage` — which needs both, and
 * which is the subject of the browser-level check — is deliberately left out of this suite.
 *
 * The bound is read from the shared contract rather than restated, so this suite keeps proving
 * `MAX_LONG_EDGE_PX` instead of a copied number.
 *
 * Downscaling is a courtesy: it keeps the cost of an upload independent of the resolution a
 * capture was taken at. The control is the server, which re-reads the dimensions from the bytes it
 * receives and rejects anything over the bound; nothing asserted here stands in for that check.
 */

import { describe, expect, it } from 'vitest';

import { MAX_LONG_EDGE_PX } from '@trade-read/shared';

import { computeTargetSize, isBlankFrame } from './downscale-image';

/** One RGBA pixel, in the order a `Uint8ClampedArray` holds it. */
type Pixel = readonly [red: number, green: number, blue: number, alpha: number];

const OPAQUE_BLACK: Pixel = [0, 0, 0, 255];
const OPAQUE_WHITE: Pixel = [255, 255, 255, 255];

/** Builds a frame of `pixelCount` pixels, colouring pixel `index` through `pixelAt`. */
function frameOf(pixelCount: number, pixelAt: (index: number) => Pixel): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(pixelCount * 4);

  for (let index = 0; index < pixelCount; index += 1) {
    const [red, green, blue, alpha] = pixelAt(index);
    const offset = index * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = alpha;
  }

  return pixels;
}

describe('computeTargetSize', () => {
  describe('within the bound', () => {
    it('keeps an image at the bound on its long edge unchanged', () => {
      expect(computeTargetSize(MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX / 2)).toEqual({
        width: MAX_LONG_EDGE_PX,
        height: MAX_LONG_EDGE_PX / 2,
      });
    });

    it('keeps a square already at the bound unchanged', () => {
      expect(computeTargetSize(MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX)).toEqual({
        width: MAX_LONG_EDGE_PX,
        height: MAX_LONG_EDGE_PX,
      });
    });

    it('never upscales a small image', () => {
      expect(computeTargetSize(800, 600)).toEqual({ width: 800, height: 600 });
    });

    it('keeps a single-pixel image at one pixel', () => {
      expect(computeTargetSize(1, 1)).toEqual({ width: 1, height: 1 });
    });
  });

  describe('beyond the bound', () => {
    it('halves a landscape capture whose width is twice the bound', () => {
      expect(computeTargetSize(MAX_LONG_EDGE_PX * 2, MAX_LONG_EDGE_PX)).toEqual({
        width: MAX_LONG_EDGE_PX,
        height: MAX_LONG_EDGE_PX / 2,
      });
    });

    it('scales a portrait capture down so its height meets the bound', () => {
      expect(computeTargetSize(MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX * 2)).toEqual({
        width: MAX_LONG_EDGE_PX / 2,
        height: MAX_LONG_EDGE_PX,
      });
    });

    it('reduces an oversized square to the bound on both axes', () => {
      expect(computeTargetSize(3000, 3000)).toEqual({
        width: MAX_LONG_EDGE_PX,
        height: MAX_LONG_EDGE_PX,
      });
    });

    it('pins the long edge of an odd ratio to the bound rather than a pixel short', () => {
      const target = computeTargetSize(5000, 3000);

      expect(Math.max(target.width, target.height)).toBe(MAX_LONG_EDGE_PX);
      expect(Math.abs(target.width / target.height - 5000 / 3000)).toBeLessThan(0.01);
    });
  });

  describe('shape of every answer', () => {
    /** Every family of input the branches above cover, including both degenerate ones. */
    const SIZES: ReadonlyArray<readonly [number, number]> = [
      [1, 1],
      [800, 600],
      [MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX / 2],
      [MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX],
      [MAX_LONG_EDGE_PX * 2, MAX_LONG_EDGE_PX],
      [MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX * 2],
      [3000, 3000],
      [5000, 3000],
      [0, 0],
      [Number.NaN, 100],
      [-5, 100],
    ];

    it.each(SIZES)('answers %sx%s in whole pixels', (width, height) => {
      const target = computeTargetSize(width, height);

      expect(Number.isInteger(target.width)).toBe(true);
      expect(Number.isInteger(target.height)).toBe(true);
    });

    it.each(SIZES)('answers %sx%s with a drawable pixel count', (width, height) => {
      const target = computeTargetSize(width, height);

      expect(target.width).toBeGreaterThanOrEqual(1);
      expect(target.height).toBeGreaterThanOrEqual(1);
      expect(Number.isNaN(target.width)).toBe(false);
      expect(Number.isNaN(target.height)).toBe(false);
    });
  });
});

describe('isBlankFrame', () => {
  it('reports nothing to judge as not blank', () => {
    expect(isBlankFrame(new Uint8ClampedArray(0))).toBe(false);
  });

  it('reports a uniformly coloured frame as blank', () => {
    expect(isBlankFrame(frameOf(64, () => OPAQUE_BLACK))).toBe(true);
    expect(isBlankFrame(frameOf(64, () => OPAQUE_WHITE))).toBe(true);
  });

  it('reports a frame of alternating colours as not blank', () => {
    // The predicate samples every fourth pixel, so the alternation is built at that stride: a
    // frame that varied only at the pixels the sampling skips would read as uniform.
    const pixels = frameOf(64, (index) =>
      Math.floor(index / 4) % 2 === 0 ? OPAQUE_BLACK : OPAQUE_WHITE,
    );

    expect(isBlankFrame(pixels)).toBe(false);
  });
});
