/**
 * Suite for the timing decision, driven by answers written here rather than by a recorded envelope.
 *
 * The recorded synthesis set carries no `BREAK` answer — its six files hold `RETEST`, `NOW`, `WAIT`
 * and one out-of-vocabulary line — and that inventory is closed, so the mapping from `BREAK` to
 * `ON_BREAK` and the decision that keeps or corrects `ON_BREAK` are proved against an answer object
 * written inline below. Every level and every current price is likewise written here, with fixed
 * image ids, so the suite exercises the real decision with no fixture between it and the module.
 *
 * The image ids are fixed readable strings because id shape is the routes' and the store's concern,
 * not this module's: a level's image id is compared for equality and never parsed here.
 */

import { describe, expect, it } from 'vitest';

import type { Level, Timing } from '@trade-read/shared';

import { mapSynthesis, type SynthesisAnswer } from '../../src/domain/synthesis-mapping.js';
import { decideTiming, type CurrentPriceEvidence } from '../../src/domain/timing.js';

/** The image that reports the footprint levels used by the `NOW` and `RETEST` cases. */
const FOOTPRINT_IMAGE_ID = 'image-footprint-primary';

/** A second footprint image, used to show that footprint levels elsewhere do not carry a trigger. */
const SECOND_FOOTPRINT_IMAGE_ID = 'image-footprint-secondary';

/** The image that reports gamma-exposure levels only. */
const GEX_IMAGE_ID = 'image-gex-primary';

/** An image the submission never produced, standing for evidence with no levels behind it. */
const NO_LEVEL_IMAGE_ID = 'image-without-levels';

/** The value-area high and low one footprint image reported; `5845` is the trigger of most cases. */
function footprintLevels(): readonly Level[] {
  return [
    { levelId: 'level-footprint-vah', price: 5845, type: 'FOOTPRINT_VALUE_AREA_HIGH', imageId: FOOTPRINT_IMAGE_ID },
    { levelId: 'level-footprint-val', price: 5840, type: 'FOOTPRINT_VALUE_AREA_LOW', imageId: FOOTPRINT_IMAGE_ID },
  ];
}

/** Two gamma-exposure levels from one image, no footprint level among them. */
function gammaLevels(): readonly Level[] {
  return [
    { levelId: 'level-gex-positive-gamma', price: 5840, type: 'GEX_POSITIVE_GAMMA_STRIKE', imageId: GEX_IMAGE_ID },
    { levelId: 'level-gex-zero-gamma', price: 5850, type: 'GEX_ZERO_GAMMA', imageId: GEX_IMAGE_ID },
  ];
}

/**
 * The inline answer that carries the `BREAK` timing code.
 *
 * No committed envelope answers `BREAK`, and the recorded inventory may not grow a seventh file, so
 * this literal is the evidence that the code maps to `ON_BREAK` and that the decision which keeps or
 * corrects `ON_BREAK` runs over a real answer instead of a hand-made mapped struct.
 */
const BREAK_ANSWER: SynthesisAnswer = {
  s: 'LONG',
  t: 'BREAK',
  e: 5845,
  x: 5840,
  k: [5900],
  c: 'M',
  src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
  w: 'Long through the value-area high, invalidated at the value-area low, targeting the call wall.',
};

/** One proposal made with no usable current-price evidence, and the shape of evidence that produced it. */
const NO_EVIDENCE_CASES: ReadonlyArray<readonly [Timing, string, readonly CurrentPriceEvidence[]]> = [
  ['ON_RETEST', 'no image reports a current price', []],
  ['ON_BREAK', 'no image reports a current price', []],
  ['NOW', 'no image reports a current price', []],
  ['ON_RETEST', 'the only current price comes from an image with no levels', [
    { imageId: NO_LEVEL_IMAGE_ID, price: 5845 },
  ]],
  ['ON_BREAK', 'the only current price comes from an image with no levels', [
    { imageId: NO_LEVEL_IMAGE_ID, price: 5845 },
  ]],
  ['NOW', 'the only current price comes from an image with no levels', [
    { imageId: NO_LEVEL_IMAGE_ID, price: 5845 },
  ]],
];

describe('mapSynthesis over the BREAK timing code', () => {
  it('maps an inline t:"BREAK" answer to the ON_BREAK timing', () => {
    expect(Object.keys(BREAK_ANSWER)).toEqual(['s', 't', 'e', 'x', 'k', 'c', 'src', 'w']);
    expect(BREAK_ANSWER.t).toBe('BREAK');
    expect(mapSynthesis(BREAK_ANSWER).timing).toBe('ON_BREAK');
  });
});

