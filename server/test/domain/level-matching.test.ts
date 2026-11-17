/**
 * Suite for the exact resolution of a cited price to the extracted level it names.
 *
 * One question decides this whole module: does a price the model proposed name a level a submitted
 * image actually reported? A tolerant answer — rounding, a nearest match, an epsilon — would make
 * rule 1 ("no price appears that the model did not report as a level price") unfalsifiable and would
 * pre-empt rule 2, whose entire subject is the price that names nothing (AAP §0.6.2, D6). So every
 * price assertion below is `toBe`/`toEqual` against the literal number the fixture shows: a suite
 * that passes without the near-miss cases has proved nothing about price identity.
 *
 * Five properties are proved here rather than assumed from the module's own description:
 *
 * - **Exact equality, no tolerance.** A price a fraction of a tick above a level resolves to nothing,
 *   and so does the recorded entry price of the unmatched-price answer.
 * - **A deterministic tie-break on a shared price.** Where two images report one price, a level from
 *   an image the read cites wins; otherwise the earlier extracted level, which is the earlier level
 *   of the flattened array. The same call twice returns the same level id.
 * - **A cited price is a reference, not a filter.** A price only a non-cited image reported still
 *   resolves: `src` decides between candidates, never whether a candidate exists.
 * - **Rule 3's measure and rule 7's question.** `distinctImageCount` counts the images behind a set of
 *   level ids, and `isGexOnly` answers over exactly the levels a read cites — false when it cites none.
 * - **A price that names nothing is reported, not estimated.** `matchPrices` and `resolvePrices` hand
 *   the unmatched prices back as the numbers the model gave, so the downgrade rule can name them.
 *
 * Every input is the one the domain receives: committed screenshots' real bytes through the real
 * upload validator, their recorded chat-completions envelopes through the real answer schemas, and the
 * recorded synthesis envelopes through the real mapping. Two image ids are the ones the recorded
 * synthesis answers cite (`RECORDED_SOURCE_IMAGE_IDS`), so `resolvePrices` resolves against a `src`
 * that genuinely names the submitted images instead of a list matching nothing.
 *
 * Two shapes differ from the description this suite was specified from, and the source is followed.
 * `matchPrice` and `matchPrices` take their `{ sourceImageIds }` options object as a required
 * argument, so it is always passed — with an empty list where no read is in play — rather than
 * omitted. `distinctImageCount` and `isGexOnly` are methods on the index that take level ids, not
 * fields of it, which is what lets rule 3 and rule 7 ask about the levels a read cites rather than
 * about every level of the analysis.
 *
 * What this suite does not prove: whether a model reads a price off a chart. Every number here comes
 * from a recorded answer, so what is under test is resolution, never perception.
 */

import { describe, expect, it } from 'vitest';

import {
  EXTRACTION_CODE_TO_LEVEL_TYPE,
  isFootprintLevelType,
  isGexLevelType,
  type LevelType,
} from '@trade-read/shared';

import { mapExtraction, type MappedImage, type MappedLevel } from '../../src/domain/extraction-mapping.js';
import { validateImages } from '../../src/domain/image-validation.js';
import {
  buildLevelIndex,
  distinctImageIds,
  matchLevel,
  matchLevels,
  matchPrice,
  matchPrices,
  resolvePrices,
  type LevelIndex,
} from '../../src/domain/level-matching.js';
import { extractionAnswerSchema, synthesisAnswerSchema } from '../../src/domain/schemas.js';
import { mapSynthesis, type MappedSynthesis } from '../../src/domain/synthesis-mapping.js';
import { screenshotAttachment } from '../helpers/fixtures.js';
import {
  RECORDED_SOURCE_IMAGE_IDS,
  recordedAnswerLine,
  recordedExtraction,
  recordedSynthesis,
  type RecordedExtractionStem,
  type RecordedSynthesisScenario,
} from '../helpers/recorded.js';

