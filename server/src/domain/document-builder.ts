/**
 * The one place an analysis document is assembled.
 *
 * Everything else in the domain works in fragments: an extraction maps one image into levels, a
 * synthesis maps one answer into the public vocabulary, and the invariant passes decide which of
 * those references survive. This module is where those fragments become the single object the API
 * returns and the store persists, so no route, adapter or test constructs that shape itself.
 *
 * Three rules it owns:
 *
 * - A price exists only on a level. The recommendation carries level ids and nothing else, so a
 *   reader can always resolve a price back to the screenshot that reported it.
 * - The rationale is server-authored. The synthesis line has no rationale field, so the evidence is
 *   built here from the levels the recommendation uses; a read that references no level — a
 *   `NO_TRADE` downgrade — still records what each readable screenshot contributed, because that is
 *   the evidence behind returning nothing actionable.
 * - The disclaimer is the shared constant, never a copy of it, so the sentence in the record and
 *   the sentence on screen cannot drift apart.
 *
 * It performs no I/O, holds no clock and reads no environment: its inputs are the recorded facts and
 * its output is the document.
 */

import {
  DISCLAIMER,
  type AnalysisDocument,
  type AnalysisImage,
  type Confidence,
  type Level,
  type LevelType,
  type ModelUsage,
  type Rationale,
  type Recommendation,
} from '@trade-read/shared';

import { getPromptVersion } from '../adapters/prompts/prompt-library.js';

import type { MappedImage } from './extraction-mapping.js';
import type { InvariantOutcome } from './invariants.js';

/** Everything the document records, as the service holds it at the end of a successful analysis. */
export interface BuildDocumentInput {
  /** The id minted for this analysis; it is also the store's directory name. */
  readonly analysisId: string;

  /** ISO-8601 UTC instant at which the analysis completed. */
  readonly createdAt: string;

  /** The operator's instrument label, already clamped, empty when none was supplied. */
  readonly instrument: string;

  /** The operator's free text, already clamped, empty when none was supplied. */
  readonly context: string;

  /** Every submitted image with the levels its own reading yielded, in submission order. */
  readonly images: ReadonlyArray<MappedImage>;

  /** The side, timing and level references the invariant passes left standing. */
  readonly outcome: InvariantOutcome;

  /** The confidence the synthesis reported, in the public vocabulary. */
  readonly confidence: Confidence;

  /** The synthesis's one supporting sentence, already within its 140-character cap. */
  readonly summary: string;

  /**
   * What had to be assumed or corrected beyond the invariant passes — an unreadable screenshot, a
   * dropped unpriced level — in the order they were found. The passes' own sentences are supplied in
   * `outcome.assumptions`; this array adds to them.
   */
  readonly assumptions: ReadonlyArray<string>;

  /**
   * What the analysis cost. The instruction versions are not a caller's to supply: this module adds
   * them from the prompt library, so a document's `promptVersion` is always the version of the text
   * that was actually sent, read at the moment the record is assembled.
   */
  readonly modelUsage: Omit<ModelUsage, 'promptVersion'>;
}

/**
 * The human wording of a level type: the public taxonomy member with its underscores opened out and
 * its acronyms kept, so a claim reads as a sentence without inventing a second vocabulary.
 */
function levelTypeWording(type: LevelType): string {
  return type.toLowerCase().split('_').join(' ');
}

/** One claim per referenced level, naming the price, the kind of level and where it came from. */
function claimFor(role: string, level: Level): string {
  return (
    `The ${role} price ${String(level.price)} is the ${levelTypeWording(level.type)} level this ` +
    'screenshot reported.'
  );
}

/**
 * The evidence behind the levels the recommendation references, one entry per level and in the order
 * the recommendation names them: entry, invalidation, then each target.
 */
function rationaleForLevels(outcome: InvariantOutcome): Rationale[] {
  const cited: Array<{ role: string; level: Level }> = [];

  if (outcome.entryLevel !== null) {
    cited.push({ role: 'entry', level: outcome.entryLevel });
  }
  if (outcome.invalidationLevel !== null) {
    cited.push({ role: 'invalidation', level: outcome.invalidationLevel });
  }
  outcome.targetLevels.forEach((level) => {
    cited.push({ role: 'target', level });
  });

  return cited.map(({ role, level }) => ({
    claim: claimFor(role, level),
    imageId: level.imageId,
    levelIds: [level.levelId],
  }));
}

/**
 * The evidence a read that references no level rests on: one entry per screenshot that reported any
 * level, naming the prices it contributed and citing them by id.
 *
 * A `NO_TRADE`/`WAIT` document is a complete answer rather than a failure, and the reason it is
 * complete is that these readings were available and did not support a directional read. The
 * entries cite real levels, so every reference they carry resolves in the level table.
 */
