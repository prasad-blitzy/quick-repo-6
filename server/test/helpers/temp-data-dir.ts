import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this module's own URL, never from the working directory, so the guard below holds
// whether the suite is started from the repository root or from inside `server/`.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// `REPO_ROOT` keeps the trailing separator the URL form produces; containment compares against a
// single-separator prefix rather than another separator appended to that one.
const REPO_ROOT_PREFIX = REPO_ROOT.endsWith(sep) ? REPO_ROOT : `${REPO_ROOT}${sep}`;

// The repository's own store. A test directory must never be, or sit inside, this path.
const REPOSITORY_DATA_DIR = join(REPO_ROOT, '.data');

const DEFAULT_PREFIX = 'trade-read-test-';

/** An empty data directory for one test, created outside the repository checkout. */
export interface TempDataDir {
  /** Absolute path of the directory, which exists from the moment the promise resolves. */
  readonly dataDir: string;
  /** Removes the directory with everything written into it. Safe to call any number of times. */
  cleanup(): Promise<void>;
}

/**
 * Creates a unique empty directory for use as a test data directory.
 *
 * The directory is created afresh and nothing is created or deleted anywhere else, so a suite can
 * point a second repository instance at the same path to show that stored analyses survive a
 * restart.
 *
 * @param prefix Leading name segment for the directory; defaults to `trade-read-test-`.
 * @throws If the created path would land inside the repository checkout, which includes the
 *   repository's own `.data` directory.
 */
export async function createTempDataDir(prefix?: string): Promise<TempDataDir> {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), prefix ?? DEFAULT_PREFIX)));

  if (isInsideRepository(dataDir)) {
    throw new Error(
      `Refusing to use "${dataDir}" as a test data directory: it is inside the repository checkout ` +
        `"${REPO_ROOT}" or is the repository's own "${REPOSITORY_DATA_DIR}".`,
    );
  }

  let cleaned = false;

  return {
    dataDir,
    async cleanup(): Promise<void> {
      if (cleaned) {
        return;
      }

      await rm(dataDir, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

// The `.data` comparison is kept explicit: that directory holds a developer's real store, so the
// refusal names it rather than reporting a bare containment failure. A resolved candidate is
// normalised without a trailing separator, which is why containment is the prefix test.
function isInsideRepository(candidate: string): boolean {
  return candidate === REPOSITORY_DATA_DIR || candidate.startsWith(REPO_ROOT_PREFIX);
}
