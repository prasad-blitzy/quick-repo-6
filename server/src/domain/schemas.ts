/**
 * The analysis contract as runtime schemas: the two model answer lines, the operator's request
 * fields, and the document the server returns and stores.
 *
 * The two answer-line schemas are the schema half of the one-line conformance check. They travel
 * with a provider request, and the adapter that owns the retry applies them to the provider's text
 * through `conformance.ts`; an answer that fails one of them is a conformance failure like a
 * malformed line, so it earns that call exactly one silent retry and then the analysis fails with
 * `ANALYSIS_FAILED`. Nothing downstream of the port re-validates an answer, because nothing
 * downstream can be handed one that failed here. Every code a line may carry is the shared
 * vocabulary's rather than a private list, so a value outside that vocabulary is rejected at this
 * boundary and no code from the model's vocabulary can reach a document.
 *
 * Both answer schemas are declared over the port's own answer types, and the document schema over
 * the shared contract's own document type, so what each parses to is exactly what its consumer
 * already handles and no answer or document shape exists twice.
 *
 * Every object here is strict. For the two answer lines that means an extra key is a conformance
 * failure rather than a value quietly dropped, because the line is a fixed compact shape the
 * completion ceiling was set for. For the document it is what keeps a price out of
 * `recommendation` and a model code out of a stored record: an unexpected key fails instead of
 * disappearing, so the two structural invariants of the contract are checkable from a finished
 * response.
 *
 * This module imports zod and the shared contract and nothing else. It reads no environment,
 * performs no I/O, holds no state and defines no error type: a violation is the schema's own
 * failure, and the layer that ran it decides what that means.
 */

import { z } from 'zod';

import {
  CONFIDENCE_CODES,
  CONFIDENCES,
  DISCLAIMER,
  EXTRACTION_CODES,
  IMAGE_STATUSES,
  LEVEL_TYPES,
  OBSERVATION_MAX_CHARS,
  SIDES,
  SUMMARY_MAX_CHARS,
  SYNTHESIS_SIDE_CODES,
  SYNTHESIS_TIMING_CODES,
  TIMINGS,
  type AnalysisDocument,
  type AnalysisImage,
  type Level,
  type ModelUsage,
  type Rationale,
  type Recommendation,
} from '@trade-read/shared';

import type {
  ExtractionAnswer,
  ExtractionReadability,
  SynthesisAnswer,
} from '../ports/vision-provider.js';

// The model answer lines.

/**
 * The two values the extraction's readability field may hold, restated as a tuple because the port
 * declares `ExtractionReadability` as a type rather than as a vocabulary list. `satisfies` makes the
 * build stop if the two ever disagree, so the tuple cannot drift from the union it mirrors.
 */
const EXTRACTION_READABILITY = [
  'OK',
  'BLANK',
] as const satisfies readonly ExtractionReadability[];

/**
 * One image's extraction line: `{"l":[[<price>,"<code>"],...],"o":"<observation>","r":"OK|BLANK"}`.
 *
 * `l` holds the level pairs in the order the model reported them, price first — a bare finite
 * number, with no currency symbol, thousands separator or unit — paired with a code from the shared
 * vocabulary. A price the model could not read is left out of the line rather than guessed, because
 * a level without a readable price is dropped downstream and never estimated (rule 6); what this
 * schema guarantees is that nothing but a real number is admitted as a price.
 *
 * `o` opens with `LAST=<price>`, the price visible at the image's final bar, or with `LAST=NA`. That
 * token is the current-price evidence the timing decision rests on, which is why its 80-character
 * cap is a conformance rule and not a formatting preference: an over-long observation fails the
 * schema and earns the call its retry, and is never truncated here, since truncating could cut the
 * very token the decision reads.
 *
 * `r` says whether the image held a chart at all. `BLANK` is a normal outcome for a submitted
 * screenshot — the image is recorded as unreadable and its reading discarded — not an error.
 */
