/**
 * The timing decision: whether a proposed timing is supported by the price evidence, or corrected.
 *
 * A synthesis answer proposes when its entry becomes actionable — now, on a retest, on a break, or
 * not yet — but a proposal is only a claim about the chart. What decides it is the price each image
 * reported as its own current price, from the `LAST=` token of that image's extraction observation,
 * set against the levels extracted from the same image: a current price is "at the trigger" when the
 * trigger price is the extracted level nearest to it within its own image, so evidence the model's
 * wording could not produce either way. No branch of this module reads anything but the proposal
 * itself from the answer.
 *
 * The four proposals are held to what the evidence can actually show. `ON_BREAK` needs a current
 * price at the trigger, `ON_RETEST` needs the trigger not to be reached yet, and `NOW` needs both a
 * current price at the trigger and that price to come from an image which yielded at least one
 * footprint level — the closest a still screenshot comes to "live in the final bars". `WAIT` is
 * always valid, because waiting contradicts nothing. A proposal the evidence does not support is
 * corrected to `WAIT`, and the correction carries one sentence naming the proposal and the evidence
 * that failed it, so the document's assumptions say what the server changed and why.
 *
 * When there is no current price at all — no image reported a `LAST=` price, or only an image that
 * yielded no levels did — every directional proposal is corrected to `WAIT`, because nothing can be
 * confirmed without a price to confirm it against.
 *
 * It reads no environment, performs no I/O, reaches no network and holds no state: the same input
 * always yields the same decision.
 */

import { isFootprintLevelType, type Level, type Timing } from '@trade-read/shared';

/** One image's reported current price: the price its extraction observation stated as `LAST=` value. */
export interface CurrentPriceEvidence {
  /** The id of the image that reported the price. */
  readonly imageId: string;
  /** The price that image reported as its current price. */
  readonly price: number;
}

/** Everything the timing decision is allowed to look at, and nothing about the model's wording. */
export interface TimingInput {
  /** The timing the answer proposed, already translated into its public value. */
  readonly proposed: Timing;
  /** The price the timing is judged against: the entry price of the read, or null when it cites none. */
  readonly triggerPrice: number | null;
  /** Every current price reported by the submission, in submission order. */
  readonly currentPrices: readonly CurrentPriceEvidence[];
  /** Each image's extracted levels, keyed by image id; an absent or empty entry contributes no evidence. */
  readonly levelsByImage: ReadonlyMap<string, readonly Level[]>;
}

/** The timing the evidence supports, with the sentence a correction owes when it does not support the proposal. */
export interface TimingDecision {
  /** The timing to record: the proposal where the evidence supports it, `WAIT` where it does not. */
  readonly timing: Timing;
  /** One sentence naming the proposal and the evidence that failed it, or null when nothing was corrected. */
  readonly correction: string | null;
}

/** One current price together with the levels extracted from the image that reported it. */
interface PriceContext {
  readonly evidence: CurrentPriceEvidence;
  readonly levels: readonly Level[];
}

/**
 * The extracted level nearest to a price within one image, ties broken by the lower price.
 *
 * An exact price always wins, because its distance is zero; where two levels are equidistant — the
 * price sits midway between them — the lower price is taken, so the same evidence always selects the
 * same level. A level whose price is not a finite number is skipped rather than treated as distant,
 * and an image with no readable level yields null, which no trigger price can equal.
 */
function nearestLevel(price: number, levels: readonly Level[]): Level | null {
  let nearest: Level | null = null;
  for (const level of levels) {
    if (!Number.isFinite(level.price)) {
      continue;
    }
    if (nearest === null) {
      nearest = level;
      continue;
    }
    const distance = Math.abs(level.price - price);
    const nearestDistance = Math.abs(nearest.price - price);
    if (distance < nearestDistance || (distance === nearestDistance && level.price < nearest.price)) {
      nearest = level;
    }
  }
  return nearest;
}

/** Whether one image's current price has the trigger price as its nearest extracted level. */
function isAtTrigger(triggerPrice: number, context: PriceContext): boolean {
  const nearest = nearestLevel(context.evidence.price, context.levels);
  return nearest !== null && nearest.price === triggerPrice;
}

