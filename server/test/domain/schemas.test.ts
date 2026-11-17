/**
 * Suite for the schemas every model answer passes through before any mapping runs.
 *
 * The two answer lines and the response document are where a vocabulary or shape violation is
 * caught, so this suite drives the real recorded answers through them: one full chat-completions
 * envelope per screenshot, whose answer line is read by `recordedAnswerLine`, parsed and then
 * validated. The document is driven from a factory written here rather than produced through the
 * orchestration path, so nothing in the suite needs a provider, a store, a prompt or a network
 * connection, and the caps, the taxonomy, the code maps and the disclaimer arrive from
 * `@trade-read/shared` instead of being restated a second time.
 *
 * Both halves matter equally, and every rejection states why it happened: a rejected line is
 * asserted to be rejected at the field that broke it, so a schema that rejected everything would
 * fail here rather than pass.
 *
 * Two recorded synthesis answers — `unmatched-price` and `single-source` — are deliberately
 * schema-valid. Rule 2 and rule 3 are domain downgrades applied after mapping, never schema
 * failures, so a schema that rejected them would turn a legitimate `200` with `NO_TRADE`/`WAIT`
 * into a `502`.
 */

import { describe, expect, it } from 'vitest';
import type { ZodSafeParseResult } from 'zod';

import {
  CONFIDENCE_CODE_TO_CONFIDENCE,
  CONFIDENCE_CODES,
  CONTEXT_MAX_CHARS,
  DISCLAIMER,
  EXTRACTION_CODE_TO_LEVEL_TYPE,
  INSTRUMENT_MAX_CHARS,
  LEVEL_TYPES,
  OBSERVATION_MAX_CHARS,
  SIDE_CODE_TO_SIDE,
  SUMMARY_MAX_CHARS,
  SYNTHESIS_SIDE_CODES,
  SYNTHESIS_TIMING_CODES,
  TIMING_CODE_TO_TIMING,
  type AnalysisDocument,
  type AnalysisImage,
  type Level,
} from '@trade-read/shared';

import {
  analysisDocumentSchema,
  analysisRequestFieldsSchema,
  extractionAnswerSchema,
  synthesisAnswerSchema,
} from '../../src/domain/schemas.js';
import type {
  ExtractionAnswer,
  ExtractionReadability,
  SynthesisAnswer,
} from '../../src/ports/vision-provider.js';
import {
  RECORDED_EXTRACTION_STEMS,
  RECORDED_SYNTHESIS_SCENARIOS,
  recordedAnswerLine,
  recordedExtraction,
  recordedSynthesis,
  type RecordedExtractionStem,
  type RecordedSynthesisScenario,
} from '../helpers/recorded.js';

// The recorded answers, parsed exactly as the provider adapter parses them: the envelope's answer
// line, read as JSON, then validated by the schema under test. Every positive case below is built
// from one of these, so no case asserts against an answer this suite invented.

/**
 * The two values the extraction's readability field may hold, declared over the port's own union so
 * a change to that union stops this build rather than letting the assertion drift.
 */
const READABILITY_VALUES: readonly ExtractionReadability[] = ['OK', 'BLANK'];

/** The one recorded scenario that carries codes outside the vocabulary, so it is not a clean answer. */
const OUT_OF_VOCABULARY_SCENARIO: RecordedSynthesisScenario = 'out-of-vocabulary';

/**
 * The recorded synthesis scenarios a conforming schema must accept: every one but the
 * out-of-vocabulary answer. `unmatched-price` and `single-source` belong here because rules 2 and 3
 * are downgrades the domain applies after mapping, not schema failures — rejecting either would
 * turn a valid `NO_TRADE`/`WAIT` result into a `502`.
 */
const CLEAN_SYNTHESIS_SCENARIOS: readonly RecordedSynthesisScenario[] =
  RECORDED_SYNTHESIS_SCENARIOS.filter((scenario) => scenario !== OUT_OF_VOCABULARY_SCENARIO);

/** One extraction answer, the object `extractionAnswerSchema` is expected to admit. */
/**
 * The recorded answers the shape and cap cases are built from: the footprint screenshot's extraction,
 * which carries more level pairs than the other four, and the long synthesis.
 */
