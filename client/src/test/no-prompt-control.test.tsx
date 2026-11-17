/**
 * Suite: the client can neither supply, alter nor suppress the built-in analysis instruction text.
 *
 * Evidence for two AAP clauses. §0.6.5 row 1 lists "any prompt field, prompt editor or prompt
 * choice in the client" as a required absence and names the surfaces that would host one; this file
 * is the evidence it asks for. §0.6.6 criterion 2's client half is the same claim from the other
 * side: with nothing to type, the builder's own instruction text is the only one a submission can
 * carry.
 *
 * The absence is proven twice, because either half alone is weak. The rendered half drives all
 * three surfaces and judges every attribute, label and accessible name, so a control that appears on
 * screen fails here. The static half reads every production source under `client/src` and looks for
 * the shapes such a control takes in code — a field name, a multipart append, a query parameter, an
 * object key — and for the built-in instruction artefacts that must never reach a browser. D13 gives
 * the positive form of the same claim: a submitted body carries exactly `images`, and `instrument`
 * and `context` when they were typed, so that body is captured from a real submission through the
 * real transport rather than from a replaced one.
 *
 * Every pattern is built from tokens assembled by concatenation (`'pro' + 'mpt'`), so this file's
 * own source holds none of the literals it searches for.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_PATH, DISCLAIMER } from '@trade-read/shared';
import type {
  AnalysisDocument,
  AnalysisImage,
  Level,
  ModelUsage,
  Rationale,
  Recommendation,
} from '@trade-read/shared';

import AnalysisSurface from '../features/analysis/analysis-surface';
import HistorySurface from '../features/history/history-surface';
import UploadSurface from '../features/upload/upload-surface';

/** What a user-event instance is, named once so the helpers below can take one. */
type User = ReturnType<typeof userEvent.setup>;

/**
 * The two calls this suite replaces, held in a hoisted cell because a `vi.mock` factory is lifted
 * above every import and so cannot close over a module-scope binding.
 *
 * `createAnalysis`, `getAnalysis`, `analysisImageUrl` and the `ApiError` class stay the module's own:
 * the captured-body cases must run through the real transport, or they would prove something about
 * a double instead of about the client.
 */
const api = vi.hoisted(() => ({
  listAnalyses: vi.fn(),
  deleteAnalysis: vi.fn(),
}));

/**
 * jsdom decodes no images: it provides neither `createImageBitmap` nor a 2D canvas context. Only the
 * decoder is replaced, so the queue's own bookkeeping — which is what decides the submitted field
 * list this suite measures — still runs for real; `computeTargetSize` and `isBlankFrame` remain the
 * module's own functions.
 */
vi.mock('../features/upload/downscale-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/upload/downscale-image')>();

  return {
    ...actual,
    downscaleImage: async () => ({
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
      width: 800,
      height: 600,
      blankFrame: false,
    }),
  };
});

/**
 * Only the two calls no surface under test may perform are replaced: a history read, which would
 * otherwise reach a network, and the delete that the history surface would need stubbed anyway.
 */
vi.mock('../api/analysis-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/analysis-api')>();

  return {
    ...actual,
    listAnalyses: api.listAnalyses,
    deleteAnalysis: api.deleteAnalysis,
  };
});

/**
 * The one transport the surfaces can reach, as a plain object rather than a `Response` instance.
 *
 * `api/analysis-api.ts` reads the body as text and parses it itself, so `text` is the member that
 * matters here; `headers` and `json` are present too, so the double describes the whole answer the
 * transport is written to accept.
 */
