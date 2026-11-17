/**
 * The product's single end-to-end proof: two chart screenshots are dropped onto the upload surface in
 * one gesture, submitted with nothing typed, and the trade read that comes back is traced to the
 * levels and images it was built from.
 *
 * Nothing here starts a process and nothing here reaches a model. `scripts/run-e2e.mjs` builds the
 * packages, starts the API with `STUB_PROVIDER=1` and a temporary data directory, starts the Vite dev
 * server and only then runs this file, so the stub replays recorded provider answers and no
 * credential exists in the run. The files arrive through a real `DataTransfer` on a real `DragEvent`
 * (`e2e/helpers/drop-files.ts`), never by handing a file input its files: the picker and the drop are
 * equal paths into the same queue, and the drop is the path this suite proves.
 *
 * The recorded calibration for the two fixtures is side `LONG`, timing `ON_RETEST`, entry 5842.75
 * (the footprint imbalance) and invalidation 5840.00 (the GEX positive-gamma strike): neither image
 * reports its final-bar price at that trigger level, so the retest timing survives. Those numbers are
 * not asserted as literals — the prices are read back from the rendered card and traced into the
 * level table — so a re-recorded envelope cannot silently rot this suite. `NO_TRADE`/`WAIT` is a
 * complete result rather than a failure, so that outcome is accepted and every remaining assertion
 * still runs.
 */

import { expect, test } from 'playwright/test';
import type { Locator, Page, Request } from 'playwright/test';

import { dropFilesOnZone, readFixtureFiles } from './helpers/drop-files.js';

/** The two screenshots that are dropped, in the order the queue receives them. */
const FOOTPRINT_FIXTURE = 'fixtures/screenshots/footprint-es-5m.png';
const GEX_FIXTURE = 'fixtures/screenshots/gex-es-levels.png';
const FIXTURES: readonly string[] = [FOOTPRINT_FIXTURE, GEX_FIXTURE];

/** The file names the interface shows back, which is what a level row and its image are matched on. */
const FOOTPRINT_FILE_NAME = 'footprint-es-5m.png';
const GEX_FILE_NAME = 'gex-es-levels.png';
const FIXTURE_FILE_NAMES: readonly string[] = [FOOTPRINT_FILE_NAME, GEX_FILE_NAME];

/**
 * The disclaimer, spelled out rather than imported: a divergence between this sentence and the
 * constant the server stores is exactly what the assertion exists to catch.
 */
const DISCLAIMER_TEXT =
  'Analysis of the screenshots you provided. It is not investment advice and not a recommendation to trade any instrument.';

/** The public vocabulary of `shared/src/contract.ts`, quoted so a leak of a model code fails here. */
const SIDES: readonly string[] = ['LONG', 'SHORT', 'NO_TRADE'];
const TIMINGS: readonly string[] = ['NOW', 'ON_RETEST', 'ON_BREAK', 'WAIT'];
const LEVEL_TYPES: readonly string[] = [
  'GEX_CALL_WALL',
  'GEX_PUT_WALL',
  'GEX_ZERO_GAMMA',
  'GEX_POSITIVE_GAMMA_STRIKE',
  'GEX_NEGATIVE_GAMMA_STRIKE',
  'FOOTPRINT_VALUE_AREA_HIGH',
  'FOOTPRINT_VALUE_AREA_LOW',
  'FOOTPRINT_POC',
  'FOOTPRINT_IMBALANCE',
  'ABSORPTION',
  'LIQUIDITY_VOID',
  'OTHER',
];

/** What the card prints for each code: the read is a person's answer, not a code dump. */
const SIDE_LABELS: Readonly<Record<string, string>> = {
  LONG: 'Long',
  SHORT: 'Short',
  NO_TRADE: 'No trade',
};
const TIMING_LABELS: Readonly<Record<string, string>> = {
  NOW: 'Now',
  ON_RETEST: 'On retest',
  ON_BREAK: 'On break',
  WAIT: 'Wait',
};

/** The two prices the card must render for a directional read. */
const CARD_PRICE_LABELS = ['Entry', 'Invalidation'] as const;
type CardPriceLabel = (typeof CARD_PRICE_LABELS)[number];

