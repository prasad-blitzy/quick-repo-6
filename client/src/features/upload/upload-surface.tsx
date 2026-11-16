/**
 * The upload surface: the composition root of `features/upload` and the only path in the product
 * that creates an analysis.
 *
 * It owns one submission gesture and nothing more. The queue behind `useImageQueue` decides which
 * files are accepted and builds the request body; this component carries the two optional text
 * fields, the single submit control and the one call into `api/analysis-api.ts`, then hands the
 * stored document to `onCreated`. No module outside `api/analysis-api.ts` reaches the API, so no
 * address, header or credential appears here, and nothing is requested while the surface is merely
 * on screen.
 *
 * Two rules shape the markup. A failure replaces the pending line instead of joining it, so a
 * refused submission can never read as work still running. An advisory note on a thumbnail never
 * blocks submission, because only the server's extraction outcome can say whether an image holds a
 * chart. Thumbnails carry the file's name, dimensions and uploaded size rather than a rendering of
 * the image: the bytes already travel with the submission, and the browser-side object URLs that a
 * preview would need belong to the surface that re-displays a stored analysis.
 */

import { useCallback, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import {
  CONTEXT_MAX_CHARS,
  ERROR_CODES,
  INSTRUMENT_MAX_CHARS,
  MAX_IMAGES,
} from '@trade-read/shared';
import type { AnalysisDocument, ErrorCode } from '@trade-read/shared';

import { createAnalysis } from '../../api/analysis-api';
import { messageForCode } from '../../api/errors';
import ErrorNotice from '../../components/error-notice';
import { DropZone } from './drop-zone';
import { useImageQueue } from './use-image-queue';

/** The failure this surface shows in place of its pending line, already carrying its sentence. */
interface UploadFailure {
  code: ErrorCode;
  message: string;
}

export interface UploadSurfaceProps {
  /** Receives the stored analysis, which the caller then displays or records. */
  onCreated: (document: AnalysisDocument) => void;
}

/**
 * A queued screenshot's uploaded size, short enough for a thumbnail caption.
 *
 * Read from the prepared blob rather than from the file the operator picked, so a capture that was
 * downscaled reports the bytes that are actually uploaded. A size that is absent or nonsensical
 * reads as `0 B` instead of `NaN`.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const kibibytes = bytes / 1024;

  if (kibibytes < 1024) {
    return `${kibibytes.toFixed(1)} KiB`;
  }

  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}

/**
 * The failure state for anything a submission can reject with.
 *
 * Both fields are read off the thrown value rather than by testing for the transport's error class,
 * so a rejection from a replaced or stubbed transport — a plain object, an ordinary `Error`, or no
 * value at all — resolves the same way: a code the shared table lists, or the fallback code, always
 * paired with a non-empty sentence. A code outside the table is discarded rather than shown, since
 * the interface has no behaviour for it.
 */
function toErrorState(thrown: unknown): UploadFailure {
  const isObject = typeof thrown === 'object' && thrown !== null;
  const rawCode = isObject && 'code' in thrown ? thrown.code : undefined;
  const code: ErrorCode =
    typeof rawCode === 'string' && (ERROR_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as ErrorCode)
      : 'INTERNAL_ERROR';

  const rawMessage = isObject && 'message' in thrown ? thrown.message : undefined;
  const supplied = typeof rawMessage === 'string' ? rawMessage.trim() : '';

  return { code, message: supplied === '' ? messageForCode(code) : supplied };
}

/**
 * The upload surface.
 *
 * Everything the operator can do here is one gesture: hand over screenshots, optionally name the
 * instrument or describe the context, and submit. The submission is attempted exactly once per
 * gesture, and re-attempted only through the failure notice's own control, so the same screenshots
 * are never sent twice behind the operator's back.
 */
export default function UploadSurface({ onCreated }: UploadSurfaceProps) {
  const queue = useImageQueue();
  const [instrument, setInstrument] = useState('');
  const [context, setContext] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failure, setFailure] = useState<UploadFailure | null>(null);

  /**
   * Submits the queue as it stands.
   *
   * The body comes from the queue alone, so the request carries the images and the two optional
   * text fields and nothing else. The queue is emptied only after a document arrives: a refused
   * submission keeps its screenshots, which is what lets the failure notice re-post them.
   */
  const submit = useCallback(async () => {
    if (!queue.hasFiles || isSubmitting) return;

    setIsSubmitting(true);
    setFailure(null);

    const formData = queue.buildFormData(instrument, context);

    try {
      const document = await createAnalysis(formData);
      queue.clear();
      onCreated(document);
    } catch (thrown) {
      setFailure(toErrorState(thrown));
    } finally {
      setIsSubmitting(false);
    }
  }, [context, instrument, isSubmitting, onCreated, queue]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      // A form's default action navigates away from the single-page application entirely.
      event.preventDefault();
      void submit();
    },
    [submit],
  );

  const handleResubmit = useCallback(() => {
    void submit();
  }, [submit]);

  /**
   * A new gesture, a removal or an edit drops the previous failure: the notice answers the input
   * that produced it, so it must not outlive that input.
   */
  const handleFiles = useCallback(
    (files: File[]) => {
      setFailure(null);
      queue.addFiles(files);
    },
    [queue],
  );

  const handleRemove = useCallback(
    (index: number) => {
      setFailure(null);
      queue.remove(index);
    },
    [queue],
  );

  const handleInstrumentChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setFailure(null);
    // Sliced as well as capped by `maxLength`: a value set by a paste, a script or an IME can
    // exceed the attribute before the field reports a change.
    setInstrument(event.currentTarget.value.slice(0, INSTRUMENT_MAX_CHARS));
  }, []);

  const handleContextChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setFailure(null);
    setContext(event.currentTarget.value.slice(0, CONTEXT_MAX_CHARS));
  }, []);

  const canSubmit = queue.hasFiles && !isSubmitting && !queue.isProcessing;

  return (
    <section className="surface" aria-labelledby="upload-heading" data-surface="upload">
      <h2 className="surface__title" id="upload-heading">
        New analysis
      </h2>
      <p className="surface__subtitle">
        Drop one to {MAX_IMAGES} screenshots of your own charts and submit them. Nothing has to be
        typed.
      </p>

      <form
        className="upload-form"
        aria-busy={isSubmitting ? true : undefined}
        onSubmit={handleSubmit}
      >
        <DropZone onFiles={handleFiles} disabled={isSubmitting} />

        {queue.rejections.length > 0 ? (
          <ul className="rejections" aria-live="polite" aria-label="Rejected files">
            {queue.rejections.map((rejection) => (
              <li
                className="rejections__item"
                data-code={rejection.code}
                key={`${rejection.code}:${rejection.fileName}`}
              >
                {rejection.message}
              </li>
            ))}
          </ul>
        ) : null}

        {queue.entries.length > 0 ? (
          <ul className="thumbnail-list" aria-label="Screenshots queued">
            {queue.entries.map((entry, index) => (
              <li className="thumbnail" key={`${entry.file.name}:${index}`}>
                <span className="thumbnail__name">{entry.file.name}</span>
                <span className="thumbnail__meta">
                  <span>{`${entry.width}\u00d7${entry.height}`}</span>
                  <span>{formatBytes(entry.blob.size)}</span>
                </span>
                {entry.note === undefined ? null : <p className="thumbnail__note">{entry.note}</p>}
                <button
                  type="button"
                  className="button thumbnail__remove"
                  aria-label={`Remove ${entry.file.name}`}
                  onClick={() => {
                    handleRemove(index);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <label className="field" htmlFor="upload-instrument">
          <span className="field__label">Instrument (optional)</span>
          <input
            id="upload-instrument"
            name="instrument"
            className="field__input"
            type="text"
            value={instrument}
            maxLength={INSTRUMENT_MAX_CHARS}
            onChange={handleInstrumentChange}
            autoComplete="off"
          />
        </label>

        <label className="field" htmlFor="upload-context">
          <span className="field__label">Context (optional)</span>
          <textarea
            id="upload-context"
            name="context"
            className="field__input field__input--multiline"
            rows={3}
            value={context}
            maxLength={CONTEXT_MAX_CHARS}
            onChange={handleContextChange}
          />
        </label>

        {failure !== null ? (
          <ErrorNotice
            code={failure.code}
            message={failure.message}
            onResubmit={handleResubmit}
          />
        ) : isSubmitting ? (
          <p className="pending-indicator" role="status">
            Analysing your screenshots…
          </p>
        ) : null}

        <div className="surface__actions">
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            Analyse screenshots
          </button>
        </div>
      </form>
    </section>
  );
}
