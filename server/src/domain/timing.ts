/**
 * The timing decision: which timing the price evidence actually supports.
 *
 * A synthesis answer proposes when its entry becomes actionable — `NOW`, `ON_RETEST`, `ON_BREAK` or
 * `WAIT` — and a proposal is only a claim about the chart. What decides it is the current price each
 * image reported for itself, from the `LAST=` token of that image's extraction observation (D8), set
 * against the levels extracted from that same image: an image's current price is *at the trigger*
 * when the trigger level is the extracted level nearest to that price among that image's own levels.
 * The model's wording is never the evidence. The proposal arrives here already translated into a
 * public `Timing`, and nothing in this module reads a short code or reasons about an answer line.
 *
 * The three directional proposals are held to what a still screenshot can show:
 *
 * - `NOW` stands only when some image's current price sits at the trigger *and* that same image
 *   yielded at least one footprint level. A still image carries no bar sequence, so the closest
 *   decidable form of "live in the final bars of the footprint screenshot" is a footprint
 *   screenshot whose own reported current price sits at the trigger; no stronger claim about
 *   liveness is made anywhere in the build.
 * - `ON_BREAK` stands only when some image's current price sits at the trigger, because a break is
 *   the trigger being tested right now.
 * - `ON_RETEST` stands only when no image's current price sits at the trigger, because a retest is
 *   the trigger not having been reached yet.
 *
 * `WAIT` claims nothing about the price, so no evidence can contradict it and it is never corrected:
 * `WAIT` is a complete result, not a failure. When no submitted image reported a current price at
 * all, every directional proposal is corrected to `WAIT`, because nothing can be confirmed without a
 * price to confirm it against.
 *
 * A correction is one server-authored sentence naming the proposal and the evidence that overruled
 * it, which the caller records among the document's assumptions. The model's timing code is only
 * ever the proposal under test, and the public vocabulary is the only vocabulary a sentence uses.
 * Nothing here raises an error, returns null for the timing, or rewrites a proposal into a different
 * directional timing: an unsupported proposal becomes `WAIT`, and that is the whole of the
 * correction.
 *
 * Purity is contractual. It reads no clock, no randomness, no environment; it performs no I/O and
 * reaches no network; it holds no state; and it iterates only the arrays it is given, in the order
 * they arrive, so the same input always yields the same decision.
 */

import { isFootprintLevelType, type Timing } from '@trade-read/shared';

import type { MappedImage, MappedLevel } from './extraction-mapping.js';

/** One image's reported current price, with the case of no reported price already excluded. */
export interface ReportedPrice {
  /** The id of the image that reported the price. */
  readonly imageId: string;

  /** The price that image reported as its own current one. */
  readonly price: number;
}

/** Everything the decision reads: the proposal, the level it is judged against, and the images. */
export interface TimingInput {
  /** The timing the answer proposed, already translated into its public value. */
  readonly proposed: Timing;

  /**
   * The level the proposal is judged against: the level the read's entry price resolved to, or null
   * when the read cites no entry level at all.
   */
  readonly triggerLevel: MappedLevel | null;

  /** Every submitted image, in submission order, with its levels and its reported current price. */
  readonly images: ReadonlyArray<MappedImage>;
}

/** The timing the evidence supports, with the sentence a correction owes when it overrules one. */
export interface TimingDecision {
  /** The timing to record: the proposal where the evidence supports it, `WAIT` where it does not. */
  readonly timing: Timing;

  /**
   * One sentence naming the proposal and the evidence that overruled it, or null when the proposal
   * stood.
   */
  readonly correction: string | null;
}

/** One image whose current price sits at the trigger, together with that price. */
interface AtTriggerImage {
  /** The image, whose levels are the footprint evidence `NOW` additionally requires. */
  readonly image: MappedImage;

  /** The current price that put this image at the trigger, already known to be a finite number. */
  readonly price: number;
}

/**
 * Whether a reported current price is one the decision can use.
 *
 * A price that is absent, `null`, `NaN` or infinite is no evidence at all, so an image carrying one
 * is treated exactly like an image that reported `LAST=NA`.
 */