const FIXTURE_STEM: RecordedExtractionStem = 'footprint-es-5m';
const FIXTURE_SCENARIO: RecordedSynthesisScenario = 'long';

/** One extraction answer, the object `extractionAnswerSchema` is expected to admit. */
function extractionAnswer(stem: RecordedExtractionStem): ExtractionAnswer {
  return extractionAnswerSchema.parse(JSON.parse(recordedAnswerLine(recordedExtraction(stem))));
}

/** One synthesis answer, the object `synthesisAnswerSchema` is expected to admit. */
function synthesisAnswer(scenario: RecordedSynthesisScenario): SynthesisAnswer {
  return synthesisAnswerSchema.parse(JSON.parse(recordedAnswerLine(recordedSynthesis(scenario))));
}

/**
 * The recorded extraction answer as a plain record, so a negative case can replace a single field
 * with something the schema must refuse without annotating the broken value as a valid answer.
 */
function extractionFields(stem: RecordedExtractionStem = FIXTURE_STEM): Record<string, unknown> {
  return { ...extractionAnswer(stem) };
}

/** The recorded synthesis answer as a plain record, for the same reason. */
function synthesisFields(scenario: RecordedSynthesisScenario = FIXTURE_SCENARIO): Record<string, unknown> {
  return { ...synthesisAnswer(scenario) };
}

/**
 * `text` padded with `x` to exactly `length` characters. Throws when the recorded text is already at
 * or past that length, so a cap case can never pass on a string it did not build to that size.
 */
function paddedTo(text: string, length: number): string {
  if (text.length >= length) {
    throw new Error(
      `The recorded text is already ${text.length} characters, so it cannot be padded to ${length}.`,
    );
  }
  return text.padEnd(length, 'x');
}

/**
 * The paths of a refused parse's issues, joined with `.` so an assertion can name the field that
 * broke. Asserts the parse was refused first, so no caller can read issue paths off a success.
 */
function rejectedPaths(result: ZodSafeParseResult<unknown>): readonly string[] {
  expect(result.success, 'the schema must refuse this value').toBe(false);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.path.map(String).join('.'));
}

/** Whether one of `paths` names `field` itself or something nested beneath it. */
function namesField(paths: readonly string[], field: string): boolean {
  return paths.some((path) => path === field || path.startsWith(`${field}.`));
}

// The document factory. Its ids are readable strings rather than the server's UUIDs because an id's
// shape is the routes' and the store's concern: the document schema compares ids for equality and
// never parses one.

const FOOTPRINT_IMAGE_ID = 'image-footprint-primary';
const GEX_IMAGE_ID = 'image-gex-primary';
const ENTRY_LEVEL_ID = 'level-footprint-imb';
const INVALIDATION_LEVEL_ID = 'level-gex-positive-gamma';

/** The price the recorded footprint answer reports for the imbalance, reported on a level and nowhere else. */
const ENTRY_PRICE = 5842.75;

/** The price the recorded gamma-exposure answer reports for the positive-gamma strike. */
const INVALIDATION_PRICE = 5840;

/**
 * A complete analysis document: the create response and the persisted record, field for field as
 * the contract states it.
 *
 * The annotation is the point of the factory. Every field the contract declares is present here or
 * the build stops, so a document the schema accepts cannot be one that is merely shaped like an
 * analysis. Every code and every level type is taken from the shared vocabulary's own translation
 * tables, and the recommendation holds level references only — no price exists on it, which is the
 * invariant `analysisDocumentSchema` enforces and the suite then asserts structurally.
 */
