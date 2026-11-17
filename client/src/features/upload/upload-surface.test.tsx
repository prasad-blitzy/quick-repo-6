/**
 * Suite for the upload surface: the single gesture that turns dropped or picked screenshots into a
 * stored analysis.
 *
 * What the surface owns is the submission, so that is what is asserted: one request per gesture, a
 * body carrying the images and the two optional text fields and nothing else, a pending line while
 * that request runs, and a failure notice with a retry control in place of the pending line when the
 * request is refused. Everything else belongs to a module further in — the queue decides which
 * files are accepted, `api/analysis-api.ts` performs the request, `api/errors.ts` owns the sentence
 * a code shows — so those real modules run here and only the two that need a browser jsdom does not
 * provide are replaced: the image downscaler (no `createImageBitmap`, no canvas) and the transport
 * (no test may reach a network).
 *
 * `api/errors.ts` is deliberately left real. Every expected sentence is read from `messageForCode`
 * and every expected status from `ERROR_STATUS`, so a failure assertion proves the surface shows the
 * shared wording rather than a copy of it that could drift; no limit number is written here, because
 * the field caps come from `INSTRUMENT_MAX_CHARS` and `CONTEXT_MAX_CHARS`.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_MAX_CHARS,
  DISCLAIMER,
  ERROR_STATUS,
  INSTRUMENT_MAX_CHARS,
} from '@trade-read/shared';
import type { AnalysisDocument, ErrorCode } from '@trade-read/shared';

import { createAnalysis } from '../../api/analysis-api';
import { messageForCode } from '../../api/errors';
import UploadSurface from './upload-surface';
import { BLANK_FRAME_NOTE } from './use-image-queue';

/**
 * The engagement of the blank-frame hint for the mocked downscaler.
 *
 * Held in a hoisted cell because a `vi.mock` factory is lifted above this file's imports and so
 * cannot close over an ordinary module-scope binding. The queue reads the hint from the downscaler's
 * answer, which is how a test asks for a screenshot that looks uniformly coloured.
 */
const downscale = vi.hoisted(() => ({ blankFrame: false }));

/**
 * The sibling downscaler cannot run in jsdom: it awaits `createImageBitmap` and draws through a 2D
 * canvas context, and jsdom provides neither. The replacement answers with the supplied file as the
 * bytes to upload and fixed dimensions, so the queue's own bookkeeping still runs for real.
 */
vi.mock('./downscale-image', () => ({
  computeTargetSize: (width: number, height: number) => ({ width, height }),
  isBlankFrame: () => downscale.blankFrame,
  downscaleImage: async (file: File) => ({
    blob: file,
    width: 1600,
    height: 900,
    blankFrame: downscale.blankFrame,
  }),
}));

/**
 * The transport is replaced, so no test of this suite touches the network: every request the surface
 * can make leaves through `createAnalysis`, and the failures each code produces are handed to it
 * directly. `ApiError` is provided because the module exports it, not because the surface reads it —
 * a rejection here is a plain object, which is the point of the failure cases below.
 */
vi.mock('../../api/analysis-api', () => ({
  createAnalysis: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

/** What a user-event instance is, named once so the helpers below can take one. */
type User = ReturnType<typeof userEvent.setup>;

/** The only multipart fields a submission may carry, in the order the queue appends them. */
const SUBMITTED_FIELDS: readonly string[] = ['images', 'instrument', 'context'];

/** The three failures this surface must render as a notice with a retry control. */
const REFUSAL_CODES: readonly ErrorCode[] = [
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_QUOTA_EXCEEDED',
  'ANALYSIS_TIMEOUT',
];

/**
 * The accessible names no control of this surface may carry.
 *
 * The application reads screenshots and offers no way to act on the read it returns, so a control
 * for buying, selling, sizing a position or reaching a broker would be a design failure rather than
 * a missing feature.
 */
const TRADING_CONTROL = /buy|sell|place order|size|broker/i;

/** A screenshot of a kind the picker's `accept` attribute admits. */
function pngFile(name: string): File {
  return new File(['chart screenshot bytes'], name, { type: 'image/png' });
}

/** The clipped input the drop zone opens; the zone is the control, and this is the picker behind it. */
function fileInputIn(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) {
    throw new Error('The upload surface rendered no file picker.');
  }
  return input;
}

/** The surface's only submission control, found by role and accessible name. */
function submitButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: /analyse screenshots/i });
}

/** The document the transport resolved with, read once so a test says which call it means. */
function submittedFormData(callIndex = 0): FormData {
  const call = vi.mocked(createAnalysis).mock.calls[callIndex];
  const formData = call?.[0];
  if (formData === undefined) {
    throw new Error(`The surface made no submission at call ${callIndex}.`);
  }
  return formData;
}

