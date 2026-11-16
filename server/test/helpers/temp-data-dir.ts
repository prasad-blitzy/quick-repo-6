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

/**
 * An empty data directory for one test, created outside the repository checkout.
 *
 * Teardown is the caller's obligation and must survive a failing test: call `cleanup()` from an
 * `afterEach` hook or a `finally` block, or hold the value with `await using`, whose scope end
 * disposes the directory even when the test throws before reaching its own cleanup.
 */
export interface TempDataDir {
  /** Absolute path of the directory, which exists from the moment the promise resolves. */
  readonly dataDir: string;
  /**
   * Removes the directory with everything written into it. Safe to call any number of times.
   *
   * Call it from an `afterEach` hook or a `finally` block rather than only after a test's last
   * assertion, so an assertion that throws still removes the directory and the store inside it.
   */
  cleanup(): Promise<void>;
  /**
   * Removes the directory exactly as `cleanup()` does, through the same idempotent path, so
   * `await using` tears it down when the enclosing scope ends however that scope is left.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Creates a unique empty directory for use as a test data directory.
 *
 * The directory is created afresh and nothing is created or deleted anywhere else, so a suite can
 * point a second repository instance at the same path to show that stored analyses survive a
 * restart.
 *
 * Nothing tears the directory down on the caller's behalf, so the caller owns it: call `cleanup()`
 * from an `afterEach` hook or a `finally` block so a failing assertion still removes the directory,
 * or hold the returned value with `await using`, whose scope end disposes it.
 *
 * @param prefix Leading name segment for the directory; defaults to `trade-read-test-`. It is
 *   joined as one name segment under the temporary root, so it must be a bare name.
 * @throws If `prefix` is blank, is `.`, contains `..` or carries a path separator, any of which
 *   would build a directory path outside the temporary root.
 * @throws If the created path would land inside the repository checkout, which includes the
 *   repository's own `.data` directory.
 */
export async function createTempDataDir(prefix?: string): Promise<TempDataDir> {
  const namePrefix = assertBarePrefix(prefix ?? DEFAULT_PREFIX);
  const dataDir = resolve(await mkdtemp(join(tmpdir(), namePrefix)));

  if (isInsideRepository(dataDir)) {
    throw new Error(
      `Refusing to use "${dataDir}" as a test data directory: it is inside the repository checkout ` +
        `"${REPO_ROOT}" or is the repository's own "${REPOSITORY_DATA_DIR}".`,
    );
  }

  let cleaned = false;

  async function cleanup(): Promise<void> {
    if (cleaned) {
      return;
    }

    await rm(dataDir, { recursive: true, force: true });
    cleaned = true;
  }

  return {
    dataDir,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

// The prefix is the whole name segment the directory is created under, so it is validated before
// `mkdtemp` runs rather than after: a separator or ".." would place the directory outside the
// temporary root, and `.` or a blank value collapses the join onto the root itself. The
// containment guard below stays as the second line of defence.
function assertBarePrefix(prefix: string): string {
  if (prefix.trim() === '') {
    throw new Error(
      `Test data directory prefix ${JSON.stringify(prefix)} must not be blank; ` +
        `pass a bare name segment such as "${DEFAULT_PREFIX}".`,
    );
  }

  if (prefix === '.') {
    throw new Error(
      'Test data directory prefix "." names the temporary root itself, so the random suffix is ' +
        `appended to that root's own name and the directory created beside it; ` +
        `pass a bare name segment such as "${DEFAULT_PREFIX}".`,
    );
  }

  if (prefix.includes('..') || prefix.includes('/') || prefix.includes('\\')) {
    throw new Error(
      `Test data directory prefix "${prefix}" must be a bare name segment without a path ` +
        `separator or ".."; the temporary root is joined by this helper, not by the caller.`,
    );
  }

  return prefix;
}

// The `.data` comparison is kept explicit: that directory holds a developer's real store, so the
// refusal names it rather than reporting a bare containment failure. A resolved candidate is
// normalised without a trailing separator, which is why containment is the prefix test.
function isInsideRepository(candidate: string): boolean {
  return candidate === REPOSITORY_DATA_DIR || candidate.startsWith(REPO_ROOT_PREFIX);
}
