/**
 * Exact resolution of a cited price to the extracted level it names.
 *
 * A recommendation never carries a price of its own: it cites the prices the model reported, and
 * this module turns each of them back into the level they came from, so the document can reference a
 * level id. Resolution is exact numeric equality and nothing else — no rounding, no tolerance, no
 * nearest-match — because a price that does not equal an extracted level's price is precisely the
 * case the downgrade rules exist to catch, and a tolerant match would hide it.
 *
 * Two different images can report the same price, and then the same input has to resolve to the same
 * level every time. The order is fixed: a level whose image the read names in `src` wins, because the
 * read claims to rest on that image; then the earlier extracted level; then the earlier level a run
 * of resolutions has already picked, so a price resolved twice resolves to the same level twice.
 *
 * The levels on offer are one flattened sequence: every image's levels in submission order, and each
 * image's levels in the order its extraction reported them. That sequence is what the positional
 * tie-breaks are measured against, and `LevelIndex` is it, built once per analysis so that every
 * resolution of a read sees the same levels in the same order. A caller that already holds the
 * flattened `Level[]` resolves without one (`matchLevel`, `matchLevels`); a caller holding the mapped
 * images builds the index (`matchPrice`, `matchPrices`, `resolvePrices`) so the order cannot be
 * assembled a second, subtly different way at a second call site.
 *
 * It reads no environment, performs no I/O, reaches no network and holds no state.
 */

import { isGexLevelType, type Level } from '@trade-read/shared';

import type { MappedImage, MappedLevel } from './extraction-mapping.js';
import type { MappedSynthesis } from './synthesis-mapping.js';

/** One level under consideration, with the position that decides between levels sharing a price. */
interface Candidate {
  /** The level itself, which is what a match returns. */
  readonly level: Level;
  /** Whether the read names this level's image, which outranks every positional tie-break. */
  readonly namedBySource: boolean;
  /**
   * The level's position in the flattened sequence of the analysis' levels.
   *
   * This one key settles both positional rules: the level that came earlier in extraction order and
   * the level that came earlier in the flattened array are the same level, because the flattened
   * sequence is the extraction order of every image laid end to end.
   */
  readonly levelIndex: number;
  /** The level's position among the levels a run has already picked, or no position at all. */
  readonly pickedIndex: number;
}

/** The position recorded for a level a run has not picked yet, so any picked level outranks it. */
const NOT_PICKED = Number.POSITIVE_INFINITY;

/** Whether one candidate should be preferred to the incumbent, by the fixed order of tie-breaks. */
function outranks(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.namedBySource !== incumbent.namedBySource) {
    return candidate.namedBySource;
  }
  if (candidate.levelIndex !== incumbent.levelIndex) {
    return candidate.levelIndex < incumbent.levelIndex;
  }
  return candidate.pickedIndex < incumbent.pickedIndex;
}

/** The position of a level among the ones a run has already picked, or {@link NOT_PICKED}. */
function pickedIndexIn(picked: readonly Level[], level: Level): number {
  const index = picked.indexOf(level);
  return index === -1 ? NOT_PICKED : index;
}

/**
 * The level a price resolves to, or null when no level carries that price or the price is null.
 *
 * `picked` is the run of levels this resolution belongs to, in the order they were picked; a level
 * already in it wins the last remaining tie, which keeps a repeated price on one level instead of
 * drifting between two levels the model reported at the same price.
 */
function resolve(
  price: number | null,
  levels: readonly Level[],
  sourceImageIds: ReadonlySet<string>,
  picked: readonly Level[],
): Level | null {
  if (price === null) {
    return null;
  }

  let best: Candidate | null = null;
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    if (level === undefined || level.price !== price) {
      continue;
    }
    const candidate: Candidate = {
      level,
      namedBySource: sourceImageIds.has(level.imageId),
      levelIndex,
      pickedIndex: pickedIndexIn(picked, level),
    };
    if (best === null || outranks(candidate, best)) {
      best = candidate;
    }
  }

  return best === null ? null : best.level;
}

/**
 * Every level of one analysis, in the order resolution depends on, with the lookups its rules ask for.
 *
 * Build it once per analysis from the mapped images rather than once per price: the flattened order
 * is what the tie-break is defined against, and an index assembled at a second call site is how two
 * resolutions of one price come to disagree. The index holds the levels the extractions reported and
 * nothing else, so a level id it cannot resolve is a level this analysis does not have.
 */
