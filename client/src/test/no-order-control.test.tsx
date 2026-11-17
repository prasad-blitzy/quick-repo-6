/**
 * The cross-cutting proof that the client is a trade *read* and never a trading ticket: no surface
 * it renders offers an order, a position size or a broker action.
 *
 * AAP §0.6.5 (Required Absences, row 3) names this file as the evidence for that absence, and
 * §0.6.6 criterion 11 widens it to *every* surface — the upload surface included, because the
 * criterion says "no surface" — so all three surfaces are rendered here and every client source is
 * scanned. §0.7.3 and decision D15 shape the positive half: the side and the timing are output the
 * interface prints as data, and a `NO_TRADE`/`WAIT` read is an ordinary result rather than a
 * failure, so the positive assertions must find the recommendation *and* show it is inert.
 *
 * The guard is deliberately two halves, because either alone can pass vacuously. The rendered half
 * inspects the accessibility tree of each surface for a control a ticket would have to carry, and
 * checks that the side and timing text sits outside every control. The static half reads the client
 * sources through Vite's raw-import glob — this package declares no Node typings, so its filesystem
 * module is not available to it — and fails on a token that would introduce one anywhere, including
 * in a file no surface of today renders.
 *
 * Nothing here reaches a network: the transport module is replaced by doubles, a `fetch` double
 * stands behind it so a stray request cannot hang, and `downscaleImage` is stubbed because jsdom
 * has neither a canvas nor `createImageBitmap` to decode into.
 */

import { render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DISCLAIMER } from '@trade-read/shared';
import type { AnalysisDocument } from '@trade-read/shared';

import { analysisImageUrl, deleteAnalysis, listAnalyses } from '../api/analysis-api';
import AnalysisSurface from '../features/analysis/analysis-surface';
import HistorySurface from '../features/history/history-surface';
import UploadSurface from '../features/upload/upload-surface';

/**
 * The canvas path is stubbed, not exercised: jsdom implements neither `createImageBitmap` nor a 2D
 * canvas, so the real `downscaleImage` could only throw here. Every other export of the module —
 * `computeTargetSize`, `isBlankFrame` and the queued-image types — survives the spread, so the
 * upload surface keeps the behaviour this suite is not about.
 */
vi.mock('../features/upload/downscale-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/upload/downscale-image')>();

  return {
    ...actual,
    downscaleImage: vi.fn(async () => ({
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
      width: 800,
      height: 600,
      blankFrame: false,
    })),
  };
});

/**
 * The transport is replaced, and only where this suite must stand in for a server: the real
 * `ApiError` class and every real URL builder survive the spread, so a surface that constructs an
 * error or asks for an image URL behaves exactly as it does in production.
 *
 * The factory closes over no binding of this file, because Vitest hoists it above the imports; the
 * per-test answers are installed in `beforeEach` below.
 */
vi.mock('../api/analysis-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/analysis-api')>();

  return {
    ...actual,
    listAnalyses: vi.fn(),
    deleteAnalysis: vi.fn(),
    analysisImageUrl: vi.fn(),
  };
});

/** The one model slug a stored analysis records, so no fixture invents a second. */
const ANALYSIS_MODEL = 'google/gemini-2.5-flash';

/**
 * A stand-in thumbnail source.
 *
 * It carries a scheme nothing serves, so an assertion about a stored image's URL cannot be
 * satisfied by a URL a surface assembled itself.
 */
function storedImageUrl(analysisId: string, imageId: string): string {
  return `stored-image:${analysisId}/${imageId}`;
}

/**
 * A complete analysis: two screenshots and three levels, every field the shared contract requires.
 *
 * Prices exist only inside `levels[]`; the recommendation holds level references and no price of
 * its own, which is the structural rule AAP §0.3.2 states and the reason this file can prove the
 * side and timing are data without any price assertion at all.
 */
