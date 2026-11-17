#!/usr/bin/env node
/**
 * End-to-end harness: one run that builds the workspace, brings up a stub-configured API and the
 * client dev server, hands them to the Playwright suite, and then proves the API's own log carries
 * neither the model credential nor image bytes.
 *
 * `playwright.config.ts` deliberately declares no `webServer` block, so the process lifecycle is
 * owned here — a config-managed server would not be the stub-configured API this run requires:
 *
 *   1. create `.e2e/` and a temporary data directory beneath it, emptying the captured log first so
 *      a build that fails leaves no earlier run's output for the scan;
 *   2. build `shared`, then `server`, so the API runs compiled output;
 *   3. start the API: `node server/dist/index.js` with `STUB_PROVIDER=1` over that data directory,
 *      teeing its output into `.e2e/server.log`;
 *   4. start the client: the Vite dev server, proxying `/api` to the API origin this run uses;
 *   5. wait until `GET /api/v1/health` and the client root both answer, under one 60 s budget;
 *   6. confirm the Chromium binary Playwright needs is installed;
 *   7. run Playwright and keep its exit code;
 *   8. stop both children, then scan `.e2e/server.log` for the credential's variable name, its value
 *      shape and a base64 payload.
 *
 * The ports and the bind address come from the environment — `PORT`, `HOST` and `VITE_PORT` — so a
 * checkout that reserves its own port block runs entirely inside it; unset, they are the documented
 * defaults 3001, 127.0.0.1 and 5173, which are also the origin `playwright.config.ts` derives its
 * `baseURL` from. The run needs no credential and no network: `STUB_PROVIDER=1` selects the replay
 * adapter, and the credential variable is removed from the environment of every child this script
 * starts, so a stub run begins with no key and the API reports `providerConfigured: false`. Nothing
 * here reads, sets, prints or stores its value — the removal is by name, in whatever case the
 * environment spells it — and the name's only other appearance is the `CREDENTIAL_VARIABLE` constant
 * below, which the log scan uses as the log half of the secrecy requirement.
 *
 * Every failure path exits non-zero, so `npm run test:e2e` can never pass silently:
 *
 *   - `0` when both builds succeeded, Playwright passed and the captured log is clean;
 *   - `1` for a failed readiness wait, a missing browser binary, a missing Playwright install, an
 *     interrupted run, or a leak in the captured log;
 *   - the Playwright runner's own non-zero code when the suite failed;
 *   - a build's own non-zero code when that build failed, so a compiler verdict is never reported as
 *     something it was not.
 *
 * Nothing here imports a dependency: process handling, HTTP polling and the scan use
 * `node:child_process`, `node:fs`, `node:path`, `node:url` and the runtime's global `fetch`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// -------------------------------------------------------------------------------------------------
// Locations
// -------------------------------------------------------------------------------------------------

/**
 * Repository root, resolved from this file, so every child runs there whatever directory this script
 * was started in.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The configuration the runner is given explicitly, and the compiled API entry point. */
const PLAYWRIGHT_CONFIG = join(ROOT, 'playwright.config.ts');
const SERVER_ENTRY = join(ROOT, 'server', 'dist', 'index.js');

/** Artefacts. `.e2e/` is git-ignored, and the API log is kept after the run for inspection. */
const E2E_DIR = join(ROOT, '.e2e');
const SERVER_LOG = join(E2E_DIR, 'server.log');

/** `npm` is a shim only a shell can execute on Windows, so the command differs there. */
const IS_WINDOWS = process.platform === 'win32';
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm';

/** The runner CLI: the workspace bin, with the package's own entry as the fallback. */
const PLAYWRIGHT_BIN = join(
  ROOT,
  'node_modules',
  '.bin',
  IS_WINDOWS ? 'playwright.cmd' : 'playwright',
);
const PLAYWRIGHT_CLI = join(ROOT, 'node_modules', 'playwright', 'cli.js');

const SHARED_WORKSPACE = '@trade-read/shared';
const SERVER_WORKSPACE = '@trade-read/server';
const CLIENT_WORKSPACE = '@trade-read/client';

