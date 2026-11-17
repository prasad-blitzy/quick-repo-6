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
 * current prices those answers are measured against. All five recorded answers that reach these passes
 * are then walked as one corpus, so rule 1, the reference shape D7 fixes, the determinism and the
 * authorship of the assumption list are checked on every one of them rather than on a sample.
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
  type Side,
  type Timing,
} from '@trade-read/shared';

import { mapExtraction, type MappedImage } from '../../src/domain/extraction-mapping.js';
import { validateImages } from '../../src/domain/image-validation.js';
import { buildLevelIndex } from '../../src/domain/level-matching.js';
import {
  applyInvariants,
  type InvariantInput,
  type InvariantOutcome,
} from '../../src/domain/invariants.js';
import { extractionAnswerSchema } from '../../src/domain/schemas.js';
import { mapSynthesis, type SynthesisAnswer } from '../../src/domain/synthesis-mapping.js';
import { screenshotAttachment } from '../helpers/fixtures.js';
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

/**
 * One submitted image as the domain carries it, with the fields no rule reads filled in.
 *
 * Only the id, the levels and the reported current price bear on the invariant passes and the timing
 * decision they delegate to, so a case states those and nothing else.
 */
function submittedImage(
  imageId: string,
  levels: readonly Level[],
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

/**
 * The shape every outcome obeys (D7): a non-actionable read names no level at all, and a read that
 * carries a timing other than the wait cites the level that timing was judged against.
 */
function expectActionableOrEmpty(outcome: InvariantOutcome): void {
  if (outcome.side === 'NO_TRADE' || outcome.timing === 'WAIT') {
    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel).toBeNull();
    expect(outcome.invalidationLevel).toBeNull();
    expect(outcome.targetLevels).toEqual([]);
    return;
  }

  expect(outcome.entryLevel).not.toBeNull();
}

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
      images: [],
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
      images: [],
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
      images: [],
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
      images: [],
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
      images: [],
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
        t: 'RETEST',
        e: 5845,
        x: 5840,
        k: [5900],
        c: 'M',
        src: [SECOND_GEX_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the zero-gamma strike, invalidated at the value-area low of the footprint image.',
      }),
      levels: [...ALL_LEVELS, ...SHARED_PRICE_LEVELS],
      // The gamma image reports a current price that sits nearest its own call wall, so no image
      // reaches the trigger and the retest proposal stands: the shared price is what the case tests.
      images: [submittedImage(GEX_IMAGE_ID, GEX_LEVELS, 5890)],
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.timing).toBe('ON_RETEST');
    expect(outcome.entryLevel?.imageId).toBe(SECOND_GEX_IMAGE_ID);
    expect(outcome.invalidationLevel?.imageId).toBe(FOOTPRINT_IMAGE_ID);
    expect(outcome.assumptions).toEqual([]);
  });

  it('keeps a gamma-only read and records that it rests on gamma exposure alone', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5841,
        x: 5860,
        k: [5900],
        c: 'H',
        src: [GEX_IMAGE_ID, SECOND_GEX_IMAGE_ID],
        w: 'Long from the positive-gamma strike, invalidated at the negative-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      // The gamma image's current price sits nearest its call wall rather than the trigger, so the
      // retest proposal stands and this case is decided by the evidence type of the levels it cites.
      images: [submittedImage(GEX_IMAGE_ID, GEX_LEVELS, 5890)],
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.timing).toBe('ON_RETEST');
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
        t: 'RETEST',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high, invalidated at the positive-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      // The footprint image's current price sits nearest its value-area low, so the trigger is not
      // reached and the retest proposal stands on the levels the read cites.
      images: [
        submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5842),
        submittedImage(GEX_IMAGE_ID, GEX_LEVELS, null),
      ],
    });

    expect(outcome.side).toBe('LONG');
    expect(outcome.assumptions).toEqual([]);
  });

  it('voids the side when the evidence contradicts the proposed timing', () => {
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
      images: [
        submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5844.5),
        submittedImage(GEX_IMAGE_ID, GEX_LEVELS, null),
      ],
    });

    // The footprint image's current price sits at the value-area high, so the retest the answer
    // proposes is contradicted; the record keeps one sentence saying which proposal was overruled.
    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel).toBeNull();
    expect(outcome.invalidationLevel).toBeNull();
    expect(outcome.targetLevels).toEqual([]);
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('ON_RETEST');
    // Rule 4 is decided before the gamma-exposure note, so a read its own timing evidence voided
    // carries the correction alone; the note describes the evidence a surviving read cites, and this
    // one cites nothing.
    expect(outcome.assumptions[0]).not.toContain('gamma-exposure');
  });

  it('names each cited price that matches no extracted level in one sentence', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5849.37,
        x: 5846.13,
        k: [5900, 5875],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from a level between the value-area high and the call wall, targeting two strikes.',
      }),
      levels: ALL_LEVELS,
      images: [],
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    for (const price of ['5849.37', '5846.13', '5875']) {
      expect(outcome.assumptions[0]).toContain(price);
    }
    // The one target the levels do carry is not named as a failure.
    expect(outcome.assumptions[0]).not.toContain('5900');
  });

  it('names the reference a directional read leaves out', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'SHORT',
        t: 'RETEST',
        e: 5845,
        x: null,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Short from the value-area high without a level the read is invalidated at.',
      }),
      levels: ALL_LEVELS,
      images: [submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5842)],
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('no invalidation price');
  });

  it('does not count a source image id the analysis does not hold', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, 'image-never-submitted'],
        w: 'Long from the value-area high, invalidated at the positive-gamma strike, targeting the call wall.',
      }),
      levels: ALL_LEVELS,
      images: [],
    });

    // The entry and the invalidation do come from two images, so only the source count is short.
    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('fewer than two source image ids');
    expect(outcome.assumptions[0]).not.toContain('two distinct images');
  });

  it('normalises a side that proposes to wait to the non-actionable state', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'SHORT',
        t: 'WAIT',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Short from the value-area high once price leaves it, invalidated at the positive-gamma strike.',
      }),
      levels: ALL_LEVELS,
      images: [
        submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5844.5),
        submittedImage(GEX_IMAGE_ID, GEX_LEVELS, 5850),
      ],
    });

    // A read that asks to wait is a complete result, so it is recorded as such and nothing about it
    // is explained as a correction.
    expect(outcome).toEqual({
      side: 'NO_TRADE',
      timing: 'WAIT',
      entryLevel: null,
      invalidationLevel: null,
      targetLevels: [],
      assumptions: [],
    });
  });

  it('records the absent current price when that is why a waiting read waits', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'WAIT',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high once price reaches it, invalidated at the positive-gamma strike.',
      }),
      levels: ALL_LEVELS,
      images: [
        submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, null),
        submittedImage(GEX_IMAGE_ID, GEX_LEVELS, null),
      ],
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('current price');
  });

  it('leaves no side without references and no wait with them', () => {
    const voided = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: 5849.37,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from a level neither screenshot reported, invalidated at the positive-gamma strike.',
      }),
      levels: ALL_LEVELS,
      images: [submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5844.5)],
    });
    const waiting = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'WAIT',
        e: 5845,
        x: 5841,
        k: [5900],
        c: 'M',
        src: [FOOTPRINT_IMAGE_ID, GEX_IMAGE_ID],
        w: 'Long from the value-area high once price reaches it, invalidated at the positive-gamma strike.',
      }),
      levels: ALL_LEVELS,
      images: [submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, null)],
    });
    const timed = applyInvariants({
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
      images: [
        submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5842),
        submittedImage(GEX_IMAGE_ID, GEX_LEVELS, 5850),
      ],
    });

    for (const outcome of [voided, waiting, timed]) {
      expectActionableOrEmpty(outcome);
    }
    expect(timed.side).toBe('LONG');
    expect(timed.entryLevel).not.toBeNull();
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
      images: [],
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
      images: [submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5844.5)],
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
 * One recorded screenshot as the analysis service maps it: the fixture's own bytes through the real
 * upload validator, its recorded answer line through the real extraction schema, and `mapExtraction`.
 *
 * The cases below build their readings from the fixtures with their own helpers, so each reading is
 * checked against this path before it is used as evidence: a case can then never be decided on levels
 * or a current price the analysis path would not have produced.
 */