const FIXTURE: AnalysisDocument = {
  analysisId: 'guard-analysis',
  createdAt: '2025-05-01T12:00:00.000Z',
  instrument: 'ES',
  context: '',
  images: [
    {
      imageId: 'guard-i1',
      fileName: 'footprint-es-5m.png',
      contentType: 'image/png',
      byteSize: 184_320,
      width: 1600,
      height: 900,
      status: 'ANALYZED',
    },
    {
      imageId: 'guard-i2',
      fileName: 'gex-es-levels.png',
      contentType: 'image/png',
      byteSize: 151_552,
      width: 1400,
      height: 880,
      status: 'ANALYZED',
    },
  ],
  levels: [
    { levelId: 'guard-l1', price: 5120, type: 'FOOTPRINT_POC', imageId: 'guard-i1' },
    { levelId: 'guard-l2', price: 5100.5, type: 'GEX_PUT_WALL', imageId: 'guard-i2' },
    {
      levelId: 'guard-l3',
      price: 5150,
      type: 'FOOTPRINT_VALUE_AREA_HIGH',
      imageId: 'guard-i1',
    },
  ],
  recommendation: {
    side: 'LONG',
    timing: 'ON_RETEST',
    triggerLevelId: 'guard-l1',
    entryLevelId: 'guard-l1',
    invalidationLevelId: 'guard-l2',
    targetLevelIds: ['guard-l3'],
    confidence: 'MEDIUM',
    summary: 'Retest of the point of control with the put wall beneath as invalidation.',
  },
  rationale: [
    { claim: 'Entry sits at the point of control.', imageId: 'guard-i1', levelIds: ['guard-l1'] },
    {
      claim: 'Invalidation rests below the put wall.',
      imageId: 'guard-i2',
      levelIds: ['guard-l2'],
    },
  ],
  assumptions: [],
  modelUsage: {
    provider: 'openrouter',
    model: ANALYSIS_MODEL,
    promptVersion: 'extraction@v1;synthesis@v1',
    imageCallCount: 2,
    synthesisCompletionTokens: 96,
    latencyMs: 4200,
  },
  disclaimer: DISCLAIMER,
};

/**
 * The same analysis with no direction to take: null references, no targets, no evidence.
 *
 * D15 makes this a complete result, so the case below proves it renders as a recommendation — no
 * alert, no notice, no retry control — while still offering no control of the kind this file
 * exists to forbid.
 */
const NO_TRADE_FIXTURE: AnalysisDocument = {
  ...FIXTURE,
  analysisId: 'guard-analysis-no-trade',
  recommendation: {
    side: 'NO_TRADE',
    timing: 'WAIT',
    triggerLevelId: null,
    entryLevelId: null,
    invalidationLevelId: null,
    targetLevelIds: [],
    confidence: 'LOW',
    summary: 'No submitted screenshot gives ES a direction to take.',
  },
  rationale: [],
};

/**
 * The `fetch` double every test installs.
 *
 * It answers like the API rather than rejecting, so a request this suite should not make cannot
 * hang a test waiting for it, and the case that asserts the double was never called is what proves
 * the surfaces reach the API only through the module replaced above. `Response` itself is not
 * constructed: the object is a stand-in for the parts the transport reads.
 */
function createFetchStub() {
  return vi.fn(
    async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => FIXTURE,
      }) as unknown as Response,
  );
}

let fetchStub = createFetchStub();

/**
 * Arms every double before each test.
 *
 * The runner's `restoreMocks` covers spies rather than the implementations carried by the module
 * doubles, so each test starts from the same answers; `src/test/setup.ts` removes the global
 * `fetch` stub afterwards, for the whole suite.
 */
beforeEach(() => {
  vi.mocked(listAnalyses).mockResolvedValue({ items: [FIXTURE] });
  vi.mocked(deleteAnalysis).mockResolvedValue(undefined);
  vi.mocked(analysisImageUrl).mockImplementation(storedImageUrl);
  fetchStub = createFetchStub();
  vi.stubGlobal('fetch', fetchStub);
});

/**
 * The word this file forbids, assembled at runtime so its own source never contains the literal it
 * searches for — otherwise the static half would have to exempt this file for a token it only ever
 * names as the thing under guard.
 */
