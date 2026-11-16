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
 * It reads no environment, performs no I/O, reaches no network and holds no state.
 */

import type { Level } from '@trade-read/shared';

/** One level under consideration, with the position that decides between levels sharing a price. */
interface Candidate {
  /** The level itself, which is what a match returns. */
  readonly level: Level;
  /** Whether the read names this level's image, which outranks every positional tie-break. */
  readonly namedBySource: boolean;
  /** The level's position in the array it was extracted into. */
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