/** The route the API answers as soon as it is serving: its only readiness signal. */
const HEALTH_PATH = '/api/v1/health';

// -------------------------------------------------------------------------------------------------
// Bounds
//
// None of these is application configuration: they size the waits and the reports of this script.
// The analysis budget the suite observes is a constant in the shared package, not an environment
// variable this script could set, and `playwright.config.ts` already sizes its spec timeout past it.
// -------------------------------------------------------------------------------------------------

/** How long both services get to answer before the run is declared failed. */
const READY_TIMEOUT_MS = 60_000;

/** Gap between readiness probes. */
const READY_POLL_INTERVAL_MS = 250;

/** One probe's own cap, so a socket that never answers cannot consume the whole budget. */
const READY_REQUEST_TIMEOUT_MS = 2_000;

/** How long a child may take to stop on SIGTERM before its process group is killed outright. */
const STOP_GRACE_MS = 5_000;

/** Lines quoted from a child's captured output when a stage fails. */
const LOG_TAIL_LINES = 20;

// -------------------------------------------------------------------------------------------------
// What the captured API log may never contain
// -------------------------------------------------------------------------------------------------

/** The credential's variable name: a log line that names it is a leak even without its value. */
const CREDENTIAL_VARIABLE = 'OPENROUTER_API_KEY';

/**
 * The leading shape of a vendor key, assembled from its parts at run time so this file does not
 * itself carry the string a secret scanner searches for. The scan's subject is the shape, never a key.
 */
const CREDENTIAL_KEY_PREFIX = ['sk', 'or'].join('-') + '-';

/**
 * A payload: at least 256 characters of the base64 alphabet, optionally padded to a four-character
 * boundary. Ordinary log text cannot produce a run that long — its words are separated by spaces and
 * its fields by JSON punctuation — while base64 image bytes are thousands of such characters in a row.
 */
