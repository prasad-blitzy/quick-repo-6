import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from 'playwright/test';

/**
 * The repository root, resolved from this module's own location because a Playwright worker's
 * working directory is wherever the runner was launched — the end-to-end harness starts it from the
 * repository root today, but nothing in the config guarantees that, and a fixture path resolved
 * against the wrong directory would fail as "missing" rather than as "wrong cwd".
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The three image types the API accepts, keyed by lowercased file extension. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** One image file, in the shape a drop needs: a name, the type a browser would report, and bytes. */
export type DropFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * Reads fixture images from the repository, so a caller can name them the way a documentation link
 * would and get real bytes back. The result is in the order requested, which is the order the drop
 * hands to the upload surface and therefore the order its thumbnails appear in.
 *
 * @param relativePaths Paths relative to the repository root, e.g.
 *   `'fixtures/screenshots/footprint-es-5m.png'`.
 */
export async function readFixtureFiles(relativePaths: string[]): Promise<DropFile[]> {
  return Promise.all(
    relativePaths.map(async (relativePath): Promise<DropFile> => {
      const absolutePath = join(REPO_ROOT, relativePath);

      const mimeType = MIME_BY_EXTENSION[extname(absolutePath).toLowerCase()];
      if (mimeType === undefined) {
        throw new Error(
          `${absolutePath} is not a PNG, JPEG or WebP image. Only those three types are accepted, ` +
            'and the API rejects anything else before it reads a pixel.',
        );
      }

      return { name: basename(absolutePath), mimeType, buffer: await readFixtureBytes(absolutePath) };
    }),
  );
}

/**
 * Hands every file to the zone in one drag gesture: one `DataTransfer` carrying all of them, the
 * same way an operating-system drop of several selected files arrives.
 *
 * Nothing here waits for the queue, and nothing asserts about the interface: what the drop
 * produced belongs to the caller's assertions.
 *
 * @param page The page holding the upload surface.
 * @param files The files to drop, in the order their thumbnails should appear.
 */
export async function dropFilesOnZone(page: Page, files: DropFile[]): Promise<void> {
  if (files.length === 0) {
    throw new Error(
      'dropFilesOnZone needs at least one file: an empty drop exercises no upload path at all.',
    );
  }

  // Buffers cannot cross the process boundary into the page, so the bytes travel as base64. They
  // stay inside this payload — never logged, never returned, never written anywhere.
  const payload = files.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    base64: file.buffer.toString('base64'),
  }));

  const dropWasAccepted = await page.evaluate((dropped) => {
    const zones = document.querySelectorAll('.drop-zone');
    const zone = zones.item(0);
    if (zone === null || zones.length !== 1) {
      throw new Error(
        `dropFilesOnZone expected exactly one .drop-zone element, found ${zones.length}.`,
      );
    }

    const transfer = new DataTransfer();
    for (const item of dropped) {
      const bytes = Uint8Array.from(atob(item.base64), (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: item.mimeType }));
    }

    // `bubbles: true` is mandatory: React attaches its listeners on the root container, so an
    // event that stays on the zone never reaches the component's handler and the drop does nothing.
    const dragEvent = (type: string): DragEvent =>
      new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });

    zone.dispatchEvent(dragEvent('dragenter'));
    zone.dispatchEvent(dragEvent('dragover'));
    const drop = dragEvent('drop');
    zone.dispatchEvent(drop);

    // The zone's drop handler calls preventDefault to stop the browser from navigating to the
    // dropped file, so a cancelled default is the evidence that the application took the drop.
    return drop.defaultPrevented;
  }, payload);

  if (!dropWasAccepted) {
    throw new Error(
      'The drop zone did not call preventDefault() on the drop event, so the browser would have ' +
        'navigated to the dropped file and the application never received it.',
    );
  }
}

/** Reads one fixture's bytes, turning the likeliest failure into an instruction to fix it. */
async function readFixtureBytes(absolutePath: string): Promise<Buffer> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new Error(
        `${absolutePath} does not exist. The fixture screenshots are generated rather than ` +
          'committed: run `npm run setup`, then `node fixtures/generate-fixtures.mjs`.',
      );
    }
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
