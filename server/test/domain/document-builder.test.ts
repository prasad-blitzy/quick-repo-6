/**
 * Suite for the one place an analysis document is assembled, driven by fixtures written here.
 *
 * No other suite reaches `buildAnalysisDocument`: every other domain module is proved through its own
 * passes, and the document is the last of them, so nothing until now exercised the evidence it
 * writes. The fixtures below are plain mapped images and an invariant outcome, in the contract's own
 * shapes, so each case states the evidence it starts from and the claim it expects back. The builder
 * validates its result with `analysisDocumentSchema.parse` before returning, which is why a fixture
 * that departs from the shared contract fails here for the contract's reason rather than for an
 * assertion's.
 *
 * The numbering of the evidence is what these cases exist for. The document lists one entry per level
 * the read cites, so a level an earlier role already named is not a second observation, and the
 * targets that survive that are numbered from one with no gap: a repeated level must not leave the
 * claims reading `Target 2`, `Target 3` with no `Target 1` to find.
 *
 * The image ids and level ids are fixed readable strings because id shape is the routes' and the
 * store's concern, not this module's: an id is compared for equality here and never parsed.
 */

import { describe, expect, it } from 'vitest';

import { DISCLAIMER, type Level } from '@trade-read/shared';

import { getPromptVersion } from '../../src/adapters/prompts/prompt-library.js';
import {
  buildAnalysisDocument,
  type BuildDocumentInput,
} from '../../src/domain/document-builder.js';
import type { MappedImage } from '../../src/domain/extraction-mapping.js';
import type { InvariantOutcome } from '../../src/domain/invariants.js';

/** The footprint screenshot, which reported the entry level and one of the targets. */
const FOOTPRINT_IMAGE_ID = 'image-footprint-primary';
const FOOTPRINT_FILE_NAME = 'footprint-es-5m.png';

/** The gamma-exposure screenshot, which reported the invalidation level and the other target. */
const GEX_IMAGE_ID = 'image-gex-primary';
const GEX_FILE_NAME = 'gex-es-levels.png';

/** A third screenshot, whose extraction reported no readable chart at all. */
const BLANK_IMAGE_ID = 'image-blank-primary';
const BLANK_FILE_NAME = 'blank-uniform.png';

const ENTRY_LEVEL: Level = {
  levelId: 'level-footprint-imbalance',
  price: 5845,
  type: 'FOOTPRINT_IMBALANCE',
  imageId: FOOTPRINT_IMAGE_ID,
};

const INVALIDATION_LEVEL: Level = {
  levelId: 'level-gex-negative-gamma',
  price: 5860,
  type: 'GEX_NEGATIVE_GAMMA_STRIKE',
  imageId: GEX_IMAGE_ID,
};

const VALUE_AREA_HIGH_LEVEL: Level = {
  levelId: 'level-footprint-value-area-high',
  price: 5855,
  type: 'FOOTPRINT_VALUE_AREA_HIGH',
  imageId: FOOTPRINT_IMAGE_ID,
};

const CALL_WALL_LEVEL: Level = {
  levelId: 'level-gex-call-wall',
  price: 5900,
  type: 'GEX_CALL_WALL',
  imageId: GEX_IMAGE_ID,
};

/** The claim the entry level earns, which is the wording this suite holds the builder to. */
const ENTRY_CLAIM = `Entry is the FOOTPRINT_IMBALANCE level from ${FOOTPRINT_FILE_NAME}.`;

/** The claim the invalidation level earns. */
const INVALIDATION_CLAIM = `Invalidation is the GEX_NEGATIVE_GAMMA_STRIKE level from ${GEX_FILE_NAME}.`;

/** The reason an image carries when its extraction reported no chart. */
const BLANK_REASON = 'The extraction reported that this image contains no readable chart.';

/** The assumption sentence the builder writes when the completion-token figure is an estimate. */
const ESTIMATE_ASSUMPTION =
  'The synthesis completion-token figure is an estimate: the provider reported no usage for the ' +
  'synthesis call.';

/**
 * One submitted image as the domain carries it into the builder, with the fields no rule reads here
 * filled in: this suite states the geometry, the status and the levels, and nothing else.
 */
function submittedImage(imageId: string, fileName: string, levels: readonly Level[]): MappedImage {
  return {
    imageId,
    fileName,
    contentType: 'image/png',
    byteSize: 4096,
    width: 1600,
    height: 900,
    status: 'ANALYZED',
    levels: levels.map((level) => ({ ...level })),
    currentPrice: { imageId, price: null },
  };
}

/** The footprint screenshot as the extraction mapped it. */
function footprintImage(): MappedImage {
  return submittedImage(FOOTPRINT_IMAGE_ID, FOOTPRINT_FILE_NAME, [
    ENTRY_LEVEL,
    VALUE_AREA_HIGH_LEVEL,
  ]);
}

