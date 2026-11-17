/**
 * Suite for the fixed disclaimer: the sentence every surface that shows a recommendation carries,
 * and the one surface that must carry none.
 *
 * The evidence owed here is exactness rather than similarity. The expected value is the shared
 * constant imported from `@trade-read/shared`, never a copy of the sentence, and it is compared
 * with `toBe` against `textContent`, because Testing Library's default normaliser trims a value and
 * collapses runs of whitespace: a text query alone would accept a stray space or a wrapped line
 * that the interface must never render.
 *
 * Two surfaces show a recommendation, so two surfaces carry the sentence. The analysis surface
 * prints one trade read, and the history surface prints a side and a timing on every row, which
 * makes that list a recommendation surface as well; it therefore keeps the sentence beneath the
 * list in every state, and the populated and empty states are both asserted. The upload surface
 * shows no recommendation, so it carries none, and that absence is asserted only once the surface
 * has rendered its submit control, so a tree that rendered nothing cannot satisfy it.
 *
 * The API module is replaced whole, so no case here reads a credential or attempts a request: the
 * analysis surface is handed the document it would otherwise read back, and the history surface is
 * handed a page of one. The fixture's own `disclaimer` field is the imported constant for the same
 * reason as the assertions, so the stored document and the interface cannot hold two different
 * sentences inside this suite.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DISCLAIMER, type AnalysisDocument } from '@trade-read/shared';

/**
 * The one module the surfaces reach for input and output, replaced whole.
 *
 * The factory is self-contained because Vitest hoists it above this file's imports, and it declares
 * every export of the real module: a surface importing a name the double lacks would fail on the
 * import rather than on an assertion, which reads as a broken suite instead of a finding. `ApiError`
 * is a real class because the history surface classifies a rejection with `instanceof`.
 */
vi.mock('../api/analysis-api', () => {
  class DoubleApiError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, status: number) {
      super(`The API answered ${code}.`);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }

  return {
    ApiError: DoubleApiError,
    createAnalysis: vi.fn(),
    getAnalysis: vi.fn(),
    listAnalyses: vi.fn(),
    deleteAnalysis: vi.fn(),
    analysisImageUrl: (analysisId: string, imageId: string) =>
      `/api/v1/analyses/${analysisId}/images/${imageId}`,
    getHealth: vi.fn(),
  };
});

import { getAnalysis, listAnalyses } from '../api/analysis-api';
import AnalysisSurface from '../features/analysis/analysis-surface';
import HistorySurface from '../features/history/history-surface';
import UploadSurface from '../features/upload/upload-surface';

/**
 * The analysis every case renders.
 *
 * It is the shortest document the shared contract admits: one image, one level, and a
 * `NO_TRADE`/`WAIT` read, which the contract calls a complete answer rather than a failure. That is
 * deliberate — the sentence must be on screen for a read that recommends nothing to do, which is
 * the state a reader is most likely to misread as an error page. `satisfies` keeps the shape a
 * compile-time obligation, so a contract change breaks this file instead of passing silently.
 */
const DOCUMENT = {
  analysisId: 'analysis-1',
  createdAt: '2024-05-01T13:30:00.000Z',
  instrument: 'ES',
  context: 'Footprint chart and gamma levels, five-minute.',
  images: [
    {
      imageId: 'image-1',
      fileName: 'footprint-es-5m.png',
      contentType: 'image/png',
      byteSize: 96_512,
      width: 1600,
      height: 900,
      status: 'ANALYZED',
    },
  ],
  levels: [
    {
      levelId: 'level-1',
      price: 5_123.25,
      type: 'FOOTPRINT_POC',
      imageId: 'image-1',
    },
  ],
  recommendation: {
    side: 'NO_TRADE',
    timing: 'WAIT',
    triggerLevelId: null,
    entryLevelId: null,
    invalidationLevelId: null,
    targetLevelIds: [],
    confidence: 'LOW',
    summary: 'No side is worth taking until price leaves the point of control.',
  },
  rationale: [],
  assumptions: [],
  modelUsage: {
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    promptVersion: 'extraction@1;synthesis@1',
    imageCallCount: 1,
    synthesisCompletionTokens: 58,
    latencyMs: 3_400,
  },
  disclaimer: DISCLAIMER,
} satisfies AnalysisDocument;

