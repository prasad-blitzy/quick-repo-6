/**
 * Translation of one synthesised answer into the vocabulary the document and the client use.
 *
 * The model answers with the two-character codes of `shared/src/vocabulary.ts` — `NONE` for a
 * `NO_TRADE` read, `RETEST` for `ON_RETEST`, and so on — and those codes never leave the server. This
 * module is the single step that replaces them with their public values, by looking each one up in
 * that shared table rather than restating any of them, so a code added there without a mapping stops
 * the build instead of reaching a response as an unknown string.
 *
 * The answer it receives has already been checked against the shape and the vocabulary its schema
 * declares, by the layer that owns the retry (see `conformance.ts`); this module therefore validates
 * nothing and has no failure path. Prices are carried across exactly as the model reported them,
 * because resolution against the extracted levels is exact, and an answer that reads `t: "BREAK"`
 * comes out as the timing `ON_BREAK` — the mapping that turns the wire code into the public one.
 *
 * It reads no environment, performs no I/O, reaches no network and holds no state.
 */

import {
  CONFIDENCE_CODE_TO_CONFIDENCE,
  SIDE_CODE_TO_SIDE,
  TIMING_CODE_TO_TIMING,
  type Confidence,
  type ConfidenceCode,
  type Side,
  type SynthesisSideCode,
  type SynthesisTimingCode,
  type Timing,
} from '@trade-read/shared';

/**
 * One synthesis answer line, in the short codes the model writes and a schema has already admitted.
 *
 * Every field is required: the line is a single JSON object whose keys are exactly these eight, and
 * an answer missing one of them or carrying a code outside the vocabulary is rejected before it can
 * become this type.
 */
export interface SynthesisAnswer {
  /** The side code: `LONG`, `SHORT`, or `NONE` for a read that recommends no trade. */
  readonly s: SynthesisSideCode;
  /** The timing code: `NOW`, `RETEST`, `BREAK` or `WAIT`. */
  readonly t: SynthesisTimingCode;
  /** The entry price the read cites, or null when it cites none. */
  readonly e: number | null;
  /** The invalidation price the read cites, or null when it cites none. */
  readonly x: number | null;
  /** The target prices the read cites, in the order it listed them; possibly empty. */
  readonly k: readonly number[];
  /** The confidence code: `H`, `M` or `L`. */
  readonly c: ConfidenceCode;
  /** The ids of the submitted images the read claims to rest on, as the model copied them. */
  readonly src: readonly string[];
  /** The one-sentence summary of the read, at most 140 characters. */
  readonly w: string;
}

/**
 * One synthesis answer with every code replaced by its public value.
 *
 * This is the shape the rest of the domain reasons about: the level references are still prices
 * here, and `server/src/domain/invariants.ts` is what resolves them against the extracted levels and
 * decides whether the read survives.
 */
export interface MappedSynthesis {
  /** The side the read takes. `NO_TRADE` is a complete answer, not a failure. */
  readonly side: Side;
  /** When the read says its entry becomes actionable, before any correction the evidence forces. */
  readonly timing: Timing;
  /** How strongly the model said its evidence supports the read. */
  readonly confidence: Confidence;
  /** The price the read enters at, or null when it cites none. */
  readonly entryPrice: number | null;
  /** The price the read is invalidated at, or null when it cites none. */
  readonly invalidationPrice: number | null;
  /** The prices the read targets, in the order it listed them; possibly empty. */
  readonly targetPrices: readonly number[];
  /** The ids of the images the read claims to rest on, in the order it listed them. */
  readonly sourceImageIds: readonly string[];
  /** The model's own one-sentence summary, carried across unaltered. */
  readonly summary: string;
}

/**
 * Translates one validated answer through the shared code tables.
 *
 * Each code is looked up in the table `shared/src/vocabulary.ts` owns, so no second copy of the
 * mapping exists and none can disagree with it. Prices and the summary are copied as reported: no
 * price is rounded, normalised or guessed, because a price that does not exactly equal an extracted
 * level's price is what the downgrade rules exist to catch, and a summary is the model's sentence
 * rather than the server's.
 *
 * `k` and `src` are copied into fresh arrays so the mapped result cannot be changed by a caller that
 * later mutates the answer it passed in, and `src` keeps the model's order and any repetition: what
 * the read claims to rest on is a fact about the answer, not something to tidy up here.
 */
export function mapSynthesis(answer: SynthesisAnswer): MappedSynthesis {
  return {
    side: SIDE_CODE_TO_SIDE[answer.s],
    timing: TIMING_CODE_TO_TIMING[answer.t],
    confidence: CONFIDENCE_CODE_TO_CONFIDENCE[answer.c],
    entryPrice: answer.e,
    invalidationPrice: answer.x,
    targetPrices: [...answer.k],
    sourceImageIds: [...answer.src],
    summary: answer.w,
  };
}