function rationaleForReadings(images: ReadonlyArray<MappedImage>): Rationale[] {
  return images
    .filter((image) => image.levels.length > 0)
    .map((image) => {
      const prices = image.levels.map((level) => String(level.price)).join(', ');

      return {
        claim:
          `This screenshot reported ${String(image.levels.length)} price level` +
          `${image.levels.length === 1 ? '' : 's'} (${prices}), and the read drawn from them was ` +
          'no trade.',
        imageId: image.imageId,
        levelIds: image.levels.map((level) => level.levelId),
      };
    });
}

/**
 * One stored image as the document records it: the geometry, the status and, only for an unreadable
 * image, the reason it could not be read.
 */
function toAnalysisImage(image: MappedImage): AnalysisImage {
  const stored: AnalysisImage = {
    imageId: image.imageId,
    fileName: image.fileName,
    contentType: image.contentType,
    byteSize: image.byteSize,
    width: image.width,
    height: image.height,
    status: image.status,
  };

  return image.extractionError === undefined
    ? stored
    : { ...stored, extractionError: image.extractionError };
}

/** The recommendation, expressed entirely as level references so it can carry no price of its own. */
function toRecommendation(input: BuildDocumentInput): Recommendation {
  const { outcome } = input;

  return {
    side: outcome.side,
    timing: outcome.timing,
    // The trigger is the price the timing was judged against, which is the entry price, so the
    // trigger reference and the entry reference name the same level whenever a read has one.
    triggerLevelId: outcome.entryLevel === null ? null : outcome.entryLevel.levelId,
    entryLevelId: outcome.entryLevel === null ? null : outcome.entryLevel.levelId,
    invalidationLevelId: outcome.invalidationLevel === null ? null : outcome.invalidationLevel.levelId,
    targetLevelIds: outcome.targetLevels.map((level) => level.levelId),
    confidence: input.confidence,
    summary: input.summary,
  };
}

/**
 * The assumptions the document records: the invariant passes' sentences first, because they explain
 * a correction or a downgrade, then the causes this builder was handed, with an exact repeat said
 * once so two passes reporting the same cause do not read as two different problems.
 */
function collectAssumptions(input: BuildDocumentInput): string[] {
  const assumptions: string[] = [];
  const seen = new Set<string>();

  for (const sentence of [...input.outcome.assumptions, ...input.assumptions]) {
    const trimmed = sentence.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    assumptions.push(trimmed);
  }

  return assumptions;
}

/**
 * Assembles the analysis document.
 *
 * @param input - Everything the analysis recorded, already mapped into the public vocabulary.
 * @returns The document the API returns and the store persists, byte for byte.
 */
export function buildAnalysisDocument(input: BuildDocumentInput): AnalysisDocument {
  const levelCitations = rationaleForLevels(input.outcome);

  return {
    analysisId: input.analysisId,
    createdAt: input.createdAt,
    instrument: input.instrument,
    context: input.context,
    images: input.images.map(toAnalysisImage),
    levels: input.images.flatMap((image) => image.levels),
    recommendation: toRecommendation(input),
    rationale: levelCitations.length > 0 ? levelCitations : rationaleForReadings(input.images),
    assumptions: collectAssumptions(input),
    // The instruction versions are read here rather than received, so no caller can record a version
    // that differs from the text the provider library actually sends.
    modelUsage: { ...input.modelUsage, promptVersion: getPromptVersion() },
    disclaimer: DISCLAIMER,
  };
}

/**
 * The assumption recorded for each screenshot the analysis could not read, naming the file so the
 * operator knows which capture to take again. The reason is the image's own, so the two causes of
 * unreadability stay distinguishable.
 */
export function unreadableImageAssumption(image: MappedImage): string {
  return (
    `The screenshot "${image.fileName}" could not be read into levels: ` +
    `${image.extractionError ?? 'no reason was recorded.'}`
  );
}

/**
 * The assumption recorded when a reading carried prices that could not be read and were dropped
 * rather than repaired, which is the one cause that would otherwise silently shrink the level table.
 */
export function droppedLevelAssumption(fileName: string, droppedLevelCount: number): string {
  return (
    `The screenshot "${fileName}" reported ${String(droppedLevelCount)} price` +
    `${droppedLevelCount === 1 ? '' : 's'} that could not be read, which ` +
    `${droppedLevelCount === 1 ? 'was' : 'were'} dropped rather than estimated.`
  );
}
