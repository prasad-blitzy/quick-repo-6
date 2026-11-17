#!/usr/bin/env node
/**
 * verify-client-bundle — the static half of the proof that nothing a browser must never see
 * reaches it.
 *
 * The gate builds the client, reads every byte the build produced, and fails when the bundle
 * carries any of three things:
 *
 *   - the model credential: neither the name of the variable that holds it nor the leading shape of
 *     its value may appear in a browser artefact;
 *   - a model provider hostname: the server has exactly one gateway and the client reaches it through
 *     its own same-origin proxy prefix, so a vendor host in the bundle would be a second egress path;
 *   - a phrase from either built-in instruction text: both texts live only in the server's prompt
 *     modules, and a copy inside the bundle would hand the instruction to anyone who opens it.
 *
 * The prompt phrases are derived from those two modules on every run rather than repeated here. A
 * second copy of the text in this script would be a second source of truth that nothing keeps in
 * step with the first, and a stale copy would report a clean scan while the text it exists to
 * protect had already changed. For the same reason a module that cannot be read, or that yields no
 * usable phrase, fails the gate: a scan whose needle set came out empty would pass, and passing on
 * nothing is the one outcome a leak gate must never produce.
 *
 * The script reads no environment file and prints no matched value — only the file, the pattern's
 * label and a fixed description of the pattern — so a gate run can neither write the credential into
 * a build log nor confirm a candidate key to whoever reads that log.
 *
 * Usage:
 *   node scripts/verify-client-bundle.mjs                 build the client, then scan client/dist
 *   node scripts/verify-client-bundle.mjs --skip-build    scan the client/dist already on disk
 *
 * The second form serves a caller that has just built the client itself; it scans whatever is on
 * disk and therefore trusts that build. The first form is what `npm run verify:bundle` runs.
 *
 * Exit codes: 0 for a clean bundle; 1 for a matched pattern, for a phrase that could not be derived,
 * or for a bundle that is missing or empty; otherwise the client build's own non-zero code, so a
 * failed build can never be read as a clean scan.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file, so the gate runs from whatever directory it started in. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The client package, and the directory its build writes: the only artefact this gate reads. */
const CLIENT_DIR = join(ROOT, 'client');
const DIST_DIR = join(CLIENT_DIR, 'dist');

/** The prompt modules that hold the only copies of the two instruction texts. */
const PROMPT_DIR = join(ROOT, 'server', 'src', 'adapters', 'prompts');

/**
 * Each instruction text with the label its findings carry. The gate reads these modules and never
 * imports them: it needs their text, not their behaviour, and reading them keeps the scan runnable
 * before the server has been built.
 */
const PROMPT_MODULES = [
  { source: 'extraction', path: join(PROMPT_DIR, 'extraction-prompt.ts') },
  { source: 'synthesis', path: join(PROMPT_DIR, 'synthesis-prompt.ts') },
];

const IS_WINDOWS = process.platform === 'win32';

/** `npm.cmd` is the executable on Windows; a bare `npm` there is a shell script the call cannot run. */
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm';

/** The client build exactly as the workspace declares it, so the gate builds what an operator builds. */
const CLIENT_BUILD_ARGS = ['run', 'build', '--workspace', '@trade-read/client'];

const USAGE = 'usage: node scripts/verify-client-bundle.mjs [--skip-build]';

/** The credential's variable name. Its presence in a bundle means the browser can name the secret. */
const CREDENTIAL_VARIABLE = 'OPENROUTER_API_KEY';

/**
 * The leading shape of a model provider key, assembled from its parts at run time so this file does
 * not itself carry the string a secret scanner searches for. The gate's subject is the shape of a
 * key, never a key, and a committed file must not look like the thing it forbids.
 */
const CREDENTIAL_KEY_PREFIX = ['sk', 'or'].join('-') + '-';

/**
 * Hostnames the bundle may not contain. The first is the single gateway the server uses — the client
 * reaches it only through its own same-origin proxy prefix, never by name — and the rest are the
 * vendors a second egress path would introduce. `generativelanguage.googleapis.com` is listed ahead
 * of the `googleapis.com` it ends in, so the specific host is reported before its suffix.
 */