function validDocument(): AnalysisDocument {
  return {
    analysisId: '0b9d2f74-5c18-4a2e-9d31-6f80c7a45e12',
    createdAt: '2024-05-01T13:45:00.000Z',
    instrument: 'ES',
    context: '',
    images: [
      {
        imageId: FOOTPRINT_IMAGE_ID,
        fileName: 'footprint-es-5m.png',
        contentType: 'image/png',
        byteSize: 128_540,
        width: 1440,
        height: 900,
        status: 'ANALYZED',
      },
      {
        imageId: GEX_IMAGE_ID,
        fileName: 'gex-es-levels.png',
        contentType: 'image/png',
        byteSize: 96_312,
        width: 1440,
        height: 900,
        status: 'ANALYZED',
      },
    ],
    levels: [
      {
        levelId: ENTRY_LEVEL_ID,
        price: ENTRY_PRICE,
        type: EXTRACTION_CODE_TO_LEVEL_TYPE.IMB,
        imageId: FOOTPRINT_IMAGE_ID,
      },
      {
        levelId: INVALIDATION_LEVEL_ID,
        price: INVALIDATION_PRICE,
        type: EXTRACTION_CODE_TO_LEVEL_TYPE.GPG,
        imageId: GEX_IMAGE_ID,
      },
    ],
    recommendation: {
      side: SIDE_CODE_TO_SIDE.LONG,
      timing: TIMING_CODE_TO_TIMING.RETEST,
      triggerLevelId: ENTRY_LEVEL_ID,
      entryLevelId: ENTRY_LEVEL_ID,
      invalidationLevelId: INVALIDATION_LEVEL_ID,
      targetLevelIds: [],
      confidence: CONFIDENCE_CODE_TO_CONFIDENCE.M,
      summary: 'Retest long from the footprint imbalance, invalidated at the positive-gamma strike.',
    },
    rationale: [
      {
        claim: 'The footprint imbalance is the level a retest enters from.',
        imageId: FOOTPRINT_IMAGE_ID,
        levelIds: [ENTRY_LEVEL_ID],
      },
      {
        claim: 'The positive-gamma strike invalidates the read.',
        imageId: GEX_IMAGE_ID,
        levelIds: [INVALIDATION_LEVEL_ID],
      },
    ],
    assumptions: [],
    modelUsage: {
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      promptVersion: 'extraction@1;synthesis@1',
      imageCallCount: 2,
      synthesisCompletionTokens: 118,
      latencyMs: 7431,
    },
    disclaimer: DISCLAIMER,
  };
}

/** The factory document's first image, which every image-property case starts from. */
function firstImage(document: AnalysisDocument): AnalysisImage {
  const [image] = document.images;
  if (image === undefined) {
    throw new Error('The factory document must carry at least one image.');
  }
  return image;
}

/** The factory document's first level, which every level-property case starts from. */
function firstLevel(document: AnalysisDocument): Level {
  const [level] = document.levels;
  if (level === undefined) {
    throw new Error('The factory document must carry at least one level.');
  }
  return level;
}

/**
 * Apply one change to an isolated copy of the factory document and hand the result back as the
 * untyped value `safeParse` takes.
 *
 * A change may return something the `AnalysisDocument` type forbids — a status the contract does not
 * have, a price on the recommendation — and that is exactly what these cases need to hand the
 * schema. The copy keeps a change that mutates in place from reaching the next case.
 */
function mutation(change: (document: AnalysisDocument) => unknown): unknown {
  return change(structuredClone(validDocument()));
}

describe('recorded extraction answers', () => {
  it.each(RECORDED_EXTRACTION_STEMS)('accepts the recorded %s answer unchanged', (stem) => {
    const recorded: Record<string, unknown> = JSON.parse(
      recordedAnswerLine(recordedExtraction(stem)),
    );
    const answer = extractionAnswer(stem);

    expect(Object.keys(recorded).sort()).toEqual(['l', 'o', 'r']);
    expect(answer.l).toEqual(recorded.l);
    expect(answer.o).toBe(recorded.o);
    expect(answer.r).toBe(recorded.r);
    expect(READABILITY_VALUES).toContain(answer.r);
  });
});