const BASE64_PAYLOAD = /(?:[A-Za-z0-9+/]{4}){64,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/;

/**
 * The three banned patterns, each with the label a finding carries.
 *
 * `find` returns the index of the first match, or `-1`, so one table both locates a finding in the
 * captured log and decides whether a single line has to be masked before it is quoted: a report may
 * name the label and the line number, never the text, because the match can be the credential itself.
 */
const LEAK_PATTERNS = [
  { label: 'credential-variable', find: (text) => text.indexOf(CREDENTIAL_VARIABLE) },
  { label: 'credential-value-shape', find: (text) => text.indexOf(CREDENTIAL_KEY_PREFIX) },
  {
    label: 'base64-payload',
    find: (text) => {
      const match = BASE64_PAYLOAD.exec(text);
      return match === null ? -1 : match.index;
    },
  },
];

// -------------------------------------------------------------------------------------------------
// Failures and environment
// -------------------------------------------------------------------------------------------------

/**
 * A stage that failed: the sentence an operator reads, the detail lines that explain it, and the
 * exit code the run must end with when the failure has one of its own — a build's code, for example.
 */
class HarnessError extends Error {
  constructor(reason, details = [], exitCode = null) {
    super(reason);
    this.name = 'HarnessError';
    this.details = details;
    this.exitCode = exitCode;
  }
}

/** Reads an environment value, treating an unset or blank one as absent. */
function envValue(name, fallback) {
  const value = process.env[name];

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Reads a TCP port from the environment. A value that is not a real port stops the run here, because
 * a child asked to bind it would fail later with a message about something else entirely.
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

/**
 * The environment a child is started with: this process's own, with the model credential removed.
 *
 * A stub run must begin with no credential. `providerConfigured` is derived from the credential alone
 * and not from `STUB_PROVIDER`, so a key exported in the operator's shell would otherwise reach the
 * API child, have a replay run log `providerConfigured: true`, and repeat that to the client from
 * health. No child needs it: `STUB_PROVIDER=1` replays recorded answers and nothing this script starts
 * reaches the provider. The removal is by name, in whatever case the environment spells it, so nothing
 * here reads, prints, logs or stores the key's value; everything else — `PATH`, `HOME`, `TMPDIR`, the
 * npm variables — is still inherited, with the caller's own values spread on top.
 */
function credentialFreeEnvironment(extras = {}) {
  const inherited = { ...process.env };

  for (const name of Object.keys(inherited)) {
    if (name.toUpperCase() === CREDENTIAL_VARIABLE) {
      delete inherited[name];
    }
  }

  return { ...inherited, ...extras };
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function delay(ms) {
  // Referenced deliberately: the timer is what keeps the process alive between two probes.
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

// -------------------------------------------------------------------------------------------------
// Children
//
// Both long-lived processes are spawned detached on POSIX, so each leads its own process group and
// one signal reaches npm *and* the Vite or Node grandchild it started. Signalling npm's pid alone
// would leave that grandchild running and holding its port.
// -------------------------------------------------------------------------------------------------

/** Live children, so a teardown signals exactly the processes still running. */
const live = new Set();

/** Set while this script stops its own children, so their exits are not reported as crashes. */
let stopping = false;

/** The signal that interrupted the run, if one did. */
let interruptedSignal = null;

function spawnOptions({ env = credentialFreeEnvironment(), shell = false } = {}) {
  return {
    cwd: ROOT,
    env,
    shell,
    // Its own process group on POSIX, so a stop reaches npm and everything npm started.
    detached: !IS_WINDOWS,
  };
}

/** Signals a child's whole process group: the group id is the pid, because the child is detached. */
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
    // npm and Vite both run through a shell on Windows, so kill the tree rather than the shim. This
    // child gets the credential-free environment too, so no child this script starts carries the key.
    spawnSync('taskkill', ['/pid', String(child.proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      env: credentialFreeEnvironment(),
    });
    return;
  }

  signalGroup(child, 'SIGKILL');
}

function requestStop(child) {
  signalGroup(child, 'SIGTERM');
}

function hasExited(child) {
  const { proc } = child;

  return typeof proc.pid !== 'number' || proc.exitCode !== null || proc.signalCode !== null;
}

/** How a child ended, or `null` while it is still running. */
function describeExit(child) {
  if (child.spawnError !== null) {
    return `it could not be started (${child.spawnError})`;
  }

  if (child.exit === null) {
    return null;
  }

  const { code, signal } = child.exit;

  return code === null ? `signal ${signal}` : `code ${code}`;
}

/** Appends a tail line, keeping the buffer bounded. */
function pushTail(child, line) {
  child.tail.push(line);

  if (child.tail.length > LOG_TAIL_LINES) {
    child.tail.shift();
  }
}

/**
 * Echoes a child's output to this process's console with the child's label, so the interleaved output
 * of two servers stays readable and the API's captured log file remains its own output alone.
 */
function createPrefixedEcho(label) {
  let pending = '';

  return {
    write(chunk) {
      pending += chunk;

      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        process.stdout.write(`[${label}] ${line}\n`);
      }
    },
    flush() {
      if (pending !== '') {
        process.stdout.write(`[${label}] ${pending}\n`);
        pending = '';
      }
    },
  };
}

/**
 * Captures one child stream three ways: verbatim into the child's log file, which stage 8 scans and
 * reads back as bytes the child actually wrote; prefixed onto the console; and into the bounded tail
 * a failed stage quotes. Nothing here filters a chunk, because a log that had been transformed could
 * not prove anything about what the server logged.
 */
function captureStream(stream, child, echo) {
  let tailPending = '';

  stream.setEncoding('utf8');

  stream.on('data', (chunk) => {
    if (child.log !== null) {
      child.log.write(chunk);
    }

    echo.write(chunk);

    tailPending += chunk;

    const lines = tailPending.split('\n');
    tailPending = lines.pop() ?? '';

    for (const line of lines) {
      pushTail(child, line);
    }
  });

  stream.on('end', () => {
    if (tailPending !== '') {
      pushTail(child, tailPending);
    }

    echo.flush();
  });

  stream.on('error', (error) => {
    pushTail(child, `(its output could not be read: ${error.message})`);
  });
}

/**
 * Starts a child whose output is captured. Returns the record the readiness wait, the teardown and
 * the failure reports all read.
 */
function startChild({ label, command, args, env = credentialFreeEnvironment(), prefix, log = null }) {
  const child = {
    label,
    log,
    tail: [],
    closed: false,
    exit: null,
    spawnError: null,
  };

  const shell = IS_WINDOWS && command === NPM_COMMAND;
  const proc = spawn(command, args, {
    ...spawnOptions({ env, shell }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.proc = proc;
  live.add(child);

  // A child that never started emits 'error' and may emit no 'exit' at all, so the readiness wait
  // reads the failure from here rather than waiting out its whole budget.
  proc.once('error', (error) => {
    child.spawnError = error.message;
    pushTail(child, `failed to start: ${error.message}`);
  });

  proc.once('exit', (code, signal) => {
    child.exit = { code, signal };

    if (!stopping) {
      console.error(`run-e2e: ${label} exited on its own (code ${code}, signal ${signal})`);
    }
  });

  // 'close' follows 'exit' once the output streams are drained. A teardown waits for it, because
  // stopping a child and reading its log before the last chunk arrives would let a leak escape.
  proc.once('close', () => {
    child.closed = true;
  });

  const echo = createPrefixedEcho(prefix);

  for (const stream of [proc.stdout, proc.stderr]) {
    if (stream !== null) {
      captureStream(stream, child, echo);
    }
  }

  return child;
}

/** A child that has ended before it answered, described for a failure report. */
function firstEndedChild() {
  for (const child of live) {
    const outcome = describeExit(child);

    if (outcome !== null) {
      return `${child.label} ended before answering (${outcome})`;
    }
  }

  return null;
}

/** The last lines a child wrote, with every line a banned pattern matches masked. */
function describeTail(child) {
  const details = [`${child.label} output (last ${String(child.tail.length)} line(s))`];

  if (child.tail.length === 0) {
    details.push('  (it produced no output)');
    return details;
  }

  for (const line of child.tail) {
    details.push(`  ${redactLine(line)}`);
  }

  return details;
}

/**
 * Runs one workspace build to completion, inheriting its output so a compiler error stays where it is
 * actionable. A non-zero exit carries the build's own code, so the harness reports the compiler's
 * verdict rather than a generic failure.
 */
function runBuild(workspace, meaning) {
  const args = ['run', 'build', '--workspace', workspace];

  console.log(`run-e2e: building ${workspace}`);

  return new Promise((resolveBuild, rejectBuild) => {
    const proc = spawn(NPM_COMMAND, args, { ...spawnOptions(), stdio: 'inherit' });

    proc.once('error', (error) => {
      rejectBuild(
        new HarnessError(`${meaning} could not be started`, [
          `command  ${formatCommand(NPM_COMMAND, args)}`,
          `error    ${error.message}`,
        ]),
      );
    });

    proc.once('exit', (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }

      const exitCode = typeof code === 'number' && code > 0 ? code : 1;
      const outcome = code === null ? `signal ${signal}` : `exit code ${code}`;

      rejectBuild(
        new HarnessError(
          `${meaning} failed (${outcome})`,
          [`command  ${formatCommand(NPM_COMMAND, args)}`],
          exitCode,
        ),
      );
    });
  });
}

/**
 * Polls a URL until `validate` accepts an answer, until the deadline, or until a child that must
 * serve it has ended. Each probe is capped on its own, and its body is drained so the connection is
 * released instead of being left for the server to time out.
 *
 * A child that ended is the whole story of a wait that will never succeed, so it is reported at once
 * rather than after the whole budget, with the output it produced — redacted — as the detail. The
 * `60s` in the timeout message is the budget itself, not a measurement of how long anything took.
 */
async function waitFor(label, url, validate, details = () => []) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastOutcome = 'no probe completed';

  while (Date.now() < deadline) {
    if (interruptedSignal !== null) {
      throw new HarnessError(
        `the run was interrupted by ${interruptedSignal}, so it proved nothing`,
        details(),
      );
    }

    const ended = firstEndedChild();

    if (ended !== null) {
      throw new HarnessError(`the ${label} did not answer ${url}: ${ended}`, details());
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) });

      if (await validate(response)) {
        console.log(`run-e2e: ${label} ready at ${url}`);
        return;
      }

      lastOutcome = `the last response was HTTP ${String(response.status)}`;
    } catch (error) {
      lastOutcome = `the last probe failed (${error.message})`;
    }

    await delay(READY_POLL_INTERVAL_MS);
  }

  throw new HarnessError(
    `the ${label} did not answer ${url} within ${String(READY_TIMEOUT_MS / 1_000)}s ` +
      `(${lastOutcome})`,
    details(),
  );
}