function okResponse(body: AnalysisDocument): Response {
  const bodyText = JSON.stringify(body);

  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => bodyText,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn<typeof fetch>();

/** The two screenshots the fixture read rests on, named once so the rationale can cite them. */
const FIRST_IMAGE_ID = 'im-0001';
const SECOND_IMAGE_ID = 'im-0002';

/** What the analysis made of each submitted screenshot. */
const IMAGES: AnalysisImage[] = [
  {
    imageId: FIRST_IMAGE_ID,
    fileName: 'footprint-es-5m.png',
    contentType: 'image/png',
    byteSize: 1536,
    width: 1600,
    height: 900,
    status: 'ANALYZED',
  },
  {
    imageId: SECOND_IMAGE_ID,
    fileName: 'gex-es-levels.png',
    contentType: 'image/png',
    byteSize: 2048,
    width: 1600,
    height: 900,
    status: 'ANALYZED',
  },
];

/** The prices the read uses, each exactly as an analysis reported it and tied to its image. */
const LEVELS: Level[] = [
  {
    levelId: 'lv-0001',
    price: 5390,
    type: 'FOOTPRINT_VALUE_AREA_LOW',
    imageId: FIRST_IMAGE_ID,
  },
  { levelId: 'lv-0002', price: 5400.25, type: 'FOOTPRINT_POC', imageId: FIRST_IMAGE_ID },
  { levelId: 'lv-0003', price: 5412.5, type: 'GEX_CALL_WALL', imageId: SECOND_IMAGE_ID },
];

/**
 * A read expressed the only way the shared contract allows: by level reference. No price field
 * exists on it, because a price exists only on a level (AAP §0.3.2, rule 1).
 */
const RECOMMENDATION: Recommendation = {
  side: 'LONG',
  timing: 'ON_RETEST',
  triggerLevelId: 'lv-0002',
  entryLevelId: 'lv-0002',
  invalidationLevelId: 'lv-0001',
  targetLevelIds: ['lv-0003'],
  confidence: 'MEDIUM',
  summary: 'A retest of the point of control supports a long read into the call wall.',
};

/** The evidence behind the read, citing both submitted images. */
const RATIONALE: Rationale[] = [
  {
    claim: 'Entry rests on the point of control reported by the footprint screenshot.',
    imageId: FIRST_IMAGE_ID,
    levelIds: ['lv-0002'],
  },
  {
    claim: 'The target is the call wall reported by the gamma screenshot.',
    imageId: SECOND_IMAGE_ID,
    levelIds: ['lv-0003'],
  },
];

/** What the analysis cost and which instruction versions produced it. */
const MODEL_USAGE: ModelUsage = {
  provider: 'openrouter',
  model: 'configured-vision-model',
  promptVersion: 'extraction@1;synthesis@1',
  imageCallCount: 2,
  synthesisCompletionTokens: 37,
  latencyMs: 2100,
};

/** One complete stored analysis, of the shape every surface under test renders. */
const FIXTURE: AnalysisDocument = {
  analysisId: 'an-0001',
  createdAt: '2026-01-01T00:00:00.000Z',
  instrument: 'ES',
  context: '',
  images: IMAGES,
  levels: LEVELS,
  recommendation: RECOMMENDATION,
  rationale: RATIONALE,
  assumptions: [],
  modelUsage: MODEL_USAGE,
  disclaimer: DISCLAIMER,
};

beforeEach(() => {
  api.listAnalyses.mockReset();
  api.listAnalyses.mockResolvedValue({ items: [FIXTURE] });
  api.deleteAnalysis.mockReset();
  api.deleteAnalysis.mockResolvedValue(undefined);

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse(FIXTURE));
  // The suites that render a surface must never reach a network: this is the only `fetch` they see.
  vi.stubGlobal('fetch', fetchMock);
});

/**
 * The token every pattern below is built from, assembled rather than written: this file's own source
 * therefore carries no prompt literal, which is what lets its sibling scanner read it safely.
 */
const PROMPT_TOKEN = 'pro' + 'mpt';

/** The same token as a matcher over rendered attribute values, labels and accessible names. */
const PROMPT_VALUE = new RegExp(PROMPT_TOKEN, 'i');

/** One pattern over source text, with the sentence a hit prints. */
interface SourcePattern {
  readonly label: string;
  readonly source: string;
  readonly flags: string;
}

/**
 * The shapes a prompt control takes in source. Each is structural — a field name, a multipart
 * append, a query parameter, an object key, a label, an accessible name — so a bare occurrence of
 * the word is deliberately not matched: prose in a comment, and the `promptVersion` provenance the
 * analysis surface is required to display (AAP §0.6.1), are not controls, and matching them would
 * force the component that legitimately renders the version to be excluded from the scan.
 */
const PROMPT_SOURCE_PATTERNS: readonly SourcePattern[] = [
  {
    label: 'a prompt form field',
    // The optional `{` admits the JSX expression form as well as the attribute literal, so
    // `name="prompt"`, `name={'prompt'}`, `name={"prompt"}` and `name={`prompt`}` all match.
    source: `name\\s*=\\s*\\{?\\s*["'\`]${PROMPT_TOKEN}`,
    flags: 'i',
  },
  {
    label: 'a prompt appended to the submitted body',
    source: `\\.append\\(\\s*["'\`]${PROMPT_TOKEN}`,
    flags: 'i',
  },
  { label: 'a prompt query parameter', source: `[?&]${PROMPT_TOKEN}=`, flags: 'i' },
  {
    label: 'a prompt object key or request header',
    source: `["'\`]${PROMPT_TOKEN}["'\`]\\s*:`,
    flags: 'i',
  },
  { label: 'a prompt label', source: `<label[^>]*>[^<]*${PROMPT_TOKEN}`, flags: 'i' },
  {
    label: 'a prompt accessible name',
    source: `aria-label\\s*=\\s*\\{?\\s*["'\`][^"'\`]*${PROMPT_TOKEN}`,
    flags: 'i',
  },
];