/**
 * The id the footprint screenshot is mapped with, taken from the id its recorded synthesis answers
 * cite.
 *
 * Using the recorded ids rather than a label of this suite's own choosing is what keeps a `src` list
 * meaningful: `synthesis-long` cites exactly these two ids, so the tie-break's first key is exercised
 * by the real fixture instead of by a list no level can belong to.
 */
const FOOTPRINT_IMAGE_ID: string = RECORDED_SOURCE_IMAGE_IDS['footprint-es-5m'];

/** The id the gamma-exposure screenshot is mapped with, for the same reason as the footprint id. */
const GEX_IMAGE_ID: string = RECORDED_SOURCE_IMAGE_IDS['gex-es-levels'];

/**
 * The id of a second submission of the same gamma-exposure screenshot.
 *
 * Deliberately distinct from {@link GEX_IMAGE_ID}: two copies of one screenshot are two images to the
 * domain, which is what puts every gamma price on two levels and makes the tie-break observable.
 */
const SECOND_GEX_IMAGE_ID = 'image-gex-es-levels-resubmitted';

/** The id the volume-profile screenshot is mapped with, where a footprint-only read is needed. */
const VOLUME_PROFILE_IMAGE_ID = 'image-volume-profile-es';

/** The images a read like `synthesis-long` rests on, used where a call needs a source list. */
const READ_SOURCE_IMAGE_IDS = [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID] as const;

/** The prices the footprint reading reports, in the order it reports them. */
const FOOTPRINT_PRICES = [5841.25, 5842.0, 5842.75, 5843.5, 5844.25, 5845.0] as const;

/** The prices the gamma-exposure reading reports, in the order it reports them. */
const GEX_PRICES = [5800.0, 5840.0, 5850.0, 5860.0, 5900.0] as const;

/**
 * Maps one recorded extraction the way the analysis service does: the screenshot's real bytes through
 * the real upload validator, the recorded envelope's answer line through the real schema, then the
 * module that turns an answer into levels.
 */
function mapStem(stem: RecordedExtractionStem, imageId: string): MappedImage {
  const [validated] = validateImages([screenshotAttachment(stem)]);

  if (validated === undefined) {
    throw new Error(`Upload validation returned no image for the "${stem}" fixture.`);
  }

  const answer = extractionAnswerSchema.parse(JSON.parse(recordedAnswerLine(recordedExtraction(stem))));

  return mapExtraction({ validated, imageId, answer }).image;
}

/** Maps one recorded synthesis answer through the real schema and the real code translation. */
function mapScenario(scenario: RecordedSynthesisScenario): MappedSynthesis {
  return mapSynthesis(
    synthesisAnswerSchema.parse(JSON.parse(recordedAnswerLine(recordedSynthesis(scenario)))),
  );
}

/**
 * The level one image reports at a price, failing loudly when it reports none.
 *
 * Used to compare a resolution result against the level it must be — by identity, so a resolution that
 * rebuilt an equal-looking level instead of returning the extracted one fails here.
 */
function levelAtPrice(image: MappedImage, price: number): MappedLevel {
  const level = image.levels.find((candidate) => candidate.price === price);

  if (level === undefined) {
    throw new Error(
      `The "${image.fileName}" reading reports no level at ${price}; it reports ${image.levels
        .map((candidate) => candidate.price)
        .join(', ')}.`,
    );
  }

  return level;
}

/**
 * A resolution result narrowed to the level it must have found.
 *
 * `matchPrice` returns a nullable level, and a case that asserted through an optional chain would pass
 * on `null` for every property assertion it makes about the level. This turns "resolved nothing" into
 * a failure that says which price was lost.
 */
function resolved(level: MappedLevel | null, price: number): MappedLevel {
  if (level === null) {
    throw new Error(`No level resolved at ${price}, which the recorded levels do carry.`);
  }

  return level;
}

