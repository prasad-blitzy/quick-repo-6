/**
 * Suite for the analysis surface: the screen that renders one stored trade read in full.
 *
 * The surface's contract is that it renders exactly what the analysis recorded and reaches no
 * further than one read. Every assertion below therefore reads the DOM the document produced — a
 * side, a timing, a price, a source image, a status, a prompt version, the disclaimer — and none
 * of them measures styling, which jsdom does not compute.
 *
 * The transport is replaced wholesale, so the suite answers two separate questions without a
 * network: what the surface renders from a document it was handed (most cases, no read at all),
 * and which read it issues when it was handed only an id, including what each failure becomes on
 * screen. A rejecting `fetch` is installed as well: this suite must reach nothing, so an accidental
 * request fails the test that caused it instead of silently succeeding.
 *
 * The failures the surface is fed carry a `code` on a plain object rather than the transport's own
 * `ApiError`, because membership of the shared error table, not the thrown value's class, is what
 * decides how a failure is shown — and that is the behaviour under test.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DISCLAIMER } from '@trade-read/shared';
import type { AnalysisDocument, AnalysisImage } from '@trade-read/shared';

import { analysisImageUrl, getAnalysis } from '../../api/analysis-api';
import AnalysisSurface, { type AnalysisSurfaceProps } from './analysis-surface';

/**
 * The one boundary this suite replaces: the client's transport module.
 *
 * The factory is self-contained because Vitest hoists it above this file's imports. `ApiError` is
 * stood up with the module even though no test constructs one, so the mock stays a faithful
 * stand-in for the module's surface rather than a partial one that would break the day the surface
 * names it.
 */
vi.mock('../../api/analysis-api', () => ({
  getAnalysis: vi.fn(),
  analysisImageUrl: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;

    status: number;

    constructor(code: string, status = 500) {
      super(code);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  },
}));

const mockedGetAnalysis = vi.mocked(getAnalysis);
const mockedAnalysisImageUrl = vi.mocked(analysisImageUrl);

/**
 * The stand-in thumbnail URL.
 *
 * It carries a scheme nothing serves, so the assertion that a thumbnail's source came from this
 * stub cannot be satisfied by a URL the surface assembled itself.
 */
function storedImageUrl(analysisId: string, imageId: string): string {
  return `stored-image:${analysisId}/${imageId}`;
}

/** The `fetch` each test installs: it rejects, so any request this suite must not make fails. */
function networkRefusingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      Promise.reject(new Error('This suite must reach no network.')),
  );
}

let fetchStub = networkRefusingFetch();

/**
 * Restores the two module doubles and arms the network guard before every test.
 *
 * The configuration's `restoreMocks` and `clearMocks` cover spies, not the implementations these
 * doubles carry, so each test starts from the same pair of answers. The global `fetch` stub is
 * removed after every test by `src/test/setup.ts`, which owns that teardown for the whole suite.
 */
beforeEach(() => {
  mockedGetAnalysis.mockReset();
  mockedAnalysisImageUrl.mockReset();
  mockedAnalysisImageUrl.mockImplementation(storedImageUrl);
  fetchStub = networkRefusingFetch();
  vi.stubGlobal('fetch', fetchStub);
});

/** One submitted screenshot, as the analysis recorded it. */
function imageFixture(overrides: Partial<AnalysisImage> = {}): AnalysisImage {
  return {
    imageId: 'I1',
    fileName: 'footprint-es-5m.png',
    contentType: 'image/png',
    byteSize: 184320,
    width: 1600,
    height: 900,
    status: 'ANALYZED',
    ...overrides,
  };
}

/** The second screenshot of the pair, from a different kind of chart. */
function gexImage(overrides: Partial<AnalysisImage> = {}): AnalysisImage {
  return imageFixture({
    imageId: 'I2',
    fileName: 'gex-es-levels.png',
    byteSize: 151552,
    width: 1400,
    height: 880,
    ...overrides,
  });
}