export interface LevelIndex {
  /** Every level of every image: images in submission order, each image's levels in extraction order. */
  all(): ReadonlyArray<MappedLevel>;

  /** The level carrying an id, or null when no level of this analysis carries it. */
  byId(levelId: string): MappedLevel | null;

  /**
   * How many distinct images stand behind a set of level ids.
   *
   * This is the measure the source-sufficiency rule is stated in: two levels at one price are one
   * observation when a single image reported both, and two when two images did. An id no level
   * carries contributes no image, so an unresolvable reference cannot inflate the count.
   */
  distinctImageCount(levelIds: ReadonlyArray<string>): number;

  /**
   * Whether every level a set of ids references is a gamma-exposure level.
   *
   * False when the set references no level at all, because a read that cites nothing rests on no
   * gamma-exposure evidence and the assumption this answers for is about evidence a read has.
   */
  isGexOnly(levelIds: ReadonlyArray<string>): boolean;

  /** Whether the analysis yielded no level at all, which no resolution can then succeed against. */
  isEmpty(): boolean;
}

/**
 * Builds the index of an analysis' levels.
 *
 * The order is the contract: images in submission order, each image's levels in the order its
 * extraction reported them — the order a document lists them in, and the order the tie-break
 * resolves a shared price by. The levels are copied into one frozen array, so a caller cannot append
 * a level no extraction reported, and the ids are keyed once here rather than scanned per lookup.
 */
export function buildLevelIndex(images: ReadonlyArray<MappedImage>): LevelIndex {
  const flattened: MappedLevel[] = [];
  for (const image of images) {
    for (const level of image.levels) {
      flattened.push(level);
    }
  }

  const levels: ReadonlyArray<MappedLevel> = Object.freeze(flattened);
  const levelsById = new Map<string, MappedLevel>();
  for (const level of levels) {
    // An id is minted per level, so a repeated id would be the same level listed twice; keeping the
    // first occurrence leaves the lookup agreeing with the flattened order.
    if (!levelsById.has(level.levelId)) {
      levelsById.set(level.levelId, level);
    }
  }

  /** The levels a set of ids references, skipping the ids no level of this analysis carries. */
  const levelsFor = (levelIds: ReadonlyArray<string>): ReadonlyArray<MappedLevel> => {
    const referenced: MappedLevel[] = [];
    for (const levelId of levelIds) {
      const level = levelsById.get(levelId);
      if (level !== undefined) {
        referenced.push(level);
      }
    }
    return referenced;
  };

  return {
    all: () => levels,
    byId: (levelId) => levelsById.get(levelId) ?? null,
    distinctImageCount: (levelIds) =>
      new Set(levelsFor(levelIds).map((level) => level.imageId)).size,
    isGexOnly: (levelIds) => {
      const referenced = levelsFor(levelIds);
      return referenced.length > 0 && referenced.every((level) => isGexLevelType(level.type));
    },
    isEmpty: () => levels.length === 0,
  };
}

/**
 * The level one cited price names, or null when it names none.
 *
 * `sourceImageIds` are the images the read claims to rest on; a level from one of them is preferred
 * where two levels share the price. Call it with the mapped answer's `sourceImageIds` so the
 * preference reflects what the read actually cited.
 */
export function matchLevel(
  price: number | null,
  levels: readonly Level[],
  sourceImageIds: readonly string[],
): Level | null {
  return resolve(price, levels, new Set(sourceImageIds), []);
}

/**
 * The levels a run of cited prices names, in the order the prices were cited.
 *
 * A price that names no level is dropped rather than estimated, substituted or matched
 * approximately: the caller decides what an unresolved price means, and a target list that silently
 * gained a level the model never cited would be an invented price.
 */
export function matchLevels(
  prices: readonly number[],
  levels: readonly Level[],
  sourceImageIds: readonly string[],
): readonly Level[] {
  const named = new Set(sourceImageIds);
  const matched: Level[] = [];
  for (const price of prices) {
    const level = resolve(price, levels, named, matched);
    if (level !== null) {
      matched.push(level);
    }
  }
  return matched;
}

