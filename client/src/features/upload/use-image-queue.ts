/**
 * The upload queue behind the drop zone: it decides which of the files an operator handed over are
 * queued for analysis, prepares each one for upload, and builds the submission body.
 *
 * The bounds applied here are the server's own, imported from the shared contract rather than
 * restated, and the server re-checks all of them on the received bytes. Pre-validation is therefore
 * a courtesy that spares the operator a round trip, never a second, stricter authority: a file this
 * browser cannot decode is refused on its own while the rest of the gesture is still queued, and a
 * screenshot that looks uniformly coloured is annotated and submitted anyway, because only the
 * extraction answer can say whether an image holds a chart.
 *
 * Nothing here renders and nothing here reaches the network. The surface owns the submission; this
 * hook answers with the queue it holds and one rejection record per refused file.
 */

import { useCallback, useRef, useState } from 'react';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_BYTES,
  type ErrorCode,
} from '@trade-read/shared';

import { messageForCode } from '../../api/errors';
import { downscaleImage, type DownscaledImage } from './downscale-image';

/** One queued screenshot, prepared for upload. */
export interface QueuedImage {
  /** The supplied file, kept for the name it is uploaded under and the size the queue reports. */
  file: File;
  /** The bytes that are uploaded: the file itself when it needed no work, else its re-encode. */
  blob: Blob;
  /** Dimensions of `blob`, which are the dimensions the server re-reads from the bytes it receives. */
  width: number;
  height: number;
  /** Advisory text shown on the thumbnail; absent for an ordinary screenshot. */
  note?: string;
}

/**
 * One refused file, naming it and carrying the shared sentence for the code.
 *
 * The sentence is the shared error table's, so the wording of a limit lives in exactly one place
 * and no limit is spelled out again here; the file name is prefixed because a single drop can bring
 * several files and the operator has to know which one was refused.
 */
export interface RejectedFile {
  fileName: string;
  code: ErrorCode;
  message: string;
}

/**
 * The note a thumbnail carries when the decoded frame looks uniformly coloured.
 *
 * Advisory only. The file stays queued and is submitted, because readability is the server's
 * extraction outcome to decide and not a pixel sample taken here.
 */
export const BLANK_FRAME_NOTE = 'This screenshot looks blank. It will still be submitted.';

/** What the upload surface needs from the queue. */
export interface ImageQueue {
  /** Queued screenshots in the order they were accepted, which is the order they are uploaded. */
  entries: QueuedImage[];
  /** Files refused by the last `addFiles` call: one record per file, nothing carried over. */
  rejections: RejectedFile[];
  /** True while a batch is being prepared, so the surface can hold back its submit control. */
  isProcessing: boolean;
  /** Whether anything is queued, which is what a submit control depends on. */
  hasFiles: boolean;
  /** Accepts one gesture's files, or one selection's, in the order given. */
  addFiles: (files: File[]) => void;
  /** Drops the entry at that queue position, leaving every other entry and the refusals as they are. */
  remove: (index: number) => void;
  /** Empties the queue and the refusals. */
  clear: () => void;
  /** Builds the submission body from the queue and the two optional text fields. */
  buildFormData: (instrument: string, context: string) => FormData;
}

