/**
 * The persistence boundary of the server: the only way any route reaches a stored analysis or
 * the image bytes it retained.
 *
 * This module declares shapes and nothing else. It performs no filesystem work, builds no path,
 * serialises nothing and logs nothing; the filesystem implementation lives behind this interface
 * in `server/src/store/file-system-analysis-repository.ts` and is injected into the route layer,
 * so an object-store implementation can replace it without a route noticing. The port declares no
 * error type of its own: an id that fails its pattern is refused with the `NOT_FOUND` code of the
 * shared error table in `shared/src/errors.ts`, which the implementation raises as the domain's
 * `AppError`.
 *
 * Two rules bind every implementation, stated here because a second implementation has to honour
 * them as well:
 *
 * - Write order. Image bytes are written first and the document last, the document under a
 *   temporary name that is then renamed into place, so a half-written analysis is never observable
 *   and two concurrent submissions cannot collide. Deletion removes the document and then the
 *   image directory.
 * - Id guard. An `analysisId` is the directory name of its analysis beneath `DATA_DIR` and an
 *   `imageId` is the stored file name of its bytes, so every id arrives from a URL path and an
 *   implementation matches it against its pattern before joining any path: no path is ever built
 *   from an id that fails its pattern, which is what keeps a crafted id from escaping the data
 *   directory.
 *
 * An id that fails its pattern is not an unanswerable case: it is answered exactly as an id that
 * was never stored. An id that passes its pattern and matches no record is an ordinary answer —
 * `null` from `findById` and from `readImage`, `false` from `delete`, which the route turns into
 * `404 NOT_FOUND`. A refused id is rejected with the shared `NOT_FOUND`, and the route answers it
 * with that same `404 NOT_FOUND`: one code, one status and one generic sentence, carrying neither
 * the id nor a path, so the two are indistinguishable to a caller.
 *
 * The port carries no business rule: `save` persists the document it is given verbatim, and
 * `AnalysisDocument` is defined once in `shared/src/contract.ts`, never narrowed or extended here.
 */
import type { AnalysisDocument } from '@trade-read/shared';

/**
 * The bytes of one submitted image, exactly as the store should keep them.
 *
 * `bytes` are the image as received and already validated: downscaled by the browser, then checked
 * against the count, size, type and dimension bounds by the server. The port neither sniffs the
 * type nor re-encodes the bytes, and `contentType` is the type sniffed from the magic bytes before
 * `save` is called, so the server never derives a content type from a file name. An implementation
 * writes these bytes before the document that cites them.
 */
export interface StoredImage {
  imageId: string;
  /** The type the stored bytes are served with, sniffed from the bytes themselves. */
  contentType: string;
  /** The image file's bytes, written before the document whose images cite them. */
  bytes: Uint8Array;
}

/**
 * One stored image as {@link AnalysisRepository.readImage} returns it.
 *
 * `contentType` is the type stored when the image was saved rather than one re-derived at read
 * time, so the image route can set the response content type without inspecting the bytes. `bytes`
 * is a `Uint8Array` rather than a runtime-specific type, so the route serialises it directly and
 * the port does not bind its consumers to Node.
 */
export interface StoredImageBytes {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Persists completed analyses and their image bytes.
 *
 * The five operations below are exactly what the REST surface needs — one per storable effect —
 * and no route reaches persisted state any other way.
 */
export interface AnalysisRepository {
  /**
   * Stores one completed analysis with the image bytes its `images[]` cite.
   *
   * The document is persisted verbatim, because building and correcting it is the domain's work,
   * not the store's. Bytes are written first and the document last, atomically, so a reader sees
   * either a complete analysis or none of it. An id that fails its pattern is refused with the
   * shared `NOT_FOUND` before any path is built, rather than turned into one.
   */
  save(document: AnalysisDocument, images: ReadonlyArray<StoredImage>): Promise<void>;

  /**
   * Returns the stored analysis with this id, or `null` when none exists.
   *
   * `null` rather than a throw keeps the missing case out of the exception path: the route answers
   * `404 NOT_FOUND` from it. An id that fails its pattern guard is rejected instead, before any
   * path is built, with the shared `NOT_FOUND` that the route answers with that same
   * `404 NOT_FOUND`, so a crafted id and an id that was never stored are answered alike.
   */
  findById(analysisId: string): Promise<AnalysisDocument | null>;

  /**
   * Returns up to `limit` stored analyses, newest first.
   *
   * The caller clamps `limit` to the documented page bounds before calling, so the port neither
   * defaults nor clamps it; an empty store yields an empty array rather than a throw.
   */
  list(limit: number): Promise<AnalysisDocument[]>;

  /**
   * Removes one stored analysis together with its image bytes.
   *
   * Resolves `true` when a document was removed and `false` when there was nothing to remove, so
   * the route can answer `204` or `404 NOT_FOUND`. A `false` result leaves the store untouched. An
   * id that fails its pattern guard never becomes a path either: it is rejected with the shared
   * `NOT_FOUND`, which the route answers with the same `404 NOT_FOUND` an absent record gets, and
   * the store is left as the `false` case leaves it.
   */
  delete(analysisId: string): Promise<boolean>;

  /**
   * Returns the stored bytes of one image and the content type they were saved with.
   *
   * Resolves `null` for an unknown analysis and for an image id that analysis does not cite, so
   * the analysis surface can re-display a stored screenshot after a restart while the route
   * answers `404 NOT_FOUND` for anything it may not serve. Either id failing its pattern guard is
   * rejected before a path is built, with the shared `NOT_FOUND` behind that same `404 NOT_FOUND`.
   * Reading is scoped to one analysis: the bytes inherit the id guard and the deletion semantics of
   * the document.
   */
  readImage(analysisId: string, imageId: string): Promise<StoredImageBytes | null>;
}
