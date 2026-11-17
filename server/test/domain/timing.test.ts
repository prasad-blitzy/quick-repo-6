/**
 * Suite for the timing decision: the timing the price evidence supports, whatever the answer proposed.
 *
 * AAP §0.6.2 rule 4 and decision D8 fix what `server/src/domain/timing.ts` enforces. `ON_RETEST`
 * requires that no current price sits at the trigger, `ON_BREAK` requires that one does, `NOW`
 * requires one there from an image that also yielded a footprint level, a contradiction is corrected
 * to `WAIT`, `WAIT` is never corrected, and with no current-price evidence at all every directional
 * proposal becomes `WAIT`. Both directions of every arm are proved below — the proposal the evidence
 * supports is kept and the one it contradicts is corrected — because a suite that only proved
 * survival would not prove the rule.
 *
 * Every `MappedImage` is produced the way the analysis service produces one: a committed
 * screenshot's real bytes through `validateImages`, that screenshot's recorded chat-completions
 * envelope through `extractionAnswerSchema`, and `mapExtraction`. No level, no price and no image is
 * written by hand here, and every trigger level is resolved out of the evidence by
 * `buildLevelIndex` + `matchPrice` by exact equality, so no case judges a price the submission does
 * not hold (D6).
 *
 * The recorded evidence, with the submission-order ids the cases use (`IMAGE_1` is the first file
 * dropped), asserted in its own block below so a drifted fixture fails as evidence rather than as a
 * puzzling decision:
 *
 * | fixture             | its own current price | the levels it reports                                  | footprint? |
 * | `footprint-es-5m`   | 5844.25               | 5841.25 VAL, 5842.00 OTH, 5842.75 IMB, 5843.50 POC,    | yes        |
 * |                     |                       | 5844.25 OTH, 5845.00 VAH                              |            |
 * | `gex-es-levels`     | 5850.00               | 5800.00 GPW, 5840.00 GPG, 5850.00 GZG, 5860.00 GNG,    | no         |
 * |                     |                       | 5900.00 GCW                                           |            |
 * | `dom-ladder-es`     | 5840.00               | 5835.00 OTH, 5838.00 LV, 5840.00 ABS, 5845.00 OTH      | no         |
 * | `volume-profile-es` | 5847.00               | 5836.00 VAL, 5843.00 POC, 5847.00 VAH                  | yes        |
 * | `blank-uniform`     | none (`LAST=NA`)      | none                                                   | no         |
 *
 * Two answers are quoted rather than driven: `BREAK` appears in no recorded envelope, so the literal
 * that carries it is written inline to prove the wire code maps to `ON_BREAK`; and the equidistant
 * price the tie-break case needs exists in no recorded reading, so that one price is set while every
 * level price stays the recorded one. Both are commented where they stand.
 *
 * The audited prices are never rounded and never compared with a tolerance: a mismatch must fail.
 */

import { describe, expect, it } from 'vitest';

import { isFootprintLevelType, type Timing } from '@trade-read/shared';

import {
  mapExtraction,
  type MappedImage,
  type MappedLevel,
} from '../../src/domain/extraction-mapping.js';
import { validateImages, type ValidatedImage } from '../../src/domain/image-validation.js';
import { buildLevelIndex, matchPrice, type LevelIndex } from '../../src/domain/level-matching.js';
import { extractionAnswerSchema } from '../../src/domain/schemas.js';
import { mapSynthesis, type SynthesisAnswer } from '../../src/domain/synthesis-mapping.js';
import {
  currentPriceEvidence,
  decideTiming,
  isAtTrigger,
  type TimingDecision,
  type TimingInput,
} from '../../src/domain/timing.js';
import { screenshotAttachment } from '../helpers/fixtures.js';
import {
  recordedAnswerLine,
  recordedExtraction,
  type RecordedExtractionStem,
} from '../helpers/recorded.js';

/**
 * The public timings, named once.
 *
 * `@trade-read/shared` declares the union and the `TIMINGS` tuple but no constant per member, so this
 * table is the suite's single naming of them: every proposal and every expectation below is a member
 * of that union, and `satisfies` stops the build if the union ever stops admitting one.
 */