describe('recorded synthesis answers', () => {
  it.each(CLEAN_SYNTHESIS_SCENARIOS)('accepts the recorded %s answer unchanged', (scenario) => {
    const recorded: Record<string, unknown> = JSON.parse(
      recordedAnswerLine(recordedSynthesis(scenario)),
    );
    const answer = synthesisAnswer(scenario);

    expect(Object.keys(recorded).sort()).toEqual(['c', 'e', 'k', 's', 'src', 't', 'w', 'x']);
    expect(answer).toEqual(recorded);
    expect(SYNTHESIS_SIDE_CODES).toContain(answer.s);
    expect(SYNTHESIS_TIMING_CODES).toContain(answer.t);
    expect(CONFIDENCE_CODES).toContain(answer.c);
  });

  it('counts every recorded scenario but the out-of-vocabulary one as clean', () => {
    expect(CLEAN_SYNTHESIS_SCENARIOS).toHaveLength(RECORDED_SYNTHESIS_SCENARIOS.length - 1);
    expect(CLEAN_SYNTHESIS_SCENARIOS).toContain('unmatched-price');
    expect(CLEAN_SYNTHESIS_SCENARIOS).toContain('single-source');
  });

  it('refuses the out-of-vocabulary answer at the two codes and nothing else', () => {
    const recorded: Record<string, unknown> = JSON.parse(
      recordedAnswerLine(recordedSynthesis(OUT_OF_VOCABULARY_SCENARIO)),
    );

    // The fixture carries codes outside both vocabularies; that is what makes it the case rather than
    // a schema that refuses a well-formed answer for some other reason.
    expect(String(recorded.s)).toBe('MAYBE');
    expect(String(recorded.t)).toBe('SOON');

    const paths = rejectedPaths(synthesisAnswerSchema.safeParse(recorded));

    // Exactly the two code fields, so the refusal is the vocabulary rather than something incidental
    // about the rest of the line.
    expect([...paths].sort()).toEqual(['s', 't']);
  });
});

describe('extraction answer caps', () => {
  it('refuses an observation one character past the cap and accepts one exactly at it', () => {
    const fields = extractionFields();
    const recordedObservation = String(fields.o);

    const atCap = { ...fields, o: paddedTo(recordedObservation, OBSERVATION_MAX_CHARS) };
    const pastCap = { ...fields, o: paddedTo(recordedObservation, OBSERVATION_MAX_CHARS + 1) };

    const accepted = extractionAnswerSchema.parse(atCap);
    expect(accepted.o).toHaveLength(OBSERVATION_MAX_CHARS);
    // The recorded line is a prefix of the padded one, so the evidence token the timing decision
    // reads survives: the cap is a conformance rule and the observation is never truncated for it.
    expect(accepted.o.startsWith(recordedObservation)).toBe(true);

    expect(rejectedPaths(extractionAnswerSchema.safeParse(pastCap))).toEqual(['o']);
  });
});

describe('synthesis answer caps', () => {
  it('refuses a summary one character past the cap and accepts one exactly at it', () => {
    const fields = synthesisFields();
    const recordedSummary = String(fields.w);

    const atCap = { ...fields, w: paddedTo(recordedSummary, SUMMARY_MAX_CHARS) };
    const pastCap = { ...fields, w: paddedTo(recordedSummary, SUMMARY_MAX_CHARS + 1) };

    const accepted = synthesisAnswerSchema.parse(atCap);
    expect(accepted.w).toHaveLength(SUMMARY_MAX_CHARS);

    expect(rejectedPaths(synthesisAnswerSchema.safeParse(pastCap))).toEqual(['w']);
  });
});

describe('extraction answer shape', () => {
  it('refuses a line whose level list, code, price or readability is malformed', () => {
    const fields = extractionFields();
    const [firstPair] = extractionAnswer(FIXTURE_STEM).l;
    if (firstPair === undefined) {
      throw new Error('The recorded footprint answer must carry at least one level pair.');
    }
    const [firstPrice, firstCode] = firstPair;

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly answer: Record<string, unknown>;
      readonly field: string;
    }> = [
      {
        name: 'a level code outside the taxonomy',
        answer: { ...fields, l: [[firstPrice, 'XX']] },
        field: 'l',
      },
      {
        name: 'a price written as a string',
        answer: { ...fields, l: [[String(firstPrice), firstCode]] },
        field: 'l',
      },
      {
        name: 'a readability outside OK and BLANK',
        answer: { ...fields, r: 'MAYBE' },
        field: 'r',
      },
      {
        name: 'no readability field at all',
        answer: { l: fields.l, o: fields.o },
        field: 'r',
      },
      {
        name: 'a level list that is not a list',
        answer: { ...fields, l: firstPrice },
        field: 'l',
      },
    ];

    for (const { name, answer, field } of cases) {
      const result = extractionAnswerSchema.safeParse(answer);
      expect(result.success, `${name} must be refused`).toBe(false);
      expect(namesField(rejectedPaths(result), field), `${name} must be refused at "${field}"`).toBe(
        true,
      );
    }
  });
});

