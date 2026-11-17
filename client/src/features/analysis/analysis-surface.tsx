/*
 * The analysis surface: one stored trade read rendered in full, and the only place a person reads
 * the recommendation, the levels it cites and the evidence behind it.
 *
 * Two shapes of input arrive from `App.tsx` and both must work. When the surface is handed the
 * document `POST /api/v1/analyses` just returned — the very analysis the operator asked for — it
 * renders it directly and reads nothing, so a fresh read never costs a second trip to the server.
 * Otherwise it reads the stored analysis by id, and a failure to do so becomes the client's one
 * failure surface instead of a spinner that never stops.
 *
 * Everything rendered here is the server's decision: the side, the timing, the level references,
 * the rationale, the assumptions, the prompt version and the model. This file resolves no price and
 * derives no field, so no claim on screen exists that an analysis did not record.
 *
 * Two absences are deliberate and asserted elsewhere. There is no prompt input: the built-in
 * instructions are the server's and no screen may alter them. And there is no order entry, quantity,
 * stop, target order or broker control, because the product's answer is a read about a chart rather
 * than an instruction to trade, which is also why the fixed disclaimer is rendered exactly once,
 * from the shared constant, in every state this surface can be in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ERROR_CODES, MAX_LONG_EDGE_PX } from '@trade-read/shared';
import type { AnalysisDocument, AnalysisImage, ErrorCode, ImageStatus } from '@trade-read/shared';

import { analysisImageUrl, getAnalysis } from '../../api/analysis-api';
import { shouldReturnToHistory } from '../../api/errors';
import { Disclaimer } from '../../components/disclaimer';
import ErrorNotice from '../../components/error-notice';

import { EvidenceList } from './evidence-list';
import { LevelTable } from './level-table';
import { RecommendationCard } from './recommendation-card';

/**
 * What `App.tsx` mounts the surface with: which analysis to show, the document it may already hold
 * for that analysis, and the two destinations a person can leave for.
 *
 * No other input reaches this surface — not the URL, not a router, not storage — so the analysis
 * shown is always the one the caller named.
 */
export interface AnalysisSurfaceProps {
  /** The identifier of the analysis to display. */
  analysisId: string;
  /**
   * The document the create call returned, when the caller still holds it. It is rendered as given
   * and no read is performed, which is what keeps a just-submitted analysis off the network. It is
   * ignored unless its `analysisId` matches the prop above.
   */
  initialDocument?: AnalysisDocument;
  /** Leaves for the history surface: the destination for a gone analysis and for a finished read. */
  onBackToHistory: () => void;
  /** Starts a new upload from the analysis surface. */
  onNewAnalysis: () => void;
}

/**
 * A failure the surface can show: a code from the shared error table and, when the server sent one,
 * its sentence. The code alone is enough — `components/error-notice.tsx` owns the wording and the
 * offered control for every code — and the sentence is carried only because a server message names
 * detail this surface cannot derive.
 */
interface SurfaceFailure {
  code: ErrorCode;
  message?: string;
}

/** Whether a value names one of the codes the shared table lists. */
function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reads a rejection as a failure this surface can act on.
 *
 * Membership of the shared table is what makes a code usable, not the class of the thrown value: a
 * real `ApiError` and a rejection a suite stubbed with a plain `{ code }` object are both handled,
 * while `instanceof ApiError` would misclassify the second when the API module is mocked. Anything
 * else — a `TypeError`, a bare string, a body with no code or an unknown one — becomes the fallback
 * code, which still has one sentence and one offered control, so no rejection can render nothing.
 */
function toFailure(error: unknown): SurfaceFailure {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };

    if (isErrorCode(code)) {
      return typeof message === 'string' && message.trim() !== '' ? { code, message } : { code };
    }
  }

  return { code: 'INTERNAL_ERROR' };
}

/** The visible word for a stored image's status. */
const STATUS_LABEL: Record<ImageStatus, string> = {
  ANALYZED: 'Analyzed',
  UNREADABLE: 'Unreadable',
};

/** The stylesheet class that colours a status badge. */
const STATUS_MODIFIER: Record<ImageStatus, string> = {
  ANALYZED: 'status--analyzed',
  UNREADABLE: 'status--unreadable',
};

/** One submitted image, with the thumbnail source and box the surface renders for it. */
interface ImageStatusEntry {
  /** The stored image record, rendered as the analysis recorded it. */
  image: AnalysisImage;
  /** The URL the stored bytes are served from. */
  src: string;
  /** The thumbnail's declared width, in pixels, so the layout is reserved before the image loads. */
  thumbWidth: number;
  /** The thumbnail's declared height, in pixels, for the same reason. */
  thumbHeight: number;
}