const TIMING = {
  now: 'NOW',
  onRetest: 'ON_RETEST',
  onBreak: 'ON_BREAK',
  wait: 'WAIT',
} as const satisfies Readonly<Record<string, Timing>>;

/** The three proposals the evidence can overrule; `WAIT` claims nothing about the price. */
const DIRECTIONAL_TIMINGS: readonly Timing[] = [TIMING.now, TIMING.onRetest, TIMING.onBreak];

/**
 * Every price this suite decides over, exactly as the recorded envelopes report them.
 *
 * The values are written out rather than read back out of the answer lines, because an assertion that
 * read its expectation from the same parsed envelope could not tell a mapping that echoed its input
 * from one that preserved it.
 */
const PRICE = {
  /** The price the footprint reading reports as its own current one; also the OTH level at it. */
  footprintLast: 5844.25,
  /** The footprint imbalance, and the trigger most of the negative cases are judged against. */
  footprintImbalance: 5842.75,
  /** The footprint point of control: a level the image reports, away from its current price. */
  footprintPointOfControl: 5843.5,
  /** The other footprint level equidistant from the tie-break case's current price. */
  footprintOther: 5844.25,
  /** The gamma reading's own current price, and its zero-gamma level. */
  gexLast: 5850,
  gexZeroGamma: 5850,
  /** The depth-of-market reading's own current price, and its absorption level. */
  domLast: 5840,
  domAbsorption: 5840,
  /** The volume-profile reading's own current price, and its value-area high. */
  volumeProfileLast: 5847,
  volumeProfileValueAreaHigh: 5847,
  /** The volume-profile point of control: a level the image reports, away from its current price. */
  volumeProfilePointOfControl: 5843,
} as const;

/** The id a submission's image carries at a position: `IMAGE_1` for the first file, and so on. */
function imageIdAt(position: number): string {
  return `IMAGE_${String(position + 1)}`;
}

/**
 * The one validated part a single-screenshot upload yields, failing loudly rather than letting an
 * assertion run against an absent element (`noUncheckedIndexedAccess` makes an indexed read optional).
 */
function validateOnly(stem: RecordedExtractionStem): ValidatedImage {
  const [validated] = validateImages([screenshotAttachment(stem)]);

  if (validated === undefined) {
    throw new Error(`Upload validation returned no image for the "${stem}" fixture.`);
  }

  return validated;
}

/**
 * One recorded reading as the domain carries it: the fixture's own bytes through the real upload
 * validator, its recorded envelope's answer line through the real extraction schema, and the mapping
 * the analysis service applies. The id is the position the file was dropped in.
 */
function mappedImage(stem: RecordedExtractionStem, imageId: string): MappedImage {
  const validated = validateOnly(stem);
  const answerLine = recordedAnswerLine(recordedExtraction(stem));
  const answer = extractionAnswerSchema.parse(JSON.parse(answerLine));

  return mapExtraction({ validated, imageId, answer }).image;
}

/** One submission with the lookups the cases need, so no case builds an index or resolves a trigger. */
interface Submission {
  /** The images in submission order, carrying `IMAGE_1`, `IMAGE_2`, ... as their ids. */
  readonly images: MappedImage[];
  /** The level index over exactly those images, in that order. */
  readonly index: LevelIndex;
  /** The image one fixture produced. */
  image(stem: RecordedExtractionStem): MappedImage;
  /** The level one cited price resolves to by exact equality (D6). */
  trigger(price: number): MappedLevel;
}

/**
 * Builds one submission the way the analysis service does: each fixture's recorded reading mapped to
 * the position it was dropped in, then one level index over the whole set.
 */
function submission(...stems: RecordedExtractionStem[]): Submission {
  const images: MappedImage[] = [];
  const byStem = new Map<RecordedExtractionStem, MappedImage>();

  stems.forEach((stem, position) => {
    const mapped = mappedImage(stem, imageIdAt(position));
    images.push(mapped);
    byStem.set(stem, mapped);
  });

  const index = buildLevelIndex(images);

  return {
    images,
    index,
    image: (stem) => {
      const mapped = byStem.get(stem);

      if (mapped === undefined) {
        throw new Error(`This submission did not include the "${stem}" fixture.`);
      }

      return mapped;
    },
    trigger: (price) => {
      const level = matchPrice(index, price, { sourceImageIds: [] });

      if (level === null) {
        throw new Error(
          `No level of this submission is priced ${String(price)}; a case must judge a price the ` +
            'evidence actually reported.',
        );
      }

      return level;
    },
  };
}