/** The ids of the levels an index holds whose type satisfies a predicate, in index order. */
function idsWhere(index: LevelIndex, matches: (type: LevelType) => boolean): string[] {
  return index.all().filter((level) => matches(level.type)).map((level) => level.levelId);
}

// The corner-corpus images: the footprint screenshot first, the gamma-exposure screenshot second, in
// the order a submission produces them and therefore in the order the tie-break ranks them.
const footprintImage = mapStem('footprint-es-5m', FOOTPRINT_IMAGE_ID);
const gexImage = mapStem('gex-es-levels', GEX_IMAGE_ID);

/** The one index every resolution in this suite is measured against. */
const cornerIndex = buildLevelIndex([footprintImage, gexImage]);

/**
 * The same gamma-exposure screenshot submitted twice, so every gamma price sits on two levels.
 *
 * Its two images are mapped separately rather than reusing {@link gexImage}, because a second
 * submission is a second image with its own id and its own level ids.
 */
const firstGexCopy = mapStem('gex-es-levels', GEX_IMAGE_ID);
const secondGexCopy = mapStem('gex-es-levels', SECOND_GEX_IMAGE_ID);
const duplicatePriceIndex = buildLevelIndex([firstGexCopy, secondGexCopy]);

/** The duplicate-price index with its images in the opposite order, for the array-order fallback. */
const reversedDuplicatePriceIndex = buildLevelIndex([secondGexCopy, firstGexCopy]);

describe('buildLevelIndex', () => {
  it('flattens the levels in submission order, each image in reported order, and looks each up by id', () => {
    const levels = cornerIndex.all();

    expect(levels).toHaveLength(FOOTPRINT_PRICES.length + GEX_PRICES.length);
    // Submission order decides which image comes first; the extraction's own order is preserved
    // inside each image, because that order is the second tie-break key (D6).
    expect(levels.slice(0, FOOTPRINT_PRICES.length).map((level) => level.price)).toEqual([
      ...FOOTPRINT_PRICES,
    ]);
    expect(levels.slice(FOOTPRINT_PRICES.length).map((level) => level.price)).toEqual([...GEX_PRICES]);
    expect(
      levels.slice(0, FOOTPRINT_PRICES.length).every((level) => level.imageId === FOOTPRINT_IMAGE_ID),
    ).toBe(true);
    expect(
      levels.slice(FOOTPRINT_PRICES.length).every((level) => level.imageId === GEX_IMAGE_ID),
    ).toBe(true);

    // The array is frozen so no caller can append a level no extraction reported.
    expect(Object.isFrozen(levels)).toBe(true);
    expect(cornerIndex.isEmpty()).toBe(false);

    // A lookup returns the level itself, not a copy: a document may reference only the levels an
    // extraction produced, and its price is the number that extraction reported.
    const imbalance = levelAtPrice(footprintImage, 5842.75);
    expect(cornerIndex.byId(imbalance.levelId)).toBe(imbalance);
    expect(cornerIndex.byId(imbalance.levelId)?.price).toBe(5842.75);
    expect(cornerIndex.byId('level-no-extraction-minted')).toBeNull();

    expect(buildLevelIndex([]).isEmpty()).toBe(true);
  });
});

