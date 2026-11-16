/*
 * The history surface: every stored analysis, newest first, each row openable or deletable in
 * place, with the fixed disclaimer always beneath the list.
 *
 * Three rules shape this file. The order is the server's — `AnalysisListResponse.items` arrives
 * newest first from the store and is rendered exactly as received, so nothing here sorts,
 * reverses or re-orders by instrument, side or id. A deletion is confirmed in place: the first
 * press only arms the row, and no request leaves the process until the confirmation is pressed,
 * which is why no modal or native dialog is involved. And this list is a recommendation surface,
 * because every row prints a side and a timing, so the disclaimer renders in every state —
 * loading, populated, empty and failed — and never conditionally on there being rows.
 *
 * The component reaches the API only through `api/analysis-api.ts` and shows failures only
 * through `components/error-notice.tsx`, so it owns no transport, no message sentence and no
 * retry: a failed read or delete becomes state, the notice replaces the pending indicator, and
 * the control that re-reads the list is the caller's own `reload`.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { HISTORY_LIMIT_DEFAULT } from '@trade-read/shared';
import type { AnalysisDocument, ErrorCode } from '@trade-read/shared';

import { ApiError, deleteAnalysis, listAnalyses } from '../../api/analysis-api';
import { messageForCode, shouldReturnToHistory } from '../../api/errors';
import { Disclaimer } from '../../components/disclaimer';
import ErrorNotice from '../../components/error-notice';

/** The props the application passes: where a row opens, and how the surface is left behind. */
export interface HistorySurfaceProps {
  /** Opens one stored analysis; the surface performs no navigation of its own. */
  onOpenAnalysis: (analysisId: string) => void;
  /** Leaves for the upload surface, offered beside the list. */
  onNewAnalysis: () => void;
}

/** A failure the surface shows: the code the interface acts on and the one sentence it prints. */
interface HistoryError {
  readonly code: ErrorCode;
  readonly message: string;
}

/**
 * The text a stored analysis shows for its instrument when none was submitted.
 *
 * Stated once here rather than at the markup, so the empty case cannot render as an empty cell
 * that reads as a missing value to a screen reader.
 */
const NO_INSTRUMENT = 'No instrument';

/**
 * Turns whatever a rejected call carried into the surface's error state.
 *
 * The transport rejects with `ApiError` for every failure it can describe — a non-2xx response,
 * an unreadable body, a request that never arrived — and that class already holds the code and
 * the sentence the interface shows, so it is used as it stands. Anything else is unexpected and
 * becomes the fallback code with the shared table's sentence for it, which keeps one sentence per
 * code and keeps a raw `TypeError` out of the tree.
 *
 * @param cause - The rejection reason of a list or delete call.
 * @returns The code and sentence the notice renders.
 */
function toHistoryError(cause: unknown): HistoryError {
  if (cause instanceof ApiError) {
    return { code: cause.code, message: cause.message };
  }

  return { code: 'INTERNAL_ERROR', message: messageForCode('INTERNAL_ERROR') };
}

/**
 * The history surface.
 *
 * The list is read once on mount through `listAnalyses` at the shared default page size, and
 * again whenever the notice's resubmit control asks for it. Each read carries a generation number
 * so a slower earlier answer cannot overwrite a newer one — which is also what makes React 19
 * `StrictMode`'s double effect run harmless: the second read wins and the first is discarded
 * rather than appended.
 *
 * A row's removal is local state, not a re-read: the server has already answered `204`, so the
 * row that named that analysis is dropped from the list and the list needs no refetch. When the
 * last row goes the empty state takes its place.
 */