// -------------------------------------------------------------------------------------------------
// The captured log and its scan
// -------------------------------------------------------------------------------------------------

/** The 1-based line number of a character index, so a finding names where an operator should look. */
function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Every banned pattern present in the captured log, reported as a label and a line number. The
 * matched text is deliberately never returned: a finding about a credential must not reprint it.
 */
function scanLog(text) {
  const findings = [];

  for (const { label, find } of LEAK_PATTERNS) {
    const index = find(text);

    if (index !== -1) {
      findings.push({ label, line: lineNumberAt(text, index) });
    }
  }

  return findings;
}

/** A log line as it may be quoted: replaced by its label when any banned pattern matches it. */
function redactLine(line) {
  for (const { label, find } of LEAK_PATTERNS) {
    if (find(line) !== -1) {
      return `[redacted: ${label}]`;
    }
  }

  return line;
}

/** Closes the captured log stream and resolves once its last byte is on disk. */
function closeServerLog(log) {
  return new Promise((resolveClose) => {
    if (log === null || log.closed) {
      resolveClose();
      return;
    }

    log.once('close', resolveClose);
    log.once('error', resolveClose);
    log.end();
  });
}

/**
 * Reads the captured API log and reports what may not be in it. A missing or unreadable file fails the
 * assertion rather than passing it: an assertion that ran on nothing proves nothing.
 */
