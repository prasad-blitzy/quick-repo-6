/**
 * End-to-end harness: builds the workspace, brings up a stub-configured API and the client dev
 * server, runs the Playwright suite against them, and proves the captured API log carries neither
 * the model credential nor image bytes.
 *
 * `playwright.config.ts` deliberately declares no `webServer`: a config-managed server would not be
 * the stub-configured API this run requires, and a second, differently configured API would hide
 * the stub. So this script owns every process, in eight stages:
 *
 *   1. build `shared`, then `server`, so the API runs the compiled entry point;
 *   2. capture: tee both children into `.e2e/server.log` and `.e2e/client.log` while still printing
 *      their output; both files are emptied in the preamble before stage 1, so a build that fails
 *      leaves no earlier run's log behind for stage 8 to scan;
 *   3. start the API: `node dist/index.js` from `server/`, over a temporary `DATA_DIR` removed at
 *      teardown, with `STUB_PROVIDER=1`;
 *   4. start the client: the Vite dev server, pointed at the API origin this run is using;
 *   5. wait for `GET /api/v1/health` and the client origin to answer 200, failing fast if either
 *      child dies first;
 *   6. confirm the Chromium binary Playwright needs is installed;
 *   7. run Playwright and keep its exit code;
 *   8. assert the captured API log holds no credential, no key shape and no base64 payload.
 *
 * Ports and bind address come from the environment (`PORT`, `HOST`, `VITE_PORT`) so a checkout that
 * reserves a port block runs entirely inside it; unset, they are the documented defaults.
 *
 * The API is given a credential invented for this run, assembled from parts at run time so this
 * file holds no key-shaped literal and never written to disk. `STUB_PROVIDER=1` selects the replay
 * provider, so that value never leaves the process: it exists so the log assertion has something
 * that must not appear in the log, instead of passing because no credential was ever set. An
 * operator's own exported credential is scanned for as well.
 *
 * Two things a run must never do are handled here rather than left to the operator: a child that
 * dies before answering is reported with its exit code and the last output it produced, and every
 * process this script started is stopped as a process group at the end, whatever stage the run
 * reached.
 *
 * The readiness poll and the log scan are exported so they can be exercised on their own; the stage
 * sequence and the exit code live in the guarded entry point.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repository root, so every child runs there whatever directory the script was started in. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the API is built to, and the entry point the stage 3 child runs. */
const SERVER_DIR = resolve(ROOT, 'server');
const SERVER_ENTRY = resolve(SERVER_DIR, 'dist', 'index.js');

/** Captured output: the API's for the leak assertion, the client's for diagnosis. */
const E2E_DIR = resolve(ROOT, '.e2e');
const SERVER_LOG = resolve(E2E_DIR, 'server.log');
const CLIENT_LOG = resolve(E2E_DIR, 'client.log');

const IS_WINDOWS = process.platform === 'win32';
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm';
const PLAYWRIGHT_BIN = resolve(
  ROOT,
  'node_modules',
  '.bin',
  IS_WINDOWS ? 'playwright.cmd' : 'playwright',
);

/** How long a child may take to stop on SIGTERM before its process group is killed outright. */
const STOP_GRACE_MS = 5_000;

/** How long the API and the client get to answer before the run is declared failed. */
const READY_TIMEOUT_MS = 90_000;

/** Gap between readiness probes. */
const READY_POLL_INTERVAL_MS = 250;

/** A single probe's own cap, so a socket that never answers cannot consume the whole budget. */
const READY_REQUEST_TIMEOUT_MS = 2_000;

/** Lines of each child's output quoted when a stage fails. */
const LOG_TAIL_LINES = 20;

/** Longest partial line kept for that quote, so one endless line cannot grow it without bound. */
const TAIL_LINE_MAX = 4_096;

/**
 * How long a run of base64-alphabet characters has to be before it can only have come from binary
 * data. Ordinary log text separates its words with spaces and its fields with JSON punctuation, so
 * a 200-character unbroken run of `A-Za-z0-9+/` is a payload, not prose; the smallest real image is
 * thousands of characters of it.
 */
export const BASE64_RUN_THRESHOLD = 200;

/** Characters kept either side of a masked span in a reported excerpt. */
const EXCERPT_RADIUS = 40;