/** Membership is decided by the shared tuple, so no accepted content type is restated here. */
function isAcceptedImageMimeType(value: string): boolean {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function rejectionFor(file: File, code: ErrorCode): RejectedFile {
  return { fileName: file.name, code, message: `${file.name}: ${messageForCode(code)}` };
}

/** What a queue weighs once uploaded, measured on the blobs rather than on the source files. */
function uploadedBytes(queue: readonly QueuedImage[]): number {
  return queue.reduce((total, entry) => total + entry.blob.size, 0);
}

export function useImageQueue(): ImageQueue {
  const [entries, setEntries] = useState<QueuedImage[]>([]);
  const [rejections, setRejections] = useState<RejectedFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * The queue as the latest commit left it.
   *
   * A batch is prepared across awaits, and every file has to be counted against everything accepted
   * before it — before React has re-rendered — so the batch counts against this mirror rather than
   * against the rendered `entries`. Every mutation writes it, so the two never disagree for longer
   * than an unprocessed update.
   */
  const queueRef = useRef<QueuedImage[]>([]);

  /** Held for the duration of a batch, so a second gesture is ignored rather than interleaved. */
  const isBatching = useRef(false);

  const addFiles = useCallback((files: File[]) => {
    // A call carrying nothing replaces the previous refusals with an empty list, so the surface
    // cannot be left showing a rejection beside an empty queue.
    if (files.length === 0) {
      setRejections([]);
      return;
    }
    if (isBatching.current) return;

    isBatching.current = true;
    setIsProcessing(true);

    // The work is asynchronous because preparing a file decodes it, but the caller is a drop or
    // change handler that must return immediately: it is started here and the outcome arrives in
    // state. Failures are per file, so nothing thrown inside the batch escapes unhandled.
    void (async () => {
      const batchRejections: RejectedFile[] = [];
      // Combined-queue accounting: what the operator already queued is what this batch starts from.
      let accepted = queueRef.current.length;
      let uploaded = uploadedBytes(queueRef.current);

      try {
        // Sequential on purpose, in the order the gesture supplied the files: queue order is
        // submission order, and one decode at a time keeps the peak memory of a six-file drop to a
        // single bitmap.
        for (const file of files) {
          if (accepted >= MAX_IMAGES) {
            batchRejections.push(rejectionFor(file, 'TOO_MANY_IMAGES'));
            continue;
          }
          if (!isAcceptedImageMimeType(file.type)) {
            batchRejections.push(rejectionFor(file, 'UNSUPPORTED_IMAGE_TYPE'));
            continue;
          }
          if (file.size > MAX_IMAGE_BYTES) {
            batchRejections.push(rejectionFor(file, 'IMAGE_TOO_LARGE'));
            continue;
          }

          let prepared: DownscaledImage;
          try {
            prepared = await downscaleImage(file);
          } catch {
            // A file this browser cannot decode is refused alone: the queue stands and the rest of
            // the batch is still prepared, because the server decides what it can read.
            batchRejections.push(rejectionFor(file, 'INTERNAL_ERROR'));
            continue;
          }

          if (uploaded + prepared.blob.size > MAX_TOTAL_BYTES) {
            batchRejections.push(rejectionFor(file, 'IMAGE_TOO_LARGE'));
            continue;
          }

          accepted += 1;
          uploaded += prepared.blob.size;
          const entry: QueuedImage = {
            file,
            blob: prepared.blob,
            width: prepared.width,
            height: prepared.height,
            // The note is present only when there is something to say, so an ordinary screenshot
            // carries no `note` at all rather than an empty string a thumbnail would have to test.
            ...(prepared.blankFrame ? { note: BLANK_FRAME_NOTE } : {}),
          };
          queueRef.current = [...queueRef.current, entry];
          setEntries(queueRef.current);
        }

        setRejections(batchRejections);
      } finally {
        isBatching.current = false;
        setIsProcessing(false);
      }
    })();
  }, []);

  const remove = useCallback((index: number) => {
    setEntries((current) => {
      const next = current.filter((_, position) => position !== index);
      // The mirror is written inside the updater so it can only ever describe the queue the
      // operator is looking at; the filter is deterministic, so an updater React re-invokes cannot
      // drop a second entry.
      queueRef.current = next;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    queueRef.current = [];
    setEntries([]);
    setRejections([]);
  }, []);

  const buildFormData = useCallback((instrument: string, context: string) => {
    const formData = new FormData();
    // Built from the mirror rather than from the rendered queue: a submit handler may run before a
    // just-removed thumbnail has re-rendered, and both hold the same array otherwise.
    for (const entry of queueRef.current) {
      formData.append('images', entry.blob, entry.file.name);
    }
    // A field the operator left blank is absent rather than supplied-and-blank, so the stored
    // analysis records only text that was actually typed.
    if (instrument.trim() !== '') formData.append('instrument', instrument);
    if (context.trim() !== '') formData.append('context', context);
    return formData;
  }, []);

  return {
    entries,
    rejections,
    isProcessing,
    hasFiles: entries.length > 0,
    addFiles,
    remove,
    clear,
    buildFormData,
  };
}