function productionReading(stem: RecordedExtractionStem, imageId: string): MappedImage {
  const [validated] = validateImages([screenshotAttachment(stem)]);
  if (validated === undefined) {
    throw new Error(`Upload validation returned no image for the "${stem}" fixture.`);
  }

  const answer = extractionAnswerSchema.parse(
    JSON.parse(recordedAnswerLine(recordedExtraction(stem))),
  );

  return mapExtraction({ validated, imageId, answer }).image;
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
  const images: MappedImage[] = [];

  for (const stem of recordedSynthesisSourceStems(scenario)) {
    const imageId = submittedImageIds[stem] ?? RECORDED_SOURCE_IMAGE_IDS[stem];
    const extraction = recordedExtractionAnswer(stem);
    const imageLevels: Level[] = extraction.pairs.map(([price, code], index) => ({
      levelId: `${stem}-level-${index + 1}`,
      price,
      type: EXTRACTION_CODE_TO_LEVEL_TYPE[code],
      imageId,
    }));

    const currentPrice = currentPriceOf(stem, extraction.observation);
    // The evidence the case is decided on is checked against the mapping the analysis service applies
    // to the same answer: the prices, the level types and the reported current price must be the ones
    // the production path makes of it.
    const mapped = productionReading(stem, imageId);
    expect(mapped.levels.map((level) => [level.price, level.type])).toEqual(
      imageLevels.map((level) => [level.price, level.type]),
    );
    expect(mapped.currentPrice.price).toBe(currentPrice);

    levels.push(...imageLevels);
    images.push(submittedImage(imageId, imageLevels, currentPrice));
  }

  const namedSourceIds = new Set(answer.src);
  for (const image of images) {
    if (!namedSourceIds.has(image.imageId)) {
      throw new Error(
        `The recorded synthesis-${scenario} answer does not name "${image.imageId}", the image its own ` +
          `extraction was paired with, so the read would cite levels from an image it never claims.`,
      );
    }
  }

  return { mapped: mapSynthesis(answer), levels, images };
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

    // Rule 2 is decided before the source-sufficiency pass, and a voided read is explained once. Had
    // the later pass run first it would have named the missing reference this answer leaves behind —
    // its entry price resolved to nothing — and the read would carry that sentence instead.
    expect(outcome.assumptions[0]).not.toContain('cites no entry price');
    expect(outcome.assumptions[0]).not.toContain('two distinct images');
    expect(outcome.assumptions[0]).not.toContain('source image ids');
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

// Rule 6's count is not this module's to write. `server/src/domain/extraction-mapping.ts` drops a
// reported pair whose price is not a finite number and hands the number dropped onwards, and
// `server/src/domain/document-builder.ts` turns that count into the sentence a document records
// (`droppedLevelAssumption`). Both sit outside this suite's import whitelist and are proved on their
// own paths. What this module decides downstream of the drop is proved below: the dropped pair
// produced no level, so a read citing its price names nothing, is voided, and leaves that price out
// of every reference rather than substituting an estimate for it.

describe('rule 6 — a price the extraction could not read', () => {
  /** The price the recorded footprint reading reports, used as the pair whose own price was unread. */
  const UNREADABLE_PRICE = 5842;

  it('voids a read citing the dropped price and keeps it out of every reference', () => {
    const footprintImageId = RECORDED_SOURCE_IMAGE_IDS['footprint-es-5m'];
    const extraction = recordedExtractionAnswer('footprint-es-5m');
    const levels: Level[] = extraction.pairs
      .filter(([price]) => price !== UNREADABLE_PRICE)
      .map(([price, code], index) => ({
        levelId: `footprint-es-5m-level-${index + 1}`,
        price,
        type: EXTRACTION_CODE_TO_LEVEL_TYPE[code],
        imageId: footprintImageId,
      }));
    const currentPrice = currentPriceOf('footprint-es-5m', extraction.observation);

    // 5841.25 and 5845.00 are levels the reading did keep, so the price the drop removed is the only
    // failure this answer earns. Without rule 2 the same read would also be short of a second source
    // image, which is why the single sentence asserted below is order evidence as well as cause.
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'LONG',
        t: 'RETEST',
        e: UNREADABLE_PRICE,
        x: 5841.25,
        k: [5845],
        c: 'M',
        src: [footprintImageId],
        w: 'Long from the level the reading could not price, invalidated at the value-area low it kept.',
      }),
      levels,
      images: [submittedImage(footprintImageId, levels, currentPrice)],
    });

    expect(levels.map((level) => level.price)).not.toContain(UNREADABLE_PRICE);
    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.entryLevel).toBeNull();
    expect(outcome.invalidationLevel).toBeNull();
    expect(outcome.targetLevels).toEqual([]);
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain(String(UNREADABLE_PRICE));
    expect(outcome.assumptions[0]).not.toContain('fewer than two source image ids');
  });
});