const ORDER_TOKEN = 'ord' + 'er';

/** One forbidden phrase and the label that names it in a failure message. */
interface OrderPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * The tokens that would indicate a control of the kind this file exists to forbid.
 *
 * Each pattern is deliberately narrow. A bare `\b<the word>\b` is useless here: production comments
 * say "queue order", "submission order" and "tab order" in their ordinary sense, and the fixed
 * disclaimer says the analysis is "not a recommendation to trade any instrument". A pattern that
 * trips on those is wrong, not the source. Equally, `size` alone would match `byteSize` and every
 * file-size caption, so only the position-sizing phrase is forbidden.
 */
const ORDER_PATTERNS: readonly OrderPattern[] = [
  { label: `place ${ORDER_TOKEN}`, pattern: new RegExp(`\\bplace\\s+${ORDER_TOKEN}\\b`, 'i') },
  {
    label: `${ORDER_TOKEN} ticket, entry or form`,
    pattern: new RegExp(`\\b${ORDER_TOKEN}\\s+(ticket|entry|form)\\b`, 'i'),
  },
  {
    label: `send, route, submit, cancel or confirm ${ORDER_TOKEN}`,
    pattern: new RegExp(`\\b(send|route|submit|cancel|confirm)\\s+${ORDER_TOKEN}\\b`, 'i'),
  },
  { label: 'qty', pattern: /\bqty\b/i },
  { label: 'quantity', pattern: /\bquantity\b/i },
  { label: 'position size', pattern: /\bposition[\s_-]?siz(e|ing)\b/i },
  { label: 'broker', pattern: /\bbroker(age)?\b/i },
  { label: 'buy or sell', pattern: /\b(buy|sell)\b/i },
  { label: 'notional', pattern: /\bnotional\b/i },
  { label: 'leverage', pattern: /\bleverage\b/i },
  { label: 'stop loss', pattern: /\bstop[-\s]?loss\b/i },
  { label: 'take profit', pattern: /\btake[-\s]?profit\b/i },
  { label: 'place or execute a trade', pattern: /(place|execute)\s+(a\s+)?trade\b/i },
];

/** Every element a person can operate, whether it is focusable by default or given a role. */
const CONTROL_SELECTOR = 'button, a, input, select, textarea, [role="button"]';

/** Every interactive role the accessibility tree can offer, so no control escapes by being custom. */
const CONTROL_ROLES = [
  'button',
  'textbox',
  'spinbutton',
  'combobox',
  'checkbox',
  'radio',
  'slider',
  'link',
] as const;

/**
 * The hooks a control of the forbidden kind would most plausibly carry. The attribute selector's
 * `i` flag makes the match case-insensitive, so a `data-action="PlaceOrder"` cannot slip past.
 */
const ORDER_HOOK_SELECTOR = `[data-action*="${ORDER_TOKEN}" i], [data-control*="${ORDER_TOKEN}" i]`;

/**
 * Everything a person could read as the name of a control: its accessible name where one is
 * declared, and the attributes this interface uses to label a control's behaviour, plus its text.
 */
function accessibleName(element: Element): string {
  const candidates = [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('name'),
    element.getAttribute('data-action'),
    element.getAttribute('data-control'),
    element.textContent,
  ];

  return candidates
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join(' ');
}