export const extractionAnswerSchema: z.ZodType<ExtractionAnswer> = z.strictObject({
  l: z.array(z.tuple([z.number().finite(), z.enum(EXTRACTION_CODES)])),
  o: z.string().max(OBSERVATION_MAX_CHARS),
  r: z.enum(EXTRACTION_READABILITY),
});

/**
 * The synthesis line: `{"s","t","e","x","k","c","src","w"}`.
 *
 * Every code is the model's short one — `NONE` for a read that recommends no trade, `RETEST` for a
 * timing that waits for price to come back to the entry — and the domain translates it through the
 * shared vocabulary while it assembles the document, so no code reaches the client or the stored
 * record.
 *
 * `e` and `x` are the proposed entry and invalidation prices, or null when the read proposes none,
 * and `k` holds the proposed targets in the order they were listed. They are references in the
 * making: each resolves to an extracted level only by exact numeric equality, so a price no
 * submitted image reported resolves to nothing and voids the read (rule 2). That repair belongs to
 * the domain, so this schema admits any finite number and judges none of them here.
 *
 * `k` and `src` are allowed to be empty on purpose. A directional read with fewer than two source
 * images, or with no targets at all, is downgraded to `NO_TRADE`/`WAIT` with the cause recorded in
 * `assumptions[]` — a complete `200` result (rule 5), never a failure — so a minimum length here
 * would turn a legitimate downgrade into a `502`. `w` is the one supporting sentence, capped at 140
 * characters for the same reason the observation is capped at 80.
 */
export const synthesisAnswerSchema: z.ZodType<SynthesisAnswer> = z.strictObject({
  s: z.enum(SYNTHESIS_SIDE_CODES),
  t: z.enum(SYNTHESIS_TIMING_CODES),
  e: z.number().finite().nullable(),
  x: z.number().finite().nullable(),
  k: z.array(z.number().finite()),
  c: z.enum(CONFIDENCE_CODES),
  src: z.array(z.string()),
  w: z.string().max(SUMMARY_MAX_CHARS),
});

// The operator's request fields.

/**
 * The two optional text fields a submission may carry, and nothing else.
 *
 * `instrument` and `context` reach the model as labelled data beneath the built-in instructions, so
 * they are typed here and bounded nowhere: the error table is closed and holds no code for an
 * over-long value, and the 16- and 500-character caps are applied as a clamp by the analysis
 * service, the single place that behaviour lives (D12). A `maxLength` here would reject a request
 * the error table never authorised rejecting.
 *
 * A field outside these two is stripped rather than refused, matching the multipart field filter
 * that drops everything except `images`, `instrument` and `context` before the domain sees a
 * request (D13). No instruction field exists to accept, drop or act on.
 */
export const analysisRequestFieldsSchema = z.object({
  instrument: z.string().optional(),
  context: z.string().optional(),
});

// The analysis document, in the pieces `AnalysisDocument` is made of. Each piece is declared over
// its contract type, so a difference between a schema and the shape every consumer imports is a
// compile error rather than a rejected response at runtime.

/**
 * One level: a price reported by one submitted image, labelled with the kind of level it is.
 *
 * This is the only place a price appears in a document, which is what makes "every price present
 * resolves to a level extracted from a submitted image" checkable from a finished response.
 */
const levelSchema: z.ZodType<Level> = z.strictObject({
  levelId: z.string(),
  price: z.number().finite(),
  type: z.enum(LEVEL_TYPES),
  imageId: z.string(),
  note: z.string().optional(),
});

// The fields every submitted image carries, whatever the reading made of it. They are spread into
// both status branches so the two shapes cannot drift apart.
const imageFields = {
  imageId: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
};

/**
 * The two statuses the contract allows, taken from its own tuple so this schema cannot disagree
 * with `IMAGE_STATUSES`.
 */
const [ANALYZED_STATUS, UNREADABLE_STATUS] = IMAGE_STATUSES;

