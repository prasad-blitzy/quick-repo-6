/**
 * Suite for the translation of one extraction answer into the levels, the status and the
 * current-price evidence the rest of the domain reasons about.
 *
 * Four properties of `server/src/domain/extraction-mapping.ts` are contractual, and each is proved
 * here rather than assumed from the module's own description of itself:
 *
 * - **Nothing is invented.** A level's price is the number the extraction reported, exactly — the
 *   recorded prices below are asserted with `toBe` against literals, so a rounded, rescaled or
 *   reformatted value fails here — and a pair whose price cannot be read is dropped and counted,
 *   never repaired (rule 6, AAP §0.6.2).
 * - **The codes are translated, not passed through.** Each level's type is read from
 *   `EXTRACTION_CODE_TO_LEVEL_TYPE`, and no mapped type is ever one of the model's short codes, so
 *   no model vocabulary reaches a client (D4, D10, AAP §0.3.3).
 * - **A reading that yielded nothing is `UNREADABLE`, not an error** (D9): `r: "BLANK"` and, equally,
 *   a chart whose every price was dropped produce that status with a reason, an empty level array
 *   and a drop count that still accounts for what was discarded.
 * - **The current price comes from the observation's `LAST=` token alone** (D8). That token is the
 *   only current-price evidence the build has, and the timing decision downstream is judged against
 *   it, so each image's evidence is asserted here against the price the fixture actually shows.
 *
 * Every input is produced the one way the domain receives one: a committed screenshot's real bytes
 * through the real upload validator, and that screenshot's recorded chat-completions envelope
 * through the real extraction schema. No answer line is written inline and no `ValidatedImage` is
 * hand-built, so a case cannot pass on an input the product path could not produce. The two rule-6
 * cases are the deliberate exception, because the price they hand over is one the schema refuses to
 * express at all — which is precisely the input the mapping has to defend against.
 *
 * What this suite does not prove: whether the model read a chart correctly. That is the live check's
 * question. Everything here is decided from an answer, never from pixels.
 */

import { describe, expect, it } from 'vitest';

import {
  EXTRACTION_CODES,
  EXTRACTION_CODE_TO_LEVEL_TYPE,
  OBSERVATION_MAX_CHARS,
  isFootprintLevelType,
  isGexLevelType,
} from '@trade-read/shared';

import {
  mapExtraction,
  type ExtractionMapResult,
  type MappedImage,
  type MappedLevel,
} from '../../src/domain/extraction-mapping.js';
import { validateImages, type ValidatedImage } from '../../src/domain/image-validation.js';
import { extractionAnswerSchema } from '../../src/domain/schemas.js';
import type { ExtractionAnswer } from '../../src/ports/vision-provider.js';
import { screenshotAttachment } from '../helpers/fixtures.js';
import {
  RECORDED_EXTRACTION_STEMS,
  recordedAnswerLine,
  recordedExtraction,
  type RecordedExtractionStem,
} from '../helpers/recorded.js';

/**
 * The prices the footprint reading reports, in the order it reports them, written out so a mapped
 * price is compared against the number the fixture shows rather than against itself.
 *
 * This is the one list of recorded values the suite restates. It is deliberate: `answer.l` is the
 * input's own copy of the same numbers, so asserting a level against it would pass for any mapping
 * that echoed its input, and rule 6's "never estimated" claim needs a value stated independently.
 */
const FOOTPRINT_PRICES = [5841.25, 5842.0, 5842.75, 5843.5, 5844.25, 5845.0] as const;

/**
 * The current price each recorded reading reports, or `null` for the reading that reports none.
 *
 * Literal for the same reason as {@link FOOTPRINT_PRICES}: D8's timing decision rests on these
 * numbers, so the suite states the value it expects instead of reading it back out of the observation
 * the mapping itself parses.
 */
const LAST_PRICE_BY_STEM: Readonly<Record<RecordedExtractionStem, number | null>> = {
  'footprint-es-5m': 5844.25,
  'gex-es-levels': 5850.0,
  'dom-ladder-es': 5840.0,
  'volume-profile-es': 5847.0,
  'blank-uniform': null,
};

/**
 * The recorded stems as a plain list, so a table-driven case takes one stem per row instead of
 * spreading the tuple the helper declares.
 */
const RECORDED_STEMS: readonly RecordedExtractionStem[] = RECORDED_EXTRACTION_STEMS;