/**
 * The thumbnail box for one stored image: its own aspect ratio, scaled down so the long edge never
 * exceeds the analysis's own `MAX_LONG_EDGE_PX` and never enlarged beyond the pixels the server
 * stored. A dimension that is not a positive finite number yields a zero box rather than a `NaN`
 * attribute the browser would silently discard.
 */
function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);

  if (!Number.isFinite(longEdge) || longEdge <= 0) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, MAX_LONG_EDGE_PX / longEdge);

  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * One complete trade read: the recommendation and the prices it uses, the levels those prices came
 * from, the evidence behind them, each submitted screenshot with what the analysis made of it, the
 * assumptions the server recorded, the instruction version that produced the read, and the fixed
 * disclaimer.
 *
 * The states are exclusive by construction, so a person never sees two at once: the document, or
 * the pending indicator, or the failure notice (and, for a gone analysis, the sentence that says so
 * while the surface leaves for history). The two departure controls are rendered in every state,
 * because a failed read must not trap someone on a page.
 */
export default function AnalysisSurface({
  analysisId,
  initialDocument,
  onBackToHistory,
  onNewAnalysis,
}: AnalysisSurfaceProps) {
  /* The document the caller already holds is usable only when it belongs to the analysis asked for:
   * an `analysisId` mismatch means the caller's document is stale and the stored one must be read. */
  const initialIsUsable =
    initialDocument !== undefined && initialDocument.analysisId === analysisId;

  /* The analysis document on screen. The name is the surface's, not the DOM's: nothing in this file
   * reads the global `document`, and the stored record is what every branch below renders. */
  const [document, setDocument] = useState<AnalysisDocument | null>(
    initialIsUsable ? initialDocument : null,
  );
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const [isLoading, setIsLoading] = useState(!initialIsUsable);
  /* Bumped by the resubmit control: the read effect keys on it, so a retry is the same effect run
   * again rather than a second request path with its own error handling. */
  const [reloadToken, setReloadToken] = useState(0);
  /* One navigation for a gone analysis, whatever re-renders follow: the flag survives the
   * double-invoked effects of a strict-mode mount and the re-render the navigation itself causes. */
  const hasLeftForHistory = useRef(false);

  useEffect(() => {
    /* A usable in-session document is rendered without a read at all — including on the first
     * render, where the state above was already seeded with it. Only an explicit reload reads. */
    if (initialIsUsable && reloadToken === 0) {
      return;
    }

    let cancelled = false;

    /* A read in flight owns the body: the previous document — another analysis's, or one whose
     * reload was refused — is cleared rather than left on screen under a pending indicator. */
    setIsLoading(true);
    setDocument(null);
    setFailure(null);

    getAnalysis(analysisId)
      .then(
        (loaded) => {
          if (cancelled) {
            return;
          }

          setDocument(loaded);
          setFailure(null);
        },
        (error: unknown) => {
          if (cancelled) {
            return;
          }

          /* A read that failed leaves nothing to render: the stale document, when there was one,
           * must not stay on screen beside a failure that says the read did not happen. */
          setDocument(null);
          setFailure(toFailure(error));
        },
      )
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analysisId, initialDocument, initialIsUsable, reloadToken]);

  /* The resubmit control re-posts the read it refused. It holds no queue and sends nothing itself:
   * the effect above is the only place a read is issued. */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /* A gone analysis cannot be recovered by retrying it, so `api/errors.ts` — the single owner of
   * that decision — sends the surface back to history instead of offering a control. */
  const returningToHistory = failure !== null && shouldReturnToHistory(failure.code);

  useEffect(() => {
    if (failure === null || !shouldReturnToHistory(failure.code) || hasLeftForHistory.current) {
      return;
    }

    hasLeftForHistory.current = true;
    onBackToHistory();
  }, [failure, onBackToHistory]);

  /* The thumbnails are derived from the document alone, so `analysisImageUrl` runs once per stored
   * image per document rather than on every render. */
  const imageEntries = useMemo<ImageStatusEntry[]>(() => {
    if (document === null) {
      return [];
    }

    const { analysisId: storedAnalysisId, images } = document;

    return images.map((image) => {
      const thumb = thumbnailSize(image.width, image.height);

      return {
        image,
        src: analysisImageUrl(storedAnalysisId, image.imageId),
        thumbWidth: thumb.width,
        thumbHeight: thumb.height,
      };
    });
  }, [document]);

  /* Progress is shown only while a read is genuinely in flight: a failure owns the body instead,
   * and `aria-busy` is dropped with the indicator so a failure is never announced as still loading. */
  const showPending = isLoading && failure === null && document === null;

  return (
    <section className="surface analysis-surface" aria-busy={showPending ? true : undefined}>
      <h2 className="surface__title analysis-surface__title">Trade read</h2>

      {document !== null && document.instrument !== '' ? (
        <p className="analysis-surface__instrument">{document.instrument}</p>
      ) : null}

      {document !== null && document.createdAt !== '' ? (
        <p className="analysis-surface__created-at">
          <time dateTime={document.createdAt}>{document.createdAt}</time>
        </p>
      ) : null}

      {showPending ? (
        <div className="pending-indicator" role="status">
          Loading analysis…
        </div>
      ) : null}

      {failure !== null && !returningToHistory ? (
        <ErrorNotice code={failure.code} message={failure.message} onResubmit={reload} />
      ) : null}

      {returningToHistory ? (
        <p className="empty-state">That analysis is no longer available.</p>
      ) : null}

      {document !== null ? (
        <>
          <RecommendationCard recommendation={document.recommendation} levels={document.levels} />

          <LevelTable levels={document.levels} images={document.images} />

          <EvidenceList
            rationale={document.rationale}
            levels={document.levels}
            images={document.images}
          />

          <section className="analysis-surface__images">
            <h3 className="analysis-surface__images-title">Screenshots</h3>
            <ul className="image-status-list">
              {imageEntries.map(({ image, src, thumbWidth, thumbHeight }) => (
                <li
                  key={image.imageId}
                  className="image-status"
                  data-status={image.status}
                  data-image-id={image.imageId}
                >
                  {/* The thumbnail is never hidden, whatever the status: an unreadable screenshot
                      is the evidence that it could not be read. */}
                  <img
                    className="image-status__thumb"
                    src={src}
                    alt={image.fileName}
                    loading="lazy"
                    width={thumbWidth}
                    height={thumbHeight}
                  />
                  <div className="analysis-surface__image-body">
                    <p className="analysis-surface__image-head">
                      <span className={`status ${STATUS_MODIFIER[image.status]}`}>
                        {STATUS_LABEL[image.status]}
                      </span>{' '}
                      <span className="analysis-surface__image-name">{image.fileName}</span>
                    </p>
                    <p className="analysis-surface__image-caption">
                      {`${image.width}\u00d7${image.height} \u00b7 ${Math.round(
                        image.byteSize / 1024,
                      )} KiB \u00b7 ${image.contentType}`}
                    </p>
                    {image.status === 'UNREADABLE' &&
                    image.extractionError !== undefined &&
                    image.extractionError !== '' ? (
                      <p className="image-status__error">{image.extractionError}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Rendered only when the analysis recorded an assumption: an empty list would claim
              nothing was assumed, which is a different statement from "there is nothing to say". */}
          {document.assumptions.length > 0 ? (
            <section className="analysis-surface__assumptions">
              <h3 className="analysis-surface__assumptions-title">Assumptions</h3>
              <ul className="assumptions">
                {document.assumptions.map((assumption, index) => (
                  <li key={`${index}:${assumption}`} className="assumptions__item">
                    {assumption}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Provenance, printed as the server recorded it: the instruction versions that produced
              this read and the model that read it, so a stored analysis can always be traced back
              to the text behind it. Nothing here is derived, defaulted or reformatted. */}
          <dl className="meta">
            <div className="meta__item">
              <dt className="meta__label">Prompt version</dt>
              <dd className="meta__value">{document.modelUsage.promptVersion}</dd>
            </div>
            <div className="meta__item">
              <dt className="meta__label">Model</dt>
              <dd className="meta__value">{document.modelUsage.model}</dd>
            </div>
            <div className="meta__item">
              <dt className="meta__label">Screenshots analyzed</dt>
              <dd className="meta__value">{document.modelUsage.imageCallCount}</dd>
            </div>
            <div className="meta__item">
              <dt className="meta__label">Latency</dt>
              <dd className="meta__value">{document.modelUsage.latencyMs} ms</dd>
            </div>
          </dl>
        </>
      ) : null}

      {/* The surface shows a recommendation, so it carries the fixed disclaimer in every state —
          exactly one node, always from its one source, never the document's own copy of the text. */}
      <Disclaimer />

      <div className="analysis-surface__actions">
        <button type="button" className="button" onClick={onNewAnalysis}>
          New analysis
        </button>
        <button type="button" className="button" onClick={onBackToHistory}>
          History
        </button>
      </div>
    </section>
  );
}