describe('decideTiming', () => {
  it('keeps ON_BREAK when a current price sits at the trigger of a gamma-only image', () => {
    const decision = decideTiming({
      proposed: mapSynthesis(BREAK_ANSWER).timing,
      triggerPrice: 5850,
      currentPrices: [{ imageId: GEX_IMAGE_ID, price: 5849.5 }],
      levelsByImage: new Map<string, readonly Level[]>([[GEX_IMAGE_ID, gammaLevels()]]),
    });

    expect(decision).toEqual({ timing: 'ON_BREAK', correction: null });
  });

  it('corrects ON_BREAK to WAIT when no current price sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_BREAK',
      triggerPrice: 5845,
      currentPrices: [{ imageId: FOOTPRINT_IMAGE_ID, price: 5838 }],
      levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, footprintLevels()]]),
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('ON_BREAK');
    expect(decision.correction).toContain('5845');
    expect(decision.correction?.endsWith('.')).toBe(true);
  });

  it('breaks a nearest-level tie toward the lower price when judging the trigger', () => {
    const tieLevels: readonly Level[] = [
      { levelId: 'level-gex-zero-gamma', price: 5850, type: 'GEX_ZERO_GAMMA', imageId: GEX_IMAGE_ID },
      { levelId: 'level-gex-positive-gamma', price: 5840, type: 'GEX_POSITIVE_GAMMA_STRIKE', imageId: GEX_IMAGE_ID },
    ];
    const currentPrices: readonly CurrentPriceEvidence[] = [{ imageId: GEX_IMAGE_ID, price: 5845 }];

    expect(
      decideTiming({
        proposed: 'ON_BREAK',
        triggerPrice: 5840,
        currentPrices,
        levelsByImage: new Map<string, readonly Level[]>([[GEX_IMAGE_ID, tieLevels]]),
      }),
    ).toEqual({ timing: 'ON_BREAK', correction: null });

    expect(
      decideTiming({
        proposed: 'ON_BREAK',
        triggerPrice: 5850,
        currentPrices,
        levelsByImage: new Map<string, readonly Level[]>([[GEX_IMAGE_ID, tieLevels]]),
      }).timing,
    ).toBe('WAIT');
  });

  it('keeps ON_RETEST when no current price sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_RETEST',
      triggerPrice: 5845,
      currentPrices: [{ imageId: FOOTPRINT_IMAGE_ID, price: 5842 }],
      levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, footprintLevels()]]),
    });

    expect(decision).toEqual({ timing: 'ON_RETEST', correction: null });
  });

  it('corrects ON_RETEST to WAIT when a current price already sits at the trigger', () => {
    const decision = decideTiming({
      proposed: 'ON_RETEST',
      triggerPrice: 5845,
      currentPrices: [{ imageId: FOOTPRINT_IMAGE_ID, price: 5844.5 }],
      levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, footprintLevels()]]),
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('ON_RETEST');
    expect(decision.correction).toContain('5844.5');
    expect(decision.correction).toContain('5845');
  });

  it('keeps NOW when the price at the trigger comes from an image carrying footprint levels', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerPrice: 5845,
      currentPrices: [{ imageId: FOOTPRINT_IMAGE_ID, price: 5844.5 }],
      levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, footprintLevels()]]),
    });

    expect(decision).toEqual({ timing: 'NOW', correction: null });
  });

  it('corrects NOW to WAIT when the image at the trigger carries only gamma-exposure levels', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerPrice: 5850,
      currentPrices: [{ imageId: GEX_IMAGE_ID, price: 5849.5 }],
      levelsByImage: new Map<string, readonly Level[]>([[GEX_IMAGE_ID, gammaLevels()]]),
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('NOW');
    expect(decision.correction).toContain('footprint');
  });

  it('does not let a footprint image that is away from the trigger carry a NOW', () => {
    const decision = decideTiming({
      proposed: 'NOW',
      triggerPrice: 5850,
      currentPrices: [
        { imageId: GEX_IMAGE_ID, price: 5849.5 },
        { imageId: SECOND_FOOTPRINT_IMAGE_ID, price: 5842 },
      ],
      levelsByImage: new Map<string, readonly Level[]>([
        [GEX_IMAGE_ID, gammaLevels()],
        [
          SECOND_FOOTPRINT_IMAGE_ID,
          [
            {
              levelId: 'level-secondary-vah',
              price: 5850,
              type: 'FOOTPRINT_VALUE_AREA_HIGH',
              imageId: SECOND_FOOTPRINT_IMAGE_ID,
            },
            {
              levelId: 'level-secondary-val',
              price: 5841,
              type: 'FOOTPRINT_VALUE_AREA_LOW',
              imageId: SECOND_FOOTPRINT_IMAGE_ID,
            },
          ],
        ],
      ]),
    });

    expect(decision.timing).toBe('WAIT');
    expect(decision.correction).toContain('NOW');
  });

  it.each(NO_EVIDENCE_CASES)(
    'corrects %s to WAIT when %s',
    (proposed, _evidenceShape, currentPrices) => {
      const decision = decideTiming({
        proposed,
        triggerPrice: 5845,
        currentPrices,
        levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, footprintLevels()]]),
      });

      expect(decision.timing).toBe('WAIT');
      expect(decision.correction).toContain(proposed);
      expect(decision.correction).toMatch(/no current-price evidence/i);
    },
  );

  it.each([
    ['no current-price evidence', []],
    ['a current price at the trigger', [{ imageId: FOOTPRINT_IMAGE_ID, price: 5844.5 }]],
  ] as ReadonlyArray<readonly [string, readonly CurrentPriceEvidence[]]>)(
    'keeps a proposed WAIT unchanged with %s',
    (_evidenceShape, currentPrices) => {
      const decision = decideTiming({
        proposed: 'WAIT',
        triggerPrice: 5845,
        currentPrices,
        levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, footprintLevels()]]),
      });

      expect(decision).toEqual({ timing: 'WAIT', correction: null });
    },
  );
});