/** `promptVersion` is `extraction@<v>;synthesis@<v>`, read from the server's prompt library. */
const PROMPT_VERSION_PATTERN = /extraction@\S+;synthesis@\S+/;
const MODEL_SLUG = 'google/gemini-2.5-flash';

/** A price exactly as a level stores it: digits with an optional fraction, never formatted. */
const PRICE_PATTERN = /^-?\d+(?:\.\d+)?$/;
const IMAGE_BYTES_PATH_PATTERN = /\/api\/v1\/analyses\/[^/]+\/images\/[^/]+$/;
const ANALYSIS_READ_PATH_PATTERN = /^\/api\/v1\/analyses\/[^/]+$/;

/**
 * The two controls the interface may never offer. The prompt pattern covers the built-in
 * instructions, which no field, header or query parameter may reach; the trading pattern covers
 * order entry, position sizing and broker actions, which the product does not do at all.
 */
const PROMPT_CONTROL_PATTERN = /prompt/i;
const TRADING_CONTROL_PATTERN =
  /buy|sell|place order|submit order|order|position size|quantity|broker|execute/i;

/** Longer than the 30 000 ms analysis budget, so the wait is never the thing that fails first. */
const RECOMMENDATION_TIMEOUT_MS = 35_000;

/** One request the page issued, kept so the suite can prove which calls it made and where to. */
interface CapturedRequest {
  readonly method: string;
  readonly url: string;
}

/** One row of the rendered level table. */
interface LevelRow {
  readonly levelId: string;
  readonly levelType: string;
  readonly imageId: string;
  readonly price: string;
  readonly sourceImage: string;
}

/** One rendered per-image status, with the image it is about and the request its thumbnail loads. */
interface RenderedImageStatus {
  readonly imageId: string;
  readonly status: string;
  readonly text: string;
  readonly imageSource: string;
}

/** A card price, and the image it was traced back to through the level table. */
interface PriceTrace {
  readonly label: CardPriceLabel;
  readonly price: string;
  readonly levelId: string;
  readonly fileName: string;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/** Every request the page issues from the moment this is called, in order. */
function captureRequests(page: Page): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  page.on('request', (request: Request) => {
    captured.push({ method: request.method(), url: request.url() });
  });
  return captured;
}

/** A `data-*` state attribute the assertions depend on, read as a value rather than as a null. */
async function readStateAttribute(
  locator: Locator,
  name: string,
  description: string,
): Promise<string> {
  const value = await locator.getAttribute(name);
  if (value === null || value.trim() === '') {
    throw new Error(`${description} carries no ${name} attribute, so its state cannot be asserted.`);
  }
  return value.trim();
}

/** The label translated into the sentence the card shows, so a code cannot stand in for an answer. */
function labelFor(
  labels: Readonly<Record<string, string>>,
  code: string,
  kind: string,
): string {
  const label = labels[code];
  if (label === undefined) {
    throw new Error(`${code} is not a ${kind} code the interface renders.`);
  }
  return label;
}

/** The name of the one submitted screenshot a piece of rendered text names. */
function fixtureFileNameIn(text: string, description: string): string {
  const named = FIXTURE_FILE_NAMES.filter((fileName) => text.includes(fileName));
  const [onlyNamed] = named;
  if (named.length !== 1 || onlyNamed === undefined) {
    throw new Error(
      `${description} must name exactly one submitted screenshot (${FIXTURE_FILE_NAMES.join(
        ' or ',
      )}), but named ${named.length}.`,
    );
  }
  return onlyNamed;
}

/** The card's grid cell for one price, found by its label rather than by its position. */
function cardCell(card: Locator, label: CardPriceLabel): Locator {
  // The inner locator of `has` is re-anchored on each candidate cell, so it is built from the page:
  // anchoring it on the card would look for a second `.recommendation` inside every cell.
  return card
    .locator('.recommendation__cell')
    .filter({ has: card.page().locator('dt.recommendation__label', { hasText: label }) });
}