/** A callback the surfaces require and no case here exercises. */
const noop = () => {};

/**
 * The options that make a text query exact: an identity normaliser in place of Testing Library's
 * own, which trims the value and collapses runs of whitespace before comparing it. Passed to both
 * the positive and the negative query so neither can be satisfied by a paragraph that merely
 * contains the sentence.
 */
const EXACT_TEXT = {
  exact: true,
  normalizer: (value: string): string => value,
};

/**
 * Asserts that every element carrying the disclaimer class reads byte for byte as the shared
 * constant.
 *
 * Reading `textContent` directly is what makes the check one of exactness: the rendered paragraph
 * holds the constant and nothing else, so any added character — a space, a newline, a second
 * sentence — is a difference this comparison reports and a normalised query would hide. Every
 * matching element is checked, not the first, so a surface that rendered the sentence twice with
 * one altered is still caught.
 *
 * @param container - The element the case rendered, which is the whole surface.
 */
function expectExactDisclaimer(container: HTMLElement): void {
  const nodes = Array.from(container.querySelectorAll('.disclaimer'));

  expect(nodes.length, 'the surface rendered no element carrying the disclaimer').toBeGreaterThan(0);

  for (const node of nodes) {
    expect(node.textContent, 'a disclaimer element did not read as the shared constant').toBe(
      DISCLAIMER,
    );
  }
}

describe('the fixed disclaimer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is rendered byte-exactly beside a trade read on the analysis surface', async () => {
    const { container } = render(
      <AnalysisSurface
        analysisId={DOCUMENT.analysisId}
        initialDocument={DOCUMENT}
        onBackToHistory={noop}
        onNewAnalysis={noop}
      />,
    );

    // The read itself is on screen, so the sentence is asserted against a populated recommendation
    // surface rather than one that rendered an empty tree.
    expect(screen.getByRole('heading', { name: 'Trade read' })).toBeInTheDocument();

    expectExactDisclaimer(container);

    // The same paragraph is reachable by its text with the normaliser removed, which is what a
    // reader sees; the assertion above only proves the characters match.
    expect(await screen.findByText(DISCLAIMER, EXACT_TEXT)).toBeInTheDocument();
  });

  it('is rendered while the analysis surface is still reading', async () => {
    // A read that never settles holds the surface in its pending state for the whole case, so the
    // sentence is asserted against a surface that holds no recommendation yet.
    vi.mocked(getAnalysis).mockReturnValue(new Promise<AnalysisDocument>(() => {}));

    const { container } = render(
      <AnalysisSurface analysisId="analysis-2" onBackToHistory={noop} onNewAnalysis={noop} />,
    );

    expect(await screen.findByRole('status')).toHaveTextContent('Loading analysis…');

    expectExactDisclaimer(container);
  });

  it.each([
    {
      state: 'a populated list',
      items: [DOCUMENT] as AnalysisDocument[],
      settled: DOCUMENT.instrument,
    },
    { state: 'an empty list', items: [] as AnalysisDocument[], settled: 'No analyses yet.' },
  ])('is rendered byte-exactly on the history surface over $state', async ({ items, settled }) => {
    vi.mocked(listAnalyses).mockResolvedValue({ items });

    const { container } = render(
      <HistorySurface onOpenAnalysis={noop} onNewAnalysis={noop} />,
    );

    // Waiting for the row, or for the empty state, is what proves the list has settled: the
    // sentence beneath it is then asserted against the state a reader actually sees.
    await screen.findByText(settled);

    expectExactDisclaimer(container);
  });

  it('is absent from the upload surface, which shows no recommendation', async () => {
    const { container } = render(<UploadSurface onCreated={noop} />);

    // The surface is settled before the absence is read: the submit control and the drop zone are
    // both found first, so a surface that failed to render cannot satisfy the assertions below.
    expect(
      await screen.findByRole('button', { name: 'Analyse screenshots' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add chart screenshots/i }),
    ).toBeInTheDocument();

    expect(container.querySelector('.disclaimer')).toBeNull();
    expect(screen.queryByText(DISCLAIMER, EXACT_TEXT)).toBeNull();
  });
});
