/**
 * Suite for the passes that decide whether a mapped read survives, driven by answers written here.
 *
 * The recorded synthesis set holds no answer that rests on gamma exposure alone, and it may not grow
 * one — the inventory is closed at its six files — so the read whose every cited level is a
 * gamma-exposure level is built inline below and mapped through `mapSynthesis`, which is the same
 * path a recorded answer takes. Every level is written here too, with fixed image ids, so each case
 * states its own evidence and no fixture stands between the suite and the module.
 *
 * The two downgrade rules are also proved over the recorded envelopes themselves, whose answer lines
 * go through `mapSynthesis` and whose presupposed extraction envelopes supply the levels and the
 * current prices those answers are measured against.
 *
 * The image ids are fixed readable strings because id shape is the routes' and the store's concern,
 * not this module's: a level's image id is compared for equality and never parsed here.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_CODE_TO_CONFIDENCE,
  EXTRACTION_CODE_TO_LEVEL_TYPE,
  SIDE_CODE_TO_SIDE,
  TIMING_CODE_TO_TIMING,
  type ExtractionCode,
  type Level,
} from '@trade-read/shared';

import { applyInvariants, type InvariantInput } from '../../src/domain/invariants.js';
import { mapSynthesis, type SynthesisAnswer } from '../../src/domain/synthesis-mapping.js';
import type { CurrentPriceEvidence } from '../../src/domain/timing.js';
import {
  RECORDED_SOURCE_IMAGE_IDS,
  bindRecordedSources,
  recordedAnswerLine,
  recordedExtraction,
  recordedSynthesis,
  recordedSynthesisSourceStems,
  type RecordedChatCompletion,
  type RecordedExtractionStem,
  type RecordedSourceStem,
  type RecordedSynthesisScenario,
} from '../helpers/recorded.js';

/** One footprint image: a value-area high and low, the two levels a footprint read cites. */
const FOOTPRINT_IMAGE_ID = 'image-footprint-primary';

/** One gamma-exposure image: a positive-gamma strike and the call wall above it. */
const GEX_IMAGE_ID = 'image-gex-primary';

/** A second gamma-exposure image, which is what lets a gamma-only read cite two distinct images. */
const SECOND_GEX_IMAGE_ID = 'image-gex-secondary';

const FOOTPRINT_LEVELS: readonly Level[] = [
  { levelId: 'level-footprint-vah', price: 5845, type: 'FOOTPRINT_VALUE_AREA_HIGH', imageId: FOOTPRINT_IMAGE_ID },
  { levelId: 'level-footprint-val', price: 5840, type: 'FOOTPRINT_VALUE_AREA_LOW', imageId: FOOTPRINT_IMAGE_ID },
];

const GEX_LEVELS: readonly Level[] = [
  { levelId: 'level-gex-positive-gamma', price: 5841, type: 'GEX_POSITIVE_GAMMA_STRIKE', imageId: GEX_IMAGE_ID },
  { levelId: 'level-gex-call-wall', price: 5900, type: 'GEX_CALL_WALL', imageId: GEX_IMAGE_ID },
];

const SECOND_GEX_LEVELS: readonly Level[] = [
  { levelId: 'level-gex-negative-gamma', price: 5860, type: 'GEX_NEGATIVE_GAMMA_STRIKE', imageId: SECOND_GEX_IMAGE_ID },
];

/** A second gamma image reporting the footprint's value-area-high price, so one price sits on two images. */
const SHARED_PRICE_LEVELS: readonly Level[] = [
  { levelId: 'level-gex-zero-gamma', price: 5845, type: 'GEX_ZERO_GAMMA', imageId: SECOND_GEX_IMAGE_ID },
];

/** Every extracted level the cases resolve against, in extraction order. */
const ALL_LEVELS: readonly Level[] = [...FOOTPRINT_LEVELS, ...GEX_LEVELS, ...SECOND_GEX_LEVELS];

