/**
 * The passes that decide whether a mapped synthesis read survives the evidence, and what it owes.
 *
 * A mapped answer is a claim: it cites prices, names the images it rests on and proposes a timing.
 * Each pass here tests one part of that claim against what the extractions actually reported, in a
 * fixed order, because the order decides which cause is recorded when more than one applies.
 *
 * The cited prices are resolved first, and a read that cites a price no extracted level carries is
 * void outright: nothing later could turn a price the screenshots never reported into evidence, so
 * the read becomes `NO_TRADE`/`WAIT` and says which prices were unmatched. A read that survives is
 * then measured for source sufficiency — a directional side needs an entry and an invalidation level
 * from two distinct images, and it must name at least two of the images this analysis holds as its
 * sources, since one image alone is one observation — and a read short of any of that is downgraded
 * with the cause named in one sentence. A read still standing has its timing decided from the price
 * evidence by `timing.ts`, and a correction there voids the read too, because a read whose own
 * evidence contradicts the moment it claims to be actionable has no timing the record can stand
 * behind. A read whose every cited level is a gamma-exposure level says so, because gamma exposure
 * is a different kind of evidence from footprint volume.
 *
 * A non-actionable read is always exactly `NO_TRADE` with the `WAIT` timing and no level references
 * at all (D7), so no document shows a side with nothing to act on. `NO_TRADE`/`WAIT` is a complete
 * result and never an error (rule 5): every pass returns a recommendation and the sentences that
 * explain it, and none of them raises.
 *
 * The assumption array's order is this module's pass order, which the analysis surface renders as a
 * list: the unmatched prices first, then the source shortfall, then the timing correction, then the
 * absence of any current price, and last the gamma-exposure-only note. `document-builder.ts` appends
 * the extraction-side causes — an unreadable screenshot and a dropped unpriced level — after these,
 * so a downgrade is always explained before the readings it rests on.
 *
 * Every sentence a pass writes is client-visible, so it uses the public vocabulary only and never a
 * model short code. It reads no environment, performs no I/O, reaches no network and holds no state.
 */

import { isGexLevelType, type Level, type Side, type Timing } from '@trade-read/shared';

import type { MappedImage } from './extraction-mapping.js';
import { distinctImageIds, matchLevel } from './level-matching.js';
import { isDirectional, type MappedSynthesis } from './synthesis-mapping.js';
import { currentPriceEvidence, decideTiming } from './timing.js';