/**
 * The index of the footprint pair whose price the rule-6 cases cannot read: the `IMB` level at
 * 5842.75, chosen because rounding or truncating it lands on a price the reading never reports, which
 * is the difference between dropping the pair and estimating a replacement for it.
 */
const DROPPED_FOOTPRINT_INDEX = 2;

/** The price that pair reports, which no surviving level may carry. */
const DROPPED_FOOTPRINT_PRICE = 5842.75;

/**
 * Values a rounding, truncating or coercing implementation would turn {@link DROPPED_FOOTPRINT_PRICE}
 * into: 5843 for a round to the nearest integer, 5842.8 for one decimal place, 5842.7 for a
 * truncation. Rule 6 forbids each of them, because a level at any of those prices would be a level no
 * image showed, dressed as one it did. None of them is one of the reading's own prices — 5842.0, for
 * instance, is a price the footprint fixture really reports, so it proves nothing either way and is
 * deliberately absent from this list. The list is asserted absent rather than only asserting the
 * dropped pair missing, because "the pair vanished" and "nothing took its place" are different
 * claims and only the second is the rule.
 */
const FORBIDDEN_ESTIMATES = [5843, 5842.8, 5842.7] as const;

/** One mapped reading with the inputs that produced it, so a case can assert the pass-through too. */
interface Mapping {
  /** The part upload validation returned, carrying the geometry and format sniffed from the bytes. */
  readonly validated: ValidatedImage;
  /** The recorded answer as the extraction schema admitted it. */
  readonly answer: ExtractionAnswer;
  /** What the module under test made of the two. */
  readonly result: ExtractionMapResult;
}

/**
 * The id one fixture's image is mapped with.
 *
 * Fixed readable strings rather than minted UUIDs: an id's shape is the routes' and the store's
 * concern, and this module only ever echoes the id it is handed and compares it for equality, so a
 * generated value would add nothing a stable label does not show. The stem is in the label because
 * every case here maps one image and a failure should say which.
 */
function imageIdFor(stem: RecordedExtractionStem): string {
  return `image-${stem}`;
}

/**
 * Maps one recorded reading the way the analysis service does: real fixture bytes through the real
 * upload validator, then the recorded envelope's answer line through the real schema, then the
 * module under test.
 */
function mapOne(stem: RecordedExtractionStem, imageId: string = imageIdFor(stem)): Mapping {
  const [validated] = validateImages([screenshotAttachment(stem)]);

  if (validated === undefined) {
    throw new Error(`Upload validation returned no image for the "${stem}" fixture.`);
  }

  const answer = extractionAnswerSchema.parse(JSON.parse(recordedAnswerLine(recordedExtraction(stem))));

  return { validated, answer, result: mapExtraction({ validated, imageId, answer }) };
}

/**
 * The level at `index`, failing loudly rather than letting an assertion read an absent element —
 * with `noUncheckedIndexedAccess` an indexed read is optional, and a missing level must not be
 * reported as a mismatched one.
 */
function levelAt(image: MappedImage, index: number): MappedLevel {
  const level = image.levels[index];

  if (level === undefined) {
    throw new Error(`The image yielded ${image.levels.length} level(s), so index ${index} is absent.`);
  }

  return level;
}

/** The one level reported at `price`, by exact equality — the same rule a document resolves with. */
function levelAtPrice(image: MappedImage, price: number): MappedLevel {
  const level = image.levels.find((candidate) => candidate.price === price);

  if (level === undefined) {
    throw new Error(
      `No level was reported at ${price}; the image yielded ${image.levels
        .map((candidate) => candidate.price)
        .join(', ')}.`,
    );
  }

  return level;
}

/** The prices of an image's levels, in reported order. */
function pricesOf(image: MappedImage): number[] {
  return image.levels.map((level) => level.price);
}

/**
 * The recorded answer with chosen pairs' prices replaced by values the schema cannot produce.
 *
 * `extractionAnswerSchema` admits finite numbers only, so a `NaN`, an `Infinity` or a numeric string
 * cannot arrive through the parser at all. That is exactly why the mapping defends against them:
 * this cast is the only way to hand the module a price a model could still write, and it is what
 * keeps rule 6's drop rule under test rather than leaving it to the schema above to make it moot.
 */
function withPrices(
  answer: ExtractionAnswer,
  priceFor: (index: number, reported: number) => unknown,
): ExtractionAnswer {
  const l = answer.l.map(([reported, code], index) => [priceFor(index, reported), code]);

  return { ...answer, l } as unknown as ExtractionAnswer;
}