/** The price the card renders for one reference, exactly as the level stores it. */
async function readCardPrice(card: Locator, label: CardPriceLabel): Promise<string> {
  const value = cardCell(card, label).locator('dd.recommendation__value');
  await expect(value, `the card must render one ${label} price`).toHaveCount(1);

  const price = (await value.innerText()).trim();
  if (!PRICE_PATTERN.test(price)) {
    throw new Error(
      `The card's ${label} cell shows "${price}", which is not a price a level reported.`,
    );
  }
  return price;
}

/** The level the card's price cell refers to, which is the row the price must be found on. */
async function readCardLevelReference(
  card: Locator,
  label: CardPriceLabel,
): Promise<string> {
  return readStateAttribute(
    cardCell(card, label).locator('dd.recommendation__value'),
    'data-level-id',
    `the card's ${label} cell`,
  );
}

async function readLevelRows(page: Page): Promise<LevelRow[]> {
  return page.locator('.level-table tr[data-level-id]').evaluateAll((rows: Element[]) =>
    rows.map((row) => ({
      levelId: row.getAttribute('data-level-id') ?? '',
      levelType: row.getAttribute('data-level-type') ?? '',
      imageId: row.getAttribute('data-image-id') ?? '',
      price: (row.querySelector('td.level-table__price')?.textContent ?? '').trim(),
      sourceImage: (row.querySelector('td.level-table__image')?.textContent ?? '').trim(),
    })),
  );
}

async function readImageStatuses(page: Page): Promise<RenderedImageStatus[]> {
  return page.locator('.image-status').evaluateAll((statuses: Element[]) =>
    statuses.map((element) => ({
      imageId: element.getAttribute('data-image-id') ?? '',
      status: element.getAttribute('data-status') ?? '',
      text: (element.textContent ?? '').trim(),
      imageSource: element.querySelector('img')?.getAttribute('src') ?? '',
    })),
  );
}

/** The upload surface's submit control: the only button it renders that is not a thumbnail's own. */
function submitControl(page: Page): Locator {
  return page
    .locator('.surface')
    .filter({ has: page.locator('.drop-zone') })
    .locator('button:not(.thumbnail__remove)');
}

/** One optional text field of the upload surface, found by the label beside it. */
function textField(page: Page, label: string): Locator {
  return page
    .locator('.field')
    .filter({ has: page.locator('.field__label', { hasText: label }) })
    .locator('.field__input');
}

/**
 * Traces one price the card shows back to the level it refers to, the row holding that price and the
 * screenshot that row came from. This is the criterion the product lives on: every price in the read
 * is a level an image reported, and the interface still says which image that was.
 */
async function tracePriceToLevel(
  page: Page,
  card: Locator,
  label: CardPriceLabel,
): Promise<PriceTrace> {
  const price = await readCardPrice(card, label);
  const levelId = await readCardLevelReference(card, label);

  const rowByReference = page.locator(`.level-table tr[data-level-id="${levelId}"]`);
  await expect(
    rowByReference,
    `the card's ${label} price must be the price of the level it refers to (${levelId})`,
  ).toHaveCount(1);
  await expect(rowByReference.locator('td.level-table__price')).toHaveText(price);

  const rowsAtPrice = page.locator('.level-table tr[data-level-id]').filter({
    has: page.locator('td.level-table__price', {
      hasText: new RegExp(`^${escapeRegExp(price)}$`),
    }),
  });
  await expect(rowsAtPrice.first(), `the ${label} price ${price} must appear in the level table`)
    .toBeVisible();

  const imageId = (await rowByReference.getAttribute('data-image-id'))?.trim() ?? '';
  expect(imageId, `the ${label} row must name the image it was read from`).not.toBe('');

  const statuses = await readImageStatuses(page);
  const status = statuses.find((entry) => entry.imageId === imageId);
  if (status === undefined) {
    throw new Error(
      `The ${label} level row was read from image ${imageId}, but no per-image status is about it.`,
    );
  }

  const fileName = fixtureFileNameIn(status.text, `the ${label} level's per-image status`);
  const rowSource = (await rowByReference.locator('td.level-table__image').innerText()).trim();
  expect(rowSource, `the ${label} row must name the screenshot it was read from`).toBe(fileName);

  return { label, price, levelId, fileName };
}