describe('matchPrice', () => {
  it('resolves a cited price to the one level that carries it', () => {
    const imbalance = resolved(matchPrice(cornerIndex, 5842.75, { sourceImageIds: READ_SOURCE_IMAGE_IDS }), 5842.75);
    expect(imbalance.price).toBe(5842.75);
    expect(imbalance.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.IMB);
    expect(imbalance.imageId).toBe(FOOTPRINT_IMAGE_ID);
    expect(imbalance).toBe(levelAtPrice(footprintImage, 5842.75));

    const positiveGamma = resolved(
      matchPrice(cornerIndex, 5840.0, { sourceImageIds: READ_SOURCE_IMAGE_IDS }),
      5840.0,
    );
    expect(positiveGamma.price).toBe(5840.0);
    expect(positiveGamma.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.GPG);
    expect(positiveGamma.imageId).toBe(GEX_IMAGE_ID);
    expect(positiveGamma).toBe(levelAtPrice(gexImage, 5840.0));
  });

  it.each([
    [5842.7501, 'a ten-thousandth of a point above the imbalance'],
    [5842.749999, 'a millionth of a point below the imbalance'],
    [5842.7, 'the imbalance truncated to one decimal place'],
    [5843.0, 'the point of control at 5843.50 truncated to the integer below it'],
    [5849.37, 'the entry price the unmatched-price answer proposes, which no image reports'],
    [5842.75 + 1e-9, 'the imbalance a billionth of a point higher'],
  ])('resolves nothing for %s — %s', (price) => {
    // D6: resolution is exact numeric equality and nothing else. No rounding, no tolerance, no
    // nearest match, so every value in this table — each one a plausible misread of a price the
    // fixtures report — names no level at all. 5842 is deliberately absent: 5842.0 is a price the
    // footprint reading really reports, so it resolves, and a table that expected null for it would
    // be asserting a rounding rule the module must not have.
    expect(matchPrice(cornerIndex, price, { sourceImageIds: READ_SOURCE_IMAGE_IDS })).toBeNull();

    // And nothing resolved can be a price no level carries.
    expect(cornerIndex.all().some((level) => level.price === price)).toBe(false);
  });

  it('resolves a null price to nothing, because a read that cites no price cites no level', () => {
    expect(matchPrice(cornerIndex, null, { sourceImageIds: READ_SOURCE_IMAGE_IDS })).toBeNull();
  });
});

describe('the tie-break between levels sharing a price (D6)', () => {
  it('prefers a level whose image the read cites, then extraction order, then array order', () => {
    // One cited image outranks the position of the level it shares a price with.
    const named = resolved(
      matchPrice(duplicatePriceIndex, 5840.0, { sourceImageIds: [SECOND_GEX_IMAGE_ID] }),
      5840.0,
    );
    expect(named.imageId).toBe(SECOND_GEX_IMAGE_ID);
    expect(named.price).toBe(5840.0);

    // Both copies cited: the first key cannot separate them, so the earlier extracted level wins.
    const bothNamed = resolved(
      matchPrice(duplicatePriceIndex, 5840.0, {
        sourceImageIds: [GEX_IMAGE_ID, SECOND_GEX_IMAGE_ID],
      }),
      5840.0,
    );
    expect(bothNamed.imageId).toBe(GEX_IMAGE_ID);

    // No copy cited: the earlier level of the flattened array wins, which is the same level.
    const noneNamed = resolved(matchPrice(duplicatePriceIndex, 5840.0, { sourceImageIds: [] }), 5840.0);
    expect(noneNamed.imageId).toBe(GEX_IMAGE_ID);
    expect(noneNamed).toBe(bothNamed);
  });

  it('resolves a price only a non-cited image reported, so src ranks candidates and never filters them', () => {
    const callWall = resolved(matchPrice(cornerIndex, 5900.0, { sourceImageIds: [FOOTPRINT_IMAGE_ID] }), 5900.0);

    expect(callWall.price).toBe(5900.0);
    expect(callWall.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.GCW);
    expect(callWall.imageId).toBe(GEX_IMAGE_ID);
  });

  it('returns the same level for the same input, and moves the winner only in the array-order fallback', () => {
    const first = resolved(matchPrice(duplicatePriceIndex, 5840.0, { sourceImageIds: [] }), 5840.0);
    const second = resolved(matchPrice(duplicatePriceIndex, 5840.0, { sourceImageIds: [] }), 5840.0);

    expect(second.levelId).toBe(first.levelId);
    expect(second).toBe(first);

    // Reversing the input array changes only the positional fallback, because the array order is what
    // that fallback is measured against.
    const reversedFallback = resolved(
      matchPrice(reversedDuplicatePriceIndex, 5840.0, { sourceImageIds: [] }),
      5840.0,
    );
    expect(reversedFallback.imageId).toBe(SECOND_GEX_IMAGE_ID);

    // The first key is independent of position: the cited copy still wins in the reversed index.
    const reversedNamed = resolved(
      matchPrice(reversedDuplicatePriceIndex, 5840.0, { sourceImageIds: [GEX_IMAGE_ID] }),
      5840.0,
    );
    expect(reversedNamed.imageId).toBe(GEX_IMAGE_ID);
  });
});