describe('synthesis answer shape', () => {
  it('refuses a line whose targets, sources, entry price or side is malformed', () => {
    const fields = synthesisFields();

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly answer: Record<string, unknown>;
      readonly field: string;
    }> = [
      {
        name: 'targets that are not a list',
        answer: { ...fields, k: ENTRY_PRICE },
        field: 'k',
      },
      {
        name: 'source ids that are not a list',
        answer: { ...fields, src: FOOTPRINT_IMAGE_ID },
        field: 'src',
      },
      {
        name: 'an entry price written as a string',
        answer: { ...fields, e: String(fields.e) },
        field: 'e',
      },
      {
        name: 'no side field at all',
        answer: {
          t: fields.t,
          e: fields.e,
          x: fields.x,
          k: fields.k,
          c: fields.c,
          src: fields.src,
          w: fields.w,
        },
        field: 's',
      },
    ];

    for (const { name, answer, field } of cases) {
      const result = synthesisAnswerSchema.safeParse(answer);
      expect(result.success, `${name} must be refused`).toBe(false);
      expect(namesField(rejectedPaths(result), field), `${name} must be refused at "${field}"`).toBe(
        true,
      );
    }
  });
});

describe('the analysis document', () => {
  it('accepts the factory document and keeps every price out of the recommendation', () => {
    const document = analysisDocumentSchema.parse(validDocument());

    expect(document).toEqual(validDocument());

    // Rule 1, structurally: the read refers to levels by id, so no field of it can hold a price.
    const recommendationValues = Object.values(document.recommendation);
    expect(recommendationValues.length).toBeGreaterThan(0);
    expect(recommendationValues.every((value) => typeof value !== 'number')).toBe(true);

    // The price exists, and it exists on the level the recommendation points at.
    expect(document.levels.map((level) => level.price)).toContain(ENTRY_PRICE);
    expect(document.recommendation.entryLevelId).toBe(ENTRY_LEVEL_ID);
  });

  it('refuses a recommendation that carries a price under any name', () => {
    for (const key of ['entryPrice', 'entry']) {
      const result = analysisDocumentSchema.safeParse(
        mutation(
          (document) =>
            ({
              ...document,
              recommendation: { ...document.recommendation, [key]: ENTRY_PRICE },
              // The one deliberate cast in this suite: a price on the read is a shape the
              // `Recommendation` type makes impossible to write, so the copy has to be forced
              // through the document type to reach the schema that must refuse it.
            }) as unknown as AnalysisDocument,
        ),
      );

      expect(result.success, `a recommendation carrying "${key}" must be refused`).toBe(false);
      expect(namesField(rejectedPaths(result), 'recommendation')).toBe(true);
    }
  });

  it('refuses any disclaimer but the fixed sentence, and the factory carries that sentence', () => {
    expect(validDocument().disclaimer).toBe(DISCLAIMER);

    const nearMisses: ReadonlyArray<readonly [string, string]> = [
      ['a lower-cased sentence', DISCLAIMER.toLowerCase()],
      ['a sentence missing its final word', DISCLAIMER.replace(/\s+\S+$/, '')],
      ['a sentence missing its final character', DISCLAIMER.slice(0, -1)],
    ];

    for (const [name, disclaimer] of nearMisses) {
      expect(disclaimer, `${name} must differ from the fixed sentence`).not.toBe(DISCLAIMER);

      const result = analysisDocumentSchema.safeParse(
        mutation((document) => ({ ...document, disclaimer })),
      );

      expect(result.success, `${name} must be refused`).toBe(false);
      expect(rejectedPaths(result)).toEqual(['disclaimer']);
    }
  });

  it('refuses an image status outside the contract and a foreign model provider', () => {
    const withUnknownStatus = analysisDocumentSchema.safeParse(
      mutation((document) => ({
        ...document,
        images: [{ ...firstImage(document), status: 'OK' }],
      })),
    );
    expect(withUnknownStatus.success, 'a status outside the contract must be refused').toBe(false);
    expect(namesField(rejectedPaths(withUnknownStatus), 'images')).toBe(true);

    const withForeignProvider = analysisDocumentSchema.safeParse(
      mutation((document) => ({
        ...document,
        modelUsage: { ...document.modelUsage, provider: 'openai' },
      })),
    );
    expect(withForeignProvider.success, 'a provider other than the one used must be refused').toBe(
      false,
    );
    expect(rejectedPaths(withForeignProvider)).toEqual(['modelUsage.provider']);
  });

  it('refuses an unreadable image that carries no reason, and a read image that carries one', () => {
    // The two statuses are a discriminated union rather than one shape with an optional field, so
    // the reason travels only with the unreadable case in both directions.
    const unreadableWithoutReason = analysisDocumentSchema.safeParse(
      mutation((document) => ({
        ...document,
        images: [{ ...firstImage(document), status: 'UNREADABLE' }],
      })),
    );
    expect(
      unreadableWithoutReason.success,
      'an unreadable image with no reason must be refused',
    ).toBe(false);
    expect(namesField(rejectedPaths(unreadableWithoutReason), 'images')).toBe(true);

    const analyzedWithReason = analysisDocumentSchema.safeParse(
      mutation((document) => ({
        ...document,
        images: [
          { ...firstImage(document), status: 'ANALYZED', extractionError: 'no chart in frame' },
        ],
      })),
    );
    expect(analyzedWithReason.success, 'an analysed image with a reason must be refused').toBe(false);
    expect(namesField(rejectedPaths(analyzedWithReason), 'images')).toBe(true);
  });

  it('refuses a creation time that carries no time of day', () => {
    const dateOnly = analysisDocumentSchema.safeParse(
      mutation((document) => ({ ...document, createdAt: '2024-05-01' })),
    );
    expect(dateOnly.success, 'a date with no time must be refused').toBe(false);
    expect(rejectedPaths(dateOnly)).toEqual(['createdAt']);
  });
});