/**
 * The five recorded scenarios whose answers reach these passes, in the order the corpus lists them.
 *
 * `out-of-vocabulary` is absent deliberately: the schema the adapter applies rejects that answer
 * before any mapping runs, so it never arrives here and the conformance suite owns it (D11).
 */
const DECIDED_SCENARIOS = [
  'long',
  'short',
  'no-trade',
  'unmatched-price',
  'single-source',
] as const satisfies readonly RecordedSynthesisScenario[];

/** One recorded directional read the evidence supports, with the side and timing it must keep. */
interface KeptRead {
  /** The recorded scenario. */
  readonly scenario: RecordedSynthesisScenario;
  /** The side the answer takes and no pass overrules. */
  readonly side: Side;
  /** The timing the price evidence supports. */
  readonly timing: Timing;
}

/**
 * The two recorded directional reads that survive every pass.
 *
 * `long` proposes a retest while neither image's own current price sits at the trigger it cites, and
 * `short` proposes `NOW` while the footprint image's current price of 5844.25 does sit at its own
 * 5844.25 level — the trigger — on an image that carries footprint levels, so the evidence supports
 * both. Each names two source images and cites a footprint level, which keeps rule 3 and rule 7
 * quiet.
 */
const KEPT_READS: readonly KeptRead[] = [
  { scenario: 'long', side: 'LONG', timing: 'ON_RETEST' },
  { scenario: 'short', side: 'SHORT', timing: 'NOW' },
];

