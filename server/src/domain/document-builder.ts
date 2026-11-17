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
 *   the evidence behind returning nothing actionable. A claim names the role, the level type and the
 *   screenshot, never the price: a consumer resolves the price through the cited level id, which
 *   keeps `levels[]` the one place a price appears.
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
  type ModelUsage,
  type Rationale,
  type Recommendation,
} from '@trade-read/shared';

import { getPromptVersion } from '../adapters/prompts/prompt-library.js';

import type { MappedImage } from './extraction-mapping.js';
import type { InvariantOutcome } from './invariants.js';
import { analysisDocumentSchema } from './schemas.js';

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

  /**
   * Whether `modelUsage.synthesisCompletionTokens` is an estimate rather than the provider's own
   * figure, which happens only when the provider reported no usage at all (D14).
   *
   * The document has to state that, because a cost recorded beside a stored read is only useful if a
   * reader can tell a measured figure from an estimated one; the sentence is written here rather than
   * by the caller so exactly one wording exists.
   */
  readonly tokensEstimated?: boolean;
}

/** One cited level together with the role the recommendation gives it. */
interface CitedLevel {
  /** How the read uses the level, in the words the claim uses: `Entry`, `Invalidation`, `Target`. */
  readonly role: string;
  /** The level the read cites. */
  readonly level: Level;
}

/**
 * One claim: the role the level plays, its public type and the screenshot it was read from.
 *
 * The price is deliberately absent. `levels[]` is the only place a price appears, so a claim cites the
 * level and a consumer reads the number off that row; repeating the price here would be a second copy
 * of it, free to drift from the level the claim names.
 */
function claimFor(cited: CitedLevel, fileName: string | undefined): string {
  const source = fileName === undefined ? 'a submitted screenshot' : fileName;
  return `${cited.role} is the ${cited.level.type} level from ${source}.`;
}

/**
 * The levels the recommendation cites, in the order it names them: entry, invalidation, then each
 * target.
 *
 * A level cited under more than one role is listed once, under the role that named it first, because
 * the evidence holds one entry per level rather than one per mention. The target ordinals are
 * assigned after that deduplication, over the targets that survive it: a level the entry or an
 * earlier target already named is not a target the evidence can show, so counting it would leave the
 * claims reading `Target 2`, `Target 3` with no `Target 1` to find. A read with one surviving target
 * therefore names it `Target`, and a read with more numbers them from one with no gap.
 */
function citedLevels(outcome: InvariantOutcome): CitedLevel[] {
  const cited: CitedLevel[] = [];
  const seen = new Set<string>();

  // A level keeps the role that named it first, and the roles are claimed in the order they appear:
  // entry, then invalidation.
  const cite = (role: string, level: Level): void => {
    if (seen.has(level.levelId)) {
      return;
    }
    seen.add(level.levelId);
    cited.push({ role, level });
  };

  if (outcome.entryLevel !== null) {
    cite('Entry', outcome.entryLevel);
  }
  if (outcome.invalidationLevel !== null) {
    cite('Invalidation', outcome.invalidationLevel);
  }

  // The targets no earlier role cited, in the order the read named them, each listed once.
  const survivingTargets: Level[] = [];
  for (const level of outcome.targetLevels) {
    if (seen.has(level.levelId)) {
      continue;
    }
    seen.add(level.levelId);
    survivingTargets.push(level);
  }

  const numbered = survivingTargets.length > 1;
  survivingTargets.forEach((level, index) => {
    cited.push({ role: numbered ? `Target ${String(index + 1)}` : 'Target', level });
  });

  return cited;
}

/**
 * The evidence behind the levels the recommendation references, one entry per level and in the order
 * the recommendation names them.
 */
function rationaleForLevels(
  outcome: InvariantOutcome,
  fileNameById: ReadonlyMap<string, string>,
): Rationale[] {
  return citedLevels(outcome).map((cited) => ({
    claim: claimFor(cited, fileNameById.get(cited.level.imageId)),
    imageId: cited.level.imageId,
    levelIds: [cited.level.levelId],
  }));
}

/**
 * The evidence a read that references no level rests on: one entry per screenshot that reported any
 * level, citing the levels it contributed by id.
 *
 * A `NO_TRADE`/`WAIT` document is a complete answer rather than a failure, and the reason it is
 * complete is that these readings were available and did not support a directional read. The entries
 * cite real levels without restating their prices, so every reference they carry resolves in the
 * level table and the table stays the only place a price appears.
 */
function rationaleForReadings(images: ReadonlyArray<MappedImage>): Rationale[] {
  return images
    .filter((image) => image.levels.length > 0)
    .map((image) => ({
      claim:
        `This screenshot reported ${String(image.levels.length)} price level` +
        `${image.levels.length === 1 ? '' : 's'}, and the read drawn from them was no trade.`,
      imageId: image.imageId,
      levelIds: image.levels.map((level) => level.levelId),
    }));
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

  // The reason belongs to the unreadable case alone: an image that was read carries none, and the
  // contract's stored shape refuses one on it, so the key is omitted rather than sent as undefined.
  return image.status !== 'UNREADABLE' || image.extractionError === undefined
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
 * The assumption recorded when the cost figure is an estimate rather than the provider's own, so a
 * reader of a stored read can tell the two apart (D14).
 */
const ESTIMATED_TOKENS_ASSUMPTION =
  'The synthesis completion-token figure is an estimate: the provider reported no usage for the ' +
  'synthesis call.';

/**
 * The assumptions the document records: the invariant passes' sentences first, because they explain
 * a correction or a downgrade, then the causes this builder was handed, and last the note that the
 * cost figure is an estimate. An exact repeat is said once, so two passes reporting the same cause do
 * not read as two different problems.
 */
function collectAssumptions(input: BuildDocumentInput): string[] {
  const assumptions: string[] = [];
  const seen = new Set<string>();

  const remember = (sentence: string): void => {
    const trimmed = sentence.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    assumptions.push(trimmed);
  };

  for (const sentence of input.outcome.assumptions) {
    remember(sentence);
  }
  for (const sentence of input.assumptions) {
    remember(sentence);
  }
  if (input.tokensEstimated === true) {
    remember(ESTIMATED_TOKENS_ASSUMPTION);
  }

  return assumptions;
}

/**
 * Assembles the analysis document.
 *
 * @param input - Everything the analysis recorded, already mapped into the public vocabulary.
 * @returns The document the API returns and the store persists, byte for byte.
 * @throws {ZodError} When the assembled object departs from the shared contract, which is a defect in
 *   this build rather than in the request: the analysis service turns the throw into the generic
 *   `INTERNAL_ERROR` response, so no malformed document ever reaches a client or the store.
 */
export function buildAnalysisDocument(input: BuildDocumentInput): AnalysisDocument {
  const fileNameById = new Map(input.images.map((image) => [image.imageId, image.fileName]));
  const levelCitations = rationaleForLevels(input.outcome, fileNameById);

  const document: AnalysisDocument = {
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

  // The last gate before a document leaves this module: everything above assembles, this proves the
  // result is the contract's shape, so a field added, dropped or mistyped here fails loudly.
  return analysisDocumentSchema.parse(document);
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
