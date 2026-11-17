/**
 * Suite for the history surface: the stored analyses rendered in the order the API answered with,
 * and a deletion that is armed in place before any request leaves the process.
 *
 * The surface owns two decisions, so the assertions divide along those seams. The order is the
 * server's — `AnalysisListResponse.items` arrives newest first and the rows are rendered exactly as
 * received — so the page below is deliberately ordered such that no client-side sort by date, id or
 * instrument reproduces the supplied sequence, which is what lets the order assertion fail if the
 * component ever re-orders. A deletion is armed by the first press and sent only by the
 * confirmation, so the idle, armed and deleted states are each read from the accessibility tree, and
 * `confirm` is spied on to prove no browser dialog is involved.
 *
 * Everything here runs offline. `api/analysis-api.ts` is mocked, so the two transport functions this
 * surface calls are spies while the real `ApiError` class survives for the failure cases, and a
 * `fetch` guard is installed for every test and asserted unused afterwards: a request that reached
 * the network would fail the suite instead of passing quietly.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISCLAIMER, HISTORY_LIMIT_DEFAULT } from '@trade-read/shared';
import type { AnalysisDocument, AnalysisListResponse, Side, Timing } from '@trade-read/shared';

import { ApiError, deleteAnalysis, listAnalyses } from '../../api/analysis-api';
import { messageForCode, shouldOfferResubmit } from '../../api/errors';
import HistorySurface from './history-surface';

/**
 * The transport spies. The factory keeps every other export of the module — `ApiError` above all,
 * because the failure cases construct one — and replaces only the two calls this surface makes, so
 * no test can reach a server. Vitest hoists this call above the imports, which is why the factory
 * receives the module's own exports rather than closing over a binding.
 */
vi.mock('../../api/analysis-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/analysis-api')>();
  return { ...actual, listAnalyses: vi.fn(), deleteAnalysis: vi.fn() };
});

/**
 * The guard every test installs as `fetch`.
 *
 * With the api module mocked, nothing in this suite should touch the transport at all; the guard is
 * what turns a stray direct call into a failure instead of a request, and the `afterEach` below
 * asserts it was never called so that "reaches no network" is a checked fact.
 */
const fetchGuard = vi.fn(() => {
  throw new Error('network access is forbidden in this suite');
});

/** The one model slug every fixture records, so no document invents a second. */
const ANALYSIS_MODEL = 'google/gemini-2.5-flash';

/** The fields a fixture varies; everything else about its document is derived from these. */
interface DocumentSeed {
  readonly analysisId: string;
  /** ISO-8601 UTC, exactly as the server stores it. */
  readonly createdAt: string;
  readonly instrument: string;
  readonly side: Side;
  readonly timing: Timing;
}

/**
 * One complete `AnalysisDocument`, built from a seed.
 *
 * The shape is the shared contract's field for field, so a missing or mistyped member fails the type
 * check here instead of at a component's render. A directional read carries entry, invalidation and
 * target references with one rationale entry per level it uses; `NO_TRADE` carries null references,
 * no targets and no evidence, which is the shape the contract defines for it.
 *
 * @param seed - The fields that distinguish one fixture from another.
 * @returns A document valid against the shared contract.
 */
