/**
 * The analysis itself: one submission in, one stored document out.
 *
 * This is the only module that sequences the work, and the sequence is the contract:
 *
 * 1. Every upload bound is enforced before the first provider call, so a refused submission costs
 *    nothing and writes nothing.
 * 2. One extraction call per image, in submission order, because the synthesis is given those
 *    readings in the order the operator dropped them.
 * 3. Every image unreadable is a `422` rather than a read of nothing.
 * 4. Exactly one synthesis call, carrying every reading.
 * 5. The answer is mapped into the public vocabulary, the invariant passes decide what survives, and
 *    the document builder assembles the record.
 * 6. Only then is anything persisted, images first, so a timeout or a failed model call leaves no
 *    analysis behind at all.
 *
 * The thirty-second budget is one deadline created here and shared by every call of the analysis:
 * each call inherits what remains of it, and a call that would begin with nothing left fails as
 * `504 ANALYSIS_TIMEOUT` instead of starting. This module owns the clock reading and the ordering;
 * the bounds live in `image-validation.ts`, the mapping in the two mapper modules, the corrections
 * in `invariants.ts` and the document shape in `document-builder.ts`.
 *
 * It reaches no network and no filesystem itself: the model is the injected port and the store is
 * the injected repository.
 */

import {
  CONTEXT_MAX_CHARS,
  INSTRUMENT_MAX_CHARS,
  type AnalysisDocument,
} from '@trade-read/shared';

import type { Logger } from '../observability/logger.js';
import type { AnalysisRepository, StoredImage } from '../ports/analysis-repository.js';
import type { ImageExtraction, VisionProvider } from '../ports/vision-provider.js';

import { createDeadline } from './deadline.js';
import {
  buildAnalysisDocument,
  droppedLevelAssumption,
  unreadableImageAssumption,
} from './document-builder.js';
import { AppError, sanitizeSlug, toAppError } from './errors.js';
import { mapExtraction, type ExtractionMapResult } from './extraction-mapping.js';
import { analysisId as mintAnalysisId, imageId as mintImageId } from './ids.js';
import { validateImages, type SubmittedImage } from './image-validation.js';
import { applyInvariants } from './invariants.js';
import { extractionAnswerSchema, synthesisAnswerSchema } from './schemas.js';
import { mapSynthesis } from './synthesis-mapping.js';
import type { CurrentPriceEvidence } from './timing.js';

/** What the service needs: the two ports, the log and the configured model slug. */
export interface AnalysisServiceDeps {
  /** The only path to a model. The production adapter and the replay adapter are interchangeable. */
  readonly provider: VisionProvider;

  /** The only path to stored state; the document is handed over once it is complete. */
  readonly repository: AnalysisRepository;

  /** The server's single writer, used for one line per completed analysis and per failure. */
  readonly logger: Logger;

  /** The configured vision slug, recorded on the document so a stored read names its model. */
  readonly model: string;

  /** Millisecond clock, defaulted; injected so a suite can assert latency without waiting. */
  readonly now?: () => number;
}

/** One submission as the route hands it over: the parsed parts and the two optional text fields. */
export interface CreateAnalysisInput {
  /** The uploaded parts with their submitted names, exactly as multipart parsing left them. */
  readonly images: ReadonlyArray<SubmittedImage>;

  /** The optional instrument label; clamped here, and empty when the operator supplied nothing. */
  readonly instrument?: string;

  /** The optional free text; clamped here, and empty when the operator supplied nothing. */
  readonly context?: string;
}

/** The service the routes call. One method, because one submission creates one analysis. */
export interface AnalysisService {
  /**
   * Runs one analysis end to end and stores it.
   *
   * @param input - The submitted parts and the operator's optional text.
   * @returns The stored document, which is also the response body.
   * @throws {AppError} The code of whichever bound, provider failure or expiry stopped the analysis.
   *   Nothing is persisted when it throws.
   */
  create(input: CreateAnalysisInput): Promise<AnalysisDocument>;
}

/**
 * Clamps one optional text field to its documented cap, counting code points rather than UTF-16 code
 * units so a field of emoji cannot be split in half.
 *
 * Clamping rather than rejecting is deliberate: the request defines no error code for a long
 * instrument or context, so an over-long value is shortened to the bound instead of failing a
 * submission whose images are fine.
 */
function clampText(value: string | undefined, maxChars: number): string {
  if (value === undefined) {
    return '';
  }

  const trimmed = value.trim();
  const codePoints = Array.from(trimmed);

  return codePoints.length > maxChars ? codePoints.slice(0, maxChars).join('') : trimmed;
}

/**
 * Fails the analysis when the shared budget is spent.
 *
 * Checked before every call rather than only once, so the second image of a submission cannot start
 * a provider request on a budget the first one exhausted, and so a submission that spent its budget
 * on extraction reports the timeout before the synthesis call begins.
 */
function assertBudgetRemains(isExpired: boolean): void {
  if (isExpired) {
    throw AppError.analysisTimeout();
  }
}

/**
 * The current prices the timing decision may use: only the images that reported one.
 *
 * An image with no `LAST=` evidence contributes nothing here, which is what lets the decision tell
 * "no image reports a current price" apart from "a current price was reported elsewhere".
 */