/** Everything the passes may look at: the mapped read, the extracted levels, and the price evidence. */
export interface InvariantInput {
  /** The synthesis answer, already translated into the public vocabulary. */
  readonly mapped: MappedSynthesis;
  /** Every level the submission's extractions produced, in extraction order. */
  readonly levels: readonly Level[];
  /**
   * Every submitted image, in submission order, with the levels it yielded and the current price it
   * reported: the evidence the timing decision is judged against.
   */
  readonly images: ReadonlyArray<MappedImage>;
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
  /** The timing the evidence supports, or `WAIT` when the read was voided. */
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

/**
 * The assumption recorded when a read that takes a side proposed to wait and no screenshot reported
 * a current price, which is the absence that left no timing to confirm.
 */
const NO_CURRENT_PRICE_ASSUMPTION =
  'No submitted screenshot reported a current price, so no timing could be confirmed and the read ' +
  'waits for one.';

/** The cited prices resolved against the extracted levels, with every price that named none. */
interface CitedResolution {
  /** The level the entry price resolved to, or null when the read cites none or it matched nothing. */
  readonly entry: Level | null;
  /** The level the invalidation price resolved to, or null likewise. */
  readonly invalidation: Level | null;
  /** The levels the target prices resolved to, in cited order, with unmatched prices dropped. */
  readonly targets: readonly Level[];
  /** Every cited price that named no level: the entry, then the invalidation, then the targets. */
  readonly unmatched: readonly number[];
}

/** A non-actionable read: no side, the `WAIT` timing, no references, and the sentences that explain it. */
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

/**
 * Resolves every price the read cites, collecting the ones that named no level.
 *
 * The read's own source image ids go into each lookup, because a level from an image the read says
 * it rests on wins where two images reported the same price (D6). Equality is exact and numeric
 * throughout: a price one ulp away from a level names nothing and is reported as unmatched rather
 * than rounded onto it, and the prices are reported in the order the read cited them so the sentence
 * naming them reads in that order.
 */
function resolveCitedPrices(mapped: MappedSynthesis, levels: readonly Level[]): CitedResolution {
  const sources = mapped.sourceImageIds;
  const entry = matchLevel(mapped.entryPrice, levels, sources);
  const invalidation = matchLevel(mapped.invalidationPrice, levels, sources);

  const targets: Level[] = [];
  const unmatched: number[] = [];

  if (mapped.entryPrice !== null && entry === null) {
    unmatched.push(mapped.entryPrice);
  }
  if (mapped.invalidationPrice !== null && invalidation === null) {
    unmatched.push(mapped.invalidationPrice);
  }
  for (const price of mapped.targetPrices) {
    const level = matchLevel(price, levels, sources);
    if (level === null) {
      unmatched.push(price);
    } else {
      targets.push(level);
    }
  }

  return { entry, invalidation, targets, unmatched };
}

/** The prices a sentence names, rendered as `a`, `a and b`, or `a, b and c`. */
function priceList(prices: readonly number[]): string {
  const rendered = prices.map((price) => String(price));
  const last = rendered[rendered.length - 1] ?? '';
  if (rendered.length <= 1) {
    return last;
  }
  return `${rendered.slice(0, -1).join(', ')} and ${last}`;
}

/** The assumption naming every cited price that no extracted level carries. */
function unmatchedPricesSentence(prices: readonly number[]): string {
  const single = prices.length === 1;
  return (
    `The read cited the ${single ? 'price' : 'prices'} ${priceList(prices)}, which ` +
    `${single ? 'equals' : 'equal'} no level extracted from the submitted screenshots, so the read ` +
    'was voided.'
  );
}

/** The assumption naming which of the two references a directional read leaves out. */
function missingReferenceSentence(noEntry: boolean, noInvalidation: boolean): string {
  if (noEntry && noInvalidation) {
    return (
      'The directional read was downgraded to NO_TRADE because it cites no entry or invalidation ' +
      'price.'
    );
  }
  return noEntry
    ? 'The directional read was downgraded to NO_TRADE because it cites no entry price.'
    : 'The directional read was downgraded to NO_TRADE because it cites no invalidation price.';
}

/** The assumption naming why a directional read has too little source evidence to stand. */
function sourceSufficiencySentence(evidenceImageCount: number, sourceImageCount: number): string {
  const imagesShort = evidenceImageCount < 2;
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

/**
 * The images a read could legitimately name as its sources.
 *
 * The submitted images are the set the rule is stated over. The images the extractions reported
 * levels from are the same images in every analysis — a level is always one extraction's, produced
 * for an image the submission carried — and they are included so the rule is decided on the same
 * evidence when a caller supplies the flattened levels without the image records.
 */
function heldImageIds(
  images: ReadonlyArray<MappedImage>,
  levels: readonly Level[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const level of levels) {
    ids.add(level.imageId);
  }
  for (const image of images) {
    ids.add(image.imageId);
  }
  return ids;
}

/**
 * How many distinct images a read names in `src` that this analysis actually holds.
 *
 * An id naming no image the analysis holds is not evidence of a source, so a read that cites an
 * image it was never given counts one source fewer than it claims, and repetition counts once.
 */
function namedSourceImageCount(
  sourceImageIds: readonly string[],
  held: ReadonlySet<string>,
): number {
  const named = new Set<string>();
  for (const sourceImageId of sourceImageIds) {
    if (held.has(sourceImageId)) {
      named.add(sourceImageId);
    }
  }
  return named.size;
}

/**
 * Applies the rules that decide whether the read survives, in the order they must run.
 *
 * Each pass can void the read, and only the first cause found is recorded, because a later rule
 * cannot be judged against a read an earlier one has already voided. A read that survives every pass
 * keeps its side, gains the timing the price evidence supports, and carries the assumptions its
 * corrections and its evidence type earned it.
 *
 * @param input - The mapped read, the extracted levels and the submitted images with their prices.
 * @returns The recommendation to record and the assumptions that explain it. Never an error, and
 *   never a null timing: a read that cannot be acted on is `NO_TRADE` with the `WAIT` timing.
 */
export function applyInvariants(input: InvariantInput): InvariantOutcome {
  const { mapped, levels, images } = input;

  // Rule 2: a cited price that no extracted level carries voids the read, because nothing later
  // could make a price the screenshots never reported into evidence.
  const resolution = resolveCitedPrices(mapped, levels);
  if (resolution.unmatched.length > 0) {
    return noTradeOutcome([unmatchedPricesSentence(resolution.unmatched)]);
  }

  // Rule 5: a read that takes no side is a complete answer, so it owes no explanation.
  if (!isDirectional(mapped.side)) {
    return noTradeOutcome([]);
  }

  // Rule 3: a directional read needs both references, on two distinct images, and it must name at
  // least two of the images this analysis holds as its sources.
  const { entry, invalidation, targets } = resolution;
  if (entry === null || invalidation === null) {
    return noTradeOutcome([missingReferenceSentence(entry === null, invalidation === null)]);
  }
  const evidenceImageCount = distinctImageIds([entry, invalidation]).length;
  const sourceImageCount = namedSourceImageCount(mapped.sourceImageIds, heldImageIds(images, levels));
  if (evidenceImageCount < 2 || sourceImageCount < 2) {
    return noTradeOutcome([sourceSufficiencySentence(evidenceImageCount, sourceImageCount)]);
  }

  // Rule 4: the timing is judged against the level the entry price resolved to (D7) and the current
  // price each image reported for itself. A read that already proposes to wait is non-actionable as
  // it stands — a complete result rather than a downgrade — and says why no timing was confirmed
  // when no screenshot reported a current price at all.
  if (mapped.timing === 'WAIT') {
    return noTradeOutcome(
      currentPriceEvidence(images).length === 0 ? [NO_CURRENT_PRICE_ASSUMPTION] : [],
    );
  }

  const decision = decideTiming({ proposed: mapped.timing, triggerLevel: entry, images });
  if (decision.correction !== null) {
    // A read whose own evidence contradicts the moment it claims to be actionable has no timing the
    // record can stand behind, so the side falls with the timing rather than leaving a directional
    // side that references nothing (D7).
    return noTradeOutcome([decision.correction]);
  }

  // Rule 7: a surviving read whose every cited level is a gamma-exposure level rests on gamma
  // evidence alone, which the operator is told because footprint volume is the other kind of evidence.
  const citedLevels = [entry, invalidation, ...targets];
  const assumptions: string[] = [];
  if (citedLevels.every((level) => isGexLevelType(level.type))) {
    assumptions.push(GEX_ONLY_ASSUMPTION);
  }

  return {
    side: mapped.side,
    timing: decision.timing,
    entryLevel: entry,
    invalidationLevel: invalidation,
    targetLevels: targets,
    assumptions,
  };
}
