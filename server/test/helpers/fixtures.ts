import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the repository's `fixtures` directory.
 *
 * Resolved from this module's own location — `server/test/helpers` → `server/test` → `server` →
 * repository root — so a suite finds the fixtures regardless of the directory the test runner
 * starts in. `resolve` drops the URL's trailing separator, so the value ends at `fixtures`.
 */
export const FIXTURES_ROOT: string = resolve(fileURLToPath(new URL('../../../fixtures/', import.meta.url)));

/** Absolute path of the screenshot fixtures. */
export const SCREENSHOTS_DIR: string = join(FIXTURES_ROOT, 'screenshots');

/** Absolute path of the fixture files that are not screenshots. */
export const FILES_DIR: string = join(FIXTURES_ROOT, 'files');

/** Every screenshot fixture a suite may upload. */
export const SCREENSHOT_STEMS = [
  'footprint-es-5m',
  'gex-es-levels',
  'dom-ladder-es',
  'volume-profile-es',
  'blank-uniform',
  'oversize-long-edge',
] as const;

/** A screenshot fixture's name, without its `.png` extension. */
export type ScreenshotStem = (typeof SCREENSHOT_STEMS)[number];

/** The committed file whose bytes are not an accepted image type. */
export const NOT_AN_IMAGE_PDF_FILE_NAME = 'not-an-image.pdf';

/**
 * One uploaded-file fixture, shaped the way a suite posts it as a multipart part.
 *
 * `contentType` is the client's claim and nothing more: the server sniffs the magic bytes in
 * `server/src/domain/image-probe.ts` and `server/src/domain/image-validation.ts` rejects a part
 * whose bytes disagree. The PDF fixture is therefore sent with its honest `application/pdf`, so
 * the type rejection is what gets proven rather than a decode failure.
 *
 * `bytes` is a `Buffer` because this surface exists only for tests. The domain's stored-image
 * type deliberately uses `Uint8Array`; this is not that type.
 */
export interface MultipartAttachment {
  /** The file name the multipart part claims. */
  fileName: string;
  /** The content type the multipart part claims. */
  contentType: string;
  /** The fixture's exact on-disk bytes: nothing padded, re-encoded or rewritten. */
  bytes: Buffer;
}

const PNG_CONTENT_TYPE = 'image/png';
const PDF_CONTENT_TYPE = 'application/pdf';
const NOT_AN_IMAGE_PDF_PATH = join(FILES_DIR, NOT_AN_IMAGE_PDF_FILE_NAME);

function missingScreenshotError(stem: string, path: string): Error {
  const unknownStem = (SCREENSHOT_STEMS as readonly string[]).includes(stem)
    ? ''
    : ` '${stem}' is not one of the known screenshot stems (${SCREENSHOT_STEMS.join(', ')}).`;
  return new Error(
    `Missing screenshot fixture: ${path}.${unknownStem} The screenshot fixtures are committed to the ` +
      'repository, so a missing copy means an incomplete checkout: restore it from version control, or ' +
      'regenerate every screenshot by running `npm run setup` to install the Chromium binary the ' +
      'generator drives and then `node fixtures/generate-fixtures.mjs` from the repository root.',
  );
}

/**
 * Absolute path of one screenshot fixture, asserted to be on disk.
 *
 * A missing PNG means the checkout is incomplete, so the error names the absolute path, the stem when
 * it is not a known one, the restore route, and the two commands that regenerate the file.
 */
export function screenshotPath(stem: ScreenshotStem): string {
  const path = join(SCREENSHOTS_DIR, `${stem}.png`);
  if (!existsSync(path)) {
    throw missingScreenshotError(stem, path);
  }
  return path;
}

/** Absolute path of the wrong-type fixture, asserted to be on disk. */
export function notAnImagePdfPath(): string {
  if (!existsSync(NOT_AN_IMAGE_PDF_PATH)) {
    throw new Error(
      `Missing fixture file: ${NOT_AN_IMAGE_PDF_PATH}. That file is committed to the repository and is ` +
        'not generated, so a missing copy means an incomplete checkout; restore it from version control.',
    );
  }
  return NOT_AN_IMAGE_PDF_PATH;
}

/** One screenshot as a multipart part named `<stem>.png`. */
export function readScreenshot(stem: ScreenshotStem): MultipartAttachment {
  return screenshotAttachment(stem);
}

/**
 * One screenshot as a multipart part.
 *
 * `fileName` defaults to `<stem>.png` and is deliberately not validated: suites rename the part to
 * drive the stub's choice of recorded answer, and to prove name handling with names that collide
 * or carry spaces.
 */
export function screenshotAttachment(stem: ScreenshotStem, fileName?: string): MultipartAttachment {
  return {
    fileName: fileName ?? `${stem}.png`,
    contentType: PNG_CONTENT_TYPE,
    bytes: readFileSync(screenshotPath(stem)),
  };
}

/** The wrong-type fixture as a multipart part, named as committed unless `fileName` overrides it. */
export function notAnImagePdfAttachment(fileName?: string): MultipartAttachment {
  return {
    fileName: fileName ?? NOT_AN_IMAGE_PDF_FILE_NAME,
    contentType: PDF_CONTENT_TYPE,
    bytes: readFileSync(notAnImagePdfPath()),
  };
}

/** One screenshot's exact bytes, for suites that assert on image headers. */
export function screenshotBytes(stem: ScreenshotStem): Buffer {
  return readFileSync(screenshotPath(stem));
}
