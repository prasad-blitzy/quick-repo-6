/**
 * Suite for the timing decision, driven by levels and current prices written here rather than by a
 * recorded envelope.
 *
 * The recorded synthesis set carries no `BREAK` answer — its six files hold `RETEST`, `NOW`, `WAIT`
 * and one out-of-vocabulary line — and that inventory is closed, so the mapping from `BREAK` to
 * `ON_BREAK` and the decision that keeps or corrects `ON_BREAK` are proved against an answer object
 * written inline below. Every level and every current price is likewise written here, with fixed
 * image ids, so each case states its own evidence and no fixture stands between the suite and the
 * module.
 *
 * The image ids are fixed readable strings because id shape is the routes' and the store's concern,
 * not this module's: a level id is compared for equality and never parsed here, which is exactly how
 * the decision tells one level from another that happens to carry the same price.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Timing } from '@trade-read/shared';

import type { MappedImage, MappedLevel } from '../../src/domain/extraction-mapping.js';
import { mapSynthesis, type SynthesisAnswer } from '../../src/domain/synthesis-mapping.js';
import {
  currentPriceEvidence,
  decideTiming,
  isAtTrigger,
  type TimingInput,
} from '../../src/domain/timing.js';

/** The image that reports the footprint levels the `NOW` and `ON_RETEST` cases are judged against. */
const FOOTPRINT_IMAGE_ID = 'image-footprint-primary';

/** A second footprint image, used to show that footprint levels elsewhere do not carry a trigger. */
const SECOND_FOOTPRINT_IMAGE_ID = 'image-footprint-secondary';

/** The image that reports gamma-exposure levels only. */
const GEX_IMAGE_ID = 'image-gex-primary';

/** An image the extraction could read no level from, used for the price-without-levels case. */
const NO_LEVEL_IMAGE_ID = 'image-without-levels';

/** The value-area high of the footprint image; `5845` is the trigger of most cases. */
const VALUE_AREA_HIGH: MappedLevel = {
  levelId: 'level-footprint-vah',
  price: 5845,
  type: 'FOOTPRINT_VALUE_AREA_HIGH',
  imageId: FOOTPRINT_IMAGE_ID,
};

/** The value-area low of the same footprint image, 5 below its high. */
const VALUE_AREA_LOW: MappedLevel = {
  levelId: 'level-footprint-val',
  price: 5840,
  type: 'FOOTPRINT_VALUE_AREA_LOW',
  imageId: FOOTPRINT_IMAGE_ID,
};

/** The zero-gamma level of the gamma-exposure image. */
const ZERO_GAMMA: MappedLevel = {
  levelId: 'level-gex-zero-gamma',
  price: 5850,
  type: 'GEX_ZERO_GAMMA',
  imageId: GEX_IMAGE_ID,
};

/** A gamma-exposure strike of the gamma-exposure image, 10 below its zero-gamma level. */
const POSITIVE_GAMMA: MappedLevel = {
  levelId: 'level-gex-positive-gamma',
  price: 5840,
  type: 'GEX_POSITIVE_GAMMA_STRIKE',
  imageId: GEX_IMAGE_ID,
};

/** The two levels one footprint image reported, in the order its extraction reported them. */
function footprintLevels(): readonly MappedLevel[] {
  return [VALUE_AREA_HIGH, VALUE_AREA_LOW];
}

/** The two levels one gamma-exposure image reported, with no footprint level among them. */
function gammaLevels(): readonly MappedLevel[] {
  return [ZERO_GAMMA, POSITIVE_GAMMA];
}

/**
 * One submitted image as the domain carries it from the extraction onwards.
 *
 * Only the three fields the decision reads are meaningful here: the id, the levels and the reported
 * current price. The rest are filled with fixed plausible values, so a case says what it is about
 * and nothing else.
 */