/** The patterns a piece of text matches, by label. */
function matchedLabels(text: string): string[] {
  return ORDER_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/**
 * Asserts that nothing a person can operate in `container` is a means of trading.
 *
 * The checks run from the blunt to the precise. A picker element or a numeric field is what a
 * ticket would need to choose a side, an account or a size, so both are refused outright. A form
 * that posts anywhere is refused because no surface here submits to anything but its own handler.
 * Then every control the tree offers is named and tested against the pattern set, so a control
 * cannot hide behind a role the elements above it do not have.
 *
 * @param container - The rendered surface's container, as Testing Library returns it.
 */
function expectNoOrderControl(container: HTMLElement): void {
  const scoped = within(container);

  expect(container.querySelector('select')).toBeNull();
  expect(container.querySelector('input[type="number"]')).toBeNull();
  expect(container.querySelectorAll('form[action]')).toHaveLength(0);
  expect(container.querySelector(ORDER_HOOK_SELECTOR)).toBeNull();

  const interactive = new Set<Element>(Array.from(container.querySelectorAll(CONTROL_SELECTOR)));

  for (const role of CONTROL_ROLES) {
    for (const element of scoped.queryAllByRole(role)) {
      interactive.add(element);
    }
  }

  const offenders = [...interactive]
    .map((element) => accessibleName(element))
    .filter((name) => name !== '')
    .flatMap((name) => matchedLabels(name).map((label) => `"${name.trim()}" :: ${label}`));

  expect(offenders, `controls named for trading:\n${offenders.join('\n')}`).toEqual([]);
}

describe('no surface offers a way to trade', () => {
  it('renders the trade read as inert data on the analysis surface, and offers no control of the kind this file forbids', () => {
    const { container } = render(
      <AnalysisSurface
        analysisId={FIXTURE.analysisId}
        initialDocument={FIXTURE}
        onBackToHistory={vi.fn()}
        onNewAnalysis={vi.fn()}
      />,
    );

    expectNoOrderControl(container);

    /* The positive half: the read is on screen, so the absence above cannot pass because nothing
     * rendered. Its side and timing are printed as the analysis recorded them, and the text sits
     * outside every control, which is what makes them data rather than an input. */
    const card = container.querySelector<HTMLElement>('.recommendation');
    expect(card).not.toBeNull();
    expect(card?.dataset.side).toBe(FIXTURE.recommendation.side);
    expect(card?.dataset.timing).toBe(FIXTURE.recommendation.timing);

    const side = container.querySelector('.recommendation__side');
    const timing = container.querySelector('.recommendation__timing');
    expect(side).not.toBeNull();
    expect(timing).not.toBeNull();

    /* The card prints its own label for a side, so the assertion reads the text the DOM holds
     * rather than restating a literal that a relabelling would silently invalidate. */
    const sideLabel = side?.textContent?.trim() ?? '';
    expect(sideLabel).not.toBe('');
    expect(timing?.textContent?.trim()).not.toBe('');
    expect(side?.closest(CONTROL_SELECTOR)).toBeNull();
    expect(timing?.closest(CONTROL_SELECTOR)).toBeNull();

    for (const node of within(container).getAllByText(sideLabel)) {
      expect(node.closest(CONTROL_SELECTOR)).toBeNull();
    }

    /* A surface that shows a recommendation carries the fixed disclaimer (AAP §0.6.6 criterion 11). */
    expect(within(container).getByText(DISCLAIMER)).toBeInTheDocument();
  });

  it('prints each history row side and timing as inert text, and offers no control of the kind this file forbids', async () => {
    const { container } = render(
      <HistorySurface onOpenAnalysis={vi.fn()} onNewAnalysis={vi.fn()} />,
    );

    await waitFor(() => {
      expect(vi.mocked(listAnalyses)).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelectorAll('.history-item')).toHaveLength(1);
    });

    expectNoOrderControl(container);

    /* A history row is a recommendation surface — it prints a side and a timing — so the same
     * positive half applies: `.history-item` and its two fields are the hooks the surface renders,
     * the values are there, and neither is operable. */
    const row = container.querySelector('.history-item');
    expect(row).not.toBeNull();

    const side = row?.querySelector('.history-item__side');
    const timing = row?.querySelector('.history-item__timing');
    expect(side?.textContent?.trim()).toBe(FIXTURE.recommendation.side);
    expect(timing?.textContent?.trim()).toBe(FIXTURE.recommendation.timing);
    expect(side?.closest(CONTROL_SELECTOR)).toBeNull();
    expect(timing?.closest(CONTROL_SELECTOR)).toBeNull();

    expect(within(container).getByText(DISCLAIMER)).toBeInTheDocument();
  });

  it('offers only the drop zone, two optional fields and one submit control on the upload surface', () => {
    const { container } = render(<UploadSurface onCreated={vi.fn()} />);

    expectNoOrderControl(container);

    /* Non-vacuity for this surface: it rendered its own controls, and they are the ones the
     * product has — a zone, two optional text fields, and a submit that stays closed until a file
     * is queued. None of them takes a side, an account or a size. */
    expect(
      within(container).getByRole('button', { name: /add chart screenshots/i }),
    ).toBeInTheDocument();
    expect(within(container).getByLabelText(/instrument/i)).toBeInTheDocument();
    expect(within(container).getByLabelText(/context/i)).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: /analyse screenshots/i })).toBeDisabled();
  });

  it('renders a NO_TRADE/WAIT read as an ordinary result, with no failure surface and no order control', () => {
    const { container } = render(
      <AnalysisSurface
        analysisId={NO_TRADE_FIXTURE.analysisId}
        initialDocument={NO_TRADE_FIXTURE}
        onBackToHistory={vi.fn()}
        onNewAnalysis={vi.fn()}
      />,
    );

    expectNoOrderControl(container);

    /* D15: a read with no direction to take is a complete answer. It renders through the same
     * card as any other, and nothing marks it as an error — no alert region, no notice, no retry. */
    const card = container.querySelector<HTMLElement>('.recommendation');
    expect(card).not.toBeNull();
    expect(card?.dataset.side).toBe('NO_TRADE');
    expect(card?.dataset.timing).toBe('WAIT');

    expect(within(container).queryByRole('alert')).toBeNull();
    expect(container.querySelector('.error-notice')).toBeNull();
    expect(within(container).queryByRole('button', { name: /try again/i })).toBeNull();
    expect(within(container).getByText(DISCLAIMER)).toBeInTheDocument();
  });

  it('reaches no network, so the proof holds offline and without a credential', async () => {
    const analysis = render(
      <AnalysisSurface
        analysisId={FIXTURE.analysisId}
        initialDocument={FIXTURE}
        onBackToHistory={vi.fn()}
        onNewAnalysis={vi.fn()}
      />,
    );
    expectNoOrderControl(analysis.container);
    analysis.unmount();

    const history = render(<HistorySurface onOpenAnalysis={vi.fn()} onNewAnalysis={vi.fn()} />);
    await waitFor(() => {
      expect(vi.mocked(listAnalyses)).toHaveBeenCalled();
    });
    expectNoOrderControl(history.container);
    history.unmount();

    const upload = render(<UploadSurface onCreated={vi.fn()} />);
    expectNoOrderControl(upload.container);
    upload.unmount();

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

/**
 * Every client source file, loaded as raw text through Vite's glob rather than from the filesystem:
 * this package's type configuration omits Node's typings, so its filesystem module would not
 * compile, and the glob is the one file reader a browser-targeted package has.
 *
 * Keys are relative to this file. `../styles.css` loads as an empty string because the runner turns
 * CSS processing off (`css: false` in `client/vitest.config.ts`), so the stylesheet is proven to be
 * *covered* rather than scanned: a stylesheet hosts no control, and the surfaces it styles are
 * covered by the rendered half above.
 */
const SOURCES = import.meta.glob('../**/*.{ts,tsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * The two absence scanners. Each must contain the tokens it forbids in order to look for them, so
 * each must be exempt — and nothing else may be: the assertion below requires every entry to be a
 * test module in this directory, which is what stops a component from being added here to make the
 * scan pass.
 */
const SCANNER_FILES = ['../test/no-prompt-control.test.tsx', '../test/no-order-control.test.tsx'];

/** Whether a path is a test module, exempt because a sibling suite names these tokens as well. */
const isTestFile = (path: string): boolean => /\.test\.(ts|tsx)$/.test(path);

/**
 * The sources every scan must include, listed so a narrower glob — a changed extension set, a moved
 * directory — fails here instead of quietly scanning less than the client contains.
 */
const REQUIRED = [
  '../App.tsx',
  '../main.tsx',
  '../styles.css',
  '../api/analysis-api.ts',
  '../api/errors.ts',
  '../components/disclaimer.tsx',
  '../components/error-notice.tsx',
  '../features/upload/drop-zone.tsx',
  '../features/upload/use-image-queue.ts',
  '../features/upload/upload-surface.tsx',
  '../features/upload/downscale-image.ts',
  '../features/analysis/analysis-surface.tsx',
  '../features/analysis/recommendation-card.tsx',
  '../features/analysis/level-table.tsx',
  '../features/analysis/evidence-list.tsx',
  '../features/history/history-surface.tsx',
];

/** What the scan reads: every source except the scanners and the sibling suites. */
const scanned = Object.keys(SOURCES).filter(
  (path) => !SCANNER_FILES.includes(path) && !isTestFile(path),
);

/**
 * Removes comment text and keeps every other character in place.
 *
 * A comment is prose, and this interface's own sources describe the absence the scan asserts — the
 * analysis surface's header names what it deliberately does not carry — so matching raw text would
 * fail the guard on the sentence that states what it guards. What a control is actually made of is
 * markup, attributes, string literals and JSX text, and all of that is preserved. Quoted and
 * template literals are copied through untouched, so a `//` inside a URL is never read as a comment.
 *
 * @param source - The raw text of one source file.
 * @returns The same text with the contents of every comment replaced by whitespace.
 */
function stripComments(source: string): string {
  let output = '';
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);

    if (char === '/' && next === '/') {
      while (index < source.length && source.charAt(index) !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      while (
        index < source.length &&
        !(source.charAt(index) === '*' && source.charAt(index + 1) === '/')
      ) {
        output += source.charAt(index) === '\n' ? '\n' : ' ';
        index += 1;
      }
      output += '  ';
      index += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      output += char;
      index += 1;

      while (index < source.length) {
        const inner = source.charAt(index);

        if (inner === '\\') {
          output += inner + source.charAt(index + 1);
          index += 2;
          continue;
        }

        output += inner;
        index += 1;

        if (inner === char) {
          break;
        }
      }

      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

describe('no client source introduces a way to trade', () => {
  it('exempts exactly the two scanners, so no component can ever be exempted to make this pass', () => {
    expect(SCANNER_FILES).toEqual([
      '../test/no-prompt-control.test.tsx',
      '../test/no-order-control.test.tsx',
    ]);
    expect(SCANNER_FILES.filter((path) => !isTestFile(path))).toEqual([]);
  });

  it('scans every client source, the stylesheet included', () => {
    expect(scanned).toEqual(expect.arrayContaining(REQUIRED));

    expect(
      Object.keys(SOURCES)
        .filter((path) => !scanned.includes(path))
        .every((path) => SCANNER_FILES.includes(path) || isTestFile(path)),
    ).toBe(true);

    expect(Object.keys(SOURCES)).toContain('../styles.css');
    expect(scanned).toContain('../styles.css');
    expect(SOURCES['../App.tsx']?.length ?? 0).toBeGreaterThan(0);
  });

  it('strips comment prose without touching markup, attributes or string literals', () => {
    const stripped = stripComments(
      `/** no order entry, quantity or broker control */\nconst a = 'buy'; // sell\nconst b = 1;`,
    );

    expect(stripped).not.toContain('quantity');
    expect(stripped).not.toContain('broker');
    expect(stripped).not.toContain('sell');
    expect(stripped).toContain("const a = 'buy';");
    expect(stripped).toContain('const b = 1;');
  });

  it('finds no token of a trading control in any client source', () => {
    const hits = scanned.flatMap((path) => {
      const text = stripComments(SOURCES[path] ?? '');
      return matchedLabels(text).map((label) => `${path} :: ${label}`);
    });

    expect(hits, `order-control scan hits:\n${hits.join('\n')}`).toEqual([]);
  });
});