function documentFrom(seed: DocumentSeed): AnalysisDocument {
  const imageId = `${seed.analysisId}-image`;
  const entryLevelId = `${seed.analysisId}-entry`;
  const invalidationLevelId = `${seed.analysisId}-invalidation`;
  const targetLevelId = `${seed.analysisId}-target`;
  const directional = seed.side !== 'NO_TRADE';

  return {
    analysisId: seed.analysisId,
    createdAt: seed.createdAt,
    instrument: seed.instrument,
    context: '',
    images: [
      {
        imageId,
        fileName: `${seed.analysisId}-chart.png`,
        contentType: 'image/png',
        byteSize: 18_342,
        width: 1600,
        height: 900,
        status: 'ANALYZED',
      },
    ],
    levels: [
      { levelId: entryLevelId, price: 5_342.25, type: 'FOOTPRINT_POC', imageId },
      { levelId: invalidationLevelId, price: 5_331.5, type: 'FOOTPRINT_VALUE_AREA_LOW', imageId },
      { levelId: targetLevelId, price: 5_368, type: 'GEX_CALL_WALL', imageId },
    ],
    recommendation: {
      side: seed.side,
      timing: seed.timing,
      triggerLevelId: directional ? entryLevelId : null,
      entryLevelId: directional ? entryLevelId : null,
      invalidationLevelId: directional ? invalidationLevelId : null,
      targetLevelIds: directional ? [targetLevelId] : [],
      confidence: directional ? 'MEDIUM' : 'LOW',
      summary: directional
        ? `Holding ${seed.instrument} above the point of control keeps the read alive.`
        : `No submitted screenshot gives ${seed.instrument} a direction to act on.`,
    },
    rationale: directional
      ? [
          { claim: 'Entry sits on the point of control.', imageId, levelIds: [entryLevelId] },
          {
            claim: 'A close back below value area low invalidates the read.',
            imageId,
            levelIds: [invalidationLevelId],
          },
        ]
      : [],
    assumptions: directional
      ? []
      : ['Timing was corrected to WAIT because no image reported a current price.'],
    modelUsage: {
      provider: 'openrouter',
      model: ANALYSIS_MODEL,
      promptVersion: 'extraction@1;synthesis@1',
      imageCallCount: 1,
      synthesisCompletionTokens: 58,
      latencyMs: 4_120,
    },
    disclaimer: DISCLAIMER,
  };
}

const ALPHA = documentFrom({
  analysisId: 'alpha',
  createdAt: '2024-05-03T15:05:00.000Z',
  instrument: 'ES',
  side: 'LONG',
  timing: 'NOW',
});

const BRAVO = documentFrom({
  analysisId: 'bravo',
  createdAt: '2024-05-02T11:45:00.000Z',
  instrument: 'NQ',
  side: 'SHORT',
  timing: 'ON_RETEST',
});

const CHARLIE = documentFrom({
  analysisId: 'charlie',
  createdAt: '2024-05-01T09:30:00.000Z',
  instrument: 'CL',
  side: 'NO_TRADE',
  timing: 'WAIT',
});

/**
 * The page the API answers with, in the sequence the store returned it.
 *
 * The order is deliberately unlike anything a client could derive: the timestamps run middle, oldest,
 * newest while the ids run bravo, charlie, alpha and the instruments NQ, CL, ES, so sorting by date
 * (either direction), by id, by instrument, or reversing the list each produce a different sequence
 * than the one supplied.
 */
const SUPPLIED_PAGE: AnalysisListResponse = { items: [BRAVO, CHARLIE, ALPHA] };

/** The supplied sequence, taken from the page itself so there is one copy of it. */
const SUPPLIED_IDS = SUPPLIED_PAGE.items.map((document) => document.analysisId);

/**
 * Renders the surface with the two callbacks the application passes, spied.
 *
 * @returns The rendered view and the spies behind its props.
 */
function renderHistory() {
  const onOpenAnalysis = vi.fn<(analysisId: string) => void>();
  const onNewAnalysis = vi.fn<() => void>();

  const view = render(
    <HistorySurface onOpenAnalysis={onOpenAnalysis} onNewAnalysis={onNewAnalysis} />,
  );

  return { ...view, onOpenAnalysis, onNewAnalysis };
}

/**
 * The rendered rows' analysis ids, in the order the document holds them.
 *
 * @returns One entry per row, `data-analysis-id` as markup carries it.
 */
async function renderedIds(): Promise<Array<string | null>> {
  const rows = await screen.findAllByRole('listitem');

  return rows.map((row) => row.getAttribute('data-analysis-id'));
}

/**
 * The row for one analysis, found through the control that names it.
 *
 * @param analysisId - The identifier the row's controls carry.
 * @returns The list item holding those controls.
 */
