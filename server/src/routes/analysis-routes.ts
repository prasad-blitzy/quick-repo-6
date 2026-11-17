/**
 * The analysis REST surface: the five routes the product exposes, mounted at `/api/v1/analyses`.
 *
 * This layer parses and delegates, and it carries no business rule of its own. The submission is
 * parsed by `multipart.ts` and handed to the domain service, which owns every bound, the deadline
 * and the document; the three read routes consult the repository port; the image route serves the
 * bytes the store retained so the analysis surface can re-display a stored screenshot. Nothing here
 * decides a price, a status or a message — a rejection arrives as the domain's `AppError` and leaves
 * through the shared error handler with its code, its status and its sentence intact.
 *
 * Two behaviours are deliberate. The list's `limit` is clamped rather than rejected — the error
 * table defines no code for a bad query value, so a non-numeric or non-positive value falls back to
 * the documented default and a value past the cap is clamped to it. And an unknown id is answered
 * `404 NOT_FOUND` whether it was never stored or failed the id guard, because the two must be
 * indistinguishable to a caller.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import {
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  type AnalysisDocument,
  type AnalysisListResponse,
} from '@trade-read/shared';

import type { AnalysisService } from '../domain/analysis-service.js';
import { AppError } from '../domain/errors.js';
import type { AnalysisRepository } from '../ports/analysis-repository.js';

import { pickKnownFields, uploadImages } from './multipart.js';

/** What the analysis router needs: the domain service, the store and the log. */
export interface AnalysisRouterDeps {
  /** Runs one submission end to end; the route sets the status and nothing else. */
  readonly service: AnalysisService;

  /**
   * The persistence port, read by the three read routes and the delete route.
   *
   * It owns its own logging: a removal already emits one line from the store, so the route does not
   * record it a second time.
   */
  readonly repository: AnalysisRepository;
}

/**
 * Wraps an async handler so a rejection reaches the shared error handler.
 *
 * Express 5 forwards a rejected promise on its own, but doing it here keeps the route's failure path
 * explicit and keeps this module independent of that behaviour.
 */
function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}

/**
 * Reads the page size a list request asks for.
 *
 * A value that is not a positive integer — absent, empty, `abc`, `0`, `-3`, `2.5` — resolves to the
 * documented default, and a value beyond the cap is clamped to the cap. Neither case is an error:
 * the request's error table defines no code for a bad query value.
 */
function resolveLimit(raw: unknown): number {
  const candidate = Array.isArray(raw) ? raw[0] : raw;

  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return HISTORY_LIMIT_DEFAULT;
  }

  const parsed = Number(candidate);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return HISTORY_LIMIT_DEFAULT;
  }

  return Math.min(parsed, HISTORY_LIMIT_MAX);
}

/**
 * Reads one path parameter as text.
 *
 * A route parameter arrives as text unless a pattern captured a repeated segment, and a path this
 * router did not match is not a case it has to invent an answer for, so anything else resolves to
 * the empty string — which the store's id guard then refuses with the same `NOT_FOUND` an absent
 * record gets.
 */
function pathParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Builds the analysis router.
 *
 * @param deps - The domain service, the store and the log.
 * @returns A router serving `/`, `/:id`, `/:id/images/:imageId` and the delete route, relative to the
 *   mount point `app.ts` chooses.
 */
export function createAnalysisRouter(deps: AnalysisRouterDeps): Router {
  const router = Router();

  // One submission, one analysis. The multipart parser enforces only the file count and a memory
  // guard; every other bound, the deadline and the persistence happen in the domain service.
  router.post(
    '/',
    uploadImages,
    asyncRoute(async (request, response) => {
      const uploaded = Array.isArray(request.files) ? request.files : [];
      const fields = pickKnownFields(request.body);

      const document = await deps.service.create({
        images: uploaded.map((file) => ({
          fileName: file.originalname,
          bytes: file.buffer,
        })),
        ...(fields.instrument === undefined ? {} : { instrument: fields.instrument }),
        ...(fields.context === undefined ? {} : { context: fields.context }),
      });

      response.status(200).json(document);
    }),
  );

  // The history page, newest first. An empty store is an empty array rather than a failure.
  router.get(
    '/',
    asyncRoute(async (request, response) => {
      const items: AnalysisDocument[] = await deps.repository.list(
        resolveLimit(request.query['limit']),
      );
      const body: AnalysisListResponse = { items };

      response.status(200).json(body);
    }),
  );

  // The retained bytes of one submitted screenshot, served with the type it was stored with so the
  // analysis surface can show the image beside the evidence that cites it.
  router.get(
    '/:id/images/:imageId',
    asyncRoute(async (request, response) => {
      const stored = await deps.repository.readImage(
        pathParam(request.params['id']),
        pathParam(request.params['imageId']),
      );

      if (stored === null) {
        throw AppError.notFound();
      }

      response.status(200).type(stored.contentType).send(Buffer.from(stored.bytes));
    }),
  );

  // One stored analysis.
  router.get(
    '/:id',
    asyncRoute(async (request, response) => {
      const document = await deps.repository.findById(pathParam(request.params['id']));

      if (document === null) {
        throw AppError.notFound();
      }

      response.status(200).json(document);
    }),
  );

  // Removal takes the document and its image bytes together, and answers `204` with no body.
  router.delete(
    '/:id',
    asyncRoute(async (request, response) => {
      const analysisId = pathParam(request.params['id']);

      if (!(await deps.repository.delete(analysisId))) {
        throw AppError.notFound();
      }

      response.status(204).end();
    }),
  );

  return router;
}
