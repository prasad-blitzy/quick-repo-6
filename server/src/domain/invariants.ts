/**
 * The passes that decide whether a mapped synthesis read survives the evidence, and what it owes.
 *
 * A mapped answer is a claim: it cites prices, names the images it rests on and proposes a timing.
 * Each pass here tests one part of that claim against what the extraction actually reported, in a
 * fixed order, because the order decides which cause is recorded when more than one applies.
 *
 * The cited prices are resolved first, and a directional read that cites a price no extracted level
 * carries is void outright: nothing later could repair a price the images never reported, so the
 * read becomes `NO_TRADE`/`WAIT` and says which price was unmatched. A read that survives that is
 * then measured for source sufficiency — a directional side needs its entry and invalidation on two
 * distinct images and at least two source image ids, since one image alone is one observation — and
 * a read short of either is downgraded with the cause named in one sentence. A read still standing
 * has its timing decided from the price evidence by `timing.ts`, whose correction is recorded when
 * the evidence contradicts the proposal, and a read whose every cited level is a gamma-exposure level
 * says so, because gamma exposure is a different kind of evidence from footprint volume.
 *
 * `NO_TRADE`/`WAIT` is a complete result and never an error: a downgraded read is returned like any
 * other, carrying the assumptions that explain it. It reads no environment, performs no I/O, reaches
 * no network and holds no state.
 */

import { isGexLevelType, type Level, type Side, type Timing } from '@trade-read/shared';

import { distinctImageIds, matchLevel, matchLevels } from './level-matching.js';
import type { MappedSynthesis } from './synthesis-mapping.js';
import { decideTiming, type CurrentPriceEvidence } from './timing.js';

/** Everything the passes may look at: the mapped read, the extracted levels, and the price evidence. */
export interface InvariantInput {
  /** The synthesis answer, already translated into the public vocabulary. */
  readonly mapped: MappedSynthesis;
  /** Every level the submission's extractions produced, in extraction order. */
  readonly levels: readonly Level[];
  /** Every current price the extractions reported, in submission order. */
  readonly currentPrices: readonly CurrentPriceEvidence[];
  /** Each image's extracted levels, keyed by image id, as the timing decision needs them. */
  readonly levelsByImage: ReadonlyMap<string, readonly Level[]>;
}

/**
 * The read as the document records it: a side and a timing, the levels those reference, and the
 * sentences explaining anything that had to be corrected or assumed.
 *
 * A `NO_TRADE`/`WAIT` outcome carries no level references at all, and a `NO_TRADE` side always
 * carries the `WAIT` timing.
 */
export interface InvariantOutcome {
  /** The side that survived the passes, or `NO_TRADE` when a pass voided the read. */
  readonly side: Side;
  /** The timing the evidence supports, or `WAIT` when the read was voided or corrected. */
  readonly timing: Timing;
  /** The level the entry price resolved to, or null for a `NO_TRADE` read. */
  readonly entryLevel: Level | null;
  /** The level the invalidation price resolved to, or null for a `NO_TRADE` read. */
  readonly invalidationLevel: Level | null;
  /** The levels the target prices resolved to, in cited order; empty for a `NO_TRADE` read. */
  readonly targetLevels: readonly Level[];
  /** What had to be assumed or corrected, one sentence per cause, in the order the passes found them. */
  readonly assumptions: readonly string[];
}

/** The assumption recorded when every level a surviving read cites is a gamma-exposure level. */
const GEX_ONLY_ASSUMPTION =
  'Every level this read cites is a gamma-exposure level, so the read rests on gamma-exposure ' +
  'evidence alone.';

/** The cited prices resolved against the extracted levels, with the first failure if there was one. */
interface CitedResolution {
  /** The level the entry price resolved to, or null when the read cites no entry price. */
  readonly entry: Level | null;
  /** The level the invalidation price resolved to, or null when the read cites no invalidation price. */
  readonly invalidation: Level | null;
  /** The levels the target prices resolved to, in cited order, with unmatched prices dropped. */
  readonly targets: readonly Level[];
  /** The first cited price that resolved to no level, or null when every cited price resolved. */
  readonly unmatchedPrice: number | null;
}

/** A downgraded read: no side, no timing, no references, and the sentences that explain the downgrade. */
function noTradeOutcome(assumptions: readonly string[]): InvariantOutcome {
  return {
    side: 'NO_TRADE',
    timing: 'WAIT',
    entryLevel: null,
    invalidationLevel: null,
    targetLevels: [],
    assumptions,
  };
}

/** The assumption naming a cited price that no extracted level carries. */
function unmatchedPriceSentence(price: number): string {
  return `The cited price ${String(price)} equals no extracted level, so the read was voided.`;
}