/**
 * Longest masked run still reported with its context. Past this the excerpt carries the span's
 * length and no surrounding text, so one pathological inline blob is neither reprinted nor turned
 * into a multi-kilobyte report line.
 */
const MASKED_SPAN_LIMIT = 200;

/**
 * Characters that can belong to the same token: the base64/base64url and vendor-key alphabet plus
 * the word characters a prompt phrase carries. Whitespace, a quote, a brace, a bracket, a comma and
 * every other delimiter end the run.
 */
const TOKEN_CHARACTER = /[A-Za-z0-9_\-./+=]/;

/** The credential's variable name: it may not appear in a log line either. */
const CREDENTIAL_VARIABLE = 'OPENROUTER_API_KEY';

/**
 * The leading shape of a vendor key, assembled from parts at run time so this file holds no
 * key-shaped literal. The scan's subject is the shape, never a key.
 */
const CREDENTIAL_KEY_PREFIX = ['sk', 'or'].join('-') + '-';

/**
 * The credential this run's API is started with. Random per run, assembled from parts, and selected
 * alongside the stub provider, so it exists only for the log assertion to have something to find.
 */
const RUN_CREDENTIAL = ['sk', 'or', 'v1', 'e2e', randomBytes(9).toString('hex')].join('-');

/** The health route, as the API base path and the health router compose it. */
const HEALTH_PATH = '/api/v1/health';

/** Reads an override, treating an unset or blank value as absent. */
function envValue(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * A TCP port from the environment. A value that is not a real port stops the run here, because a
 * child asked to bind it would fail later with a message about the wrong thing.
 */
function envPort(name, fallback) {
  const raw = envValue(name, fallback);
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new HarnessError(`${name} must be an integer between 1 and 65535`, [
      `received  ${raw}`,
    ]);
  }

  return String(port);
}

const HOST = envValue('HOST', '127.0.0.1');

/** A stage that failed, with the lines an operator needs to see why. */
class HarnessError extends Error {
  constructor(reason, details = []) {
    super(reason);
    this.name = 'HarnessError';
    this.details = details;
  }
}

/** Live children, so a shutdown signals exactly the processes still running. */
const live = new Set();

/** The signal that interrupted the run, if one did. */
let interruptedSignal = null;