const PROVIDER_HOSTS = [
  'openrouter.ai',
  'openai.com',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'googleapis.com',
  'amazonaws.com',
  'bedrock',
  'azure.com',
  'cohere.ai',
  'mistral.ai',
  'groq.com',
];

/**
 * The current-price token every extraction answer must carry. It is the one fixed token of the
 * extraction instruction that can be asserted without restating any of that text: if it appears in
 * the bundle, some part of the extraction instruction reached the browser.
 */
const PROMPT_TOKEN = 'LAST=';

/**
 * The constant patterns, each with the stable label its findings carry and a description fit to
 * print. No description repeats a matched value, so a report never becomes the leak it reports.
 */
const STATIC_PATTERNS = [
  {
    label: 'credential-variable',
    pattern: CREDENTIAL_VARIABLE,
    description: 'the model credential variable name',
  },
  {
    label: 'credential-value-shape',
    pattern: CREDENTIAL_KEY_PREFIX,
    description: 'the leading shape of a model provider key',
  },
  ...PROVIDER_HOSTS.map((host) => ({
    label: 'provider-host',
    pattern: host,
    description: `a model provider hostname (${host})`,
  })),
  {
    label: 'prompt-token',
    pattern: PROMPT_TOKEN,
    description: 'the current-price token the extraction instruction requires',
  },
];

/**
 * Shortest phrase this gate accepts as a prompt needle. Ordinary prose eight characters long could
 * occur in any bundle by accident, and a coincidental match would fail a clean build; a phrase this
 * long belongs to the instruction text and to nothing else in a client bundle.
 */
const MIN_PHRASE_LENGTH = 48;

/** Characters of a phrase the scan looks for: long enough to be distinctive, short enough to match. */
const PHRASE_NEEDLE_LENGTH = 48;

/** Phrases kept per module: the longest are the most distinctive, and twenty of them cover the text. */
const MAX_PHRASES_PER_MODULE = 20;

/** The escapes a string literal in these sources can carry, decoded to the character each stands for. */
const DECODED_ESCAPES = {
  n: ' ',
  r: ' ',
  t: ' ',
  '0': '\u0000',
  '"': '"',
  "'": "'",
  '`': '`',
  '\\': '\\',
};

/**
 * Skips a `${...}` interpolation that begins just after its opening brace and returns the index of
 * the first character past its closing brace, or `null` when the source ends inside it.
 *
 * Braces are counted rather than an expression parsed: an interpolation in a prompt module is an
 * imported constant, never a construct that would put an unmatched brace inside a string.
 */
function skipInterpolation(source, start) {
  let depth = 1;
  let index = start;

  while (index < source.length) {
    const character = source[index];

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return null;
}

/**
 * Reads the string literal that starts at `start`, returning its decoded value and the index of the
 * first character after it, or `null` when the source ends inside the literal.
 *
 * Escapes are decoded to the characters they stand for, so a phrase taken from a single-quoted
 * literal and the same phrase inside a de-escaped bundle compare equal. A `${...}` interpolation
 * stands as a space: its value is unknown here, and its source form would never appear in a bundle.
 */
function readStringLiteral(source, start) {
  const quote = source[start];
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const character = source[index];

    if (character === '\\') {
      const escaped = source[index + 1];

      if (escaped === undefined) {
        return null;
      }

      value += Object.hasOwn(DECODED_ESCAPES, escaped) ? DECODED_ESCAPES[escaped] : escaped;
      index += 2;
      continue;
    }

    if (character === quote) {
      return { value, next: index + 1 };
    }

    if (quote === '`' && character === '$' && source[index + 1] === '{') {
      const resume = skipInterpolation(source, index + 2);

      if (resume === null) {
        return null;
      }

      value += ' ';
      index = resume;
      continue;
    }

    // An unterminated single- or double-quoted literal ends at its line end, so one stray quote
    // cannot swallow the rest of the module.
    if (quote !== '`' && character === '\n') {
      return { value, next: index };
    }

    value += character;
    index += 1;
  }

  return null;
}