function inspectServerLog() {
  if (!existsSync(SERVER_LOG)) {
    return {
      clean: false,
      findings: [],
      details: [`the captured log is missing: ${relative(ROOT, SERVER_LOG)}`],
    };
  }

  let text;

  try {
    text = readFileSync(SERVER_LOG, 'utf8');
  } catch (error) {
    return {
      clean: false,
      findings: [],
      details: [`the captured log could not be read (${error.message})`],
    };
  }

  return { clean: true, findings: scanLog(text), details: [], characters: text.length };
}

// -------------------------------------------------------------------------------------------------
// Stages
// -------------------------------------------------------------------------------------------------

/**
 * Clears the captured log and creates the temporary data directory this run's API writes to.
 *
 * The log is opened with `w` before any stage can fail, so a run that dies early can never leave an
 * earlier run's log in place for stage 8 to scan. Its stream is the only writer: handing the API child
 * the same path would open a second descriptor on the file and truncate it mid-run.
 */
function prepareArtefacts() {
  mkdirSync(E2E_DIR, { recursive: true });

  const log = createWriteStream(SERVER_LOG, { flags: 'w' });
  const dataDir = join(E2E_DIR, `data-${String(process.pid)}-${String(Date.now())}`);

  mkdirSync(dataDir, { recursive: true });

  return { log, dataDir };
}

/** Fails with the path named when a file the run depends on is absent. */
function requireFile(path, meaning) {
  if (existsSync(path)) {
    return;
  }

  throw new HarnessError(`${meaning} is missing: ${relative(ROOT, path)}`, [
    'run      npm run build',
  ]);
}

/**
 * Starts the API on this run's data directory with the replay provider selected. The child's
 * environment is this process's own with the credential variable removed, plus the five values below:
 * no credential is set, read or forwarded here, and no `.env` file is loaded, because a stub run must
 * never acquire a real key.
 */