/**
 * A complete analysis: two screenshots and four levels, every field the shared contract requires.
 *
 * The levels are chosen to make three properties visible. `5120` appears twice — on `L1` and
 * `L4` — so a rendering that grouped or deduplicated equal prices would show it once. `5100.5` is
 * fractional, so a rendering that rounded it would lose the digit. And the four prices differ in
 * magnitude, so a thousands separator would appear on some rows and not others.
 */
function buildDocument(overrides: Partial<AnalysisDocument> = {}): AnalysisDocument {
  return {
    analysisId: 'a1',
    createdAt: '2025-05-01T12:00:00.000Z',
    instrument: 'ES',
    context: '',
    images: [imageFixture(), gexImage()],
    levels: [
      { levelId: 'L1', price: 5120, type: 'FOOTPRINT_POC', imageId: 'I1' },
      { levelId: 'L2', price: 5100.5, type: 'GEX_PUT_WALL', imageId: 'I2' },
      { levelId: 'L3', price: 5150, type: 'FOOTPRINT_VALUE_AREA_HIGH', imageId: 'I1' },
      { levelId: 'L4', price: 5120, type: 'FOOTPRINT_VALUE_AREA_LOW', imageId: 'I2' },
    ],
    recommendation: {
      side: 'LONG',
      timing: 'ON_RETEST',
      triggerLevelId: 'L1',
      entryLevelId: 'L1',
      invalidationLevelId: 'L2',
      targetLevelIds: ['L3'],
      confidence: 'MEDIUM',
      summary: 'Retest of the point of control with the put wall beneath as invalidation.',
    },
    rationale: [
      {
        claim: 'Entry sits at the point of control extracted from the footprint chart.',
        imageId: 'I1',
        levelIds: ['L1'],
      },
      {
        claim: 'Invalidation rests below the put wall from the GEX ladder.',
        imageId: 'I2',
        levelIds: ['L2'],
      },
    ],
    assumptions: [],
    modelUsage: {
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      promptVersion: 'extraction@v1;synthesis@v1',
      imageCallCount: 2,
      synthesisCompletionTokens: 118,
      latencyMs: 5230,
    },
    disclaimer: DISCLAIMER,
    ...overrides,
  };
}

/**
 * The one element matching a selector, or a failure naming what the surface did not render.
 *
 * A complete read is expected in every case below, so an absent node is a test failure with a
 * readable message rather than a `null` that turns each following assertion into a type error.
 */
function one(scope: HTMLElement, selector: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`Nothing matched ${selector}.`);
  }
  return found;
}

/** The stored ids of the level table's rows, in the order the table renders them. */
function levelRowIds(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.level-table tbody tr')).map((row) =>
    row.getAttribute('data-level-id'),
  );
}

/** Renders the surface with the two departure controls spied, so each case can assert on them. */
function renderSurface(props: Partial<AnalysisSurfaceProps> = {}) {
  const onBackToHistory = vi.fn();
  const onNewAnalysis = vi.fn();

  const result = render(
    <AnalysisSurface
      analysisId="a1"
      onBackToHistory={onBackToHistory}
      onNewAnalysis={onNewAnalysis}
      {...props}
    />,
  );

  return { ...result, onBackToHistory, onNewAnalysis };
}