/**
 * Every string literal in a source module, in source order: template literals, single-quoted and
 * double-quoted ones alike, with comment bodies skipped so a sentence of documentation is never
 * mistaken for instruction text.
 *
 * This is a scanner for needles rather than a parser: it walks the source once, treats `//` and
 * `/*` as comments outside a literal, and stops at an unterminated literal with what it has.
 */
function collectStringLiterals(source) {
  const literals = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }

    if (character === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      const literal = readStringLiteral(source, index);

      if (literal === null) {
        break;
      }

      literals.push(literal.value);
      index = literal.next;
      continue;
    }

    index += 1;
  }

  return literals;
}

/**
 * The phrases this gate searches for in a bundle: every string literal of at least
 * `MIN_PHRASE_LENGTH` characters once its whitespace is collapsed to single spaces and trimmed,
 * deduped, longest first, and capped at `MAX_PHRASES_PER_MODULE`.
 *
 * Longest first is what makes the cap safe: a template literal holding a whole instruction text is
 * the most distinctive thing in its module, so it is never the candidate a cap removes.
 */
function derivePromptPhrases(source) {
  const phrases = new Set();

  for (const literal of collectStringLiterals(source)) {
    const phrase = literal.replace(/\s+/g, ' ').trim();

    if (phrase.length >= MIN_PHRASE_LENGTH) {
      phrases.add(phrase);
    }
  }

  return [...phrases]
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_PHRASES_PER_MODULE);
}

/**
 * Reads both prompt modules and returns the full needle set: the constant patterns plus each
 * module's derived phrases, with the phrase count per module and every reason a phrase could not be
 * derived.
 *
 * `problems` is what makes a half-scan impossible: the caller fails the gate on any entry, so a
 * module that moved, vanished or lost its literal cannot quietly reduce the check to the constant
 * patterns.
 */
function buildNeedles() {
  const needles = [...STATIC_PATTERNS];
  const phraseCounts = new Map();
  const problems = [];

  for (const module of PROMPT_MODULES) {
    let source;

    try {
      source = readFileSync(module.path, 'utf8');
    } catch (error) {
      problems.push(
        `cannot read ${relative(ROOT, module.path)}; the prompt-absence check cannot be trusted ` +
          `(${error.message})`,
      );
      continue;
    }

    const phrases = derivePromptPhrases(source);
    phraseCounts.set(module.source, phrases.length);

    if (phrases.length === 0) {
      problems.push(
        `cannot derive a phrase from ${relative(ROOT, module.path)}: it holds no string literal of ` +
          `at least ${MIN_PHRASE_LENGTH} characters, so the prompt-absence check would scan for nothing`,
      );
      continue;
    }

    for (const phrase of phrases) {
      needles.push({
        label: `prompt-phrase:${module.source}`,
        pattern: phrase.slice(0, PHRASE_NEEDLE_LENGTH),
        description: `a phrase from the ${module.source} instruction text`,
        // A phrase reaches a bundle only inside a JavaScript or CSS string, where its spaces are
        // written as escapes or collapsed by minification. The normalised copy is the form that
        // finds it, so the raw bytes are not searched for a phrase.
        phrase: true,
      });
    }
  }

  return { needles, phraseCounts, problems };
}

/** Every regular file under `directory`, depth first, as absolute paths. */
function walkFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
      continue;
    }

    if (entry.isFile()) {
      files.push(path);
      continue;
    }

    // A symbolic link counts only when it resolves to a regular file: following a link to a
    // directory could loop, and such a directory is walked in its own right.
    if (entry.isSymbolicLink()) {
      try {
        if (statSync(path).isFile()) {
          files.push(path);
        }
      } catch {
        // A dangling link holds no bytes to scan.
      }
    }
  }

  return files;
}

/**
 * The second search text: a copy of the file with the escapes a bundled string carries folded back
 * into the characters they stand for, and every whitespace run collapsed to a space.
 *
 * A minified bundle writes the spaces of an instruction as `\n` escapes or folds the whole text into
 * one long token, so the raw bytes of such a file never hold a phrase as its module writes it. Only
 * this form does, which is why the scan reads both.
 */