describe('resolvePrices', () => {
  it('resolves every price a directional read cites, and reports none unmatched', () => {
    const synthesis = mapScenario('long');
    const resolvedPrices = resolvePrices(cornerIndex, synthesis);

    expect(synthesis.entryPrice).toBe(5842.75);
    expect(synthesis.invalidationPrice).toBe(5840.0);
    expect(synthesis.targetPrices).toEqual([5845.0, 5900.0]);

    const entry = resolved(resolvedPrices.entry, 5842.75);
    expect(entry.price).toBe(5842.75);
    expect(entry.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.IMB);
    expect(entry.imageId).toBe(FOOTPRINT_IMAGE_ID);
    expect(entry).toBe(levelAtPrice(footprintImage, 5842.75));

    const invalidation = resolved(resolvedPrices.invalidation, 5840.0);
    expect(invalidation.price).toBe(5840.0);
    expect(invalidation.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.GPG);
    expect(invalidation.imageId).toBe(GEX_IMAGE_ID);

    expect(resolvedPrices.targets.map((level) => level.price)).toEqual([5845.0, 5900.0]);
    expect(resolvedPrices.targets.map((level) => level.type)).toEqual([
      EXTRACTION_CODE_TO_LEVEL_TYPE.VAH,
      EXTRACTION_CODE_TO_LEVEL_TYPE.GCW,
    ]);
    expect(resolvedPrices.targets.map((level) => level.imageId)).toEqual([FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID]);
    // A target list keeps the order the read proposed, so a document can present it as written.
    expect(resolvedPrices.targets[0]).toBe(levelAtPrice(footprintImage, 5845.0));

    expect(resolvedPrices.unmatched).toEqual([]);
  });

  it('reports an entry price that names no level while still resolving the rest of the read', () => {
    const synthesis = mapScenario('unmatched-price');
    const resolvedPrices = resolvePrices(cornerIndex, synthesis);

    expect(synthesis.entryPrice).toBe(5849.37);
    expect(resolvedPrices.entry).toBeNull();
    // Rule 2's detection has to name the offending price, so it is reported as the number the model
    // gave rather than dropped or rounded into a match.
    expect(resolvedPrices.unmatched).toEqual([5849.37]);
    expect(resolvedPrices.unmatched[0]).toBe(5849.37);

    // The rest of the read is unaffected: one unresolvable price does not poison its neighbours.
    const invalidation = resolved(resolvedPrices.invalidation, 5840.0);
    expect(invalidation.price).toBe(5840.0);
    expect(invalidation.imageId).toBe(GEX_IMAGE_ID);
    expect(resolvedPrices.targets.map((level) => level.price)).toEqual([5845.0, 5900.0]);
  });

  it('resolves a read that cites no price to nothing, and counts no null price as unmatched', () => {
    const synthesis = mapScenario('no-trade');
    const resolvedPrices = resolvePrices(cornerIndex, synthesis);

    expect(synthesis.entryPrice).toBeNull();
    expect(synthesis.invalidationPrice).toBeNull();
    expect(synthesis.targetPrices).toEqual([]);

    expect(resolvedPrices.entry).toBeNull();
    expect(resolvedPrices.invalidation).toBeNull();
    expect(resolvedPrices.targets).toEqual([]);
    // A read that cites no price is complete and consistent; only a cited price that names no level
    // is a fault, which is why the null avoids the unmatched collection.
    expect(resolvedPrices.unmatched).toEqual([]);
  });

  it('counts the distinct images behind a read, which is the measure rule 3 is stated in', () => {
    const longSynthesis = mapScenario('long');
    const singleSourceSynthesis = mapScenario('single-source');
    const long = resolvePrices(cornerIndex, longSynthesis);
    const singleSource = resolvePrices(cornerIndex, singleSourceSynthesis);

    const longEntry = resolved(long.entry, 5842.75);
    const longInvalidation = resolved(long.invalidation, 5840.0);
    expect(longSynthesis.sourceImageIds).toEqual([FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID]);
    expect(longEntry.imageId).not.toBe(longInvalidation.imageId);
    expect(cornerIndex.distinctImageCount([longEntry.levelId, longInvalidation.levelId])).toBe(2);
    expect(
      cornerIndex.distinctImageCount([
        longEntry.levelId,
        longInvalidation.levelId,
        ...long.targets.map((level) => level.levelId),
      ]),
    ).toBe(2);

    const singleEntry = resolved(singleSource.entry, 5842.75);
    const singleInvalidation = resolved(singleSource.invalidation, 5841.25);
    expect(singleInvalidation.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.VAL);
    expect(singleInvalidation.imageId).toBe(FOOTPRINT_IMAGE_ID);
    expect(cornerIndex.distinctImageCount([singleEntry.levelId, singleInvalidation.levelId])).toBe(1);
    // Every price the single-source answer cites lives on the one image it names, so the count stays
    // 1 even over the whole read — the evidence rule 3 downgrades on.
    expect(singleSourceSynthesis.sourceImageIds).toEqual([FOOTPRINT_IMAGE_ID]);
    expect(
      cornerIndex.distinctImageCount([
        singleEntry.levelId,
        singleInvalidation.levelId,
        ...singleSource.targets.map((level) => level.levelId),
      ]),
    ).toBe(1);

    // An id no level carries contributes no image, so a stale reference cannot inflate the count.
    expect(cornerIndex.distinctImageCount([])).toBe(0);
    expect(cornerIndex.distinctImageCount(['level-no-extraction-minted'])).toBe(0);
  });
});