/**
 * A stored analysis of the cheapest complete shape: a `NO_TRADE`/`WAIT` read, which is a finished
 * result rather than a failure and therefore has to survive exactly like any other.
 */
function completeAnalysis(): AnalysisDocument {
  return {
    analysisId: 'an-0001',
    createdAt: '2026-01-01T00:00:00.000Z',
    instrument: '',
    context: '',
    images: [
      {
        imageId: 'im-0001',
        fileName: 'footprint-es-5m.png',
        contentType: 'image/png',
        byteSize: 1536,
        width: 1600,
        height: 900,
        status: 'ANALYZED',
      },
    ],
    levels: [
      { levelId: 'lv-0001', price: 5400.25, type: 'FOOTPRINT_POC', imageId: 'im-0001' },
    ],
    recommendation: {
      side: 'NO_TRADE',
      timing: 'WAIT',
      triggerLevelId: null,
      entryLevelId: null,
      invalidationLevelId: null,
      targetLevelIds: [],
      confidence: 'LOW',
      summary: 'No actionable read from the screenshots supplied.',
    },
    rationale: [],
    assumptions: ['No current price was visible in any screenshot.'],
    modelUsage: {
      provider: 'openrouter',
      model: 'configured-vision-model',
      promptVersion: 'extraction@1;synthesis@1',
      imageCallCount: 1,
      synthesisCompletionTokens: 42,
      latencyMs: 1200,
    },
    disclaimer: DISCLAIMER,
  };
}

/**
 * The rejection the transport produces for a refused submission: the shared code with its shared
 * status and sentence, as a plain object.
 *
 * A plain object is deliberate. The surface reads a code and a message off whatever it is given, so
 * a failure that arrives without the transport's own error class still renders the notice its code
 * earns; a subclass would prove only that one class is handled.
 */
function refusal(code: ErrorCode): { code: ErrorCode; status: number; message: string } {
  return { code, status: ERROR_STATUS[code], message: messageForCode(code) };
}

/** A resolution the test settles by hand, so the pending state can be observed mid-flight. */
function pendingAnalysis(): {
  promise: Promise<AnalysisDocument>;
  resolve: (document: AnalysisDocument) => void;
} {
  let resolve!: (document: AnalysisDocument) => void;
  const promise = new Promise<AnalysisDocument>((settle) => {
    resolve = settle;
  });

  return {
    promise,
    resolve: (document: AnalysisDocument) => {
      resolve(document);
    },
  };
}

/** The surface over a spy, which is the only prop a caller supplies. */
function renderSurface() {
  const onCreated = vi.fn<(document: AnalysisDocument) => void>();
  const { container } = render(<UploadSurface onCreated={onCreated} />);

  return { container, onCreated };
}

/**
 * Picks one screenshot the way the operator does, through the input the drop zone opens.
 *
 * The queue prepares a file across a microtask, so this returns only once the thumbnail is on screen
 * and the submit control has left the processing state it holds while a batch is prepared.
 */
async function queueScreenshot(
  user: User,
  container: HTMLElement,
  file: File,
): Promise<HTMLElement> {
  await user.upload(fileInputIn(container), file);

  const thumbnail = await waitFor(() => {
    const found = container.querySelector<HTMLElement>('.thumbnail');
    if (found === null) {
      throw new Error('The upload surface rendered no thumbnail yet.');
    }
    return found;
  });

  await waitFor(() => {
    expect(submitButton()).toBeEnabled();
  });

  return thumbnail;
}

/**
 * The failure notice, once the surface has replaced its pending line with one.
 *
 * Read from the DOM rather than by role so a notice that renders with no accessible name is still
 * found, and so the absence assertion beside it can use the same selector.
 */
async function failureNotice(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>('.error-notice');
    if (found === null) {
      throw new Error('No failure notice was rendered.');
    }
    return found;
  });
}

/**
 * The global `fetch` double installed for every test.
 *
 * The surface must reach the API through `api/analysis-api.ts` alone, so a `fetch` of its own would
 * be a second egress; the stub exists to make that absence assertable. The environment setup module
 * unstubs globals after each test, so this one never outlives its own case.
 */
let fetchDouble: ReturnType<typeof vi.fn>;

beforeEach(() => {
  downscale.blankFrame = false;
  vi.mocked(createAnalysis).mockReset();
  fetchDouble = vi.fn();
  vi.stubGlobal('fetch', fetchDouble);
});