function startApi({ log, dataDir, port }) {
  return startChild({
    label: 'api',
    prefix: 'api',
    command: process.execPath,
    args: [relative(ROOT, SERVER_ENTRY)],
    env: credentialFreeEnvironment({
      STUB_PROVIDER: '1',
      DATA_DIR: dataDir,
      PORT: port,
      HOST: envValue('HOST', '127.0.0.1'),
      NODE_ENV: 'test',
    }),
    log,
  });
}

/** Starts the client dev server on this run's port, proxying `/api` to this run's API origin. */
function startClient({ port, apiOrigin }) {
  return startChild({
    label: 'client',
    prefix: 'web',
    command: NPM_COMMAND,
    args: ['run', 'dev', '--workspace', CLIENT_WORKSPACE],
    env: credentialFreeEnvironment({ VITE_PORT: port, VITE_API_TARGET: apiOrigin }),
  });
}

/**
 * Confirms the browser binary Playwright needs is on disk. Its absence is the one precondition this
 * script cannot satisfy itself, so it stops with the command that installs it and never downloads.
 */
async function requireChromium() {
  const missing =
    "Playwright's Chromium binary is not installed. Run `npm run setup` (installs Chromium) and " +
    're-run `npm run test:e2e`.';

  let executablePath;

  try {
    const { chromium } = await import('playwright');

    executablePath = chromium.executablePath();
  } catch (error) {
    throw new HarnessError(missing, [`error    Playwright could not be loaded (${error.message})`]);
  }

  if (typeof executablePath !== 'string' || !existsSync(executablePath)) {
    throw new HarnessError(missing, [
      `expected  ${typeof executablePath === 'string' ? executablePath : '(no path reported)'}`,
    ]);
  }

  console.log(`run-e2e: chromium ${executablePath}`);
}

/**
 * Runs the Playwright suite against the servers this run started and resolves with its exit code and
 * signal. The configuration is named explicitly rather than discovered, so the run reads the file this
 * repository documents, and `VITE_PORT` is passed through so the config derives the `baseURL` the dev
 * server actually answers on.
 */
async function runPlaywright(vitePort) {
  let command = PLAYWRIGHT_BIN;
  let args = [];
  let shell = IS_WINDOWS;

  if (!existsSync(PLAYWRIGHT_BIN)) {
    if (!existsSync(PLAYWRIGHT_CLI)) {
      throw new HarnessError('Playwright is not installed; run `npm install`', [
        `expected  ${relative(ROOT, PLAYWRIGHT_BIN)} or ${relative(ROOT, PLAYWRIGHT_CLI)}`,
      ]);
    }

    command = process.execPath;
    args = [PLAYWRIGHT_CLI];
    shell = false;
  }

  const configArg = relative(ROOT, PLAYWRIGHT_CONFIG);
  const runnerArgs = ['test', '--config', configArg];
  const runArgs = [...args, ...runnerArgs];
  const shown =
    command === process.execPath
      ? formatCommand('node', [relative(ROOT, PLAYWRIGHT_CLI), ...runnerArgs])
      : formatCommand(relative(ROOT, command), runnerArgs);

  console.log(`run-e2e: ${shown}`);

  const proc = spawn(command, runArgs, {
    cwd: ROOT,
    env: credentialFreeEnvironment({ VITE_PORT: vitePort }),
    shell,
    // Not detached: the runner belongs to this process's own group, so an interrupt reaches it too.
    detached: false,
    // Inherited: the runner's own output is the report of a failing spec, and the leak assertion is
    // about the API's captured log, not this stream.
    stdio: 'inherit',
  });

  return new Promise((resolveRun, rejectRun) => {
    proc.once('error', (error) => {
      rejectRun(new HarnessError('Playwright could not be started', [`error    ${error.message}`]));
    });

    proc.once('exit', (code, signal) => {
      resolveRun({ code, signal });
    });
  });
}

/**
 * Stops every live child: SIGTERM to its process group, then SIGKILL once the grace period is spent,
 * and the returned promise settles when the process ended and its output streams closed. Idempotent,
 * so a teardown can call it again on a path that already stopped a child.
 */