/**
 * The built-in instruction artefacts, which belong to the server's prompt modules alone: a client
 * carrying either constant's name, the current-price evidence token or the output rule's own words
 * would be holding — or building — the text the server owns.
 */
const PROMPT_ARTEFACT_PATTERNS: readonly SourcePattern[] = [
  { label: 'the extraction prompt constant', source: 'EXTRACTION_' + 'PROMPT', flags: '' },
  { label: 'the synthesis prompt constant', source: 'SYNTHESIS_' + 'PROMPT', flags: '' },
  { label: 'the current-price evidence token', source: 'LAST=', flags: '' },
  { label: 'the one-line output rule', source: 'compact ' + 'JSON', flags: 'i' },
  { label: 'the code-fence rule', source: 'markdown ' + 'fence', flags: 'i' },
];

/** The optional text fields a submission may carry, which are the only text fields the client has. */
const TEXT_FIELD_NAMES: readonly string[] = ['instrument', 'context'];

/** A short description of an element, for a failure message that names the offender. */
function describeElement(element: Element): string {
  const parts: string[] = [element.tagName.toLowerCase()];

  for (const attribute of ['id', 'name', 'aria-label']) {
    const value = element.getAttribute(attribute);

    if (value !== null) {
      parts.push(`${attribute}=${JSON.stringify(value)}`);
    }
  }

  return `<${parts.join(' ')}>`;
}

/**
 * Every attribute of every element in the rendered subtree, as text, so one pass covers `name`,
 * `id`, `placeholder`, `aria-*`, `data-*` and class names alike: whichever of them a control used to
 * announce itself, it is read here.
 */
function attributeTexts(container: HTMLElement): string[] {
  const texts: string[] = [];

  for (const element of Array.from(container.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      texts.push(
        `${describeElement(element)} ${attribute.name}=${JSON.stringify(attribute.value)}`,
      );
    }
  }

  return texts;
}

/**
 * The one rule all three surfaces are judged by: no prompt control exists, by any route a person
 * could reach it.
 *
 * Four checks, because a control can be found by four different things: an attribute that names it,
 * the accessible name a screen reader announces, the visible text of a label, and the field list a
 * text entry control is admitted to. The last one keeps the check honest on the upload surface,
 * which legitimately carries one text input and one textarea: they are the optional instrument and
 * context fields by name (D12, D13), and a third text entry control under any other name fails here.
 */
function expectNoPromptControl(container: HTMLElement): void {
  const attributeHits = attributeTexts(container).filter((text) => PROMPT_VALUE.test(text));
  expect(attributeHits, `attributes naming a prompt control:\n${attributeHits.join('\n')}`).toEqual(
    [],
  );

  const labelledHits = Array.from(container.querySelectorAll('label'))
    .filter((label) => PROMPT_VALUE.test(label.textContent ?? ''))
    .map(describeElement);
  expect(labelledHits, `labels naming a prompt control:\n${labelledHits.join('\n')}`).toEqual([]);

  const namedHits = [
    ...within(container).queryAllByRole('textbox', { name: PROMPT_VALUE }),
    ...within(container).queryAllByRole('button', { name: PROMPT_VALUE }),
    ...within(container).queryAllByRole('link', { name: PROMPT_VALUE }),
  ].map(describeElement);
  expect(namedHits, `controls named for a prompt:\n${namedHits.join('\n')}`).toEqual([]);

  const foreignTextEntries = [
    ...Array.from(container.querySelectorAll('textarea')),
    ...Array.from(container.querySelectorAll('input')).filter((input) => {
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();

      return type === 'text' || type === 'search';
    }),
  ]
    .filter((control) => !TEXT_FIELD_NAMES.includes(control.getAttribute('name') ?? ''))
    .map(describeElement);
  expect(
    foreignTextEntries,
    `text entry controls outside the submitted field list:\n${foreignTextEntries.join('\n')}`,
  ).toEqual([]);
}