function isReadablePrice(price: number | null): price is number {
  return price !== null && Number.isFinite(price);
}

/**
 * The extracted level nearest to a price among one image's own levels, or null when it has none.
 *
 * Distance is the absolute difference. Two levels equidistant from the price — the price sitting
 * midway between them — are separated by taking the lower price, so the nearest level is a function
 * of the evidence rather than of array order. A remaining tie is two levels at one price, and the
 * level the extraction reported first is kept, which is the order the levels arrive in. A level
 * whose price is not a finite number is skipped rather than treated as distant.
 */
function nearestLevel(price: number, levels: ReadonlyArray<MappedLevel>): MappedLevel | null {
  let nearest: MappedLevel | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const level of levels) {
    if (!Number.isFinite(level.price)) {
      continue;
    }

    const distance = Math.abs(level.price - price);
    const closer = distance < nearestDistance;
    const equallyCloseToLowerPrice =
      distance === nearestDistance && nearest !== null && level.price < nearest.price;

    if (nearest === null || closer || equallyCloseToLowerPrice) {
      nearest = level;
      nearestDistance = distance;
    }
  }

  return nearest;
}

/**
 * Whether one image's own current price sits at the trigger level.
 *
 * The image is at the trigger when the level nearest to its current price among *its own* levels is
 * the trigger level, compared by `levelId` rather than by price: two levels can share a price, and
 * which of them the read cites was settled by the resolution tie-break, so the decision has to judge
 * the level the read actually references. An image that reported no current price, or yielded no
 * level, is never at the trigger — it has nothing to be nearest to.
 */
export function isAtTrigger(image: MappedImage, triggerLevel: MappedLevel): boolean {
  const price = image.currentPrice.price;
  if (!isReadablePrice(price)) {
    return false;
  }

  const nearest = nearestLevel(price, image.levels);
  return nearest !== null && nearest.levelId === triggerLevel.levelId;
}

/**
 * The current prices the decision may use, one per image that reported a readable one.
 *
 * A `LAST=NA` observation, a missing token and a value that is not a finite number all contribute
 * nothing here, which is what lets the decision tell "no image reports a current price" apart from
 * "a current price was reported". The order is submission order, so a decision formed from this list
 * names its evidence in the order the operator submitted it.
 */
export function currentPriceEvidence(
  images: ReadonlyArray<MappedImage>,
): ReadonlyArray<ReportedPrice> {
  const prices: ReportedPrice[] = [];

  for (const image of images) {
    const price = image.currentPrice.price;
    if (isReadablePrice(price)) {
      prices.push({ imageId: image.imageId, price });
    }
  }

  return prices;
}

/** The correction for a directional proposal made by a read that cites no trigger level. */
function noTriggerLevelCorrection(proposed: Timing): string {
  return (
    `The proposed ${proposed} timing was corrected to WAIT because the read cites no trigger level ` +
    'for a timing to be judged against.'
  );
}

/** The correction for a directional proposal made when no image reported a current price. */
function noCurrentPriceCorrection(proposed: Timing): string {
  return (
    `The proposed ${proposed} timing was corrected to WAIT because no current price was visible in ` +
    'the submitted images.'
  );
}

/** The correction for a proposal that needs the trigger reached, when no current price reaches it. */
function triggerNotReachedCorrection(proposed: Timing, triggerPrice: number): string {
  return (
    `The proposed ${proposed} timing was corrected to WAIT because no reported current price has ` +
    `the trigger level ${String(triggerPrice)} as the nearest level of its own image.`
  );
}

/** The correction for `NOW` proposed from an image that sits at the trigger without footprint data. */
function missingFootprintCorrection(currentPrice: number, triggerPrice: number): string {
  return (
    `The proposed NOW timing was corrected to WAIT because the image whose current price of ` +
    `${String(currentPrice)} sits at the trigger level ${String(triggerPrice)} reports no footprint ` +
    'level, so nothing shows the setup still live in its final bars.'
  );
}