describe('the level taxonomy', () => {
  it.each(LEVEL_TYPES)('accepts a level of type %s', (levelType) => {
    const result = analysisDocumentSchema.safeParse(
      mutation((document) => ({
        ...document,
        levels: [{ ...firstLevel(document), type: levelType }],
      })),
    );

    expect(result.success, `a level of type "${levelType}" must be accepted`).toBe(true);
  });

  it('refuses a level type outside the taxonomy', () => {
    const result = analysisDocumentSchema.safeParse(
      mutation((document) => ({
        ...document,
        levels: [{ ...firstLevel(document), type: 'SUPPORT' }],
      })),
    );

    expect(result.success, 'a level type outside the taxonomy must be refused').toBe(false);
    expect(rejectedPaths(result)).toEqual(['levels.0.type']);
  });
});

describe('the request fields', () => {
  it('bounds neither text field, and still refuses one that is not text', () => {
    // Decision D12: the INSTRUMENT_MAX_CHARS and CONTEXT_MAX_CHARS caps are a clamp applied by the
    // analysis service, not a schema bound, because the closed error table holds no code for an
    // over-long value. A maxLength here would reject a request the error table never authorised
    // rejecting.
    const instrument = 'i'.repeat(INSTRUMENT_MAX_CHARS + 1);
    const context = 'c'.repeat(CONTEXT_MAX_CHARS + 1);

    const fields = analysisRequestFieldsSchema.parse({ instrument, context });
    expect(fields.instrument).toHaveLength(INSTRUMENT_MAX_CHARS + 1);
    expect(fields.context).toHaveLength(CONTEXT_MAX_CHARS + 1);

    // Neither field is required: a submission with nothing typed is a valid request.
    expect(analysisRequestFieldsSchema.safeParse({}).success).toBe(true);

    // The type check is real even though neither length is bounded here.
    const numericInstrument = analysisRequestFieldsSchema.safeParse({ instrument: 42 });
    expect(numericInstrument.success, 'a non-text instrument must be refused').toBe(false);
    expect(rejectedPaths(numericInstrument)).toEqual(['instrument']);

    const listContext = analysisRequestFieldsSchema.safeParse({ context: ['ES'] });
    expect(listContext.success, 'a non-text context must be refused').toBe(false);
    expect(rejectedPaths(listContext)).toEqual(['context']);
  });
});