async function stopAllChildren() {
  const stoppingChildren = [...live];

  live.clear();
  stopping = true;

  await Promise.all(
    stoppingChildren.map(
      (child) =>
        new Promise((resolveStop) => {
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

          // A process group that survives even SIGKILL must not hold the run: stop waiting shortly
          // after the kill rather than for an end that may never arrive.
          const giveUpTimer = setTimeout(settle, STOP_GRACE_MS + 5_000);

          child.proc.once('close', settle);

          if (!hasExited(child)) {
            requestStop(child);
          }
        }),
    ),
  );
}

/** Removes the run's temporary data directory, reporting rather than hiding a removal failure. */
function removeDataDir(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.error(`run-e2e: could not remove ${relative(ROOT, path)} (${error.message})`);
  }
}

// -------------------------------------------------------------------------------------------------
// The run
// -------------------------------------------------------------------------------------------------

/** Normalises anything thrown by a stage into a reportable problem. */
function toProblem(error) {
  if (error instanceof HarnessError) {
    return { reason: error.message, details: error.details, exitCode: error.exitCode };
  }

  return {
    reason: `the harness failed unexpectedly (${error.message})`,
    details: [String(error.stack ?? '')],
    exitCode: null,
  };
}

/**
 * The stage sequence. A stage either returns or throws, and whatever happened, the teardown runs, the
 * log is scanned and the exit code is chosen from the facts rather than from how far the run got.
 */