export default function HistorySurface({ onOpenAnalysis, onNewAnalysis }: HistorySurfaceProps) {
  const headingId = useId();

  /** The stored analyses, newest first, or `null` before the first successful read. */
  const [items, setItems] = useState<AnalysisDocument[] | null>(null);
  /** The failure being shown, from either a list read or a delete. */
  const [error, setError] = useState<HistoryError | null>(null);
  /** Whether a list read is in flight, so the pending indicator shows until one settles. */
  const [pending, setPending] = useState(true);
  /** The one row armed for deletion; no request has been made while this names it. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** The row whose deletion is in flight, so its confirmation control can report itself busy. */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /* The newest read issued. Compared after each answer so only the latest read is applied. */
  const readGeneration = useRef(0);

  /**
   * Reads the history page. Stable across renders, because the mount effect depends on it and the
   * notice's resubmit control calls it directly.
   */
  const reload = useCallback(async (): Promise<void> => {
    const generation = readGeneration.current + 1;
    readGeneration.current = generation;

    setPending(true);
    setError(null);

    try {
      const response = await listAnalyses(HISTORY_LIMIT_DEFAULT);

      if (readGeneration.current !== generation) {
        return;
      }

      setItems(response.items);
    } catch (cause) {
      if (readGeneration.current !== generation) {
        return;
      }

      setError(toHistoryError(cause));
    } finally {
      if (readGeneration.current === generation) {
        setPending(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Arms one row for deletion. Nothing is requested until the confirmation is pressed. */
  const requestDelete = useCallback((analysisId: string): void => {
    setConfirmingId(analysisId);
  }, []);

  /** Closes the confirmation with no request, leaving the row exactly as it was. */
  const cancelDelete = useCallback((): void => {
    setConfirmingId(null);
  }, []);

  /**
   * Deletes one stored analysis and drops its row.
   *
   * A successful delete removes that analysis from the list without a refetch. A failed one keeps
   * every row it had, because a failure says nothing about what the store holds — with one
   * exception: `NOT_FOUND` means the record is already gone, so `shouldReturnToHistory` (true for
   * that code alone) removes the row as well, and the notice then explains it. Either way the
   * failure becomes the surface's error state, so the notice replaces the pending indicator
   * instead of the row spinning.
   *
   * @param analysisId - The identifier of the row that was confirmed.
   */
  const confirmDelete = useCallback(async (analysisId: string): Promise<void> => {
    const dropRow = (): void => {
      setItems((current) =>
        current === null ? current : current.filter((document) => document.analysisId !== analysisId),
      );
    };

    setDeletingId(analysisId);
    setError(null);

    try {
      await deleteAnalysis(analysisId);
      dropRow();
    } catch (cause) {
      const failure = toHistoryError(cause);
      setError(failure);

      if (shouldReturnToHistory(failure.code)) {
        dropRow();
      }
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }, []);

  const showingPending = pending && items === null;
  const showingEmpty = !showingPending && items !== null && items.length === 0;
  const showingList = !showingPending && items !== null && items.length > 0;

  return (
    <section className="surface" aria-labelledby={headingId}>
      <h2 className="surface__title" id={headingId}>
        History
      </h2>

      <button type="button" className="button" onClick={onNewAnalysis}>
        Start a new analysis
      </button>

      {showingPending ? (
        <p className="pending-indicator" role="status">
          Loading history…
        </p>
      ) : null}

      {error !== null ? (
        <ErrorNotice
          code={error.code}
          message={error.message}
          onResubmit={() => {
            void reload();
          }}
        />
      ) : null}

      {showingEmpty ? <p className="empty-state">No analyses yet.</p> : null}

      {showingList ? (
        <ul className="history-list">
          {items.map((document) => {
            const isConfirming = confirmingId === document.analysisId;
            const isDeleting = deletingId === document.analysisId;

            return (
              <li
                key={document.analysisId}
                className="history-item"
                data-analysis-id={document.analysisId}
              >
                <div className="history-item__meta">
                  <span className="history-item__instrument">
                    {document.instrument === '' ? NO_INSTRUMENT : document.instrument}
                  </span>
                  {/* The stored ISO-8601 string, verbatim: no locale, timezone or relative
                      formatting, so the row reads the same on every machine. */}
                  <time className="history-item__time" dateTime={document.createdAt}>
                    {document.createdAt}
                  </time>
                  <span className="history-item__side">{document.recommendation.side}</span>
                  <span className="history-item__timing">{document.recommendation.timing}</span>
                </div>

                <div className="history-item__actions">
                  {isConfirming ? (
                    <div className="history-item__confirm">
                      <button
                        type="button"
                        className="history-item__delete"
                        aria-label={`Confirm delete ${document.analysisId}`}
                        aria-busy={isDeleting}
                        disabled={isDeleting}
                        onClick={() => {
                          void confirmDelete(document.analysisId);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="history-item__open"
                        aria-label={`Cancel delete ${document.analysisId}`}
                        onClick={cancelDelete}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="history-item__open"
                        aria-label={`Open analysis ${document.analysisId}`}
                        onClick={() => {
                          onOpenAnalysis(document.analysisId);
                        }}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="history-item__delete"
                        aria-label={`Delete analysis ${document.analysisId}`}
                        onClick={() => {
                          requestDelete(document.analysisId);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Disclaimer />
    </section>
  );
}