/**
 * The same levels with every reported current price removed: a submission whose extractions all read
 * `LAST=NA`. The levels are untouched, which is what isolates D8's "no current-price evidence at all"
 * from "a current price that does not reach the trigger".
 */
function withoutReportedPrice(images: ReadonlyArray<MappedImage>): MappedImage[] {
  return images.map((image) => ({
    ...image,
    currentPrice: { imageId: image.imageId, price: null },
  }));
}

/** Whether one image yielded a footprint level, by the shared predicate rather than a local list (D4). */
function carriesFootprintLevel(image: MappedImage): boolean {
  return image.levels.some((level) => isFootprintLevelType(level.type));
}

describe('the recorded evidence every case below decides over', () => {
  it('maps each recorded extraction to the current price and the levels its envelope reports', () => {
    const every = submission(
      'footprint-es-5m',
      'gex-es-levels',
      'dom-ladder-es',
      'volume-profile-es',
      'blank-uniform',
    );

    const footprint = every.image('footprint-es-5m');
    expect(footprint.imageId).toBe('IMAGE_1');
    expect(footprint.currentPrice.price).toBe(PRICE.footprintLast);
    expect(footprint.levels.map((level) => level.price)).toEqual([
      5841.25, 5842, 5842.75, 5843.5, 5844.25, 5845,
    ]);
    expect(carriesFootprintLevel(footprint)).toBe(true);

    const gex = every.image('gex-es-levels');
    expect(gex.imageId).toBe('IMAGE_2');
    expect(gex.currentPrice.price).toBe(PRICE.gexLast);
    expect(gex.levels.map((level) => level.price)).toEqual([5800, 5840, 5850, 5860, 5900]);
    expect(carriesFootprintLevel(gex)).toBe(false);

    const domLadder = every.image('dom-ladder-es');
    expect(domLadder.currentPrice.price).toBe(PRICE.domLast);
    expect(domLadder.levels.map((level) => level.price)).toEqual([5835, 5838, 5840, 5845]);
    expect(carriesFootprintLevel(domLadder)).toBe(false);

    const volumeProfile = every.image('volume-profile-es');
    expect(volumeProfile.currentPrice.price).toBe(PRICE.volumeProfileLast);
    expect(volumeProfile.levels.map((level) => level.price)).toEqual([5836, 5843, 5847]);
    expect(carriesFootprintLevel(volumeProfile)).toBe(true);

    const blank = every.image('blank-uniform');
    expect(blank.currentPrice.price).toBeNull();
    expect(blank.levels).toEqual([]);
    expect(carriesFootprintLevel(blank)).toBe(false);
  });
});