describe('isGexOnly', () => {
  it('answers over exactly the levels a read cites, and never calls an empty set gamma-only', () => {
    const gexOnlyIndex = buildLevelIndex([gexImage]);
    const gexLevelIds = idsWhere(gexOnlyIndex, isGexLevelType);
    expect(gexLevelIds).toHaveLength(GEX_PRICES.length);
    expect(gexOnlyIndex.isGexOnly(gexLevelIds)).toBe(true);

    // The same gamma levels inside a mixed index stay gamma-only, because the question is about the
    // levels the read references rather than about every level of the analysis.
    expect(cornerIndex.isGexOnly(gexLevelIds)).toBe(true);

    const everyCornerLevelId = cornerIndex.all().map((level) => level.levelId);
    expect(cornerIndex.all().some((level) => isFootprintLevelType(level.type))).toBe(true);
    expect(cornerIndex.isGexOnly(everyCornerLevelId)).toBe(false);

    // A footprint-only read: two screenshots of the same family still rest on no gamma evidence. The
    // volume profile is a footprint reading, and the footprint reading also reports `OTHER` levels, so
    // the family check is "no level here is a gamma level" rather than "every level is footprint".
    const footprintOnlyIndex = buildLevelIndex([
      footprintImage,
      mapStem('volume-profile-es', VOLUME_PROFILE_IMAGE_ID),
    ]);
    expect(footprintOnlyIndex.all().some((level) => isFootprintLevelType(level.type))).toBe(true);
    expect(footprintOnlyIndex.all().filter((level) => isGexLevelType(level.type))).toEqual([]);
    expect(footprintOnlyIndex.isGexOnly(footprintOnlyIndex.all().map((level) => level.levelId))).toBe(false);

    // The convention this module chose for no evidence at all: a set that references no level is not
    // gamma-exposure-only, because the assumption rule 7 records is about evidence a read has.
    expect(buildLevelIndex([]).isGexOnly([])).toBe(false);
    expect(cornerIndex.isGexOnly([])).toBe(false);
    expect(cornerIndex.isGexOnly(['level-no-extraction-minted'])).toBe(false);
  });
});