/** No control on the page may offer the built-in instructions as something a person can type. */
async function expectNoPromptControl(page: Page): Promise<void> {
  const descriptors = await page
    .locator('input, textarea, select, label')
    .evaluateAll((elements: Element[]) =>
      elements.flatMap((element) => [
        element.getAttribute('aria-label') ?? '',
        element.getAttribute('placeholder') ?? '',
        element.getAttribute('name') ?? '',
        element.getAttribute('id') ?? '',
        element.textContent ?? '',
      ]),
    );

  expect(
    descriptors.filter((descriptor) => PROMPT_CONTROL_PATTERN.test(descriptor)),
    'the built-in prompts are applied by the server, so the interface must offer no way to type one',
  ).toEqual([]);
}

/**
 * No control on the page may offer an order, a position size or a broker action, and no link or form
 * may point off this origin: the product tells a person what it reads, and calls nothing else.
 */
async function expectNoTradingControl(page: Page): Promise<void> {
  const descriptors = await page
    .locator('button, a, input, select, textarea, form')
    .evaluateAll((elements: Element[]) =>
      elements.flatMap((element) => {
        const tagName = element.tagName.toLowerCase();
        const attributes = [
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('placeholder') ?? '',
          element.getAttribute('name') ?? '',
          element.getAttribute('id') ?? '',
          element.getAttribute('action') ?? '',
        ];
        // Only a control's own visible wording is read: a container's whole text would drag the
        // summary sentence and the disclaimer into a scan about what a control offers.
        const isVerballyLabelled = tagName === 'button' || tagName === 'a';
        return isVerballyLabelled ? [...attributes, element.textContent ?? ''] : attributes;
      }),
    );

  expect(
    descriptors.filter((descriptor) => TRADING_CONTROL_PATTERN.test(descriptor)),
    'the interface must offer no order, position size or broker action',
  ).toEqual([]);

  const pageOrigin = new URL(page.url()).origin;
  const targets = await page
    .locator('a[href], form[action]')
    .evaluateAll((elements: Element[]) =>
      elements.map((element) => element.getAttribute('href') ?? element.getAttribute('action') ?? ''),
    );
  for (const target of targets) {
    expect(new URL(target, pageOrigin).origin, `"${target}" must stay on ${pageOrigin}`).toBe(
      pageOrigin,
    );
  }
}