describe('every recorded scenario', () => {
  it.each(KEPT_READS)('keeps the $scenario read as $side / $timing', ({ scenario, side, timing }) => {
    const outcome = applyInvariants(recordedInvariantInput(scenario, recordedSynthesis(scenario)));

    expect(outcome.side).toBe(side);
    expect(outcome.timing).toBe(timing);
    expect(outcome.entryLevel).not.toBeNull();
    // Nothing was overruled: no missing reference, no source shortfall, no timing correction and no
    // gamma-exposure note.
    expect(outcome.assumptions).toEqual([]);
  });

  it('records the recorded no-trade answer as a complete result rather than a failure', () => {
    // Rule 5: the call answers with a recommendation instead of raising, which is why an error here
    // would surface as an unhandled throw rather than as a caught one. The answer also proves rule 5
    // is decided before rule 3: it names one source image and cites no price, so the later pass would
    // have written a missing-reference sentence had it run first.
    const outcome = applyInvariants(
      recordedInvariantInput('no-trade', recordedSynthesis('no-trade')),
    );

    expect(outcome).toEqual({
      side: 'NO_TRADE',
      timing: 'WAIT',
      entryLevel: null,
      invalidationLevel: null,
      targetLevels: [],
      assumptions: [],
    });
  });

  it.each(DECIDED_SCENARIOS)(
    'records %s as level references and no price of its own',
    (scenario) => {
      const input = recordedInvariantInput(scenario, recordedSynthesis(scenario));
      const index = buildLevelIndex(input.images);
      const outcome = applyInvariants(input);

      // Rule 1: the record is a side, a timing, level references and sentences. No field of it can
      // hold a number, so no price of the read's own can exist.
      expect(Object.values(outcome).every((field) => typeof field !== 'number')).toBe(true);

      // Every reference resolves in the index built from the extractions, at a price one of them
      // reported: nothing is invented, and the level a reference names is the level itself.
      const heldPrices = input.levels.map((level) => level.price);
      const referenced = [outcome.entryLevel, outcome.invalidationLevel, ...outcome.targetLevels];
      for (const level of referenced) {
        if (level === null) {
          continue;
        }
        expect(index.byId(level.levelId)).toBe(level);
        expect(heldPrices).toContain(level.price);
      }
    },
  );

  it.each(DECIDED_SCENARIOS)('records %s with the reference shape D7 fixes', (scenario) => {
    const outcome = applyInvariants(recordedInvariantInput(scenario, recordedSynthesis(scenario)));

    // D7, in the shape this module returns: a non-actionable read names no level and no target,
    // while an actionable one is judged against the level its entry price resolved to, so the
    // trigger and the entry are one reference and the read always arrives with an invalidation.
    expectActionableOrEmpty(outcome);
    if (outcome.side !== 'NO_TRADE') {
      expect(outcome.timing).not.toBe('WAIT');
      expect(outcome.entryLevel).not.toBeNull();
      expect(outcome.invalidationLevel).not.toBeNull();
      for (const target of outcome.targetLevels) {
        expect(target.levelId).not.toBe('');
      }
    }
  });

  it.each(DECIDED_SCENARIOS)(
    'writes the same server-authored assumptions twice for %s',
    (scenario) => {
      const envelope = recordedSynthesis(scenario);
      const first = applyInvariants(recordedInvariantInput(scenario, envelope));
      const second = applyInvariants(recordedInvariantInput(scenario, envelope));

      // D10: the same evidence earns the same sentences on every run, so a stored record can be
      // re-derived and a reviewer can trust the list they read.
      expect(second.assumptions).toEqual(first.assumptions);

      const modelCodes: readonly string[] = [
        ...Object.keys(SIDE_CODE_TO_SIDE),
        ...Object.keys(TIMING_CODE_TO_TIMING),
      ];
      for (const assumption of first.assumptions) {
        // Each entry is a sentence the server wrote: longer than any code token, and never a model
        // code passed through as if it explained itself.
        expect(assumption.length).toBeGreaterThan(20);
        expect(modelCodes).not.toContain(assumption);
      }
    },
  );

  it('earns its assumptions from the recorded causes and writes none otherwise', () => {
    const scenariosWithAssumptions = DECIDED_SCENARIOS.filter(
      (scenario) =>
        applyInvariants(recordedInvariantInput(scenario, recordedSynthesis(scenario))).assumptions
          .length > 0,
    );

    // The sentences are cause-driven rather than decorative: the `no-trade` answer and both surviving
    // directional reads owe no explanation at all, and exactly the two recorded downgrades earn one.
    expect(scenariosWithAssumptions).toEqual(['unmatched-price', 'single-source']);
  });
});