describe('rendered surfaces', () => {
  it('renders no prompt control on the upload surface', () => {
    const { container } = render(<UploadSurface onCreated={vi.fn()} />);

    expectNoPromptControl(container);

    // Not vacuous: the surface really does render the two optional text fields, so the role-by-role
    // checks above had something to judge rather than an empty list.
    expect(within(container).queryAllByRole('textbox')).toHaveLength(2);
    expect(screen.getByLabelText(/instrument/i)).toHaveAttribute('name', 'instrument');
    expect(screen.getByLabelText(/context/i)).toHaveAttribute('name', 'context');
  });

  it('renders no prompt control on the analysis surface, while showing the prompt version', () => {
    const { container } = render(
      <AnalysisSurface
        analysisId={FIXTURE.analysisId}
        initialDocument={FIXTURE}
        onBackToHistory={vi.fn()}
        onNewAnalysis={vi.fn()}
      />,
    );

    expectNoPromptControl(container);
    expect(within(container).queryAllByRole('textbox')).toHaveLength(0);

    /* The positive half of §0.6.6 criterion 2: the version that produced the read is displayed as
       provenance. It is displayed, not editable, and the patterns above target a prompt parameter or
       control and never the identifier `promptVersion`. */
    const meta = container.querySelector('.meta');
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toContain(FIXTURE.modelUsage.promptVersion);
  });

  it('renders no prompt control on the populated history surface', async () => {
    const { container } = render(
      <HistorySurface onOpenAnalysis={vi.fn()} onNewAnalysis={vi.fn()} />,
    );

    await waitFor(() => {
      expect(api.listAnalyses).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelectorAll('.history-item')).toHaveLength(1);
    });

    expectNoPromptControl(container);
  });
});


/** The clipped file input the drop zone owns: the zone is the control, and this is what it opens. */
function filePicker(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('.drop-zone__input');

  if (input === null) {
    throw new Error('The upload surface rendered no file picker to queue a screenshot through.');
  }

  return input;
}

/** One PNG carrying the eight-byte signature every screenshot starts with. */
function screenshotFile(name = 'footprint-es-5m.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
    type: 'image/png',
  });
}

/**
 * The surface's only submission control, found by role and accessible name rather than by a class.
 * The pattern admits either spelling of the verb, so a wording change cannot make this suite skip the
 * submission it measures.
 */
function submitControl(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: /submit|analyse|analyze/i });
}

/**
 * Queues one screenshot the way the operator does, through the picker the drop zone opens.
 *
 * The queue prepares a file across a microtask, so this returns only once the thumbnail is on screen
 * and the submit control has left the processing state it holds while a batch is prepared.
 */
async function queueScreenshot(user: User, container: HTMLElement): Promise<void> {
  await user.upload(filePicker(container), screenshotFile());

  await waitFor(() => {
    expect(container.querySelectorAll('.thumbnail')).toHaveLength(1);
  });
  await waitFor(() => {
    expect(submitControl()).toBeEnabled();
  });
}

/** The arguments of one captured call, absent when no such call was made. */
function capturedInit(index = 0): RequestInit | undefined {
  return fetchMock.mock.calls[index]?.[1];
}

/** The captured request's target as text, whatever form the transport used to name it. */
function capturedUrl(index = 0): string {
  const target = fetchMock.mock.calls[index]?.[0];

  return typeof target === 'string' ? target : String(target);
}

/** The submitted body, proven to be form data before any field is read from it. */
function submittedBody(index = 0): FormData {
  const body = capturedInit(index)?.body;

  if (!(body instanceof FormData)) {
    throw new Error(`Submission ${index} carried no form data body.`);
  }

  return body;
}

/** The names of the headers a request carried, whichever form the transport supplied them in. */
function headerNames(init: RequestInit | undefined): string[] {
  const { headers } = init ?? {};

  if (headers === undefined) {
    return [];
  }

  if (headers instanceof Headers) {
    return Array.from(headers.keys());
  }

  if (Array.isArray(headers)) {
    return headers.map((pair) => pair[0] ?? '');
  }

  return Object.keys(headers);
}