async function findRow(analysisId: string): Promise<HTMLElement> {
  const open = await screen.findByRole('button', { name: `Open analysis ${analysisId}` });
  const row = open.closest('li');

  if (row === null) {
    throw new Error(`No list item holds the controls for ${analysisId}.`);
  }

  return row;
}

beforeEach(() => {
  vi.mocked(listAnalyses).mockReset();
  vi.mocked(deleteAnalysis).mockReset();
  fetchGuard.mockClear();
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  // The whole point of the guard: a request that slipped past the mock is reported, not swallowed.
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('HistorySurface', () => {
  describe('the stored list', () => {
    it('renders the rows in the order the API supplied them, at the shared default page size', async () => {
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);

      renderHistory();

      const rows = await screen.findAllByRole('listitem');

      expect(listAnalyses).toHaveBeenCalledTimes(1);
      expect(listAnalyses).toHaveBeenCalledWith(HISTORY_LIMIT_DEFAULT);
      expect(rows.map((row) => row.getAttribute('data-analysis-id'))).toEqual(SUPPLIED_IDS);
    });

    it("shows a row's instrument, stored timestamp, side and timing", async () => {
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);

      renderHistory();

      const row = await findRow(ALPHA.analysisId);

      expect(within(row).getByText(ALPHA.instrument)).toBeInTheDocument();

      const timestamp = within(row).getByText(ALPHA.createdAt);
      expect(timestamp.tagName).toBe('TIME');
      expect(timestamp).toHaveAttribute('datetime', ALPHA.createdAt);

      expect(within(row).getByText(ALPHA.recommendation.side)).toBeInTheDocument();
      expect(within(row).getByText(ALPHA.recommendation.timing)).toBeInTheDocument();
    });

    it('opens the analysis a row names and leaves for a new one', async () => {
      const user = userEvent.setup();
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);

      const { onOpenAnalysis, onNewAnalysis } = renderHistory();

      await user.click(
        await screen.findByRole('button', { name: `Open analysis ${CHARLIE.analysisId}` }),
      );

      expect(onOpenAnalysis).toHaveBeenCalledTimes(1);
      expect(onOpenAnalysis).toHaveBeenCalledWith(CHARLIE.analysisId);

      await user.click(screen.getByRole('button', { name: 'Start a new analysis' }));

      expect(onNewAnalysis).toHaveBeenCalledTimes(1);
    });

    it('shows the empty state, and no rows, when the store holds nothing', async () => {
      vi.mocked(listAnalyses).mockResolvedValue({ items: [] });

      const { container } = renderHistory();

      await waitFor(() => {
        expect(container.querySelector('.empty-state')).not.toBeNull();
      });

      expect(container.querySelector('.empty-state')).toHaveTextContent('No analyses yet.');
      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
      expect(screen.queryByRole('alert')).toBeNull();
      // The disclaimer is not conditional on there being rows: every state of this surface shows it.
      expect(screen.getByRole('note')).toHaveTextContent(DISCLAIMER);
    });
  });

  describe('deletion', () => {
    it('arms a row for deletion without sending a request or opening a browser dialog', async () => {
      const user = userEvent.setup();
      const browserDialog = vi.fn(() => true);
      vi.stubGlobal('confirm', browserDialog);
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);

      renderHistory();
      await findRow(CHARLIE.analysisId);

      await user.click(
        screen.getByRole('button', { name: `Delete analysis ${CHARLIE.analysisId}` }),
      );

      expect(
        screen.getByRole('button', { name: `Confirm delete ${CHARLIE.analysisId}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Cancel delete ${CHARLIE.analysisId}` }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: `Delete analysis ${CHARLIE.analysisId}` }),
      ).toBeNull();

      // Arming is per row: the other rows keep their own idle controls.
      expect(
        screen.getByRole('button', { name: `Delete analysis ${BRAVO.analysisId}` }),
      ).toBeInTheDocument();
      expect(deleteAnalysis).not.toHaveBeenCalled();
      expect(browserDialog).not.toHaveBeenCalled();
    });

    it('leaves the row as it was when the confirmation is cancelled', async () => {
      const user = userEvent.setup();
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);

      renderHistory();
      await findRow(CHARLIE.analysisId);

      await user.click(
        screen.getByRole('button', { name: `Delete analysis ${CHARLIE.analysisId}` }),
      );
      await user.click(
        screen.getByRole('button', { name: `Cancel delete ${CHARLIE.analysisId}` }),
      );

      expect(
        screen.getByRole('button', { name: `Delete analysis ${CHARLIE.analysisId}` }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: `Confirm delete ${CHARLIE.analysisId}` }),
      ).toBeNull();
      expect(deleteAnalysis).not.toHaveBeenCalled();
      expect(await renderedIds()).toEqual(SUPPLIED_IDS);
    });

    it('deletes the confirmed analysis once and drops only its row', async () => {
      const user = userEvent.setup();
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);
      vi.mocked(deleteAnalysis).mockResolvedValue(undefined);

      renderHistory();
      await findRow(CHARLIE.analysisId);

      await user.click(
        screen.getByRole('button', { name: `Delete analysis ${CHARLIE.analysisId}` }),
      );
      await user.click(
        screen.getByRole('button', { name: `Confirm delete ${CHARLIE.analysisId}` }),
      );

      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: `Open analysis ${CHARLIE.analysisId}` }),
        ).toBeNull();
      });

      expect(deleteAnalysis).toHaveBeenCalledTimes(1);
      expect(deleteAnalysis).toHaveBeenCalledWith(CHARLIE.analysisId);
      expect(screen.queryByText(CHARLIE.instrument)).toBeNull();
      expect(await renderedIds()).toEqual([BRAVO.analysisId, ALPHA.analysisId]);
      // The row was dropped from the list locally: a successful delete triggers no second read.
      expect(listAnalyses).toHaveBeenCalledTimes(1);
    });
  });

  describe('a failed read', () => {
    it("replaces the pending state with the code's message and a resubmit control that reads again", async () => {
      const user = userEvent.setup();
      vi.mocked(listAnalyses)
        .mockRejectedValueOnce(new ApiError('PROVIDER_NOT_CONFIGURED', 503))
        .mockResolvedValueOnce(SUPPLIED_PAGE);

      const { container } = renderHistory();

      const notice = await screen.findByRole('alert');

      expect(notice).toHaveAttribute('data-code', 'PROVIDER_NOT_CONFIGURED');
      expect(notice).toHaveTextContent(messageForCode('PROVIDER_NOT_CONFIGURED'));
      expect(container.querySelector('.pending-indicator')).toBeNull();
      expect(shouldOfferResubmit('PROVIDER_NOT_CONFIGURED')).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(listAnalyses).toHaveBeenCalledTimes(2);
      expect(await renderedIds()).toEqual(SUPPLIED_IDS);
    });

    it('shows the NOT_FOUND message with no resubmit control, matching the shared mapping', async () => {
      vi.mocked(listAnalyses).mockRejectedValue(new ApiError('NOT_FOUND', 404));

      renderHistory();

      const notice = await screen.findByRole('alert');

      expect(notice).toHaveAttribute('data-code', 'NOT_FOUND');
      expect(notice).toHaveTextContent(messageForCode('NOT_FOUND'));
      expect(shouldOfferResubmit('NOT_FOUND')).toBe(false);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
  });

  describe('the disclaimer', () => {
    it('renders the fixed sentence beneath the list, byte for byte', async () => {
      vi.mocked(listAnalyses).mockResolvedValue(SUPPLIED_PAGE);

      renderHistory();
      await screen.findAllByRole('listitem');

      const disclaimer = screen.getByRole('note');
      expect(disclaimer.textContent).toBe(DISCLAIMER);

      const list = screen.getByRole('list');
      const follows = list.compareDocumentPosition(disclaimer) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(follows).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
  });
});