/** The gamma-exposure screenshot as the extraction mapped it. */
function gexImage(): MappedImage {
  return submittedImage(GEX_IMAGE_ID, GEX_FILE_NAME, [INVALIDATION_LEVEL, CALL_WALL_LEVEL]);
}

/** The two readable screenshots, in submission order. */
function readableImages(): MappedImage[] {
  return [footprintImage(), gexImage()];
}

/** The screenshot whose extraction reported no chart, so it yielded no level and says why. */
function blankImage(): MappedImage {
  return {
    ...submittedImage(BLANK_IMAGE_ID, BLANK_FILE_NAME, []),
    status: 'UNREADABLE',
    extractionError: BLANK_REASON,
  };
}

/** A read that survived every pass, with the level references each case overrides. */
function outcome(overrides: Partial<InvariantOutcome> = {}): InvariantOutcome {
  return {
    side: 'LONG',
    timing: 'ON_RETEST',
    entryLevel: ENTRY_LEVEL,
    invalidationLevel: INVALIDATION_LEVEL,
    targetLevels: [],
    assumptions: [],
    ...overrides,
  };
}

/** Everything one build needs, as the analysis service holds it at the end of a successful read. */
function documentInput(overrides: Partial<BuildDocumentInput> = {}): BuildDocumentInput {
  return {
    analysisId: 'analysis-document-builder',
    createdAt: '2025-01-02T03:04:05.000Z',
    instrument: 'ES',
    context: 'Opening range',
    images: readableImages(),
    outcome: outcome(),
    confidence: 'MEDIUM',
    summary: 'Long from the imbalance on a retest, invalidated below the negative-gamma strike.',
    assumptions: [],
    modelUsage: {
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      imageCallCount: 2,
      synthesisCompletionTokens: 96,
      latencyMs: 1234,
    },
    ...overrides,
  };
}

/**
 * The target lists the evidence is numbered over, each with the claims the document must carry.
 *
 * The first case is the shape that used to skip an ordinal: the entry level is cited again as a
 * target, so it is one observation rather than two, and the two targets that remain are numbers one
 * and two. The rest fix the neighbouring shapes — a lone surviving target, a target the read cited
 * twice, and a list every entry of which an earlier role already named.
 */
const TARGET_NUMBERING_CASES: ReadonlyArray<{
  readonly name: string;
  readonly targetLevels: readonly Level[];
  readonly expectedClaims: readonly string[];
}> = [
  {
    name: 'numbers the surviving targets from one when the entry level is cited again as a target',
    targetLevels: [ENTRY_LEVEL, VALUE_AREA_HIGH_LEVEL, CALL_WALL_LEVEL],
    expectedClaims: [
      ENTRY_CLAIM,
      INVALIDATION_CLAIM,
      `Target 1 is the FOOTPRINT_VALUE_AREA_HIGH level from ${FOOTPRINT_FILE_NAME}.`,
      `Target 2 is the GEX_CALL_WALL level from ${GEX_FILE_NAME}.`,
    ],
  },
  {
    name: 'names a lone surviving target without a number',
    targetLevels: [VALUE_AREA_HIGH_LEVEL],
    expectedClaims: [
      ENTRY_CLAIM,
      INVALIDATION_CLAIM,
      `Target is the FOOTPRINT_VALUE_AREA_HIGH level from ${FOOTPRINT_FILE_NAME}.`,
    ],
  },
  {
    name: 'names the one surviving target without a number when the entry was cited beside it',
    targetLevels: [ENTRY_LEVEL, VALUE_AREA_HIGH_LEVEL],
    expectedClaims: [
      ENTRY_CLAIM,
      INVALIDATION_CLAIM,
      `Target is the FOOTPRINT_VALUE_AREA_HIGH level from ${FOOTPRINT_FILE_NAME}.`,
    ],
  },
  {
    name: 'lists a target the read cited twice once, keeping the numbering gapless',
    targetLevels: [VALUE_AREA_HIGH_LEVEL, VALUE_AREA_HIGH_LEVEL, CALL_WALL_LEVEL],
    expectedClaims: [
      ENTRY_CLAIM,
      INVALIDATION_CLAIM,
      `Target 1 is the FOOTPRINT_VALUE_AREA_HIGH level from ${FOOTPRINT_FILE_NAME}.`,
      `Target 2 is the GEX_CALL_WALL level from ${GEX_FILE_NAME}.`,
    ],
  },
  {
    name: 'leaves no target claim when every cited target was named by an earlier role',
    targetLevels: [ENTRY_LEVEL],
    expectedClaims: [ENTRY_CLAIM, INVALIDATION_CLAIM],
  },
];