describe('applyInvariants', () => {
  it('voids a directional read whose entry price matches no extracted level', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5849.37,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high, invalidated at the positive-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel).toBeNull();
    expect(outcome.invalidationLevel).toBeNull();
    expect(outcome.targetLevels).toEqual([]);
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('5849.37');
  });

  it('voids a directional read whose target price matches no extracted level', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5845,
        x: 5841,
        k: [5900, 5875],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high, targeting the call wall and an unrecorded strike above it.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('5875');
  });

  it('downgrades a read whose entry and invalidation levels sit on one image', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5845,
        x: 5840,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high, invalidated at the value-area low of the same footprint image.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('two distinct images');
    expect(outcome.assumptions[0]).not.toContain('source image ids');
  });

  it('downgrades a read that names a single source image id', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID],
        w: 'Long from the value-area high, invalidated at the positive-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('fewer than two source image ids');
    expect(outcome.assumptions[0]).not.toContain('two distinct images');
  });

  it('names both shortfalls when a read has one image and one source id', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5845,
        x: 5840,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID],
        w: 'Long from the value-area high, invalidated at the value-area low of the same footprint image.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('two distinct images');
    expect(outcome.assumptions[0]).toContain('fewer than two source image ids');
  });

  it('prefers the level whose image the read names when two images share the entry price', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'WAIT',
        e: 5845,
        x: 5840,
        k: [5900],
        c: 'M',
        src: [SECOND_GEX_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the zero-gamma strike, invalidated at the value-area low of the footprint image.',
      }),
      levels: [...ALL_LEVELS, ...SHARED_PRICE_LEVELS],
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.entryLevel?.imageId).toBe(SECOND_GEX_IMAGE_ID);
    expect(outcome.invalidationLevel?.imageId).toBe(FOOTPRINT_IMAGE_ID);
    expect(outcome.assumptions).toEqual([]);
  });

  it('keeps a gamma-only read and records that it rests on gamma exposure alone', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'WAIT',
        e: 5841,
        x: 5860,
        k: [5900],
        c: 'H',
        src: [GEX_IMAGE_ID, SECOND_GEX_IMAGE_ID],
        w: 'Long from the positive-gamma strike, invalidated at the negative-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel?.price).toBe(5841);
    expect(outcome.invalidationLevel?.price).toBe(5860);
    expect(outcome.targetLevels.map((level) => level.price)).toEqual([5900]);
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('gamma-exposure');
  });

  it('records no gamma-exposure assumption when the read cites a footprint level', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'WAIT',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high, invalidated at the positive-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.assumptions).toEqual([]);
  });

  it('records the timing correction as an assumption when the evidence contradicts the proposal', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long on a retest of the value-area high, invalidated at the positive-gamma strike.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [{ imageId: FOOTPRINT_IMAGE_ID, price: 5844.5 }],
      levelsByImage: new Map<string, readonly Level[]>([
        [FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS],
        [GEX_IMAGE_ID, GEX_LEVELS],
      ]),
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('ON_RETEST');
  });

  it('passes a NO_TRADE answer through as a complete result', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'NONE',
        t: 'WAIT',
        e: null,
        x: null,
        k: [],
        c: 'L',
        src: [FOOTPRINT_IMAGE_ID],
        w: 'No directional edge across the supplied levels; waiting for price to reach a level first.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [],
      levelsByImage: new Map<string, readonly Level[]>(),
    });

    expect(outcome).toEqual({
      side: 'NO_TRADE',
      timing: 'WAIT',
      entryLevel: null,
      invalidationLevel: null,
      targetLevels: [],
      assumptions: [],
    });
  });

  it('records WAIT for a NO_TRADE answer whatever timing it proposed', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'NONE',
        t: 'NOW',
        e: null,
        x: null,
        k: [],
        c: 'L',
        src: [],
        w: 'No trade while the chart shows nothing actionable on either image.',
      }),
      levels: ALL_LEVELS,
      currentPrices: [{ imageId: FOOTPRINT_IMAGE_ID, price: 5844.5 }],
      levelsByImage: new Map<string, readonly Level[]>([[FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS]]),
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.assumptions).toEqual([]);
  });
});

// The recorded pairings. Each recorded downgrade answer is measured against the extraction envelopes
// its own `src` names, so the two are read back out of the fixtures rather than restated here.

/** One extraction answer line, narrowed to the two fields a recorded read is measured against. */
interface RecordedExtractionAnswer {
  /** The `[price, code]` pairs the extraction reported, in the order it reported them. */
  readonly pairs: ReadonlyArray<readonly [number, ExtractionCode]>;
  /** The observation the extraction wrote, whose `LAST=` token states that image's current price. */
  readonly observation: string;
}

/** The token every extraction observation opens with when the image reported a current price. */
const CURRENT_PRICE_TOKEN = /^LAST=([0-9.]+)/;

/** The token every extraction observation opens with when the image reported no current price. */
const NO_CURRENT_PRICE_TOKEN = /^LAST=NA\b/;

/** A short description of a value, for the sentences that say what an answer carried instead. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'string') {
    return `the string "${value}"`;
  }
  return `the ${typeof value}`;
}

/** One answer line's fields, admitted only as one line holding a single JSON object. */
function answerFields(source: string, line: string): Record<string, unknown> {
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error(`The recorded ${source} answer must be one line, but it carries a line break.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new Error(`The recorded ${source} answer is not valid JSON.`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The recorded ${source} answer must hold exactly one JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** The finite price at `what`, or a thrown error naming what the answer carried instead. */
function priceAt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what} must be a finite price, but it holds ${describeValue(value)}.`);
  }
  return value;
}