/**
 * The current prices this decision can use, each with the levels of its own image.
 *
 * An image that yielded no level, or that the extraction marked unreadable, carries no evidence of
 * its own: its price cannot be nearest to a trigger that does not exist there. A price that is not a
 * finite number is dropped for the same reason.
 */
function usableEvidence(input: TimingInput): readonly PriceContext[] {
  const usable: PriceContext[] = [];
  for (const evidence of input.currentPrices) {
    if (!Number.isFinite(evidence.price)) {
      continue;
    }
    const levels = input.levelsByImage.get(evidence.imageId);
    if (levels === undefined || levels.length === 0) {
      continue;
    }
    usable.push({ evidence, levels });
  }
  return usable;
}

/** The correction for a proposal made when no image reported a current price that can be read. */
function noEvidenceCorrection(proposed: Timing): string {
  return (
    `The proposed ${proposed} timing was corrected to WAIT because no current-price evidence exists ` +
    'for any image carrying levels.'
  );
}

/** The correction for `NOW` proposed without a current price at the trigger on a footprint image. */
const NOW_CORRECTION =
  'The proposed NOW timing was corrected to WAIT because no current price sitting at the trigger ' +
  'is reported by an image carrying footprint levels.';

/** The correction for `ON_BREAK` proposed by a read that cites no entry price to break. */
const BREAK_WITHOUT_TRIGGER_CORRECTION =
  'The proposed ON_BREAK timing was corrected to WAIT because the read cites no trigger price to break.';

/** The correction for `ON_BREAK` proposed with no current price at the trigger it cites. */
function breakCorrection(triggerPrice: number): string {
  return (
    `The proposed ON_BREAK timing was corrected to WAIT because no current price sits at the trigger ` +
    `price ${String(triggerPrice)}.`
  );
}

/** The correction for `ON_RETEST` proposed while a current price already sits at the trigger. */
function retestCorrection(currentPrice: number, triggerPrice: number): string {
  return (
    `The proposed ON_RETEST timing was corrected to WAIT because the current price ${String(currentPrice)} ` +
    `already sits at the trigger price ${String(triggerPrice)}.`
  );
}

/**
 * Decides the timing the evidence supports for a proposed one.
 *
 * `WAIT` is returned with no correction: waiting claims no price is being tested, so no evidence can
 * contradict it. Each other proposal is checked against every usable current price, and survives only
 * where the evidence shows what it claims; otherwise the decision is `WAIT` plus one sentence naming
 * the proposal and the evidence, which the caller records among the document's assumptions.
 */
export function decideTiming(input: TimingInput): TimingDecision {
  const evidence = usableEvidence(input);

  if (evidence.length === 0) {
    return input.proposed === 'WAIT'
      ? { timing: 'WAIT', correction: null }
      : { timing: 'WAIT', correction: noEvidenceCorrection(input.proposed) };
  }

  const triggerPrice = input.triggerPrice;

  switch (input.proposed) {
    case 'WAIT':
      return { timing: 'WAIT', correction: null };
    case 'NOW': {
      const live = triggerPrice !== null && evidence.some(
        (context) =>
          isAtTrigger(triggerPrice, context) &&
          context.levels.some((level) => isFootprintLevelType(level.type)),
      );
      return live
        ? { timing: 'NOW', correction: null }
        : { timing: 'WAIT', correction: NOW_CORRECTION };
    }
    case 'ON_BREAK': {
      if (triggerPrice === null) {
        return { timing: 'WAIT', correction: BREAK_WITHOUT_TRIGGER_CORRECTION };
      }
      const tested = evidence.some((context) => isAtTrigger(triggerPrice, context));
      return tested
        ? { timing: 'ON_BREAK', correction: null }
        : { timing: 'WAIT', correction: breakCorrection(triggerPrice) };
    }
    case 'ON_RETEST': {
      if (triggerPrice === null) {
        return { timing: 'ON_RETEST', correction: null };
      }
      const reached = evidence.find((context) => isAtTrigger(triggerPrice, context));
      return reached === undefined
        ? { timing: 'ON_RETEST', correction: null }
        : {
            timing: 'WAIT',
            correction: retestCorrection(reached.evidence.price, triggerPrice),
          };
    }
  }
}