function deEscape(text) {
  return text
    .replace(/\\r\\n/g, ' ')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every needle found in the bundle, one record per file and pattern.
 *
 * Files are read as bytes and decoded as `latin1`: each ASCII byte maps to one character and byte
 * positions are preserved, so a binary asset is scanned rather than skipped and no decode can throw.
 * A file may raise several records, and the scan never stops at the first one, because a single run
 * should surface everything there is to fix.
 */
function scanFiles(files, needles) {
  const hits = [];

  for (const file of files) {
    const raw = readFileSync(file).toString('latin1');
    const normalised = deEscape(raw);
    const reported = new Set();

    for (const needle of needles) {
      const searched = needle.phrase ? [normalised] : [raw, normalised];

      if (!searched.some((text) => text.includes(needle.pattern))) {
        continue;
      }

      // One record per pattern, however many of the search texts and however many occurrences hold
      // it, so a report lists each problem once.
      const key = `${needle.label}\u0000${needle.pattern}`;

      if (reported.has(key)) {
        continue;
      }

      reported.add(key);

      hits.push({
        file: relative(ROOT, file),
        label: needle.label,
        pattern: needle.pattern,
        description: needle.description,
      });
    }
  }

  return hits;
}

/**
 * Builds the client exactly as the workspace declares it. The bundle the scan reads has to be the one
 * a build produces, so a stale `client/dist` is accepted only when the caller passes `--skip-build`
 * and takes responsibility for it.
 */
function buildClient() {
  const command = [NPM_COMMAND, ...CLIENT_BUILD_ARGS].join(' ');

  console.log(`verify-client-bundle: building the client (${command})`);

  const result = spawnSync(NPM_COMMAND, CLIENT_BUILD_ARGS, {
    cwd: ROOT,
    stdio: 'inherit',
    // The build inherits the environment untouched: this gate never reads, forwards or prints it.
    env: process.env,
    shell: IS_WINDOWS,
  });

  if (result.error) {
    console.error(
      `verify-client-bundle: the client build could not be started: ${result.error.message}`,
    );
    process.exitCode = 1;
    return false;
  }

  if (result.status !== 0) {
    console.error('verify-client-bundle: client build failed; client/dist was not verified');

    // The build's own code is propagated, so a caller sees the failure it actually was.
    process.exitCode = result.status === null ? 1 : result.status;
    return false;
  }

  return true;
}

function main() {
  let skipBuild = false;

  for (const argument of process.argv.slice(2)) {
    if (argument === '--skip-build') {
      skipBuild = true;
      continue;
    }

    console.error(`verify-client-bundle: unrecognised argument "${argument}"`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (!skipBuild && !buildClient()) {
    return;
  }

  const distPath = relative(ROOT, DIST_DIR);

  if (!existsSync(DIST_DIR) || !statSync(DIST_DIR).isDirectory()) {
    console.error(
      `verify-client-bundle: ${distPath} does not exist, so there is no client bundle to scan`,
    );
    process.exitCode = 1;
    return;
  }

  const files = walkFiles(DIST_DIR);

  if (files.length === 0) {
    console.error(
      `verify-client-bundle: ${distPath} holds no files, so there is no client bundle to scan`,
    );
    process.exitCode = 1;
    return;
  }

  const { needles, phraseCounts, problems } = buildNeedles();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`verify-client-bundle: ${problem}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log(`verify-client-bundle: scanning ${files.length} files under client/dist`);

  const hits = scanFiles(files, needles);

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(`FAIL ${hit.file}: ${hit.label} — ${hit.description}`);
    }

    console.log(`verify-client-bundle: ${hits.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }

  const phraseTotal = [...phraseCounts.values()].reduce((total, count) => total + count, 0);
  const phraseBreakdown = PROMPT_MODULES.map(
    (module) => `${module.source} ${phraseCounts.get(module.source)}`,
  ).join(', ');

  console.log(
    `verify-client-bundle: clean — ${files.length} file(s) scanned for ` +
      `${STATIC_PATTERNS.length} static patterns and ${phraseTotal} derived prompt phrase(s) ` +
      `(${phraseBreakdown}); no matches found`,
  );
}

main();