test.describe('drag-and-drop trade read', () => {
  test('reads a trade from two screenshots dropped in one gesture, with nothing typed', async ({
    page,
  }) => {
    // 1. The page opens on the upload surface, whose zone is a focusable button.
    await page.goto('/');
    await expect(page.locator('[data-surface="upload"]').first()).toBeVisible();

    const dropZone = page.locator('.drop-zone');
    await expect(dropZone).toBeVisible();
    await expect(dropZone).toHaveAttribute('role', 'button');
    await expect(dropZone).toHaveAttribute('tabindex', '0');
    await expect(dropZone).toHaveAccessibleName(/screenshot/i);

    // 2. The fixture bytes, read by the helper that owns fixture paths and never logged.
    const files = await readFixtureFiles([...FIXTURES]);
    expect(files.map((file) => file.name)).toEqual([FOOTPRINT_FILE_NAME, GEX_FILE_NAME]);

    // 3. Capture starts before the submission, so every call this path makes is accounted for.
    const requests = captureRequests(page);

    // 4. One gesture: both files in a single DataTransfer on a single drop.
    await dropFilesOnZone(page, files);

    // 5. The queue holds both files, which is the multi-file drop proof.
    await expect(page.locator('.thumbnail')).toHaveCount(files.length);
    const queue = page.locator('.thumbnail-list');
    await expect(queue).toContainText(FOOTPRINT_FILE_NAME);
    await expect(queue).toContainText(GEX_FILE_NAME);

    // 6. Nothing is typed, and nothing offers to type the server's instructions.
    const instrument = textField(page, 'Instrument');
    const context = textField(page, 'Context');
    await expect(instrument).toHaveCount(1);
    await expect(context).toHaveCount(1);
    await expect(instrument).toHaveValue('');
    await expect(context).toHaveValue('');
    await expectNoPromptControl(page);

    // 7. One submit control, enabled by the queued files, activated once by a pointer.
    const submit = submitControl(page);
    await expect(submit).toHaveCount(1);
    await expect(submit).toBeEnabled();
    await submit.click();

    // 8. The read arrives inside the analysis budget, so this wait is never the first failure.
    const card = page.locator('.recommendation');
    await expect(card).toBeVisible({ timeout: RECOMMENDATION_TIMEOUT_MS });

    // 9. A read is a result: nothing replaced it with a failure surface.
    await expect(page.locator('.error-notice')).toHaveCount(0);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);

    // 10. The public vocabulary, and the words a person reads instead of it.
    const side = await readStateAttribute(card, 'data-side', 'the recommendation');
    const timing = await readStateAttribute(card, 'data-timing', 'the recommendation');
    expect(SIDES, `data-side="${side}" is not a public side`).toContain(side);
    expect(TIMINGS, `data-timing="${timing}" is not a public timing`).toContain(timing);
    await expect(card.locator('.recommendation__side')).toHaveText(
      labelFor(SIDE_LABELS, side, 'side'),
    );
    await expect(card.locator('.recommendation__timing')).toHaveText(
      labelFor(TIMING_LABELS, timing, 'timing'),
    );

    // 11 and 12. A directional read names the level each of its prices is, and a read with no
    // direction carries no level reference at all — so only the directional branch has prices to
    // trace, and the remaining assertions below run for both.
    const traces: PriceTrace[] = [];
    const isDirectional = side !== 'NO_TRADE' && timing !== 'WAIT';

    if (isDirectional) {
      for (const label of CARD_PRICE_LABELS) {
        traces.push(await tracePriceToLevel(page, card, label));
      }
      expect(
        new Set(traces.map((trace) => trace.fileName)).size,
        'a directional read needs its entry and invalidation from two different screenshots',
      ).toBe(2);
    } else {
      if (side === 'NO_TRADE') {
        expect(timing, 'a no-trade read is a wait: it names nothing to act on').toBe('WAIT');
        await expect(card).toHaveClass(/recommendation--no-trade/);
      }
      await expect(page.locator('.error-notice')).toHaveCount(0);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
    }

    // 13. Every level is a row, typed from the public taxonomy and attributed to a screenshot.
    const rows = await readLevelRows(page);
    expect(rows.length, 'the analysis must report the levels it read').toBeGreaterThan(0);

    const levelIds = rows.map((row) => row.levelId);
    expect(levelIds.filter((levelId) => levelId === '')).toEqual([]);
    expect(new Set(levelIds).size, 'each level must own exactly one row').toBe(rows.length);

    for (const row of rows) {
      expect(LEVEL_TYPES, `level ${row.levelId} carries "${row.levelType}"`).toContain(row.levelType);
      expect(row.price, `level ${row.levelId} must show the price it reported`).toMatch(
        PRICE_PATTERN,
      );
      expect(row.imageId, `level ${row.levelId} must name the image it was read from`).not.toBe('');
      expect(FIXTURE_FILE_NAMES, `level ${row.levelId} names an unknown screenshot`).toContain(
        row.sourceImage,
      );
    }

    const renderedImages = [...new Set(rows.map((row) => row.sourceImage))].sort();
    expect(renderedImages, 'the level table must show both the footprint and the GEX chart').toEqual(
      [...FIXTURE_FILE_NAMES].sort(),
    );

    for (const trace of traces) {
      expect(levelIds, `the ${trace.label} price must belong to a rendered level`).toContain(
        trace.levelId,
      );
    }

    // 14. The evidence is server-written, cites levels that exist, and names the images it rests on.
    const evidenceItems = page.locator('.evidence-list__item');
    expect(
      await evidenceItems.count(),
      'the read must show the evidence it rests on',
    ).toBeGreaterThan(0);

    const evidenceImageIds = await evidenceItems.evaluateAll((items: Element[]) =>
      items.map((item) => item.getAttribute('data-image-id') ?? ''),
    );
    expect(evidenceImageIds.filter((imageId) => imageId === '')).toEqual([]);

    const citedLevelIds = await evidenceItems.evaluateAll((items: Element[]) =>
      items.flatMap((item) =>
        (item.getAttribute('data-level-ids') ?? '')
          .split(/\s+/)
          .filter((levelId) => levelId !== ''),
      ),
    );
    expect(
      citedLevelIds.filter((levelId) => !levelIds.includes(levelId)),
      'every level the evidence cites must exist in the level table',
    ).toEqual([]);

    const evidenceList = page.locator('.evidence-list__items');
    const evidenceText = await evidenceList.innerText();
    expect(
      FIXTURE_FILE_NAMES.some((fileName) => evidenceText.includes(fileName)),
      'the evidence must name the screenshot it was read from',
    ).toBe(true);

    if (isDirectional) {
      for (const fileName of FIXTURE_FILE_NAMES) {
        expect(evidenceText, `the evidence must name ${fileName}`).toContain(fileName);
      }
      expect(
        new Set(evidenceImageIds).size,
        'a directional read rests on both submitted images',
      ).toBe(2);
    }

    // 15. The record names the instructions and the model that produced it, from the server.
    const meta = page.locator('.meta');
    await expect(meta).toHaveCount(1);
    const metaText = (await meta.innerText()).trim();
    expect(metaText, 'the prompt version that produced the read must be shown').toMatch(
      PROMPT_VERSION_PATTERN,
    );
    expect(metaText, 'the configured model slug must be shown').toContain(MODEL_SLUG);

    // 16. The fixed disclaimer, character for character, on the surface that shows a recommendation.
    const disclaimer = page.locator('.disclaimer');
    await expect(disclaimer).toHaveCount(1);
    await expect(disclaimer).toHaveText(DISCLAIMER_TEXT);

    // 17. Both images were read, and each is re-displayed from the stored bytes beside its status.
    const statuses = await readImageStatuses(page);
    expect(statuses.length, 'every submitted image must report its status').toBe(files.length);
    for (const status of statuses) {
      expect(status.status, `image ${status.imageId} must have been read`).toBe('ANALYZED');
      expect(status.imageId, 'each status must name the image it is about').not.toBe('');
      expect(status.imageSource, 'each status must re-display the stored screenshot').toMatch(
        IMAGE_BYTES_PATH_PATTERN,
      );
      fixtureFileNameIn(status.text, 'each per-image status');
    }
    expect(
      new Set(statuses.map((status) => status.imageSource)).size,
      'the two statuses must load two different stored screenshots',
    ).toBe(files.length);

    // 18. What the surface must not offer, and where the page may not talk to.
    await expectNoTradingControl(page);
    await expectNoPromptControl(page);

    const pageOrigin = new URL(page.url()).origin;
    const offOrigin = requests
      .filter((request) => {
        const parsed = parseUrl(request.url);
        return (
          parsed !== null &&
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.origin !== pageOrigin
        );
      })
      .map((request) => `${request.method} ${request.url}`);
    expect(
      offOrigin,
      `every call the interface makes must stay on ${pageOrigin}, which proxies /api to the API`,
    ).toEqual([]);

    const analysisPosts = requests.filter(
      (request) =>
        request.method === 'POST' &&
        (parseUrl(request.url)?.pathname.endsWith('/api/v1/analyses') ?? false),
    );
    expect(
      analysisPosts.map((request) => request.url),
      'one submission is one POST: no automatic retry and no queued background job',
    ).toHaveLength(1);

    const analysisReads = requests.filter(
      (request) =>
        request.method === 'GET' &&
        ANALYSIS_READ_PATH_PATTERN.test(parseUrl(request.url)?.pathname ?? ''),
    );
    expect(
      analysisReads.map((request) => request.url),
      'the create response is handed straight to the surface, so the stored document is not re-read',
    ).toEqual([]);

    // The observed read, reported beside the run rather than inferred from a green tick.
    test.info().annotations.push({
      type: 'trade read',
      description: [
        `side ${side}, timing ${timing}`,
        traces.length === 0
          ? 'no directional prices to trace'
          : traces
              .map((trace) => `${trace.label} ${trace.price} of ${trace.fileName}`)
              .join('; '),
      ].join(': '),
    });
  });
});