function image(
  imageId: string,
  levels: readonly MappedLevel[],
  currentPrice: number | null,
): MappedImage {
  return {
    imageId,
    fileName: `${imageId}.png`,
    contentType: 'image/png',
    byteSize: 1024,
    width: 800,
    height: 600,
    status: levels.length === 0 ? 'UNREADABLE' : 'ANALYZED',
    levels: [...levels],
    currentPrice: { imageId, price: currentPrice },
  };
}

/** The footprint image reporting the price one case needs, with no second image at all. */
function footprintImage(currentPrice: number | null): MappedImage {
  return image(FOOTPRINT_IMAGE_ID, footprintLevels(), currentPrice);
}

/** The gamma-exposure image reporting the price one case needs. */
function gexImage(currentPrice: number | null): MappedImage {
  return image(GEX_IMAGE_ID, gammaLevels(), currentPrice);
}

/**
 * The inline answer that carries the `BREAK` timing code.
 *
 * No recorded envelope answers `BREAK`, and the recorded inventory may not grow a seventh file, so
 * this literal is what proves the code maps to `ON_BREAK` and that the decision keeps `ON_BREAK`
 * over a real mapped answer instead of a hand-made mapped struct.
 */
const BREAK_ANSWER: SynthesisAnswer = {
  s: 'LONG',
  t: 'BREAK',
  e: 5850,
  x: 5840,
  k: [5900],
  c: 'M',
  src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
  w: 'Long through the zero-gamma level, invalidated at the positive-gamma strike, targeting the call wall.',
};

/** The three directional proposals, which are the ones the evidence can overrule. */
const DIRECTIONAL_TIMINGS: ReadonlyArray<Timing> = ['NOW', 'ON_RETEST', 'ON_BREAK'];

describe('mapSynthesis over the BREAK timing code', () => {
  it('maps an inline t:"BREAK" answer to the ON_BREAK timing', () => {
    expect(BREAK_ANSWER.t).toBe('BREAK');
    expect(mapSynthesis(BREAK_ANSWER).timing).toBe('ON_BREAK');
  });
});

describe('isAtTrigger', () => {
  it('holds when the trigger is the level nearest the image own current price', () => {
    expect(isAtTrigger(footprintImage(5844.5), VALUE_AREA_HIGH)).toBe(true);
  });

  it('fails when the image reported no current price', () => {
    expect(isAtTrigger(footprintImage(null), VALUE_AREA_HIGH)).toBe(false);
  });

  it('fails when the image yielded no level to be nearest to', () => {
    expect(isAtTrigger(image(NO_LEVEL_IMAGE_ID, [], 5845), VALUE_AREA_HIGH)).toBe(false);
  });

  it('breaks a nearest-level tie toward the lower price', () => {
    // The current price sits exactly midway between 5850 and 5840, so the lower level is nearest.
    const midway = gexImage(5845);

    expect(isAtTrigger(midway, POSITIVE_GAMMA)).toBe(true);
    expect(isAtTrigger(midway, ZERO_GAMMA)).toBe(false);
  });

  it('compares levels by id, so a level priced alike from another image is not the trigger', () => {
    const elsewhere: MappedLevel = {
      levelId: 'level-other-value-area-high',
      price: VALUE_AREA_HIGH.price,
      type: 'FOOTPRINT_VALUE_AREA_HIGH',
      imageId: SECOND_FOOTPRINT_IMAGE_ID,
    };

    expect(isAtTrigger(footprintImage(5845), VALUE_AREA_HIGH)).toBe(true);
    expect(isAtTrigger(footprintImage(5845), elsewhere)).toBe(false);
  });

  it('keeps the level reported first when two levels share the nearest price', () => {
    const reportedFirst: MappedLevel = {
      levelId: 'level-first-at-5845',
      price: 5845,
      type: 'FOOTPRINT_POC',
      imageId: FOOTPRINT_IMAGE_ID,
    };
    const reportedSecond: MappedLevel = {
      levelId: 'level-second-at-5845',
      price: 5845,
      type: 'FOOTPRINT_IMBALANCE',
      imageId: FOOTPRINT_IMAGE_ID,
    };
    const shared = image(FOOTPRINT_IMAGE_ID, [reportedFirst, reportedSecond], 5845);

    expect(isAtTrigger(shared, reportedFirst)).toBe(true);
    expect(isAtTrigger(shared, reportedSecond)).toBe(false);
  });
});

