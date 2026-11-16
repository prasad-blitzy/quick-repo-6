/**
 * Translation of one synthesised answer into the vocabulary the document and the client use.
 *
 * The model answers with the short codes of `shared/src/vocabulary.ts` — `NONE` for a `NO_TRADE`
 * read, `RETEST` for `ON_RETEST`, and so on — and those codes never leave the server. This module is
 * the single step that replaces them with their public values, by looking each one up in that shared
 * table rather than restating any of them, so a code added there without a mapping stops the build
 * instead of reaching a response as an unknown string.
 *
 * The answer it receives has already been checked against the shape and the vocabulary its schema
 * declares, by the layer that owns the retry (see `conformance.ts`); this module therefore validates
 * nothing and has no failure path. Prices are carried across exactly as the model reported them,
 * because resolution against the extracted levels is exact, and an answer that reads `t: "BREAK"`
 * comes out as the timing `ON_BREAK` — the mapping that turns the wire code into the public one. The
 * image ids are the one thing tidied here, and only of whitespace and repetition.
 *
 * It reads no environment, performs no I/O, reaches no network and holds no state.
 */

import {
  CONFIDENCE_CODE_TO_CONFIDENCE,
  SIDE_CODE_TO_SIDE,
  TIMING_CODE_TO_TIMING,
  type Confidence,
  type Side,
  type Timing,
} from '@trade-read/shared';

import type { SynthesisAnswer } from '../ports/vision-provider.js';

// The answer shape is the port's declaration — one line of compact JSON whose eight keys are the
// model's — and the schema that admits it and the adapter that parses it both build on that same
// declaration. It is imported rather than restated so a field added to the contract arrives here
// instead of leaving a second copy to drift, and re-exported because this module's callers and its
// suites name the type by this path.
export type { SynthesisAnswer };

/**
 * One synthesis answer with every code replaced by its public value.
 *
 * This is the shape the rest of the domain reasons about: the level references are still prices
 * here, and `server/src/domain/invariants.ts` is what resolves them against the extracted levels and
 * decides whether the read survives.
 */
export interface MappedSynthesis {
  /** The side the read takes. `NO_TRADE` is a complete answer, not a failure. */
  side: Side;
  /** When the read says its entry becomes actionable, before any correction the evidence forces. */
  timing: Timing;
  /** The price the read enters at, or null when it cites none. */
  entryPrice: number | null;
  /** The price the read is invalidated at, or null when it cites none. */
  invalidationPrice: number | null;
  /** The prices the read targets, in the order it listed them; possibly empty. */
  targetPrices: number[];
  /** How strongly the model said its evidence supports the read. */
  confidence: Confidence;
  /** The ids of the images the read claims to rest on, trimmed and deduplicated, in its own order. */
  sourceImageIds: string[];
  /** The model's own one-sentence summary, carried across unaltered. */
  summary: string;
}

/**
 * The image ids a read names, trimmed, with the empty entries dropped and each id kept once.
 *
 * A source id is compared for equality against the ids the submission minted, so a value carrying
 * surrounding whitespace, or nothing at all, names no image and would only make the read look better
 * sourced than it is; repetition is collapsed for the same reason, since what the sufficiency rule
 * counts is the distinct images the read rests on. The model's own order is kept, first occurrence
 * first, so resolving a price that two images report to the same one stays deterministic.
 *
 * The claim is not measured against the submitted images here: it is passed on exactly as the answer
 * made it, and `invariants.ts` is what tests it against the evidence and records an assumption when
 * it falls short.
 */
function normaliseSourceImageIds(sourceImageIds: readonly string[]): string[] {
  const named: string[] = [];
  const seen = new Set<string>();
  for (const sourceImageId of sourceImageIds) {
    const trimmed = sourceImageId.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    named.push(trimmed);
  }
  return named;
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
 * later mutates the answer it passed in. `k` keeps the model's order and any repetition, and `src` is
 * trimmed and deduplicated; neither list is filtered against the submitted images, because whether a
 * cited price or image holds up is the evidence's question, not the mapping's.
 */
export function mapSynthesis(answer: SynthesisAnswer): MappedSynthesis {
  return {
    side: SIDE_CODE_TO_SIDE[answer.s],
    timing: TIMING_CODE_TO_TIMING[answer.t],
    entryPrice: answer.e,
    invalidationPrice: answer.x,
    targetPrices: [...answer.k],
    confidence: CONFIDENCE_CODE_TO_CONFIDENCE[answer.c],
    sourceImageIds: normaliseSourceImageIds(answer.src),
    summary: answer.w,
  };
}

/**
 * Whether a read takes a side at all.
 *
 * `NO_TRADE` is a complete recommendation — it states that no setup among the supplied levels is
 * worth taking — so a caller asks this to know whether level references are expected, and never to
 * decide whether the analysis succeeded (rule 5).
 */
export function isDirectional(side: Side): boolean {
  return side !== 'NO_TRADE';
}