describe('mapExtraction', () => {
  describe('the five kinds of screenshot', () => {
    it('maps the footprint reading level for level, in the order it was reported', () => {
      const { answer, result, validated } = mapOne('footprint-es-5m');
      const { image } = result;

      // Identity comes from the validated part — the name the multipart body carried and the
      // geometry sniffed from the bytes — never from the answer, which knows none of it.
      expect(image.imageId).toBe(imageIdFor('footprint-es-5m'));
      expect(image.fileName).toBe(validated.fileName);
      expect(image.contentType).toBe(validated.contentType);
      expect(image.byteSize).toBe(validated.byteSize);
      expect(image.width).toBe(validated.width);
      expect(image.height).toBe(validated.height);

      expect(image.status).toBe('ANALYZED');
      expect(image.extractionError).toBeUndefined();
      expect(image.levels).toHaveLength(FOOTPRINT_PRICES.length);

      FOOTPRINT_PRICES.forEach((price, index) => {
        const level = levelAt(image, index);
        const pair = answer.l[index];

        if (pair === undefined) {
          throw new Error(`The recorded footprint answer carries no pair at index ${index}.`);
        }

        expect(level.price).toBe(price);
        expect(level.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE[pair[1]]);
        expect(level.imageId).toBe(image.imageId);
      });

      const levelIds = image.levels.map((level) => level.levelId);
      expect(levelIds.every((levelId) => levelId.length > 0)).toBe(true);
      expect(new Set(levelIds).size).toBe(levelIds.length);
      expect(result.droppedLevelCount).toBe(0);
    });

    it('maps the gamma-exposure reading onto the gamma-exposure family', () => {
      const { answer, result } = mapOne('gex-es-levels');
      const { image } = result;

      expect(image.status).toBe('ANALYZED');
      expect(image.levels).toHaveLength(5);

      const types = answer.l.map(([, code]) => EXTRACTION_CODE_TO_LEVEL_TYPE[code]);

      image.levels.forEach((level, index) => {
        const pair = answer.l[index];

        if (pair === undefined) {
          throw new Error(`The recorded gamma-exposure answer carries no pair at index ${index}.`);
        }

        expect(level.price).toBe(pair[0]);
        expect(level.type).toBe(types[index]);
        expect(isGexLevelType(level.type)).toBe(true);
      });

      // Five gamma-exposure codes, five distinct level types: a mapping that collapsed two codes
      // onto one type would keep the level count and lose the distinction the read depends on.
      expect(types.every(isGexLevelType)).toBe(true);
      expect(new Set(types).size).toBe(types.length);
    });

    it('maps the depth-of-market reading, two of whose levels share a type', () => {
      const { answer, result } = mapOne('dom-ladder-es');
      const { image } = result;

      expect(image.status).toBe('ANALYZED');

      expect(levelAtPrice(image, 5840.0).type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.ABS);
      expect(levelAtPrice(image, 5838.0).type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE.LV);

      // Two levels of one type is legal: the ladder reports two undifferentiated prices, and the
      // mapping keeps both rather than deduplicating them into one.
      const others = image.levels.filter((level) => level.type === EXTRACTION_CODE_TO_LEVEL_TYPE.OTH);
      expect(others).toHaveLength(2);
      expect(others.map((level) => level.price)).toEqual([5835.0, 5845.0]);
    });

    it('maps the volume-profile reading onto the footprint family', () => {
      const { answer, result } = mapOne('volume-profile-es');
      const { image } = result;

      expect(image.status).toBe('ANALYZED');
      expect(image.levels).toHaveLength(3);

      image.levels.forEach((level, index) => {
        const pair = answer.l[index];

        if (pair === undefined) {
          throw new Error(`The recorded volume-profile answer carries no pair at index ${index}.`);
        }

        expect(level.price).toBe(pair[0]);
        expect(level.type).toBe(EXTRACTION_CODE_TO_LEVEL_TYPE[pair[1]]);
        expect(isFootprintLevelType(level.type)).toBe(true);
      });
    });
  });

  describe('the current-price evidence', () => {
    // D8: the timing decision is judged against these numbers and nothing else, so the price an
    // image reports as its own current one is asserted against the value the fixture shows rather
    // than against the observation the mapping itself parsed.
    it.each(RECORDED_STEMS)(
      'reports the current price the %s reading states, or none when it states none',
      (stem) => {
        const { result } = mapOne(stem);
        const { currentPrice } = result.image;

        expect(currentPrice.imageId).toBe(result.image.imageId);
        expect(currentPrice.price).toBe(LAST_PRICE_BY_STEM[stem]);
      },
    );

    it.each([
      ['the LAST=NA token', 'LAST=NA no chart content in frame'],
      ['no LAST= token at all', 'absorption holding the bid'],
      ['a value that is not a number', 'LAST=unknown absorption holding the bid'],
    ])('reports no current price for an observation carrying %s', (_label, observation) => {
      const { answer, validated } = mapOne('footprint-es-5m');
      const imageId = imageIdFor('footprint-es-5m');

      const result = mapExtraction({
        validated,
        imageId,
        answer: { ...answer, o: observation },
      });

      // An explicit `null`, not an absent property: "this image reported no current price" has to
      // be representable so the timing decision can tell it apart from a price it was never given.
      expect(result.image.currentPrice).toEqual({ imageId, price: null });
    });
  });

  describe('the observation', () => {
    it.each(RECORDED_STEMS)("passes the %s reading's observation through verbatim", (stem) => {
      const { answer, result } = mapOne(stem);

      expect(result.observation).toBe(answer.o);
    });

    it('clamps an observation longer than the schema allows', () => {
      const { answer, validated } = mapOne('footprint-es-5m');
      const overlong = `${answer.o}${'x'.repeat(OBSERVATION_MAX_CHARS)}`;

      // The schema caps the observation at 80 characters, so this length cannot arrive through the
      // parser; the clamp is the module's own defence and is what keeps an over-long line out of a
      // log. The evidence is still read from the token the full observation opens with.
      const result = mapExtraction({
        validated,
        imageId: imageIdFor('footprint-es-5m'),
        answer: { ...answer, o: overlong },
      });

      expect(result.observation).toHaveLength(OBSERVATION_MAX_CHARS);
      expect(result.observation).toBe(overlong.slice(0, OBSERVATION_MAX_CHARS));
      expect(result.image.currentPrice.price).toBe(LAST_PRICE_BY_STEM['footprint-es-5m']);
    });
  });


  describe('a price that cannot be read (rule 6)', () => {
    it('drops the pair and counts it instead of repairing it', () => {
      const { answer, validated } = mapOne('footprint-es-5m');
      const imageId = imageIdFor('footprint-es-5m');
      const broken = withPrices(answer, (index, reported) =>
        index === DROPPED_FOOTPRINT_INDEX ? Number.NaN : reported,
      );

      const result = mapExtraction({ validated, imageId, answer: broken });
      const prices = pricesOf(result.image);

      expect(result.droppedLevelCount).toBe(1);
      expect(result.image.levels).toHaveLength(FOOTPRINT_PRICES.length - 1);
      expect(prices).toEqual(
        FOOTPRINT_PRICES.filter((_price, index) => index !== DROPPED_FOOTPRINT_INDEX),
      );

      // The dropped price is gone and nothing took its place: no rounded neighbour, no truncated
      // decimal and nothing non-finite. A mapping that estimated instead of dropping fails here.
      expect(prices).not.toContain(DROPPED_FOOTPRINT_PRICE);

      for (const estimate of FORBIDDEN_ESTIMATES) {
        expect(prices).not.toContain(estimate);
      }

      expect(result.image.levels.every((level) => Number.isFinite(level.price))).toBe(true);

      // One unreadable pair leaves five readable ones, so the image is still a chart.
      expect(result.image.status).toBe('ANALYZED');
    });

    it('drops a price that arrived as a string instead of coercing it to a number', () => {
      const { answer, validated } = mapOne('footprint-es-5m');
      const broken = withPrices(answer, (index, reported) =>
        index === DROPPED_FOOTPRINT_INDEX ? String(DROPPED_FOOTPRINT_PRICE) : reported,
      );

      const result = mapExtraction({
        validated,
        imageId: imageIdFor('footprint-es-5m'),
        answer: broken,
      });

      expect(result.droppedLevelCount).toBe(1);
      expect(pricesOf(result.image)).toEqual(
        FOOTPRINT_PRICES.filter((_price, index) => index !== DROPPED_FOOTPRINT_INDEX),
      );
      // `Number('5842.75')` is 5842.75, so a coercing mapping would keep the level and pass a
      // count-of-survivors assertion. The price type is what tells the two apart.
      expect(result.image.levels.some((level) => typeof level.price !== 'number')).toBe(false);
      expect(pricesOf(result.image)).not.toContain(DROPPED_FOOTPRINT_PRICE);
    });
  });

  describe('a reading that yielded no level (D9)', () => {
    it('marks a reading that reported no chart as unreadable and counts no dropped price', () => {
      const { answer, result } = mapOne('blank-uniform');
      const { image } = result;

      expect(answer.r).toBe('BLANK');
      expect(image.status).toBe('UNREADABLE');
      expect((image.extractionError ?? '').length).toBeGreaterThan(0);
      expect(image.levels).toEqual([]);
      expect(result.droppedLevelCount).toBe(0);
      expect(image.currentPrice.price).toBeNull();
    });

    it('discards the pairs a no-chart reading still carried without counting them as dropped', () => {
      const { answer, validated, result: blankReading } = mapOne('blank-uniform');
      const imageId = imageIdFor('blank-uniform');

      // The schema admits an empty list for a `BLANK` reading, but nothing stops a model from
      // reporting prices beside the flag. Handing over pairs anyway is what proves the module
      // discards them rather than trusting the model to have emptied the list.
      const carrying = {
        ...answer,
        l: [
          [5840.0, 'ABS'],
          [5838.0, 'LV'],
        ],
      } as unknown as ExtractionAnswer;

      const result = mapExtraction({ validated, imageId, answer: carrying });

      expect(result.image.status).toBe('UNREADABLE');
      expect(result.image.levels).toEqual([]);
      expect(result.droppedLevelCount).toBe(0);
      expect(result.image.extractionError).toBe(blankReading.image.extractionError);
    });

    it('marks a chart whose every price was dropped as unreadable, saying which cause applied', () => {
      const { answer, validated } = mapOne('volume-profile-es');
      const broken = withPrices(answer, () => Number.NaN);

      const result = mapExtraction({
        validated,
        imageId: imageIdFor('volume-profile-es'),
        answer: broken,
      });
      const { image } = result;

      expect(image.status).toBe('UNREADABLE');
      expect(image.levels).toEqual([]);
      expect(result.droppedLevelCount).toBe(answer.l.length);
      expect((image.extractionError ?? '').length).toBeGreaterThan(0);

      // The reason names the cause the operator can act on, and the two causes are distinct: an
      // image with no chart at all and an image whose prices could not be read are different
      // problems, and the document reports which one happened.
      const noChartReason = mapOne('blank-uniform').result.image.extractionError;
      expect((noChartReason ?? '').length).toBeGreaterThan(0);
      expect(image.extractionError).not.toBe(noChartReason);

      // The observation's evidence survives the level drops: whether the pairs could be read is a
      // question about the levels, not about the current price the image states.
      expect(image.currentPrice.price).toBe(LAST_PRICE_BY_STEM['volume-profile-es']);
    });
  });

  describe('the recorded corpus', () => {
    it.each(RECORDED_STEMS)('keeps one level per reported pair for the %s reading', (stem) => {
      const { answer, result } = mapOne(stem);

      expect(result.droppedLevelCount).toBe(0);
      expect(result.image.levels).toHaveLength(answer.l.length);
      expect(result.image.status).toBe(answer.r === 'BLANK' ? 'UNREADABLE' : 'ANALYZED');

      // D10: the model's vocabulary never leaves the mapping, so no mapped type may be a short code.
      for (const level of result.image.levels) {
        expect((EXTRACTION_CODES as readonly string[]).includes(level.type)).toBe(false);
      }
    });

    it('mints fresh level ids on every call and changes nothing else', () => {
      const first = mapOne('gex-es-levels');
      const second = mapOne('gex-es-levels');

      expect(pricesOf(second.result.image)).toEqual(pricesOf(first.result.image));
      expect(second.result.image.levels.map((level) => level.type)).toEqual(
        first.result.image.levels.map((level) => level.type),
      );
      expect(second.result.observation).toBe(first.result.observation);

      // Ids are minted per call, so two calls never share one; a fixed value cannot be asserted
      // here, and a mapping that reused ids across calls would let one document cite another's level.
      const firstIds = new Set(first.result.image.levels.map((level) => level.levelId));
      const secondIds = second.result.image.levels.map((level) => level.levelId);

      expect(firstIds.size).toBe(first.result.image.levels.length);
      expect(secondIds.some((levelId) => firstIds.has(levelId))).toBe(false);
    });
  });
});