describe('decideTiming — NOW', () => {
  it('keeps NOW when a footprint image sits at the trigger', () => {
    // The shape of the recorded `synthesis-short` read: the setup is live in a footprint screenshot
    // whose own current price is the level in question, which is the still-image form of D8's `NOW`
    // condition. The volume-profile reading reports 5847 as its own current price and 5847 as its
    // value-area high, so its value-area high is where price is, and it carries footprint levels.
    const evidence = submission('volume-profile-es', 'gex-es-levels');
    const trigger = evidence.trigger(PRICE.volumeProfileValueAreaHigh);
    const atTrigger = evidence.image('volume-profile-es');

    expect(trigger.imageId).toBe(atTrigger.imageId);
    expect(trigger.type).toBe('FOOTPRINT_VALUE_AREA_HIGH');
    expect(isAtTrigger(atTrigger, trigger)).toBe(true);
    expect(carriesFootprintLevel(atTrigger)).toBe(true);
    expect(
      decideTiming({ proposed: TIMING.now, triggerLevel: trigger, images: evidence.images }),
    ).toEqual({ timing: TIMING.now, correction: null });
  });

  it('keeps NOW at the entry level the recorded short read cites', () => {
    // `synthesis-short` proposes NOW at 5844.25, resting on the footprint and gamma screenshots. The
    // footprint reading's own current price is that very level and the reading carries footprint
    // levels, so the proposal survives its own evidence.
    const evidence = submission('footprint-es-5m', 'gex-es-levels');
    const trigger = evidence.trigger(PRICE.footprintLast);

    expect(isAtTrigger(evidence.image('footprint-es-5m'), trigger)).toBe(true);
    expect(
      decideTiming({ proposed: TIMING.now, triggerLevel: trigger, images: evidence.images }),
    ).toEqual({ timing: TIMING.now, correction: null });
  });

  it('corrects NOW when the image at the trigger carries no footprint level', () => {
    // Only the gamma reading is at this trigger: its own current price of 5850 is its zero-gamma
    // level. Nothing it reported is a footprint level, so nothing shows the setup live in the final
    // bars of a footprint screenshot.
    const evidence = submission('volume-profile-es', 'gex-es-levels');
    const trigger = evidence.trigger(PRICE.gexZeroGamma);

    expect(isAtTrigger(evidence.image('volume-profile-es'), trigger)).toBe(false);
    expect(isAtTrigger(evidence.image('gex-es-levels'), trigger)).toBe(true);
    expect(carriesFootprintLevel(evidence.image('gex-es-levels'))).toBe(false);

    const decision = decideTiming({
      proposed: TIMING.now,
      triggerLevel: trigger,
      images: evidence.images,
    });

    expect(decision.timing).toBe(TIMING.wait);
    expect(decision.correction).toContain('NOW');
    expect(decision.correction).toContain('5850');
    expect(decision.correction).toContain('reports no footprint level');
  });

  it('corrects NOW when no current price reaches the trigger', () => {
    // The footprint reading's own current price of 5844.25 is nearest its 5844.25 level and the gamma
    // reading's 5850 is nearest its own zero-gamma level, so neither is at 5842.75.
    const evidence = submission('footprint-es-5m', 'gex-es-levels');
    const trigger = evidence.trigger(PRICE.footprintImbalance);

    expect(isAtTrigger(evidence.image('footprint-es-5m'), trigger)).toBe(false);
    expect(isAtTrigger(evidence.image('gex-es-levels'), trigger)).toBe(false);
    // Two prices were reported, so what corrects this proposal is "not reached", not "no price at all".
    expect(currentPriceEvidence(evidence.images)).toHaveLength(2);

    const decision = decideTiming({
      proposed: TIMING.now,
      triggerLevel: trigger,
      images: evidence.images,
    });

    expect(decision.timing).toBe(TIMING.wait);
    expect(decision.correction).toContain('NOW');
    expect(decision.correction).toContain('5842.75');
    expect(decision.correction).toContain('nearest level of its own image');
  });
});

describe('decideTiming — ON_BREAK', () => {
  it('keeps ON_BREAK when a current price sits at the trigger', () => {
    // A break is the trigger being tested right now: the depth-of-market reading reports 5840 as its
    // own current price and 5840 as its absorption level.
    const evidence = submission('dom-ladder-es');
    const trigger = evidence.trigger(PRICE.domAbsorption);

    expect(trigger.type).toBe('ABSORPTION');
    expect(isAtTrigger(evidence.image('dom-ladder-es'), trigger)).toBe(true);
    expect(
      decideTiming({ proposed: TIMING.onBreak, triggerLevel: trigger, images: evidence.images }),
    ).toEqual({ timing: TIMING.onBreak, correction: null });
  });

  it('corrects ON_BREAK when no current price sits at the trigger', () => {
    const evidence = submission('footprint-es-5m', 'gex-es-levels');
    const trigger = evidence.trigger(PRICE.footprintImbalance);

    const decision = decideTiming({
      proposed: TIMING.onBreak,
      triggerLevel: trigger,
      images: evidence.images,
    });

    expect(decision.timing).toBe(TIMING.wait);
    expect(decision.correction).toContain('ON_BREAK');
    expect(decision.correction).toContain('5842.75');
    expect(decision.correction).toContain('nearest level of its own image');
  });
});