/** The price at `what`, or null where the answer cites none. */
function priceOrNullAt(value: unknown, what: string): number | null {
  return value === null ? null : priceAt(value, what);
}

/** The prices at `what`, in the order the answer cited them. */
function pricesAt(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} must be an array of prices, but it holds ${describeValue(value)}.`);
  }
  return value.map((entry, index) => priceAt(entry, `${what}[${index}]`));
}

/** The non-empty strings at `what`, in the order the answer listed them. */
function stringsAt(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} must be an array of strings, but it holds ${describeValue(value)}.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(
        `${what}[${index}] must be a non-empty string, but it holds ${describeValue(entry)}.`,
      );
    }
    return entry;
  });
}

/** The non-empty sentence at `what`. */
function sentenceAt(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} must be a non-empty sentence, but it holds ${describeValue(value)}.`);
  }
  return value;
}

/**
 * The code at `what`, admitted only where `table` — the single table `shared` owns for that code
 * space — maps it, so no unchecked code reaches a module.
 */
function codeAt<Code extends string, Mapped>(
  table: Readonly<Record<Code, Mapped>>,
  value: unknown,
  what: string,
): Code {
  if (typeof value === 'string' && Object.hasOwn(table, value)) {
    return value as Code;
  }
  throw new Error(
    `${what} must be one of the codes ${Object.keys(table).join(', ')}, but it holds ` +
      `${describeValue(value)}.`,
  );
}

/** One recorded extraction envelope, read as the level pairs and the observation it wrote. */
function recordedExtractionAnswer(stem: RecordedExtractionStem): RecordedExtractionAnswer {
  const source = `extraction-${stem}`;
  const fields = answerFields(source, recordedAnswerLine(recordedExtraction(stem)));

  const { l: reported, o: observation } = fields;
  if (!Array.isArray(reported)) {
    throw new Error(
      `The recorded ${source} answer must carry "l" as an array of [price, code] pairs, but it ` +
        `holds ${describeValue(reported)}.`,
    );
  }
  const pairs = reported.map((entry, index) => {
    const what = `"l[${index}]" of the recorded ${source} answer`;
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${what} must be a [price, code] pair, but it holds ${describeValue(entry)}.`);
    }
    return [
      priceAt(entry[0], `${what}'s price`),
      codeAt(EXTRACTION_CODE_TO_LEVEL_TYPE, entry[1], `${what}'s code`),
    ] as const;
  });

  return { pairs, observation: sentenceAt(observation, `"o" of the recorded ${source} answer`) };
}

/** The current price one extraction observation states, or null where it reports that it read none. */
function currentPriceOf(stem: RecordedExtractionStem, observation: string): number | null {
  const token = CURRENT_PRICE_TOKEN.exec(observation);
  if (token !== null) {
    const price = Number.parseFloat(token[1] ?? '');
    if (!Number.isFinite(price)) {
      throw new Error(`The extraction-${stem} observation states a LAST= value that is not a number.`);
    }
    return price;
  }
  if (NO_CURRENT_PRICE_TOKEN.test(observation)) {
    return null;
  }
  throw new Error(
    `The extraction-${stem} observation must open with LAST=<price> or LAST=NA, but it reads ` +
      `"${observation}".`,
  );
}

/** One recorded synthesis answer line, in the shape `mapSynthesis` takes. */
function recordedSynthesisAnswer(
  scenario: RecordedSynthesisScenario,
  line: string,
): SynthesisAnswer {
  const source = `synthesis-${scenario}`;
  const fields = answerFields(source, line);
  return {
    s: codeAt(SIDE_CODE_TO_SIDE, fields.s, `"s" of the recorded ${source} answer`),
    t: codeAt(TIMING_CODE_TO_TIMING, fields.t, `"t" of the recorded ${source} answer`),
    e: priceOrNullAt(fields.e, `"e" of the recorded ${source} answer`),
    x: priceOrNullAt(fields.x, `"x" of the recorded ${source} answer`),
    k: pricesAt(fields.k, `"k" of the recorded ${source} answer`),
    c: codeAt(CONFIDENCE_CODE_TO_CONFIDENCE, fields.c, `"c" of the recorded ${source} answer`),
    src: stringsAt(fields.src, `"src" of the recorded ${source} answer`),
    w: sentenceAt(fields.w, `"w" of the recorded ${source} answer`),
  };
}

/**
 * One recorded synthesis envelope as the invariants module's own input.
 *
 * The screenshots a read presupposes come from the recording itself — `recordedSynthesisSourceStems`
 * reads them back out of the answer's `src` — and each one is paired with its recorded extraction, so
 * the levels and the current prices are exactly the evidence the answer was recorded against. Each
 * level carries the image id the run would have minted for that screenshot: the recorded id, or the
 * id `bindRecordedSources` rebound it to when a submission's own ids were supplied.
 */
