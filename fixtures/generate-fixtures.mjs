/**
 * Renders every page under `fixtures/render/` in headless Chromium and writes the committed PNG
 * fixtures into `fixtures/screenshots/`.
 *
 * Run by hand after the Chromium binary is installed:
 *
 *   npm install
 *   npm run setup
 *   node fixtures/generate-fixtures.mjs
 *
 * Every path is resolved from this file's own location, so the script behaves the same whichever
 * directory it is invoked from. The capture table below is the single source of truth for what is
 * rendered and at what size; a render page with no table row, or a table row with no render page,
 * is a hard failure rather than a silently stale fixture.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const RENDER_DIR = join(here, 'render');
const OUT_DIR = join(here, 'screenshots');

/**
 * Longest acceptable edge for a submitted screenshot, mirroring `MAX_LONG_EDGE_PX` in
 * `shared/src/limits.ts`: an image is stored only if its long edge is at or below this many
 * pixels. This script is plain JavaScript and deliberately does not import the TypeScript module,
 * so the two values must be kept in step by hand.
 */
const MAX_LONG_EDGE = 2048;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The authoritative stem -> viewport -> output table.
 *
 * `oversize` marks the one fixture whose purpose is to be rejected by the server's dimension
 * bound (`IMAGE_TOO_LARGE_DIMENSIONS`); every other row must stay within `MAX_LONG_EDGE`.
 * `oversize-long-edge.png` is the footprint page captured a second time at a larger viewport,
 * not a sixth render page and not a copy or upscale of an existing PNG.
 */
const CAPTURES = Object.freeze([
  Object.freeze({ page: 'footprint-es-5m.html', output: 'footprint-es-5m.png', width: 1440, height: 900, oversize: false }),
  Object.freeze({ page: 'gex-es-levels.html', output: 'gex-es-levels.png', width: 1440, height: 900, oversize: false }),
  Object.freeze({ page: 'dom-ladder-es.html', output: 'dom-ladder-es.png', width: 1600, height: 1000, oversize: false }),
  Object.freeze({ page: 'volume-profile-es.html', output: 'volume-profile-es.png', width: 1280, height: 960, oversize: false }),
  Object.freeze({ page: 'blank-uniform.html', output: 'blank-uniform.png', width: 800, height: 600, oversize: false }),
  Object.freeze({ page: 'footprint-es-5m.html', output: 'oversize-long-edge.png', width: 3000, height: 3000, oversize: true }),
]);

/** A failure the operator can act on: its message is printed without a stack trace. */
class FixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureError';
  }
}

/** Path relative to the repository root, so reported paths do not depend on the working directory. */
function displayPath(absolutePath) {
  return relative(REPO_ROOT, absolutePath).split('\\').join('/');
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new FixtureError(
      'could not load `playwright`, so the render pages cannot be captured. Run `npm install` at ' +
        'the repository root and then `npm run setup` to install the Chromium binary this script ' +
        `drives. (${error.message})`,
    );
  }
}

async function launchChromium(chromium) {
  try {
    return await chromium.launch({
      headless: true,
      // Running as root inside a container: without this Chromium refuses to start.
      chromiumSandbox: false,
      // The host's /dev/shm is small for the 3000x3000 frame this script captures.
      args: ['--disable-dev-shm-usage'],
    });
  } catch (error) {
    throw new FixtureError(
      'Chromium failed to launch. Run `npm run setup` at the repository root to install the ' +
        `browser binary this script needs, then retry. (${error.message})`,
    );
  }
}

/**
 * Checks the capture table against itself before anything is rendered: a duplicate output, a
 * non-PNG output name, or an `oversize` flag that contradicts the declared viewport would
 * otherwise produce a fixture whose purpose the suites assert in the opposite direction.
 */