/** Submits the queue and waits for the one request that submission must produce. */
async function submitOnce(user: User): Promise<void> {
  expect(fetchMock).not.toHaveBeenCalled();

  await user.click(submitControl());

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

describe('submitted multipart body', () => {
  it('carries the images and nothing else when no text was typed', async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadSurface onCreated={vi.fn()} />);

    await queueScreenshot(user, container);
    await submitOnce(user);

    const body = submittedBody();

    // Exact equality, not a subset: D13 admits `images` and the two optional text fields and drops
    // every other multipart field, so a fourth key — a prompt above all — fails here.
    expect(Array.from(body.keys())).toEqual(['images']);
    expect(body.getAll('images')).toHaveLength(1);
    expect(capturedUrl().startsWith(API_BASE_PATH)).toBe(true);
  });

  it('carries the two optional text fields when they were typed', async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadSurface onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText(/instrument/i), 'ES');
    await user.type(screen.getByLabelText(/context/i), 'watching 5100');
    await queueScreenshot(user, container);
    await submitOnce(user);

    expect(Array.from(submittedBody().keys()).sort()).toEqual(['context', 'images', 'instrument']);
  });

  it('carries no prompt field, no prompt query parameter and no prompt header', async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadSurface onCreated={vi.fn()} />);

    await queueScreenshot(user, container);
    await submitOnce(user);

    expect(Array.from(submittedBody().keys())).not.toContain(PROMPT_TOKEN);

    const url = capturedUrl();
    expect(new RegExp(`[?&]${PROMPT_TOKEN}=`, 'i').test(url)).toBe(false);

    expect(headerNames(capturedInit()).map((name) => name.toLowerCase())).not.toContain(
      PROMPT_TOKEN,
    );

    // One request per press of the control: the client never re-sends a submission on its own.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


/**
 * Every source under `client/src`, read as raw text through Vite's import analysis rather than
 * through the filesystem: this package carries no Node typings, so no filesystem reader is available
 * to a suite and Vite's own glob is the only one it can use.
 */
const SOURCES = import.meta.glob('../**/*.{ts,tsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * The two scanner files, and nothing else, may be left out of the scan.
 *
 * Each proves an absence by holding the very tokens it searches for, so reading them here would fail
 * on the guard itself. A component path may never be added: the assertions below are what stop the
 * exclusion list from growing to hide a real defect.
 */
const SCANNER_FILES: readonly string[] = [
  '../test/no-prompt-control.test.tsx',
  '../test/no-order-control.test.tsx',
];

/** Whether a path is a suite, which legitimately carries these tokens inside its own assertions. */
const isTestFile = (path: string): boolean => /\.test\.(ts|tsx)$/.test(path);

/** Every production source the application ships, so the scan cannot silently narrow. */
const REQUIRED_SOURCES: readonly string[] = [
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

/** The paths the scan reads: every source a browser could load. */
const SCANNED_PATHS = Object.keys(SOURCES)
  .filter((path) => !SCANNER_FILES.includes(path) && !isTestFile(path))
  .sort();

describe('client sources', () => {
  it('scans every production source and excludes only the scanners and their sibling suites', () => {
    // The exclusion list holds exactly these two paths; a component added to it is a defect.
    expect(SCANNER_FILES).toEqual([
      '../test/no-prompt-control.test.tsx',
      '../test/no-order-control.test.tsx',
    ]);

    expect(SCANNED_PATHS).toEqual(expect.arrayContaining([...REQUIRED_SOURCES]));

    const excluded = Object.keys(SOURCES).filter((path) => !SCANNED_PATHS.includes(path));
    const unexplained = excluded.filter(
      (path) => !SCANNER_FILES.includes(path) && !isTestFile(path),
    );
    expect(
      unexplained,
      `sources left out of the scan without cause:\n${unexplained.join('\n')}`,
    ).toEqual([]);

    /* The glob's stylesheet half reaches the one stylesheet the client ships, so a `.prompt*` class
       added to it joins the scan instead of vanishing from it. Its text arrives empty because the
       suite runs with CSS processing off (`css: false` in client/vitest.config.ts) and Vitest
       replaces a stylesheet module's exported value; a class name cannot create a field, a parameter
       or a control, so the empty value costs the patterns above no evidence they cover. */
    expect(Object.keys(SOURCES)).toContain('../styles.css');
  });

  it('holds no prompt parameter and none of the built-in instruction text', () => {
    const patterns: readonly SourcePattern[] = [
      ...PROMPT_SOURCE_PATTERNS,
      ...PROMPT_ARTEFACT_PATTERNS,
    ];
    const hits: string[] = [];

    for (const path of SCANNED_PATHS) {
      const source = SOURCES[path] ?? '';

      for (const pattern of patterns) {
        if (new RegExp(pattern.source, pattern.flags).test(source)) {
          hits.push(`${path} :: ${pattern.label}`);
        }
      }
    }

    // A hit is a defect in that production file, reported here rather than silenced by excluding the
    // file: the exclusion list is asserted above to hold the two scanners and nothing else.
    expect(hits, `prompt-control scan hits:\n${hits.join('\n')}`).toEqual([]);
  });
});