function recordedInvariantInput(
  scenario: RecordedSynthesisScenario,
  envelope: RecordedChatCompletion,
  submittedImageIds: Readonly<Partial<Record<RecordedSourceStem, string>>> = {},
): InvariantInput {
  const answer = recordedSynthesisAnswer(scenario, recordedAnswerLine(envelope));
  const levels: Level[] = [];
  const currentPrices: CurrentPriceEvidence[] = [];
  const levelsByImage = new Map<string, readonly Level[]>();

  for (const stem of recordedSynthesisSourceStems(scenario)) {
    const imageId = submittedImageIds[stem] ?? RECORDED_SOURCE_IMAGE_IDS[stem];
    const extraction = recordedExtractionAnswer(stem);
    const imageLevels: Level[] = extraction.pairs.map(([price, code], index) => ({
      levelId: `${stem}-level-${index + 1}`,
      price,
      type: EXTRACTION_CODE_TO_LEVEL_TYPE[code],
      imageId,
    }));

    levels.push(...imageLevels);
    levelsByImage.set(imageId, imageLevels);
    const currentPrice = currentPriceOf(stem, extraction.observation);
    if (currentPrice !== null) {
      currentPrices.push({ imageId, price: currentPrice });
    }
  }

  const namedSourceIds = new Set(answer.src);
  for (const imageId of levelsByImage.keys()) {
    if (!namedSourceIds.has(imageId)) {
      throw new Error(
        `The recorded synthesis-${scenario} answer does not name "${imageId}", the image its own ` +
          `extraction was paired with, so the read would cite levels from an image it never claims.`,
      );
    }
  }

  return { mapped: mapSynthesis(answer), levels, currentPrices, levelsByImage };
}

describe('rules 2 and 3 over the recorded envelopes', () => {
  it('voids the recorded read whose entry price matches no extracted level', () => {
    const input = recordedInvariantInput('unmatched-price', recordedSynthesis('unmatched-price'));
    const { mapped, levels } = input;
    const levelPrices = levels.map((level) => level.price);

    // The recorded answer decides the case: it names both images it rests on, and its entry matches
    // no level either of them reported, while every other price it cites is one of them.
    expect(mapped.entryPrice).toBe(5849.37);
    expect(new Set(mapped.sourceImageIds).size).toBe(2);
    expect(levelPrices).not.toContain(5849.37);
    for (const cited of [mapped.invalidationPrice, ...mapped.targetPrices]) {
      expect(levelPrices).toContain(cited);
    }

    const outcome = applyInvariants(input);

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel).toBeNull();
    expect(outcome.invalidationLevel).toBeNull();
    expect(outcome.targetLevels).toEqual([]);
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('5849.37');
  });

  it('downgrades the recorded read whose entry and invalidation sit on one image', () => {
    const input = recordedInvariantInput('single-source', recordedSynthesis('single-source'));
    const { mapped, levels } = input;
    const levelPrices = levels.map((level) => level.price);

    // Every price the answer cites is extracted, so the source-sufficiency rule is the one that
    // fires, on the single image id the answer names.
    for (const cited of [mapped.entryPrice, mapped.invalidationPrice, ...mapped.targetPrices]) {
      expect(levelPrices).toContain(cited);
    }
    expect(mapped.sourceImageIds).toHaveLength(1);

    const outcome = applyInvariants(input);

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel).toBeNull();
    expect(outcome.invalidationLevel).toBeNull();
    expect(outcome.targetLevels).toEqual([]);
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('two distinct images');
    expect(outcome.assumptions[0]).toContain('fewer than two source image ids');
  });

  it('decides the same downgrade after the recorded sources are rebound to fresh submitted ids', () => {
    const envelope = recordedSynthesis('unmatched-price');
    const asRecorded = applyInvariants(recordedInvariantInput('unmatched-price', envelope));

    const footprintImageId = randomUUID();
    const gexImageId = randomUUID();
    const submittedImageIds: Readonly<Partial<Record<RecordedSourceStem, string>>> = {
      'footprint-es-5m': footprintImageId,
      'gex-es-levels': gexImageId,
    };
    const rebound = bindRecordedSources(envelope, submittedImageIds);
    // The same id map pairs the rebound answer's sources with the extractions it presupposes, since
    // the recorded ids no longer appear anywhere in the answer.
    const reboundInput = recordedInvariantInput('unmatched-price', rebound, submittedImageIds);

    // The replay path replaces the recorded ids and leaves the prices alone, and the decision the
    // answer earns is the one it earned against the ids it was recorded with.
    expect(reboundInput.mapped.sourceImageIds).toEqual([footprintImageId, gexImageId]);
    expect(reboundInput.mapped.entryPrice).toBe(5849.37);
    expect(applyInvariants(reboundInput)).toEqual(asRecorded);
  });
});