describe('the BREAK timing code', () => {
  /**
   * The answer that carries the `BREAK` code.
   *
   * No recorded envelope answers `BREAK` — the recorded synthesis set holds `RETEST`, `NOW`, `WAIT`
   * and the out-of-vocabulary line — so this literal is what proves the wire code translates to
   * `ON_BREAK` and that the decision then keeps it on evidence that supports it. Its prices are the
   * recorded ones; only its timing code matters to this suite.
   */
  const BREAK_ANSWER: SynthesisAnswer = {
    s: 'LONG',
    t: 'BREAK',
    e: PRICE.gexZeroGamma,
    x: 5860,
    k: [5900],
    c: 'M',
    src: [],
    w: 'Long through zero gamma, invalidated at the negative-gamma strike, targeting the call wall.',
  };

  it('translates BREAK to ON_BREAK and keeps it over an image at the trigger', () => {
    const mapped = mapSynthesis(BREAK_ANSWER);
    const evidence = submission('dom-ladder-es');
    const trigger = evidence.trigger(PRICE.domAbsorption);

    expect(mapped.timing).toBe(TIMING.onBreak);
    expect(
      decideTiming({ proposed: mapped.timing, triggerLevel: trigger, images: evidence.images }),
    ).toEqual({ timing: TIMING.onBreak, correction: null });
  });
});


describe('decideTiming — ON_RETEST', () => {
  it('keeps ON_RETEST when no current price sits at the trigger', () => {
    // The recorded `synthesis-long` read: RETEST at 5842.75, resting on both screenshots. Neither
    // image's own current price is nearest that level, so the retest the answer proposes is real.
    const evidence = submission('footprint-es-5m', 'gex-es-levels');
    const trigger = evidence.trigger(PRICE.footprintImbalance);

    expect(isAtTrigger(evidence.image('footprint-es-5m'), trigger)).toBe(false);
    expect(isAtTrigger(evidence.image('gex-es-levels'), trigger)).toBe(false);
    expect(
      decideTiming({ proposed: TIMING.onRetest, triggerLevel: trigger, images: evidence.images }),
    ).toEqual({ timing: TIMING.onRetest, correction: null });
  });

  it('corrects ON_RETEST when a current price already sits at the trigger', () => {
    // A retest is the trigger not having been reached yet, and the depth-of-market reading's own
    // current price of 5840 is its absorption level.
    const evidence = submission('dom-ladder-es');
    const trigger = evidence.trigger(PRICE.domAbsorption);

    const decision = decideTiming({
      proposed: TIMING.onRetest,
      triggerLevel: trigger,
      images: evidence.images,
    });

    expect(decision.timing).toBe(TIMING.wait);
    expect(decision.correction).toContain('ON_RETEST');
    expect(decision.correction).toContain('5840');
    expect(decision.correction).toContain('already sits at the trigger level');
  });
});

describe('decideTiming — WAIT', () => {
  it('keeps a proposed WAIT unchanged whether the evidence is full or absent', () => {
    const full = submission('footprint-es-5m', 'gex-es-levels');
    const blank = submission('blank-uniform');

    // `WAIT` claims nothing about the price, so no price can contradict it: it is a complete result
    // and never earns a correction, whatever the images reported.
    expect(
      decideTiming({
        proposed: TIMING.wait,
        triggerLevel: full.trigger(PRICE.footprintImbalance),
        images: full.images,
      }),
    ).toEqual({ timing: TIMING.wait, correction: null });

    // The blank reading reported `LAST=NA` and yielded no level, so this read cites no trigger either.
    expect(
      decideTiming({ proposed: TIMING.wait, triggerLevel: null, images: blank.images }),
    ).toEqual({ timing: TIMING.wait, correction: null });
  });
});