function assertCaptureTable() {
  const problems = [];
  const outputs = new Set();

  for (const capture of CAPTURES) {
    const label = `capture table row ${capture.page} -> ${capture.output}`;
    if (!capture.page.endsWith('.html')) {
      problems.push(`${label}: the source page must be an .html file`);
    }
    if (!capture.output.endsWith('.png')) {
      problems.push(`${label}: the output must be a .png file`);
    }
    if (outputs.has(capture.output)) {
      problems.push(`${label}: the output name is used more than once`);
    }
    outputs.add(capture.output);
    for (const dimension of [capture.width, capture.height]) {
      if (!Number.isInteger(dimension) || dimension <= 0) {
        problems.push(`${label}: viewport ${capture.width}x${capture.height} is not a positive whole number of pixels`);
        break;
      }
    }
    const declaredLongEdge = Math.max(capture.width, capture.height);
    if (capture.oversize && declaredLongEdge <= MAX_LONG_EDGE) {
      problems.push(
        `${label}: marked oversize but its declared long edge is ${declaredLongEdge}px, which does not exceed the ${MAX_LONG_EDGE}px bound`,
      );
    }
    if (!capture.oversize && declaredLongEdge > MAX_LONG_EDGE) {
      problems.push(
        `${label}: not marked oversize but its declared long edge is ${declaredLongEdge}px, which exceeds the ${MAX_LONG_EDGE}px bound a stored screenshot must respect`,
      );
    }
  }

  if (problems.length > 0) {
    throw new FixtureError(`the capture table is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

/** The render pages on disk, sorted so the cross-check against the table is deterministic. */
async function listRenderPages() {
  let entries;
  try {
    entries = await readdir(RENDER_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new FixtureError(
        `the render directory ${displayPath(RENDER_DIR)} does not exist, so there is nothing to capture. ` +
          'Restore the page sources under fixtures/render/ before running this script.',
      );
    }
    throw error;
  }

  const pages = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name)
    .sort();

  if (pages.length === 0) {
    throw new FixtureError(
      `the render directory ${displayPath(RENDER_DIR)} holds no .html pages, so there is nothing to capture.`,
    );
  }

  return pages;
}

/**
 * Keeps the generator and the committed fixtures in lockstep: a page that no row describes, or a
 * row whose page is missing, is reported by stem rather than surfacing as an ENOENT mid-run.
 */
function assertTableMatchesPages(pageNames) {
  const expected = new Set(CAPTURES.map((capture) => capture.page));
  const found = new Set(pageNames);
  const problems = [];

  for (const stem of pageNames.filter((name) => !expected.has(name))) {
    problems.push(`${displayPath(join(RENDER_DIR, stem))} has no row in the capture table`);
  }
  for (const stem of [...expected].filter((name) => !found.has(name)).sort()) {
    problems.push(`the capture table expects ${displayPath(join(RENDER_DIR, stem))}, which is not present`);
  }

  if (problems.length > 0) {
    throw new FixtureError(`the render pages and the capture table disagree:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Reads a PNG's dimensions from its IHDR header, the same header-only probe
 * `server/src/domain/image-probe.ts` performs, so the assertion needs no image-processing
 * dependency (AAP §0.9.3).
 */
function readPngSize(buffer, label) {
  const headerLength = 24;
  if (buffer.length < headerLength) {
    throw new FixtureError(`${label}: ${buffer.length} bytes is too short to hold a PNG header`);
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new FixtureError(`${label}: the file does not begin with the PNG signature`);
  }
  const chunkType = buffer.toString('latin1', 12, 16);
  if (chunkType !== 'IHDR') {
    throw new FixtureError(`${label}: the first PNG chunk is ${JSON.stringify(chunkType)} rather than IHDR`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Captures one table row and writes it to `outPath`. Each row gets its own browser context so the
 * viewport, device pixel ratio and colour scheme apply to that capture alone; `fullPage: false`
 * keeps the PNG's pixel dimensions equal to the viewport instead of letting content height leak in.
 */
async function renderCapture(browser, capture, outPath) {
  const context = await browser.newContext({
    viewport: { width: capture.width, height: capture.height },
    // A device pixel ratio other than 1 would silently change the PNG's real pixel dimensions.
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  });

  try {
    const page = await context.newPage();
    const externalRequests = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('ws:') || url.startsWith('wss:')) {
        externalRequests.push(url);
      }
    });

    await page.goto(pathToFileURL(join(RENDER_DIR, capture.page)).href, { waitUntil: 'load' });

    if (externalRequests.length > 0) {
      throw new FixtureError(
        `${capture.page} requests resources outside the repository (${externalRequests.join(', ')}). ` +
          'A render page must be self-contained so the fixtures can be regenerated without network access.',
      );
    }

    // Neutralise everything that could make two runs differ, then settle fonts and layout. Two
    // animation frames flush style and layout without a fixed sleep, which would be a race.
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}',
    });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () => new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(() => settle(null)))),
    );

    await page.screenshot({ path: outPath, type: 'png', fullPage: false });
    await page.close();
  } finally {
    await context.close().catch((error) => {
      process.stderr.write(`generate-fixtures: warning: a browser context did not close cleanly: ${error.message}\n`);
    });
  }
}

/** Exact dimensions and the long-edge rule, so a viewport edit cannot silently invalidate a fixture. */
function assertCaptureMatches(capture, measured, label) {
  if (measured.width !== capture.width || measured.height !== capture.height) {
    throw new FixtureError(
      `${label}: expected ${capture.width}x${capture.height} but the PNG holds ${measured.width}x${measured.height}`,
    );
  }

  const longEdge = Math.max(measured.width, measured.height);
  if (capture.oversize && longEdge <= MAX_LONG_EDGE) {
    throw new FixtureError(
      `${label}: is the oversize fixture and must exceed the ${MAX_LONG_EDGE}px long edge, but its long edge is ${longEdge}px`,
    );
  }
  if (!capture.oversize && longEdge > MAX_LONG_EDGE) {
    throw new FixtureError(
      `${label}: its long edge is ${longEdge}px, above the ${MAX_LONG_EDGE}px bound every stored screenshot must respect`,
    );
  }
}

async function main() {
  const { chromium } = await loadPlaywright();

  assertCaptureTable();
  const pageNames = await listRenderPages();
  assertTableMatchesPages(pageNames);

  await mkdir(OUT_DIR, { recursive: true });

  const browser = await launchChromium(chromium);
  const written = [];

  try {
    for (const capture of CAPTURES) {
      const outPath = join(OUT_DIR, capture.output);
      const label = displayPath(outPath);

      await renderCapture(browser, capture, outPath);

      const buffer = await readFile(outPath);
      const measured = readPngSize(buffer, label);
      assertCaptureMatches(capture, measured, label);

      written.push({ label, width: measured.width, height: measured.height, byteSize: buffer.length });
    }
  } finally {
    await browser.close().catch((error) => {
      process.stderr.write(`generate-fixtures: warning: the browser did not close cleanly: ${error.message}\n`);
    });
  }

  // Reported only once every fixture is written and verified, so a partial run never reads as success.
  for (const file of written) {
    process.stdout.write(`${file.label} ${file.width}x${file.height} ${file.byteSize} bytes\n`);
  }
  process.stdout.write(`wrote ${written.length} screenshots to ${displayPath(OUT_DIR)}\n`);
}

main().catch((error) => {
  const message = error instanceof FixtureError ? error.message : (error.stack ?? String(error));
  process.stderr.write(`generate-fixtures: ${message}\n`);
  process.exitCode = 1;
});