/** The correction for `ON_RETEST` proposed while a current price already sits at the trigger. */
function alreadyAtTriggerCorrection(currentPrice: number, triggerPrice: number): string {
  return (
    `The proposed ON_RETEST timing was corrected to WAIT because the current price of ` +
    `${String(currentPrice)} already sits at the trigger level ${String(triggerPrice)}.`
  );
}

/**
 * The images whose own current price sits at the trigger, with that price, in submission order.
 *
 * The current price is carried back out because every correction that mentions one would otherwise
 * have to read the same observation a second time, and an image that reached this list is known to
 * carry a finite price.
 */
function imagesAtTrigger(
  images: ReadonlyArray<MappedImage>,
  triggerLevel: MappedLevel,
): ReadonlyArray<AtTriggerImage> {
  const atTrigger: AtTriggerImage[] = [];

  for (const image of images) {
    const price = image.currentPrice.price;
    if (isReadablePrice(price) && isAtTrigger(image, triggerLevel)) {
      atTrigger.push({ image, price });
    }
  }

  return atTrigger;
}

/** Whether one image yielded at least one footprint level, which is the `NOW` liveness evidence. */
function carriesFootprintLevel(image: MappedImage): boolean {
  return image.levels.some((level) => isFootprintLevelType(level.type));
}

/**
 * Decides the timing the evidence supports for a proposed one.
 *
 * `WAIT` is returned unchanged, because waiting asserts nothing about the price. A read that cites no
 * trigger level cannot have its timing judged at all, so any directional proposal becomes `WAIT`;
 * the downgrade rules run before this decision and leave such a read at `WAIT` already, which makes
 * the branch defensive rather than routine. The remaining proposals are then tested against every
 * image's own current price, and each survives only where the evidence shows what it claims:
 * `NOW` needs a current price at the trigger on an image that carries footprint levels, `ON_BREAK`
 * needs a current price at the trigger, and `ON_RETEST` needs no current price at it. Anything else
 * is `WAIT` plus one sentence naming the proposal and the evidence that overruled it.
 *
 * @param input - The proposal, the trigger level it is judged against and the submitted images.
 * @returns The timing the evidence supports and, where the proposal was overruled, the sentence that
 *   says what overruled it. Never an error, and never null.
 */
export function decideTiming(input: TimingInput): TimingDecision {
  const { proposed, triggerLevel, images } = input;

  if (proposed === 'WAIT') {
    return { timing: 'WAIT', correction: null };
  }

  if (triggerLevel === null) {
    return { timing: 'WAIT', correction: noTriggerLevelCorrection(proposed) };
  }

  if (currentPriceEvidence(images).length === 0) {
    return { timing: 'WAIT', correction: noCurrentPriceCorrection(proposed) };
  }

  const atTrigger = imagesAtTrigger(images, triggerLevel);
  const firstAtTrigger = atTrigger[0];

  switch (proposed) {
    case 'NOW': {
      const live = atTrigger.some((entry) => carriesFootprintLevel(entry.image));
      if (live) {
        return { timing: 'NOW', correction: null };
      }
      if (firstAtTrigger !== undefined) {
        return {
          timing: 'WAIT',
          correction: missingFootprintCorrection(firstAtTrigger.price, triggerLevel.price),
        };
      }
      return {
        timing: 'WAIT',
        correction: triggerNotReachedCorrection('NOW', triggerLevel.price),
      };
    }

    case 'ON_BREAK': {
      if (firstAtTrigger !== undefined) {
        return { timing: 'ON_BREAK', correction: null };
      }
      return {
        timing: 'WAIT',
        correction: triggerNotReachedCorrection('ON_BREAK', triggerLevel.price),
      };
    }

    case 'ON_RETEST': {
      if (firstAtTrigger === undefined) {
        return { timing: 'ON_RETEST', correction: null };
      }
      return {
        timing: 'WAIT',
        correction: alreadyAtTriggerCorrection(firstAtTrigger.price, triggerLevel.price),
      };
    }
  }
}