async function main() {
  const problems = [];
  const ports = { api: envPort('PORT', '3001'), vite: envPort('VITE_PORT', '5173') };
  const apiOrigin = `http://${envValue('HOST', '127.0.0.1')}:${ports.api}`;
  const clientOrigin = `http://localhost:${ports.vite}`;

  requireFile(PLAYWRIGHT_CONFIG, 'the Playwright configuration');

  const { log, dataDir } = prepareArtefacts();

  console.log(
    [
      `run-e2e: ${ROOT}`,
      `  api      ${apiOrigin} (STUB_PROVIDER=1)`,
      `  client   ${clientOrigin} (proxying /api to ${apiOrigin})`,
      `  log      ${relative(ROOT, SERVER_LOG)}`,
      `  data     ${relative(ROOT, dataDir)}`,
    ].join('\n'),
  );

  console.log('run-e2e: stage 1/8 preparing the artefacts');

  const runningTails = () => [...live].flatMap((child) => describeTail(child));

  let playwrightCode = null;

  try {
    console.log('run-e2e: stage 2/8 building shared, then server');
    await runBuild(SHARED_WORKSPACE, 'shared build');
    await runBuild(SERVER_WORKSPACE, 'server build');

    // A build that exits 0 without emitting the entry point would otherwise surface as a child that
    // died on MODULE_NOT_FOUND, so the artefact is checked where it is produced.
    requireFile(SERVER_ENTRY, 'the compiled API entry point');

    console.log('run-e2e: stage 3/8 starting the API');
    startApi({ log, dataDir, port: ports.api });

    console.log('run-e2e: stage 4/8 starting the client');
    startClient({ port: ports.vite, apiOrigin });

    console.log('run-e2e: stage 5/8 waiting for both to answer');

    await waitFor(
      'API',
      `${apiOrigin}${HEALTH_PATH}`,
      async (response) => {
        if (!response.ok) {
          await response.text();
          return false;
        }

        const body = await response.json();

        return body?.status === 'ok';
      },
      runningTails,
    );

    await waitFor(
      'client',
      `${clientOrigin}/`,
      async (response) => {
        await response.text();

        return response.ok;
      },
      runningTails,
    );

    console.log('run-e2e: stage 6/8 checking the Playwright Chromium binary');
    await requireChromium();

    console.log('run-e2e: stage 7/8 running Playwright');
    const outcome = await runPlaywright(ports.vite);

    playwrightCode = outcome.code === null ? 1 : outcome.code;

    if (playwrightCode !== 0) {
      const ending =
        outcome.code === null ? `signal ${outcome.signal}` : `exit code ${String(outcome.code)}`;

      problems.push({
        reason: `Playwright failed (${ending})`,
        details: [`artefacts  ${relative(ROOT, join(E2E_DIR, 'test-results'))}`],
        exitCode: null,
      });
    }
  } catch (error) {
    problems.push(toProblem(error));
  } finally {
    // The children first, so the captured log is complete before the scan reads it.
    await stopAllChildren();
    await closeServerLog(log);
    removeDataDir(dataDir);
  }

  if (interruptedSignal !== null) {
    problems.push({
      reason: `the run was interrupted by ${interruptedSignal}, so it proved nothing`,
      details: [],
      exitCode: null,
    });
  }

  console.log('run-e2e: stage 8/8 scanning the captured API log');
  const inspection = inspectServerLog();

  for (const finding of inspection.findings) {
    // Label and line number only: the matched text may be the credential or image bytes.
    console.error(
      `run-e2e: server.log contains ${finding.label} at line ${String(finding.line)}`,
    );
  }

  const logClean = inspection.clean && inspection.findings.length === 0;

  if (!inspection.clean) {
    problems.push({
      reason: 'the leak assertion could not run on the captured API log',
      details: inspection.details,
      exitCode: null,
    });
  } else if (inspection.findings.length > 0) {
    problems.push({
      reason:
        `the captured API log carries ${String(inspection.findings.length)} banned pattern(s)` +
        ` (${relative(ROOT, SERVER_LOG)})`,
      details: [],
      exitCode: null,
    });
  } else {
    console.log(
      `run-e2e: server.log is clean (${String(inspection.characters)} characters: no credential` +
        ' variable, no key shape, no base64 payload)',
    );
  }

  let playwrightResult = 'did not run';

  if (playwrightCode === 0) {
    playwrightResult = 'passed';
  } else if (playwrightCode !== null) {
    playwrightResult = `failed (exit code ${String(playwrightCode)})`;
  }

  const scanResult = logClean ? 'clean' : 'failed';

  if (problems.length === 0) {
    console.log(
      '\nrun-e2e: PASS - build, readiness, Playwright and the log scan all passed ' +
        `(Playwright ${playwrightResult}, log scan ${scanResult}); ` +
        `captured log kept at ${relative(ROOT, SERVER_LOG)}`,
    );
    process.exitCode = 0;
    return;
  }

  // A build's own code wins, because a compiler verdict is the specific thing that went wrong; then
  // the runner's code, so a failing spec is reported as the failure it is; otherwise 1.
  const buildFailure = problems.find((problem) => problem.exitCode !== null);

  process.exitCode =
    buildFailure?.exitCode ?? (playwrightCode !== null && playwrightCode !== 0 ? playwrightCode : 1);

  console.error('\nrun-e2e FAILED');

  for (const problem of problems) {
    console.error(`run-e2e: ${problem.reason}`);

    for (const detail of problem.details) {
      console.error(`  ${redactLine(detail)}`);
    }
  }

  console.error(`run-e2e: Playwright ${playwrightResult}, log scan ${scanResult}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interruptedSignal === null) {
      interruptedSignal = signal;
      console.error(`\nrun-e2e: ${signal} received, stopping the run`);
    }

    // The children lead their own process groups, so the terminal's signal does not reach them:
    // stop them here, and the stage waiting on one of them sees it end and reports.
    for (const child of live) {
      requestStop(child);
    }
  });
}

// Last resort for an exit this script did not initiate: leave no process behind.
process.on('exit', () => {
  for (const child of live) {
    if (!hasExited(child)) {
      forceKill(child);
    }
  }
});

// The entry point, guarded so the module can be imported without starting a run.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    const problem = toProblem(error);

    console.error('\nrun-e2e FAILED');
    console.error(`run-e2e: ${problem.reason}`);

    for (const detail of problem.details) {
      console.error(`  ${redactLine(detail)}`);
    }

    process.exitCode = problem.exitCode ?? 1;
  }
}