/** Set while this script stops its own children, so their exits are not reported as crashes. */
let stopping = false;

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function delay(ms) {
  // Deliberately referenced: a poll between two probes must not let the process exit early.
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/**
 * Signals a child's whole process group. The group id equals the child's pid because the child is
 * spawned detached on POSIX, which is also what makes `-pid` address npm and its grandchildren.
 */
function signalGroup(child, signal) {
  const { pid } = child.proc;

  if (typeof pid !== 'number') {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH means the group is already gone, which is the outcome the signal wanted.
    if (error.code !== 'ESRCH') {
      console.error(`run-e2e: ${child.label}: could not send ${signal} (${error.message})`);
    }
  }
}

function forceKill(child) {
  if (IS_WINDOWS) {
    // npm runs through a shell on Windows, so kill the tree rather than the shim.
    spawnSync('taskkill', ['/pid', String(child.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  signalGroup(child, 'SIGKILL');
}

function requestStop(child) {
  if (IS_WINDOWS) {
    forceKill(child);
    return;
  }

  signalGroup(child, 'SIGTERM');
}

function hasExited(child) {
  const { proc } = child;
  return (
    typeof proc.pid !== 'number' || proc.exitCode !== null || proc.signalCode !== null
  );
}

/** How a child ended, or `null` while it is still running. */
function childOutcome(child) {
  if (child.spawnError !== null) {
    return `it could not be started (${child.spawnError})`;
  }

  const { proc } = child;

  if (proc.exitCode !== null) {
    return `code ${proc.exitCode}`;
  }

  if (proc.signalCode !== null) {
    return `signal ${proc.signalCode}`;
  }

  return null;
}

/** Appends a tail line, keeping the buffer bounded. */
function pushTail(child, line) {
  child.tail.push(line);

  if (child.tail.length > LOG_TAIL_LINES) {
    child.tail.shift();
  }
}

/**
 * Tees one child stream into its log file and onto the console, and keeps the last lines for a
 * failure report. The file is appended synchronously, so a log left behind by an interrupted run is
 * complete up to the last byte the child wrote.
 */
function captureStream(stream, child, sink) {
  let pending = '';

  stream.setEncoding('utf8');

  stream.on('data', (chunk) => {
    appendFileSync(child.logPath, chunk);
    sink.write(chunk);

    pending += chunk;

    const lines = pending.split('\n');
    pending = lines.pop() ?? '';

    if (pending.length > TAIL_LINE_MAX) {
      pending = pending.slice(-TAIL_LINE_MAX);
    }

    for (const line of lines) {
      pushTail(child, line);
    }
  });

  stream.on('end', () => {
    if (pending !== '') {
      pushTail(child, pending);
      pending = '';
    }
  });

  stream.on('error', (error) => {
    pushTail(child, `(output stream error: ${error.message})`);
  });
}

function processOptions({ cwd = ROOT, env = process.env, shell = false } = {}) {
  return {
    cwd,
    env,
    shell,
    // Its own process group on POSIX, so a stop reaches npm and everything npm started.
    detached: !IS_WINDOWS,
  };
}

/**
 * Starts a child whose output is captured. Returns a record the readiness poll and the failure
 * report both read.
 */
function startCapturedChild({
  label,
  command,
  args,
  cwd = ROOT,
  env = process.env,
  logPath,
  shell = false,
}) {
  const child = { label, proc: null, logPath, tail: [], closed: false, spawnError: null };
  const proc = spawn(command, args, {
    ...processOptions({ cwd, env, shell }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.proc = proc;
  live.add(child);

  // A child that never started emits 'error' and may emit no 'exit' at all, so the readiness poll
  // reads the failure from here rather than waiting out its whole budget.
  proc.once('error', (error) => {
    child.spawnError = error.message;
    pushTail(child, `failed to start: ${error.message}`);
  });

  proc.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`run-e2e: ${label} exited on its own (code ${code}, signal ${signal})`);
    }
  });

  // 'close' follows 'exit' once the output streams are drained, and it is what a teardown waits
  // for: reading a log whose last chunk is still in flight would let a leak escape the assertion.
  proc.once('close', () => {
    child.closed = true;
  });

  if (proc.stdout !== null) {
    captureStream(proc.stdout, child, process.stdout);
  }

  if (proc.stderr !== null) {
    captureStream(proc.stderr, child, process.stderr);
  }

  return child;
}

/**
 * Polls `url` until it answers 200, until the deadline, or until `cancellation` returns a reason.
 *
 * Every probe is capped on its own so one unanswered socket cannot use up the whole budget, and the
 * body is drained so the connection is released rather than left for the server to time out.
 */
export async function waitForHttpReady(
  url,
  {
    timeoutMs = READY_TIMEOUT_MS,
    intervalMs = READY_POLL_INTERVAL_MS,
    requestTimeoutMs = READY_REQUEST_TIMEOUT_MS,
    cancellation = () => null,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastOutcome = 'no response was received';

  while (Date.now() < deadline) {
    const cancelled = cancellation();

    if (cancelled !== null) {
      return { ok: false, reason: cancelled };
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      await response.text();

      if (response.ok) {
        return { ok: true, reason: null };
      }

      lastOutcome = `the last response was HTTP ${response.status}`;
    } catch (error) {
      lastOutcome = `the last probe failed: ${error.message}`;
    }

    await delay(intervalMs);
  }

  return {
    ok: false,
    reason: `no 200 from ${url} within ${timeoutMs} ms (${lastOutcome})`,
  };
}

/** Stops a stage from starting new work once the operator has interrupted the run. */
function assertNotInterrupted() {
  if (interruptedSignal !== null) {
    throw new HarnessError(`the run was interrupted by ${interruptedSignal}, so it proved nothing`);
  }
}

/** The whole token a match sits in: the match extended both ways over `TOKEN_CHARACTER`. */
function tokenSpanAt(text, index, length) {
  let start = index;
  let end = index + length;

  while (start > 0 && TOKEN_CHARACTER.test(text[start - 1])) {
    start -= 1;
  }

  while (end < text.length && TOKEN_CHARACTER.test(text[end])) {
    end += 1;
  }

  return { start, end };
}

/**
 * A window of context around a match with the whole key-shaped run it sits in masked, so a report
 * never reprints a secret. Masking the match alone would not be enough: two of the needles are the
 * six characters of a key's leading shape, so the text right after such a hit is the credential's
 * own body. The masked span is therefore the token the match belongs to — extended over every
 * character that can belong to it — and the context window sits outside that span. A span past
 * `MASKED_SPAN_LIMIT` is reported by its length alone, with no surrounding text.
 */
function redactExcerpt(text, index, length) {
  const span = tokenSpanAt(text, index, length);
  const maskedLength = span.end - span.start;

  if (maskedLength > MASKED_SPAN_LIMIT) {
    return `[REDACTED: ${maskedLength} characters]`;
  }

  const start = Math.max(0, span.start - EXCERPT_RADIUS);
  const end = Math.min(text.length, span.end + EXCERPT_RADIUS);
  const before = text.slice(start, span.start).replace(/\s+/g, ' ');
  const after = text.slice(span.end, end).replace(/\s+/g, ' ');

  return `${start > 0 ? '...' : ''}${before}[REDACTED]${after}${end < text.length ? '...' : ''}`;
}

/**
 * The pure log scan: every needle found, plus the first run of base64-alphabet characters long
 * enough to be a payload. A payload is reported by its length rather than its content, because
 * reprinting image bytes in a failure message is the leak the scan exists to prevent.
 */
export function scanLogForLeaks(text, needles, { base64Threshold = BASE64_RUN_THRESHOLD } = {}) {
  const hits = [];

  for (const needle of needles) {
    if (typeof needle.value !== 'string' || needle.value === '') {
      continue;
    }

    const first = text.indexOf(needle.value);

    if (first === -1) {
      continue;
    }

    let occurrences = 0;
    let from = first;

    while (from !== -1) {
      occurrences += 1;
      from = text.indexOf(needle.value, from + needle.value.length);
    }

    hits.push({
      label: needle.label,
      occurrences,
      excerpt: redactExcerpt(text, first, needle.value.length),
    });
  }

  const payload = new RegExp(`[A-Za-z0-9+/]{${base64Threshold},}`).exec(text);

  if (payload !== null) {
    hits.push({
      label: `a base64 payload of ${payload[0].length} characters`,
      occurrences: 1,
      excerpt: `[payload withheld: ${payload[0].length} characters]`,
    });
  }

  return hits;
}

/** The needles the captured API log is scanned for, including the operator's own credential. */
function logScanNeedles() {
  const needles = [
    { label: 'the run credential sentinel', value: RUN_CREDENTIAL },
    { label: 'the credential variable name', value: CREDENTIAL_VARIABLE },
    { label: 'the credential key shape', value: CREDENTIAL_KEY_PREFIX },
  ];

  const operatorKey = process.env[CREDENTIAL_VARIABLE]?.trim();

  if (typeof operatorKey === 'string' && operatorKey !== '') {
    needles.push({ label: "the operator's exported credential", value: operatorKey });
  }

  return needles;
}

/**
 * Stops one child as a process group: SIGTERM, then SIGKILL once the grace period is spent, and
 * resolves once the child's output streams are closed as well as its process ended.
 */
function stopChild(child) {
  return new Promise((resolveStop) => {
    if (child.closed) {
      resolveStop();
      return;
    }

    let settled = false;

    const settle = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolveStop();
    };

    const killTimer = setTimeout(() => {
      forceKill(child);
    }, STOP_GRACE_MS);

    // A group that survives even SIGKILL (a zombie, an unkillable device wait) must not hold the
    // run: stop waiting shortly after the kill instead of waiting for an end that may never come.
    const giveUpTimer = setTimeout(settle, STOP_GRACE_MS + 5_000);

    child.proc.once('close', settle);

    if (!hasExited(child)) {
      requestStop(child);
    }
  });
}

/** Stops every live child, and forgets them. Idempotent, so teardown can call it again. */
async function stopAllChildren() {
  const stoppingChildren = [...live];

  live.clear();
  stopping = true;

  await Promise.all(stoppingChildren.map((child) => stopChild(child)));
}

/** The last output a failed child produced, as report lines. */
function describeTail(child) {
  const details = [`${child.label} log  ${relative(ROOT, child.logPath)}`];

  if (child.tail.length === 0) {
    details.push('  (the child produced no output)');
    return details;
  }

  for (const line of child.tail) {
    details.push(`  ${line}`);
  }

  return details;
}

/** Runs one workspace build to completion, failing the stage by name when it does not succeed. */
function runWorkspaceBuild(workspace, meaning) {
  const args = ['run', 'build', '-w', workspace];

  console.log(`  command  ${formatCommand(NPM_COMMAND, args)}`);

  const result = spawnSync(NPM_COMMAND, args, {
    ...processOptions({ cwd: ROOT }),
    // Inherited, so a compiler error reaches the operator's terminal where it is actionable.
    stdio: 'inherit',
  });

  if (result.error) {
    throw new HarnessError(`${meaning} could not be started`, [
      `command  ${formatCommand(NPM_COMMAND, args)}`,
      `error    ${result.error.message}`,
    ]);
  }

  if (result.status !== 0) {
    const outcome =
      result.status === null ? `signal ${result.signal}` : `exit code ${result.status}`;

    throw new HarnessError(`${meaning} failed (${outcome})`, [
      `command  ${formatCommand(NPM_COMMAND, args)}`,
    ]);
  }
}

/** Starts the API on the run's data directory, with the stub provider selected. */
function startApi(tempDataDir, port) {
  const args = ['dist/index.js'];

  console.log(`  command  node ${join('server', 'dist', 'index.js')} (cwd server)`);
  console.log(`  data     ${tempDataDir}`);

  return startCapturedChild({
    label: 'api',
    command: process.execPath,
    args,
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      STUB_PROVIDER: '1',
      DATA_DIR: tempDataDir,
      PORT: port,
      HOST,
      [CREDENTIAL_VARIABLE]: RUN_CREDENTIAL,
    },
    logPath: SERVER_LOG,
  });
}

/** Starts the client dev server, proxying to this run's API origin. */
function startClient(apiOrigin, vitePort) {
  const args = ['run', 'dev', '-w', '@trade-read/client'];

  console.log(`  command  ${formatCommand(NPM_COMMAND, args)}`);

  return startCapturedChild({
    label: 'client',
    command: NPM_COMMAND,
    args,
    env: {
      ...process.env,
      VITE_PORT: vitePort,
      VITE_API_TARGET: apiOrigin,
    },
    shell: IS_WINDOWS,
    logPath: CLIENT_LOG,
  });
}

/**
 * Waits for one service to answer, reporting a child that died on its own before it did. A dead
 * child is the whole story, so it is reported with its exit code and the last output it produced
 * rather than as a timeout.
 */
async function awaitService(child, url, extraDetails = () => []) {
  const result = await waitForHttpReady(url, {
    cancellation: () => {
      // An interrupt is why the child died, so it is reported as the cause rather than as an exit.
      if (interruptedSignal !== null) {
        return `the run was interrupted by ${interruptedSignal}`;
      }

      const outcome = childOutcome(child);

      return outcome === null ? null : `${child.label} exited before answering (${outcome})`;
    },
  });

  if (!result.ok) {
    throw new HarnessError(`${child.label} did not answer ${url}: ${result.reason}`, [
      ...extraDetails(),
      ...describeTail(child),
    ]);
  }

  console.log(`  ready    ${url}`);
}

/**
 * Confirms the browser binary Playwright needs is on disk. Its absence is the one precondition the
 * harness cannot satisfy itself and cannot work around, so it stops with the command that installs
 * it.
 */
async function checkChromiumBinary() {
  let executablePath;

  try {
    const { chromium } = await import('playwright');

    executablePath = chromium.executablePath();
  } catch (error) {
    throw new HarnessError(`Playwright could not be loaded from the workspace install`, [
      `error    ${error.message}`,
    ]);
  }

  if (typeof executablePath !== 'string' || !existsSync(executablePath)) {
    throw new HarnessError('the Chromium binary Playwright needs is not installed', [
      `expected  ${executablePath ?? '(no path reported)'}`,
      'run       npm run setup',
    ]);
  }

  console.log(`  browser  ${executablePath}`);
}

/** Runs the Playwright suite, keeping its exit code. */
async function runPlaywright(env) {
  if (!existsSync(PLAYWRIGHT_BIN)) {
    throw new HarnessError('the Playwright CLI is not installed in this checkout', [
      `expected  ${relative(ROOT, PLAYWRIGHT_BIN)}`,
      'run       npm install at the repository root',
    ]);
  }

  console.log(`  command  ${formatCommand(relative(ROOT, PLAYWRIGHT_BIN), ['test'])}`);

  // Inherited output and no log tee: the runner reports Playwright's own output as it happens, and
  // the leak assertion is about the API's log, not this one's.
  const child = { label: 'playwright', proc: null, logPath: CLIENT_LOG, tail: [] };
  const proc = spawn(PLAYWRIGHT_BIN, ['test'], {
    ...processOptions({ cwd: ROOT, env, shell: IS_WINDOWS }),
    stdio: 'inherit',
  });

  child.proc = proc;
  live.add(child);

  let outcome;

  try {
    outcome = await new Promise((resolveOutcome, rejectOutcome) => {
      proc.once('error', rejectOutcome);
      proc.once('exit', (code, signal) => resolveOutcome({ code, signal }));
    });
  } catch (error) {
    throw new HarnessError('Playwright could not be started', [`error    ${error.message}`]);
  } finally {
    live.delete(child);
  }

  if (interruptedSignal !== null) {
    throw new HarnessError(`the run was interrupted by ${interruptedSignal}`, [
      `playwright  stopped on ${outcome.signal ?? `code ${outcome.code}`}`,
    ]);
  }

  if (outcome.code !== 0) {
    const ending =
      outcome.code === null ? `signal ${outcome.signal}` : `exit code ${outcome.code}`;

    throw new HarnessError(`Playwright failed (${ending})`, [
      `artifacts  ${relative(ROOT, E2E_DIR)} (traces and screenshots of failing specs)`,
    ]);
  }
}

/** Reads the captured API log and reports everything in it that may not be there. */
function assertServerLogClean() {
  if (!existsSync(SERVER_LOG)) {
    return {
      reason: 'the API log was never written, so the leak assertion could not run',
      details: [`expected  ${relative(ROOT, SERVER_LOG)}`],
    };
  }

  const text = readFileSync(SERVER_LOG, 'utf8');
  const hits = scanLogForLeaks(text, logScanNeedles());

  if (hits.length === 0) {
    console.log(
      `  clean    ${relative(ROOT, SERVER_LOG)} (${text.length} characters, ` +
        'no credential, no key shape, no base64 payload)',
    );
    return null;
  }

  return {
    reason: `${hits.length} banned string(s) in the captured API log`,
    details: hits.map(
      (hit) =>
        `hit      ${relative(ROOT, SERVER_LOG)}: ${hit.label} ` +
        `(${hit.occurrences}x) "${hit.excerpt}"`,
    ),
  };
}

/** Removes the run's temporary data directory, reporting rather than hiding a failure to remove. */
function removeTempDataDir(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `run-e2e: could not remove the temporary data directory ${path} (${error.message})`,
    );
  }
}

/**
 * The stage sequence. Every stage either returns or throws a `HarnessError`; the log assertion runs
 * whatever happened before it, so a failure in an earlier stage never hides a leak.
 */
async function main() {
  const problems = [];
  let tempDataDir = null;

  const ports = {
    port: envPort('PORT', '3001'),
    vitePort: envPort('VITE_PORT', '5173'),
  };

  const apiOrigin = `http://${HOST}:${ports.port}`;
  const clientOrigin = `http://localhost:${ports.vitePort}`;

  // Both capture files are emptied before the first stage can fail, so stage 8 always reads this
  // run's output: a build failure would otherwise leave a previous run's log in place for it.
  mkdirSync(E2E_DIR, { recursive: true });
  writeFileSync(SERVER_LOG, '');
  writeFileSync(CLIENT_LOG, '');

  console.log(
    [
      `run-e2e: ${ROOT}`,
      `  api      ${apiOrigin} (STUB_PROVIDER=1)`,
      `  client   ${clientOrigin} (proxying /api to ${apiOrigin})`,
      `  log      ${relative(ROOT, SERVER_LOG)}`,
      '',
    ].join('\n'),
  );

  try {
    console.log('run-e2e: stage 1/8 build shared');
    assertNotInterrupted();
    runWorkspaceBuild('@trade-read/shared', 'the shared package build');

    console.log('run-e2e: stage 1/8 build server');
    assertNotInterrupted();
    runWorkspaceBuild('@trade-read/server', 'the server build');

    console.log('run-e2e: stage 2/8 capture output');
    assertNotInterrupted();
    // Emptied in the preamble, before stage 1, so stage 8 can only ever read this run's output.
    console.log(
      `  logs     ${relative(ROOT, SERVER_LOG)}, ${relative(ROOT, CLIENT_LOG)} ` +
        '(emptied before stage 1)',
    );

    tempDataDir = mkdtempSync(join(tmpdir(), 'trade-read-e2e-'));

    console.log('run-e2e: stage 3/8 start the API');
    assertNotInterrupted();
    const api = startApi(tempDataDir, ports.port);

    console.log('run-e2e: stage 4/8 start the client');
    assertNotInterrupted();
    const client = startClient(apiOrigin, ports.vitePort);

    console.log('run-e2e: stage 5/8 wait for both to answer');
    await awaitService(api, `${apiOrigin}${HEALTH_PATH}`, () => {
      // A build that produced no entry point is the likeliest reason this child never starts, so it
      // is named rather than left to the reader of a MODULE_NOT_FOUND line.
      if (existsSync(SERVER_ENTRY)) {
        return [];
      }

      return [
        `missing  ${relative(ROOT, SERVER_ENTRY)} does not exist: ` +
          'the server build produced no entry point',
      ];
    });

    await awaitService(client, `${clientOrigin}/`);

    console.log('run-e2e: stage 6/8 check the Chromium binary');
    assertNotInterrupted();
    await checkChromiumBinary();

    console.log('run-e2e: stage 7/8 run Playwright');
    assertNotInterrupted();
    await runPlaywright({ ...process.env, VITE_PORT: ports.vitePort });
  } catch (error) {
    if (error instanceof HarnessError) {
      problems.push({ reason: error.message, details: error.details });
    } else {
      problems.push({
        reason: `the harness failed unexpectedly: ${error.message}`,
        details: [String(error.stack ?? '')],
      });
    }
  } finally {
    // Children first, so the captured log is complete before the assertion reads it.
    await stopAllChildren();

    if (tempDataDir !== null) {
      removeTempDataDir(tempDataDir);
    }
  }

  const interrupted = problems.some((problem) => /interrupted/.test(problem.reason));

  if (interruptedSignal !== null && !interrupted) {
    problems.push({
      reason: `the run was interrupted by ${interruptedSignal}, so it proved nothing`,
      details: [],
    });
  }

  console.log('run-e2e: stage 8/8 assert the API log carries no credential and no base64');
  const logProblem = assertServerLogClean();

  if (logProblem !== null) {
    problems.push(logProblem);
  }

  if (problems.length === 0) {
    console.log(
      '\nrun-e2e: PASS - build, readiness, Playwright and the log assertion all passed; ' +
        `captured log kept at ${relative(ROOT, SERVER_LOG)}`,
    );
    process.exitCode = 0;
    return;
  }

  console.error('\nrun-e2e FAILED');

  for (const problem of problems) {
    console.error(`  reason   ${problem.reason}`);

    for (const detail of problem.details) {
      console.error(`  ${detail}`);
    }
  }

  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interruptedSignal === null) {
      interruptedSignal = signal;
      console.error(`\nrun-e2e: ${signal} received, stopping the run`);
    }

    // The children live in their own process groups, so the terminal's signal does not reach them:
    // stop them here, and the stage that is waiting on one of them sees it exit and reports.
    for (const child of live) {
      requestStop(child);
    }
  });
}

// Last resort for an exit this script did not initiate: leave no process behind.
process.on('exit', () => {
  for (const child of live) {
    if (hasExited(child)) {
      continue;
    }

    forceKill(child);
  }
});

// The entry point, guarded so the exported poll and scan can be used without starting a run.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // A configuration error the stages never reached, such as a port that is not a port. It is
    // reported in the same shape as a stage failure, because it comes from the same script.
    console.error('\nrun-e2e FAILED');
    console.error(`  reason   ${error.message}`);

    const details = error instanceof HarnessError ? error.details : [String(error.stack ?? '')];

    for (const detail of details) {
      console.error(`  ${detail}`);
    }

    process.exitCode = 1;
  }
}