describe('decideTiming — absent current-price evidence', () => {
  it.each(DIRECTIONAL_TIMINGS)(
    'corrects %s to WAIT when the only image yielded no level and no current price',
    (proposed) => {
      // The blank submission holds no level, so a read over it cites no trigger at all: every
      // directional proposal is corrected rather than kept.
      const blank = submission('blank-uniform');
      const decision = decideTiming({ proposed, triggerLevel: null, images: blank.images });

      expect(decision.timing).toBe(TIMING.wait);
      expect(decision.correction).toContain(proposed);
    },
  );

  it.each(DIRECTIONAL_TIMINGS)(
    'corrects %s to WAIT when the images carry levels but reported no current price',
    (proposed) => {
      // D8: when no current-price evidence exists at all, all three correct to WAIT. The levels are
      // the recorded ones and the trigger is the level the recorded submission holds; only the prices
      // the two images reported for themselves are gone, which is what isolates this branch from
      // "a price that does not reach the trigger".
      const recorded = submission('footprint-es-5m', 'gex-es-levels');
      const trigger = recorded.trigger(PRICE.footprintImbalance);
      const pricesAbsent = withoutReportedPrice(recorded.images);

      expect(currentPriceEvidence(pricesAbsent)).toEqual([]);
      expect(trigger.imageId).toBe(recorded.image('footprint-es-5m').imageId);

      const decision = decideTiming({ proposed, triggerLevel: trigger, images: pricesAbsent });

      expect(decision.timing).toBe(TIMING.wait);
      expect(decision.correction).toContain(proposed);
      expect(decision.correction).toContain('no current price was visible in the submitted images');
    },
  );
});

describe('isAtTrigger', () => {
  it('holds only when the trigger is the nearest of that image own levels', () => {
    const evidence = submission('volume-profile-es');
    const image = evidence.image('volume-profile-es');
    const atItsOwnPrice = evidence.trigger(PRICE.volumeProfileValueAreaHigh);
    const insideItsRange = evidence.trigger(PRICE.volumeProfilePointOfControl);

    // 5847 is the price this image reported as its own current one, so its value-area high is where
    // price is.
    expect(isAtTrigger(image, atItsOwnPrice)).toBe(true);
    // 5843 is a level the same image reported, yet the image's current price of 5847 is nearest its
    // 5847 level, so the point of control is not somewhere price currently sits.
    expect(atItsOwnPrice.price).toBe(PRICE.volumeProfileLast);
    expect(insideItsRange.price).toBe(PRICE.volumeProfilePointOfControl);
    expect(isAtTrigger(image, insideItsRange)).toBe(false);

    expect(
      decideTiming({ proposed: TIMING.onBreak, triggerLevel: atItsOwnPrice, images: evidence.images })
        .timing,
    ).toBe(TIMING.onBreak);
    expect(
      decideTiming({ proposed: TIMING.onBreak, triggerLevel: insideItsRange, images: evidence.images })
        .timing,
    ).toBe(TIMING.wait);
  });

  it('fails for an image that reported no current price and for one with no level behind its price', () => {
    const gexTrigger = submission('gex-es-levels').trigger(PRICE.gexZeroGamma);
    const blank = submission('blank-uniform').image('blank-uniform');

    expect(blank.currentPrice.price).toBeNull();
    expect(isAtTrigger(blank, gexTrigger)).toBe(false);

    // The price is the recorded one; only the level list is emptied, modelling a reading whose every
    // pair was dropped (rule 6), so the image has nothing for its price to be nearest to.
    const volumeProfile = submission('volume-profile-es');
    const valueAreaHigh = volumeProfile.trigger(PRICE.volumeProfileValueAreaHigh);
    const priceWithNoLevels: MappedImage = {
      ...volumeProfile.image('volume-profile-es'),
      levels: [],
    };

    expect(priceWithNoLevels.currentPrice.price).toBe(PRICE.volumeProfileLast);
    expect(isAtTrigger(priceWithNoLevels, valueAreaHigh)).toBe(false);
  });

  it('compares levels by id, so a level priced alike is not the trigger the read cites', () => {
    // Two levels can share a price, so the decision judges the level the read actually references:
    // the same price under a different level id is a different level.
    const evidence = submission('gex-es-levels');
    const image = evidence.image('gex-es-levels');
    const cited = evidence.trigger(PRICE.gexZeroGamma);
    const relabelled: MappedLevel = { ...cited, levelId: 'level-relabelled-zero-gamma' };

    expect(isAtTrigger(image, cited)).toBe(true);
    expect(isAtTrigger(image, relabelled)).toBe(false);
  });

  it('breaks a nearest-level tie toward the lower price', () => {
    // No recorded current price is equidistant from two of its own levels, so the price here is set
    // midway between the recorded 5843.5 POC and 5844.25 OTH; every level price stays recorded.
    const evidence = submission('footprint-es-5m');
    const image = evidence.image('footprint-es-5m');
    const pointOfControl = evidence.trigger(PRICE.footprintPointOfControl);
    const other = evidence.trigger(PRICE.footprintOther);
    const midwayPrice = (PRICE.footprintPointOfControl + PRICE.footprintOther) / 2;
    const midway: MappedImage = {
      ...image,
      currentPrice: { imageId: image.imageId, price: midwayPrice },
    };

    expect(midwayPrice).toBe(5843.875);
    expect(pointOfControl.price).toBe(PRICE.footprintPointOfControl);
    expect(other.price).toBe(PRICE.footprintOther);
    expect(isAtTrigger(midway, pointOfControl)).toBe(true);
    expect(isAtTrigger(midway, other)).toBe(false);
  });
});