/**
 * The order the passes run in, asserted wherever two passes could both have spoken.
 *
 * Only the first cause a pass finds is recorded, because a later pass cannot be judged against a read
 * an earlier one has already voided. Three of the pairs are proved where their cases already stand:
 * rule 2 before rule 3 in the recorded `unmatched-price` case, rule 5 before rule 3 in the recorded
 * `no-trade` case, and rule 4 before rule 7 in the timing-contradiction case. The remaining pair is
 * decided here, because rule 2 asks about a price and rule 5 about a side, and an answer that takes no
 * side can still cite one.
 */
describe('the pass order', () => {
  it('decides rule 2 before rule 5, so a no-trade answer still explains a price it cannot cite', () => {
    const outcome = applyInvariants({
      mapped: mapSynthesis({
        s: 'NONE',
        t: 'WAIT',
        e: 5849.37,
        x: null,
        k: [],
        c: 'L',
        src: [FOOTPRINT_IMAGE_ID],
        w: 'No trade across the supplied levels while the last trade sits between two of them.',
      }),
      levels: ALL_LEVELS,
      images: [submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_LEVELS, 5844.5)],
    });

    expect(outcome.side).toBe('NO_TRADE');
    expect(outcome.timing).toBe('WAIT');
    expect(outcome.assumptions).toHaveLength(1);
    expect(outcome.assumptions[0]).toContain('5849.37');
  });
});