/**
 * The level one cited price names in an analysis' levels, or null when it names none.
 *
 * Equality is exact and numeric: `5800.0` names a level priced `5800` because the two are the same
 * number, and a price one ulp away names nothing, because a price no image reported must not become
 * a reference the document can show. `options.sourceImageIds` are the images the read claims to rest
 * on; where two images reported the same price, a level from one of them is preferred, which is the
 * first tie-break of D6 and the reason this takes the read rather than the price alone.
 */
export function matchPrice(
  index: LevelIndex,
  price: number | null,
  options: { sourceImageIds: ReadonlyArray<string> },
): MappedLevel | null {
  return matchLevel(price, index.all(), options.sourceImageIds);
}

/**
 * The levels a run of cited prices names, with the prices that named none reported back as data.
 *
 * The proposed order is preserved in both outputs, and an unmatched price is reported as the number
 * the model gave rather than dropped silently, because the rule that voids a read has to name the
 * price that voided it. Resolution is the single-price lookup, so a run of prices resolves exactly as
 * resolving each price on its own would.
 */
export function matchPrices(
  index: LevelIndex,
  prices: ReadonlyArray<number>,
  options: { sourceImageIds: ReadonlyArray<string> },
): { matched: MappedLevel[]; unmatched: number[] } {
  const matched: MappedLevel[] = [];
  const unmatched: number[] = [];
  for (const price of prices) {
    const level = matchPrice(index, price, options);
    if (level === null) {
      unmatched.push(price);
    } else {
      matched.push(level);
    }
  }
  return { matched, unmatched };
}

/**
 * Every price a read cites, resolved to the level it names, with the prices that named no level.
 *
 * This is the whole of a read's price resolution in one call, so a caller never handles a bare price
 * it then has to resolve itself: a document can only reference the levels this returns (rule 1), and
 * a non-empty `unmatched` is the fact the downgrade rule is stated over (rule 2). An entry or an
 * invalidation price that names no level leaves its field null and appears in `unmatched`, which
 * makes a cited price that cannot be resolved distinguishable from one the read never cited.
 */
export interface MatchedRecommendationPrices {
  /** The level the entry price names, or null when the read cites no entry price or none matched. */
  entry: MappedLevel | null;
  /** The level the invalidation price names, or null likewise. */
  invalidation: MappedLevel | null;
  /** The levels the target prices name, in the order cited, with unmatched prices dropped. */
  targets: MappedLevel[];
  /** Every cited price that named no level: the entry, then the invalidation, then the targets. */
  unmatched: number[];
}

/**
 * Resolves every price one mapped synthesis cites against the analysis' levels.
 *
 * The read's own `sourceImageIds` are the tie-break's first key, so a price two images reported
 * resolves to the level of the image the read says it rests on. The side is not consulted: a read
 * that takes no side cites no prices and resolves to nothing, and whether an unresolved price voids
 * the read is the invariants' decision, made from `unmatched` rather than pre-empted here.
 */
export function resolvePrices(
  index: LevelIndex,
  synthesis: MappedSynthesis,
): MatchedRecommendationPrices {
  const options = { sourceImageIds: synthesis.sourceImageIds };
  const entry = matchPrice(index, synthesis.entryPrice, options);
  const invalidation = matchPrice(index, synthesis.invalidationPrice, options);
  const targets = matchPrices(index, synthesis.targetPrices, options);

  const unmatched: number[] = [];
  if (synthesis.entryPrice !== null && entry === null) {
    unmatched.push(synthesis.entryPrice);
  }
  if (synthesis.invalidationPrice !== null && invalidation === null) {
    unmatched.push(synthesis.invalidationPrice);
  }
  unmatched.push(...targets.unmatched);

  return { entry, invalidation, targets: targets.matched, unmatched };
}

/**
 * The distinct images behind a set of levels, in the order they first appear.
 *
 * This is the count a read's entry and invalidation are measured by: two levels at the same price or
 * of the same type prove nothing on their own, whereas two levels reported by two images are two
 * independent observations, which is what a directional read needs.
 */
export function distinctImageIds(levels: readonly Level[]): readonly string[] {
  const seen = new Set<string>();
  const imageIds: string[] = [];
  for (const level of levels) {
    if (seen.has(level.imageId)) {
      continue;
    }
    seen.add(level.imageId);
    imageIds.push(level.imageId);
  }
  return imageIds;
}