describe('AnalysisSurface', () => {
  describe('the recommendation', () => {
    it('renders a LONG read from the document it was handed, without reading it again', () => {
      const { container } = renderSurface({ initialDocument: buildDocument() });

      const card = one(container, '.recommendation');
      expect(card).toHaveAttribute('data-side', 'LONG');
      expect(card).toHaveAttribute('data-timing', 'ON_RETEST');
      expect(within(card).getByText('5120')).toBeInTheDocument();
      expect(within(card).getByText('5100.5')).toBeInTheDocument();
      expect(within(card).getByText('5150')).toBeInTheDocument();
      expect(card).toHaveTextContent(
        'Retest of the point of control with the put wall beneath as invalidation.',
      );
      expect(card.textContent).not.toContain('\u2014');

      expect(mockedGetAnalysis).not.toHaveBeenCalled();
      expect(container.querySelector('.pending-indicator')).toBeNull();
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it('renders a SHORT read', () => {
      const { container } = renderSurface({
        initialDocument: buildDocument({
          recommendation: {
            side: 'SHORT',
            timing: 'ON_BREAK',
            triggerLevelId: 'L2',
            entryLevelId: 'L2',
            invalidationLevelId: 'L3',
            targetLevelIds: ['L1'],
            confidence: 'HIGH',
            summary: 'Break of the put wall targets the point of control.',
          },
        }),
      });

      const card = one(container, '.recommendation');
      expect(card).toHaveAttribute('data-side', 'SHORT');
      expect(card).toHaveAttribute('data-timing', 'ON_BREAK');
      expect(within(card).getByText('5100.5')).toBeInTheDocument();
      expect(within(card).getByText('5150')).toBeInTheDocument();
      expect(within(card).getByText('High')).toHaveAttribute('data-confidence', 'HIGH');
      expect(card).toHaveTextContent('Break of the put wall targets the point of control.');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('renders NO_TRADE as a complete result with no error framing', () => {
      const { container } = renderSurface({
        initialDocument: buildDocument({
          recommendation: {
            side: 'NO_TRADE',
            timing: 'WAIT',
            triggerLevelId: null,
            entryLevelId: null,
            invalidationLevelId: null,
            targetLevelIds: [],
            confidence: 'LOW',
            summary: 'No directional read: the levels conflict across the two screenshots.',
          },
        }),
      });

      const card = one(container, '.recommendation');
      expect(card).toHaveAttribute('data-side', 'NO_TRADE');
      expect(card).toHaveAttribute('data-timing', 'WAIT');
      expect(card).toHaveTextContent(
        'No directional read: the levels conflict across the two screenshots.',
      );
      /* Entry, invalidation and targets each say they are unavailable rather than showing a price:
       * a read that holds no reference reports three absences and still reads as a result. */
      expect(card.querySelectorAll('.recommendation__value--none')).toHaveLength(3);
      expect(card.textContent?.match(/\u2014/g)).toHaveLength(3);

      expect(screen.queryByRole('alert')).toBeNull();
      expect(container.querySelector('.error-notice')).toBeNull();
      expect(container.querySelector('[data-error]')).toBeNull();
    });

    it('offers no order, size, prompt or broker control', () => {
      const { container } = renderSurface({ initialDocument: buildDocument() });

      expect(screen.queryByRole('textbox')).toBeNull();
      expect(container.querySelector('input, textarea, select')).toBeNull();
      expect(container.querySelector('a[href]')).toBeNull();

      const labelled = screen.getAllByRole('button').map((button) => button.textContent);
      expect(labelled).toHaveLength(2);
      expect(labelled).toEqual(expect.arrayContaining(['New analysis', 'History']));
    });
  });

  describe('the levels and the evidence behind them', () => {
    it('traces the entry and invalidation references to level-table rows', () => {
      const stored = buildDocument();
      const { container } = renderSurface({ initialDocument: stored });

      const referenced = Array.from(
        one(container, '.recommendation').querySelectorAll<HTMLElement>(
          '.recommendation__value[data-level-id]',
        ),
      );
      expect(referenced.map((cell) => cell.getAttribute('data-level-id'))).toEqual([
        stored.recommendation.entryLevelId,
        stored.recommendation.invalidationLevelId,
      ]);

      /* The price printed on the card and the price printed on the row it cites are one value:
       * the card derives nothing, so a mismatch here would mean a price reached the screen that no
       * extracted level holds. */
      for (const cell of referenced) {
        const levelId = cell.getAttribute('data-level-id');
        const row = one(container, `.level-table tbody tr[data-level-id="${levelId}"]`);
        expect(one(row, '.level-table__price').textContent).toBe(cell.textContent);
      }

      expect(levelRowIds(container)).toEqual(['L1', 'L2', 'L3', 'L4']);
      expect(container.querySelectorAll('.level-table tbody tr')).toHaveLength(
        stored.levels.length,
      );
    });

    it('renders the level and evidence tables with the source images named', () => {
      const { container } = renderSurface({ initialDocument: buildDocument() });

      const table = one(container, '.level-table');
      expect(within(table).getAllByText('5120')).toHaveLength(2);
      expect(within(table).getByText('5100.5')).toBeInTheDocument();
      expect(within(table).getByText('5150')).toBeInTheDocument();
      expect(table).toHaveTextContent('footprint-es-5m.png');
      expect(table).toHaveTextContent('gex-es-levels.png');

      const evidence = one(container, '.evidence-list');
      expect(evidence).toHaveTextContent('footprint-es-5m.png');
      expect(evidence).toHaveTextContent('gex-es-levels.png');

      const items = Array.from(evidence.querySelectorAll('.evidence-list__item'));
      expect(items.map((item) => item.getAttribute('data-image-id'))).toEqual(['I1', 'I2']);
      expect(items.map((item) => item.getAttribute('data-level-ids'))).toEqual(['L1', 'L2']);
    });

    it('shows the prompt version and the model the analysis recorded', () => {
      const { container } = renderSurface({ initialDocument: buildDocument() });

      const meta = one(container, '.meta');
      expect(meta).toHaveTextContent('extraction@v1;synthesis@v1');
      expect(meta).toHaveTextContent('google/gemini-2.5-flash');
    });

    it('renders exactly one disclaimer, and it is the shared constant', () => {
      const { container } = renderSurface({ initialDocument: buildDocument() });

      const nodes = container.querySelectorAll('.disclaimer');
      expect(nodes).toHaveLength(1);
      expect(nodes.item(0)?.textContent).toBe(DISCLAIMER);
    });
  });

  describe('the submitted screenshots', () => {
    it('renders each screenshot with its status and the URL its stored bytes come from', () => {
      const { container } = renderSurface({
        initialDocument: buildDocument({
          images: [
            imageFixture(),
            gexImage({ status: 'UNREADABLE', extractionError: 'No chart content detected' }),
          ],
        }),
      });

      const items = Array.from(container.querySelectorAll<HTMLElement>('.image-status'));
      expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
        'ANALYZED',
        'UNREADABLE',
      ]);

      const analyzed = items.find((item) => item.getAttribute('data-status') === 'ANALYZED');
      const unreadable = items.find((item) => item.getAttribute('data-status') === 'UNREADABLE');
      expect(analyzed?.querySelector('.status--analyzed')).not.toBeNull();
      expect(unreadable?.querySelector('.status--unreadable')).not.toBeNull();
      expect(unreadable).toHaveTextContent('No chart content detected');

      /* The thumbnails are addressed through the transport module, so the stored bytes are found by
       * analysis id and image id rather than by a path this component assembles itself. */
      expect(mockedAnalysisImageUrl).toHaveBeenCalledWith('a1', 'I1');
      expect(mockedAnalysisImageUrl).toHaveBeenCalledWith('a1', 'I2');
      const thumbnails = Array.from(container.querySelectorAll('.image-status__thumb'));
      expect(thumbnails.map((thumb) => thumb.getAttribute('src'))).toEqual([
        storedImageUrl('a1', 'I1'),
        storedImageUrl('a1', 'I2'),
      ]);
      expect(thumbnails.map((thumb) => thumb.getAttribute('alt'))).toEqual([
        'footprint-es-5m.png',
        'gex-es-levels.png',
      ]);
    });

    it('renders the assumptions the analysis recorded, and no list when it recorded none', () => {
      const recorded = renderSurface({
        initialDocument: buildDocument({
          assumptions: ['Timing corrected to WAIT: no current price was reported.'],
        }),
      });

      const list = one(recorded.container, '.assumptions');
      expect(list).toHaveTextContent('Timing corrected to WAIT: no current price was reported.');
      recorded.unmount();

      const silent = renderSurface({ initialDocument: buildDocument() });
      expect(silent.container.querySelector('.assumptions')).toBeNull();
    });
  });

  describe('reading a stored analysis', () => {
    it('reads the analysis when no document was supplied', async () => {
      mockedGetAnalysis.mockResolvedValue(buildDocument());

      const { container } = renderSurface();

      expect(container.querySelector('.pending-indicator')).not.toBeNull();

      await waitFor(() => {
        expect(container.querySelector('.level-table')).not.toBeNull();
      });

      expect(mockedGetAnalysis).toHaveBeenCalledTimes(1);
      expect(mockedGetAnalysis).toHaveBeenCalledWith('a1');
      expect(one(container, '.recommendation')).toHaveAttribute('data-side', 'LONG');
      expect(container.querySelector('.pending-indicator')).toBeNull();
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it('shows the pending state and no alert while the read is in flight', () => {
      mockedGetAnalysis.mockReturnValue(new Promise<AnalysisDocument>(() => {}));

      const { container } = renderSurface();

      expect(one(container, '.pending-indicator')).toHaveAttribute('role', 'status');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('returns to history for a gone analysis, without a notice', async () => {
      mockedGetAnalysis.mockRejectedValue(
        Object.assign(new Error('Analysis a1 was not found.'), {
          code: 'NOT_FOUND',
          status: 404,
        }),
      );

      const { container, onBackToHistory } = renderSurface();

      await waitFor(() => {
        expect(onBackToHistory).toHaveBeenCalledTimes(1);
      });

      expect(container.querySelector('.error-notice')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(container.textContent).toContain('That analysis is no longer available.');
    });

    it('shows the provider failure and re-reads the analysis on Try again', async () => {
      const user = userEvent.setup();
      mockedGetAnalysis
        .mockRejectedValueOnce(
          Object.assign(new Error('Insufficient credits on the model account.'), {
            code: 'PROVIDER_QUOTA_EXCEEDED',
            status: 503,
          }),
        )
        .mockResolvedValueOnce(buildDocument());

      const { container } = renderSurface();

      await waitFor(() => {
        expect(container.querySelector('.error-notice')).not.toBeNull();
      });

      const notice = one(container, '.error-notice');
      expect(notice).toHaveAttribute('role', 'alert');
      expect(notice).toHaveAttribute('data-code', 'PROVIDER_QUOTA_EXCEEDED');
      expect(notice).toHaveTextContent('Insufficient credits on the model account.');
      /* A failure replaces the pending indicator rather than sitting beside it, and the surface
       * still carries the fixed disclaimer, because it is a surface that shows a recommendation. */
      expect(container.querySelector('.pending-indicator')).toBeNull();
      expect(one(container, '.disclaimer').textContent).toBe(DISCLAIMER);

      await user.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(container.querySelector('.level-table')).not.toBeNull();
      });

      expect(mockedGetAnalysis).toHaveBeenCalledTimes(2);
      expect(container.querySelector('.error-notice')).toBeNull();
      expect(one(container, '.recommendation')).toHaveAttribute('data-side', 'LONG');
    });

    it('answers an unrecognised failure with the fallback code', async () => {
      mockedGetAnalysis.mockRejectedValue(new Error('boom'));

      const { container } = renderSurface();

      await waitFor(() => {
        expect(container.querySelector('.error-notice')).not.toBeNull();
      });

      expect(one(container, '.error-notice')).toHaveAttribute('data-code', 'INTERNAL_ERROR');
      expect(container.querySelector('.recommendation')).toBeNull();
    });
  });
});