/**
 * One submitted screenshot as the analysis recorded it.
 *
 * `status` carries the contract's two values: `ANALYZED` when the extraction returned a level at a
 * readable price, `UNREADABLE` when the image held no chart (`r: "BLANK"`) or no readable price at
 * all (D9). The reason travels only with the unreadable case, so the two statuses form a
 * discriminated union rather than one shape with an optional field: an analysed image carrying an
 * error and an unreadable image carrying no reason are both structural failures.
 */
const imageSchema: z.ZodType<AnalysisImage> = z.discriminatedUnion('status', [
  z.strictObject({
    ...imageFields,
    status: z.literal(ANALYZED_STATUS),
    // An optional property admits an explicit `undefined` in TypeScript, so the key may stand empty
    // here; what this branch refuses is a reason attached to an image that was read.
    extractionError: z.never().optional(),
  }),
  z.strictObject({
    ...imageFields,
    status: z.literal(UNREADABLE_STATUS),
    extractionError: z.string().min(1),
  }),
]);

/**
 * The trade read, expressed entirely as references to levels.
 *
 * No field here can hold a price, and the object is strict so a price added under any name is a
 * failure rather than a key silently stripped: a consumer reaches a displayed price only through
 * `levels[]`, so no price can exist that a submitted image did not report (rule 1). A
 * `NO_TRADE`/`WAIT` read carries null references and no targets, and is a complete result.
 */
const recommendationSchema: z.ZodType<Recommendation> = z.strictObject({
  side: z.enum(SIDES),
  timing: z.enum(TIMINGS),
  triggerLevelId: z.string().nullable(),
  entryLevelId: z.string().nullable(),
  invalidationLevelId: z.string().nullable(),
  targetLevelIds: z.array(z.string()),
  confidence: z.enum(CONFIDENCES),
  summary: z.string().max(SUMMARY_MAX_CHARS),
});

/** One entry of the evidence behind a read: the claim, the image it rests on, the levels it cites. */
const rationaleSchema: z.ZodType<Rationale> = z.strictObject({
  claim: z.string(),
  imageId: z.string(),
  levelIds: z.array(z.string()),
});

/**
 * What the analysis cost and which instructions produced it.
 *
 * `provider` is a literal rather than a string, so a document can carry no provider but the one this
 * application uses. `model` comes from configuration and `promptVersion` from the versioned
 * instruction library at request time; neither is ever read from a request.
 */
const modelUsageSchema: z.ZodType<ModelUsage> = z.strictObject({
  provider: z.literal('openrouter'),
  model: z.string(),
  promptVersion: z.string(),
  imageCallCount: z.number().int().nonnegative(),
  synthesisCompletionTokens: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(),
});

/**
 * A completed analysis: the create response and the persisted record, byte for byte.
 *
 * The response path validates every document against this schema before it is returned or written,
 * so three invariants hold of anything a consumer receives: `recommendation` holds level references
 * and no price, `levels[]` is the only place a price appears, and `images[].status` is the
 * contract's two-valued union with its reason only on the unreadable case. `disclaimer` is the fixed
 * sentence itself rather than any string, so a surface cannot render anything else, and
 * `createdAt` is the ISO-8601 UTC instant the contract declares — the format the document builder
 * writes with `new Date().toISOString()`, which a date without a time or a local offset is not.
 */
export const analysisDocumentSchema: z.ZodType<AnalysisDocument> = z.strictObject({
  analysisId: z.string(),
  createdAt: z.iso.datetime(),
  instrument: z.string(),
  context: z.string(),
  images: z.array(imageSchema),
  levels: z.array(levelSchema),
  recommendation: recommendationSchema,
  rationale: z.array(rationaleSchema),
  assumptions: z.array(z.string()),
  modelUsage: modelUsageSchema,
  disclaimer: z.literal(DISCLAIMER),
});