/** One branch of the decision that owes a correction, with the wording its template must produce. */
interface CorrectionRow {
  /** What the branch is about, quoted in the case title. */
  readonly label: string;
  /** The decision to make, built from the recorded evidence like every other case. */
  readonly decide: () => TimingDecision;
  /** The substrings the branch's own template produces: the proposal and the evidence it found. */
  readonly mentions: readonly string[];
}

/**
 * Every correction the decision can make, one row each.
 *
 * The substrings are read off `server/src/domain/timing.ts`'s own sentence templates rather than
 * guessed, so a template that stopped naming the proposal or the evidence it found fails here.
 */
const CORRECTION_ROWS: readonly CorrectionRow[] = [
  {
    label: 'a read that cites no trigger level',
    decide: () =>
      decideTiming({
        proposed: TIMING.now,
        triggerLevel: null,
        images: submission('blank-uniform').images,
      }),
    mentions: ['The proposed NOW timing was corrected to WAIT', 'cites no trigger level'],
  },
  {
    label: 'no current price visible in any image',
    decide: () => {
      const recorded = submission('footprint-es-5m', 'gex-es-levels');

      return decideTiming({
        proposed: TIMING.onBreak,
        triggerLevel: recorded.trigger(PRICE.footprintImbalance),
        images: withoutReportedPrice(recorded.images),
      });
    },
    mentions: [
      'The proposed ON_BREAK timing was corrected to WAIT',
      'no current price was visible',
    ],
  },
  {
    label: 'no reported current price at the trigger',
    decide: () => {
      const recorded = submission('footprint-es-5m', 'gex-es-levels');

      return decideTiming({
        proposed: TIMING.now,
        triggerLevel: recorded.trigger(PRICE.footprintImbalance),
        images: recorded.images,
      });
    },
    mentions: [
      'The proposed NOW timing was corrected to WAIT',
      '5842.75',
      'nearest level of its own image',
    ],
  },
  {
    label: 'an at-trigger image with no footprint level',
    decide: () => {
      const recorded = submission('volume-profile-es', 'gex-es-levels');

      return decideTiming({
        proposed: TIMING.now,
        triggerLevel: recorded.trigger(PRICE.gexZeroGamma),
        images: recorded.images,
      });
    },
    mentions: [
      'The proposed NOW timing was corrected to WAIT',
      '5850',
      'reports no footprint level',
    ],
  },
  {
    label: 'a current price already at the trigger',
    decide: () => {
      const recorded = submission('dom-ladder-es');

      return decideTiming({
        proposed: TIMING.onRetest,
        triggerLevel: recorded.trigger(PRICE.domAbsorption),
        images: recorded.images,
      });
    },
    mentions: [
      'The proposed ON_RETEST timing was corrected to WAIT',
      '5840',
      'already sits at the trigger level',
    ],
  },
];