function readableCurrentPrices(
  mappings: ReadonlyArray<ExtractionMapResult>,
): CurrentPriceEvidence[] {
  const prices: CurrentPriceEvidence[] = [];

  for (const mapping of mappings) {
    const { imageId, price } = mapping.image.currentPrice;

    if (price !== null) {
      prices.push({ imageId, price });
    }
  }

  return prices;
}

/**
 * The assumptions the extraction side owes the operator: every screenshot that could not be read,
 * and every reading whose unpriced entries were dropped rather than repaired.
 */
function readingAssumptions(mappings: ReadonlyArray<ExtractionMapResult>): string[] {
  const assumptions: string[] = [];

  for (const mapping of mappings) {
    if (mapping.image.status === 'UNREADABLE') {
      assumptions.push(unreadableImageAssumption(mapping.image));
    }

    if (mapping.droppedLevelCount > 0) {
      assumptions.push(droppedLevelAssumption(mapping.image.fileName, mapping.droppedLevelCount));
    }
  }

  return assumptions;
}

/**
 * Builds the analysis service.
 *
 * @param deps - The model port, the store port, the log and the configured slug.
 * @returns The service the analysis routes delegate to.
 */
export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService {
  const now = deps.now ?? Date.now;

  return {
    async create(input: CreateAnalysisInput): Promise<AnalysisDocument> {
      const analysisId = mintAnalysisId();
      const startedAt = now();

      try {
        // Bounds first: a rejected submission must not have talked to a model or touched the store.
        const validated = validateImages(input.images);
        const instrument = clampText(input.instrument, INSTRUMENT_MAX_CHARS);
        const context = clampText(input.context, CONTEXT_MAX_CHARS);

        // One id per part, minted before the loop so every reading, level and stored file agrees on
        // the image it belongs to.
        const parts = validated.map((image) => ({ image, imageId: mintImageId() }));

        // The one deadline for the whole analysis: it starts after validation, because the budget
        // bounds the model work rather than the upload.
        const deadline = createDeadline();

        const mappings: ExtractionMapResult[] = [];
        const readings: ImageExtraction[] = [];
        let extractionCallCount = 0;

        for (const part of parts) {
          assertBudgetRemains(deadline.isExpired());

          const result = await deps.provider.extract({
            image: {
              imageId: part.imageId,
              fileName: part.image.fileName,
              contentType: part.image.contentType,
              bytes: part.image.bytes,
            },
            instrument,
            context,
            remainingMs: deadline.remainingMs(),
            signal: deadline.signal(),
            schema: extractionAnswerSchema,
          });

          extractionCallCount += result.callCount;
          mappings.push(
            mapExtraction({
              validated: part.image,
              imageId: part.imageId,
              answer: result.answer,
            }),
          );
          readings.push({ imageId: part.imageId, answer: result.answer });
        }

        // Every screenshot unreadable is a complete answer, but not a trade read: there is no
        // evidence to synthesise from, so the submission fails with its own code and stores nothing.
        if (!mappings.some((mapping) => mapping.image.status === 'ANALYZED')) {
          throw AppError.noReadableImages();
        }

        assertBudgetRemains(deadline.isExpired());

        const synthesis = await deps.provider.synthesize({
          extractions: readings,
          instrument,
          context,
          remainingMs: deadline.remainingMs(),
          signal: deadline.signal(),
          schema: synthesisAnswerSchema,
        });

        const mapped = mapSynthesis(synthesis.answer);
        const levels = mappings.flatMap((mapping) => mapping.image.levels);

        const outcome = applyInvariants({
          mapped,
          levels,
          currentPrices: readableCurrentPrices(mappings),
          levelsByImage: new Map(
            mappings.map((mapping) => [mapping.image.imageId, mapping.image.levels] as const),
          ),
        });

        const document = buildAnalysisDocument({
          analysisId,
          createdAt: new Date(now()).toISOString(),
          instrument,
          context,
          images: mappings.map((mapping) => mapping.image),
          outcome,
          confidence: mapped.confidence,
          summary: mapped.summary,
          assumptions: readingAssumptions(mappings),
          modelUsage: {
            provider: 'openrouter',
            model: sanitizeSlug(deps.model),
            imageCallCount: extractionCallCount,
            synthesisCompletionTokens: synthesis.completionTokens ?? 0,
            latencyMs: Math.max(0, Math.round(now() - startedAt)),
          },
        });

        // Last, and only on the success path: the store writes the image bytes before the document,
        // so a stored analysis is always complete and a failed one leaves nothing behind.
        const storedImages: StoredImage[] = parts.map((part) => ({
          imageId: part.imageId,
          contentType: part.image.contentType,
          bytes: part.image.bytes,
        }));
        await deps.repository.save(document, storedImages);

        deps.logger.duration(
          {
            event: 'analysis_completed',
            analysisId,
            imageCount: extractionCallCount,
            tokens: synthesis.completionTokens,
            outcome: 'ok',
          },
          startedAt,
        );

        return document;
      } catch (error) {
        const failure = toAppError(error);

        deps.logger.error({
          event: 'analysis_failed',
          analysisId,
          outcome: 'error',
          reason: failure.code,
          status: failure.status,
        });

        throw failure;
      }
    },
  };
}