describe('UploadSurface', () => {
  describe('a submission with nothing typed', () => {
    it('holds its submit control disabled while no screenshot is queued', () => {
      renderSurface();

      expect(submitButton()).toBeDisabled();
    });

    it('queues a picked screenshot as a named thumbnail and enables the submit control', async () => {
      const user = userEvent.setup();
      const { container } = renderSurface();
      const file = pngFile('footprint-es-5m.png');

      const thumbnail = await queueScreenshot(user, container, file);

      expect(thumbnail).toHaveTextContent(file.name);
      expect(submitButton()).toBeEnabled();
    });

    it('submits once with only the images field and hands the stored analysis to onCreated', async () => {
      const user = userEvent.setup();
      const analysis = completeAnalysis();
      vi.mocked(createAnalysis).mockResolvedValueOnce(analysis);
      const { container, onCreated } = renderSurface();

      await queueScreenshot(user, container, pngFile('footprint-es-5m.png'));
      await user.click(submitButton());

      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledWith(analysis);
      });

      expect(createAnalysis).toHaveBeenCalledTimes(1);

      // The body is the client-side half of the rule that no request content can instruct the
      // analysis: there is no field here to carry an instruction.
      const formData = submittedFormData();
      expect([...formData.keys()]).toEqual(['images']);
      expect(formData.getAll('images')).toHaveLength(1);
      for (const field of formData.keys()) {
        expect(SUBMITTED_FIELDS.includes(field)).toBe(true);
      }
    });

    it('queues a screenshot that looks blank with an advisory note and submits it anyway', async () => {
      downscale.blankFrame = true;
      const user = userEvent.setup();
      vi.mocked(createAnalysis).mockResolvedValueOnce(completeAnalysis());
      const { container, onCreated } = renderSurface();

      const thumbnail = await queueScreenshot(user, container, pngFile('blank-uniform.png'));

      const note = thumbnail.querySelector('.thumbnail__note');
      expect(note).not.toBeNull();
      expect(note).toHaveTextContent(BLANK_FRAME_NOTE);
      expect(submitButton()).toBeEnabled();

      await user.click(submitButton());

      // Only the extraction answer can say whether an image holds a chart, so a pixel sample taken
      // in the browser is advice and never a refusal.
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('the two optional fields', () => {
    it('carries the instrument and the context typed beside the images', async () => {
      const user = userEvent.setup();
      vi.mocked(createAnalysis).mockResolvedValueOnce(completeAnalysis());
      const { container } = renderSurface();

      await queueScreenshot(user, container, pngFile('gex-es-levels.png'));
      await user.type(screen.getByLabelText<HTMLInputElement>(/instrument/i), 'ES');
      await user.type(
        screen.getByLabelText<HTMLTextAreaElement>(/context/i),
        'watching the value area',
      );
      await user.click(submitButton());

      await waitFor(() => {
        expect(createAnalysis).toHaveBeenCalledTimes(1);
      });

      const formData = submittedFormData();
      expect([...formData.keys()]).toEqual([...SUBMITTED_FIELDS]);
      expect(formData.get('instrument')).toBe('ES');
      expect(formData.get('context')).toBe('watching the value area');
    });

    it('caps both text fields at the shared character limits', () => {
      renderSurface();

      // Read from the shared limits, which are the same values the server clamps to, so the two
      // halves of the bound cannot drift apart.
      expect(screen.getByLabelText(/instrument/i)).toHaveAttribute(
        'maxlength',
        String(INSTRUMENT_MAX_CHARS),
      );
      expect(screen.getByLabelText(/context/i)).toHaveAttribute(
        'maxlength',
        String(CONTEXT_MAX_CHARS),
      );
    });

    it('never submits more instrument text than the cap allows', async () => {
      const user = userEvent.setup();
      vi.mocked(createAnalysis).mockResolvedValueOnce(completeAnalysis());
      const { container } = renderSurface();
      const instrument = screen.getByLabelText<HTMLInputElement>(/instrument/i);

      await queueScreenshot(user, container, pngFile('footprint-es-5m.png'));
      await user.type(instrument, 'X'.repeat(INSTRUMENT_MAX_CHARS * 2));

      expect(instrument.value.length).toBeLessThanOrEqual(INSTRUMENT_MAX_CHARS);

      await user.click(submitButton());

      await waitFor(() => {
        expect(createAnalysis).toHaveBeenCalledTimes(1);
      });

      const sent = submittedFormData().get('instrument');
      expect(sent).not.toBeNull();
      expect(String(sent).length).toBeLessThanOrEqual(INSTRUMENT_MAX_CHARS);
    });
  });

  describe('while a submission is running', () => {
    it('shows a pending line over a busy form, then hands the document over', async () => {
      const user = userEvent.setup();
      const pending = pendingAnalysis();
      vi.mocked(createAnalysis).mockReturnValueOnce(pending.promise);
      const { container, onCreated } = renderSurface();

      await queueScreenshot(user, container, pngFile('footprint-es-5m.png'));
      await user.click(submitButton());

      await waitFor(() => {
        expect(container.querySelector('.pending-indicator')).not.toBeNull();
      });
      expect(container.querySelector('form')).toHaveAttribute('aria-busy', 'true');
      expect(container.querySelector('.error-notice')).toBeNull();

      const analysis = completeAnalysis();
      await act(async () => {
        pending.resolve(analysis);
      });

      await waitFor(() => {
        expect(container.querySelector('.pending-indicator')).toBeNull();
      });
      expect(container.querySelector('form')).not.toHaveAttribute('aria-busy', 'true');
      expect(onCreated).toHaveBeenCalledWith(analysis);
    });
  });

  describe('a refused submission', () => {
    it.each(REFUSAL_CODES)(
      'replaces its pending line with the %s notice and retries only when asked',
      async (code) => {
        const user = userEvent.setup();
        vi.mocked(createAnalysis).mockRejectedValueOnce(refusal(code));
        const { container } = renderSurface();

        await queueScreenshot(user, container, pngFile('gex-es-levels.png'));
        await user.click(submitButton());

        const notice = await failureNotice(container);

        expect(notice).toHaveAttribute('data-code', code);
        expect(notice).toHaveTextContent(messageForCode(code));
        // A refusal replaces the pending state instead of joining it, so nothing on screen can
        // still read as work in progress.
        expect(container.querySelector('.pending-indicator')).toBeNull();
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(container.querySelector('[aria-busy="true"]')).toBeNull();
        // The gesture is attempted exactly once: only the operator's retry repeats it.
        expect(createAnalysis).toHaveBeenCalledTimes(1);

        const retry = screen.getByRole('button', { name: /try again/i });
        const second = pendingAnalysis();
        vi.mocked(createAnalysis).mockReturnValueOnce(second.promise);

        await user.click(retry);

        await waitFor(() => {
          expect(createAnalysis).toHaveBeenCalledTimes(2);
        });
        // The refused screenshots are still held, so the retry re-posts them rather than a blank set.
        expect(submittedFormData(1).getAll('images')).toHaveLength(1);
        expect(container.querySelector('.pending-indicator')).not.toBeNull();

        await act(async () => {
          second.resolve(completeAnalysis());
        });

        await waitFor(() => {
          expect(container.querySelector('.pending-indicator')).toBeNull();
        });
      },
    );
  });

  describe('what the surface must never contain', () => {
    it('reaches no network of its own, leaving every request to the API module', async () => {
      const user = userEvent.setup();
      vi.mocked(createAnalysis).mockResolvedValueOnce(completeAnalysis());
      const { container, onCreated } = renderSurface();

      await queueScreenshot(user, container, pngFile('footprint-es-5m.png'));
      await user.click(submitButton());

      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledTimes(1);
      });

      expect(fetchDouble).not.toHaveBeenCalled();
    });

    it('shows no disclaimer, because it shows no recommendation', () => {
      const { container } = renderSurface();

      expect(container.querySelector('.disclaimer')).toBeNull();
      expect(screen.queryByText(DISCLAIMER)).toBeNull();
    });

    it('offers no prompt control of any kind', async () => {
      const user = userEvent.setup();
      const { container } = renderSurface();
      await queueScreenshot(user, container, pngFile('footprint-es-5m.png'));

      expect(screen.queryByLabelText(/prompt/i)).toBeNull();
      expect(screen.queryByPlaceholderText(/prompt/i)).toBeNull();
      expect(container.querySelector('[name="prompt"]')).toBeNull();

      // Every named field the surface can render is one the submission is allowed to carry, so no
      // request content can reach the instruction text.
      const namedFields = [
        ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          'input[name], textarea[name], select[name]',
        ),
      ];
      expect(namedFields.length).toBeGreaterThan(0);
      for (const field of namedFields) {
        expect(SUBMITTED_FIELDS.includes(field.getAttribute('name') ?? '')).toBe(true);
      }
    });

    it('offers no order, position-size or broker control', async () => {
      const user = userEvent.setup();
      const { container } = renderSurface();
      await queueScreenshot(user, container, pngFile('footprint-es-5m.png'));

      expect(screen.queryByRole('button', { name: TRADING_CONTROL })).toBeNull();
      expect(screen.queryByRole('link', { name: TRADING_CONTROL })).toBeNull();
      expect(screen.queryByRole('spinbutton', { name: TRADING_CONTROL })).toBeNull();
      expect(container.querySelector('select')).toBeNull();
      expect(container.querySelector('input[type="number"]')).toBeNull();
    });
  });
});