/** The assumption naming why a directional read has too little source evidence to stand. */
function sourceSufficiencySentence(imageCount: number, sourceImageCount: number): string {
  const imagesShort = imageCount < 2;
  const sourcesShort = sourceImageCount < 2;
  if (imagesShort && sourcesShort) {
    return (
      'The directional read was downgraded to NO_TRADE because its entry and invalidation levels do ' +
      'not come from two distinct images and it names fewer than two source image ids.'
    );
  }
  if (imagesShort) {
    return (
      'The directional read was downgraded to NO_TRADE because its entry and invalidation levels do ' +
      'not come from two distinct images.'
    );
  }
  return (
    'The directional read was downgraded to NO_TRADE because it names fewer than two source image ids.'
  );
}

/** Whether a resolved reference holds a level, so a null reference can be counted out. */
function isResolvedLevel(level: Level | null): level is Level {
  return level !== null;
}

/**
 * The first cited target price that resolved to no level, or null when every target resolved.
 *
 * `targets` is the resolution of `targetPrices` with the unmatched prices dropped, so the two arrays
 * agree position by position until the first price that found no level, and a resolved level always
 * carries the price it was resolved from.
 */
function firstUnmatchedTarget(
  targetPrices: readonly number[],
  targets: readonly Level[],
): number | null {
  for (let index = 0; index < targetPrices.length; index += 1) {
    const price = targetPrices[index];
    if (price === undefined) {
      continue;
    }
    const resolved = targets[index];
    if (resolved === undefined || resolved.price !== price) {
      return price;
    }
  }
  return null;
}

/**
 * Resolves every price the read cites, using the shared-image preference the read itself states.
 *
 * The entry and invalidation prices go through the single-price lookup and the targets through the
 * list lookup, both of which resolve by exact numeric equality alone; the first price that finds
 * nothing is reported so the caller can void the read and name it.
 */
function resolveCitedPrices(
  mapped: MappedSynthesis,
  levels: readonly Level[],
): CitedResolution {
  const entry = matchLevel(mapped.entryPrice, levels, mapped.sourceImageIds);
  const invalidation = matchLevel(mapped.invalidationPrice, levels, mapped.sourceImageIds);
  const targets = matchLevels(mapped.targetPrices, levels, mapped.sourceImageIds);

  if (mapped.entryPrice !== null && entry === null) {
    return { entry, invalidation, targets, unmatchedPrice: mapped.entryPrice };
  }
  if (mapped.invalidationPrice !== null && invalidation === null) {
    return { entry, invalidation, targets, unmatchedPrice: mapped.invalidationPrice };
  }
  return {
    entry,
    invalidation,
    targets,
    unmatchedPrice: firstUnmatchedTarget(mapped.targetPrices, targets),
  };
}

/**
 * Applies the rules that decide whether the read survives, in the order they must run.
 *
 * Each pass can void the read, and only the first cause found is recorded, because a later rule
 * cannot be judged against a read an earlier one has already voided. A read that survives every pass
 * keeps its side, gains the timing the price evidence supports, and carries the assumptions its
 * corrections and its evidence type earned it.
 */
export function applyInvariants(input: InvariantInput): InvariantOutcome {
  const mapped = input.mapped;

  if (mapped.side === 'NO_TRADE') {
    return noTradeOutcome([]);
  }

  const resolution = resolveCitedPrices(mapped, input.levels);
  if (resolution.unmatchedPrice !== null) {
    return noTradeOutcome([unmatchedPriceSentence(resolution.unmatchedPrice)]);
  }

  const entryAndInvalidation = [resolution.entry, resolution.invalidation].filter(isResolvedLevel);
  const evidenceImageCount = distinctImageIds(entryAndInvalidation).length;
  const sourceImageCount = new Set(mapped.sourceImageIds).size;
  if (evidenceImageCount < 2 || sourceImageCount < 2) {
    return noTradeOutcome([sourceSufficiencySentence(evidenceImageCount, sourceImageCount)]);
  }

  const decision = decideTiming({
    proposed: mapped.timing,
    triggerPrice: mapped.entryPrice,
    currentPrices: input.currentPrices,
    levelsByImage: input.levelsByImage,
  });

  const assumptions: string[] = [];
  if (decision.correction !== null) {
    assumptions.push(decision.correction);
  }

  // Past the sufficiency pass both references hold a level, so the levels this read cites are exactly
  // its entry, its invalidation and its resolved targets.
  const bothReferencesResolved = entryAndInvalidation.length === 2;
  const citedLevels = [...entryAndInvalidation, ...resolution.targets];
  if (bothReferencesResolved && citedLevels.every((level) => isGexLevelType(level.type))) {
    assumptions.push(GEX_ONLY_ASSUMPTION);
  }

  return {
    side: mapped.side,
    timing: decision.timing,
    entryLevel: resolution.entry,
    invalidationLevel: resolution.invalidation,
    targetLevels: resolution.targets,
    assumptions,
  };
}
