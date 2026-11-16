#!/usr/bin/env node

/**
 * Development orchestrator: the server's TypeScript compiler in watch mode and the client's Vite
 * dev server, started together and stopped together by one interrupt.
 *
 * The API process itself is not started here — only the compiler that produces it. The banner
 * prints the command that runs it.
 *
 * On POSIX each child leads its own process group, so one signal reaches npm *and* the `tsc` or
 * `vite` grandchild it spawns; signalling npm's pid alone leaves that grandchild running.
 *
 * This is the in-house replacement for a process-orchestrator dependency, so it imports only Node
 * built-ins.
 */

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Repository root, so every child runs there whatever directory the script was invoked from. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IS_WINDOWS = process.platform === 'win32';
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm';

/** How long a child may take to stop on SIGTERM before its process group is killed outright. */
const STOP_GRACE_MS = 5_000;

const SERVER_WORKSPACE = '@trade-read/server';

const PROCESSES = [
  {
    label: 'server',
    meaning: 'TypeScript compiler, watch mode',
    args: ['run', 'build:watch', '--workspace', SERVER_WORKSPACE],
  },
  {
    label: 'client',
    meaning: 'Vite dev server',
    args: ['run', 'dev', '--workspace', '@trade-read/client'],
  },
];

// The announced URLs come from the environment the children inherit (HOST and PORT for the API,
// VITE_PORT and VITE_API_TARGET for the client), so a checkout running on non-default ports prints
// the ports it will actually use. Unset, they are the documented defaults.

function envValue(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

const API_ORIGIN = `http://${envValue('HOST', '127.0.0.1')}:${envValue('PORT', '3001')}`;
const CLIENT_ORIGIN = `http://localhost:${envValue('VITE_PORT', '5173')}`;
const API_PROXY_TARGET = envValue('VITE_API_TARGET', API_ORIGIN);

/** Live children, so a shutdown signals exactly the processes still running. */
const live = new Set();

let shuttingDown = false;

function formatCommand(args) {
  return [NPM_COMMAND, ...args].join(' ');
}

function printBanner() {
  const lines = [`dev: ${ROOT}`, ''];

  for (const definition of PROCESSES) {
    const command = formatCommand(definition.args);
    lines.push(`  ${definition.label.padEnd(7)} ${command}   (${definition.meaning})`);
  }

  lines.push(
    '',
    `  client  ${CLIENT_ORIGIN} (/api proxied to ${API_PROXY_TARGET})`,
    `  api     ${API_ORIGIN} (start with: npm run start --workspace ${SERVER_WORKSPACE})`,
    '',
    '  Ctrl-C stops both',
  );

  console.log(lines.join('\n'));
}

/**
 * Signals a child's whole process group. The group id equals the child's pid because the child is
 * spawned detached on POSIX, which is also what makes `-pid` address npm and its grandchild.
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
      console.error(`${child.label}: could not send ${signal} (${error.message})`);
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

/**
 * Stops every live child and exits with `code`. Idempotent: the first caller decides the exit code,
 * and the exits its own signals provoke are ignored by the child 'exit' listeners.
 */
function shutdown(code, reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  // Set before anything else, so the code survives even an exit this script does not reach.
  process.exitCode = code;

  console.error(reason);

  const stopping = [...live];
  live.clear();

  if (stopping.length === 0) {
    process.exit(code);
    return;
  }

  let outstanding = stopping.length;
  const settled = () => {
    outstanding -= 1;
    if (outstanding === 0) {
      // One tick of grace, so a sibling's queued spawn 'error' still gets printed first.
      setImmediate(() => process.exit(code));
    }
  };

  for (const child of stopping) {
    // A child that never spawned has no pid and will emit no 'exit'; a child that already exited
    // needs nothing more. Only a running child is signalled and waited for.
    if (
      typeof child.proc.pid !== 'number' ||
      child.proc.exitCode !== null ||
      child.proc.signalCode !== null
    ) {
      settled();
      continue;
    }

    child.proc.once('exit', settled);
    requestStop(child);
  }

  // A child that ignores SIGTERM must not hold the operator's terminal: kill the group once the
  // grace period is spent. Unreferenced, so a clean stop is never delayed by this timer.
  const deadline = setTimeout(() => {
    for (const child of stopping) {
      forceKill(child);
    }
    process.exit(code);
  }, STOP_GRACE_MS);
  deadline.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // A deliberate interrupt is a clean stop, so it exits 0; a non-zero code is reserved for a
    // child that died on its own.
    shutdown(0, '\nstopping dev servers');
  });
}

// Last resort for an exit this script did not initiate: leave no process behind.
process.on('exit', () => {
  for (const child of live) {
    if (
      typeof child.proc.pid !== 'number' ||
      child.proc.exitCode !== null ||
      child.proc.signalCode !== null
    ) {
      continue;
    }
    forceKill(child);
  }
});

function start() {
  printBanner();

  for (const definition of PROCESSES) {
    const options = {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    };

    if (IS_WINDOWS) {
      // npm is a .cmd shim on Windows, which only resolves through the shell.
      options.shell = true;
    } else {
      options.detached = true;
    }

    const proc = spawn(NPM_COMMAND, definition.args, options);
    const child = { label: definition.label, proc };
    live.add(child);

    // A child that never started emits 'error' and may emit no 'exit' at all.
    proc.on('error', (error) => {
      live.delete(child);
      console.error(`${definition.label}: failed to start (${error.message})`);
      shutdown(1, `${definition.label} could not be started`);
    });

    proc.on('exit', (code, signal) => {
      live.delete(child);

      if (shuttingDown) {
        return;
      }

      // An unexpected exit is a failure even when the child chose code 0: the operator was left
      // without a process this script promised to keep running.
      const exitCode = code === 0 || code === null ? 1 : code;
      const summary = `${definition.label} exited unexpectedly (code ${code}, signal ${signal})`;
      shutdown(exitCode, summary);
    });
  }
}

start();