describe('matchPrices', () => {
  it('reports every cited price that names no level, preserved exactly as proposed', () => {
    const { matched, unmatched } = matchPrices(cornerIndex, [5842.75, 5849.37, 5840.0], {
      sourceImageIds: READ_SOURCE_IMAGE_IDS,
    });

    expect(matched.map((level) => level.price)).toEqual([5842.75, 5840.0]);
    expect(unmatched).toEqual([5849.37]);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toBe(5849.37);

    // Nothing was estimated into the place of the price that named no level.
    expect(matched.some((level) => level.price === 5849.37)).toBe(false);
    expect(cornerIndex.all().some((level) => level.price === 5849.37)).toBe(false);
  });
});

describe('the flattened-level entry points', () => {
  it('applies one exact-equality rule whether the caller holds the index or the levels', () => {
    const reportedPrices: readonly number[] = [...FOOTPRINT_PRICES, ...GEX_PRICES];
    const nearMisses = [5842.7501, 5842.749999, 5842.7, 5849.37, 5842.75 + 1e-9];

    for (const price of [...reportedPrices, ...nearMisses]) {
      const throughIndex = matchPrice(cornerIndex, price, { sourceImageIds: READ_SOURCE_IMAGE_IDS });
      const throughLevels = matchLevel(price, cornerIndex.all(), READ_SOURCE_IMAGE_IDS);

      expect(throughLevels?.levelId ?? null).toBe(throughIndex?.levelId ?? null);
    }

    // Stated once outright, so the loop above cannot pass by both entry points failing alike.
    expect(matchLevel(5842.75, cornerIndex.all(), READ_SOURCE_IMAGE_IDS)).toBe(
      levelAtPrice(footprintImage, 5842.75),
    );
    expect(matchLevel(5849.37, cornerIndex.all(), READ_SOURCE_IMAGE_IDS)).toBeNull();
  });

  it('drops an unmatched price from a target list instead of substituting a level', () => {
    const levels = matchLevels([5845.0, 5849.37, 5900.0], cornerIndex.all(), READ_SOURCE_IMAGE_IDS);

    expect(levels.map((level) => level.price)).toEqual([5845.0, 5900.0]);
    expect(levels.map((level) => level.type)).toEqual([
      EXTRACTION_CODE_TO_LEVEL_TYPE.VAH,
      EXTRACTION_CODE_TO_LEVEL_TYPE.GCW,
    ]);
  });

  it('resolves a repeated price to the one level it names each time', () => {
    const levels = matchLevels([5840.0, 5840.0], duplicatePriceIndex.all(), []);

    expect(levels).toHaveLength(2);
    expect(levels[0]).toBe(levels[1]);
    expect(levels[0]?.levelId).toBe(levelAtPrice(firstGexCopy, 5840.0).levelId);
  });

  it('reports the distinct images behind a set of levels in first-appearance order', () => {
    const footprintLow = levelAtPrice(footprintImage, 5841.25);
    const gexPositiveGamma = levelAtPrice(gexImage, 5840.0);
    const footprintHigh = levelAtPrice(footprintImage, 5845.0);

    // The count rule 3 needs is order-independent; the order is reported so a caller that shows the
    // images behind a read shows them in the order the read's levels were listed.
    expect(distinctImageIds([footprintLow, gexPositiveGamma, footprintHigh])).toEqual([
      FOOTPRINT_IMAGE_ID,
      GEX_IMAGE_ID,
    ]);
    expect(distinctImageIds([gexPositiveGamma, footprintLow])).toEqual([GEX_IMAGE_ID, FOOTPRINT_IMAGE_ID]);
    expect(distinctImageIds([])).toEqual([]);
  });
});