describe('buildAnalysisDocument', () => {
  describe('the evidence it cites', () => {
    it.each(TARGET_NUMBERING_CASES)('$name', ({ targetLevels, expectedClaims }) => {
      const document = buildAnalysisDocument(
        documentInput({ outcome: outcome({ targetLevels }) }),
      );
      const claims = document.rationale.map((entry) => entry.claim);

      expect(claims).toEqual([...expectedClaims]);

      // One entry per level: no level the read cites is listed as two observations.
      const citedLevelIds = document.rationale.flatMap((entry) => entry.levelIds);
      expect(new Set(citedLevelIds).size).toBe(citedLevelIds.length);

      // Every reference the evidence carries resolves in the level table.
      const knownLevelIds = new Set(document.levels.map((level) => level.levelId));
      expect(citedLevelIds.filter((levelId) => !knownLevelIds.has(levelId))).toEqual([]);

      // The surviving targets are numbered from one with no gap, whatever was cited.
      const ordinals = claims
        .map((claim) => /^Target (\d+) is /.exec(claim))
        .filter((match) => match !== null)
        .map((match) => Number(match[1]));
      expect(ordinals).toEqual(ordinals.map((_, index) => index + 1));

      // Numbering the evidence changes nothing the recommendation itself references.
      expect(document.recommendation.targetLevelIds).toEqual(
        targetLevels.map((level) => level.levelId),
      );
    });

    it('writes no price into a claim, so levels[] stays the only place a price appears', () => {
      const document = buildAnalysisDocument(
        documentInput({
          outcome: outcome({
            targetLevels: [ENTRY_LEVEL, VALUE_AREA_HIGH_LEVEL, CALL_WALL_LEVEL],
          }),
        }),
      );

      const prices = document.levels.map((level) => String(level.price));
      expect(prices).toHaveLength(4);
      for (const entry of document.rationale) {
        for (const price of prices) {
          expect(entry.claim).not.toContain(price);
        }
      }

      // The read holds references only, so no number reaches the recommendation either.
      for (const value of Object.values(document.recommendation)) {
        expect(typeof value).not.toBe('number');
      }
    });

    it('records what each readable screenshot contributed when the read references no level', () => {
      const document = buildAnalysisDocument(
        documentInput({
          outcome: {
            side: 'NO_TRADE',
            timing: 'WAIT',
            entryLevel: null,
            invalidationLevel: null,
            targetLevels: [],
            assumptions: [],
          },
        }),
      );

      expect(document.rationale).toHaveLength(2);

      const knownLevelIds = new Set(document.levels.map((level) => level.levelId));
      for (const entry of document.rationale) {
        expect(entry.levelIds.length).toBeGreaterThan(0);
        expect(entry.levelIds.filter((levelId) => !knownLevelIds.has(levelId))).toEqual([]);
      }
    });
  });

  describe('the assumptions and provenance it records', () => {
    it('records the estimate sentence once when the token figure is an estimate', () => {
      const estimated = buildAnalysisDocument(
        documentInput({ tokensEstimated: true, assumptions: [ESTIMATE_ASSUMPTION] }),
      );

      expect(
        estimated.assumptions.filter((sentence) => sentence.includes('is an estimate')),
      ).toEqual([ESTIMATE_ASSUMPTION]);

      const measured = buildAnalysisDocument(documentInput({ tokensEstimated: false }));
      expect(measured.assumptions).toEqual([]);
    });

    it('records the instruction version from the library and the shared disclaimer', () => {
      const document = buildAnalysisDocument(documentInput());

      expect(document.modelUsage.promptVersion).toBe(getPromptVersion());
      expect(document.disclaimer).toBe(DISCLAIMER);
    });
  });

  describe('the levels and images it records', () => {
    it('lists every extracted level in submission order', () => {
      const document = buildAnalysisDocument(documentInput());

      expect(document.levels.map((level) => level.levelId)).toEqual([
        ENTRY_LEVEL.levelId,
        VALUE_AREA_HIGH_LEVEL.levelId,
        INVALIDATION_LEVEL.levelId,
        CALL_WALL_LEVEL.levelId,
      ]);
    });

    it('drops a stale extractionError from an analysed image and keeps the reason on an unreadable one', () => {
      const document = buildAnalysisDocument(
        documentInput({
          images: [
            { ...footprintImage(), extractionError: 'A reason left over from an earlier reading.' },
            gexImage(),
            blankImage(),
          ],
        }),
      );

      const statuses = document.images.map((image) => image.status);
      expect(statuses).toEqual(['ANALYZED', 'ANALYZED', 'UNREADABLE']);

      // The stale reason is gone from the image that was read; the unreadable image keeps its own.
      const carriesReason = document.images.map((image) => Object.hasOwn(image, 'extractionError'));
      expect(carriesReason).toEqual([false, false, true]);
      expect(document.images.at(-1)?.extractionError).toBe(BLANK_REASON);
    });
  });
});