describe('currentPriceEvidence', () => {
  it('reports only the images that stated a current price, in submission order', () => {
    const evidence = currentPriceEvidence([
      footprintImage(5844.5),
      gexImage(null),
      image(NO_LEVEL_IMAGE_ID, [], 5851),
    ]);

    expect(evidence).toEqual([
      { imageId: FOOTPRINT_IMAGE_ID, price: 5844.5 },
      { imageId: NO_LEVEL_IMAGE_ID, price: 5851 },
    ]);
  });

  it('reports no evidence when every image reported no current price', () => {
    expect(currentPriceEvidence([footprintImage(null), gexImage(null)])).toEqual([]);
  });
});

describe('decideTiming', () => {
  it('keeps NOW when the trigger sits at the current price of a footprint image', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerLevel: VALUE_AREA_HIGH,
      images: [footprintImage(5844.5)],
    });

    expect(decision).toEqual({ timing: 'NOW', correction: null });
  });

  it('corrects NOW to WAIT when the image at the trigger carries only gamma-exposure levels', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerLevel: ZERO_GAMMA,
      images: [gexImage(5849.5)],
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('NOW');
    expect(decision.correction).toContain('footprint');
    expect(decision.correction).toContain('5849.5');
    expect(decision.correction).toContain('5850');
  });

  it('does not let a footprint image away from the trigger carry a NOW', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerLevel: ZERO_GAMMA,
      images: [
        gexImage(5849.5),
        image(SECOND_FOOTPRINT_IMAGE_ID, [
          {
            levelId: 'level-secondary-vah',
            price: 5850,
            type: 'FOOTPRINT_VALUE_AREA_HIGH',
            imageId: SECOND_FOOTPRINT_IMAGE_ID,
          },
        ], 5842),
      ],
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('NOW');
    expect(decision.correction).toContain('footprint');
  });

  it('corrects NOW to WAIT when no current price reaches the trigger', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerLevel: VALUE_AREA_HIGH,
      images: [footprintImage(5838)],
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('NOW');
    expect(decision.correction).toContain('5845');
  });

  it('keeps ON_BREAK when a current price sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_BREAK',
      triggerLevel: ZERO_GAMMA,
      images: [gexImage(5849.5)],
    });

    expect(decision).toEqual({ timing: 'ON_BREAK', correction: null });
  });

  it('corrects ON_BREAK to WAIT when no current price sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_BREAK',
      triggerLevel: VALUE_AREA_HIGH,
      images: [footprintImage(5838)],
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('ON_BREAK');
    expect(decision.correction).toContain('5845');
    expect(decision.correction?.endsWith('.')).toBe(true);
  });

  it('keeps ON_BREAK reached through the BREAK timing code', () => {
    const decision = decideTiming({
      proposed: mapSynthesis(BREAK_ANSWER).timing,
      triggerLevel: ZERO_GAMMA,
      images: [gexImage(5850), footprintImage(null)],
    });

    expect(decision).toEqual({ timing: 'ON_BREAK', correction: null });
  });

  it('keeps ON_RETEST when no current price sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_RETEST',
      triggerLevel: VALUE_AREA_HIGH,
      images: [footprintImage(5842)],
    });

    expect(decision).toEqual({ timing: 'ON_RETEST', correction: null });
  });

  it('corrects ON_RETEST to WAIT when a current price already sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_RETEST',
      triggerLevel: VALUE_AREA_HIGH,
      images: [footprintImage(5844.5)],
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('ON_RETEST');
    expect(decision.correction).toContain('5844.5');
    expect(decision.correction).toContain('5845');
  });

  it('counts a current price without levels behind it as evidence that exists', () => {
    // The price is reported, so current-price evidence exists; the image yields no level, so no
    // image is at the trigger and a retest still stands.
    const decision = decideTiming({
      proposed: 'ON_RETEST',
      triggerLevel: VALUE_AREA_HIGH,
      images: [footprintImage(null), image(NO_LEVEL_IMAGE_ID, [], 5845)],
    });

    expect(decision).toEqual({ timing: 'ON_RETEST', correction: null });
  });

  it.each(DIRECTIONAL_TIMINGS)(
    'corrects %s to WAIT when no image reported a current price',
    (proposed) => {
      const decision = decideTiming({
        proposed,
        triggerLevel: VALUE_AREA_HIGH,
        images: [footprintImage(null), gexImage(null)],
      });

      expect(decision.timing).toBe('WAIT');
      expect(decision.correction).toContain(proposed);
      expect(decision.correction).toMatch(/no current price was visible/i);
    },
  );

  it.each(DIRECTIONAL_TIMINGS)(
    'corrects %s to WAIT when the read cites no trigger level',
    (proposed) => {
      const decision = decideTiming({
        proposed,
        triggerLevel: null,
        images: [footprintImage(5845)],
      });

      expect(decision.timing).toBe('WAIT');
      expect(decision.correction).toContain(proposed);
      expect(decision.correction).toContain('cites no trigger level');
    },
  );

  it.each([
    ['no current-price evidence', [footprintImage(null)]],
    ['a current price at the trigger', [footprintImage(5845)]],
  ] as ReadonlyArray<readonly [string, ReadonlyArray<MappedImage>]>)(
    'keeps a proposed WAIT unchanged with %s',
    (_evidenceShape, images) => {
      const decision = decideTiming({
        proposed: 'WAIT',
        triggerLevel: VALUE_AREA_HIGH,
        images,
      });

      expect(decision).toEqual({ timing: 'WAIT', correction: null });
    },
  );

  it('decides every matrix case identically on repeated evaluation', () => {
    const matrix: ReadonlyArray<TimingInput> = [
      { proposed: 'NOW', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(5844.5)] },
      { proposed: 'NOW', triggerLevel: ZERO_GAMMA, images: [gexImage(5849.5)] },
      { proposed: 'NOW', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(5838)] },
      { proposed: 'NOW', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(null)] },
      { proposed: 'ON_BREAK', triggerLevel: ZERO_GAMMA, images: [gexImage(5849.5)] },
      { proposed: 'ON_BREAK', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(5838)] },
      { proposed: 'ON_BREAK', triggerLevel: null, images: [footprintImage(5845)] },
      { proposed: 'ON_RETEST', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(5842)] },
      { proposed: 'ON_RETEST', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(5844.5)] },
      { proposed: 'WAIT', triggerLevel: VALUE_AREA_HIGH, images: [footprintImage(5845)] },
    ];

    const first = matrix.map((input) => decideTiming(input));

    expect(first.map((decision) => decision.timing)).toEqual([
      'NOW',
      'WAIT',
      'WAIT',
      'WAIT',
      'ON_BREAK',
      'WAIT',
      'WAIT',
      'ON_RETEST',
      'WAIT',
      'WAIT',
    ]);

    for (let run = 0; run < 100; run += 1) {
      expect(matrix.map((input) => decideTiming(input))).toEqual(first);
    }
  });
});

describe('the module source', () => {
  const source = readFileSync(new URL('../../src/domain/timing.ts', import.meta.url), 'utf8');

  it('imports only the shared contract and the mapped-image types', () => {
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

    expect(specifiers).toEqual(['@trade-read/shared', './extraction-mapping.js']);
  });

  it('reads no clock, no randomness, no network, no filesystem and no prompt text', () => {
    for (const forbidden of [
      'Date.now',
      'new Date',
      'Math.random',
      'fetch(',
      'node:fs',
      "from 'node:",
      'synthesis-mapping',
      'zod',
      'AppError',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