describe('the correction sentence', () => {
  const title = 'names the proposal and the evidence it found: $label';

  it.each(CORRECTION_ROWS)(title, ({ decide, mentions }) => {
    const { timing, correction } = decide();

    expect(timing).toBe(TIMING.wait);
    expect(typeof correction).toBe('string');
    expect(correction).not.toBe('');
    for (const mention of mentions) {
      expect(correction).toContain(mention);
    }
    expect(correction?.endsWith('.')).toBe(true);
  });
});

describe('decideTiming — the proposal is only a hypothesis', () => {
  it('supports one proposal and overrules another from the very same evidence', () => {
    // D8: no branch reads the model's timing code other than as the proposal being tested, so the
    // same images and the same trigger decide differently for different proposals.
    const gammaAtItsOwnPrice = submission('volume-profile-es', 'gex-es-levels');
    const zeroGamma = gammaAtItsOwnPrice.trigger(PRICE.gexZeroGamma);

    expect(
      decideTiming({
        proposed: TIMING.now,
        triggerLevel: zeroGamma,
        images: gammaAtItsOwnPrice.images,
      }),
    ).toEqual({ timing: TIMING.wait, correction: expect.any(String) });
    expect(
      decideTiming({
        proposed: TIMING.onBreak,
        triggerLevel: zeroGamma,
        images: gammaAtItsOwnPrice.images,
      }),
    ).toEqual({ timing: TIMING.onBreak, correction: null });

    const nothingAtTheTrigger = submission('footprint-es-5m', 'gex-es-levels');
    const imbalance = nothingAtTheTrigger.trigger(PRICE.footprintImbalance);

    expect(
      decideTiming({
        proposed: TIMING.onRetest,
        triggerLevel: imbalance,
        images: nothingAtTheTrigger.images,
      }),
    ).toEqual({ timing: TIMING.onRetest, correction: null });
    expect(
      decideTiming({
        proposed: TIMING.onBreak,
        triggerLevel: imbalance,
        images: nothingAtTheTrigger.images,
      }),
    ).toEqual({ timing: TIMING.wait, correction: expect.any(String) });
  });
});

describe('determinism', () => {
  it('decides every evidence set identically on repeated evaluation', () => {
    const volumeProfileAndGex = submission('volume-profile-es', 'gex-es-levels');
    const footprintAndGex = submission('footprint-es-5m', 'gex-es-levels');
    const domLadder = submission('dom-ladder-es');
    const blank = submission('blank-uniform');

    const matrix: readonly TimingInput[] = [
      {
        proposed: TIMING.now,
        triggerLevel: volumeProfileAndGex.trigger(PRICE.volumeProfileValueAreaHigh),
        images: volumeProfileAndGex.images,
      },
      {
        proposed: TIMING.now,
        triggerLevel: volumeProfileAndGex.trigger(PRICE.gexZeroGamma),
        images: volumeProfileAndGex.images,
      },
      {
        proposed: TIMING.now,
        triggerLevel: footprintAndGex.trigger(PRICE.footprintImbalance),
        images: footprintAndGex.images,
      },
      {
        proposed: TIMING.onBreak,
        triggerLevel: domLadder.trigger(PRICE.domAbsorption),
        images: domLadder.images,
      },
      {
        proposed: TIMING.onRetest,
        triggerLevel: domLadder.trigger(PRICE.domAbsorption),
        images: domLadder.images,
      },
      {
        proposed: TIMING.onRetest,
        triggerLevel: footprintAndGex.trigger(PRICE.footprintImbalance),
        images: footprintAndGex.images,
      },
      { proposed: TIMING.wait, triggerLevel: null, images: blank.images },
      {
        proposed: TIMING.now,
        triggerLevel: null,
        images: withoutReportedPrice(footprintAndGex.images),
      },
    ];

    const first = matrix.map((input) => decideTiming(input));

    expect(first.map((decision) => decision.timing)).toEqual([
      TIMING.now,
      TIMING.wait,
      TIMING.wait,
      TIMING.onBreak,
      TIMING.wait,
      TIMING.onRetest,
      TIMING.wait,
      TIMING.wait,
    ]);

    for (let run = 0; run < 50; run += 1) {
      expect(matrix.map((input) => decideTiming(input))).toEqual(first);
    }
  });
});

